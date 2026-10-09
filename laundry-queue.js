// laundry-queue.js
// Polls the Laundry Man message queue and sends through the bot's existing sender.
// Tuned to stay well inside Render free-tier limits and to reduce PHP API traffic.
//
// Env vars (Render → Environment):
//   LM_API_BASE     = https://api.aramedia.me/laundryman/api/v1
//   LM_NODE_KEY     = node_api_key from the PHP config.php
//   LM_POLL_MS      = optional, default 30000   (30s between polls)
//   LM_BATCH_LIMIT  = optional, default 10      (max messages per poll)
//   LM_ACTIVE_HOURS = optional, default 7-23    (local hours, 24h format)
//   LM_TZ_OFFSET    = optional, default 4       (Asia/Dubai = UTC+4)
//   LM_ENABLED      = "false" to pause the poller entirely

const sleep = ms => new Promise(r => setTimeout(r, ms));

function startLaundryQueue(sendText, isReady = () => true) {
  const BASE = (process.env.LM_API_BASE || '').replace(/\/$/, '');
  const KEY = process.env.LM_NODE_KEY || '';
  const POLL_MS = Number(process.env.LM_POLL_MS || 30000);
  const BATCH_LIMIT = Math.min(50, Math.max(1, Number(process.env.LM_BATCH_LIMIT || 10)));
  const ACTIVE_HOURS = String(process.env.LM_ACTIVE_HOURS || '7-23');
  const TZ_OFFSET = Number(process.env.LM_TZ_OFFSET || 4); // Dubai
  const [startHour, endHour] = ACTIVE_HOURS.split('-').map(n => Number(n));

  if (process.env.LM_ENABLED === 'false') {
    return console.log('[laundry] disabled via LM_ENABLED');
  }
  if (!BASE || !KEY) {
    return console.error(
      '[laundry] missing:',
      [!BASE && 'LM_API_BASE', !KEY && 'LM_NODE_KEY'].filter(Boolean).join(', ')
    );
  }

  console.log('[laundry] BASE =', JSON.stringify(BASE));
  console.log(
    '[laundry] KEY length =', KEY.length,
    '| first4 =', KEY.slice(0, 4),
    '| last4 =', KEY.slice(-4)
  );
  console.log(`[laundry] poll every ${POLL_MS}ms, batch ${BATCH_LIMIT}, active ${startHour}:00-${endHour}:00 (UTC+${TZ_OFFSET})`);

  // Are we inside the active window? Window is inclusive of start, exclusive of end.
  function isActiveHour() {
    const localHour = (new Date().getUTCHours() + TZ_OFFSET + 24) % 24;
    if (startHour <= endHour) return localHour >= startHour && localHour < endHour;
    // Wrap-around window (e.g. 22-6)
    return localHour >= startHour || localHour < endHour;
  }

  // A single HTTP call to the PHP API. Throws on non-ok JSON.
  async function api(path, method = 'GET', body) {
    const url = BASE + path;
    const res = await fetch(url, {
      method,
      headers: {
        'X-Api-Key': KEY,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const json = await res.json().catch(() => ({ ok: false, error: `Bad response (${res.status})` }));
    if (!json.ok) throw new Error(json.error || 'Request failed');
    return json.data;
  }

  let busy = false;
  let failures = 0;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    if (busy) return;                       // don't stack ticks
    if (!isReady()) return;                 // WhatsApp not connected
    if (!isActiveHour()) return;            // outside active window

    busy = true;
    try {
      const messages = await api(`/node/pending?limit=${BATCH_LIMIT}`);
      failures = 0;

      for (const m of messages) {
        if (!isReady()) break;              // connection dropped; skip rest
        try {
          await sendText(String(m.phone), m.message);
          await api(`/node/${m.id}/sent`, 'POST');
          console.log(`[laundry] sent #${m.id} (${m.type})`);
        } catch (e) {
          console.error(`[laundry] failed #${m.id}:`, e.message);
          await api(`/node/${m.id}/failed`, 'POST', { error: String(e.message || e) })
            .catch(() => {});
        }
        // Pace sends so WhatsApp doesn't flag the number for bulk behaviour.
        await sleep(2000 + Math.random() * 1500);
      }
    } catch (e) {
      failures++;
      console.error('[laundry] poll error:', e.message);
      // Back off on repeated errors: 5s, 10s, 15s, ... up to 60s
      await sleep(Math.min(60000, failures * 5000));
    } finally {
      busy = false;
    }
  }

  // Fixed-interval scheduler that skips ticks while busy or off-hours.
  // Using setInterval keeps the event loop responsive between ticks.
  const handle = setInterval(tick, POLL_MS);
  tick(); // fire immediately once
  console.log('[laundry] queue polling started');

  // Optional: expose a stop function for graceful shutdown
  return () => { stopped = true; clearInterval(handle); };
}

module.exports = { startLaundryQueue };

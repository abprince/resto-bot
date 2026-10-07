// laundry-queue.js: polls the Laundry Man message queue and sends through the bot's existing sender.
// Needs Node 18+ (built-in fetch). Env vars (Render > Environment):
//   LM_API_BASE = https://aramedia.me/laundryman/api/v1
//   LM_NODE_KEY = node_api_key from the PHP config.php
//   LM_POLL_MS  = optional, default 5000      LM_ENABLED = "false" to pause

const sleep = ms => new Promise(r => setTimeout(r, ms));

function startLaundryQueue(sendText, isReady = () => true) {
  const BASE = (process.env.LM_API_BASE || '').replace(/\/$/, '');
  const KEY = process.env.LM_NODE_KEY || '';
  const POLL_MS = Number(process.env.LM_POLL_MS || 5000);
  if (process.env.LM_ENABLED === 'false') return console.log('[laundry] disabled');
  if (!BASE || !KEY) return console.error('[laundry] set LM_API_BASE and LM_NODE_KEY');

  async function api(path, method = 'GET', body) {
    const res = await fetch(BASE + path, { method, headers: { 'X-Api-Key': KEY, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({ ok: false, error: 'Bad response (' + res.status + ')' }));
    if (!json.ok) throw new Error(json.error || 'Request failed');
    return json.data;
  }

  let busy = false, failures = 0;
  async function tick() {
    if (busy || !isReady()) return;          // do nothing while WhatsApp is disconnected, so messages are not burned as failures
    busy = true;
    try {
      const messages = await api('/node/pending?limit=20');
      failures = 0;
      for (const m of messages) {
        if (!isReady()) break;               // connection dropped mid-batch; unsent messages are picked up again in ~2 minutes
        try {
          await sendText(String(m.phone), m.message);
          await api(`/node/${m.id}/sent`, 'POST');
          console.log(`[laundry] sent #${m.id} (${m.type})`);
        } catch (e) {
          console.error(`[laundry] failed #${m.id}:`, e.message);
          await api(`/node/${m.id}/failed`, 'POST', { error: String(e.message || e) }).catch(() => {});
        }
        await sleep(2000 + Math.random() * 1500);   // pace messages so the number is not flagged for bulk sending
      }
    } catch (e) {
      failures++; console.error('[laundry] poll error:', e.message);
      await sleep(Math.min(60000, failures * 5000));
    } finally { busy = false; }
  }
  setInterval(tick, POLL_MS); tick();
  console.log('[laundry] queue polling started');
}
module.exports = { startLaundryQueue };

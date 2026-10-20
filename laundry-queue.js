// laundry-queue.js — per-tenant queue poller (ESM)
// One instance per tenant. Polls /node/pending with that tenant's own API key.

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function startLaundryQueue(tenantId, apiKey, sendText, isReady = () => true) {
  const BASE = (process.env.LM_API_BASE || '').replace(/\/$/, '');
  const POLL_MS = Number(process.env.LM_POLL_MS || 30000);
  const BATCH_LIMIT = Math.min(50, Math.max(1, Number(process.env.LM_BATCH_LIMIT || 10)));

  if (!BASE || !apiKey) {
    console.error(`[tenant ${tenantId}] missing BASE or apiKey`);
    return () => {};
  }

  const logPrefix = `[tenant ${tenantId}]`;

  async function api(path, method = 'GET', body) {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({ ok: false, error: `Bad response (${res.status})` }));
    if (!json.ok) throw new Error(json.error || 'Request failed');
    return json.data;
  }

  let stopped = false, busy = false, failures = 0;

  async function tick() {
    if (stopped || busy || !isReady()) return;
    busy = true;
    try {
      const messages = await api(`/node/pending?limit=${BATCH_LIMIT}`);
      failures = 0;
      for (const m of messages) {
        if (stopped || !isReady()) break;
        try {
          const media = m.media ? (typeof m.media === 'string' ? JSON.parse(m.media) : m.media) : [];
          await sendText(String(m.phone), m.message, media);
          await api(`/node/${m.id}/sent`, 'POST');
          console.log(`${logPrefix} sent #${m.id} (${m.type})${media.length ? ' + ' + media.length + ' photo(s)' : ''}`);
        } catch (e) {
          console.error(`${logPrefix} failed #${m.id}:`, e.message);
          await api(`/node/${m.id}/failed`, 'POST', { error: String(e.message || e) }).catch(() => {});
        }
        await sleep(2000 + Math.random() * 1500);
      }
    } catch (e) {
      failures++;
      console.error(`${logPrefix} poll error:`, e.message);
      await sleep(Math.min(60000, failures * 5000));
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(tick, POLL_MS);
  tick();

  return () => { stopped = true; clearInterval(timer); };
}

export default { startLaundryQueue };
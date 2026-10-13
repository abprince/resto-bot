// bot.js — multi-tenant WhatsApp bot
//
// Two modes:
//   SHARED (default)   — one Baileys session serving all tenants from /node/tenants
//   PER-TENANT         — LM_TENANTS=1:key,3:key — one session per listed tenant
//
// Env:
//   LM_API_BASE       — PHP API base URL
//   LM_BOT_MASTER_KEY — master key (required for SHARED mode)
//   LM_BOT_MODE       — "shared" or "per_tenant" (default: shared)
//   LM_TENANTS        — comma-separated tenantId:key pairs (PER-TENANT mode)
//   LM_POLL_MS        — optional, default 30000

const express = require('express');
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { startLaundryQueue } = require('./laundry-queue');

const PORT = process.env.PORT || 3000;
const API_BASE = (process.env.LM_API_BASE || '').replace(/\/$/, '');
const MASTER_KEY = process.env.LM_BOT_MASTER_KEY || '';
const BOT_MODE = (process.env.LM_BOT_MODE || 'shared').trim();
const AUTH_ROOT = './auth_sessions';
const SHARED_AUTH_DIR = path.join(AUTH_ROOT, 'shared');

if (!API_BASE) {
  console.error('LM_API_BASE is required');
  process.exit(1);
}

const logger = pino({
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

let sharedSock = null;
let sharedConnected = false;
let sharedQr = null;
const tenantQueues = new Map();
const perTenantSessions = new Map();

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ============================================================
// SHARED MODE
// ============================================================
async function startSharedSession() {
  if (sharedSock) return;
  ensureDir(SHARED_AUTH_DIR);

  const { state, saveCreds } = await useMultiFileAuthState(SHARED_AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  logger.info(`[shared] starting WhatsApp session v${version.join('.')}`);

  sharedSock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Laundry Bot', 'Chrome', '1.0.0'],
  });

  sharedSock.ev.on('creds.update', saveCreds);

  sharedSock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sharedQr = qr;
      logger.info('[shared] new QR — scan via /qr');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output.statusCode
        : null;

      logger.warn(`[shared] connection closed (${statusCode})`);
      sharedConnected = false;
      sharedQr = null;

      if (statusCode === DisconnectReason.loggedOut) {
        logger.warn('[shared] logged out — clearing auth folder');
        if (fs.existsSync(SHARED_AUTH_DIR)) fs.rmSync(SHARED_AUTH_DIR, { recursive: true, force: true });
      }

      sharedSock = null;
      setTimeout(startSharedSession, 5000);
    } else if (connection === 'open') {
      logger.info('[shared] ✅ WhatsApp connected');
      sharedConnected = true;
      sharedQr = null;

      await syncTenantQueues();
    }
  });
}

async function syncTenantQueues() {
  if (!MASTER_KEY) {
    logger.warn('[shared] no master key — cannot fetch tenants');
    return;
  }

  try {
    const url = `${API_BASE}/node/tenants?mode=${encodeURIComponent(BOT_MODE)}`;
    const res = await fetch(url, {
      headers: { 'X-Bot-Master-Key': MASTER_KEY },
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'Request failed');

    const tenants = json.data || [];
    const wanted = new Set(tenants.map(t => t.tenant_id));

    for (const t of tenants) {
      if (tenantQueues.has(t.tenant_id)) continue;
      startQueueForTenant(t);
    }

    for (const id of [...tenantQueues.keys()]) {
      if (!wanted.has(id)) {
        logger.info(`[shared] tenant ${id} no longer served — stopping queue`);
        const stop = tenantQueues.get(id);
        if (stop) stop();
        tenantQueues.delete(id);
      }
    }
  } catch (err) {
    logger.error('[shared] tenant sync failed:', err.message);
  }
}

function startQueueForTenant(tenant) {
  logger.info(`[shared] queue started for tenant ${tenant.tenant_id}${tenant.name ? ` (${tenant.name})` : ''}${tenant.is_demo ? ' [DEMO]' : ''}`);

  const stop = startLaundryQueue(
    tenant.tenant_id,
    tenant.api_key,
    async (phone, message) => {
      const text = tenant.is_demo
        ? `[Demo · ${tenant.name}] ${message}`
        : message;

      const jid = `${String(phone).replace(/\D/g, '')}@s.whatsapp.net`;
      await sharedSock.sendMessage(jid, { text });
    },
    () => sharedConnected
  );

  tenantQueues.set(tenant.tenant_id, stop);
}

// ============================================================
// PER-TENANT MODE
// ============================================================
function parseTenantList(raw) {
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(pair => {
    const [idPart, ...keyParts] = pair.split(':');
    const id = Number(idPart);
    const key = keyParts.join(':').trim();
    return id && key ? { tenant_id: id, api_key: key } : null;
  }).filter(Boolean);
}

async function startPerTenantSession(tenantId, apiKey) {
  if (perTenantSessions.has(tenantId)) return;

  const authDir = path.join(AUTH_ROOT, String(tenantId));
  ensureDir(authDir);

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  logger.info(`[tenant ${tenantId}] starting dedicated session`);

  const sock = makeWASocket({
    version, auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Laundry Bot', 'Chrome', '1.0.0'],
  });

  const session = { sock, connected: false, qr: null, queueStop: null };
  perTenantSessions.set(tenantId, session);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.qr = qr;
      logger.info(`[tenant ${tenantId}] QR ready — /qr/${tenantId}`);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output.statusCode : null;
      logger.warn(`[tenant ${tenantId}] closed (${code})`);
      session.connected = false;
      session.qr = null;
      if (session.queueStop) { session.queueStop(); session.queueStop = null; }
      if (code === DisconnectReason.loggedOut && fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
      }
      perTenantSessions.delete(tenantId);
      setTimeout(() => startPerTenantSession(tenantId, apiKey), 5000);
    } else if (connection === 'open') {
      logger.info(`[tenant ${tenantId}] ✅ connected`);
      session.connected = true;
      session.qr = null;

      if (!session.queueStop) {
        session.queueStop = startLaundryQueue(
          tenantId, apiKey,
          async (phone, message) => {
            const jid = `${String(phone).replace(/\D/g, '')}@s.whatsapp.net`;
            await sock.sendMessage(jid, { text: message });
          },
          () => session.connected
        );
      }
    }
  });
}

function isPerTenantMode() {
  return BOT_MODE === 'per_tenant' && !!(process.env.LM_TENANTS || '').trim();
}

// ============================================================
// HTTP SERVER
// ============================================================
const app = express();

// Shared CSS for all pages
const pageCss = `
  *{box-sizing:border-box}
  body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;background:#f8fafc;color:#0f172a;-webkit-font-smoothing:antialiased}
  .wrap{max-width:720px;margin:2rem auto;padding:0 1rem}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:2rem;box-shadow:0 4px 12px rgba(15,23,42,.06)}
  .brand{display:flex;align-items:center;gap:.6rem;font-weight:800;font-size:1.2rem;color:#1b2b4b;margin-bottom:1rem}
  .brand .ic{width:40px;height:40px;border-radius:11px;background:linear-gradient(135deg,#0f766e,#115e59);display:flex;align-items:center;justify-content:center;font-size:1.3rem}
  h1{margin:0 0 .4rem;font-size:1.4rem;color:#1b2b4b}
  .sub{color:#475569;margin-bottom:1.5rem;font-size:.95rem}
  .stat{display:flex;justify-content:space-between;align-items:center;padding:.7rem 0;border-bottom:1px solid #e2e8f0}
  .stat:last-child{border-bottom:0}
  .stat .lbl{color:#94a3b8;font-size:.85rem;font-weight:600;text-transform:uppercase;letter-spacing:.03em}
  .stat .val{font-weight:700;color:#1b2b4b}
  .badge{display:inline-block;padding:.2rem .7rem;border-radius:99px;font-size:.78rem;font-weight:700}
  .badge.ok{background:#dcfce7;color:#166534}
  .badge.off{background:#fee2e2;color:#991b1b}
  .badge.warn{background:#fef3c7;color:#92400e}
  .btn{display:inline-flex;align-items:center;justify-content:center;gap:.4rem;padding:.7rem 1.2rem;background:#0f766e;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:.95rem;border:0;cursor:pointer;transition:background .15s}
  .btn:hover{background:#115e59}
  .btn.alt{background:#fff;color:#0f766e;border:1px solid #cbd5e1}
  .btn.alt:hover{background:#f0fdfa}
  .qr-wrap{margin:1.5rem auto;padding:1.2rem;background:#fff;border:3px dashed #0f766e;border-radius:14px;display:inline-block}
  .qr-wrap canvas{display:block}
  .instructions{background:#fff9e6;padding:1rem 1.2rem;border-radius:10px;margin-top:1.2rem;text-align:left;font-size:.88rem;color:#856404;border-left:4px solid #ffc107}
  .instructions strong{display:block;margin-bottom:.4rem;font-size:.92rem}
  .instructions ol{margin:0;padding-left:1.2rem}
  .instructions li{margin:.3rem 0}
  .check{width:80px;height:80px;border-radius:99px;background:#16a34a;color:#fff;display:flex;align-items:center;justify-content:center;font-size:3rem;margin:0 auto 1rem}
  table{width:100%;border-collapse:collapse;font-size:.9rem;margin-top:1rem}
  th{background:#f1f5f9;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;color:#475569;text-align:left;padding:.5rem .7rem;font-weight:700}
  td{padding:.6rem .7rem;border-bottom:1px solid #e2e8f0}
  td:last-child,th:last-child{text-align:right}
  .center{text-align:center}
  .mt{margin-top:1rem}
`;

// Homepage
app.get('/', (req, res) => {
  if (isPerTenantMode()) {
    const list = [...perTenantSessions.entries()].map(([id, s]) => ({ id, connected: s.connected }));
    const allOk = list.length && list.every(l => l.connected);
    res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Laundry Bot</title>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>${pageCss}</style></head><body>
      <div class="wrap"><div class="card">
        <div class="brand"><span class="ic">🧺</span> Laundry Bot · Per-tenant</div>
        <h1>Status</h1>
        <div class="sub">Serving ${list.length} tenant${list.length === 1 ? '' : 's'}</div>
        <div class="stat"><span class="lbl">Overall</span><span class="badge ${allOk ? 'ok' : 'off'}">${allOk ? 'All connected' : 'Some offline'}</span></div>
        ${list.length ? `<table>
          <thead><tr><th>Tenant</th><th>Status</th><th>Action</th></tr></thead>
          <tbody>${list.map(l => `<tr>
            <td><b>#${l.id}</b></td>
            <td><span class="badge ${l.connected ? 'ok' : 'off'}">${l.connected ? 'Connected' : 'Offline'}</span></td>
            <td>${l.connected ? '—' : `<a class="btn alt" href="/qr/${l.id}">Scan QR</a>`}</td>
          </tr>`).join('')}</tbody>
        </table>` : '<p class="mt" style="color:#94a3b8">No tenants configured.</p>'}
      </div></div></body></html>`);
    return;
  }

  const connected = sharedConnected;
  const count = tenantQueues.size;
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Laundry Bot</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>${pageCss}</style></head><body>
    <div class="wrap"><div class="card">
      <div class="brand"><span class="ic">🧺</span> Laundry Bot</div>
      <h1>Shared mode</h1>
      <div class="sub">One WhatsApp session serving all tenants</div>
      <div class="stat"><span class="lbl">WhatsApp</span><span class="badge ${connected ? 'ok' : 'off'}">${connected ? 'Connected' : 'Offline'}</span></div>
      <div class="stat"><span class="lbl">Tenants served</span><span class="val">${count}</span></div>
      <div class="stat"><span class="lbl">Uptime</span><span class="val">${Math.floor(process.uptime() / 60)} min</span></div>
      ${!connected ? `<div class="center mt"><a class="btn" href="/qr">📱 Scan QR to connect</a></div>` : `<div class="center mt"><span class="badge ok">✓ Running normally</span></div>`}
    </div></div></body></html>`);
});

// Health — stays JSON for the PHP endpoint. Add ?format=html for a pretty page.
app.get('/health', (req, res) => {
  const data = isPerTenantMode()
    ? {
        status: 'running',
        mode: 'per_tenant',
        whatsapp_connected: [...perTenantSessions.values()].some(s => s.connected),
        tenants_total: perTenantSessions.size,
        tenants_connected: [...perTenantSessions.values()].filter(s => s.connected).length,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      }
    : {
        status: 'running',
        mode: 'shared',
        whatsapp_connected: sharedConnected,
        tenants_served: tenantQueues.size,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      };

  if (req.query.format === 'html') {
    const ok = data.whatsapp_connected;
    return res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Bot Health</title>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>${pageCss}</style></head><body>
      <div class="wrap"><div class="card">
        <div class="brand"><span class="ic">🧺</span> Laundry Bot · Health</div>
        <div class="stat"><span class="lbl">Status</span><span class="badge ${ok ? 'ok' : 'off'}">${ok ? 'Healthy' : 'Degraded'}</span></div>
        <div class="stat"><span class="lbl">Mode</span><span class="val">${data.mode}</span></div>
        <div class="stat"><span class="lbl">WhatsApp</span><span class="val">${ok ? 'Connected' : 'Offline'}</span></div>
        ${data.mode === 'shared'
          ? `<div class="stat"><span class="lbl">Tenants served</span><span class="val">${data.tenants_served}</span></div>`
          : `<div class="stat"><span class="lbl">Tenants connected</span><span class="val">${data.tenants_connected} / ${data.tenants_total}</span></div>`}
        <div class="stat"><span class="lbl">Uptime</span><span class="val">${Math.floor(data.uptime / 60)} min</span></div>
        <div class="stat"><span class="lbl">Checked at</span><span class="val">${data.timestamp.replace('T', ' ').slice(0, 19)}</span></div>
        <div class="center mt">
          <a class="btn alt" href="/">← Home</a>
          <a class="btn" href="/health?format=html">↻ Refresh</a>
        </div>
      </div></div></body></html>`);
  }
  res.json(data);
});

// Status JSON
app.get('/status', (req, res) => {
  res.json({
    ok: true,
    mode: isPerTenantMode() ? 'per_tenant' : 'shared',
    tenants: isPerTenantMode()
      ? [...perTenantSessions.entries()].map(([id, s]) => ({
          tenant_id: id, connected: s.connected, has_qr: !!s.qr,
        }))
      : [...tenantQueues.keys()].map(id => ({ tenant_id: id, connected: sharedConnected })),
  });
});

// QR — shared
app.get('/qr', (req, res) => {
  if (isPerTenantMode()) {
    const offline = [...perTenantSessions.entries()].find(([_, s]) => !s.connected);
    if (offline) return res.redirect('/qr/' + offline[0]);
    return res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Connected</title>
      <meta name="viewport" content="width=device-width,initial-scale=1"><style>${pageCss}</style></head><body>
      <div class="wrap"><div class="card center">
        <div class="check">✓</div><h1>All connected</h1>
        <p class="sub">Every tenant is linked.</p>
        <a class="btn" href="/">← Home</a>
      </div></div></body></html>`);
  }

  if (sharedConnected) {
    return res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Connected</title>
      <meta name="viewport" content="width=device-width,initial-scale=1"><style>${pageCss}</style></head><body>
      <div class="wrap"><div class="card center">
        <div class="check">✓</div><h1>Connected</h1>
        <p class="sub">WhatsApp is linked. Serving ${tenantQueues.size} tenant${tenantQueues.size === 1 ? '' : 's'}.</p>
        <a class="btn" href="/">← Home</a>
      </div></div></body></html>`);
  }

  if (!sharedQr) {
    return res.send(`<!doctype html><html><head><meta charset="utf-8"><title>QR pending</title>
      <meta name="viewport" content="width=device-width,initial-scale=1"><style>${pageCss}</style></head><body>
      <div class="wrap"><div class="card center">
        <h1>QR not ready yet</h1>
        <p class="sub">WhatsApp is starting up. This page will refresh automatically.</p>
        <script>setTimeout(()=>location.reload(),3000)</script>
      </div></div></body></html>`);
  }

  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Scan QR</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.1/build/qrcode.min.js"></script>
    <style>${pageCss}</style></head><body>
    <div class="wrap"><div class="card center">
      <div class="brand"><span class="ic">🧺</span> Laundry Bot</div>
      <h1>Scan QR code</h1>
      <p class="sub">Link your WhatsApp to serve all tenants</p>
      <div class="qr-wrap"><div id="qrcode"></div></div>
      <div class="instructions">
        <strong>How to connect:</strong>
        <ol>
          <li>Open <b>WhatsApp</b> on the phone</li>
          <li>Tap <b>Settings</b> → <b>Linked Devices</b></li>
          <li>Tap <b>Link a Device</b></li>
          <li>Point the phone at this QR code</li>
        </ol>
      </div>
      <p style="color:#94a3b8;font-size:.8rem;margin-top:1rem">Auto-refreshes every 30 seconds</p>
    </div></div>
    <script>
      QRCode.toCanvas(${JSON.stringify(sharedQr)}, { width: 260, margin: 2 }, function(err, canvas) {
        if (err) { document.getElementById('qrcode').innerHTML = '<p>Error loading QR</p>'; return; }
        document.getElementById('qrcode').appendChild(canvas);
      });
      setTimeout(() => location.reload(), 30000);
    </script>
    </body></html>`);
});

// QR — per tenant
app.get('/qr/:tenantId', (req, res) => {
  const id = Number(req.params.tenantId);
  const s = perTenantSessions.get(id);

  if (!s) return res.status(404).send(`<!doctype html><html><head><meta charset="utf-8"><style>${pageCss}</style></head><body>
    <div class="wrap"><div class="card center">
      <h1>Tenant ${id} not served</h1>
      <a class="btn" href="/">← Home</a>
    </div></div></body></html>`);

  if (s.connected) {
    return res.send(`<!doctype html><html><head><meta charset="utf-8"><style>${pageCss}</style></head><body>
      <div class="wrap"><div class="card center">
        <div class="check">✓</div><h1>Connected</h1>
        <p class="sub">Tenant ${id} is linked.</p>
        <a class="btn" href="/">← Home</a>
      </div></div></body></html>`);
  }

  if (!s.qr) {
    return res.send(`<!doctype html><html><head><meta charset="utf-8"><style>${pageCss}</style></head><body>
      <div class="wrap"><div class="card center">
        <h1>QR not ready</h1>
        <script>setTimeout(()=>location.reload(),3000)</script>
      </div></div></body></html>`);
  }

  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Scan QR · tenant ${id}</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.1/build/qrcode.min.js"></script>
    <style>${pageCss}</style></head><body>
    <div class="wrap"><div class="card center">
      <div class="brand"><span class="ic">🧺</span> Laundry Bot</div>
      <h1>Scan QR code</h1>
      <p class="sub">Tenant #${id}</p>
      <div class="qr-wrap"><div id="qrcode"></div></div>
      <div class="instructions">
        <strong>How to connect:</strong>
        <ol>
          <li>Open <b>WhatsApp</b> on the shop phone</li>
          <li>Tap <b>Settings</b> → <b>Linked Devices</b></li>
          <li>Tap <b>Link a Device</b></li>
          <li>Point the phone at this QR code</li>
        </ol>
      </div>
      <p style="color:#94a3b8;font-size:.8rem;margin-top:1rem">Auto-refreshes every 30 seconds</p>
    </div></div>
    <script>
      QRCode.toCanvas(${JSON.stringify(s.qr)}, { width: 260, margin: 2 }, function(err, canvas) {
        if (!err) document.getElementById('qrcode').appendChild(canvas);
      });
      setTimeout(() => location.reload(), 30000);
    </script>
    </body></html>`);
});

// ============================================================
// STARTUP
// ============================================================
app.listen(PORT, async () => {
  logger.info(`🚀 Bot server on port ${PORT}`);

  if (isPerTenantMode()) {
    const list = parseTenantList(process.env.LM_TENANTS);
    logger.info(`Mode: PER-TENANT (${list.length} tenants from LM_TENANTS)`);
    for (const t of list) {
      startPerTenantSession(t.tenant_id, t.api_key).catch(err => {
        logger.error(`Failed to start tenant ${t.tenant_id}:`, err.message);
      });
    }
  } else if (MASTER_KEY) {
    logger.info(`Mode: SHARED (one WhatsApp session serving all tenants)`);
    await startSharedSession();
    setInterval(syncTenantQueues, 5 * 60 * 1000);
  } else {
    logger.error('Neither LM_TENANTS nor LM_BOT_MASTER_KEY set — nothing to do');
  }
});

process.on('SIGINT', async () => {
  logger.info('Shutting down…');
  for (const stop of tenantQueues.values()) stop();
  for (const s of perTenantSessions.values()) {
    if (s.queueStop) s.queueStop();
    try { await s.sock.logout(); } catch {}
  }
  try { if (sharedSock) await sharedSock.logout(); } catch {}
  process.exit(0);
});

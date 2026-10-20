// bot.js — multi-tenant WhatsApp bot for Laundry Man
// Updated for Baileys 7.x with LID resolution + security patches
// All original restaurant endpoints and decorative formatting preserved.

const express = require('express');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Baileys 7.x — ESM-only, use .default workaround for CommonJS
const baileys = require('@whiskeysockets/baileys').default;
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = baileys;

const { startLaundryQueue } = require('./laundry-queue');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_BASE = (process.env.LM_API_BASE || '').replace(/\/$/, '');
const MASTER_KEY = process.env.LM_BOT_MASTER_KEY || '';
const BOT_MODE = (process.env.LM_BOT_MODE || 'shared').trim();
const AUTH_ROOT = './auth_sessions';
const SHARED_AUTH_DIR = path.join(AUTH_ROOT, 'shared');

// ==================== STATE ====================
let sharedSock = null;
let sharedConnected = false;
let sharedQr = null;
const tenantQueues = new Map();
const perTenantSessions = new Map();

// In-memory message store for getMessage callback
const messageStore = new Map();

// ==================== LOGGER ====================
const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: { colorize: true },
  },
});

// ==================== HELPERS ====================
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function formatPhoneNumber(phone) {
  let cleaned = String(phone).replace(/\D/g, '');
  if (cleaned.length === 10) cleaned = '1' + cleaned;
  return cleaned;
}

function isPerTenantMode() {
  return BOT_MODE === 'per_tenant' && !!(process.env.LM_TENANTS || '').trim();
}

/**
 * Resolve a JID to a phone number.
 * Handles WhatsApp LID (Linked Device ID) format.
 */
async function resolvePhone(msg, sock) {
  const jid = msg.key && msg.key.remoteJid;

  // 1. senderPn (newest Baileys — direct phone number on message key)
  if (msg.key && msg.key.senderPn) {
    const cleaned = String(msg.key.senderPn).split('@')[0].split(':')[0];
    if (cleaned && cleaned.length >= 8) {
      if (jid && jid.endsWith('@lid') && sock.signalRepository?.lidMapping?.storeLIDPNMapping) {
        try { await sock.signalRepository.lidMapping.storeLIDPNMapping(jid, msg.key.senderPn); } catch {}
      }
      return cleaned;
    }
  }

  // 2. participantPn
  if (msg.key && msg.key.participantPn) {
    const cleaned = String(msg.key.participantPn).split('@')[0].split(':')[0];
    if (cleaned && cleaned.length >= 8) return cleaned;
  }

  // 3. remoteJidAlt
  if (msg.key && msg.key.remoteJidAlt) {
    const cleaned = String(msg.key.remoteJidAlt).split('@')[0].split(':')[0];
    if (cleaned && cleaned.length >= 8) return cleaned;
  }

  // 4. remoteJid (if PN, not LID)
  if (jid && !jid.endsWith('@lid')) {
    const cleaned = String(jid).split('@')[0].split(':')[0];
    if (cleaned && cleaned.length >= 8) return cleaned;
  }

  // 5. lidMapping store
  if (jid && jid.endsWith('@lid') && sock.signalRepository?.lidMapping) {
    try {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(jid);
      if (pn) {
        const cleaned = String(pn).split('@')[0].split(':')[0];
        if (cleaned && cleaned.length >= 8) return cleaned;
      }
    } catch {}
  }

  // 6. Debug dump
  try { logger.warn('[resolvePhone] Failed. Key: ' + JSON.stringify(msg.key)); } catch {}

  return '';
}

// Extract text from any message type
function extractText(msg) {
  const m = msg.message;
  if (!m) return '';
  let text = '';

  if (m.conversation) text = m.conversation;
  if (!text && m.extendedTextMessage) text = m.extendedTextMessage.text || '';
  if (!text && m.imageMessage) text = m.imageMessage.caption || '';
  if (!text && m.videoMessage) text = m.videoMessage.caption || '';
  if (!text && m.documentMessage) text = m.documentMessage.caption || '';
  if (!text && m.buttonsResponseMessage) {
    text = m.buttonsResponseMessage.selectedButtonId ||
           m.buttonsResponseMessage.selectedDisplayText || '';
  }
  if (!text && m.listResponseMessage) {
    text = (m.listResponseMessage.singleSelectReply &&
            m.listResponseMessage.singleSelectReply.selectedRowId) ||
           m.listResponseMessage.title || '';
  }
  if (!text && m.templateButtonReplyMessage) {
    text = m.templateButtonReplyMessage.selectedId ||
           m.templateButtonReplyMessage.selectedDisplayText || '';
  }
  if (!text && m.ephemeralMessage && m.ephemeralMessage.message) {
    const inner = m.ephemeralMessage.message;
    if (inner.conversation) text = inner.conversation;
    if (inner.extendedTextMessage) text = inner.extendedTextMessage.text || '';
  }
  if (!text && m.viewOnceMessage && m.viewOnceMessage.message) {
    const inner = m.viewOnceMessage.message;
    if (inner.conversation) text = inner.conversation;
    if (inner.extendedTextMessage) text = inner.extendedTextMessage.text || '';
  }

  return String(text || '').trim();
}

// Skip protocol / own / group / status messages
function isUserMessage(msg) {
  if (!msg.key) return false;
  if (msg.key.fromMe) return false;
  if (!msg.message) return false;
  const jid = msg.key.remoteJid;
  if (!jid) return false;
  if (jid.endsWith('@g.us')) return false;
  if (jid === 'status@broadcast') return false;
  const m = msg.message;
  if (!m) return false;
  if (m.protocolMessage) return false;
  if (m.senderKeyDistributionMessage) return false;
  return true;
}

// Store messages for getMessage callback
function storeMessage(msg) {
  if (!msg.key || !msg.key.id) return;
  messageStore.set(msg.key.id, msg);
  if (messageStore.size > 1000) {
    const keys = [...messageStore.keys()];
    keys.slice(0, 500).forEach(k => messageStore.delete(k));
  }
}

// ==================== SEND MESSAGE + MEDIA ====================
async function sendMessageWithMedia(sock, phone, text, media) {
  const jid = `${formatPhoneNumber(phone)}@s.whatsapp.net`;

  if (!Array.isArray(media) || media.length === 0) {
    await sock.sendMessage(jid, { text });
    return;
  }

  for (let i = 0; i < media.length; i++) {
    const m = media[i];
    const photoUrl = 'https://aramedia.me/laundryman/uploads/qc/' + m.path;
    const caption = (i === 0) ? text : undefined;
    try {
      await sock.sendMessage(jid, { image: { url: photoUrl }, caption });
    } catch (err) {
      logger.error(`failed to send photo ${i + 1} to ${phone}: ${err.message}`);
      if (i === 0) await sock.sendMessage(jid, { text });
    }
  }
}

// ==================== SHARED MODE ====================
async function startSharedSession() {
  if (sharedSock) return;
  ensureDir(SHARED_AUTH_DIR);

  const { state, saveCreds } = await useMultiFileAuthState(SHARED_AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  logger.info(`Starting WhatsApp with version ${version.join('.')}`);

  sharedSock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: ['Laundry Man Bot', 'Chrome', '1.0.0'],
    getMessage: async (key) => messageStore.get(key.id) || undefined,
    shouldSyncHistoryMessage: () => false,
  });

  sharedSock.ev.on('creds.update', saveCreds);

  sharedSock.ev.on('lid-mapping.update', (update) => {
    logger.info(`[shared] lid-mapping.update: ${JSON.stringify(update).slice(0, 200)}`);
  });

  sharedSock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    if (messages && messages.some(m => m.requestId)) {
      logger.warn('[shared] Dropped spoofed messages.upsert event');
      return;
    }

    for (const msg of messages) {
      try {
        if (!isUserMessage(msg)) continue;
        storeMessage(msg);

        const phone = await resolvePhone(msg, sharedSock);
        if (!phone) {
          logger.warn(`[shared] inbound: could not resolve phone from jid=${msg.key.remoteJid}`);
          continue;
        }

        const text = extractText(msg);
        if (!text) {
          const types = Object.keys(msg.message).join(',');
          logger.info(`[shared] inbound from ${phone}: (empty content, types: ${types})`);
          continue;
        }

        logger.info(`[shared] inbound from ${phone}: ${text.slice(0, 100)}`);

        const res = await fetch(`${API_BASE}/bot/inbound`, {
          method: 'POST',
          headers: {
            'X-Bot-Master-Key': MASTER_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ phone, text, message_id: msg.key.id || '' }),
        });

        const json = await res.json().catch(() => ({ ok: false }));
        logger.info(`[shared] inbound result: ${JSON.stringify(json).slice(0, 200)}`);
      } catch (err) {
        logger.error(`[shared] inbound handler failed: ${err.message}`);
      }
    }
  });

  sharedSock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) { sharedQr = qr; logger.info('New QR Code received'); }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output.statusCode : null;
      logger.warn(`Connection closed. Status: ${statusCode}`);
      sharedConnected = false;
      sharedQr = null;
      if (statusCode !== DisconnectReason.loggedOut) {
        logger.info('Attempting to reconnect...');
        sharedSock = null;
        setTimeout(startSharedSession, 5000);
      } else {
        logger.warn('Logged out. Clearing auth folder...');
        if (fs.existsSync(SHARED_AUTH_DIR)) fs.rmSync(SHARED_AUTH_DIR, { recursive: true, force: true });
        sharedSock = null;
        setTimeout(startSharedSession, 3000);
      }
    } else if (connection === 'open') {
      logger.info('✅ WhatsApp connected successfully!');
      sharedConnected = true;
      sharedQr = null;
      await syncTenantQueues();
    }
  });
}

async function syncTenantQueues() {
  if (!MASTER_KEY) { logger.warn('[shared] no master key'); return; }
  try {
    const url = `${API_BASE}/node/tenants?mode=${encodeURIComponent(BOT_MODE)}`;
    const res = await fetch(url, { headers: { 'X-Bot-Master-Key': MASTER_KEY } });
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
    async (phone, message, media) => {
      const text = tenant.is_demo ? `[Demo · ${tenant.name}] ${message}` : message;
      await sendMessageWithMedia(sharedSock, phone, text, media);
    },
    () => sharedConnected
  );
  tenantQueues.set(tenant.tenant_id, stop);
}

// ==================== PER-TENANT MODE ====================
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
    browser: ['Laundry Man Bot', 'Chrome', '1.0.0'],
    getMessage: async (key) => messageStore.get(key.id) || undefined,
    shouldSyncHistoryMessage: () => false,
  });

  const session = { sock, connected: false, qr: null, queueStop: null };
  perTenantSessions.set(tenantId, session);
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('lid-mapping.update', (update) => {
    logger.info(`[tenant ${tenantId}] lid-mapping.update: ${JSON.stringify(update).slice(0, 200)}`);
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    if (messages && messages.some(m => m.requestId)) {
      logger.warn(`[tenant ${tenantId}] Dropped spoofed messages.upsert event`);
      return;
    }
    for (const msg of messages) {
      try {
        if (!isUserMessage(msg)) continue;
        storeMessage(msg);

        const phone = await resolvePhone(msg, sock);
        if (!phone) {
          logger.warn(`[tenant ${tenantId}] inbound: could not resolve phone from jid=${msg.key.remoteJid}`);
          continue;
        }

        const text = extractText(msg);
        if (!text) continue;

        logger.info(`[tenant ${tenantId}] inbound from ${phone}: ${text.slice(0, 100)}`);

        const res = await fetch(`${API_BASE}/bot/inbound`, {
          method: 'POST',
          headers: { 'X-Bot-Master-Key': MASTER_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone, text,
            message_id: msg.key.id || '',
            tenant_id: tenantId,
          }),
        });

        const json = await res.json().catch(() => ({ ok: false }));
        logger.info(`[tenant ${tenantId}] inbound result: ${JSON.stringify(json).slice(0, 200)}`);
      } catch (err) {
        logger.error(`[tenant ${tenantId}] inbound handler failed: ${err.message}`);
      }
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { session.qr = qr; logger.info(`[tenant ${tenantId}] QR ready`); }
    if (connection === 'close') {
      const code = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output.statusCode : null;
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
          async (phone, message, media) => {
            await sendMessageWithMedia(sock, phone, message, media);
          },
          () => session.connected
        );
      }
    }
  });
}

// ==================== HOMEPAGE ====================
app.get('/', (req, res) => {
  const connected = isPerTenantMode()
    ? [...perTenantSessions.values()].some(s => s.connected)
    : sharedConnected;
  const tenantsServed = isPerTenantMode() ? perTenantSessions.size : tenantQueues.size;

  res.send(`
  <!DOCTYPE html>
  <html>
  <head>
    <title>Laundry Man Bot — WhatsApp Service</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        display: flex; justify-content: center; align-items: center;
        min-height: 100vh; background: linear-gradient(135deg, #0f766e 0%, #115e59 100%);
        padding: 1rem;
      }
      .container {
        background: white; padding: 50px 40px; border-radius: 20px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.3); text-align: center;
        max-width: 460px; width: 100%;
      }
      .icon { font-size: 64px; margin-bottom: 20px; }
      h1 { color: #1b2b4b; margin-bottom: 10px; font-size: 28px; }
      p { color: #666; margin-bottom: 20px; }
      .status {
        display: inline-block; padding: 8px 20px; border-radius: 25px;
        font-size: 14px; font-weight: bold; margin: 15px 0;
      }
      .online { background: #e8f5e9; color: #28a745; }
      .offline { background: #ffeaea; color: #dc3545; }
      .info-line { font-size: 13px; color: #999; margin-top: .4rem; }
      .links { margin-top: 30px; display: flex; flex-direction: column; gap: 10px; }
      .links a {
        display: block; padding: 12px 24px; background: #25D366; color: white;
        text-decoration: none; border-radius: 25px; font-weight: 600;
        transition: all 0.3s;
      }
      .links a:hover { background: #1da851; transform: translateY(-2px); }
      .links a.health { background: #6c757d; }
      .links a.health:hover { background: #5a6268; }
      .footer { margin-top: 30px; font-size: 12px; color: #999; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="icon">🧺</div>
      <h1>Laundry Man Bot</h1>
      <p>${isPerTenantMode() ? 'Dedicated WhatsApp Service' : 'Multi-tenant WhatsApp Service'}</p>
      <span class="status ${connected ? 'online' : 'offline'}">
        ${connected ? '🟢 Bot Online' : '🔴 Bot Offline'}
      </span>
      <div class="info-line">
        ${isPerTenantMode() ? 'Per-tenant mode' : 'Shared mode'} · Serving ${tenantsServed} tenant${tenantsServed === 1 ? '' : 's'}
      </div>
      <div class="links">
        <a href="/qr">📱 ${connected ? 'View Connection' : 'Scan QR Code to Connect'}</a>
        <a href="/health" class="health">❤️ Health Check</a>
      </div>
      <div class="footer">
        Render Deployed • v2.0
      </div>
    </div>
  </body>
  </html>
  `);
});

// ==================== QR CODE PAGE ====================
app.get('/qr', (req, res) => {
  if (isPerTenantMode()) {
    const offline = [...perTenantSessions.entries()].find(([_, s]) => !s.connected);
    if (offline) return res.redirect('/qr/' + offline[0]);
  }
  const qrCode = isPerTenantMode() ? null : sharedQr;
  const isConnected = isPerTenantMode()
    ? [...perTenantSessions.values()].every(s => s.connected) && perTenantSessions.size > 0
    : sharedConnected;

  if (qrCode && !isConnected) {
    const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Scan QR Code — Laundry Man Bot</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.1/build/qrcode.min.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex; justify-content: center; align-items: center;
            min-height: 100vh; background: #f0f2f5; padding: 1rem;
        }
        .container {
            background: white; padding: 40px 30px; border-radius: 20px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.1); text-align: center;
            max-width: 420px; width: 100%;
        }
        h2 { color: #0f766e; margin-bottom: 5px; font-size: 24px; }
        .subtitle { color: #666; margin-bottom: 20px; font-size: 14px; }
        .status {
            display: inline-block; padding: 5px 15px; border-radius: 20px;
            font-size: 13px; font-weight: bold; margin-bottom: 20px;
        }
        .disconnected { background: #ffeaea; color: #dc3545; }
        .connected { background: #e8f5e9; color: #28a745; }
        #qrcode {
            margin: 20px auto; padding: 20px; background: white;
            border: 3px dashed #0f766e; border-radius: 15px; display: inline-block;
        }
        #qrcode canvas { display: block; }
        .scan-text { color: #333; font-weight: 600; margin-top: 15px; font-size: 16px; }
        .instructions {
            background: #fff9e6; padding: 15px; border-radius: 12px;
            margin-top: 25px; text-align: left; font-size: 13px; color: #856404;
            border-left: 4px solid #ffc107;
        }
        .instructions strong { display: block; margin-bottom: 8px; font-size: 14px; }
        .instructions ol { margin: 0; padding-left: 20px; }
        .instructions li { margin: 6px 0; }
        .refresh-btn {
            background: #0f766e; color: white; border: none;
            padding: 12px 35px; border-radius: 25px; font-size: 16px;
            cursor: pointer; margin-top: 20px; font-weight: 600;
            transition: all 0.3s;
        }
        .refresh-btn:hover { background: #115e59; transform: translateY(-2px); }
        .auto-refresh { font-size: 11px; color: #999; margin-top: 12px; }
        .spinner {
            display: inline-block; width: 16px; height: 16px; border: 2px solid #0f766e;
            border-top: 2px solid transparent; border-radius: 50%;
            animation: spin 1s linear infinite; margin-right: 6px; vertical-align: middle;
        }
        @keyframes spin { 100% { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="container">
        <h2>🧺 WhatsApp QR Code</h2>
        <p class="subtitle">Laundry Man Bot Connection</p>
        <span class="status disconnected">⏳ Waiting for Scan</span>

        <div id="qrcode"></div>
        <p class="scan-text">📱 Scan with WhatsApp</p>

        <div class="instructions">
            <strong>📋 How to Connect:</strong>
            <ol>
                <li>Open <strong>WhatsApp</strong> on your phone</li>
                <li>Go to <strong>Settings</strong> ⚙️</li>
                <li>Tap <strong>Linked Devices</strong></li>
                <li>Tap <strong>Link a Device</strong></li>
                <li>Point phone at this QR code</li>
            </ol>
        </div>

        <button class="refresh-btn" onclick="location.reload()">
            🔄 Refresh QR Code
        </button>
        <p class="auto-refresh">
            <span class="spinner"></span> Auto-refreshes in 30 seconds
        </p>
    </div>

    <script>
        const qrString = ${JSON.stringify(qrCode)};
        const qrElement = document.getElementById('qrcode');

        QRCode.toCanvas(qrString, {
            width: 250,
            margin: 2,
            color: { dark: '#000000', light: '#ffffff' }
        }, function(error, canvas) {
            if (error) {
                console.error(error);
                qrElement.innerHTML = '<p style="color:red;">Error loading QR code. Please refresh.</p>';
            } else {
                qrElement.appendChild(canvas);
            }
        });

        setTimeout(() => location.reload(), 30000);
    </script>
</body>
</html>`;

    res.send(html);

  } else if (isConnected) {
    const count = isPerTenantMode() ? perTenantSessions.size : tenantQueues.size;
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Bot Connected — Laundry Man Bot</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                display: flex; justify-content: center; align-items: center;
                min-height: 100vh; background: #f0f2f5; padding: 1rem;
            }
            .container {
                background: white; padding: 50px 40px; border-radius: 20px;
                box-shadow: 0 10px 40px rgba(0,0,0,0.1); text-align: center;
                max-width: 420px; width: 100%;
            }
            .checkmark {
                width: 80px; height: 80px; background: #28a745;
                border-radius: 50%; display: flex; align-items: center;
                justify-content: center; margin: 0 auto 25px;
                font-size: 40px; color: white;
            }
            h2 { color: #28a745; margin-bottom: 10px; }
            p { color: #666; margin-bottom: 20px; }
            .links { margin-top: 25px; }
            .links a {
                display: inline-block; margin: 5px; padding: 10px 25px;
                background: #25D366; color: white; text-decoration: none;
                border-radius: 25px; font-weight: 600; transition: all 0.3s;
            }
            .links a:hover { background: #1da851; }
            .links a.home { background: #6c757d; }
            .links a.home:hover { background: #5a6268; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="checkmark">✓</div>
            <h2>WhatsApp Bot Connected!</h2>
            <p>Your bot is online and serving ${count} tenant${count === 1 ? '' : 's'}.</p>
            <div class="links">
                <a href="/">🏠 Home</a>
                <a href="/health">❤️ Health Check</a>
            </div>
        </div>
    </body>
    </html>
    `);
  } else {
    res.json({
      qr: null,
      connected: false,
      message: 'QR code not yet generated. Bot is initializing. Please refresh in a few seconds.',
    });
  }
});

// ==================== PER-TENANT QR PAGE ====================
app.get('/qr/:tenantId', (req, res) => {
  const id = Number(req.params.tenantId);
  const s = perTenantSessions.get(id);

  if (!s) {
    return res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Not found</title>
      <style>body{font-family:sans-serif;text-align:center;padding:3rem}</style></head><body>
      <h2>Tenant ${id} not served by this bot</h2><a href="/">Home</a></body></html>`);
  }

  if (s.connected) {
    return res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Connected</title>
      <style>body{font-family:sans-serif;text-align:center;padding:3rem;background:#f0f2f5}
      .c{background:#fff;padding:3rem;border-radius:20px;display:inline-block;box-shadow:0 10px 40px rgba(0,0,0,.1)}
      .check{font-size:3rem;color:#28a745}h2{color:#28a745}</style></head><body>
      <div class="c"><div class="check">✓</div><h2>Connected</h2>
      <p>Tenant #${id}</p><a href="/">← Home</a></div></body></html>`);
  }

  if (!s.qr) {
    return res.send(`<!doctype html><html><head><meta charset="utf-8"><title>QR pending</title>
      <style>body{font-family:sans-serif;text-align:center;padding:3rem}</style></head><body>
      <h2>QR not ready</h2><p>Refreshing…</p>
      <script>setTimeout(()=>location.reload(),3000)</script></body></html>`);
  }

  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Scan QR · tenant ${id}</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.1/build/qrcode.min.js"></script>
    <style>body{font-family:sans-serif;background:#f0f2f5;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:1rem}
    .c{background:#fff;padding:2rem;border-radius:20px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.1)}
    h2{color:#0f766e}#qrcode{margin:1rem auto;padding:1rem;border:3px dashed #0f766e;border-radius:15px;display:inline-block}</style></head><body>
    <div class="c"><h2>Scan QR · Tenant ${id}</h2><div id="qrcode"></div>
    <p style="color:#94a3b8;font-size:.8rem;margin-top:1rem">Auto-refreshes every 30 seconds</p></div>
    <script>
      QRCode.toCanvas(${JSON.stringify(s.qr)}, { width: 250, margin: 2 }, function(err, canvas) {
        if (!err) document.getElementById('qrcode').appendChild(canvas);
      });
      setTimeout(() => location.reload(), 30000);
    </script></body></html>`);
});

// ==================== HEALTH CHECK ====================
app.get('/health', (req, res) => {
  let data;
  if (isPerTenantMode()) {
    const connected = [...perTenantSessions.values()].filter(s => s.connected).length;
    data = {
      status: 'running',
      mode: 'per_tenant',
      whatsapp_connected: connected > 0 && connected === perTenantSessions.size,
      tenants_total: perTenantSessions.size,
      tenants_connected: connected,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  } else {
    data = {
      status: 'running',
      mode: 'shared',
      whatsapp_connected: sharedConnected,
      tenants_served: tenantQueues.size,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }

  const forced = (req.query.format || '').toLowerCase();
  const wantsHtml = forced === 'html'
    || (forced !== 'json' && (req.headers.accept || '').includes('text/html'));

  if (!wantsHtml) {
    return res.json(data);
  }

  const connected = data.whatsapp_connected;
  const uptimeMin = Math.floor(data.uptime / 60);
  const uptimeHr = Math.floor(uptimeMin / 60);
  const uptimeStr = uptimeHr > 0
    ? `${uptimeHr}h ${uptimeMin % 60}m`
    : `${uptimeMin} min`;

  res.send(`
  <!DOCTYPE html>
  <html>
  <head>
    <title>Health Check — Laundry Man Bot</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        display: flex; justify-content: center; align-items: center;
        min-height: 100vh; background: linear-gradient(135deg, #0f766e 0%, #115e59 100%);
        padding: 1rem;
      }
      .container {
        background: white; padding: 50px 40px; border-radius: 20px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.3); text-align: center;
        max-width: 460px; width: 100%;
      }
      .icon { font-size: 64px; margin-bottom: 20px; }
      h1 { color: #1b2b4b; margin-bottom: 10px; font-size: 26px; }
      p.subtitle { color: #666; margin-bottom: 20px; }

      .status {
        display: inline-block; padding: 10px 24px; border-radius: 25px;
        font-size: 15px; font-weight: bold; margin: 15px 0 25px;
      }
      .online { background: #e8f5e9; color: #28a745; }
      .offline { background: #ffeaea; color: #dc3545; }

      .stats {
        display: grid; gap: .5rem; margin-bottom: 25px; text-align: left;
      }
      .stat-row {
        display: flex; justify-content: space-between; align-items: center;
        padding: .6rem .9rem; background: #f8fafc; border-radius: 10px;
        font-size: 14px;
      }
      .stat-row .label {
        color: #94a3b8; font-weight: 600; text-transform: uppercase;
        letter-spacing: .03em; font-size: 12px;
      }
      .stat-row .value {
        color: #1b2b4b; font-weight: 700; font-family: ui-monospace, monospace;
        font-size: 13px;
      }

      .links { display: flex; flex-direction: column; gap: 10px; margin-top: 15px; }
      .links a {
        display: block; padding: 12px 24px; background: #0f766e; color: white;
        text-decoration: none; border-radius: 25px; font-weight: 600;
        transition: all 0.3s;
      }
      .links a:hover { background: #115e59; transform: translateY(-2px); }
      .links a.home { background: #6c757d; }
      .links a.home:hover { background: #5a6268; }

      .refresh {
        font-size: 12px; color: #94a3b8; margin-top: 20px;
      }
      .refresh a { color: #0f766e; text-decoration: none; font-weight: 600; }
      .refresh a:hover { text-decoration: underline; }

      .footer { margin-top: 20px; font-size: 11px; color: #cbd5e1; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="icon">${connected ? '✅' : '⚠️'}</div>
      <h1>Bot Health</h1>
      <p class="subtitle">Laundry Man WhatsApp Service</p>

      <span class="status ${connected ? 'online' : 'offline'}">
        ${connected ? '🟢 Connected' : '🔴 Disconnected'}
      </span>

      <div class="stats">
        <div class="stat-row">
          <span class="label">Status</span>
          <span class="value">${data.status}</span>
        </div>
        <div class="stat-row">
          <span class="label">Mode</span>
          <span class="value">${data.mode}</span>
        </div>
        <div class="stat-row">
          <span class="label">WhatsApp</span>
          <span class="value" style="color:${connected ? '#28a745' : '#dc3545'}">
            ${connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
        ${data.mode === 'shared'
          ? `<div class="stat-row">
              <span class="label">Tenants served</span>
              <span class="value">${data.tenants_served}</span>
            </div>`
          : `<div class="stat-row">
              <span class="label">Tenants connected</span>
              <span class="value">${data.tenants_connected} / ${data.tenants_total}</span>
            </div>`}
        <div class="stat-row">
          <span class="label">Uptime</span>
          <span class="value">${uptimeStr}</span>
        </div>
        <div class="stat-row">
          <span class="label">Checked at</span>
          <span class="value">${data.timestamp.slice(11, 19)} UTC</span>
        </div>
      </div>

      <div class="links">
        ${!connected ? `<a href="/qr">📱 Scan QR to Connect</a>` : ''}
        <a href="/" class="home">🏠 Back to Home</a>
      </div>

      <p class="refresh">
        <a href="/health?format=html">🔄 Refresh</a> ·
        <a href="/health?format=json">View raw JSON</a>
      </p>
      <div class="footer">Render Deployed • v2.0</div>
    </div>
  </body>
  </html>
  `);
});

// ==================== STATUS (JSON) ====================
app.get('/status', (req, res) => {
  res.json({
    ok: true,
    mode: isPerTenantMode() ? 'per_tenant' : 'shared',
    tenants: isPerTenantMode()
      ? [...perTenantSessions.entries()].map(([id, s]) => ({
          tenant_id: id,
          connected: s.connected,
          has_qr: !!s.qr,
        }))
      : [...tenantQueues.keys()].map(id => ({
          tenant_id: id,
          connected: sharedConnected,
        })),
  });
});

// ==================== RESTAURANT BOT ENDPOINTS (kept for compatibility) ====================
async function sendWhatsAppMessage(phoneNumber, message) {
  try {
    const sock = isPerTenantMode()
      ? [...perTenantSessions.values()][0]?.sock
      : sharedSock;

    const ready = isPerTenantMode()
      ? [...perTenantSessions.values()].some(s => s.connected)
      : sharedConnected;

    if (!sock || !ready) throw new Error('WhatsApp not connected');

    const formattedNumber = formatPhoneNumber(phoneNumber);
    const jid = `${formattedNumber}@s.whatsapp.net`;

    await sock.sendMessage(jid, { text: message });
    logger.info(`Message sent to ${phoneNumber}`);
    return true;
  } catch (error) {
    logger.error(`Failed to send message to ${phoneNumber}:`, error.message);
    return false;
  }
}

function generateOrderMessage(orderData) {
  const itemsList = (orderData.items || []).map((item, index) => {
    const name = item.item_name || item.name || 'Item';
    const qty = item.quantity || 1;
    const price = parseFloat(item.total_price || (item.unit_price * qty) || 0).toFixed(2);
    return `${index + 1}. ${name} x${qty} - $${price}`;
  }).join('\n');

  const total = parseFloat(orderData.total_amount || 0).toFixed(2);
  const payment = (orderData.payment_method || 'cash').toUpperCase();
  const carNumber = orderData.car_number || 'N/A';

  return `🛎️ *Order Confirmed!*\n\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `📋 *Order #:* ${orderData.order_number}\n` +
    `━━━━━━━━━━━━━━━━━━━\n\n` +
    `👤 *Customer:* ${orderData.customer_name}\n` +
    `🚗 *Car Number:* ${carNumber}\n\n` +
    `📦 *Order Details:*\n${itemsList}\n\n` +
    `💰 *Payment:* ${payment}\n` +
    `💵 *Total:* $${total}\n\n` +
    `⏱️ *Est. Time:* 15-20 minutes\n\n` +
    `📍 *Pickup:* Drive-Thru Window\n` +
    `🚗 We'll look for your car: *${carNumber}*\n\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `🙏 *Thank you for your order!*\n` +
    `Please wait in your car.`;
}

app.post('/send-confirmation', async (req, res) => {
  try {
    const orderData = req.body;
    if (!orderData.phone_number || !orderData.order_number) {
      return res.status(400).json({ success: false, message: 'Missing required fields: phone_number, order_number' });
    }
    const message = generateOrderMessage(orderData);
    const sent = await sendWhatsAppMessage(orderData.phone_number, message);
    if (sent) {
      logger.info(`Confirmation sent for order #${orderData.order_number}`);
      return res.json({ success: true, message: 'Order confirmation sent successfully' });
    }
    res.status(500).json({ success: false, message: 'Failed to send WhatsApp message' });
  } catch (error) {
    logger.error('Error sending confirmation:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/send-update', async (req, res) => {
  try {
    const { phone_number, message } = req.body;
    if (!phone_number || !message) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }
    const sent = await sendWhatsAppMessage(phone_number, message);
    res.json({ success: sent, message: sent ? 'Update sent' : 'Failed to send' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==================== START SERVER ====================
app.listen(PORT, async () => {
  logger.info(`🚀 Laundry Man Bot server running on port ${PORT}`);
  logger.info(`📍 Homepage: http://localhost:${PORT}`);
  logger.info(`📱 QR Code: http://localhost:${PORT}/qr`);
  logger.info(`❤️  Health: http://localhost:${PORT}/health`);

  if (isPerTenantMode()) {
    const list = parseTenantList(process.env.LM_TENANTS);
    logger.info(`Mode: PER-TENANT (${list.length} tenants)`);
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

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  for (const stop of tenantQueues.values()) stop();
  for (const s of perTenantSessions.values()) {
    if (s.queueStop) s.queueStop();
    try { await s.sock.logout(); } catch {}
  }
  try { if (sharedSock) await sharedSock.logout(); } catch {}
  process.exit(0);
});

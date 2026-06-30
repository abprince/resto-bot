const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const AUTH_FOLDER = './auth_info_baileys';

// Logger
const logger = pino({
    transport: {
        target: 'pino-pretty',
        options: { colorize: true }
    }
});

let sock = null;
let isConnected = false;
let qrCode = null;

// ==================== HOMEPAGE ====================
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>Resto Bot - Restaurant WhatsApp Service</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                display: flex; justify-content: center; align-items: center; 
                min-height: 100vh; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            }
            .container { 
                background: white; padding: 50px 40px; border-radius: 20px; 
                box-shadow: 0 20px 60px rgba(0,0,0,0.3); text-align: center; max-width: 450px; width: 90%;
            }
            .icon { font-size: 64px; margin-bottom: 20px; }
            h1 { color: #333; margin-bottom: 10px; font-size: 28px; }
            p { color: #666; margin-bottom: 20px; }
            .status { 
                display: inline-block; padding: 8px 20px; border-radius: 25px; 
                font-size: 14px; font-weight: bold; margin: 15px 0; 
            }
            .online { background: #e8f5e9; color: #28a745; }
            .offline { background: #ffeaea; color: #dc3545; }
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
            <div class="icon">🍔</div>
            <h1>Resto Bot</h1>
            <p>Restaurant WhatsApp Order Confirmation Service</p>
            <span class="status ${isConnected ? 'online' : 'offline'}">
                ${isConnected ? '🟢 Bot Online' : '🔴 Bot Offline'}
            </span>
            <div class="links">
                <a href="/qr">📱 Scan QR Code to Connect</a>
                <a href="/health" class="health">❤️ Health Check</a>
            </div>
            <div class="footer">
                Render Deployed • v1.0.0
            </div>
        </div>
    </body>
    </html>
    `);
});

// ==================== QR CODE PAGE ====================
app.get('/qr', (req, res) => {
    if (qrCode && !isConnected) {
        const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Scan QR Code - Resto Bot</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.1/build/qrcode.min.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex; justify-content: center; align-items: center;
            min-height: 100vh; background: #f0f2f5;
        }
        .container {
            background: white; padding: 40px 30px; border-radius: 20px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.1); text-align: center;
            max-width: 420px; width: 90%;
        }
        h2 { color: #25D366; margin-bottom: 5px; font-size: 24px; }
        .subtitle { color: #666; margin-bottom: 20px; font-size: 14px; }
        .status {
            display: inline-block; padding: 5px 15px; border-radius: 20px;
            font-size: 13px; font-weight: bold; margin-bottom: 20px;
        }
        .disconnected { background: #ffeaea; color: #dc3545; }
        .connected { background: #e8f5e9; color: #28a745; }
        #qrcode { 
            margin: 20px auto; padding: 20px; background: white;
            border: 3px dashed #25D366; border-radius: 15px; display: inline-block;
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
            background: #25D366; color: white; border: none;
            padding: 12px 35px; border-radius: 25px; font-size: 16px;
            cursor: pointer; margin-top: 20px; font-weight: 600;
            transition: all 0.3s;
        }
        .refresh-btn:hover { background: #1da851; transform: translateY(-2px); }
        .auto-refresh { font-size: 11px; color: #999; margin-top: 12px; }
        .spinner {
            display: inline-block; width: 16px; height: 16px; border: 2px solid #25D366;
            border-top: 2px solid transparent; border-radius: 50%;
            animation: spin 1s linear infinite; margin-right: 6px; vertical-align: middle;
        }
        @keyframes spin { 100% { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="container">
        <h2>🟢 WhatsApp QR Code</h2>
        <p class="subtitle">Resto Bot Connection</p>
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
        const qrString = "${qrCode.replace(/"/g, '\\"').replace(/\n/g, '\\n')}";
        const qrElement = document.getElementById('qrcode');
        
        QRCode.toCanvas(qrString, { 
            width: 250,
            margin: 2,
            color: {
                dark: '#000000',
                light: '#ffffff'
            }
        }, function(error, canvas) {
            if (error) {
                console.error(error);
                qrElement.innerHTML = '<p style="color:red;">Error loading QR code. Please refresh.</p>';
            } else {
                qrElement.appendChild(canvas);
            }
        });
        
        // Auto refresh every 30 seconds
        setTimeout(() => location.reload(), 30000);
    </script>
</body>
</html>`;
        
        res.send(html);
        
    } else if (isConnected) {
        res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Bot Connected - Resto Bot</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    display: flex; justify-content: center; align-items: center;
                    min-height: 100vh; background: #f0f2f5;
                }
                .container {
                    background: white; padding: 50px 40px; border-radius: 20px;
                    box-shadow: 0 10px 40px rgba(0,0,0,0.1); text-align: center;
                    max-width: 420px; width: 90%;
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
                <p>Your restaurant bot is online and ready to send order confirmations.</p>
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
            message: 'QR code not yet generated. Bot is initializing. Please refresh in a few seconds.' 
        });
    }
});

// ==================== HEALTH CHECK ====================
app.get('/health', (req, res) => {
    res.json({
        status: 'running',
        whatsapp_connected: isConnected,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// ==================== SEND ORDER CONFIRMATION ====================
app.post('/send-confirmation', async (req, res) => {
    try {
        const orderData = req.body;
        
        if (!orderData.phone_number || !orderData.order_number) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing required fields: phone_number, order_number' 
            });
        }

        if (!isConnected) {
            return res.status(503).json({ 
                success: false, 
                message: 'WhatsApp not connected. Please scan QR code first.' 
            });
        }

        const message = generateOrderMessage(orderData);
        const sent = await sendWhatsAppMessage(orderData.phone_number, message);

        if (sent) {
            logger.info(`Confirmation sent for order #${orderData.order_number}`);
            res.json({ success: true, message: 'Order confirmation sent successfully' });
        } else {
            res.status(500).json({ success: false, message: 'Failed to send WhatsApp message' });
        }
    } catch (error) {
        logger.error('Error sending confirmation:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== SEND ORDER UPDATE ====================
app.post('/send-update', async (req, res) => {
    try {
        const { phone_number, message } = req.body;
        
        if (!phone_number || !message) {
            return res.status(400).json({ 
                success: false, 
                message: 'Missing required fields: phone_number, message' 
            });
        }

        if (!isConnected) {
            return res.status(503).json({ 
                success: false, 
                message: 'WhatsApp not connected' 
            });
        }

        const sent = await sendWhatsAppMessage(phone_number, message);
        res.json({ success: sent, message: sent ? 'Update sent' : 'Failed to send' });
        
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== HELPER FUNCTIONS ====================
function formatPhoneNumber(phone) {
    let cleaned = phone.replace(/\D/g, '');
    if (cleaned.length === 10) {
        cleaned = '1' + cleaned;
    }
    return cleaned;
}

function generateOrderMessage(orderData) {
    const itemsList = orderData.items.map((item, index) => {
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

async function sendWhatsAppMessage(phoneNumber, message) {
    try {
        if (!sock || !isConnected) {
            throw new Error('WhatsApp not connected');
        }

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

// ==================== WHATSAPP CONNECTION ====================
async function connectToWhatsApp() {
    try {
        if (!fs.existsSync(AUTH_FOLDER)) {
            fs.mkdirSync(AUTH_FOLDER, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
        const { version } = await fetchLatestBaileysVersion();
        
        logger.info(`Starting WhatsApp with version ${version.join('.')}`);

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true,
            logger: pino({ level: 'silent' }),
            browser: ['Resto Bot', 'Chrome', '1.0.0']
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                qrCode = qr;
                logger.info('New QR Code received');
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error instanceof Boom 
                    ? lastDisconnect.error.output.statusCode 
                    : null;
                
                logger.warn(`Connection closed. Status: ${statusCode}`);
                isConnected = false;
                qrCode = null;
                
                if (statusCode !== DisconnectReason.loggedOut) {
                    logger.info('Attempting to reconnect...');
                    setTimeout(connectToWhatsApp, 5000);
                } else {
                    logger.warn('Logged out. Clearing auth folder...');
                    if (fs.existsSync(AUTH_FOLDER)) {
                        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
                    }
                    setTimeout(connectToWhatsApp, 3000);
                }
            } else if (connection === 'open') {
                logger.info('✅ WhatsApp connected successfully!');
                isConnected = true;
                qrCode = null;
            }
        });

        sock.ev.on('creds.update', saveCreds);

    } catch (error) {
        logger.error('Connection error:', error.message);
        setTimeout(connectToWhatsApp, 10000);
    }
}

// ==================== START SERVER ====================
app.listen(PORT, () => {
    logger.info(`🚀 Resto Bot server running on port ${PORT}`);
    logger.info(`📍 Homepage: http://localhost:${PORT}`);
    logger.info(`📱 QR Code: http://localhost:${PORT}/qr`);
    logger.info(`❤️ Health: http://localhost:${PORT}/health`);
    
    connectToWhatsApp();
});

// Graceful shutdown
process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    if (sock) {
        await sock.logout();
    }
    process.exit(0);
});
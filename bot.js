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

// Format phone number for WhatsApp
function formatPhoneNumber(phone) {
    let cleaned = phone.replace(/\D/g, '');
    if (cleaned.length === 10) {
        cleaned = '1' + cleaned;
    }
    return cleaned;
}

// Generate order confirmation message
function generateOrderMessage(orderData) {
    const itemsList = orderData.items.map((item, index) => {
        return `${index + 1}. ${item.item_name} x${item.quantity} - $${parseFloat(item.total_price).toFixed(2)}`;
    }).join('\n');

    const message = `🛎️ *Order Confirmed!*\n\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `*Order #:* ${orderData.order_number}\n` +
        `━━━━━━━━━━━━━━━━━━━\n\n` +
        `👤 *Customer:* ${orderData.customer_name}\n` +
        `🚗 *Car:* ${orderData.car_number}\n\n` +
        `📋 *Items:*\n${itemsList}\n\n` +
        `💰 *Payment:* ${orderData.payment_method.toUpperCase()}\n` +
        `💵 *Total:* $${parseFloat(orderData.total_amount).toFixed(2)}\n\n` +
        `⏱️ *Est. Time:* 15-20 mins\n\n` +
        `🙏 Thank you for your order!\n` +
        `Please wait in your car.`;

    return message;
}

// Send WhatsApp message
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
        logger.error(`Failed to send message: ${error.message}`);
        return false;
    }
}

// Connect to WhatsApp
async function connectToWhatsApp() {
    try {
        if (!fs.existsSync(AUTH_FOLDER)) {
            fs.mkdirSync(AUTH_FOLDER, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Restaurant Bot', 'Chrome', '1.0.0']
        });

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                qrCode = qr;
                logger.info('New QR Code received - scan with WhatsApp');
                // Print QR to terminal
                console.log('\n=== SCAN THIS QR CODE WITH WHATSAPP ===\n');
                require('qrcode-terminal').generate(qr, { small: true });
            }

            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error instanceof Boom) &&
                    lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
                
                logger.warn('Connection closed. Reconnecting:', shouldReconnect);
                isConnected = false;
                
                if (shouldReconnect) {
                    await connectToWhatsApp();
                } else {
                    if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
                        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
                    }
                }
            } else if (connection === 'open') {
                logger.info('WhatsApp connected successfully!');
                isConnected = true;
            }
        });

        sock.ev.on('creds.update', saveCreds);

    } catch (error) {
        logger.error('Connection error:', error);
        setTimeout(connectToWhatsApp, 5000);
    }
}

// API Routes
app.get('/health', (req, res) => {
    res.json({
        status: 'running',
        whatsapp_connected: isConnected,
        timestamp: new Date().toISOString()
    });
});

app.get('/qr', (req, res) => {
    if (qrCode) {
        res.json({ qr: qrCode, connected: isConnected });
    } else {
        res.json({ qr: null, connected: isConnected, message: 'Already connected or no QR yet' });
    }
});

app.post('/send-confirmation', async (req, res) => {
    try {
        const orderData = req.body;
        
        if (!orderData.phone_number || !orderData.order_number) {
            return res.status(400).json({ success: false, message: 'Missing order data' });
        }

        if (!isConnected) {
            return res.status(503).json({ success: false, message: 'WhatsApp not connected' });
        }

        const message = generateOrderMessage(orderData);
        const sent = await sendWhatsAppMessage(orderData.phone_number, message);

        res.json({ success: sent, message: sent ? 'Confirmation sent' : 'Failed to send' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/send-update', async (req, res) => {
    try {
        const { phone_number, message } = req.body;
        
        if (!phone_number || !message) {
            return res.status(400).json({ success: false, message: 'Missing data' });
        }

        const sent = await sendWhatsAppMessage(phone_number, message);
        res.json({ success: sent });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Start server
app.listen(PORT, () => {
    logger.info(`WhatsApp bot server running on port ${PORT}`);
    connectToWhatsApp();
});
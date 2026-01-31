const { 
    default: makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore, 
    useMultiFileAuthState,
    AuthenticationState
} = require('@whiskeysockets/baileys');
const { MongoClient } = require('mongodb');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;
let qrCode = "";

// AI Setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// --- MONGODB AUTH STORAGE FIX ---
async function useMongoDBAuthState(collection) {
    const writeData = (data, id) => {
        const json = JSON.stringify(data, (key, value) => {
            if (value instanceof Uint8Array || Buffer.isBuffer(value)) return Buffer.from(value).toString('base64');
            return value;
        });
        return collection.replaceOne({ _id: id }, { data: json }, { upsert: true });
    };

    const readData = async (id) => {
        const result = await collection.findOne({ _id: id });
        if (!result) return null;
        return JSON.parse(result.data, (key, value) => {
            if (typeof value === 'string' && /^[a-zA-Z0-9+/]*={0,2}$/.test(value) && value.length > 20) {
                // Heuristic to check if string is base64 buffer
                try { return Buffer.from(value, 'base64'); } catch { return value; }
            }
            return value;
        });
    };

    const removeData = async (id) => { await collection.deleteOne({ _id: id }); };

    // Initialize credentials
    let creds = await readData('creds');
    if (!creds) {
        // This generates a fresh set of credentials if Mongo is empty
        const temp = await useMultiFileAuthState('temp');
        creds = temp.state.creds;
        await writeData(creds, 'creds');
    }

    return {
        state: {
            creds,
            keys: makeCacheableSignalKeyStore({
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async id => {
                        const value = await readData(`${type}-${id}`);
                        if (value) data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    for (const type in data) {
                        for (const id in data[type]) {
                            const value = data[type][id];
                            if (value) await writeData(value, `${type}-${id}`);
                            else await removeData(`${type}-${id}`);
                        }
                    }
                }
            }, P({ level: 'silent' }))
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

// --- MAIN BOT ---
async function startBot() {
    try {
        const client = new MongoClient(process.env.MONGODB_URI);
        await client.connect();
        const db = client.db('whatsapp_bot');
        const collection = db.collection('session');

        const { state, saveCreds } = await useMongoDBAuthState(collection);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            logger: P({ level: 'error' }), // Only log errors
            browser: ['Mphatso AI', 'Chrome', '1.0.0'],
            // Removed printQRInTerminal to stop deprecation warning
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                qrCode = qr;
                console.log('⚡ New QR generated. View it at /qr');
            }
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error instanceof Boom) 
                    ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut 
                    : true;
                console.log('Connection closed. Reconnecting...', shouldReconnect);
                if (shouldReconnect) startBot();
            } else if (connection === 'open') {
                qrCode = "";
                console.log('🚀 MPHATSO IS ONLINE & LOGGED IN');
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            const msg = messages[0];
            if (!msg.message || msg.key.fromMe || type !== 'notify') return;

            const sender = msg.key.remoteJid;
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (!text) return;

            try {
                await sock.sendPresenceUpdate('composing', sender);
                const result = await model.generateContent(`Assistant: Mphatso. Rule: 1-2 sentences. User says: ${text}`);
                await sock.sendMessage(sender, { text: result.response.text() });
            } catch (e) { console.error("AI Error:", e.message); }
        });

    } catch (err) {
        console.error("Critical Start Error:", err);
        setTimeout(startBot, 5000); // Retry after 5s
    }
}

// Web Server
app.get('/', (req, res) => res.send('Bot Active'));
app.get('/qr', async (req, res) => {
    if (!qrCode) return res.send('<h1>Connected or checking...</h1>');
    QRCode.toDataURL(qrCode, (err, url) => {
        res.send(`<div style="text-align:center;"><h2>Scan to Link</h2><img src="${url}"/></div>`);
    });
});

app.listen(PORT, '0.0.0.0', () => startBot());
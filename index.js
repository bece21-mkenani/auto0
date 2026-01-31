const { 
    default: makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore, 
    BufferJSON,
    useMultiFileAuthState 
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

// --- MONGODB AUTH STORAGE (STABLE VERSION) ---
async function useMongoDBAuthState(collection) {
    const writeData = (data, id) => {
        // Use Baileys' native BufferJSON to convert Buffers to safe JSON
        const jsonStr = JSON.stringify(data, BufferJSON.replacer);
        return collection.replaceOne({ _id: id }, { data: jsonStr }, { upsert: true });
    };

    const readData = async (id) => {
        const result = await collection.findOne({ _id: id });
        if (!result) return null;
        // Convert back to original types (especially Buffers)
        return JSON.parse(result.data, BufferJSON.reviver);
    };

    const removeData = async (id) => collection.deleteOne({ _id: id });

    // Load or Initialize Credentials
    let creds = await readData('creds');
    if (!creds) {
        const { state } = await useMultiFileAuthState('temp_dir');
        creds = state.creds;
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

// --- MAIN BOT LOGIC ---
async function startBot() {
    try {
        const mClient = new MongoClient(process.env.MONGODB_URI);
        await mClient.connect();
        const db = mClient.db('whatsapp_bot');
        const collection = db.collection('session');

        const { state, saveCreds } = await useMongoDBAuthState(collection);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            logger: P({ level: 'error' }),
            browser: ['Mphatso AI', 'Chrome', '1.0.0'],
            generateHighQualityLinkPreview: true
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                qrCode = qr;
                console.log('⚡ QR Ready! Scan at /qr');
            }
            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error instanceof Boom) 
                    ? lastDisconnect.error.output.statusCode 
                    : 500;
                
                // Only stop if logged out, otherwise always reconnect
                if (statusCode !== DisconnectReason.loggedOut) {
                    console.log('🔄 Reconnecting in 5s...');
                    setTimeout(startBot, 5000);
                } else {
                    console.log('❌ Logged out. Delete Mongo collection and restart.');
                }
            } else if (connection === 'open') {
                qrCode = "";
                console.log('🚀 Mphatso AI is Online!');
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            const m = messages[0];
            if (!m.message || m.key.fromMe || type !== 'notify') return;

            const sender = m.key.remoteJid;
            const text = m.message.conversation || m.message.extendedTextMessage?.text;
            if (!text) return;

            try {
                await sock.sendPresenceUpdate('composing', sender);
                const response = await model.generateContent(`Assistant: Mphatso. Tone: Helpful & Witty. Brief. User: ${text}`);
                await sock.sendMessage(sender, { text: `*AI:* ${response.response.text()}` });
            } catch (err) {
                console.error("Gemini Error:", err.message);
            }
        });

    } catch (err) {
        console.error("Fatal Error:", err);
        setTimeout(startBot, 10000);
    }
}

// Web Server
app.get('/', (req, res) => res.send('Bot Status: Active'));
app.get('/qr', async (req, res) => {
    if (!qrCode) return res.send('<h1>Connected Successfully!</h1>');
    QRCode.toDataURL(qrCode, (err, url) => {
        res.send(`<div style="text-align:center;"><h2>Scan to Link Bot</h2><img src="${url}"/></div>`);
    });
});

app.listen(PORT, '0.0.0.0', () => startBot());
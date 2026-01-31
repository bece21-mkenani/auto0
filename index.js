const { 
    default: makeWASocket, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore, 
    useMultiFileAuthState,
    proto
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

// --- MONGODB AUTH STORAGE LOGIC ---
// This replicates useMultiFileAuthState but inside MongoDB to save RAM/Disk
async function useMongoDBAuthState(collection) {
    const writeData = (data, id) => {
        return collection.replaceOne({ _id: id }, { data: JSON.parse(JSON.stringify(data, (key, value) => typeof value === 'Uint8Array' ? Buffer.from(value).toString('base64') : value)) }, { upsert: true });
    };

    const readData = async (id) => {
        const result = await collection.findOne({ _id: id });
        if (!result) return null;
        return JSON.parse(JSON.stringify(result.data), (key, value) => {
            if (value && typeof value === 'object' && value.type === 'Buffer') return Buffer.from(value.data);
            return value;
        });
    };

    const removeData = async (id) => {
        await collection.deleteOne({ _id: id });
    };

    const creds = await readData('creds') || (await useMultiFileAuthState('temp').creds); // Fallback to fresh creds

    return {
        state: {
            creds,
            keys: makeCacheableSignalKeyStore({
                get: (type, ids) => {
                    return ids.reduce(async (acc, id) => {
                        const data = await readData(`${type}-${id}`);
                        if (data) (await acc)[id] = data;
                        return acc;
                    }, Promise.resolve({}));
                },
                set: (data) => {
                    for (const type in data) {
                        for (const id in data[type]) {
                            const value = data[type][id];
                            if (value) writeData(value, `${type}-${id}`);
                            else removeData(`${type}-${id}`);
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
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    const db = client.db('whatsapp_bot');
    const collection = db.collection('session');

    const { state, saveCreds } = await useMongoDBAuthState(collection);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: P({ level: 'silent' }),
        browser: ['Mphatso Assistant', 'Chrome', '1.0.0']
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrCode = qr;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) 
                ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut 
                : true;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            qrCode = "";
            console.log('🚀 MPHATSO IS ONLINE & LOGGED INTO MONGO');
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
            const prompt = `Assistant: Mphatso. Rule: 2 sentences max. User says: ${text}`;
            const result = await model.generateContent(prompt);
            await sock.sendMessage(sender, { text: `*AI:* ${result.response.text()}` });
        } catch (e) { console.error("Error:", e); }
    });
}

// Web Server
app.get('/', (req, res) => res.send('Bot is active. Check /qr.'));
app.get('/qr', async (req, res) => {
    if (!qrCode) return res.send('Connected.');
    const url = await QRCode.toDataURL(qrCode);
    res.send(`<img src="${url}" width="300">`);
});

app.listen(PORT, '0.0.0.0', () => startBot());
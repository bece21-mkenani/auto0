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
let db, sessionCol, userCol;

// AI Setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); 

// Helper: Delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- MESSAGE QUEUE SYSTEM ---
const messageQueue = [];
let isProcessing = false;

async function processQueue(sock) {
    if (isProcessing || messageQueue.length === 0) return;
    isProcessing = true;

    const { m, sender, text } = messageQueue.shift();

    try {
        // --- USER MEMORY FETCH ---
        let userData = await userCol.findOne({ whatsappId: sender });
        if (!userData) {
            userData = { whatsappId: sender, name: "New Friend", facts: [] };
            await userCol.insertOne(userData);
        }

        const hour = new Date().getHours();
        const bossStatus = (hour >= 23 || hour <= 6) ? "sleeping 😴" : (hour >= 9 && hour <= 17) ? "focus mode 👨‍💻" : "busy 🛠️";

        // Show Typing indicator
        await sock.sendPresenceUpdate('composing', sender);

        const systemInstruction = `
            Your name is Mphatso, assistant to mkenani.
            mkenani is ${bossStatus}.
            User Info: Name is ${userData.name}, Facts: ${userData.facts.join(", ") || "None yet"}.
            Instructions: Be friendly, witty, and helpful. Mention their name if known.
            STRICT LIMIT: Max 2 lines. 
        `;

        const result = await model.generateContent(`${systemInstruction}\n\nUser Message: ${text}`);
        let responseText = result.response.text().trim().split('\n').slice(0, 2).join('\n');

        // Fast typing simulation
        const typingTime = Math.min(Math.max(responseText.length * 25, 800), 3000);
        await delay(typingTime);

        // --- SEND REPLY QUOTING THE MESSAGE ---
        await sock.sendMessage(sender, { 
            text: responseText 
        }, { 
            quoted: m 
        });

        await sock.sendPresenceUpdate('paused', sender);

    } catch (err) {
        console.error("Mphatso Queue Error:", err.message);
        await sock.sendPresenceUpdate('paused', sender);
    }

    isProcessing = false;
    processQueue(sock);
}

// --- MONGODB AUTH (Separate Collections) ---
async function useMongoDBAuthState(collection) {
    const writeData = (data, id) => collection.replaceOne({ _id: id }, { data: JSON.stringify(data, BufferJSON.replacer) }, { upsert: true });
    const readData = async (id) => {
        const res = await collection.findOne({ _id: id });
        return res ? JSON.parse(res.data, BufferJSON.reviver) : null;
    };
    const removeData = async (id) => collection.deleteOne({ _id: id });

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
                        const val = await readData(`${type}-${id}`);
                        if (val) data[id] = val;
                    }));
                    return data;
                },
                set: async (data) => {
                    for (const type in data) {
                        for (const id in data[type]) {
                            const val = data[type][id];
                            if (val) await writeData(val, `${type}-${id}`);
                            else await removeData(`${type}-${id}`);
                        }
                    }
                }
            }, P({ level: 'silent' }))
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

// --- START BOT ---
async function startBot() {
    try {
        const mClient = new MongoClient(process.env.MONGODB_URI);
        await mClient.connect();
        db = mClient.db('mphatso_v2'); 
        sessionCol = db.collection('auth_session'); 
        userCol = db.collection('user_memory');    

        const { state, saveCreds } = await useMongoDBAuthState(sessionCol);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            logger: P({ level: 'error' }),
            browser: ['Mphatso Assistant', 'Chrome', '1.0.0'],
            markOnlineOnConnect: false
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', (upd) => {
            const { connection, lastDisconnect, qr } = upd;
            if (qr) qrCode = qr;
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error instanceof Boom) && 
                                       lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) startBot();
            } else if (connection === 'open') {
                qrCode = "";
                console.log('🚀 MPHATSO IS CONNECTED');
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            const m = messages[0];
            
            // 1. Skip if empty, from yourself, or FROM A GROUP (@g.us)
            if (!m.message || m.key.fromMe || m.key.remoteJid.endsWith('@g.us') || type !== 'notify') return;

            const text = m.message.conversation || m.message.extendedTextMessage?.text || "";
            if (!text) return;

            messageQueue.push({ m, sender: m.key.remoteJid, text });
            processQueue(sock);
        });

    } catch (err) {
        console.error("Bot Start Fail:", err);
        setTimeout(startBot, 10000);
    }
}

// Routes
app.get('/', (req, res) => res.send('Mphatso AI v2 is running. Status: Active'));
app.get('/qr', async (req, res) => {
    if (!qrCode) return res.send('<h1>Connected!</h1>');
    QRCode.toDataURL(qrCode, (err, url) => {
        res.send(`<div style="text-align:center;"><h2>Scan to Link Account</h2><img src="${url}"/></div>`);
    });
});

app.listen(PORT, '0.0.0.0', () => startBot());
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

// AI Configuration
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// --- INSTANT QUEUE SYSTEM ---
const messageQueue = [];
let isProcessing = false;

async function processQueue(sock) {
    if (isProcessing || messageQueue.length === 0) return;
    isProcessing = true;
    
    const { m, sender, text } = messageQueue.shift();

    try {
        // 1. Database Lookup (Memory)
        let userData = await userCol.findOne({ _id: sender });
        if (!userData) {
            userData = { _id: sender, name: "Unknown", facts: [], firstSeen: new Date() };
            await userCol.insertOne(userData);
        }

        const hour = new Date().getHours();
        const bossStatus = (hour >= 23 || hour <= 6) ? "sleeping 😴" : (hour >= 9 && hour <= 17) ? "focus mode 👨‍💻" : "busy 🛠️";

        // 2. Instant Presence
        await sock.sendPresenceUpdate('composing', sender);

        const systemInstruction = `
            Your name is Mphatso, assistant to mkenani. 
            Boss Status: mkenani is ${bossStatus}. 
            User Context: Name is "${userData.name}". Memory: ${userData.facts.join(", ") || "None"}.
            Style: Helpful, witty, human-like. 
            RULE: Max 2 lines. Respond INSTANTLY. No fluff.
        `;

        // 3. AI Generation
        const result = await model.generateContent(`${systemInstruction}\n\nUser: ${text}`);
        const responseText = result.response.text().trim().split('\n').slice(0, 2).join('\n');

        // 4. Instant Delivery
        await sock.sendMessage(sender, { text: responseText }, { quoted: m });
        await sock.readMessages([m.key]);

        // 5. Dynamic Memory Learning
        const nameMatch = text.match(/(?:my name is|call me|i am)\s+([a-zA-Z]+)/i);
        if (nameMatch) {
            await userCol.updateOne({ _id: sender }, { $set: { name: nameMatch[1] } });
        }

    } catch (err) {
        console.error("Mphatso Error:", err.message);
    } finally {
        await sock.sendPresenceUpdate('paused', sender);
        isProcessing = false;
        processQueue(sock); // Move to next message immediately
    }
}

// --- MONGODB AUTH (auth_v7 - Clean Start) ---
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

// --- CORE BOT ENGINE ---
async function startBot() {
    try {
        const mClient = new MongoClient(process.env.MONGODB_URI);
        await mClient.connect();
        db = mClient.db('MphatsoPremium'); 
        sessionCol = db.collection('auth_v7'); // Fresh collection
        userCol = db.collection('user_memory'); 

        const { state, saveCreds } = await useMongoDBAuthState(sessionCol);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            logger: P({ level: 'error' }),
            browser: ['Mphatso V7', 'Chrome', '1.0.0'],
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: true
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
                console.log('🚀 MPHATSO PREMIUM IS LIVE');
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            const m = messages[0];
            if (!m.message || m.key.fromMe || m.key.remoteJid.endsWith('@g.us') || type !== 'notify') return;

            const text = m.message.conversation || m.message.extendedTextMessage?.text || "";
            if (!text) return;

            messageQueue.push({ m, sender: m.key.remoteJid, text });
            processQueue(sock);
        });

    } catch (err) {
        console.error("Startup Failure:", err);
        setTimeout(startBot, 10000);
    }
}

// --- WEB ROUTES ---
app.get('/', (req, res) => res.send('Mphatso Premium: Always Online'));
app.get('/qr', async (req, res) => {
    if (!qrCode) return res.send('<h1>✅ Bot Connected Successfully</h1>');
    QRCode.toDataURL(qrCode, (err, url) => {
        res.send(`
            <div style="text-align:center; font-family:sans-serif; margin-top:50px;">
                <h2>Scan to Connect Mphatso</h2>
                <img src="${url}" style="border: 10px solid #25D366; border-radius:15px;"/>
                <p>Refresh page if QR doesn't load.</p>
            </div>
        `);
    });
});

app.listen(PORT, '0.0.0.0', () => startBot());
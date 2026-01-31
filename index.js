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
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// Helper: Delay function
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- MONGODB AUTH STORAGE ---
async function useMongoDBAuthState(collection) {
    const writeData = (data, id) => {
        const jsonStr = JSON.stringify(data, BufferJSON.replacer);
        return collection.replaceOne({ _id: id }, { data: jsonStr }, { upsert: true });
    };
    const readData = async (id) => {
        const result = await collection.findOne({ _id: id });
        return result ? JSON.parse(result.data, BufferJSON.reviver) : null;
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
            browser: ['Mphatso Assistant', 'Chrome', '1.0.0']
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) qrCode = qr;
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error instanceof Boom) 
                    ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut 
                    : true;
                if (shouldReconnect) startBot();
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

            // Personal Assistant Logic
            const hour = new Date().getHours();
            const bossStatus = (hour >= 23 || hour <= 6) ? "sleeping 😴" : (hour >= 9 && hour <= 17) ? "focus mode 👨‍💻" : "busy 🛠️";

            try {
                // 1. Mark as Read
                await sock.readMessages([m.key]);

                // 2. Start Typing Indicator
                await sock.sendPresenceUpdate('composing', sender);

                const systemInstruction = `
                    Your name is Mphatso, assistant to mkenani.
                    Current Status: mkenani is ${bossStatus}.
                    Instructions: Be extremely friendly, witty, and helpful.
                    STRICT LIMIT: Maximum 2 lines of text.
                `;

                const result = await model.generateContent(`${systemInstruction}\n\nUser: ${text}`);
                let responseText = result.response.text().trim();

                // Ensure 2-line limit
                responseText = responseText.split('\n').slice(0, 2).join('\n');

                // 3. Simulated "Letter by Letter" Delay
                // Calculation: ~50ms per character (minimum 1.5s, maximum 6s)
                const typingTime = Math.min(Math.max(responseText.length * 50, 1500), 6000);
                await delay(typingTime);

                // 4. Send Message
                await sock.sendMessage(sender, { text: responseText });
                
                // 5. Stop Typing
                await sock.sendPresenceUpdate('paused', sender);

            } catch (err) {
                console.error("Gemini Error:", err.message);
            }
        });

    } catch (err) {
        console.error("Fatal Error:", err);
        setTimeout(startBot, 10000);
    }
}


app.get('/', (req, res) => res.send('Mphatso AI is running.'));
app.get('/qr', async (req, res) => {
    if (!qrCode) return res.send('<h1>Connected.</h1>');
    QRCode.toDataURL(qrCode, (err, url) => {
        res.send(`<div style="text-align:center;"><h2>Scan to Link</h2><img src="${url}"/></div>`);
    });
});

app.listen(PORT, '0.0.0.0', () => startBot());
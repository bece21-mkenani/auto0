const dns = require('node:dns/promises');
dns.setServers(['8.8.8.8', '1.1.1.1']);

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const {
    default: makeWASocket,
    DisconnectReason,
    makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const pino = require('pino');

let latestQR = '';
const chatHistories = new Map();
const mkenaniLastSpoke = new Map();

const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => {
    res.send(`
        <div style="text-align:center; font-family:sans-serif; margin-top:50px;">
            <h1>Mphatso AI Status: Active 🚀</h1>
            <p>To link a new device, go to <a href="/qr">/qr</a></p>
        </div>
    `);
});

app.get('/qr', (req, res) => {
    if (!latestQR) {
        return res.send("<h1>No QR generated. The bot might already be logged in!</h1>");
    }
    QRCode.toDataURL(latestQR, (err, url) => {
        if (err) return res.send("Error generating QR image.");
        res.send(`
            <div style="text-align:center; font-family:sans-serif; margin-top:20px;">
                <h2>Scan this with WhatsApp</h2>
                <img src="${url}" style="border: 15px solid white; box-shadow: 0 0 15px rgba(0,0,0,0.2); width:350px;"/>
                <p><i>The QR refreshes automatically. Scan it quickly!</i></p>
            </div>
        `);
    });
});

app.listen(PORT, '0.0.0.0', () => console.log(`✅ Web Server running on port ${PORT}`));


const userSchema = new mongoose.Schema({
    whatsappId: String,
    name: String,
    facts: [String],
    lastInteraction: Date
});
const User = mongoose.model('User', userSchema);

const authStateSchema = new mongoose.Schema({
    id: { type: String, default: 'auth_state' },
    creds: { type: Object, default: {} }
});
const AuthState = mongoose.model('AuthState', authStateSchema);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const tools = {
    updateUserProfile: async (whatsappId, name, fact) => {
        const update = {};
        if (name) update.name = name;
        if (fact) update.$push = { facts: fact };

        const user = await User.findOneAndUpdate(
            { whatsappId },
            update,
            { upsert: true, new: true }
        );
        return `Profile updated: ${user.name || whatsappId} – facts: ${user.facts.join(', ')}`;
    }
};

const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    tools: [{
        functionDeclarations: [{
            name: "updateUserProfile",
            description: "Updates the user's name or saves a fact about them.",
            parameters: {
                type: "OBJECT",
                properties: {
                    name: { type: "STRING", description: "The user's name." },
                    fact: { type: "STRING", description: "A fact to remember." }
                },
                required: []
            }
        }]
    }],
    generationConfig: { maxOutputTokens: 150 },
    systemInstruction: "You are Mphatso, personal assistant to mkenani. Be brief (1-2 sentences), witty, and helpful."
});

function getMkenaniStatus() {
    const hour = new Date().getHours();
    if (hour >= 23 || hour <= 6) return "sleeping 😴";
    if (hour >= 9 && hour <= 17) return "in deep focus mode 👨‍💻";
    return "currently busy 🛠️";
}

// WhatsApp Connection
async function connectToWhatsApp() {
    const logger = pino({ level: 'silent' });

    const authDoc = await AuthState.findOne({ id: 'auth_state' }) ||
                    await new AuthState({ id: 'auth_state' }).save();

    const saveCreds = async () => {
        authDoc.creds = sock.authState.creds;
        await authDoc.save();
    };

    const sock = makeWASocket({
        auth: {
            creds: authDoc.creds,
            keys: makeCacheableSignalKeyStore({}, logger),
        },
        printQRInTerminal: false,
        logger,
        browser: ['Mphatso AI', 'Chrome', '120.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            latestQR = qr;
            console.log('⚡ New QR received. Scan at /qr');
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                connectToWhatsApp();
            } else {
                console.log('Logged out – clearing session');
                AuthState.deleteOne({ id: 'auth_state' }).then(() => connectToWhatsApp());
            }
        } else if (connection === 'open') {
            latestQR = '';
            console.log('🚀 Mphatso is online!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        if (from.endsWith('@g.us') || from === 'status@broadcast') return;

        const text = msg.message.conversation ||
                     msg.message.extendedTextMessage?.text ||
                     '';

        if (msg.key.fromMe) {
            mkenaniLastSpoke.set(from, Date.now());
            return;
        }

        const lastMeTime = mkenaniLastSpoke.get(from) || 0;
        const cooldown = 50 * 60 * 1000;
        if (Date.now() - lastMeTime < cooldown) return;

        try {
            await sock.sendPresenceUpdate('composing', from);

            let userProfile = await User.findOne({ whatsappId: from }) ||
                              await User.create({ whatsappId: from, facts: [] });

            let chat = chatHistories.get(from);
            if (!chat) {
                chat = model.startChat({});
                chatHistories.set(from, chat);
            }

            const dynamicPrompt = `Current status: mkenani is ${getMkenaniStatus()}.\n` +
                                 `User name: ${userProfile.name || 'Unknown'}.\n` +
                                 `Known facts: ${userProfile.facts.join(', ') || 'None'}.\n\n` +
                                 `User message: ${text}`;

            let result = await chat.sendMessage(dynamicPrompt);
            let responseText = result.response.text();

            const functionCalls = result.response.functionCalls();
            if (functionCalls?.length) {
                for (const fc of functionCalls) {
                    if (fc.name === 'updateUserProfile') {
                        const args = fc.args || {};
                        const toolResult = await tools.updateUserProfile(from, args.name, args.fact);

                        const continueResult = await chat.sendMessage({
                            functionResponse: {
                                name: fc.name,
                                response: { result: toolResult }
                            }
                        });
                        responseText = continueResult.response.text();
                    }
                }
            }

            await sock.sendMessage(from, { text: `*AI:* ${responseText}` });

        } catch (error) {
            console.error('Message handling error:', error);
        }
    });
}
mongoose.connect(process.env.MONGODB_URI).then(async () => {
    console.log('✅ Connected to MongoDB Atlas');
    connectToWhatsApp();
});

setInterval(() => {
    axios.get(`https://wautomation.onrender.com/`).catch(() => {});
}, 10 * 60 * 1000);
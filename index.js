const dns = require('node:dns/promises');
dns.setServers(['8.8.8.8', '1.1.1.1']);

const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const qrcodeTerminal = require('qrcode-terminal'); 
const QRCode = require('qrcode');                 
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const axios = require('axios');
require('dotenv').config();

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
        return res.send("<h1>No QR generated. If you just scanned, wait a moment for 'Ready' status.</h1>");
    }
    QRCode.toDataURL(latestQR, (err, url) => {
        res.send(`
            <div style="text-align:center; font-family:sans-serif; margin-top:20px;">
                <h2>Scan this with WhatsApp</h2>
                <img src="${url}" style="border: 15px solid white; box-shadow: 0 0 15px rgba(0,0,0,0.2); width:350px;"/>
                <p><i>Bot will start responding once the QR disappears from this page.</i></p>
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
const mkenaniLastSpoke = new Map(); 

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const tools = {
    updateUserProfile: async (whatsappId, name, fact) => {
        const update = {};
        if (name) update.name = name;
        const user = await User.findOneAndUpdate(
            { whatsappId }, 
            { $set: update, $push: fact ? { facts: fact } : {} },
            { upsert: true, new: true }
        );
        return `Updated profile for ${user.name || whatsappId}`;
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
                }
            }
        }]
    }],
    generationConfig: { maxOutputTokens: 80 }
});

const chatHistories = new Map();

function getMkenaniStatus() {
    const hour = new Date().getHours();
    if (hour >= 23 || hour <= 6) return "sleeping 😴";
    if (hour >= 9 && hour <= 17) return "in deep focus mode 👨‍💻";
    return "currently busy 🛠️";
}

mongoose.connect(process.env.MONGODB_URI).then(() => {
    console.log('✅ Connected to MongoDB Atlas');

    const client = new Client({
        authStrategy: new RemoteAuth({
            store: new MongoStore({ mongoose }),
            backupSyncIntervalMs: 300000 
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-extensions',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process', 
                '--disable-gpu'
            ],
            
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36'
        }
    });

    let latestQR = ""; 
    client.on('qr', (qr) => {
        latestQR = qr; 
        console.log('⚡ New QR received.');
        qrcodeTerminal.generate(qr, { small: false });
    });

    client.on('ready', () => {
        latestQR = ""; 
        console.log('🚀 Mphatso is online and ready for messages!');
    });

    client.on('message', async (msg) => {
        console.log(`📩 Message received from ${msg.from}: ${msg.body}`); 

        if (msg.from.endsWith('@g.us') || msg.isStatus) return;
        if (msg.fromMe) {
            mkenaniLastSpoke.set(msg.to, Date.now());
            return;
        }

        const lastMeTime = mkenaniLastSpoke.get(msg.from) || 0;
        const cooldown = 50 * 60 * 1000; 
        
        if (Date.now() - lastMeTime < cooldown) return;

        try {
            const chat = await msg.getChat();
            await chat.sendStateTyping();

            let userProfile = await User.findOne({ whatsappId: msg.from }) || 
                              await User.create({ whatsappId: msg.from, facts: [] });

            const systemInstruction = `
                Your name is Mphatso, assistant to mkenani. 
                STATUS: mkenani is ${getMkenaniStatus()}.
                USER: ${userProfile.name || "Unknown"}.
                KNOWN FACTS: ${userProfile.facts.join(", ")}.
                STRICT RULES: Brief (2 sentences), witty.
            `;

            if (!chatHistories.has(msg.from)) {
                chatHistories.set(msg.from, model.startChat({ history: [] }));
            }
            const userChat = chatHistories.get(msg.from);

            const result = await userChat.sendMessage([
                { text: systemInstruction },
                { text: msg.body }
            ]);

            const call = result.response.functionCalls()?.[0];

            if (call && call.name === "updateUserProfile") {
                const { name, fact } = call.args;
                await tools.updateUserProfile(msg.from, name, fact);
                const followUp = await userChat.sendMessage("Give a 1-sentence confirmation.");
                await msg.reply(`*AI:* ${followUp.response.text()}`);
            } else {
                await msg.reply(`*AI:* ${result.response.text()}`);
            }

        } catch (error) {
            console.error("Bot Error:", error);
        }
    });

    client.initialize();
});


setInterval(() => {
    axios.get(`https://wautomation.onrender.com/`).catch(() => {});
}, 10 * 60 * 1000);
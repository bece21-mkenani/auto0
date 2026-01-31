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

// --- GLOBAL STATE ---
let latestQR = ""; 
const chatHistories = new Map();
const mkenaniLastSpoke = new Map(); 

// --- WEB SERVER ---
const app = express();
const PORT = process.env.PORT || 10000; 

app.get('/', (req, res) => {
    res.send('<div style="text-align:center;padding:50px;"><h1>Mphatso AI: Active 🚀</h1><p>Visit <a href="/qr">/qr</a> to link.</p></div>');
});

app.get('/qr', (req, res) => {
    if (!latestQR) return res.send("<h1>No QR generated. Bot is likely logged in!</h1>");
    QRCode.toDataURL(latestQR, (err, url) => {
        res.send(`<div style="text-align:center;"><img src="${url}" width="350"/><p>Scan to Start</p></div>`);
    });
});

app.listen(PORT, '0.0.0.0', () => console.log(`✅ Server on port ${PORT}`));

// --- AI SETUP ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const userSchema = new mongoose.Schema({ whatsappId: String, name: String, facts: [String] });
const User = mongoose.model('User', userSchema);

const model = genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash", 
    generationConfig: { maxOutputTokens: 100 }
});

function getStatus() {
    const hr = new Date().getHours();
    return (hr >= 23 || hr <= 6) ? "sleeping 😴" : (hr >= 9 && hr <= 17) ? "focus mode 👨‍💻" : "busy 🛠️";
}

// --- BOT INITIALIZATION ---
mongoose.connect(process.env.MONGODB_URI).then(() => {
    console.log('✅ MongoDB Connected');

    const client = new Client({
        authStrategy: new RemoteAuth({
            store: new MongoStore({ mongoose }),
            backupSyncIntervalMs: 300000 
        }),
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
        },
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', '--shm-size=1gb'
            ],
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });

    client.on('qr', qr => { latestQR = qr; qrcodeTerminal.generate(qr, { small: true }); });

    client.on('ready', () => { 
        latestQR = ""; 
        console.log('🚀 MPHATSO IS ONLINE AND RECEIVING MESSAGES!'); 
    });

    client.on('message', async (msg) => {
        // Log incoming for debugging
        console.log(`📩 New message from ${msg.from}: ${msg.body}`);

        if (msg.from.endsWith('@g.us') || msg.isStatus) return;
        if (msg.fromMe) { mkenaniLastSpoke.set(msg.to, Date.now()); return; }

        const cooldown = 50 * 60 * 1000; 
        if (Date.now() - (mkenaniLastSpoke.get(msg.from) || 0) < cooldown) return;

        try {
            const chat = await msg.getChat();
            await chat.sendStateTyping(); // This should now trigger

            let profile = await User.findOne({ whatsappId: msg.from }) || 
                         await User.create({ whatsappId: msg.from, facts: [] });

            const prompt = `Name: Mphatso. Boss: mkenani (currently ${getStatus()}). User: ${profile.name || "New friend"}. Rules: Brief (2 sentences), witty. Response:`;
            
            if (!chatHistories.has(msg.from)) chatHistories.set(msg.from, model.startChat());
            const result = await chatHistories.get(msg.from).sendMessage(prompt + msg.body);
            
            await msg.reply(`*AI:* ${result.response.text()}`);
        } catch (e) { console.error("Error:", e); }
    });

    client.initialize();
});

// Keep-alive ping
setInterval(() => axios.get(`https://wautomation.onrender.com/`).catch(() => {}), 600000);
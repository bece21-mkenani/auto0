const dns = require('node:dns/promises');
dns.setServers(['8.8.8.8', '1.1.1.1']);

const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();


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
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    client.on('qr', (qr) => {
        console.log('⚡ QR Code generated! Scan it quickly:');
        qrcode.generate(qr, { small: false });
    });

    client.on('ready', () => console.log('🚀 Mphatso is online!'));

    client.on('message', async (msg) => {
       
        if (msg.from.endsWith('@g.us') || msg.isStatus) return;
        if (msg.fromMe) {
            mkenaniLastSpoke.set(msg.to, Date.now());
            return;
        }

        const lastMeTime = mkenaniLastSpoke.get(msg.from) || 0;
        const cooldown = 50 * 60 * 1000; 
        
        if (Date.now() - lastMeTime < cooldown) {
            return;
        }

        try {
            const chat = await msg.getChat();
            await chat.sendStateTyping();

            let userProfile = await User.findOne({ whatsappId: msg.from }) || 
                              await User.create({ whatsappId: msg.from, facts: [] });

            const systemInstruction = `
                Your name is Mphatso, personal assistant to mkenani. 
                STATUS: mkenani is ${getMkenaniStatus()}.
                USER: ${userProfile.name || "Unknown"}.
                KNOWN FACTS: ${userProfile.facts.join(", ")}.

                STRICT RULES:
                1. Be extremely brief (Max 2 sentences).
                2. Be witty.
                3. Use 'updateUserProfile' for names/facts.
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
            if (error.status === 429) {
                await msg.reply("*AI:* Give me a sec, mkenani will respond shortly.");
            } else {
                console.error("Bot Error:", error);
            }
        }
    });

    client.initialize();
});


const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Mphatso Assistant is alive and breathing! 🚀');
});

app.listen(PORT, () => {
    console.log(`Health check server running on port ${PORT}`);
});

const axios = require('axios');
setInterval(() => {
    axios.get(`https://wautomation.onrender.com/`).catch(err => console.log("Ping failed, but that's okay."));
}, 10 * 60 * 1000); 
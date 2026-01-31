

require('dotenv').config();

const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  BufferJSON
} = require('@whiskeysockets/baileys');

const { MongoClient } = require('mongodb');
const { Boom } = require('@hapi/boom');
const Pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const { GoogleGenerativeAI } = require('@google/generative-ai');

/* ---------------- BASIC SETUP ---------------- */

const app = express();
const PORT = process.env.PORT || 10000;
let CURRENT_QR = '';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

let db, authCol, userCol;

/* ---------------- MESSAGE QUEUE ---------------- */

const queue = [];
let processing = false;

async function processQueue(sock) {
  if (processing || queue.length === 0) return;
  processing = true;

  const job = queue.shift();
  const { m, jid, text } = job;

  try {
    await sock.sendPresenceUpdate('composing', jid);

    let user = await userCol.findOne({ _id: jid });
    if (!user) {
      user = { _id: jid, name: 'Unknown', facts: [], firstSeen: new Date() };
      await userCol.insertOne(user);
    }

    const hour = new Date().getHours();
    const bossStatus =
      hour >= 23 || hour <= 6
        ? 'sleeping 😴'
        : hour >= 9 && hour <= 17
        ? 'working 👨‍💻'
        : 'busy 🛠️';

    const systemPrompt = `
You are Vega, assistant to mkenani.
mkenani is currently ${bossStatus}.
User name: ${user.name}.
Style: friendly, short, human.
RULES:
- Max 2 lines
- No emojis spam
- Instant tone
`;

    const result = await model.generateContent(
      `${systemPrompt}\nUser: ${text}`
    );

    const reply = result.response
      .text()
      .trim()
      .split('\n')
      .slice(0, 2)
      .join('\n');

    await sock.sendMessage(jid, { text: reply }, { quoted: m });
    await sock.readMessages([m.key]);

    // Auto-learn name
    const match = text.match(/(?:my name is|call me)\s+([a-zA-Z]+)/i);
    if (match) {
      await userCol.updateOne(
        { _id: jid },
        { $set: { name: match[1] } }
      );
    }

  } catch (err) {
    console.error('QUEUE ERROR:', err.message);
  } finally {
    await sock.sendPresenceUpdate('paused', jid);
    processing = false;
    processQueue(sock);
  }
}

/* ---------------- MONGODB AUTH ---------------- */

async function useMongoAuth(collection) {
  const write = (id, value) =>
    collection.replaceOne(
      { _id: id },
      { value: JSON.stringify(value, BufferJSON.replacer) },
      { upsert: true }
    );

  const read = async (id) => {
    const doc = await collection.findOne({ _id: id });
    return doc ? JSON.parse(doc.value, BufferJSON.reviver) : null;
  };

  const remove = (id) => collection.deleteOne({ _id: id });

  const creds = (await read('creds')) || null;

  return {
    state: {
      creds,
      keys: makeCacheableSignalKeyStore(
        {
          get: async (type, ids) => {
            const data = {};
            for (const id of ids) {
              const value = await read(`${type}-${id}`);
              if (value) data[id] = value;
            }
            return data;
          },
          set: async (data) => {
            for (const type in data) {
              for (const id in data[type]) {
                const value = data[type][id];
                if (value) await write(`${type}-${id}`, value);
                else await remove(`${type}-${id}`);
              }
            }
          }
        },
        Pino({ level: 'fatal' })
      )
    },
    saveCreds: async () => {
      await write('creds', sock.authState.creds);
    }
  };
}

/* ---------------- BOT START ---------------- */

async function startBot() {
  try {
    const mongo = new MongoClient(process.env.MONGODB_URI);
    await mongo.connect();

    db = mongo.db('MphatsoPremium');
    authCol = db.collection('auth_v4');
    userCol = db.collection('user_memory');

    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMongoAuth(authCol);

    const sock = makeWASocket({
      version,
      auth: state,
      logger: Pino({ level: 'silent' }),
      browser: ['Mphatso Premium', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) CURRENT_QR = qr;

      if (connection === 'open') {
        CURRENT_QR = '';
        console.log('🚀 MPHATSO PREMIUM IS LIVE');
      }

      if (connection === 'close') {
        const shouldReconnect =
          lastDisconnect?.error instanceof Boom &&
          lastDisconnect.error.output.statusCode !==
            DisconnectReason.loggedOut;

        if (shouldReconnect) {
          console.log('🔁 Reconnecting...');
          setTimeout(startBot, 5000);
        } else {
          console.log('❌ Logged out. Delete DB and re-scan QR.');
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      const m = messages[0];
      if (!m?.message) return;
      if (m.key.fromMe) return;
      if (m.key.remoteJid.endsWith('@g.us')) return;

      const text =
        m.message.conversation ||
        m.message.extendedTextMessage?.text;

      if (!text) return;

      queue.push({ m, jid: m.key.remoteJid, text });
      processQueue(sock);
    });

  } catch (err) {
    console.error('START ERROR:', err);
    setTimeout(startBot, 10000);
  }
}

/* ---------------- EXPRESS ---------------- */

app.get('/', (_, res) => res.send('MPHATSO PREMIUM – ACTIVE'));

app.get('/qr', async (_, res) => {
  if (!CURRENT_QR) return res.send('Already connected.');
  const url = await QRCode.toDataURL(CURRENT_QR);
  res.send(`<img src="${url}" />`);
});

app.listen(PORT, '0.0.0.0', () => startBot());


const express = require("express");
const QRCode = require("qrcode");
const pino = require("pino");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = process.env.PORT || 3000;

let sock;
let qrCode = null;
let connected = false;
let enabled = true;
let reconnectTimer = null;

const users = new Set();
const ADMIN_PHONE = (process.env.ADMIN_PHONE || "").replace(/\D/g, "");

app.get("/", (req, res) => {
  res.send(`
    <html dir="rtl">
      <head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
      <body style="font-family:Arial;text-align:center;padding:30px">
        <h2>🤖 Fahad WhatsApp Bot</h2>
        <p id="status">جاري تحميل الحالة...</p>
        <img id="qr" style="max-width:300px;width:90%">
        <script>
          async function update() {
            const r = await fetch('/qr');
            const d = await r.json();
            document.getElementById('status').innerText =
              d.connected ? '✅ واتساب متصل' : '⏳ انتظر رمز الربط';
            document.getElementById('qr').src = d.qr || '';
          }
          update();
          setInterval(update, 5000);
        </script>
      </body>
    </html>
  `);
});

app.get("/qr", (req, res) => {
  res.json({ qr: qrCode, connected });
  
});

app.get("/status", (req, res) => {
  res.json({
    connected,
    enabled,
    users: users.size
  });
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});

function getText(message) {
  const m = message.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    ""
  ).trim();
}

function isOwner(jid) {
  if (!ADMIN_PHONE) return false;
  const number = jid.split("@")[0].replace(/\D/g, "");
  return number === ADMIN_PHONE;
}

async function startBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState("./auth_info_baileys");

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["Fahad Bot", "Chrome", "1.0.0"],
    printQRInTerminal: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCode = await QRCode.toDataURL(qr);
      console.log("QR code is ready");
    }

    if (connection === "open") {
      connected = true;
      qrCode = null;
      console.log("WhatsApp connected successfully");
    }

    if (connection === "close") {
      connected = false;

      const statusCode =
        lastDisconnect?.error?.output?.statusCode;

      console.log("Connection closed:", statusCode);

      if (statusCode !== DisconnectReason.loggedOut) {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(startBot, 5000);
      } else {
        console.log("Session logged out. Scan a new QR code.");
      }
    }
  });

  // استقبال الرسائل والرد عليها
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      if (!jid || jid === "status@broadcast") continue;

      const text = getText(msg).toLowerCase();
      const owner = isOwner(jid);
      const isGroup = jid.endsWith("@g.us");

      if (!isGroup) users.add(jid);

      // أوامر المالك
      if (owner && text === "!on") {
        enabled = true;
        await sock.sendMessage(jid, { text: "✅ تم تشغيل البوت." });
        continue;
      }

      if (owner && text === "!off") {
        enabled = false;
        await sock.sendMessage(jid, { text: "⛔ تم إيقاف الردود التلقائية." });
        continue;
      }

      if (owner && text === "!status") {
        await sock.sendMessage(jid, {
          text:
            "📊 حالة البوت\n" +
            "الاتصال: " + (connected ? "متصل ✅" : "غير متصل ❌") + "\n" +
            "التشغيل: " + (enabled ? "مفعّل ✅" : "متوقف ⛔") + "\n" +
            "المستخدمون: " + users.size
        });
        continue;
      }

      if (owner && text === "!users") {
        await sock.sendMessage(jid, {
          text: "👥 عدد المستخدمين المسجلين: " + users.size
        });
        continue;
      }

      // القائمة متاحة للجميع
      if (text === "!menu" || text === "!help") {
        await sock.sendMessage(jid, {
          text:
            "🤖 *قائمة أوامر بوت فهد*\n\n" +
            "!menu — عرض القائمة\n" +
            "!help — المساعدة\n" +
            "!about — معلومات البوت\n\n" +
            "أوامر المالك:\n" +
            "!on — تشغيل البوت\n" +
            "!off — إيقاف الردود\n" +
            "!status — حالة البوت\n" +
            "!users — عدد المستخدمين"
        });
        continue;
      }

      if (text === "!about") {
        await sock.sendMessage(jid, {
          text: "🤖 أنا بوت فهد، مساعد واتساب تلقائي."
        });
        continue;
      }

      if (!enabled) continue;

      // الردود التلقائية
      let reply = null;

      if (text.includes("السلام عليكم")) {
        reply = "وعليكم السلام ورحمة الله وبركاته 🌹";
      } else if (text === "هلا" || text.includes("هلا والله")) {
        reply = "يا هلا والله 👋";
      } else if (text.includes("مرحبا") || text.includes("مرحباً")) {
        reply = "أهلاً وسهلاً فيك ❤️";
      } else if (text.includes("كيفك") || text.includes("شلونك")) {
        reply = "الحمد لله بخير، وأنت كيف حالك؟ 😊";
      } else if (text.includes("شكرا") || text.includes("شكراً")) {
        reply = "العفو، بالخدمة دائمًا ❤️";
      }

      if (reply) {
        await sock.sendMessage(jid, { text: reply });
      }
    }
  });

  // الترحيب بالأعضاء الجدد
  sock.ev.on("group-participants.update", async (event) => {
    if (event.action !== "add") return;

    for (const participant of event.participants) {
      await sock.sendMessage(event.id, {
        text: `أهلاً وسهلاً بك 🎉\n@${participant.split("@")[0]}\nنورت المجموعة ❤️`,
        mentions: [participant]
      });
    }
  });
}

startBot().catch((err) => {
  console.error("Bot startup error:", err);
});
 

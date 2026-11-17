
const express = require("express");
const QRCode = require("qrcode");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 10000;
const ADMIN = (process.env.ADMIN_PHONE || "").replace(/\D/g, "");

let sock;
let qrImage = null;
let connected = false;
let botEnabled = true;
let reconnecting = false;

const users = new Set();
const seen = new Set();
const lastMessage = new Map();

app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fahad WhatsApp Bot</title>
<style>
body {
  background:#101820;color:white;
  font-family:Arial;text-align:center;
  padding:35px 15px
}
.box {
  max-width:390px;margin:auto;
  background:#1d2935;padding:25px;
  border-radius:20px
}
img {width:260px;max-width:100%;background:white;padding:10px;border-radius:12px}
button {
  background:#19b875;color:white;
  padding:13px 25px;border:0;
  border-radius:10px;margin:12px;
  font-size:16px
}
</style>
</head>
<body>
<div class="box">
<h2>🤖 Fahad WhatsApp Bot</h2>
<p id="status">جاري الاتصال...</p>
<div id="qr">جاري تجهيز QR Code...</div>
<p>افتح واتساب ← الأجهزة المرتبطة ← ربط جهاز</p>
<button onclick="loadQR()">تحديث QR</button>
</div>
<script>
async function loadQR(){
  const r = await fetch('/qr');
  const d = await r.json();
  document.getElementById('qr').innerHTML =
    d.qr ? '<img src="'+d.qr+'">' : d.connected ?
    '✅ واتساب متصل' : '⏳ انتظر ظهور الرمز';
}
async function update(){
  const r = await fetch('/status');
  const d = await r.json();
  document.getElementById('status').innerText =
    d.connected ? '🟢 متصل' : '🔴 غير متصل';
  if(!d.connected) await loadQR();
}
setInterval(update,4000);
update();
</script>
</body>
</html>
  `);
});

app.get("/qr", (req, res) => {
  res.json({ qr: qrImage, connected });
});

app.get("/status", (req, res) => {
  res.json({
    connected,
    enabled: botEnabled,
    users: users.size
  });
});

async function startBot() {
  if (reconnecting) return;
  reconnecting = true;

  try {
    const { state, saveCreds } =
      await useMultiFileAuthState("./auth_info_baileys");

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      browser: ["Fahad Bot", "Chrome", "1.0.0"],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrImage = await QRCode.toDataURL(qr);
        connected = false;
        console.log("QR Code is ready");
      }

      if (connection === "open") {
        connected = true;
        qrImage = null;
        console.log("WhatsApp connected!");
      }

      if (connection === "close") {
        connected = false;
        qrImage = null;

        const code = lastDisconnect?.error?.output?.statusCode;

        if (code !== DisconnectReason.loggedOut) {
          reconnecting = false;
          setTimeout(startBot, 5000);
        } else {
          console.log("Logged out. Delete session and reconnect.");
          reconnecting = false;
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        try {
          if (!msg.message || msg.key.fromMe) continue;
          if (msg.key.remoteJid === "status@broadcast") continue;

          const jid = msg.key.remoteJid;
          if (jid.endsWith("@g.us")) continue;

          const id = msg.key.id;
          if (!id || seen.has(id)) continue;
          seen.add(id);

          if (seen.size > 3000) {
            seen.clear();
          }

          const from = jid.split("@")[0];
          users.add(from);

          const body =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            "";

          if (!body.trim()) continue;

          const now = Date.now();
          const previous = lastMessage.get(from) || 0;

          if (now - previous < 3000) continue;
          lastMessage.set(from, now);

          const isAdmin = from === ADMIN;
          const command = body.trim().toLowerCase();

          let reply = "";

          // Owner commands
          if (isAdmin && command === "!off") {
            botEnabled = false;
            reply = "🔴 تم إيقاف البوت.";
          }
          else if (isAdmin && command === "!on") {
            botEnabled = true;
            reply = "🟢 تم تشغيل البوت.";
          }
          else if (isAdmin && command === "!status") {
            reply =
              "حالة البوت: " + (connected ? "متصل 🟢" : "غير متصل") +
              "\nعدد المستخدمين: " + users.size;
          }
          else if (isAdmin && command === "!users") {
            reply = "عدد المستخدمين: " + users.size +
              "\n" + [...users].slice(0, 30).join("\n");
          }
          else if (isAdmin && command === "!commands") {
            reply =
              "👑 أوامر المالك\n\n" +
              "!on تشغيل البوت\n" +
              "!off إيقاف البوت\n" +
              "!status حالة البوت\n" +
              "!users قائمة المستخدمين\n" +
              "!commands الأوامر";
          }
          else if (!botEnabled && !isAdmin) {
            continue;
          }
          else if (["!menu", "!help"].includes(command)) {
            reply =
              "🔥 أهلاً بك في بوت فهد\n\n" +
              "!menu القائمة\n" +
              "!about معلومات البوت\n" +
              "!help المساعدة";
          }
          else if (command === "!about") {
            reply = "🤖 Fahad WhatsApp Bot\nبوت مساعد متعدد المميزات.";
          }
          else if (["السلام عليكم", "سلام عليكم"].includes(command)) {
            reply = "وعليكم السلام ورحمة الله وبركاته 🌹";
          }
          else if (command.includes("مرحبا") || command.includes("هلا")) {
            reply = "يا هلا والله 👋";
          }
          else if (command.includes("كيف حالك")) {
            reply = "بخير الحمد لله، وأنت؟ 😊";
          }
          else {
            reply = "وصلت رسالتك ❤️\nاكتب !menu لعرض الأوامر.";
          }

          if (reply) {
            await sock.sendMessage(jid, { text: reply });
          }

        } catch (error) {
          console.error("Message error:", error);
        }
      }
    });

  } catch (error) {
    console.error("Bot startup error:", error);
    reconnecting = false;
    setTimeout(startBot, 10000);
    return;
  }

  reconnecting = false;
}

app.listen(PORT, "0.0.0.0", () => {
  console.log("Web server running on port " + PORT);
  startBot();
});

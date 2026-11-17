
const express = require("express");
const pino = require("pino");
const QRCode = require("qrcode");
const crypto = require("crypto");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json({ limit: "100kb" }));

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.DASHBOARD_PASSWORD;

if (!PASSWORD) {
  throw new Error("ضع DASHBOARD_PASSWORD في Render Environment");
}

let sock;
let qrImage = null;
let connected = false;
let enabled = true;
let reconnecting = false;
let messagesCount = 0;
let repliesCount = 0;
let lastError = "";

let sessions = new Map();
let loginAttempts = new Map();
let lastMessage = new Map();

let settings = {
  welcome: "أهلاً بك 👋 نورتنا!",
  away: "حالياً غير متواجد، سيتم الرد عليك لاحقاً.",
  replies: {
    "السلام عليكم": "وعليكم السلام ورحمة الله وبركاته 🌹",
    "هلا": "هلا وغلا 👋",
    "مرحبا": "يا مرحبا فيك ❤️",
    "كيف الحال": "بخير الحمد لله، وأنت؟",
    "شكرا": "العفو، بالخدمة دائماً ❤️",
    "شكراً": "العفو، بالخدمة دائماً ❤️",
    "باي": "في أمان الله 👋"
  }
};

const commands = {
  "!menu": () => menuText(),
  "!help": () => menuText(),
  "!مساعدة": () => menuText(),
  "!وقت": () => "الوقت الآن: " + new Date().toLocaleTimeString("ar-SA", { timeZone: "Asia/Riyadh" }),
  "!time": () => "الوقت الآن: " + new Date().toLocaleTimeString("ar-SA", { timeZone: "Asia/Riyadh" }),
  "!date": () => "التاريخ: " + new Date().toLocaleDateString("ar-SA", { timeZone: "Asia/Riyadh" }),
  "!تاريخ": () => "التاريخ: " + new Date().toLocaleDateString("ar-SA", { timeZone: "Asia/Riyadh" }),
  "!about": () => "أنا بوت واتساب آلي 🤖\nأستقبل رسائلك وأرد عليك تلقائياً.",
  "!من": () => "أنا بوت واتساب آلي 🤖",
  "!status": () => "حالة البوت: " + (enabled ? "يستقبل الرسائل ويعمل ✅" : "الردود متوقفة حالياً ⏸️"),
  "!حالة": () => "حالة البوت: " + (enabled ? "يعمل ✅" : "متوقف ⏸️"),
  "!contact": () => "أرسل رسالتك هنا وسيتم الاطلاع عليها.",
  "!تواصل": () => "أرسل رسالتك هنا وسيتم الاطلاع عليها.",
  "!ping": () => "Pong! 🏓 البوت يستجيب.",
  "!joke": () => "مرة واحد نام متأخر... فاته الحلم 😂",
  "!نكتة": () => "مرة واحد نام متأخر... فاته الحلم 😂",
  "!quote": () => "استمر، فالأشياء الجميلة تحتاج إلى صبر ✨",
  "!حكمة": () => "استمر، فالأشياء الجميلة تحتاج إلى صبر ✨",
  "!welcome": () => settings.welcome
};

function menuText() {
  return `🤖 قائمة أوامر البوت

📌 الأوامر:
!menu — القائمة
!help — المساعدة
!time — الوقت
!date — التاريخ
!about — معلومات البوت
!status — حالة البوت
!contact — التواصل
!ping — اختبار البوت
!joke — نكتة
!quote — حكمة
!welcome — رسالة الترحيب

أرسل أي أمر لمعرفة نتيجته ❤️`;
}

function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const expiry = sessions.get(token);

  if (!token || !expiry || expiry < Date.now()) {
    sessions.delete(token);
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

app.post("/api/login", (req, res) => {
  const ip = req.ip;
  const attempts = loginAttempts.get(ip) || { count: 0, until: 0 };

  if (attempts.until > Date.now()) {
    return res.status(429).json({ error: "انتظر قليلاً قبل المحاولة" });
  }

  if (req.body.password !== PASSWORD) {
    attempts.count++;
    if (attempts.count >= 5) {
      attempts.count = 0;
      attempts.until = Date.now() + 60000;
    }
    loginAttempts.set(ip, attempts);
    return res.status(401).json({ error: "كلمة المرور غير صحيحة" });
  }

  loginAttempts.delete(ip);

  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + 8 * 60 * 60 * 1000);

  res.json({ token });
});

app.get("/api/status", authenticate, (req, res) => {
  res.json({
    connected,
    enabled,
    messagesCount,
    repliesCount,
    lastError
  });
});

app.post("/api/control", authenticate, (req, res) => {
  if (req.body.action === "on") enabled = true;
  else if (req.body.action === "off") enabled = false;
  else return res.status(400).json({ error: "Invalid action" });

  res.json({ success: true, enabled });
});

app.get("/api/settings", authenticate, (req, res) => {
  res.json(settings);
});

app.post("/api/settings", authenticate, (req, res) => {
  const { welcome, away, replies } = req.body;

  if (typeof welcome === "string") settings.welcome = welcome.slice(0, 500);
  if (typeof away === "string") settings.away = away.slice(0, 500);

  if (replies && typeof replies === "object" && !Array.isArray(replies)) {
    const entries = Object.entries(replies).slice(0, 100);

    settings.replies = Object.fromEntries(
      entries
        .filter(([key, value]) =>
          typeof key === "string" &&
          typeof value === "string" &&
          key.length <= 100 &&
          value.length <= 1000
        )
    );
  }

  res.json({ success: true });
});

app.get("/api/qr", authenticate, (req, res) => {
  res.json({ qr: qrImage, connected });
});

app.get("/qr", (req, res) => {
  res.redirect("/");
});

app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>لوحة تحكم البوت</title>
<style>
body{font-family:Arial;background:#101820;color:white;padding:20px;margin:0}
main{max-width:650px;margin:auto}
.card{background:#1d2b36;padding:18px;border-radius:14px;margin:14px 0}
input,textarea{box-sizing:border-box;width:100%;padding:12px;margin:8px 0;border:0;border-radius:8px}
button{padding:12px 16px;border:0;border-radius:8px;margin:5px;cursor:pointer}
.green{background:#16a36a;color:white}
.red{background:#c0392b;color:white}
#panel{display:none}
#qr{max-width:280px;width:100%;background:white}
pre{white-space:pre-wrap;word-break:break-word}
</style>
</head>
<body>
<main>
<h2>🤖 لوحة تحكم بوت واتساب</h2>

<div class="card" id="login">
<h3>دخول المالك فقط</h3>
<input id="password" type="password" placeholder="كلمة مرور لوحة التحكم">
<button class="green" onclick="login()">دخول</button>
<p id="loginMsg"></p>
</div>

<div id="panel">
<div class="card">
<h3>حالة البوت</h3>
<p id="status">جاري التحميل...</p>
<button class="green" onclick="control('on')">تشغيل الردود</button>
<button class="red" onclick="control('off')">إيقاف الردود</button>
<button onclick="refresh()">تحديث الحالة</button>
</div>

<div class="card">
<h3>ربط واتساب QR</h3>
<p>لا تشارك هذا الرمز مع أحد.</p>
<img id="qr" style="display:none">
<p id="qrText">جاري فحص الاتصال...</p>
</div>

<div class="card">
<h3>تعديل الردود</h3>
<label>رسالة الترحيب</label>
<textarea id="welcome" rows="2"></textarea>
<label>رسالة الغياب</label>
<textarea id="away" rows="2"></textarea>
<label>الردود التلقائية (JSON)</label>
<textarea id="replies" rows="10"></textarea>
<button class="green" onclick="saveSettings()">حفظ الإعدادات</button>
<p id="saveMsg"></p>
</div>

<div class="card">
<h3>إحصائيات</h3>
<p id="stats"></p>
</div>
</div>
</main>

<script>
let token = "";

async function api(path, method="GET", body=null) {
  const r = await fetch(path, {
    method,
    headers: {
      "Content-Type":"application/json",
      "Authorization":"Bearer "+token
    },
    body: body ? JSON.stringify(body) : null
  });
  if (!r.ok) throw new Error("انتهت الجلسة أو حدث خطأ");
  return r.json();
}

async function login() {
  const r = await fetch("/api/login", {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({password:document.getElementById("password").value})
  });
  const d = await r.json();
  if (!r.ok) {
    document.getElementById("loginMsg").innerText = d.error || "فشل الدخول";
    return;
  }
  token = d.token;
  document.getElementById("login").style.display="none";
  document.getElementById("panel").style.display="block";
  await refresh();
  await loadSettings();
  await loadQR();
}

async function refresh() {
  try {
    const d = await api("/api/status");
    document.getElementById("status").innerText =
      "الاتصال: "+(d.connected?"متصل ✅":"غير متصل ❌")+
      "\\nالردود: "+(d.enabled?"مفعلة ✅":"متوقفة ⏸️")+
      "\\nآخر خطأ: "+(d.lastError || "لا يوجد");
    document.getElementById("stats").innerText =
      "الرسائل المستلمة: "+d.messagesCount+
      "\\nالردود المرسلة: "+d.repliesCount;
  } catch(e) { alert(e.message); }
}

async function control(action) {
  await api("/api/control","POST",{action});
  await refresh();
}

async function loadSettings() {
  const d = await api("/api/settings");
  document.getElementById("welcome").value=d.welcome;
  document.getElementById("away").value=d.away;
  document.getElementById("replies").value=JSON.stringify(d.replies,null,2);
}

async function saveSettings() {
  try {
    const replies=JSON.parse(document.getElementById("replies").value);
    await api("/api/settings","POST",{
      welcome:document.getElementById("welcome").value,
      away:document.getElementById("away").value,
      replies
    });
    document.getElementById("saveMsg").innerText="تم حفظ الإعدادات ✅";
  } catch(e) {
    document.getElementById("saveMsg").innerText="تأكد من صيغة JSON";
  }
}

async function loadQR() {
  try {
    const d=await api("/api/qr");
    const img=document.getElementById("qr");
    if(d.connected) {
      img.style.display="none";
      document.getElementById("qrText").innerText="واتساب متصل بالفعل ✅";
    } else if(d.qr) {
      img.src=d.qr;
      img.style.display="block";
      document.getElementById("qrText").innerText="امسح الرمز من واتساب";
    } else {
      img.style.display="none";
      document.getElementById("qrText").innerText="انتظر إنشاء رمز QR...";
    }
  } catch(e) {}
}

setInterval(()=>{ if(token){refresh();loadQR();} },10000);
</script>
</body>
</html>`);
});

app.listen(PORT, () => console.log("Server running on " + PORT));

async function startBot() {
  if (reconnecting) return;
  reconnecting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState("./auth_info_baileys");

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: ["Fahad Bot", "Chrome", "1.0.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrImage = await QRCode.toDataURL(qr);
        connected = false;
        console.log("QR is ready. Open the dashboard to scan it.");
      }

      if (connection === "open") {
        connected = true;
        qrImage = null;
        lastError = "";
        reconnecting = false;
        console.log("WhatsApp connected");
      }

      if (connection === "close") {
        connected = false;
        reconnecting = false;

        const code = lastDisconnect?.error?.output?.statusCode;
        lastError = "Connection closed: " + (code || "unknown");

        if (code !== DisconnectReason.loggedOut) {
          setTimeout(startBot, 5000);
        } else {
          console.log("Session logged out. Pair again using QR.");
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify" || !enabled) return;

      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const jid = msg.key.remoteJid;
        if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") continue;

        const text =
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          "";

        if (!text.trim()) continue;

        messagesCount++;

        const now = Date.now();
        const previous = lastMessage.get(jid) || 0;
        if (now - previous < 1500) continue;
        lastMessage.set(jid, now);

        const input = text.trim();
        const command = input.toLowerCase();

        let answer = null;

        if (commands[command]) {
          answer = commands[command]();
        } else {
          const matchingKey = Object.keys(settings.replies)
            .find(key => key.toLowerCase() === command);

          if (matchingKey) {
            answer = settings.replies[matchingKey];
          } else if (/^(السلام عليكم|سلام عليكم)$/i.test(input)) {
            answer = settings.replies["السلام عليكم"];
          }
        }

        if (answer) {
          try {
            await sock.sendMessage(jid, { text: answer });
            repliesCount++;
          } catch (err) {
            lastError = err.message;
            console.error("Send error:", err.message);
          }
        }
      }
    });

  } catch (err) {
    connected = false;
    reconnecting = false;
    lastError = err.message;
    console.error("Bot start error:", err);
    setTimeout(startBot, 10000);
  }
}

startBot();

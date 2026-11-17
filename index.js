
const express = require("express");
const QRCode = require("qrcode");
const pino = require("pino");
const crypto = require("crypto");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.DASHBOARD_PASSWORD;

if (!PASSWORD) {
  console.error("Missing DASHBOARD_PASSWORD environment variable");
  process.exit(1);
}

let sock;
let connected = false;
let enabled = true;
let qrCode = null;
let reconnectTimer;
let reconnecting = false;

const sessions = new Map();
const users = new Set();

const replies = {
  salam: "وعليكم السلام ورحمة الله وبركاته 🌹",
  hello: "يا هلا والله 👋",
  welcome: "أهلاً وسهلاً فيك ❤️"
};

function makeToken() {
  return crypto.randomBytes(32).toString("hex");
}

function auth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

app.get("/", (req, res) => {
  res.send(`
<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>لوحة تحكم فهد</title>
<style>
body{font-family:Arial;background:#101827;color:white;margin:0;padding:20px}
main{max-width:550px;margin:35px auto}
.card{background:#1d293b;padding:20px;border-radius:16px;margin:15px 0}
input,button{box-sizing:border-box;width:100%;padding:13px;border:0;border-radius:9px;margin:7px 0;font-size:16px}
input{background:#fff;color:#111}
button{background:#16a36a;color:white;font-weight:bold}
.stop{background:#c0392b}
small{color:#b8c5d6}
</style>
</head>
<body>
<main>
<h2>🤖 لوحة تحكم فهد</h2>
<div class="card" id="login">
<h3>تسجيل الدخول</h3>
<input id="password" type="password" placeholder="كلمة مرور اللوحة">
<button onclick="login()">دخول</button>
<p id="error"></p>
</div>
<div id="panel" style="display:none">
<div class="card">
<h3>حالة البوت</h3>
<p id="status">جاري التحميل...</p>
<button onclick="refresh()">تحديث الحالة</button>
</div>
<div class="card">
<h3>التحكم</h3>
<button onclick="action('on')">تشغيل البوت</button>
<button class="stop" onclick="action('off')">إيقاف الردود</button>
</div>
<div class="card">
<h3>الردود التلقائية</h3>
<label>رد السلام عليكم</label>
<input id="salam">
<label>رد هلا</label>
<input id="hello">
<label>رد مرحبا</label>
<input id="welcome">
<button onclick="saveReplies()">حفظ الردود</button>
</div>
<button class="stop" onclick="logout()">تسجيل الخروج</button>
</div>
</main>
<script>
let token = "";
async function login(){
 const r=await fetch('/api/login',{
  method:'POST',
  headers:{'Content-Type':'application/json'},
  body:JSON.stringify({password:document.getElementById('password').value})
 });
 const d=await r.json();
 if(!r.ok){document.getElementById('error').innerText='كلمة المرور غير صحيحة';return}
 token=d.token;
 document.getElementById('login').style.display='none';
 document.getElementById('panel').style.display='block';
 refresh();
}
async function api(path,method='GET',body){
 const r=await fetch(path,{
  method,
  headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
  body:body?JSON.stringify(body):undefined
 });
 if(r.status===401){logout();throw new Error('انتهت الجلسة')}
 return r.json();
}
async function refresh(){
 const d=await api('/api/status');
 document.getElementById('status').innerText=
 'واتساب: '+(d.connected?'متصل ✅':'غير متصل ❌')+
 '\\nالردود: '+(d.enabled?'مفعلة':'متوقفة')+
 '\\nعدد المستخدمين: '+d.users;
 document.getElementById('salam').value=d.replies.salam;
 document.getElementById('hello').value=d.replies.hello;
 document.getElementById('welcome').value=d.replies.welcome;
}
async function action(a){
 await api('/api/control','POST',{action:a});
 refresh();
}
async function saveReplies(){
 await api('/api/replies','POST',{
  salam:document.getElementById('salam').value,
  hello:document.getElementById('hello').value,
  welcome:document.getElementById('welcome').value
 });
 alert('تم حفظ الردود');
}
function logout(){
 token='';
 document.getElementById('panel').style.display='none';
 document.getElementById('login').style.display='block';
}
</script>
</body>
</html>
`);
});

app.post("/api/login", (req, res) => {
  const supplied = String(req.body.password || "");
  const a = Buffer.from(supplied);
  const b = Buffer.from(PASSWORD);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Wrong password" });
  }

  const token = makeToken();
  sessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
  res.json({ token });
});

app.use("/api", (req, res, next) => {
  if (req.path === "/login") return next();
  auth(req, res, next);
});

app.get("/api/status", (req, res) => {
  res.json({
    connected,
    enabled,
    users: users.size,
    replies
  });
});

app.post("/api/control", (req, res) => {
  if (req.body.action === "on") enabled = true;
  else if (req.body.action === "off") enabled = false;
  else return res.status(400).json({ error: "Invalid action" });

  res.json({ success: true, enabled });
});

app.post("/api/replies", (req, res) => {
  for (const key of Object.keys(replies)) {
    if (typeof req.body[key] === "string") {
      replies[key] = req.body[key].slice(0, 500);
    }
  }
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log("Dashboard listening on " + PORT);
});

function getText(msg) {
  const m = msg.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    ""
  ).trim().toLowerCase();
}

async function startBot() {
  if (reconnecting) return;
  reconnecting = true;

  try {
    const { state, saveCreds } =
      await useMultiFileAuthState("./auth_info_baileys");

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      browser: ["Fahad Bot", "Chrome", "1.0.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrCode = await QRCode.toDataURL(qr);
        console.log("QR ready");
      }

      if (connection === "open") {
        connected = true;
        qrCode = null;
        reconnecting = false;
        console.log("WhatsApp connected");
      }

      if (connection === "close") {
        connected = false;
        reconnecting = false;

        const code = lastDisconnect?.error?.output?.statusCode;
        if (code !== DisconnectReason.loggedOut) {
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(startBot, 5000);
        } else {
          console.log("WhatsApp logged out; scan a new QR");
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
      if (!enabled) return;

      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const jid = msg.key.remoteJid;
        if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") continue;

        users.add(jid);
        const text = getText(msg);
        let reply;

        if (text.includes("السلام عليكم")) reply = replies.salam;
        else if (text === "هلا" || text.includes("هلا والله")) reply = replies.hello;
        else if (text.includes("مرحبا") || text.includes("مرحباً")) reply = replies.welcome;

        if (reply) {
          await sock.sendMessage(jid, { text: reply });
        }
      }
    });

  } catch (err) {
    reconnecting = false;
    console.error("Bot error:", err);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(startBot, 10000);
  }
}

app.get("/qr", (req, res) => {
  res.json({ qr: qrCode, connected });
});

startBot();

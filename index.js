
const express = require("express");
const makeWASocket = require("@whiskeysockets/baileys").default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys");
const QRCode = require("qrcode");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "1mb" }));

// إعدادات Render
const PORT = process.env.PORT || 3000;
const ADMIN_PHONE = (process.env.ADMIN_PHONE || "").replace(/\D/g, "");
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-2.5-flash";

const DATA_DIR = process.env.DATA_DIR || "./data";
const AUTH_DIR = path.join(DATA_DIR, "auth");
const DATA_FILE = path.join(DATA_DIR, "bot-data.json");

fs.mkdirSync(AUTH_DIR, { recursive: true });

let sock;
let latestQR = null;
let connected = false;
let botEnabled = true;
let reconnecting = false;
let lastError = "";
let repliesCount = 0;
let incomingCount = 0;
let aiCount = 0;
let qrUpdatedAt = null;

const sessions = new Map();
const conversations = new Map();
const lastMessages = new Map();
const messageTimes = new Map();

let data = {
  aiEnabled: true,
  autoReply: true,
  replyStyle: "ودي وطبيعي وباللهجة السعودية، مختصر وواضح.",
  customInstructions: "",
  replies: {},
  jobs: [],
  contacts: []
};

function saveData() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Save error:", e.message);
  }
}

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      data = { ...data, ...saved };
    }
  } catch (e) {
    console.error("Load error:", e.message);
  }
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function isOwner(jid) {
  if (!ADMIN_PHONE || !jid) return false;
  const phone = normalizePhone(jid.split("@")[0].split(":")[0]);
  return phone === ADMIN_PHONE;
}

function jidFromPhone(phone) {
  const clean = normalizePhone(phone);
  if (!clean || clean.length < 8) throw new Error("رقم الهاتف غير صحيح");
  return clean + "@s.whatsapp.net";
}

function getMessageText(message) {
  const m = message.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ""
  ).trim();
}

function rememberContact(jid) {
  const phone = jid.split("@")[0].split(":")[0];
  if (!data.contacts.includes(phone)) {
    data.contacts.push(phone);
    if (data.contacts.length > 1000) data.contacts.shift();
    saveData();
  }
}

function cleanOldSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.createdAt > 8 * 60 * 60 * 1000) {
      sessions.delete(token);
    }
  }
}

function requireLogin(req, res, next) {
  cleanOldSessions();
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: "سجّل الدخول أولاً" });
  }
  next();
}

function safeString(value, max = 2000) {
  return String(value ?? "").slice(0, max);
}

async function askAI(jid, userText) {
  if (!GEMINI_API_KEY) {
    return "خدمة الذكاء الاصطناعي غير مفعّلة حالياً.";
  }

  const history = conversations.get(jid) || [];
  const systemPrompt = `
أنت مساعد واتساب ذكي يرد على الرسائل بأسلوب قريب من أسلوب صاحب الحساب.
لا تدّعِ أنك إنسان أو أنك صاحب الحساب بنفسك إذا سُئلت مباشرة.
استخدم اللغة العربية واللهجة السعودية غالباً.
كن طبيعياً وودوداً، ولا تطل الرد إلا عند الحاجة.
أسلوب الرد: ${data.replyStyle}
تعليمات إضافية: ${data.customInstructions}
`;

  const contents = [
    ...history.slice(-12),
    { role: "user", parts: [{ text: userText }] }
  ];

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: {
          temperature: 0.8,
          maxOutputTokens: 700
        }
      })
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error?.message || "تعذر الاتصال بالذكاء الاصطناعي");
  }

  const answer = result.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "")
    .join("")
    .trim();

  if (!answer) throw new Error("لم يصل رد من الذكاء الاصطناعي");

  const updated = [
    ...history,
    { role: "user", parts: [{ text: userText }] },
    { role: "model", parts: [{ text: answer }] }
  ].slice(-16);

  conversations.set(jid, updated);
  aiCount++;
  return answer;
}

async function sendText(jid, text) {
  if (!sock || !connected) throw new Error("واتساب غير متصل");
  await sock.sendMessage(jid, { text: safeString(text, 4000) });
  repliesCount++;
}

async function handleIncoming(msg) {
  if (!msg.message || msg.key.fromMe) return;

  const jid = msg.key.remoteJid;
  if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us")) return;

  const text = getMessageText(msg);
  if (!text) return;

  incomingCount++;
  rememberContact(jid);

  const input = text.trim();
  const command = input.toLowerCase();

  // أوامر المالك فقط: إيقاف وتشغيل البوت على الجميع
  if (isOwner(jid)) {
    if (["وقف", "!وقف", "إيقاف", "!off"].includes(command)) {
      botEnabled = false;
      await sendText(jid, "🔴 تم إيقاف البوت. لن يرد على أي شخص حتى تكتب «كمل».");
      return;
    }

    if (["كمل", "!كمل", "تشغيل", "!on"].includes(command)) {
      botEnabled = true;
      await sendText(jid, "🟢 رجع البوت للعمل، والردود التلقائية مفعّلة.");
      return;
    }

    if (["!status", "الحالة"].includes(command)) {
      await sendText(
        jid,
        `حالة البوت: ${botEnabled ? "يعمل 🟢" : "متوقف 🔴"}\nواتساب: ${connected ? "متصل" : "غير متصل"}`
      );
      return;
    }

    if (command === "!users") {
      await sendText(jid, `عدد جهات الاتصال المسجلة: ${data.contacts.length}`);
      return;
    }

    if (command === "!help" || command === "!commands") {
      await sendText(
        jid,
        "أوامر المالك:\nوقف — إيقاف الرد على الجميع\nكمل — استئناف الردود\n!status — حالة البوت\n!users — عدد جهات الاتصال\n\nوتقدر تتحكم من لوحة الموقع."
      );
      return;
    }
  }

  // إذا أوقف المالك البوت، لا يرد على أي شخص
  if (!botEnabled || !data.autoReply) return;

  // منع تكرار الرسائل بسرعة
  const now = Date.now();
  const previous = lastMessages.get(jid);
  if (previous && previous.text === input && now - previous.time < 15000) return;
  lastMessages.set(jid, { text: input, time: now });

  const times = (messageTimes.get(jid) || []).filter(t => now - t < 60000);
  if (times.length >= 8) return;
  times.push(now);
  messageTimes.set(jid, times);

  let answer = null;

  const matchingKey = Object.keys(data.replies).find(
    key => key.toLowerCase() === command
  );

  if (matchingKey) {
    answer = data.replies[matchingKey];
  } else if (data.aiEnabled) {
    try {
      answer = await askAI(jid, input);
    } catch (e) {
      lastError = e.message;
      console.error("AI error:", e.message);
      answer = null;
    }
  }

  if (answer) {
    await sendText(jid, answer);
  }
}

async function connectWhatsApp() {
  if (reconnecting) return;
  reconnecting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version;

    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch {
      version = undefined;
    }

    sock = makeWASocket({
      auth: state,
      version,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: ["Fahad Bot", "Chrome", "1.0.0"],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async update => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        latestQR = await QRCode.toDataURL(qr);
        qrUpdatedAt = new Date().toISOString();
        connected = false;
        console.log("QR Code is ready. Open /qr");
      }

      if (connection === "open") {
        connected = true;
        latestQR = null;
        lastError = "";
        console.log("WhatsApp connected successfully");
      }

      if (connection === "close") {
        connected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log("WhatsApp disconnected:", statusCode);

        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(() => {
            reconnecting = false;
            connectWhatsApp().catch(err => {
              lastError = err.message;
              console.error(err);
            });
          }, 5000);
        } else {
          lastError = "تم تسجيل الخروج. احذف جلسة الربط من التخزين وأعد مسح QR.";
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        try {
          await handleIncoming(msg);
        } catch (e) {
          lastError = e.message;
          console.error("Message handler error:", e.message);
        }
      }
    });
  } catch (e) {
    lastError = e.message;
    console.error("Connection error:", e);
    setTimeout(() => {
      reconnecting = false;
      connectWhatsApp().catch(console.error);
    }, 10000);
  }

  reconnecting = false;
}

// جدولة الرسائل
async function processJobs() {
  if (!connected || !sock) return;

  const now = Date.now();

  for (const job of data.jobs) {
    if (job.status !== "pending" || new Date(job.sendAt).getTime() > now) continue;

    job.status = "sending";
    saveData();

    try {
      await sendText(jidFromPhone(job.phone), job.message);
      job.status = "sent";
      job.sentAt = new Date().toISOString();
    } catch (e) {
      job.status = "failed";
      job.error = e.message;
    }

    saveData();
  }
}

// الصفحة الرئيسية للوحة التحكم
app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>لوحة تحكم بوت فهد</title>
<style>
body{font-family:Arial;background:#101827;color:#fff;margin:0;padding:18px}
main{max-width:850px;margin:auto}
section{background:#1d293b;padding:16px;border-radius:14px;margin:12px 0}
input,textarea,button{box-sizing:border-box;width:100%;padding:12px;margin:6px 0;border:0;border-radius:8px;font-size:15px}
button{background:#16a36a;color:white;font-weight:bold}
button.secondary{background:#33445f}
button.danger{background:#bd3434}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.stat{background:#26364d;padding:14px;border-radius:10px}
small{color:#b8c5d8}
#panel{display:none}
pre{white-space:pre-wrap;overflow-wrap:anywhere}
</style>
</head>
<body>
<main>
<h2>🤖 لوحة تحكم بوت فهد</h2>
<section id="login">
<h3>تسجيل الدخول</h3>
<input id="password" type="password" placeholder="كلمة مرور الداشبورد">
<button onclick="login()">دخول</button>
<p id="loginError"></p>
</section>

<div id="panel">
<section>
<h3>📊 حالة البوت</h3>
<div class="grid">
<div class="stat">واتساب<br><b id="wa">...</b></div>
<div class="stat">حالة الردود<br><b id="enabled">...</b></div>
<div class="stat">الرسائل الواردة<br><b id="incoming">0</b></div>
<div class="stat">الردود المرسلة<br><b id="replies">0</b></div>
<div class="stat">جهات الاتصال<br><b id="contacts">0</b></div>
<div class="stat">ردود الذكاء الاصطناعي<br><b id="aiCount">0</b></div>
</div>
<button class="secondary" onclick="refresh()">تحديث الحالة</button>
</section>

<section>
<h3>⚙️ تشغيل وإيقاف</h3>
<button onclick="control(true)">تشغيل البوت</button>
<button class="danger" onclick="control(false)">إيقاف البوت للجميع</button>
<p><small>الإيقاف يمنع الردود التلقائية والردود على كل المحادثات.</small></p>
</section>

<section>
<h3>📷 ربط واتساب</h3>
<a href="/qr" target="_blank" style="color:#8fc8ff">فتح صفحة QR</a>
<p><small>امسح الرمز من واتساب ← الأجهزة المرتبطة ← ربط جهاز.</small></p>
</section>

<section>
<h3>✉️ إرسال رسالة</h3>
<input id="phone" placeholder="رقم المستلم مع مفتاح الدولة">
<textarea id="message" placeholder="اكتب الرسالة"></textarea>
<button onclick="sendNow()">إرسال الآن</button>
</section>

<section>
<h3>🕒 جدولة رسالة</h3>
<input id="schedulePhone" placeholder="رقم المستلم مع مفتاح الدولة">
<textarea id="scheduleMessage" placeholder="نص الرسالة"></textarea>
<label>وقت الإرسال:</label>
<input id="scheduleTime" type="datetime-local">
<button onclick="schedule()">حفظ الموعد</button>
<div id="jobs"></div>
</section>

<section>
<h3>🧠 إعدادات الذكاء الاصطناعي</h3>
<label><input style="width:auto" type="checkbox" id="aiEnabled"> تفعيل الذكاء الاصطناعي</label>
<label><input style="width:auto" type="checkbox" id="autoReply"> تفعيل الرد التلقائي</label>
<input id="replyStyle" placeholder="أسلوب الرد">
<textarea id="instructions" placeholder="تعليمات إضافية للذكاء الاصطناعي"></textarea>
<button onclick="saveSettings()">حفظ الإعدادات</button>
<button class="secondary" onclick="testAI()">اختبار الذكاء الاصطناعي</button>
<pre id="aiResult"></pre>
</section>

<section>
<h3>💬 الردود المخصصة</h3>
<input id="trigger" placeholder="الكلمة أو العبارة">
<textarea id="customReply" placeholder="الرد الذي سيرسله البوت"></textarea>
<button onclick="addReply()">إضافة رد</button>
<div id="replyList"></div>
</section>

<section>
<h3>⚠️ سجل الأخطاء</h3>
<pre id="error">لا توجد أخطاء ظاهرة</pre>
</section>
<button class="danger" onclick="logout()">تسجيل الخروج</button>
</div>
</main>

<script>
let token = sessionStorage.getItem("botToken") || "";

async function api(url, method="GET", body) {
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type":"application/json",
      "Authorization":"Bearer " + token
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const result = await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(result.error || "حدث خطأ");
  return result;
}

async function login() {
  try {
    const result = await fetch("/api/login", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({password:document.getElementById("password").value})
    });
    const value = await result.json();
    if (!result.ok) throw new Error(value.error || "كلمة المرور غير صحيحة");
    token = value.token;
    sessionStorage.setItem("botToken", token);
    document.getElementById("login").style.display="none";
    document.getElementById("panel").style.display="block";
    refresh();
  } catch(e) {
    document.getElementById("loginError").textContent=e.message;
  }
}

function logout() {
  token="";
  sessionStorage.removeItem("botToken");
  location.reload();
}

async function refresh() {
  try {
    const s = await api("/api/status");
    document.getElementById("wa").textContent=s.connected?"متصل 🟢":"غير متصل 🔴";
    document.getElementById("enabled").textContent=s.botEnabled?"يعمل":"متوقف";
    document.getElementById("incoming").textContent=s.incomingCount;
    document.getElementById("replies").textContent=s.repliesCount;
    document.getElementById("contacts").textContent=s.contacts;
    document.getElementById("aiCount").textContent=s.aiCount;
    document.getElementById("error").textContent=s.lastError || "لا توجد أخطاء ظاهرة";
    const settings=await api("/api/settings");
    document.getElementById("aiEnabled").checked=settings.aiEnabled;
    document.getElementById("autoReply").checked=settings.autoReply;
    document.getElementById("replyStyle").value=settings.replyStyle || "";
    document.getElementById("instructions").value=settings.customInstructions || "";
    document.getElementById("replyList").textContent=
      Object.entries(settings.replies).map(([k,v])=>k+" ← "+v).join("\\n") || "لا توجد ردود مخصصة";
    const jobs=await api("/api/jobs");
    document.getElementById("jobs").textContent=
      jobs.jobs.map(j=>j.phone+" | "+j.sendAt+" | "+j.status).join("\\n") || "لا توجد رسائل مجدولة";
  } catch(e) {
    if (e.message.includes("سجّل الدخول")) logout();
    else alert(e.message);
  }
}

async function control(enabled) {
  try { await api("/api/control","POST",{enabled}); await refresh(); }
  catch(e){alert(e.message);}
}

async function sendNow() {
  try {
    await api("/api/send","POST",{
      phone:document.getElementById("phone").value,
      message:document.getElementById("message").value
    });
    alert("تم إرسال الرسالة");
  } catch(e){alert(e.message);}
}

async function schedule() {
  try {
    await api("/api/schedule","POST",{
      phone:document.getElementById("schedulePhone").value,
      message:document.getElementById("scheduleMessage").value,
      sendAt:document.getElementById("scheduleTime").value
    });
    alert("تمت جدولة الرسالة");
    refresh();
  } catch(e){alert(e.message);}
}

async function saveSettings() {
  try {
    await api("/api/settings","POST",{
      aiEnabled:document.getElementById("aiEnabled").checked,
      autoReply:document.getElementById("autoReply").checked,
      replyStyle:document.getElementById("replyStyle").value,
      customInstructions:document.getElementById("instructions").value
    });
    alert("تم حفظ الإعدادات");
  } catch(e){alert(e.message);}
}

async function testAI() {
  try {
    const result=await api("/api/ai-test","POST",{text:"عرّف بنفسك باختصار"});
    document.getElementById("aiResult").textContent=result.answer;
  } catch(e){alert(e.message);}
}

async function addReply() {
  try {
    await api("/api/replies","POST",{
      trigger:document.getElementById("trigger").value,
      reply:document.getElementById("customReply").value
    });
    document.getElementById("trigger").value="";
    document.getElementById("customReply").value="";
    refresh();
  } catch(e){alert(e.message);}
}

if (token) {
  document.getElementById("login").style.display="none";
  document.getElementById("panel").style.display="block";
  refresh();
}
</script>
</body>
</html>`);
});

// QR code
app.get("/qr", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="ar" dir="rtl"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ربط واتساب</title>
<body style="font-family:Arial;text-align:center;padding:20px">
<h2>ربط بوت واتساب</h2>
<p id="status">جاري تحميل رمز QR...</p>
<img id="qr" style="max-width:320px;width:100%">
<script>
async function loadQR(){
 try{
  const r=await fetch('/qr-data'); const d=await r.json();
  document.getElementById('status').textContent=d.connected?'واتساب متصل بالفعل 🟢':(d.qr?'امسح الرمز من واتساب':'الرمز لم يصدر بعد، حدّث الصفحة');
  document.getElementById('qr').src=d.qr||'';
 }catch(e){document.getElementById('status').textContent='تعذر تحميل الرمز';}
}
loadQR(); setInterval(loadQR,5000);
</script></body></html>`);
});

app.get("/qr-data", (req, res) => {
  res.json({ connected, qr: latestQR, updatedAt: qrUpdatedAt });
});

// API تسجيل الدخول
app.post("/api/login", (req, res) => {
  if (!DASHBOARD_PASSWORD) {
    return res.status(500).json({ error: "أضف DASHBOARD_PASSWORD في Render" });
  }
  if (safeString(req.body.password, 300) !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: "كلمة المرور غير صحيحة" });
  }
  const token = require("crypto").randomBytes(32).toString("hex");
  sessions.set(token, { createdAt: Date.now() });
  res.json({ token });
});

app.get("/api/status", requireLogin, (req, res) => {
  res.json({
    connected,
    botEnabled,
    incomingCount,
    repliesCount,
    aiCount,
    contacts: data.contacts.length,
    lastError
  });
});

app.post("/api/control", requireLogin, (req, res) => {
  botEnabled = Boolean(req.body.enabled);
  res.json({ success: true, botEnabled });
});

app.get("/api/settings", requireLogin, (req, res) => {
  res.json({
    aiEnabled: data.aiEnabled,
    autoReply: data.autoReply,
    replyStyle: data.replyStyle,
    customInstructions: data.customInstructions,
    replies: data.replies
  });
});

app.post("/api/settings", requireLogin, (req, res) => {
  if (typeof req.body.aiEnabled === "boolean") data.aiEnabled = req.body.aiEnabled;
  if (typeof req.body.autoReply === "boolean") data.autoReply = req.body.autoReply;
  if (req.body.replyStyle !== undefined) data.replyStyle = safeString(req.body.replyStyle, 500);
  if (req.body.customInstructions !== undefined) {
    data.customInstructions = safeString(req.body.customInstructions, 3000);
  }
  saveData();
  res.json({ success: true });
});

app.post("/api/send", requireLogin, async (req, res) => {
  try {
    const jid = jidFromPhone(req.body.phone);
    const message = safeString(req.body.message, 4000);
    if (!message.trim()) throw new Error("اكتب نص الرسالة");
    await sendText(jid, message);
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/schedule", requireLogin, (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const message = safeString(req.body.message, 4000);
    const sendAt = new Date(req.body.sendAt);

    if (phone.length < 8) throw new Error("رقم الهاتف غير صحيح");
    if (!message.trim()) throw new Error("اكتب نص الرسالة");
    if (Number.isNaN(sendAt.getTime()) || sendAt.getTime() <= Date.now()) {
      throw new Error("اختر وقتاً في المستقبل");
    }

    const job = {
      id: require("crypto").randomUUID(),
      phone,
      message,
      sendAt: sendAt.toISOString(),
      status: "pending"
    };

    data.jobs.push(job);
    saveData();
    res.json({ success: true, job });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/jobs", requireLogin, (req, res) => {
  res.json({ jobs: data.jobs.slice(-100).reverse() });
});

app.post("/api/replies", requireLogin, (req, res) => {
  const trigger = safeString(req.body.trigger, 100).trim();
  const reply = safeString(req.body.reply, 1000).trim();
  if (!trigger || !reply) return res.status(400).json({ error: "أكمل الكلمة والرد" });
  data.replies[trigger] = reply;
  saveData();
  res.json({ success: true });
});

app.post("/api/ai-test", requireLogin, async (req, res) => {
  try {
    if (!GEMINI_API_KEY) throw new Error("أضف GEMINI_API_KEY في Render");
    const answer = await askAI("dashboard-test", safeString(req.body.text || "مرحبا", 500));
    res.json({ answer });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/status", (req, res) => {
  res.json({ connected, botEnabled });
});

loadData();

app.listen(PORT, () => {
  console.log("Web server running on port", PORT);
});

setInterval(() => {
  processJobs().catch(e => {
    lastError = e.message;
    console.error("Scheduler error:", e);
  });
}, 10000);

connectWhatsApp().catch(e => {
  lastError = e.message;
  console.error(e);
});

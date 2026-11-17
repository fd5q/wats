
const express = require("express");
const pino = require("pino");
const QRCode = require("qrcode");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json({ limit: "100kb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const PASSWORD = process.env.DASHBOARD_PASSWORD;
const MODEL = "gemini-3.8-flash";
const DATA_DIR = process.env.DATA_DIR || "./data";
const DATA_FILE = path.join(DATA_DIR, "bot-data.json");
const AUTH_DIR = path.join(DATA_DIR, "auth");

if (!PASSWORD) throw new Error("DASHBOARD_PASSWORD missing");
if (!API_KEY) throw new Error("GEMINI_API_KEY missing");

let sock = null;
let connected = false;
let qrImage = null;
let enabled = true;
let reconnecting = false;
let lastError = "";

let messagesCount = 0;
let repliesCount = 0;

const sessions = new Map();
const loginAttempts = new Map();
const conversations = new Map();
const lastMessage = new Map();
const contacts = new Map();

let jobs = [];

let settings = {
  aiEnabled: true,
  aiName: "مساعد فهد",
  aiPrompt: "أنت مساعد واتساب ذكي. تحدث باللغة العربية السعودية بأسلوب طبيعي ومهذب. أجب باختصار ووضوح. لا تدّعِ أنك شخص حقيقي.",
  aiTemperature: 0.7,
  maxReplyLength: 500,
  welcome: "أهلاً بك 👋 نورتنا!",
  replies: {
    "السلام عليكم": "وعليكم السلام ورحمة الله وبركاته 🌹",
    "هلا": "هلا وغلا 👋",
    "مرحبا": "يا مرحبا فيك ❤️",
    "كيف الحال": "بخير الحمد لله، وأنت؟",
    "شكرا": "العفو، بالخدمة دائماً ❤️"
  }
};

function saveData() {
  return fs.mkdir(DATA_DIR, { recursive: true }).then(() =>
    fs.writeFile(DATA_FILE, JSON.stringify({ settings, jobs }, null, 2))
  );
}

async function loadData() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    const data = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
    if (data.settings) settings = { ...settings, ...data.settings };
    if (Array.isArray(data.jobs)) jobs = data.jobs;
  } catch (e) {
    if (e.code !== "ENOENT") console.error("Data load error:", e.message);
    await saveData();
  }
}

function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const expiry = sessions.get(token);

  if (!token || !expiry || expiry < Date.now()) {
    sessions.delete(token);
    return res.status(401).json({ error: "انتهت الجلسة، سجل الدخول مجدداً" });
  }

  next();
}

function normalizePhone(value) {
  let phone = String(value || "").replace(/\D/g, "");

  if (phone.startsWith("00")) phone = phone.slice(2);
  if (phone.startsWith("05") && phone.length === 10) {
    phone = "966" + phone.slice(1);
  }

  if (phone.length < 8 || phone.length > 15) return null;
  return phone;
}

async function sendWhatsApp(phone, message) {
  if (!connected || !sock) throw new Error("واتساب غير متصل");
  if (!message || message.length > 4000) throw new Error("الرسالة فارغة أو طويلة");

  const jid = phone + "@s.whatsapp.net";
  await sock.sendMessage(jid, { text: message });
  repliesCount++;
}

async function askGemini(jid, userMessage) {
  const history = conversations.get(jid) || [];

  const contents = [
    ...history.slice(-12),
    { role: "user", parts: [{ text: userMessage }] }
  ];

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": API_KEY
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: settings.aiPrompt +
              "\nاسم المساعد: " + settings.aiName +
              "\nلا تتجاوز " + settings.maxReplyLength + " حرفاً في الرد."
          }]
        },
        contents,
        generationConfig: {
          temperature: Number(settings.aiTemperature),
          maxOutputTokens: 700
        }
      }),
      signal: AbortSignal.timeout(30000)
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error?.message || "Gemini API error");
  }

  const answer = data.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "")
    .join("")
    .trim();

  if (!answer) throw new Error("لم يصل رد من الذكاء الاصطناعي");

  history.push(
    { role: "user", parts: [{ text: userMessage }] },
    { role: "model", parts: [{ text: answer }] }
  );

  conversations.set(jid, history.slice(-16));

  return answer.slice(0, settings.maxReplyLength);
}

// تسجيل الدخول
app.post("/api/login", (req, res) => {
  const ip = req.ip;
  const attempts = loginAttempts.get(ip) || { count: 0, until: 0 };

  if (attempts.until > Date.now()) {
    return res.status(429).json({ error: "انتظر دقيقة قبل المحاولة" });
  }

  const supplied = Buffer.from(String(req.body.password || ""));
  const expected = Buffer.from(PASSWORD);

  const valid =
    supplied.length === expected.length &&
    crypto.timingSafeEqual(supplied, expected);

  if (!valid) {
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

// حالة البوت
app.get("/api/status", authenticate, (req, res) => {
  res.json({
    connected,
    enabled,
    aiEnabled: settings.aiEnabled,
    messagesCount,
    repliesCount,
    contacts: contacts.size,
    pendingJobs: jobs.filter(j => j.status === "pending").length,
    lastError
  });
});

// تشغيل وإيقاف الردود
app.post("/api/control", authenticate, (req, res) => {
  if (req.body.action === "on") enabled = true;
  else if (req.body.action === "off") enabled = false;
  else return res.status(400).json({ error: "Invalid action" });

  res.json({ success: true, enabled });
});

// إعدادات الذكاء الاصطناعي والردود
app.get("/api/settings", authenticate, (req, res) => {
  res.json(settings);
});

app.post("/api/settings", authenticate, async (req, res) => {
  const b = req.body;

  if (typeof b.aiEnabled === "boolean") settings.aiEnabled = b.aiEnabled;
  if (typeof b.aiName === "string") settings.aiName = b.aiName.slice(0, 80);
  if (typeof b.aiPrompt === "string") settings.aiPrompt = b.aiPrompt.slice(0, 3000);

  if (Number.isFinite(Number(b.aiTemperature))) {
    settings.aiTemperature = Math.max(0, Math.min(1, Number(b.aiTemperature)));
  }

  if (Number.isFinite(Number(b.maxReplyLength))) {
    settings.maxReplyLength = Math.max(50, Math.min(1500, Number(b.maxReplyLength)));
  }

  if (typeof b.welcome === "string") settings.welcome = b.welcome.slice(0, 500);

  if (b.replies && typeof b.replies === "object" && !Array.isArray(b.replies)) {
    settings.replies = Object.fromEntries(
      Object.entries(b.replies).slice(0, 100).filter(([k, v]) =>
        typeof k === "string" && typeof v === "string" &&
        k.length <= 100 && v.length <= 1000
      )
    );
  }

  await saveData();
  res.json({ success: true });
});

// إرسال رسالة فورية
app.post("/api/send", authenticate, async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const message = String(req.body.message || "").trim();

  if (!phone) return res.status(400).json({ error: "رقم الهاتف غير صحيح" });
  if (!message) return res.status(400).json({ error: "اكتب الرسالة" });

  try {
    await sendWhatsApp(phone, message);
    res.json({ success: true, message: "تم إرسال الرسالة" });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// جدولة رسالة
app.post("/api/schedule", authenticate, async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const message = String(req.body.message || "").trim();
  const date = new Date(req.body.date);

  if (!phone) return res.status(400).json({ error: "رقم الهاتف غير صحيح" });
  if (!message) return res.status(400).json({ error: "اكتب الرسالة" });
  if (message.length > 4000) return res.status(400).json({ error: "الرسالة طويلة جداً" });
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
    return res.status(400).json({ error: "اختر موعداً مستقبلياً" });
  }

  const job = {
    id: crypto.randomUUID(),
    phone,
    message,
    date: date.toISOString(),
    status: "pending",
    createdAt: new Date().toISOString()
  };

  jobs.push(job);
  await saveData();

  res.json({ success: true, job });
});

// عرض المواعيد
app.get("/api/jobs", authenticate, (req, res) => {
  res.json(jobs.slice().reverse());
});

// إلغاء موعد
app.delete("/api/jobs/:id", authenticate, async (req, res) => {
  const job = jobs.find(j => j.id === req.params.id);

  if (!job || job.status !== "pending") {
    return res.status(404).json({ error: "الموعد غير موجود أو تم تنفيذه" });
  }

  job.status = "cancelled";
  await saveData();
  res.json({ success: true });
});

// قائمة الأشخاص الذين راسلوا البوت
app.get("/api/contacts", authenticate, (req, res) => {
  res.json([...contacts.values()]);
});

// اختبار الذكاء الاصطناعي من لوحة التحكم
app.post("/api/ai-test", authenticate, async (req, res) => {
  try {
    const answer = await askGemini(
      "dashboard-test",
      String(req.body.message || "عرف بنفسك")
    );
    res.json({ answer });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// QR محمي
app.get("/api/qr", authenticate, (req, res) => {
  res.json({ qr: qrImage, connected });
});

// صفحة الداشبورد
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fahad AI WhatsApp</title>
<style>
*{box-sizing:border-box}
body{font-family:Arial;background:#101820;color:white;margin:0;padding:16px}
main{max-width:850px;margin:auto}
.card{background:#1d2b36;padding:18px;border-radius:14px;margin:13px 0}
input,textarea,button{font:inherit;border-radius:8px;padding:12px}
input,textarea{width:100%;margin:7px 0;border:1px solid #425462;background:#101820;color:white}
button{border:0;margin:5px;cursor:pointer;background:#344b5b;color:white}
.green{background:#159767}
.red{background:#b63c3c}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.small{color:#b9c9d4;font-size:13px}
pre{white-space:pre-wrap;overflow-wrap:anywhere}
img{max-width:260px;background:white}
.hidden{display:none}
h2,h3{margin-top:5px}
</style>
</head>
<body>
<main>
<h2>🤖 Fahad AI WhatsApp</h2>
<p class="small">لوحة تحكم المالك</p>

<div class="card" id="login">
<h3>دخول المالك</h3>
<input id="password" type="password" placeholder="كلمة مرور الداشبورد">
<button class="green" onclick="login()">دخول</button>
<p id="loginMsg"></p>
</div>

<div id="panel" class="hidden">

<div class="grid">
<div class="card"><h3>الاتصال</h3><p id="connection">...</p></div>
<div class="card"><h3>الردود</h3><p id="replyState">...</p></div>
<div class="card"><h3>الذكاء الاصطناعي</h3><p id="aiState">...</p></div>
<div class="card"><h3>الإحصائيات</h3><p id="stats">...</p></div>
</div>

<div class="card">
<h3>التحكم بالبوت</h3>
<button class="green" onclick="control('on')">تشغيل الردود</button>
<button class="red" onclick="control('off')">إيقاف الردود</button>
<button onclick="refresh()">تحديث</button>
<p id="lastError"></p>
</div>

<div class="card">
<h3>📱 ربط واتساب</h3>
<img id="qr" class="hidden">
<p id="qrText">جاري الفحص...</p>
</div>

<div class="card">
<h3>💬 إرسال رسالة الآن</h3>
<input id="sendPhone" placeholder="رقم المستلم مع مفتاح الدولة">
<textarea id="sendMessage" placeholder="اكتب رسالتك"></textarea>
<button class="green" onclick="sendNow()">إرسال الآن</button>
<p id="sendResult"></p>
</div>

<div class="card">
<h3>⏰ جدولة رسالة</h3>
<input id="jobPhone" placeholder="رقم المستلم">
<textarea id="jobMessage" placeholder="نص الرسالة"></textarea>
<label>موعد الإرسال حسب توقيت جهازك</label>
<input id="jobDate" type="datetime-local">
<button class="green" onclick="schedule()">حفظ الموعد</button>
<p id="jobResult"></p>
<h3>المواعيد المجدولة</h3>
<div id="jobs">...</div>
</div>

<div class="card">
<h3>🧠 إعدادات الذكاء الاصطناعي</h3>
<label><input type="checkbox" id="aiEnabled" style="width:auto"> تفعيل ردود Gemini</label>
<input id="aiName" placeholder="اسم المساعد">
<label>تعليمات شخصية المساعد</label>
<textarea id="aiPrompt" rows="5"></textarea>
<label>درجة الإبداع: <span id="tempValue">0.7</span></label>
<input type="range" id="temperature" min="0" max="1" step="0.1" value="0.7" oninput="tempValue.innerText=this.value">
<label>أقصى طول للرد</label>
<input type="number" id="maxLength" min="50" max="1500">
<button class="green" onclick="saveSettings()">حفظ إعدادات الذكاء</button>
<p id="settingsResult"></p>
</div>

<div class="card">
<h3>🧪 تجربة الذكاء الاصطناعي</h3>
<textarea id="testMessage" placeholder="اكتب سؤالاً لتجربة Gemini"></textarea>
<button onclick="testAI()">جرّب الذكاء الاصطناعي</button>
<pre id="testResult"></pre>
</div>

<div class="card">
<h3>📝 الردود التلقائية</h3>
<p class="small">اكتب الردود بصيغة JSON، مثال: {"هلا":"هلا فيك"}</p>
<textarea id="replies" rows="9"></textarea>
<input id="welcome" placeholder="رسالة الترحيب">
<button class="green" onclick="saveSettings()">حفظ الردود</button>
</div>

<div class="card">
<h3>👥 الأشخاص الذين راسلوا البوت</h3>
<button onclick="loadContacts()">تحديث القائمة</button>
<div id="contacts"></div>
</div>

<div class="card">
<h3>🛡️ معلومات الأمان</h3>
<p class="small">كل عمليات الإدارة والإرسال والجدولة محمية بتسجيل دخول المالك. لا تشارك كلمة المرور أو رمز QR.</p>
<button class="red" onclick="logout()">تسجيل الخروج</button>
</div>

</div>
</main>

<script>
let token = "";

async function api(url, method="GET", body=null) {
  const r = await fetch(url, {
    method,
    headers: {
      "Content-Type":"application/json",
      "Authorization":"Bearer "+token
    },
    body: body ? JSON.stringify(body) : null
  });

  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "حدث خطأ");
  return data;
}

async function login() {
  try {
    const r = await fetch("/api/login", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({password:password.value})
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);

    token = d.token;
    sessionStorage.setItem("ownerToken", token);
    document.getElementById("login").classList.add("hidden");
    document.getElementById("panel").classList.remove("hidden");

    await refresh();
    await loadSettings();
    await loadQR();
    await loadJobs();
    await loadContacts();
  } catch(e) {
    loginMsg.innerText = e.message;
  }
}

async function refresh() {
  try {
    const d = await api("/api/status");
    connection.innerText = d.connected ? "متصل ✅" : "غير متصل ❌";
    replyState.innerText = d.enabled ? "مفعلة ✅" : "متوقفة ⏸️";
    aiState.innerText = d.aiEnabled ? "مفعل 🧠" : "متوقف";
    stats.innerText = "الرسائل: "+d.messagesCount+
      "\\nالردود: "+d.repliesCount+
      "\\nالأشخاص: "+d.contacts+
      "\\nالمواعيد القادمة: "+d.pendingJobs;
    lastError.innerText = "آخر خطأ: "+(d.lastError || "لا يوجد");
  } catch(e) { logout(); }
}

async function control(action) {
  try {
    await api("/api/control","POST",{action});
    await refresh();
  } catch(e) { alert(e.message); }
}

async function loadSettings() {
  const d = await api("/api/settings");
  aiEnabled.checked = d.aiEnabled;
  aiName.value = d.aiName;
  aiPrompt.value = d.aiPrompt;
  temperature.value = d.aiTemperature;
  tempValue.innerText = d.aiTemperature;
  maxLength.value = d.maxReplyLength;
  replies.value = JSON.stringify(d.replies,null,2);
  welcome.value = d.welcome;
}

async function saveSettings() {
  try {
    const parsed = JSON.parse(replies.value || "{}");
    await api("/api/settings","POST",{
      aiEnabled:aiEnabled.checked,
      aiName:aiName.value,
      aiPrompt:aiPrompt.value,
      aiTemperature:Number(temperature.value),
      maxReplyLength:Number(maxLength.value),
      replies:parsed,
      welcome:welcome.value
    });
    settingsResult.innerText = "تم الحفظ بنجاح ✅";
    await refresh();
  } catch(e) {
    settingsResult.innerText = "خطأ: "+e.message;
  }
}

async function sendNow() {
  try {
    const d = await api("/api/send","POST",{
      phone:sendPhone.value,
      message:sendMessage.value
    });
    sendResult.innerText = d.message+" ✅";
  } catch(e) {
    sendResult.innerText = e.message;
  }
}

async function schedule() {
  try {
    const d = await api("/api/schedule","POST",{
      phone:jobPhone.value,
      message:jobMessage.value,
      date:new Date(jobDate.value).toISOString()
    });
    jobResult.innerText = "تمت جدولة الرسالة ✅";
    await loadJobs();
    await refresh();
  } catch(e) {
    jobResult.innerText = e.message;
  }
}

async function loadJobs() {
  const list = await api("/api/jobs");
  jobs.innerHTML = list.map(j =>
    "<div class='card'><b>"+j.phone+"</b><p>"+j.message+"</p>"+
    "<p class='small'>"+new Date(j.date).toLocaleString("ar-SA")+
    " — "+j.status+"</p>"+
    (j.status==="pending" ?
      "<button class='red' onclick='cancelJob(\""+j.id+"\")'>إلغاء</button>" : "")+
    "</div>"
  ).join("") || "لا توجد مواعيد";
}

async function cancelJob(id) {
  try {
    await api("/api/jobs/"+id,"DELETE");
    await loadJobs();
    await refresh();
  } catch(e) { alert(e.message); }
}

async function loadQR() {
  try {
    const d = await api("/api/qr");
    if (d.connected) {
      qr.classList.add("hidden");
      qrText.innerText = "واتساب متصل بالفعل ✅";
    } else if (d.qr) {
      qr.src = d.qr;
      qr.classList.remove("hidden");
      qrText.innerText = "امسح الرمز من واتساب";
    } else {
      qr.classList.add("hidden");
      qrText.innerText = "بانتظار رمز QR...";
    }
  } catch(e) {}
}

async function testAI() {
  testResult.innerText = "جاري التفكير...";
  try {
    const d = await api("/api/ai-test","POST",{message:testMessage.value});
    testResult.innerText = d.answer;
  } catch(e) {
    testResult.innerText = e.message;
  }
}

async function loadContacts() {
  try {
    const list = await api("/api/contacts");
    contacts.innerHTML = list.map(c =>
      "<div class='card'>"+c.phone+
      "<p class='small'>آخر رسالة: "+new Date(c.lastSeen).toLocaleString("ar-SA")+"</p></div>"
    ).join("") || "لا يوجد أشخاص بعد";
  } catch(e) {}
}

function logout() {
  token = "";
  sessionStorage.removeItem("ownerToken");
  location.reload();
}

token = sessionStorage.getItem("ownerToken") || "";
if (token) {
  login().catch(logout);
}

setInterval(() => {
  if (token) {
    refresh();
    loadQR();
    loadJobs();
  }
},15000);
</script>
</body>
</html>`);
});

// تنفيذ المواعيد المجدولة
async function processJobs() {
  if (!connected || !sock) return;

  const now = Date.now();

  for (const job of jobs) {
    if (job.status !== "pending" || new Date(job.date).getTime() > now) continue;

    // نعلّم الموعد قيد التنفيذ حتى لا يتكرر
    job.status = "sending";
    await saveData();

    try {
      await sendWhatsApp(job.phone, job.message);
      job.status = "sent";
      job.sentAt = new Date().toISOString();
    } catch(e) {
      job.status = "failed";
      job.error = e.message;
      lastError = e.message;
    }

    await saveData();
  }
}

// تشغيل واتساب
async function startBot() {
  if (reconnecting) return;
  reconnecting = true;

  try {
    await fs.mkdir(AUTH_DIR, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      browser: ["Fahad AI Bot", "Chrome", "1.0.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrImage = await QRCode.toDataURL(qr);
        connected = false;
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

        const phone = jid.split("@")[0];
        contacts.set(jid, {
          phone,
          lastSeen: new Date().toISOString()
        });

        const previous = lastMessage.get(jid) || 0;
        if (Date.now() - previous < 2500) continue;
        lastMessage.set(jid, Date.now());

        const input = text.trim();
        const key = input.toLowerCase();

        let answer = null;

        if (key === "!menu" || key === "!help" || key === "!مساعدة") {
          answer = "🤖 قائمة الأوامر\\n!menu - القائمة\\n!time - الوقت\\n!date - التاريخ\\n!ping - اختبار البوت\\n!about - معلومات البوت";
        } else if (key === "!time") {
          answer = new Date().toLocaleTimeString("ar-SA", { timeZone: "Asia/Riyadh" });
        } else if (key === "!date") {
          answer = new Date().toLocaleDateString("ar-SA", { timeZone: "Asia/Riyadh" });
        } else if (key === "!ping") {
          answer = "Pong! 🏓";
        } else if (key === "!about") {
          answer = "أنا مساعد واتساب ذكي 🤖";
        } else {
          const matchingKey = Object.keys(settings.replies)
            .find(k => k.toLowerCase() === key);

          if (matchingKey) answer = settings.replies[matchingKey];
        }

        try {
          if (!answer && settings.aiEnabled) {
            answer = await askGemini(jid, input);
          }

          if (answer) {
            await sock.sendMessage(jid, { text: answer });
            repliesCount++;
          }
        } catch(e) {
          lastError = e.message;
          console.error("Message error:", e.message);
        }
      }
    });

  } catch(e) {
    connected = false;
    reconnecting = false;
    lastError = e.message;
    console.error("Bot startup error:", e.message);
    setTimeout(startBot, 10000);
  }
}

async function main() {
  await loadData();

  app.listen(PORT, () => {
    console.log("Dashboard server running on port " + PORT);
  });

  setInterval(processJobs, 10000);
  await startBot();
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});

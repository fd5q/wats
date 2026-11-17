
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
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "1mb" }));

// =============================
// إعدادات المشروع
// =============================

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-2.5-flash";
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "";

const DATA_DIR = process.env.DATA_DIR || "./data";
const AUTH_DIR = path.join(DATA_DIR, "auth");
const DATA_FILE = path.join(DATA_DIR, "bot-data.json");

fs.mkdirSync(AUTH_DIR, { recursive: true });

let sock = null;
let connected = false;
let latestQR = null;
let reconnecting = false;
let botEnabled = true;
let lastError = "";
let processingJobs = false;

let stats = {
  incoming: 0,
  sent: 0,
  ai: 0,
  blocked: 0
};

const sessions = new Map();
const conversations = new Map();
const lastMessages = new Map();
const messageTimes = new Map();
const loginAttempts = new Map();

let data = {
  aiEnabled: true,
  autoReply: true,
  replyStyle: "ودي وطبيعي وباللهجة السعودية، مختصر وواضح.",
  customInstructions: "",

  replies: [],
  bannedWords: [],
  blocked: [],
  muted: [],
  warnings: {},

  warningLimit: 3,
  blockOnBannedWord: false,
  antiSpam: true,
  welcomeEnabled: false,
  welcomeMessage: "هلا والله 👋 حياك!",

  jobs: [],
  contacts: [],
  logs: []
};

// =============================
// التخزين
// =============================

function saveData() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    const tempFile = DATA_FILE + ".tmp";
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
    fs.renameSync(tempFile, DATA_FILE);
  } catch (e) {
    console.error("Save error:", e.message);
    lastError = e.message;
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

  // تحويل الردود القديمة إلى الشكل الجديد
  if (!Array.isArray(data.replies)) {
    data.replies = Object.entries(data.replies || {}).map(([trigger, reply]) => ({
      id: crypto.randomUUID(),
      trigger,
      reply,
      enabled: true,
      match: "contains"
    }));
  }

  if (!Array.isArray(data.contacts)) data.contacts = [];
  if (!Array.isArray(data.blocked)) data.blocked = [];
  if (!Array.isArray(data.muted)) data.muted = [];
  if (!Array.isArray(data.bannedWords)) data.bannedWords = [];
  if (!Array.isArray(data.jobs)) data.jobs = [];
  if (!Array.isArray(data.logs)) data.logs = [];

  // استعادة المهام التي كانت قيد الإرسال عند توقف الخدمة
  for (const job of data.jobs) {
    if (job.status === "sending") job.status = "pending";
  }

  saveData();
}

function logEvent(type, details) {
  data.logs.unshift({
    id: crypto.randomUUID(),
    type,
    details: String(details || "").slice(0, 500),
    time: new Date().toISOString()
  });

  data.logs = data.logs.slice(0, 500);
  saveData();
}

function safeString(value, max = 2000) {
  return String(value ?? "").slice(0, max);
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function jidFromPhone(value) {
  const phone = normalizePhone(value);
  if (phone.length < 8) throw new Error("رقم الهاتف غير صحيح");
  return phone + "@s.whatsapp.net";
}

// تطبيع الكلمات العربية والإنجليزية للمطابقة
function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/ـ/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesPhrase(message, phrase) {
  const a = normalizeText(message);
  const b = normalizeText(phrase);
  return Boolean(b && a.includes(b));
}

// =============================
// تسجيل الدخول والحماية
// =============================

function cleanSessions() {
  const now = Date.now();

  for (const [token, session] of sessions) {
    if (now - session.createdAt > 8 * 60 * 60 * 1000) {
      sessions.delete(token);
    }
  }
}

function requireLogin(req, res, next) {
  cleanSessions();

  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");

  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: "انتهت الجلسة، سجّل الدخول مجدداً" });
  }

  next();
}

function loginRateLimit(req, res, next) {
  const ip = req.ip || "unknown";
  const now = Date.now();

  const attempts = (loginAttempts.get(ip) || []).filter(
    time => now - time < 10 * 60 * 1000
  );

  if (attempts.length >= 10) {
    return res.status(429).json({
      error: "محاولات كثيرة. انتظر عشر دقائق."
    });
  }

  attempts.push(now);
  loginAttempts.set(ip, attempts);
  next();
}

// =============================
// جهات الاتصال
// =============================

function rememberContact(jid, name = "") {
  const phone = jid.split("@")[0].split(":")[0];

  let contact = data.contacts.find(c => c.phone === phone);

  if (!contact) {
    contact = {
      phone,
      name: safeString(name, 100),
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      messages: 0
    };

    data.contacts.push(contact);
  }

  contact.lastSeen = new Date().toISOString();
  contact.messages = (contact.messages || 0) + 1;

  if (name) contact.name = safeString(name, 100);

  if (data.contacts.length > 2000) data.contacts.shift();

  saveData();
  return contact;
}

function getMessageText(message) {
  const m = message.message || {};

  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    ""
  ).trim();
}

function isBlocked(jid) {
  const phone = normalizePhone(jid.split("@")[0].split(":")[0]);
  return data.blocked.includes(phone);
}

function isMuted(jid) {
  const phone = normalizePhone(jid.split("@")[0].split(":")[0]);
  return data.muted.includes(phone);
}

// =============================
// الردود المخصصة
// =============================

function findCustomReply(message) {
  const normalizedMessage = normalizeText(message);

  const replies = data.replies
    .filter(r => r.enabled !== false && r.trigger && r.reply)
    .sort((a, b) => normalizeText(b.trigger).length - normalizeText(a.trigger).length);

  for (const item of replies) {
    const trigger = normalizeText(item.trigger);

    if (!trigger) continue;

    if (item.match === "exact") {
      if (normalizedMessage === trigger) return item;
    } else {
      if (normalizedMessage.includes(trigger)) return item;
    }
  }

  return null;
}

// =============================
// الذكاء الاصطناعي
// =============================

async function askAI(jid, userText) {
  if (!GEMINI_API_KEY) {
    throw new Error("مفتاح Gemini غير موجود في Render");
  }

  const history = conversations.get(jid) || [];

  const systemPrompt = `
أنت مساعد واتساب ذكي.
تحدث باللغة العربية واللهجة السعودية غالباً.
كن ودوداً وطبيعياً ومفيداً.
لا تدّع أنك إنسان أو صاحب الحساب إذا سُئلت مباشرة.
لا تنفذ طلبات خطرة أو تنتهك خصوصية أحد.
أسلوب الرد: ${data.replyStyle}
تعليمات إضافية: ${data.customInstructions}
`;

  const contents = [
    ...history.slice(-12),
    {
      role: "user",
      parts: [{ text: userText }]
    }
  ];

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: systemPrompt }]
        },
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
    throw new Error(result.error?.message || "خطأ في Gemini");
  }

  const answer = result.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "")
    .join("")
    .trim();

  if (!answer) throw new Error("لم يصل رد من الذكاء الاصطناعي");

  conversations.set(jid, [
    ...history,
    { role: "user", parts: [{ text: userText }] },
    { role: "model", parts: [{ text: answer }] }
  ].slice(-16));

  stats.ai++;
  return answer;
}

// =============================
// إرسال الرسائل
// =============================

async function sendText(jid, text) {
  if (!sock || !connected) {
    throw new Error("واتساب غير متصل");
  }

  const message = safeString(text, 4000).trim();
  if (!message) throw new Error("الرسالة فارغة");

  await sock.sendMessage(jid, { text: message });
  stats.sent++;
}

async function handleIncoming(msg) {
  if (!msg.message || msg.key.fromMe) return;

  const jid = msg.key.remoteJid;

  if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us")) return;

  const input = getMessageText(msg);
  if (!input) return;

  stats.incoming++;

  rememberContact(jid, msg.pushName || "");

  const phone = normalizePhone(jid.split("@")[0].split(":")[0]);

  // منع الأشخاص المحظورين
  if (isBlocked(jid)) {
    stats.blocked++;
    return;
  }

  // منع التكرار والإزعاج
  if (data.antiSpam) {
    const now = Date.now();

    const previous = lastMessages.get(jid);

    if (
      previous &&
      previous.text === normalizeText(input) &&
      now - previous.time < 15000
    ) {
      return;
    }

    lastMessages.set(jid, {
      text: normalizeText(input),
      time: now
    });

    const recent = (messageTimes.get(jid) || [])
      .filter(time => now - time < 60000);

    if (recent.length >= 8) {
      logEvent("anti-spam", "تم تجاهل رسائل متكررة من " + phone);
      return;
    }

    recent.push(now);
    messageTimes.set(jid, recent);
  }

  // الكلمات الممنوعة
  const banned = data.bannedWords.find(word =>
    word.enabled !== false && matchesPhrase(input, word.word)
  );

  if (banned) {
    const count = (data.warnings[phone] || 0) + 1;
    data.warnings[phone] = count;

    logEvent("banned-word", phone + " استخدم كلمة ممنوعة");

    if (data.blockOnBannedWord || count >= data.warningLimit) {
      if (!data.blocked.includes(phone)) {
        data.blocked.push(phone);
      }

      saveData();
      await sendText(jid, "تم إيقاف تفاعلك مع البوت بسبب مخالفة قواعد المحادثة.");
      logEvent("blocked", "حظر تلقائي للرقم " + phone);
      return;
    }

    saveData();
    await sendText(
      jid,
      `⚠️ تنبيه: استخدمت عبارة ممنوعة. التحذير ${count} من ${data.warningLimit}.`
    );
    return;
  }

  // الأشخاص المكتومون
  if (isMuted(jid)) return;

  // إيقاف البوت أو الرد التلقائي
  if (!botEnabled || !data.autoReply) return;

  // الردود المخصصة لها الأولوية دائماً
  const custom = findCustomReply(input);

  if (custom) {
    await sendText(jid, custom.reply);
    logEvent("custom-reply", "تم استخدام رد مخصص مع " + phone);
    return;
  }

  // الذكاء الاصطناعي
  if (data.aiEnabled) {
    try {
      const answer = await askAI(jid, input);
      await sendText(jid, answer);
      logEvent("ai-reply", "رد الذكاء الاصطناعي على " + phone);
    } catch (e) {
      lastError = e.message;
      logEvent("ai-error", e.message);
      console.error("AI error:", e.message);
    }
  }
}

// =============================
// اتصال واتساب
// =============================

async function connectWhatsApp() {
  if (reconnecting) return;
  reconnecting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    let version;
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch {}

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
        console.log("QR ready");
      }

      if (connection === "open") {
        connected = true;
        latestQR = null;
        lastError = "";
        logEvent("connection", "تم الاتصال بواتساب");
      }

      if (connection === "close") {
        connected = false;

        const code = lastDisconnect?.error?.output?.statusCode;

        logEvent("connection", "انقطع الاتصال: " + code);

        if (code !== DisconnectReason.loggedOut) {
          setTimeout(() => {
            reconnecting = false;
            connectWhatsApp().catch(console.error);
          }, 5000);
        } else {
          lastError = "تم تسجيل الخروج من واتساب. تحتاج إلى ربط QR جديد.";
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
          console.error("Message error:", e.message);
        }
      }
    });

  } catch (e) {
    lastError = e.message;
    console.error("WhatsApp connection error:", e);

    setTimeout(() => {
      reconnecting = false;
      connectWhatsApp().catch(console.error);
    }, 10000);
  }

  reconnecting = false;
}

// =============================
// جدولة الرسائل
// =============================

async function processJobs() {
  if (!connected || !sock || processingJobs) return;

  processingJobs = true;

  try {
    const now = Date.now();

    for (const job of data.jobs) {
      if (job.status !== "pending") continue;
      if (new Date(job.sendAt).getTime() > now) continue;

      job.status = "sending";
      saveData();

      try {
        await sendText(jidFromPhone(job.phone), job.message);
        job.status = "sent";
        job.sentAt = new Date().toISOString();
        logEvent("scheduled-sent", "تم إرسال رسالة مجدولة إلى " + job.phone);
      } catch (e) {
        job.status = "failed";
        job.error = e.message;
        logEvent("scheduled-error", e.message);
      }

      saveData();
    }
  } finally {
    processingJobs = false;
  }
}

// =============================
// واجهة الداشبورد
// =============================

app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fahad Bot Pro</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#0b1220;color:#f4f6fa;font-family:Arial,sans-serif}
main{max-width:1100px;margin:auto;padding:18px}
header{background:#172338;padding:20px;border-radius:16px;margin-bottom:15px}
h1{margin:0 0 8px;font-size:23px}
h2{font-size:18px;margin-top:0}
small,.muted{color:#aab8cc}
section{background:#172338;padding:17px;border-radius:14px;margin:13px 0}
input,textarea,select{width:100%;padding:12px;margin:6px 0;background:#0e192b;color:white;border:1px solid #34435b;border-radius:9px;font-size:15px}
textarea{min-height:85px;resize:vertical}
button{padding:11px 14px;border:0;border-radius:9px;background:#16865d;color:white;font-weight:bold;cursor:pointer;margin:4px 0}
button.secondary{background:#35465f}
button.danger{background:#a83242}
button.warning{background:#9a681b}
button.small{padding:7px 10px;font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px}
.stat{background:#22334d;padding:14px;border-radius:11px}
.stat b{font-size:22px;display:block;margin-top:7px}
.tabs{display:flex;gap:7px;overflow-x:auto;padding:8px 0}
.tabs button{white-space:nowrap;background:#253750}
.tabs button.active{background:#16865d}
.page{display:none}
.page.active{display:block}
.item{background:#0e192b;border:1px solid #34435b;border-radius:10px;padding:12px;margin:8px 0;overflow-wrap:anywhere}
.item button{margin-top:8px}
.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.row>*{flex:1}
.pill{display:inline-block;padding:5px 9px;background:#263a55;border-radius:20px;font-size:12px}
.ok{color:#4bdb9a}
.bad{color:#ff8585}
label{display:block;margin-top:8px}
input[type=checkbox]{width:auto}
#panel{display:none}
#login{max-width:450px;margin:50px auto}
#qrImage{max-width:260px;width:100%;background:white;padding:8px;border-radius:10px}
pre{white-space:pre-wrap;overflow-wrap:anywhere}
</style>
</head>
<body>
<main>
<header>
<h1>🤖 FAHAD BOT PRO</h1>
<small>لوحة التحكم المركزية • إدارة البوت والذكاء الاصطناعي والحماية</small>
</header>

<section id="login">
<h2>🔐 تسجيل دخول المالك</h2>
<input id="password" type="password" placeholder="كلمة مرور الداشبورد">
<button onclick="login()">دخول آمن</button>
<p id="loginError" class="bad"></p>
</section>

<div id="panel">

<div class="tabs">
<button class="active" onclick="showPage('home',this)">الرئيسية</button>
<button onclick="showPage('users',this)">المستخدمون</button>
<button onclick="showPage('security',this)">الحماية</button>
<button onclick="showPage('replies',this)">الردود</button>
<button onclick="showPage('ai',this)">الذكاء الاصطناعي</button>
<button onclick="showPage('messages',this)">الرسائل</button>
<button onclick="showPage('schedule',this)">الجدولة</button>
<button onclick="showPage('logs',this)">السجل</button>
<button onclick="showPage('settings',this)">الإعدادات</button>
</div>

<div id="home" class="page active">
<section>
<h2>📊 نظرة عامة</h2>
<div class="grid">
<div class="stat">اتصال واتساب<b id="wa">...</b></div>
<div class="stat">حالة البوت<b id="botState">...</b></div>
<div class="stat">رسائل مستلمة<b id="incoming">0</b></div>
<div class="stat">رسائل مرسلة<b id="sent">0</b></div>
<div class="stat">ردود AI<b id="aiCount">0</b></div>
<div class="stat">المستخدمون<b id="contactCount">0</b></div>
<div class="stat">المحظورون<b id="blockedCount">0</b></div>
</div>
<div class="row">
<button onclick="refresh()">تحديث البيانات</button>
<button class="danger" onclick="control(false)">إيقاف البوت</button>
<button onclick="control(true)">تشغيل البوت</button>
</div>
<p id="error" class="bad"></p>
</section>

<section>
<h2>📷 ربط واتساب</h2>
<button onclick="loadQR()">عرض رمز QR</button>
<p id="qrStatus" class="muted">اضغط لعرض رمز الربط.</p>
<img id="qrImage" hidden>
</section>
</div>

<div id="users" class="page">
<section>
<h2>👥 المستخدمون</h2>
<input id="userSearch" placeholder="ابحث برقم المستخدم..." oninput="renderUsers()">
<div id="usersList"></div>
</section>
<section>
<h2>إدارة مستخدم برقم الهاتف</h2>
<input id="managePhone" placeholder="رقم الهاتف مع مفتاح الدولة">
<div class="row">
<button class="danger" onclick="userAction('block')">حظر داخلي</button>
<button onclick="userAction('unblock')">فك الحظر</button>
<button class="warning" onclick="userAction('mute')">كتم</button>
<button onclick="userAction('unmute')">فك الكتم</button>
</div>
</section>
</div>

<div id="security" class="page">
<section>
<h2>🛡️ إعدادات الحماية</h2>
<label><input type="checkbox" id="antiSpam"> مكافحة تكرار الرسائل</label>
<label><input type="checkbox" id="blockOnBannedWord"> حظر مباشر عند استخدام كلمة ممنوعة</label>
<label>عدد التحذيرات قبل الحظر</label>
<input id="warningLimit" type="number" min="1" max="20">
<button onclick="saveSecurity()">حفظ الحماية</button>
</section>

<section>
<h2>🚫 الكلمات والعبارات الممنوعة</h2>
<input id="bannedInput" placeholder="اكتب كلمة أو عبارة ممنوعة">
<button onclick="addBanned()">إضافة كلمة ممنوعة</button>
<div id="bannedList"></div>
</section>
</div>

<div id="replies" class="page">
<section>
<h2>💬 الردود التلقائية المخصصة</h2>
<p class="muted">الرد المخصص له أولوية قبل الذكاء الاصطناعي. اختر مطابقة العبارة كاملة أو وجودها داخل الرسالة.</p>
<input id="replyId" type="hidden">
<input id="trigger" placeholder="الكلمة أو العبارة">
<textarea id="replyText" placeholder="الرد الذي سيرسله البوت"></textarea>
<select id="replyMatch">
<option value="contains">إذا كانت العبارة موجودة داخل الرسالة</option>
<option value="exact">إذا كانت الرسالة مطابقة تماماً</option>
</select>
<label><input type="checkbox" id="replyEnabled" checked> تفعيل هذا الرد</label>
<button onclick="saveReply()">حفظ الرد</button>
<button class="secondary" onclick="clearReplyForm()">إلغاء التعديل</button>
<div id="replyList"></div>
</section>
</div>

<div id="ai" class="page">
<section>
<h2>🧠 إعدادات الذكاء الاصطناعي</h2>
<label><input type="checkbox" id="aiEnabled"> تفعيل Gemini</label>
<label><input type="checkbox" id="autoReply"> تفعيل الرد التلقائي</label>
<input id="replyStyle" placeholder="أسلوب الرد">
<textarea id="instructions" placeholder="تعليمات إضافية للشخصية وطريقة الكلام"></textarea>
<button onclick="saveAI()">حفظ الإعدادات</button>
</section>
<section>
<h2>اختبار الذكاء الاصطناعي</h2>
<textarea id="testPrompt" placeholder="اكتب سؤالاً للتجربة"></textarea>
<button onclick="testAI()">اختبار</button>
<pre id="testResult"></pre>
</section>
</div>

<div id="messages" class="page">
<section>
<h2>✉️ إرسال رسالة</h2>
<input id="sendPhone" placeholder="رقم المستلم مع مفتاح الدولة">
<textarea id="sendMessage" placeholder="نص الرسالة"></textarea>
<button onclick="sendNow()">إرسال الآن</button>
</section>
</div>

<div id="schedule" class="page">
<section>
<h2>🕒 جدولة الرسائل</h2>
<input id="jobPhone" placeholder="رقم المستلم">
<textarea id="jobMessage" placeholder="نص الرسالة">
</textarea>
<label>وقت الإرسال</label>
<input id="jobTime" type="datetime-local">
<button onclick="addJob()">حفظ الجدولة</button>
<div id="jobsList"></div>
</section>
</div>

<div id="logs" class="page">
<section>
<h2>📜 سجل العمليات</h2>
<button class="secondary" onclick="loadLogs()">تحديث السجل</button>
<div id="logsList"></div>
</section>
</div>

<div id="settings" class="page">
<section>
<h2>⚙️ إعدادات البوت</h2>
<p>حالة الاتصال: <b id="settingsConnection">...</b></p>
<p>حالة التشغيل: <b id="settingsEnabled">...</b></p>
<button onclick="loadQR()">تحديث QR</button>
<button class="danger" onclick="logout()">تسجيل الخروج من الداشبورد</button>
</section>
</div>

</div>
</main>

<script>
let token = sessionStorage.getItem("botToken") || "";
let cached = {};

function showPage(id, button) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".tabs button").forEach(b => b.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  button.classList.add("active");
}

async function api(url, method="GET", body) {
  const response = await fetch(url, {
    method,
    headers: {
      "Content-Type":"application/json",
      "Authorization":"Bearer " + token
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const result = await response.json().catch(()=>({}));

  if (!response.ok) {
    if (response.status === 401) logout();
    throw new Error(result.error || "حدث خطأ");
  }

  return result;
}

async function login() {
  try {
    const response = await fetch("/api/login", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        password:document.getElementById("password").value
      })
    });

    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "فشل الدخول");

    token = result.token;
    sessionStorage.setItem("botToken", token);

    document.getElementById("login").style.display = "none";
    document.getElementById("panel").style.display = "block";

    await refresh();
  } catch(e) {
    document.getElementById("loginError").textContent = e.message;
  }
}

function logout() {
  token = "";
  sessionStorage.removeItem("botToken");
  location.reload();
}

function textNode(parent, text) {
  const el = document.createElement("div");
  el.textContent = String(text ?? "");
  parent.appendChild(el);
  return el;
}

function makeButton(label, action, style="small") {
  const b = document.createElement("button");
  b.textContent = label;
  b.className = style;
  b.onclick = action;
  return b;
}

async function refresh() {
  try {
    const result = await api("/api/dashboard");
    cached = result;

    document.getElementById("wa").textContent =
      result.connected ? "متصل 🟢" : "غير متصل 🔴";

    document.getElementById("botState").textContent =
      result.botEnabled ? "يعمل 🟢" : "متوقف 🔴";

    document.getElementById("incoming").textContent = result.stats.incoming;
    document.getElementById("sent").textContent = result.stats.sent;
    document.getElementById("aiCount").textContent = result.stats.ai;
    document.getElementById("contactCount").textContent = result.contacts.length;
    document.getElementById("blockedCount").textContent = result.blocked.length;
    document.getElementById("error").textContent = result.lastError || "";

    document.getElementById("settingsConnection").textContent =
      result.connected ? "متصل" : "غير متصل";

    document.getElementById("settingsEnabled").textContent =
      result.botEnabled ? "يعمل" : "متوقف";

    document.getElementById("antiSpam").checked = result.settings.antiSpam;
    document.getElementById("blockOnBannedWord").checked = result.settings.blockOnBannedWord;
    document.getElementById("warningLimit").value = result.settings.warningLimit;

    document.getElementById("aiEnabled").checked = result.settings.aiEnabled;
    document.getElementById("autoReply").checked = result.settings.autoReply;
    document.getElementById("replyStyle").value = result.settings.replyStyle || "";
    document.getElementById("instructions").value = result.settings.customInstructions || "";

    renderUsers();
    renderReplies();
    renderBanned();
    renderJobs(result.jobs);
    loadLogs();
  } catch(e) {
    document.getElementById("error").textContent = e.message;
  }
}

async function control(enabled) {
  try {
    await api("/api/control","POST",{enabled});
    await refresh();
  } catch(e) { alert(e.message); }
}

async function loadQR() {
  try {
    const result = await api("/api/qr");
    const image = document.getElementById("qrImage");

    if (result.connected) {
      image.hidden = true;
      document.getElementById("qrStatus").textContent = "واتساب متصل بالفعل 🟢";
    } else if (result.qr) {
      image.src = result.qr;
      image.hidden = false;
      document.getElementById("qrStatus").textContent =
        "امسح الرمز من واتساب ← الأجهزة المرتبطة ← ربط جهاز";
    } else {
      image.hidden = true;
      document.getElementById("qrStatus").textContent =
        "لم يصدر رمز QR بعد. انتظر قليلاً ثم حدّث.";
    }
  } catch(e) { alert(e.message); }
}

async function userAction(action) {
  const phone = document.getElementById("managePhone").value;
  try {
    await api("/api/user-action","POST",{phone,action});
    alert("تم تنفيذ العملية");
    await refresh();
  } catch(e) { alert(e.message); }
}

function renderUsers() {
  const list = document.getElementById("usersList");
  list.replaceChildren();

  const query = (document.getElementById("userSearch").value || "").replace(/\D/g,"");
  const users = (cached.contacts || []).filter(c => c.phone.includes(query)).slice().reverse();

  users.forEach(user => {
    const box = document.createElement("div");
    box.className = "item";

    textNode(box, user.name || "مستخدم");
    textNode(box, user.phone);
    textNode(box, "الرسائل: " + user.messages);

    const status = [];
    if ((cached.blocked || []).includes(user.phone)) status.push("محظور");
    if ((cached.muted || []).includes(user.phone)) status.push("مكتوم");
    textNode(box, status.join(" • ") || "نشط");

    box.appendChild(makeButton("حظر",()=>quickUser(user.phone,"block"),"danger small"));
    box.appendChild(makeButton("فك الحظر",()=>quickUser(user.phone,"unblock")));
    box.appendChild(makeButton("كتم",()=>quickUser(user.phone,"mute"),"warning small"));
    box.appendChild(makeButton("فك الكتم",()=>quickUser(user.phone,"unmute")));

    list.appendChild(box);
  });

  if (!users.length) textNode(list, "لا توجد نتائج.");
}

async function quickUser(phone, action) {
  try {
    await api("/api/user-action","POST",{phone,action});
    await refresh();
  } catch(e) { alert(e.message); }
}

function clearReplyForm() {
  document.getElementById("replyId").value = "";
  document.getElementById("trigger").value = "";
  document.getElementById("replyText").value = "";
  document.getElementById("replyMatch").value = "contains";
  document.getElementById("replyEnabled").checked = true;
}

async function saveReply() {
  try {
    await api("/api/replies","POST",{
      id:document.getElementById("replyId").value,
      trigger:document.getElementById("trigger").value,
      reply:document.getElementById("replyText").value,
      match:document.getElementById("replyMatch").value,
      enabled:document.getElementById("replyEnabled").checked
    });

    clearReplyForm();
    await refresh();
    alert("تم حفظ الرد");
  } catch(e) { alert(e.message); }
}

function renderReplies() {
  const list = document.getElementById("replyList");
  list.replaceChildren();

  (cached.replies || []).forEach(reply => {
    const box = document.createElement("div");
    box.className = "item";

    textNode(box, "الكلمة: " + reply.trigger);
    textNode(box, "الرد: " + reply.reply);
    textNode(box, "المطابقة: " + (reply.match === "exact" ? "مطابقة كاملة" : "داخل الرسالة"));
    textNode(box, reply.enabled ? "مفعّل" : "متوقف");

    box.appendChild(makeButton("تعديل",()=>{
      document.getElementById("replyId").value = reply.id;
      document.getElementById("trigger").value = reply.trigger;
      document.getElementById("replyText").value = reply.reply;
      document.getElementById("replyMatch").value = reply.match || "contains";
      document.getElementById("replyEnabled").checked = reply.enabled !== false;
      window.scrollTo(0,0);
    }));

    box.appendChild(makeButton("حذف",()=>deleteReply(reply.id),"danger small"));
    list.appendChild(box);
  });

  if (!(cached.replies || []).length) textNode(list,"لم تضف أي رد حتى الآن.");
}

async function deleteReply(id) {
  if (!confirm("تأكيد حذف الرد؟")) return;
  try {
    await api("/api/replies/delete","POST",{id});
    await refresh();
  } catch(e) { alert(e.message); }
}

async function addBanned() {
  try {
    await api("/api/banned","POST",{
      word:document.getElementById("bannedInput").value
    });
    document.getElementById("bannedInput").value = "";
    await refresh();
  } catch(e) { alert(e.message); }
}

function renderBanned() {
  const list = document.getElementById("bannedList");
  list.replaceChildren();

  (cached.bannedWords || []).forEach(item => {
    const box = document.createElement("div");
    box.className = "item";
    textNode(box,item.word);

    box.appendChild(makeButton("حذف",()=>deleteBanned(item.id),"danger small"));
    list.appendChild(box);
  });
}

async function deleteBanned(id) {
  try {
    await api("/api/banned/delete","POST",{id});
    await refresh();
  } catch(e) { alert(e.message); }
}

async function saveSecurity() {
  try {
    await api("/api/security","POST",{
      antiSpam:document.getElementById("antiSpam").checked,
      blockOnBannedWord:document.getElementById("blockOnBannedWord").checked,
      warningLimit:Number(document.getElementById("warningLimit").value)
    });
    alert("تم حفظ الحماية");
  } catch(e) { alert(e.message); }
}

async function saveAI() {
  try {
    await api("/api/ai-settings","POST",{
      aiEnabled:document.getElementById("aiEnabled").checked,
      autoReply:document.getElementById("autoReply").checked,
      replyStyle:document.getElementById("replyStyle").value,
      customInstructions:document.getElementById("instructions").value
    });
    alert("تم حفظ إعدادات الذكاء الاصطناعي");
  } catch(e) { alert(e.message); }
}

async function testAI() {
  try {
    const result = await api("/api/ai-test","POST",{
      text:document.getElementById("testPrompt").value
    });
    document.getElementById("testResult").textContent = result.answer;
  } catch(e) {
    document.getElementById("testResult").textContent = e.message;
  }
}

async function sendNow() {
  try {
    await api("/api/send","POST",{
      phone:document.getElementById("sendPhone").value,
      message:document.getElementById("sendMessage").value
    });
    alert("تم إرسال الرسالة");
  } catch(e) { alert(e.message); }
}

async function addJob() {
  try {
    await api("/api/schedule","POST",{
      phone:document.getElementById("jobPhone").value,
      message:document.getElementById("jobMessage").value,
      sendAt:document.getElementById("jobTime").value
    });

    alert("تمت جدولة الرسالة");
    await refresh();
  } catch(e) { alert(e.message); }
}

function renderJobs(jobs) {
  const list = document.getElementById("jobsList");
  list.replaceChildren();

  (jobs || []).slice().reverse().forEach(job => {
    const box = document.createElement("div");
    box.className = "item";

    textNode(box, job.phone);
    textNode(box, job.message);
    textNode(box, new Date(job.sendAt).toLocaleString());
    textNode(box, "الحالة: " + job.status);

    if (job.status === "pending") {
      box.appendChild(makeButton("إلغاء",()=>cancelJob(job.id),"danger small"));
    }

    list.appendChild(box);
  });

  if (!(jobs || []).length) textNode(list,"لا توجد رسائل مجدولة.");
}

async function cancelJob(id) {
  try {
    await api("/api/schedule/cancel","POST",{id});
    await refresh();
  } catch(e) { alert(e.message); }
}

async function loadLogs() {
  try {
    const result = await api("/api/logs");
    const list = document.getElementById("logsList");
    list.replaceChildren();

    result.logs.forEach(log => {
      const box = document.createElement("div");
      box.className = "item";
      textNode(box,log.type);
      textNode(box,log.details);
      textNode(box,new Date(log.time).toLocaleString());
      list.appendChild(box);
    });

    if (!result.logs.length) textNode(list,"لا توجد عمليات مسجلة.");
  } catch(e) {}
}

if (token) {
  document.getElementById("login").style.display = "none";
  document.getElementById("panel").style.display = "block";
  refresh();
}
</script>
</body>
</html>`);
});

// =============================
// API
// =============================

app.post("/api/login", loginRateLimit, (req, res) => {
  if (!DASHBOARD_PASSWORD) {
    return res.status(500).json({
      error: "أضف DASHBOARD_PASSWORD في Render"
    });
  }

  if (safeString(req.body.password, 300) !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: "كلمة المرور غير صحيحة" });
  }

  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { createdAt: Date.now() });

  res.json({ token });
});

app.get("/api/dashboard", requireLogin, (req, res) => {
  res.json({
    connected,
    botEnabled,
    lastError,
    stats,
    contacts: data.contacts,
    blocked: data.blocked,
    muted: data.muted,
    replies: data.replies,
    bannedWords: data.bannedWords,
    jobs: data.jobs,
    settings: {
      aiEnabled: data.aiEnabled,
      autoReply: data.autoReply,
      replyStyle: data.replyStyle,
      customInstructions: data.customInstructions,
      antiSpam: data.antiSpam,
      blockOnBannedWord: data.blockOnBannedWord,
      warningLimit: data.warningLimit
    }
  });
});

app.get("/api/qr", requireLogin, (req, res) => {
  res.json({ connected, qr: latestQR });
});

app.post("/api/control", requireLogin, (req, res) => {
  botEnabled = Boolean(req.body.enabled);
  logEvent("control", botEnabled ? "تشغيل البوت" : "إيقاف البوت");
  res.json({ success: true, botEnabled });
});

// إدارة المستخدمين
app.post("/api/user-action", requireLogin, (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const action = req.body.action;

    if (phone.length < 8) throw new Error("رقم الهاتف غير صحيح");

    if (action === "block") {
      if (!data.blocked.includes(phone)) data.blocked.push(phone);
    } else if (action === "unblock") {
      data.blocked = data.blocked.filter(p => p !== phone);
      delete data.warnings[phone];
    } else if (action === "mute") {
      if (!data.muted.includes(phone)) data.muted.push(phone);
    } else if (action === "unmute") {
      data.muted = data.muted.filter(p => p !== phone);
    } else {
      throw new Error("عملية غير معروفة");
    }

    saveData();
    logEvent("user-" + action, phone);

    res.json({ success: true });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// إعدادات الحماية
app.post("/api/security", requireLogin, (req, res) => {
  data.antiSpam = Boolean(req.body.antiSpam);
  data.blockOnBannedWord = Boolean(req.body.blockOnBannedWord);

  const limit = Number(req.body.warningLimit);
  data.warningLimit = Math.max(1, Math.min(20, Number.isFinite(limit) ? limit : 3));

  saveData();
  logEvent("security-settings", "تم تحديث إعدادات الحماية");

  res.json({ success: true });
});

// الكلمات الممنوعة
app.post("/api/banned", requireLogin, (req, res) => {
  const word = safeString(req.body.word, 100).trim();

  if (!word) return res.status(400).json({ error: "اكتب الكلمة أولاً" });

  if (data.bannedWords.some(w => normalizeText(w.word) === normalizeText(word))) {
    return res.status(400).json({ error: "هذه الكلمة موجودة بالفعل" });
  }

  data.bannedWords.push({
    id: crypto.randomUUID(),
    word,
    enabled: true
  });

  saveData();
  logEvent("banned-added", word);

  res.json({ success: true });
});

app.post("/api/banned/delete", requireLogin, (req, res) => {
  data.bannedWords = data.bannedWords.filter(w => w.id !== req.body.id);
  saveData();
  res.json({ success: true });
});

// الردود المخصصة
app.post("/api/replies", requireLogin, (req, res) => {
  const trigger = safeString(req.body.trigger, 150).trim();
  const reply = safeString(req.body.reply, 1500).trim();

  if (!trigger || !reply) {
    return res.status(400).json({ error: "أدخل العبارة والرد" });
  }

  const id = safeString(req.body.id, 100);

  const item = {
    id: id || crypto.randomUUID(),
    trigger,
    reply,
    match: req.body.match === "exact" ? "exact" : "contains",
    enabled: req.body.enabled !== false
  };

  const index = data.replies.findIndex(r => r.id === id && id);

  if (index >= 0) {
    data.replies[index] = item;
  } else {
    data.replies.push(item);
  }

  saveData();
  logEvent("reply-saved", trigger);

  res.json({ success: true, reply: item });
});

app.post("/api/replies/delete", requireLogin, (req, res) => {
  data.replies = data.replies.filter(r => r.id !== req.body.id);
  saveData();
  logEvent("reply-deleted", req.body.id);
  res.json({ success: true });
});

// إعدادات الذكاء الاصطناعي
app.post("/api/ai-settings", requireLogin, (req, res) => {
  data.aiEnabled = Boolean(req.body.aiEnabled);
  data.autoReply = Boolean(req.body.autoReply);
  data.replyStyle = safeString(req.body.replyStyle, 500);
  data.customInstructions = safeString(req.body.customInstructions, 3000);

  saveData();
  logEvent("ai-settings", "تم تحديث إعدادات الذكاء الاصطناعي");

  res.json({ success: true });
});

app.post("/api/ai-test", requireLogin, async (req, res) => {
  try {
    const text = safeString(req.body.text, 1000);
    if (!text.trim()) throw new Error("اكتب رسالة للاختبار");

    const answer = await askAI("dashboard-test", text);
    res.json({ answer });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// إرسال رسالة فورية
app.post("/api/send", requireLogin, async (req, res) => {
  try {
    const jid = jidFromPhone(req.body.phone);
    const message = safeString(req.body.message, 4000);

    await sendText(jid, message);
    logEvent("manual-send", normalizePhone(req.body.phone));

    res.json({ success: true });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

// جدولة الرسائل
app.post("/api/schedule", requireLogin, (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const message = safeString(req.body.message, 4000).trim();
    const sendAt = new Date(req.body.sendAt);

    if (phone.length < 8) throw new Error("رقم الهاتف غير صحيح");
    if (!message) throw new Error("اكتب الرسالة");
    if (Number.isNaN(sendAt.getTime()) || sendAt.getTime() <= Date.now()) {
      throw new Error("اختر وقتاً في المستقبل");
    }

    const job = {
      id: crypto.randomUUID(),
      phone,
      message,
      sendAt: sendAt.toISOString(),
      status: "pending"
    };

    data.jobs.push(job);
    saveData();
    logEvent("job-created", phone);

    res.json({ success: true, job });
  } catch(e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/schedule/cancel", requireLogin, (req, res) => {
  const job = data.jobs.find(j => j.id === req.body.id);

  if (!job) return res.status(404).json({ error: "الجدولة غير موجودة" });
  if (job.status !== "pending") {
    return res.status(400).json({ error: "لا يمكن إلغاء هذه الرسالة الآن" });
  }

  job.status = "cancelled";
  saveData();
  logEvent("job-cancelled", job.phone);

  res.json({ success: true });
});

app.get("/api/logs", requireLogin, (req, res) => {
  res.json({ logs: data.logs.slice(0, 200) });
});

// =============================
// تشغيل التطبيق
// =============================

loadData();

app.listen(PORT, () => {
  console.log("Dashboard running on port", PORT);
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

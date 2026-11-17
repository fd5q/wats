
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

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = "llama-3.3-70b-versatile";
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

let stats = { incoming: 0, sent: 0, ai: 0, blocked: 0 };

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

function saveData() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const temp = DATA_FILE + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(data, null, 2));
    fs.renameSync(temp, DATA_FILE);
  } catch (e) {
    lastError = e.message;
    console.error("Save error:", e.message);
  }
}

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      data = { ...data, ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) };
    }
  } catch (e) {
    console.error("Load error:", e.message);
  }

  if (!Array.isArray(data.replies)) {
    data.replies = Object.entries(data.replies || {}).map(([trigger, reply]) => ({
      id: crypto.randomUUID(), trigger, reply, enabled: true, match: "contains"
    }));
  }

  for (const key of ["contacts", "blocked", "muted", "bannedWords", "jobs", "logs"]) {
    if (!Array.isArray(data[key])) data[key] = [];
  }

  if (!data.warnings || typeof data.warnings !== "object") data.warnings = {};

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

function cleanSessions() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.createdAt > 8 * 60 * 60 * 1000) sessions.delete(token);
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
  const attempts = (loginAttempts.get(ip) || []).filter(t => now - t < 600000);

  if (attempts.length >= 10) {
    return res.status(429).json({ error: "محاولات كثيرة. انتظر عشر دقائق." });
  }

  attempts.push(now);
  loginAttempts.set(ip, attempts);
  next();
}

function rememberContact(jid, name = "") {
  const phone = jid.split("@")[0].split(":")[0];
  let contact = data.contacts.find(c => c.phone === phone);

  if (!contact) {
    contact = {
      phone, name: safeString(name, 100),
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
  return data.blocked.includes(normalizePhone(jid.split("@")[0].split(":")[0]));
}

function isMuted(jid) {
  return data.muted.includes(normalizePhone(jid.split("@")[0].split(":")[0]));
}

function findCustomReply(message) {
  const normalized = normalizeText(message);
  const replies = data.replies
    .filter(r => r.enabled !== false && r.trigger && r.reply)
    .sort((a, b) => normalizeText(b.trigger).length - normalizeText(a.trigger).length);

  for (const item of replies) {
    const trigger = normalizeText(item.trigger);
    if (!trigger) continue;
    if (item.match === "exact" && normalized === trigger) return item;
    if (item.match !== "exact" && normalized.includes(trigger)) return item;
  }
  return null;
}

// Groq AI
async function askAI(jid, userText) {
  if (!GROQ_API_KEY) {
    throw new Error("مفتاح Groq غير موجود في Render. أضف GROQ_API_KEY");
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

  const messages = [
    { role: "system", content: systemPrompt },
    ...history.slice(-12).map(item => ({
      role: item.role === "model" ? "assistant" : item.role,
      content: item.text
    })),
    { role: "user", content: userText }
  ];

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: 0.8,
      max_tokens: 700
    })
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error?.message || "خطأ في الاتصال بـ Groq");
  }

  const answer = result.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new Error("لم يصل رد من Groq");

  conversations.set(jid, [
    ...history,
    { role: "user", text: userText },
    { role: "model", text: answer }
  ].slice(-16));

  stats.ai++;
  return answer;
}

async function sendText(jid, text) {
  if (!sock || !connected) throw new Error("واتساب غير متصل");
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

  if (isBlocked(jid)) {
    stats.blocked++;
    return;
  }

  if (data.antiSpam) {
    const now = Date.now();
    const normalized = normalizeText(input);
    const previous = lastMessages.get(jid);

    if (previous && previous.text === normalized && now - previous.time < 15000) return;

    lastMessages.set(jid, { text: normalized, time: now });

    const recent = (messageTimes.get(jid) || []).filter(t => now - t < 60000);
    if (recent.length >= 8) {
      logEvent("anti-spam", "تم تجاهل رسائل متكررة من " + phone);
      return;
    }
    recent.push(now);
    messageTimes.set(jid, recent);
  }

  const banned = data.bannedWords.find(w =>
    w.enabled !== false && matchesPhrase(input, w.word)
  );

  if (banned) {
    const count = (data.warnings[phone] || 0) + 1;
    data.warnings[phone] = count;
    logEvent("banned-word", phone + " استخدم كلمة ممنوعة");

    if (data.blockOnBannedWord || count >= data.warningLimit) {
      if (!data.blocked.includes(phone)) data.blocked.push(phone);
      saveData();
      await sendText(jid, "تم إيقاف تفاعلك مع البوت بسبب مخالفة قواعد المحادثة.");
      logEvent("blocked", "حظر داخلي للرقم " + phone);
      return;
    }

    saveData();
    await sendText(jid, `⚠️ تنبيه: استخدمت عبارة ممنوعة. التحذير ${count} من ${data.warningLimit}.`);
    return;
  }

  if (isMuted(jid) || !botEnabled || !data.autoReply) return;

  const custom = findCustomReply(input);
  if (custom) {
    await sendText(jid, custom.reply);
    logEvent("custom-reply", "رد مخصص إلى " + phone);
    return;
  }

  if (data.aiEnabled) {
    try {
      const answer = await askAI(jid, input);
      await sendText(jid, answer);
      logEvent("ai-reply", "Groq رد على " + phone);
    } catch (e) {
      lastError = e.message;
      logEvent("ai-error", e.message);
      console.error("AI error:", e.message);
    }
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
          lastError = "تم تسجيل الخروج من واتساب. تحتاج QR جديد.";
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

async function processJobs() {
  if (!connected || !sock || processingJobs) return;
  processingJobs = true;

  try {
    const now = Date.now();
    for (const job of data.jobs) {
      if (job.status !== "pending" || new Date(job.sendAt).getTime() > now) continue;

      job.status = "sending";
      saveData();

      try {
        await sendText(jidFromPhone(job.phone), job.message);
        job.status = "sent";
        job.sentAt = new Date().toISOString();
        logEvent("scheduled-sent", "إرسال مجدول إلى " + job.phone);
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

// الداشبورد
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
header,section{background:#172338;padding:17px;border-radius:14px;margin:13px 0}
h1{margin:0 0 8px;font-size:23px}
h2{font-size:18px}
small,.muted{color:#aab8cc}
input,textarea,select{width:100%;padding:12px;margin:6px 0;background:#0e192b;color:white;border:1px solid #34435b;border-radius:9px;font-size:15px}
textarea{min-height:85px}
button{padding:11px 14px;border:0;border-radius:9px;background:#16865d;color:white;font-weight:bold;cursor:pointer;margin:4px 0}
button.secondary{background:#35465f}
button.danger{background:#a83242}
button.warning{background:#9a681b}
button.small{padding:7px 10px;font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px}
.stat,.item{background:#22334d;padding:14px;border-radius:11px;margin:8px 0;overflow-wrap:anywhere}
.stat b{font-size:22px;display:block;margin-top:7px}
.tabs{display:flex;gap:7px;overflow-x:auto;padding:8px 0}
.tabs button{white-space:nowrap;background:#253750}
.tabs button.active{background:#16865d}
.page{display:none}
.page.active{display:block}
.row{display:flex;gap:8px;flex-wrap:wrap}
.row>*{flex:1}
#panel{display:none}
#login{max-width:450px;margin:50px auto}
#qrImage{max-width:260px;width:100%;background:white;padding:8px;border-radius:10px}
pre{white-space:pre-wrap;overflow-wrap:anywhere}
</style>
</head>
<body><main>
<header><h1>🤖 FAHAD BOT PRO</h1><small>لوحة التحكم المركزية</small></header>
<section id="login"><h2>🔐 دخول المالك</h2>
<input id="password" type="password" placeholder="كلمة مرور الداشبورد">
<button onclick="login()">دخول</button><p id="loginError"></p></section>

<div id="panel">
<div class="tabs">
<button class="active" onclick="showPage('home',this)">الرئيسية</button>
<button onclick="showPage('users',this)">المستخدمون</button>
<button onclick="showPage('security',this)">الحماية</button>
<button onclick="showPage('replies',this)">الردود</button>
<button onclick="showPage('ai',this)">Groq AI</button>
<button onclick="showPage('messages',this)">الرسائل</button>
<button onclick="showPage('schedule',this)">الجدولة</button>
<button onclick="showPage('logs',this)">السجل</button>
<button onclick="showPage('settings',this)">الإعدادات</button>
</div>

<div id="home" class="page active">
<section><h2>📊 نظرة عامة</h2><div class="grid">
<div class="stat">واتساب<b id="wa">...</b></div>
<div class="stat">البوت<b id="botState">...</b></div>
<div class="stat">مستلمة<b id="incoming">0</b></div>
<div class="stat">مرسلة<b id="sent">0</b></div>
<div class="stat">ردود AI<b id="aiCount">0</b></div>
<div class="stat">المستخدمون<b id="contactCount">0</b></div>
<div class="stat">المحظورون<b id="blockedCount">0</b></div>
</div>
<div class="row">
<button onclick="refresh()">تحديث</button>
<button class="danger" onclick="control(false)">إيقاف البوت</button>
<button onclick="control(true)">تشغيل البوت</button>
</div><p id="error"></p></section>
<section><h2>📷 ربط واتساب</h2><button onclick="loadQR()">عرض QR</button>
<p id="qrStatus">اضغط لعرض الرمز</p><img id="qrImage" hidden></section>
</div>

<div id="users" class="page"><section><h2>👥 المستخدمون</h2>
<input id="userSearch" placeholder="ابحث برقم المستخدم" oninput="renderUsers()"><div id="usersList"></div></section>
<section><h2>إدارة مستخدم</h2><input id="managePhone" placeholder="رقم الهاتف مع مفتاح الدولة">
<div class="row"><button class="danger" onclick="userAction('block')">حظر داخلي</button>
<button onclick="userAction('unblock')">فك الحظر</button>
<button class="warning" onclick="userAction('mute')">كتم</button>
<button onclick="userAction('unmute')">فك الكتم</button></div></section></div>

<div id="security" class="page"><section><h2>🛡️ الحماية</h2>
<label><input type="checkbox" id="antiSpam"> مكافحة التكرار</label>
<label><input type="checkbox" id="blockOnBannedWord"> حظر مباشر عند كلمة ممنوعة</label>
<label>عدد التحذيرات</label><input id="warningLimit" type="number" min="1" max="20">
<button onclick="saveSecurity()">حفظ الحماية</button></section>
<section><h2>🚫 الكلمات الممنوعة</h2><input id="bannedInput" placeholder="كلمة ممنوعة">
<button onclick="addBanned()">إضافة</button><div id="bannedList"></div></section></div>

<div id="replies" class="page"><section><h2>💬 الردود المخصصة</h2>
<input id="replyId" type="hidden"><input id="trigger" placeholder="الكلمة أو العبارة">
<textarea id="replyText" placeholder="الرد"></textarea>
<select id="replyMatch"><option value="contains">موجودة داخل الرسالة</option><option value="exact">مطابقة كاملة</option></select>
<label><input type="checkbox" id="replyEnabled" checked> تفعيل الرد</label>
<button onclick="saveReply()">حفظ الرد</button><button class="secondary" onclick="clearReplyForm()">إلغاء التعديل</button>
<div id="replyList"></div></section></div>

<div id="ai" class="page"><section><h2>🧠 Groq AI</h2>
<label><input type="checkbox" id="aiEnabled"> تفعيل Groq AI</label>
<label><input type="checkbox" id="autoReply"> تفعيل الرد التلقائي</label>
<input id="replyStyle" placeholder="أسلوب الرد">
<textarea id="instructions" placeholder="تعليمات إضافية"></textarea>
<button onclick="saveAI()">حفظ الإعدادات</button></section>
<section><h2>اختبار الذكاء الاصطناعي</h2>
<textarea id="testPrompt" placeholder="اكتب سؤالاً"></textarea><button onclick="testAI()">اختبار</button><pre id="testResult"></pre></section></div>

<div id="messages" class="page"><section><h2>✉️ إرسال رسالة</h2>
<input id="sendPhone" placeholder="رقم المستلم مع مفتاح الدولة">
<textarea id="sendMessage" placeholder="نص الرسالة"></textarea><button onclick="sendNow()">إرسال الآن</button></section></div>

<div id="schedule" class="page"><section><h2>🕒 جدولة الرسائل</h2>
<input id="jobPhone" placeholder="رقم المستلم"><textarea id="jobMessage" placeholder="نص الرسالة"></textarea>
<label>وقت الإرسال</label><input id="jobTime" type="datetime-local">
<button onclick="addJob()">حفظ الجدولة</button><div id="jobsList"></div></section></div>

<div id="logs" class="page"><section><h2>📜 سجل العمليات</h2><button onclick="loadLogs()">تحديث السجل</button><div id="logsList"></div></section></div>

<div id="settings" class="page"><section><h2>⚙️ الإعدادات</h2>
<p>اتصال واتساب: <b id="settingsConnection"></b></p>
<p>حالة التشغيل: <b id="settingsEnabled"></b></p>
<button onclick="loadQR()">تحديث QR</button><button class="danger" onclick="logout()">تسجيل الخروج</button>
</section></div>
</div></main>

<script>
let token=sessionStorage.getItem("botToken")||"",cached={};
function showPage(id,b){
 document.querySelectorAll(".page").forEach(p=>p.classList.remove("active"));
 document.querySelectorAll(".tabs button").forEach(x=>x.classList.remove("active"));
 document.getElementById(id).classList.add("active");b.classList.add("active");
}
async function api(url,method="GET",body){
 const r=await fetch(url,{method,headers:{"Content-Type":"application/json","Authorization":"Bearer "+token},body:body===undefined?undefined:JSON.stringify(body)});
 const d=await r.json().catch(()=>({}));
 if(!r.ok){if(r.status===401)logout();throw new Error(d.error||"حدث خطأ");}return d;
}
async function login(){
 try{
  const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:document.getElementById("password").value})});
  const d=await r.json();if(!r.ok)throw Error(d.error||"فشل الدخول");
  token=d.token;sessionStorage.setItem("botToken",token);
  document.getElementById("login").style.display="none";document.getElementById("panel").style.display="block";await refresh();
 }catch(e){document.getElementById("loginError").textContent=e.message;}
}
function logout(){token="";sessionStorage.removeItem("botToken");location.reload();}
function node(parent,text){let e=document.createElement("div");e.textContent=String(text??"");parent.appendChild(e);return e;}
function btn(label,action,style="small"){let b=document.createElement("button");b.textContent=label;b.className=style;b.onclick=action;return b;}
async function refresh(){
 try{
  const r=await api("/api/dashboard");cached=r;
  wa.textContent=r.connected?"متصل 🟢":"غير متصل 🔴";
  botState.textContent=r.botEnabled?"يعمل 🟢":"متوقف 🔴";
  incoming.textContent=r.stats.incoming;sent.textContent=r.stats.sent;aiCount.textContent=r.stats.ai;
  contactCount.textContent=r.contacts.length;blockedCount.textContent=r.blocked.length;
  error.textContent=r.lastError||"";
  settingsConnection.textContent=r.connected?"متصل":"غير متصل";
  settingsEnabled.textContent=r.botEnabled?"يعمل":"متوقف";
  antiSpam.checked=r.settings.antiSpam;blockOnBannedWord.checked=r.settings.blockOnBannedWord;
  warningLimit.value=r.settings.warningLimit;
  aiEnabled.checked=r.settings.aiEnabled;autoReply.checked=r.settings.autoReply;
  replyStyle.value=r.settings.replyStyle||"";instructions.value=r.settings.customInstructions||"";
  renderUsers();renderReplies();renderBanned();renderJobs(r.jobs);loadLogs();
 }catch(e){document.getElementById("error").textContent=e.message;}
}
async function control(enabled){try{await api("/api/control","POST",{enabled});await refresh();}catch(e){alert(e.message);}}
async function loadQR(){
 try{
  const r=await api("/api/qr"),img=document.getElementById("qrImage");
  if(r.connected){img.hidden=true;qrStatus.textContent="واتساب متصل 🟢";}
  else if(r.qr){img.src=r.qr;img.hidden=false;qrStatus.textContent="امسح الرمز من واتساب ← الأجهزة المرتبطة ← ربط جهاز";}
  else{img.hidden=true;qrStatus.textContent="لم يصدر QR بعد، انتظر قليلاً وحدّث.";}
 }catch(e){alert(e.message);}
}
async function userAction(action){try{await api("/api/user-action","POST",{phone:managePhone.value,action});alert("تم");await refresh();}catch(e){alert(e.message);}}
function renderUsers(){
 const list=usersList;list.replaceChildren();const q=(userSearch.value||"").replace(/\D/g,"");
 const users=(cached.contacts||[]).filter(c=>c.phone.includes(q)).slice().reverse();
 users.forEach(u=>{
  const box=document.createElement("div");box.className="item";
  node(box,u.name||"مستخدم");node(box,u.phone);node(box,"الرسائل: "+u.messages);
  node(box,(cached.blocked||[]).includes(u.phone)?"محظور":(cached.muted||[]).includes(u.phone)?"مكتوم":"نشط");
  box.append(btn("حظر",()=>quickUser(u.phone,"block"),"danger small"));
  box.append(btn("فك الحظر",()=>quickUser(u.phone,"unblock")));
  box.append(btn("كتم",()=>quickUser(u.phone,"mute"),"warning small"));
  box.append(btn("فك الكتم",()=>quickUser(u.phone,"unmute")));list.append(box);
 });
 if(!users.length)node(list,"لا توجد نتائج.");
}
async function quickUser(phone,action){try{await api("/api/user-action","POST",{phone,action});await refresh();}catch(e){alert(e.message);}}
function clearReplyForm(){replyId.value="";trigger.value="";replyText.value="";replyMatch.value="contains";replyEnabled.checked=true;}
async function saveReply(){
 try{await api("/api/replies","POST",{id:replyId.value,trigger:trigger.value,reply:replyText.value,match:replyMatch.value,enabled:replyEnabled.checked});clearReplyForm();await refresh();alert("تم حفظ الرد");}
 catch(e){alert(e.message);}
}
function renderReplies(){
 replyList.replaceChildren();
 (cached.replies||[]).forEach(r=>{
  const box=document.createElement("div");box.className="item";
  node(box,"الكلمة: "+r.trigger);node(box,"الرد: "+r.reply);
  node(box,"المطابقة: "+(r.match==="exact"?"مطابقة كاملة":"داخل الرسالة"));
  node(box,r.enabled?"مفعّل":"متوقف");
  box.append(btn("تعديل",()=>{replyId.value=r.id;trigger.value=r.trigger;replyText.value=r.reply;replyMatch.value=r.match||"contains";replyEnabled.checked=r.enabled!==false;}));
  box.append(btn("حذف",()=>deleteReply(r.id),"danger small"));replyList.append(box);
 });
 if(!(cached.replies||[]).length)node(replyList,"لم تضف أي رد.");
}
async function deleteReply(id){if(!confirm("تأكيد حذف الرد؟"))return;try{await api("/api/replies/delete","POST",{id});await refresh();}catch(e){alert(e.message);}}
async function addBanned(){try{await api("/api/banned","POST",{word:bannedInput.value});bannedInput.value="";await refresh();}catch(e){alert(e.message);}}
function renderBanned(){
 bannedList.replaceChildren();
 (cached.bannedWords||[]).forEach(w=>{const box=document.createElement("div");box.className="item";node(box,w.word);box.append(btn("حذف",()=>deleteBanned(w.id),"danger small"));bannedList.append(box);});
}
async function deleteBanned(id){try{await api("/api/banned/delete","POST",{id});await refresh();}catch(e){alert(e.message);}}
async function saveSecurity(){try{await api("/api/security","POST",{antiSpam:antiSpam.checked,blockOnBannedWord:blockOnBannedWord.checked,warningLimit:Number(warningLimit.value)});alert("تم الحفظ");}catch(e){alert(e.message);}}
async function saveAI(){try{await api("/api/ai-settings","POST",{aiEnabled:aiEnabled.checked,autoReply:autoReply.checked,replyStyle:replyStyle.value,customInstructions:instructions.value});alert("تم الحفظ");}catch(e){alert(e.message);}}
async function testAI(){try{const r=await api("/api/ai-test","POST",{text:testPrompt.value});testResult.textContent=r.answer;}catch(e){testResult.textContent=e.message;}}
async function sendNow(){try{await api("/api/send","POST",{phone:sendPhone.value,message:sendMessage.value});alert("تم إرسال الرسالة");}catch(e){alert(e.message);}}
async function addJob(){try{await api("/api/schedule","POST",{phone:jobPhone.value,message:jobMessage.value,sendAt:jobTime.value});alert("تمت الجدولة");await refresh();}catch(e){alert(e.message);}}
function renderJobs(jobs){
 jobsList.replaceChildren();
 (jobs||[]).slice().reverse().forEach(j=>{
  const box=document.createElement("div");box.className="item";
  node(box,j.phone);node(box,j.message);node(box,new Date(j.sendAt).toLocaleString());node(box,"الحالة: "+j.status);
  if(j.status==="pending")box.append(btn("إلغاء",()=>cancelJob(j.id),"danger small"));jobsList.append(box);
 });
 if(!(jobs||[]).length)node(jobsList,"لا توجد رسائل مجدولة.");
}
async function cancelJob(id){try{await api("/api/schedule/cancel","POST",{id});await refresh();}catch(e){alert(e.message);}}
async function loadLogs(){
 try{const r=await api("/api/logs");logsList.replaceChildren();r.logs.forEach(l=>{const b=document.createElement("div");b.className="item";node(b,l.type);node(b,l.details);node(b,new Date(l.time).toLocaleString());logsList.append(b);});if(!r.logs.length)node(logsList,"لا توجد عمليات.");}catch(e){}
}
if(token){login.style.display="none";panel.style.display="block";refresh();}
</script></body></html>`);
});

// API
app.post("/api/login", loginRateLimit, (req, res) => {
  if (!DASHBOARD_PASSWORD) return res.status(500).json({ error: "أضف DASHBOARD_PASSWORD في Render" });
  if (safeString(req.body.password, 300) !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: "كلمة المرور غير صحيحة" });
  }
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { createdAt: Date.now() });
  res.json({ token });
});

app.get("/api/dashboard", requireLogin, (req, res) => {
  res.json({
    connected, botEnabled, lastError, stats,
    contacts: data.contacts, blocked: data.blocked, muted: data.muted,
    replies: data.replies, bannedWords: data.bannedWords, jobs: data.jobs,
    settings: {
      aiEnabled: data.aiEnabled, autoReply: data.autoReply,
      replyStyle: data.replyStyle, customInstructions: data.customInstructions,
      antiSpam: data.antiSpam, blockOnBannedWord: data.blockOnBannedWord,
      warningLimit: data.warningLimit
    }
  });
});

app.get("/api/qr", requireLogin, (req, res) => res.json({ connected, qr: latestQR }));

app.post("/api/control", requireLogin, (req, res) => {
  botEnabled = Boolean(req.body.enabled);
  logEvent("control", botEnabled ? "تشغيل البوت" : "إيقاف البوت");
  res.json({ success: true, botEnabled });
});

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
    } else throw new Error("عملية غير معروفة");

    saveData();logEvent("user-" + action, phone);res.json({ success: true });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/security", requireLogin, (req, res) => {
  data.antiSpam = Boolean(req.body.antiSpam);
  data.blockOnBannedWord = Boolean(req.body.blockOnBannedWord);
  const limit = Number(req.body.warningLimit);
  data.warningLimit = Math.max(1, Math.min(20, Number.isFinite(limit) ? limit : 3));
  saveData();logEvent("security-settings", "تحديث الحماية");res.json({ success: true });
});

app.post("/api/banned", requireLogin, (req, res) => {
  const word = safeString(req.body.word, 100).trim();
  if (!word) return res.status(400).json({ error: "اكتب الكلمة أولاً" });
  if (data.bannedWords.some(w => normalizeText(w.word) === normalizeText(word))) {
    return res.status(400).json({ error: "الكلمة موجودة بالفعل" });
  }
  data.bannedWords.push({ id: crypto.randomUUID(), word, enabled: true });
  saveData();logEvent("banned-added", word);res.json({ success: true });
});

app.post("/api/banned/delete", requireLogin, (req, res) => {
  data.bannedWords = data.bannedWords.filter(w => w.id !== req.body.id);
  saveData();res.json({ success: true });
});

app.post("/api/replies", requireLogin, (req, res) => {
  const trigger = safeString(req.body.trigger, 150).trim();
  const reply = safeString(req.body.reply, 1500).trim();
  if (!trigger || !reply) return res.status(400).json({ error: "أدخل العبارة والرد" });

  const id = safeString(req.body.id, 100);
  const item = {
    id: id || crypto.randomUUID(), trigger, reply,
    match: req.body.match === "exact" ? "exact" : "contains",
    enabled: req.body.enabled !== false
  };
  const index = data.replies.findIndex(r => r.id === id && id);
  if (index >= 0) data.replies[index] = item;
  else data.replies.push(item);
  saveData();logEvent("reply-saved", trigger);res.json({ success: true, reply: item });
});

app.post("/api/replies/delete", requireLogin, (req, res) => {
  data.replies = data.replies.filter(r => r.id !== req.body.id);
  saveData();logEvent("reply-deleted", req.body.id);res.json({ success: true });
});

app.post("/api/ai-settings", requireLogin, (req, res) => {
  data.aiEnabled = Boolean(req.body.aiEnabled);
  data.autoReply = Boolean(req.body.autoReply);
  data.replyStyle = safeString(req.body.replyStyle, 500);
  data.customInstructions = safeString(req.body.customInstructions, 3000);
  saveData();logEvent("ai-settings", "تحديث إعدادات Groq");res.json({ success: true });
});

app.post("/api/ai-test", requireLogin, async (req, res) => {
  try {
    const text = safeString(req.body.text, 1000);
    if (!text.trim()) throw new Error("اكتب رسالة للاختبار");
    const answer = await askAI("dashboard-test", text);
    res.json({ answer });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/send", requireLogin, async (req, res) => {
  try {
    const jid = jidFromPhone(req.body.phone);
    await sendText(jid, safeString(req.body.message, 4000));
    logEvent("manual-send", normalizePhone(req.body.phone));
    res.json({ success: true });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

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
    const job = { id: crypto.randomUUID(), phone, message, sendAt: sendAt.toISOString(), status: "pending" };
    data.jobs.push(job);saveData();logEvent("job-created", phone);res.json({ success: true, job });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/schedule/cancel", requireLogin, (req, res) => {
  const job = data.jobs.find(j => j.id === req.body.id);
  if (!job) return res.status(404).json({ error: "الجدولة غير موجودة" });
  if (job.status !== "pending") return res.status(400).json({ error: "لا يمكن إلغاء هذه الرسالة الآن" });
  job.status = "cancelled";saveData();logEvent("job-cancelled", job.phone);res.json({ success: true });
});

app.get("/api/logs", requireLogin, (req, res) => res.json({ logs: data.logs.slice(0, 200) }));

loadData();

app.listen(PORT, () => console.log("Dashboard running on port", PORT));

setInterval(() => {
  processJobs().catch(e => { lastError = e.message; console.error("Scheduler error:", e); });
}, 10000);

connectWhatsApp().catch(e => { lastError = e.message; console.error(e); });

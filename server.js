/**
 * Электронный дневник: production server без внешних зависимостей.
 * Запуск: DEV_LOGIN=... DEV_PASWORD=... npm start
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* Подхват .env без сторонних библиотек.
   Переменные окружения ОС имеют приоритет над файлом .env. */
(function loadDotEnv() {
  try {
    const envFile = path.join(__dirname, '.env');
    if (!fs.existsSync(envFile)) return;
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || line.trim().startsWith('#')) continue;
      let value = m[2];
      const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
      if (quoted) value = value.slice(1, -1);
      else value = value.split(/\s+#/)[0];
      if (!(m[1] in process.env)) process.env[m[1]] = value;
    }
    console.log('Переменные из .env загружены');
  } catch (e) {
    console.error('Не удалось прочитать .env:', e.message);
  }
})();

const PORT = 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PROD = process.env.NODE_ENV === 'production';
const ROOT = __dirname;
const DB_FILE = process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : path.join(ROOT, 'data.json');
/* Логин приводим к нижнему регистру: при входе пользовательский ввод
   тоже нормализуется, иначе совпадение не случится. */
const DEV_LOGIN = String(process.env.DEV_LOGIN || '').trim().toLowerCase();
// Основной формат — DEV_PASWORD; также принимаем распространённый вариант с двумя S.
const DEV_PASSWORD = String(process.env.DEV_PASWORD || process.env.DEV_PASSWORD || '').trim();
const COOKIE = 'sd_session';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
/* Скользящая сессия: при активности срок продлевается, но не чаще раза в 12 часов. */
const SESSION_RENEW_AFTER = 12 * 60 * 60 * 1000;
const MAX_BODY = 1024 * 1024;
const CLEAN_DB_VERSION = 3;
/* Расписание «идёт само»: в базе хранится типовая неделя, а номер дня в ключах
   оценок/посещаемости/ДЗ/мероприятий — число дней от даты старта (0 = первый понедельник).
   Дату старта можно сменить переменной SCHEDULE_START=ГГГГ-ММ-ДД (приводится к понедельнику). */
const MAX_DAY = 3650;
const DAY_MS = 86400000;
const SCHEDULE_START = (function () {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(process.env.SCHEDULE_START || '2026-10-19').trim());
  let d = m ? new Date(+m[1], +m[2] - 1, +m[3], 12) : new Date(2026, 9, 19, 12);
  if (isNaN(d.getTime())) d = new Date(2026, 9, 19, 12);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
})();
const pad2 = n => String(n).padStart(2, '0');
const SCHEDULE_START_ISO = `${SCHEDULE_START.getFullYear()}-${pad2(SCHEDULE_START.getMonth() + 1)}-${pad2(SCHEDULE_START.getDate())}`;
function todayOffset() { const t = new Date(); t.setHours(12, 0, 0, 0); return Math.round((t - SCHEDULE_START) / DAY_MS); }
const weekdayOf = day => ((Number(day) % 7) + 7) % 7;

if (!DEV_LOGIN || DEV_PASSWORD.length < 12) {
  console.error('');
  console.error('ОШИБКА ЗАПУСКА: не заданы переменные окружения DEV_LOGIN / DEV_PASWORD.');
  console.error('Требования: DEV_LOGIN — латинский логин (3+ символа), DEV_PASWORD — минимум 12 символов.');
  console.error('Примеры:');
  console.error('  Windows PowerShell:  $env:DEV_LOGIN="admin"; $env:DEV_PASWORD="длинный-пароль"; npm start');
  console.error('  Linux/macOS:         DEV_LOGIN=admin DEV_PASWORD="длинный-пароль" npm start');
  console.error('  Или создайте файл .env со строками DEV_LOGIN=... и DEV_PASWORD=...');
  process.exit(1);
}

function createBlankWeek() {
  const weekdays = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
  const short = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  return weekdays.map((wd, index) => ({ wd, s: short[index], lessons: [] }));
}

const DEFAULTS = {
  version: CLEAN_DB_VERSION,
  accounts: [],
  groups: [{ id: '02-СД-25-о', name: '02-СД-25-о', specialty: 'Сестринское дело', course: 2, curatorLogin: '', starostaLogin: '', schedule: createBlankWeek(), times: {} }],
  sessions: {},
  students: [],
  times: {},
  grades: {}, att: {}, hw: {},
  ev: {},
  sch: createBlankWeek(),
  push: { subs: {}, prefs: {}, held: {} }
};

const PERMS = {
  student: { diary: 1 },
  starosta: { diary: 1, journal: 1, attendance: 1, homework: 1, schedule: 1, events: 1, times: 1 },
  teacher: { diary: 1, studio: 1, grades: 1, ownAttendance: 1, ownHomework: 1 },
  curator: { diary: 1, studio: 1, journal: 1, grades: 1, attendance: 1, homework: 1, schedule: 1, events: 1, times: 1 },
  admin: { diary: 1, journal: 1, schedule: 1, events: 1, times: 1 },
  dev: { diary: 1, studio: 1, journal: 1, plus: 1, grades: 1, attendance: 1, homework: 1, schedule: 1, events: 1, times: 1, accounts: 1 }
};
const HOME = { student: 'diary.html', starosta: 'zhurnal.html', teacher: 'studio.html', curator: 'zhurnal.html', admin: 'zhurnal.html', dev: 'STplus.html' };
const PAGE_PERM = { '/diary.html': 'diary', '/studio.html': 'studio', '/zhurnal.html': 'journal', '/STplus.html': 'plus' };

const clone = value => JSON.parse(JSON.stringify(value));
const id = () => crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const safeText = (value, max = 200) => String(value || '').trim().slice(0, max);
const safeLogin = value => safeText(value, 50).toLowerCase();
const validLogin = value => /^[a-z0-9_.-]{3,50}$/.test(value);

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(password, encoded) {
  try {
    const [kind, salt, expected] = String(encoded).split('$');
    if (kind !== 'scrypt' || !salt || !expected) return false;
    const actual = crypto.scryptSync(String(password), salt, 64);
    const target = Buffer.from(expected, 'hex');
    return actual.length === target.length && crypto.timingSafeEqual(actual, target);
  } catch (e) { return false; }
}

let DB;
function purgeSessions() {
  const now = Date.now();
  for (const [key, session] of Object.entries(DB.sessions || {})) {
    if (!session || session.expires < now || !DB.accounts.some(a => a.login === session.login)) delete DB.sessions[key];
  }
}
function readDB() {
  try { DB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { DB = clone(DEFAULTS); }
  // Одноразовая очистка всех прежних демонстрационных данных.
  // После записи version=3 последующие перезапуски больше не сбрасывают базу.
  if (Number(DB.version || 0) < CLEAN_DB_VERSION) DB = clone(DEFAULTS);
  for (const [key, value] of Object.entries(DEFAULTS)) if (DB[key] === undefined) DB[key] = clone(value);
  if (!Array.isArray(DB.accounts)) DB.accounts = [];
  if (!Array.isArray(DB.groups)) DB.groups = clone(DEFAULTS.groups);
  if (!DB.groups.length) DB.groups = clone(DEFAULTS.groups);
  for (const g of DB.groups) { if (!Array.isArray(g.schedule)) g.schedule = createBlankWeek(); if (!g.times || typeof g.times !== 'object') g.times = {}; }
  if (!DB.sessions || typeof DB.sessions !== 'object') DB.sessions = {};
  for (const account of DB.accounts) {
    if (account.pass && !account.passHash) account.passHash = hashPassword(account.pass);
    delete account.pass;
    if (!account.id) account.id = id();
  }
  DB.accounts = DB.accounts.filter(a => a.role !== 'dev');
  DB.accounts.push({ id: 'developer', fio: 'Разработчик', login: DEV_LOGIN, passHash: hashPassword(DEV_PASSWORD), role: 'dev', subj: '', group: '', studentIndex: null });
  purgeSessions();
  ensurePush();
  writeDBNow();
}
function writeDBNow() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const temp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(DB, null, 2), { mode: 0o600 });
  fs.renameSync(temp, DB_FILE);
}
function saveDB() {
  // Синхронная атомарная запись: API отвечает только после фиксации данных на диске.
  writeDBNow();
}

/* ================= PUSH-УВЕДОМЛЕНИЯ (Web Push, VAPID) =================
   Пуш отправляется БЕЗ полезной нагрузки: сервис-воркер по сигналу сам забирает
   текст уведомления с нашего сервера (POST /api/push/pending). Поэтому шифрование
   содержимого не нужно, а текст не проходит через сторонние push-сервисы. */
const https = require('https');
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
const PUSH_EXTRA_HOSTS = String(process.env.PUSH_EXTRA_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/;
const TICK_MS = Number(process.env.PUSH_TICK_MS) || 30000;
const MON_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const PREF_DEFAULTS = { schedule: true, grades: true, hw: true, events: false, quiet: true, remind: 30 };
const ROLES_STUDENT = ['student', 'starosta'];
const ROLES_ALL = ['student', 'starosta', 'teacher', 'curator'];

function ensurePush() {
  if (!DB.push || typeof DB.push !== 'object') DB.push = {};
  DB.push.subs = DB.push.subs || {}; DB.push.prefs = DB.push.prefs || {}; DB.push.held = DB.push.held || {};
  if (!DB.push.vapid) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' });
    const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url');
    DB.push.vapid = { publicKey: pub, privateJwk: jwk };
  }
}
const prefsOf = login => ({ ...PREF_DEFAULTS, ...(DB.push.prefs[login] || {}) });
function sanitizePrefs(v) {
  const o = {};
  for (const k of ['schedule', 'grades', 'hw', 'events', 'quiet']) o[k] = !!(v && v[k]);
  o.remind = [0, 10, 30, 60].includes(Number(v && v.remind)) ? Number(v.remind) : 30;
  return o;
}
function endpointAllowed(ep) {
  // Сервер сам обращается по этому адресу, поэтому принимаем только известные push-сервисы (защита от SSRF).
  if (typeof ep !== 'string' || ep.length > 1000) return false;
  let u; try { u = new URL(ep); } catch (e) { return false; }
  if (u.username || u.password) return false;
  const extra = PUSH_EXTRA_HOSTS.includes(u.hostname);
  if (u.protocol === 'https:') return extra || (!u.port && PUSH_HOSTS.test(u.hostname));
  return u.protocol === 'http:' && extra;
}
const subId = ep => sha256(ep).slice(0, 32);
const quietNow = () => { const n = new Date(), m = n.getHours() * 60 + n.getMinutes(); return m >= 22 * 60 || m < 7 * 60; };
const fmtClock = m => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
function dayLabel(day) { const d = new Date(SCHEDULE_START); d.setDate(d.getDate() + Number(day)); return `${d.getDate()} ${MON_SHORT[d.getMonth()]}`; }
const cut = (v, n) => { v = String(v || ''); return v.length > n ? v.slice(0, n - 1) + '…' : v; };

const jwtCache = new Map();
function vapidJwt(aud) {
  const cached = jwtCache.get(aud);
  if (cached && cached.exp > Date.now() / 1000 + 3600) return cached.token;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const enc = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  const data = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud, exp, sub: VAPID_SUBJECT })}`;
  const key = crypto.createPrivateKey({ key: DB.push.vapid.privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const token = `${data}.${sig}`;
  jwtCache.set(aud, { token, exp });
  return token;
}
function sendPush(sub, ttl = 86400) {
  let u; try { u = new URL(sub.endpoint); } catch (e) { return; }
  const lib = u.protocol === 'http:' ? http : https;
  const req = lib.request({
    hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'POST', timeout: 10000,
    headers: { Authorization: `vapid t=${vapidJwt(u.origin)}, k=${DB.push.vapid.publicKey}`, TTL: String(ttl), Urgency: 'normal', 'Content-Length': '0' }
  }, res => {
    res.resume();
    if (res.statusCode === 404 || res.statusCode === 410) { delete DB.push.subs[sub.id]; saveDB(); }
    else if (res.statusCode >= 400) console.error(`Push ${u.hostname}: HTTP ${res.statusCode}`);
  });
  req.on('error', () => {}); req.on('timeout', () => req.destroy());
  req.end();
}
function deliver(subs, item, ttl) {
  for (const s of subs) { s.queue = s.queue || []; s.queue.push(item); while (s.queue.length > 20) s.queue.shift(); }
  saveDB();
  for (const s of subs) sendPush(s, ttl);
}
/* kind: schedule | grades | hw | events | remind | test */
function notifyUser(account, kind, item, ttl = 86400) {
  if (!account) return;
  const prefs = prefsOf(account.login);
  if (prefs[kind] === false) return;   // устройство получает уведомления, только если оно подписано
  const subs = Object.values(DB.push.subs).filter(s => s.login === account.login);
  if (!subs.length) return;
  item = { id: id(), ts: Date.now(), url: '/diary.html', ...item };
  if (kind !== 'test' && prefs.quiet && quietNow()) {
    if (kind === 'remind') return;                       // устаревшее напоминание не откладываем
    const held = DB.push.held[account.login] = DB.push.held[account.login] || [];
    held.push(item); while (held.length > 30) held.shift(); saveDB();
    return;
  }
  deliver(subs, item, ttl);
}
const accountsWhere = (roles, exceptLogin) => DB.accounts.filter(a => roles.includes(a.role) && a.login !== exceptLogin);

let schTimer = null, schEditor = null;
function scheduleChanged(editor) {
  schEditor = editor; clearTimeout(schTimer);   // правки приходят пачкой — отправляем одно уведомление после паузы
  schTimer = setTimeout(() => {
    for (const a of accountsWhere(ROLES_ALL, schEditor)) notifyUser(a, 'schedule', { title: 'Изменения в расписании', body: 'Расписание обновлено. Откройте дневник, чтобы посмотреть.' });
  }, Number(process.env.PUSH_SCHEDULE_DEBOUNCE_MS) || 90000);
  schTimer.unref();
}
function gradesChanged(before, after, user) {
  for (const key of changedKeys(before, after)) {
    if (after[key] === undefined || before[key] === after[key]) continue;
    const rec = parseRecordKey(key, true); if (!rec) continue;
    const lesson = lessonAt(rec.day, rec.pair);
    for (const a of DB.accounts.filter(x => ROLES_STUDENT.includes(x.role) && x.studentIndex === rec.student && x.login !== user.login))
      notifyUser(a, 'grades', { title: `Новая оценка: ${after[key]}`, body: `${lesson ? lesson.title : `${rec.pair} пара`} · ${dayLabel(rec.day)}` });
  }
}
function homeworkChanged(before, after, user) {
  for (const key of changedKeys(before, after)) {
    const next = after[key]; if (!next || JSON.stringify(before[key]) === JSON.stringify(next)) continue;
    const rec = parseRecordKey(key, false); if (!rec) continue;
    const lesson = lessonAt(rec.day, rec.pair);
    const body = `${cut(next.text, 140)}${next.due ? ` · срок: ${next.due}` : ''}`;
    for (const a of accountsWhere(ROLES_STUDENT, user.login))
      notifyUser(a, 'hw', { title: `Новое ДЗ · ${lesson ? lesson.title : `${rec.pair} пара`} (${dayLabel(rec.day)})`, body });
  }
}
function eventsChanged(before, after, user) {
  const added = [];
  for (const [day, list] of Object.entries(after)) {
    const old = (before[day] || []).map(e => JSON.stringify(e));
    for (const e of list) if (!old.includes(JSON.stringify(e))) added.push({ day, e });
  }
  const targets = accountsWhere(ROLES_STUDENT, user.login);
  if (added.length > 3) { for (const a of targets) notifyUser(a, 'events', { title: 'Новые мероприятия', body: `Добавлено мероприятий: ${added.length}` }); return; }
  for (const { day, e } of added) for (const a of targets)
    notifyUser(a, 'events', { title: `Мероприятие · ${dayLabel(day)}`, body: [cut(e.title, 100), e.time && e.time !== '—' ? e.time : '', e.place && e.place !== '—' ? e.place : ''].filter(Boolean).join(' · ') });
}

/* Напоминания о парах и выпуск отложенных ночью уведомлений */
let remindDay = null; const remindSent = new Set();
function lessonsFor(account, day) {
  const lessons = DB.sch?.[weekdayOf(day)]?.lessons || [];
  if (ROLES_STUDENT.includes(account.role)) return lessons;
  if (['teacher', 'curator'].includes(account.role)) return lessons.filter(l => sameTeacher(l.teacher, account.fio));
  return [];
}
function pushTick() {
  try {
    for (const [login, items] of Object.entries(DB.push.held)) {
      const account = DB.accounts.find(a => a.login === login);
      if (account && quietNow() && prefsOf(login).quiet) continue;
      delete DB.push.held[login];
      const subs = account ? Object.values(DB.push.subs).filter(s => s.login === login) : [];
      if (subs.length) for (const item of items) deliver(subs, item);
      saveDB();
    }
    const day = todayOffset(); if (day < 0 || day > MAX_DAY) return;
    if (remindDay !== day) { remindSent.clear(); remindDay = day; }
    const now = new Date(), minutes = now.getHours() * 60 + now.getMinutes();
    for (const account of DB.accounts) {
      const prefs = prefsOf(account.login);
      if (!prefs.remind) continue;
      const lessons = lessonsFor(account, day).filter(l => DB.times[l.n]).sort((a, b) => a.n - b.n);
      lessons.forEach((l, i) => {
        const [start] = DB.times[l.n];
        const prev = lessons[i - 1], gap = prev ? start - DB.times[prev.n][1] : Infinity;
        if (gap < 40) return;                                  // подряд идущие пары не дублируем
        if (minutes < start - prefs.remind || minutes >= start) return;
        const key = `${day}|${account.login}|${l.n}`;
        if (remindSent.has(key)) return;
        remindSent.add(key);
        notifyUser(account, 'remind', {
          title: `Через ${start - minutes} мин: ${l.title}`,
          body: [`${l.n} пара · ${fmtClock(start)}`, l.room && l.room !== '—' ? `каб. ${l.room}` : '', l.place].filter(Boolean).join(' · ')
        }, 900);
      });
    }
  } catch (e) { console.error('push tick:', e.message); }
}

readDB();
setInterval(() => { purgeSessions(); saveDB(); }, 60 * 60 * 1000).unref();
setInterval(pushTick, TICK_MS).unref();

function cookies(req) {
  const safeDecode = v => { try { return decodeURIComponent(v); } catch (e) { return v; } };
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(x => x.trim()).filter(Boolean).map(x => {
    const pos = x.indexOf('=');
    return [safeDecode(pos < 0 ? x : x.slice(0, pos)), safeDecode(pos < 0 ? '' : x.slice(pos + 1))];
  }));
}
function accountView(account) {
  return { id: account.id, fio: account.fio, login: account.login, role: account.role, group: account.group || '', subj: account.subj || '', studentIndex: account.studentIndex ?? null, perms: PERMS[account.role] || {}, home: HOME[account.role] || 'diary.html' };
}
function auth(req) {
  const raw = cookies(req)[COOKIE];
  if (!raw) return null;
  const session = DB.sessions[sha256(raw)];
  if (!session || session.expires < Date.now()) return null;
  const account = DB.accounts.find(a => a.login === session.login);
  return account ? accountView(account) : null;
}
/* Secure-cookie ставим только если запрос действительно пришёл по HTTPS,
   иначе при тестах по http://localhost браузер не сохранит сессию. */
function cookieFlags(req) {
  const isHttps = !!req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
  /* Lax, а не Strict: при Strict браузер не шлёт cookie, когда сайт открыт по ссылке из Telegram,
     почты или другого приложения (в том числе в установленном PWA) — и пользователя выкидывало на вход. */
  return `Path=/; HttpOnly; SameSite=Lax${isHttps ? '; Secure' : ''}`;
}
function sessionCookie(req, raw) {
  return `${COOKIE}=${encodeURIComponent(raw)}; ${cookieFlags(req)}; Max-Age=${SESSION_TTL / 1000}`;
}
function createSession(req, res, account) {
  const raw = crypto.randomBytes(32).toString('base64url');
  DB.sessions[sha256(raw)] = { login: account.login, expires: Date.now() + SESSION_TTL };
  saveDB();
  res.setHeader('Set-Cookie', sessionCookie(req, raw));
}
/* Продлеваем активную сессию и обновляем cookie, чтобы вход не «протухал» у тех, кто пользуется дневником. */
function renewSession(req, res) {
  const raw = cookies(req)[COOKIE];
  if (!raw) return;
  const session = DB.sessions[sha256(raw)];
  const now = Date.now();
  if (!session || session.expires < now) return;
  if (session.expires - now > SESSION_TTL - SESSION_RENEW_AFTER) return;
  session.expires = now + SESSION_TTL;
  try { saveDB(); } catch (e) { console.error('Не удалось сохранить продление сессии:', e.message); }
  res.setHeader('Set-Cookie', sessionCookie(req, raw));
}
function destroySession(req, res) {
  const raw = cookies(req)[COOKIE];
  if (raw) delete DB.sessions[sha256(raw)];
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieFlags(req)}; Max-Age=0`);
  saveDB();
}
function can(user, permission) { return !!(user && PERMS[user.role] && PERMS[user.role][permission]); }
function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY) reject(Object.assign(new Error('Слишком большой запрос'), { status: 413 }));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(Object.assign(new Error('Некорректный JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch (e) { return false; }
}
function requireAuth(req, res, permission) {
  const user = auth(req);
  if (!user) { json(res, 401, { ok: false, error: 'Требуется вход' }); return null; }
  if (permission && !can(user, permission)) { json(res, 403, { ok: false, error: 'Недостаточно прав' }); return null; }
  return user;
}
function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return [...keys].filter(key => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]));
}
function parseRecordKey(key, withStudent) {
  const parts = String(key).split(':').map(Number);
  if (parts.some(n => !Number.isInteger(n))) return null;
  if (parts[0] < 0 || parts[0] > MAX_DAY || parts[1] < 1 || (withStudent && parts[2] < 0)) return null;
  return { day: parts[0], pair: parts[1], student: withStudent ? parts[2] : null };
}
function lessonAt(day, pair) { return DB.sch?.[weekdayOf(day)]?.lessons?.find(lesson => Number(lesson.n) === Number(pair)) || null; }
function currentPair() {
  const now = new Date(), minutes = now.getHours() * 60 + now.getMinutes();
  for (const [number, interval] of Object.entries(DB.times || {})) if (minutes >= interval[0] && minutes < interval[1]) return Number(number);
  return null;
}
/* В расписании преподаватель часто записан как «Селецкая Е. Л.», а в аккаунте — полным ФИО.
   Совпадением считаем одинаковую фамилию и совпадающие инициалы (минимум один инициал с обеих сторон). */
function nameTokens(v) { return String(v || '').toLowerCase().replace(/ё/g, 'е').replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean); }
function sameTeacher(a, b) {
  const x = nameTokens(a), y = nameTokens(b);
  if (!x.length || !y.length) return false;
  if (x.join(' ') === y.join(' ')) return true;
  if (x[0] !== y[0]) return false;
  const ix = x.slice(1).map(w => w[0]), iy = y.slice(1).map(w => w[0]), n = Math.min(ix.length, iy.length);
  return n > 0 && ix.slice(0, n).every((c, i) => c === iy[i]);
}
function teacherOwns(user, day, pair) {
  const lesson = lessonAt(day, pair);
  return !!lesson && sameTeacher(lesson.teacher, user.fio);
}
function validStateObject(value, limit = 20000) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length <= limit; }

function sanitizeSchedule(value, times = DB.times) {
  if (!Array.isArray(value) || value.length !== 7) throw Object.assign(new Error('Расписание должно содержать 7 дней'), { status: 400 });
  return value.map((day, index) => ({
    wd: safeText(day.wd || DEFAULTS.sch[index].wd, 30), s: safeText(day.s || DEFAULTS.sch[index].s, 5),
    lessons: (Array.isArray(day.lessons) ? day.lessons : []).slice(0, 12).map(lesson => {
      const n = Number(lesson.n);
      if (!Number.isInteger(n) || n < 1 || n > 12 || !times[n]) throw Object.assign(new Error('Некорректный номер пары'), { status: 400 });
      const plain = (v, max) => safeText(v, max).replace(/[<>]/g, '');
      return { n, type: lesson.type === 'lec' ? 'lec' : 'prac', title: plain(lesson.title, 180), teacher: plain(lesson.teacher, 100), room: plain(lesson.room, 80), place: plain(lesson.place, 150) };
    }).sort((a, b) => a.n - b.n)
  }));
}
function sanitizeEvents(value) {
  if (!validStateObject(value, MAX_DAY + 1)) throw Object.assign(new Error('Некорректные мероприятия'), { status: 400 });
  const result = {};
  for (const [day, list] of Object.entries(value)) {
    const d = Number(day);
    if (!Number.isInteger(d) || d < 0 || d > MAX_DAY || !Array.isArray(list)) throw Object.assign(new Error('Некорректный день мероприятия'), { status: 400 });
    result[d] = list.slice(0, 50).map(event => ({ time: safeText(event.time, 20), title: safeText(event.title, 180), place: safeText(event.place, 150), org: safeText(event.org, 120) }));
  }
  return result;
}
function sanitizeTimes(value) {
  if (!validStateObject(value, 12)) throw Object.assign(new Error('Некорректная сетка времени'), { status: 400 });
  const result = {};
  for (const [number, interval] of Object.entries(value)) {
    const n = Number(number), start = Number(interval?.[0]), end = Number(interval?.[1]);
    if (!Number.isInteger(n) || n < 1 || n > 12 || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 1439 || end <= start) throw Object.assign(new Error('Некорректное время пары'), { status: 400 });
    result[n] = [start, end];
  }
  return result;
}

const loginAttempts = new Map();
function loginAllowed(ip) {
  const now = Date.now(), item = loginAttempts.get(ip) || { count: 0, since: now };
  if (now - item.since > 15 * 60 * 1000) { item.count = 0; item.since = now; }
  item.count += 1; loginAttempts.set(ip, item);
  return item.count <= 20;
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !sameOrigin(req)) return json(res, 403, { ok: false, error: 'Запрос отклонён' });
  if (pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, version: DB.version });

  if (pathname === '/api/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (!loginAllowed(ip)) return json(res, 429, { ok: false, error: 'Слишком много попыток. Повторите позже' });
    const input = await readBody(req), login = safeLogin(input.login);
    const account = DB.accounts.find(item => item.login === login);
    if (!account || !verifyPassword(input.password, account.passHash)) return json(res, 401, { ok: false, error: 'Неверный логин или пароль' });
    loginAttempts.delete(ip); createSession(req, res, account);
    return json(res, 200, { ok: true, user: accountView(account) });
  }
  if (pathname === '/api/register' && req.method === 'POST') {
    const input = await readBody(req), login = safeLogin(input.login);
    if (!validLogin(login)) return json(res, 400, { ok: false, error: 'Некорректный логин' });
    if (String(input.password || '').length < 8) return json(res, 400, { ok: false, error: 'Пароль должен содержать не менее 8 символов' });
    if (DB.accounts.some(item => item.login === login)) return json(res, 409, { ok: false, error: 'Такой логин уже занят' });
    const last = safeText(input.last, 60), first = safeText(input.first, 60), mid = safeText(input.mid, 60);
    if (!last || !first) return json(res, 400, { ok: false, error: 'Укажите фамилию и имя' });
    const fio = [last, first, mid].filter(Boolean).join(' ');
    let studentIndex = DB.students.indexOf(`${last} ${first}`);
    if (studentIndex < 0) { studentIndex = DB.students.length; DB.students.push(`${last} ${first}`); }
    const group = safeText(input.group, 80);
    if (!DB.groups.some(g => g.id === group || g.name === group)) return json(res, 400, { ok: false, error: 'Выберите доступную группу' });
    const account = { id: id(), fio, login, passHash: hashPassword(input.password), role: 'student', subj: '', group, studentIndex, dob: safeText(input.dob, 10) };
    DB.accounts.push(account); createSession(req, res, account); saveDB();
    return json(res, 201, { ok: true, user: accountView(account) });
  }
  if (pathname === '/api/logout' && req.method === 'POST') { destroySession(req, res); return json(res, 200, { ok: true }); }
  if (pathname === '/api/me' && req.method === 'GET') { const user = requireAuth(req, res); return user && json(res, 200, { ok: true, user }); }

  if (pathname === '/api/state' && req.method === 'GET') {
    const user = requireAuth(req, res); if (!user) return;
    const staff = user.role !== 'student';
    const group = DB.groups.find(g => g.id === user.group || g.name === user.group);
    const groupAccounts = DB.accounts.filter(a => a.role === 'student' && (a.group === group?.id || a.group === group?.name));
    const groupStudentIndices = [...new Set(groupAccounts.map(a => Number(a.studentIndex)).filter(Number.isInteger))];
    const curator = user.role === 'curator';
    const visibleIndices = curator ? new Set(groupStudentIndices) : null;
    const grades = staff ? Object.fromEntries(Object.entries(DB.grades).filter(([key]) => !visibleIndices || visibleIndices.has(Number(key.split(':')[2])))) : Object.fromEntries(Object.entries(DB.grades).filter(([key]) => Number(key.split(':')[2]) === user.studentIndex));
    const att = staff ? Object.fromEntries(Object.entries(DB.att).filter(([key]) => !visibleIndices || visibleIndices.has(Number(key.split(':')[2])))) : Object.fromEntries(Object.entries(DB.att).filter(([key]) => Number(key.split(':')[2]) === user.studentIndex));
    const students = curator ? DB.students.map((name, i) => groupStudentIndices.includes(i) ? name : null) : (staff ? DB.students : undefined);
    return json(res, 200, { grades, att, hw: DB.hw, sch: group?.schedule || DB.sch, ev: DB.ev, times: group?.times || DB.times, groupInfo: group ? { name: group.name, specialty: group.specialty, course: group.course, curatorLogin: group.curatorLogin, starostaLogin: group.starostaLogin } : null, start: SCHEDULE_START_ISO, students, groupStudentIndices: curator ? groupStudentIndices : undefined, revision: DB.updatedAt || null });
  }
  if (pathname.startsWith('/api/state/') && req.method === 'PUT') {
    const part = pathname.split('/')[3], user = requireAuth(req, res); if (!user) return;
    const input = await readBody(req);
    if (part === 'sch') {
      if (!can(user, 'schedule')) return json(res, 403, { ok: false, error: 'Нет права менять расписание' });
      const group = DB.groups.find(g => g.id === user.group || g.name === user.group);
      if (group) group.schedule = sanitizeSchedule(input); else DB.sch = sanitizeSchedule(input); scheduleChanged(user.login);
    } else if (part === 'ev') {
      if (!can(user, 'events')) return json(res, 403, { ok: false, error: 'Нет права менять мероприятия' });
      const prevEv = DB.ev; DB.ev = sanitizeEvents(input); eventsChanged(prevEv || {}, DB.ev, user);
    } else if (part === 'times') {
      if (!can(user, 'times')) return json(res, 403, { ok: false, error: 'Нет права менять время пар' });
      const group = DB.groups.find(g => g.id === user.group || g.name === user.group);
      if (group) group.times = sanitizeTimes(input); else DB.times = sanitizeTimes(input); scheduleChanged(user.login);
    } else if (part === 'grades') {
      if (!can(user, 'grades') || !validStateObject(input)) return json(res, 403, { ok: false, error: 'Нет права менять оценки' });
      for (const key of changedKeys(DB.grades, input)) {
        const record = parseRecordKey(key, true), value = input[key];
        if (!record || (value !== undefined && ![2, 3, 4, 5].includes(Number(value)))) return json(res, 400, { ok: false, error: 'Некорректная оценка' });
        if (user.role !== 'dev' && (!teacherOwns(user, record.day, record.pair) || record.day !== todayOffset() || currentPair() !== record.pair)) return json(res, 403, { ok: false, error: 'Оценки доступны только на своей текущей паре' });
      }
      const prevGrades = DB.grades; DB.grades = input; gradesChanged(prevGrades, input, user);
    } else if (part === 'att') {
      if (!validStateObject(input) || (!can(user, 'attendance') && !can(user, 'ownAttendance'))) return json(res, 403, { ok: false, error: 'Нет права менять посещаемость' });
      for (const key of changedKeys(DB.att, input)) {
        const record = parseRecordKey(key, true), value = input[key];
        if (!record || (value !== undefined && (!['У', 'Н', 'О', 'Б'].includes(value.t) || (value.t === 'О' && (!Number.isInteger(value.min) || value.min < 1 || value.min > 300))))) return json(res, 400, { ok: false, error: 'Некорректная отметка посещаемости' });
        if (user.role === 'teacher' && (!teacherOwns(user, record.day, record.pair) || record.day !== todayOffset() || currentPair() !== record.pair)) return json(res, 403, { ok: false, error: 'Отметки доступны только на своей текущей паре' });
      }
      DB.att = input;
    } else if (part === 'hw') {
      if (!validStateObject(input) || (!can(user, 'homework') && !can(user, 'ownHomework'))) return json(res, 403, { ok: false, error: 'Нет права менять ДЗ' });
      const next = clone(input);
      for (const key of changedKeys(DB.hw, next)) {
        const record = parseRecordKey(key, false), before = DB.hw[key], value = next[key];
        if (!record) return json(res, 400, { ok: false, error: 'Некорректный ключ ДЗ' });
        if (user.role === 'teacher' && !teacherOwns(user, record.day, record.pair)) return json(res, 403, { ok: false, error: 'Можно менять ДЗ только своего предмета' });
        if (user.role === 'starosta' && before?.byRole === 'teacher') return json(res, 403, { ok: false, error: 'ДЗ преподавателя нельзя изменить' });
        if (value !== undefined) {
          if (!safeText(value.text, 2000)) return json(res, 400, { ok: false, error: 'Введите текст ДЗ' });
          next[key] = { text: safeText(value.text, 2000), due: safeText(value.due, 80), src: safeText(value.src, 120), by: user.fio, byRole: user.role === 'teacher' ? 'teacher' : user.role, updatedAt: new Date().toISOString() };
        }
      }
      const prevHw = DB.hw; DB.hw = next; homeworkChanged(prevHw, next, user);
    } else return json(res, 404, { ok: false, error: 'Неизвестный раздел' });
    DB.updatedAt = new Date().toISOString(); saveDB();
    return json(res, 200, { ok: true, part, revision: DB.updatedAt });
  }

  if (pathname === '/api/schedule/import' && req.method === 'POST') {
    const user = requireAuth(req, res, 'schedule'); if (!user) return;
    const input = await readBody(req);
    let times = DB.times;
    if (input.times && typeof input.times === 'object' && Object.keys(input.times).length) {
      if (!can(user, 'times')) return json(res, 403, { ok: false, error: 'Нет права менять время пар' });
      times = sanitizeTimes({ ...DB.times, ...input.times });
    }
    const sch = sanitizeSchedule(input.sch, times);
    DB.times = times; DB.sch = sch; scheduleChanged(user.login);
    DB.updatedAt = new Date().toISOString(); saveDB();
    return json(res, 200, { ok: true, lessons: sch.reduce((sum, day) => sum + day.lessons.length, 0), revision: DB.updatedAt });
  }

  if (pathname === '/api/push/config' && req.method === 'GET') {
    const user = requireAuth(req, res); if (!user) return;
    return json(res, 200, { ok: true, publicKey: DB.push.vapid.publicKey, prefs: prefsOf(user.login), devices: Object.values(DB.push.subs).filter(s => s.login === user.login).length });
  }
  if (pathname === '/api/push/prefs' && req.method === 'PUT') {
    const user = requireAuth(req, res); if (!user) return;
    DB.push.prefs[user.login] = sanitizePrefs(await readBody(req)); saveDB();
    return json(res, 200, { ok: true, prefs: prefsOf(user.login) });
  }
  if (pathname === '/api/push/subscribe' && req.method === 'POST') {
    const user = requireAuth(req, res); if (!user) return;
    const input = await readBody(req), endpoint = String(input.endpoint || input.subscription?.endpoint || '');
    if (!endpointAllowed(endpoint)) return json(res, 400, { ok: false, error: 'Этот push-сервис не поддерживается' });
    const sid = subId(endpoint), old = DB.push.subs[sid];
    DB.push.subs[sid] = { id: sid, login: user.login, endpoint, createdAt: old?.createdAt || new Date().toISOString(), queue: old && old.login === user.login ? old.queue || [] : [] };
    const mine = Object.values(DB.push.subs).filter(s => s.login === user.login).sort((a, b) => a.createdAt < b.createdAt ? -1 : 1);
    while (mine.length > 10) delete DB.push.subs[mine.shift().id];
    saveDB(); return json(res, 200, { ok: true });
  }
  if (pathname === '/api/push/unsubscribe' && req.method === 'POST') {
    const user = requireAuth(req, res); if (!user) return;
    const input = await readBody(req), sid = subId(String(input.endpoint || ''));
    if (DB.push.subs[sid] && DB.push.subs[sid].login === user.login) { delete DB.push.subs[sid]; saveDB(); }
    return json(res, 200, { ok: true });
  }
  /* Без cookie: сервис-воркер подтверждает себя секретным адресом своей подписки (его знают только устройство и сервер).
     На каждый push отдаём ровно одно уведомление из очереди этого устройства. */
  if (pathname === '/api/push/pending' && req.method === 'POST') {
    const input = await readBody(req), sub = DB.push.subs[subId(String(input.endpoint || ''))];
    if (!sub) return json(res, 404, { ok: false, error: 'Подписка не найдена' });
    const item = (sub.queue || []).shift() || null; if (item) saveDB();
    return json(res, 200, { ok: true, item: item && { id: item.id, title: item.title, body: item.body, url: item.url }, left: (sub.queue || []).length });
  }
  if (pathname === '/api/push/test' && req.method === 'POST') {
    const user = requireAuth(req, res); if (!user) return;
    const account = DB.accounts.find(a => a.login === user.login);
    if (!Object.values(DB.push.subs).some(s => s.login === user.login)) return json(res, 400, { ok: false, error: 'Сначала включите уведомления на этом устройстве' });
    notifyUser(account, 'test', { title: 'Электронный дневник', body: 'Тестовое уведомление: push работают.' });
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/groups' && req.method === 'GET') {
    return json(res, 200, DB.groups.map(g => ({ id: g.id, name: g.name, specialty: g.specialty || '', course: g.course || 1, curatorLogin: g.curatorLogin || '', starostaLogin: g.starostaLogin || '' })));
  }
  if (pathname === '/api/groups' && req.method === 'POST') {
    const user = requireAuth(req, res, 'accounts'); if (!user) return;
    const input = await readBody(req), name = safeText(input.name, 80), specialty = safeText(input.specialty, 120), course = Math.max(1, Math.min(6, Number(input.course) || 1));
    if (!name || !/^[\p{L}\p{N} _.-]+$/u.test(name)) return json(res, 400, { ok: false, error: 'Укажите корректное название группы' });
    if (DB.groups.some(g => g.id.toLowerCase() === name.toLowerCase() || g.name.toLowerCase() === name.toLowerCase())) return json(res, 409, { ok: false, error: 'Такая группа уже существует' });
    DB.groups.push({ id: name, name, specialty, course, curatorLogin: '', starostaLogin: '', schedule: createBlankWeek(), times: {} }); saveDB();
    return json(res, 201, { ok: true });
  }
  if (pathname.startsWith('/api/groups/') && req.method === 'DELETE') {
    const user = requireAuth(req, res, 'accounts'); if (!user) return;
    const gid = decodeURIComponent(pathname.split('/')[3] || ''), group = DB.groups.find(g => g.id === gid || g.name === gid);
    if (!group) return json(res, 404, { ok: false, error: 'Группа не найдена' });
    if (DB.groups.length === 1) return json(res, 400, { ok: false, error: 'Нельзя удалить последнюю группу' });
    if (DB.accounts.some(a => a.group === group.id || a.group === group.name)) return json(res, 409, { ok: false, error: 'Сначала перенесите или удалите аккаунты этой группы' });
    DB.groups = DB.groups.filter(g => g !== group); saveDB(); return json(res, 200, { ok: true });
  }

  if (pathname === '/api/accounts' && req.method === 'GET') {
    const user = requireAuth(req, res, 'accounts'); if (!user) return;
    return json(res, 200, DB.accounts.map(accountView));
  }
  if (pathname === '/api/accounts' && req.method === 'POST') {
    const user = requireAuth(req, res, 'accounts'); if (!user) return;
    const input = await readBody(req), login = safeLogin(input.login), role = safeText(input.role, 20);
    if (!validLogin(login)) return json(res, 400, { ok: false, error: 'Некорректный логин' });
    if (!['student', 'starosta', 'teacher', 'curator', 'admin'].includes(role)) return json(res, 400, { ok: false, error: 'Некорректная роль' });
    if (String(input.password || '').length < 8) return json(res, 400, { ok: false, error: 'Пароль должен содержать не менее 8 символов' });
    if (DB.accounts.some(item => item.login === login)) return json(res, 409, { ok: false, error: 'Логин уже занят' });
    const fio = safeText(input.fio, 150); if (!fio) return json(res, 400, { ok: false, error: 'Укажите ФИО' });
    const needsGroup = ['student', 'starosta', 'curator'].includes(role);
    const groupName = needsGroup ? safeText(input.group, 80) : '';
    const groupRecord = needsGroup ? DB.groups.find(g => g.id === groupName || g.name === groupName) : null;
    if (needsGroup && !groupRecord) return json(res, 400, { ok: false, error: 'Выберите существующую группу' });
    if (role === 'curator' && groupRecord.curatorLogin && groupRecord.curatorLogin !== login) return json(res, 409, { ok: false, error: 'У группы уже назначен куратор' });
    if (role === 'starosta' && groupRecord.starostaLogin && groupRecord.starostaLogin !== login) return json(res, 409, { ok: false, error: 'У группы уже назначен староста' });
    let studentIndex = null;
    if (role === 'student' || role === 'starosta') {
      const shortName = fio.split(' ').slice(0, 2).join(' ');
      studentIndex = DB.students.indexOf(shortName);
      if (studentIndex < 0) { studentIndex = DB.students.length; DB.students.push(shortName); }
    }
    DB.accounts.push({ id: id(), fio, login, passHash: hashPassword(input.password), role, subj: ['teacher', 'curator'].includes(role) ? safeText(input.subj, 300) : '', group: needsGroup ? groupRecord.id : '', studentIndex });
    if (role === 'curator') groupRecord.curatorLogin = login; if (role === 'starosta') groupRecord.starostaLogin = login;
    saveDB(); return json(res, 201, { ok: true });
  }
  if (pathname.startsWith('/api/accounts/') && req.method === 'DELETE') {
    const user = requireAuth(req, res, 'accounts'); if (!user) return;
    const login = safeLogin(pathname.split('/')[3]), index = DB.accounts.findIndex(item => item.login === login);
    if (index < 0) return json(res, 404, { ok: false, error: 'Аккаунт не найден' });
    if (DB.accounts[index].role === 'dev') return json(res, 403, { ok: false, error: 'Аккаунт разработчика управляется через env' });
    const removed = DB.accounts[index];
    DB.accounts.splice(index, 1);
    for (const group of DB.groups) { if (group.curatorLogin === login) group.curatorLogin = ''; if (group.starostaLogin === login) group.starostaLogin = ''; }
    for (const [key, sub] of Object.entries(DB.push.subs)) if (sub.login === login) delete DB.push.subs[key];
    delete DB.push.prefs[login]; delete DB.push.held[login];
    for (const [key, session] of Object.entries(DB.sessions)) if (session.login === login) delete DB.sessions[key];
    saveDB(); return json(res, 200, { ok: true });
  }
  if (pathname === '/api/reset' && req.method === 'POST') {
    const user = requireAuth(req, res, 'accounts'); if (!user) return;
    // Полный сброс рабочей базы: сохраняем только учётную запись разработчика,
    // чтобы он мог сразу войти и создать аккаунты заново.
    const developerAccounts = DB.accounts.filter(a => a.role === 'dev');
    const developerSessions = Object.fromEntries(Object.entries(DB.sessions || {}).filter(([, session]) => developerAccounts.some(a => a.login === session.login)));
    DB = clone(DEFAULTS);
    DB.accounts = developerAccounts;
    DB.sessions = developerSessions;
    ensurePush();
    DB.updatedAt = new Date().toISOString();
    saveDB();
    console.log(`База данных очищена разработчиком. Файл: ${DB_FILE}`);
    return json(res, 200, { ok: true, message: 'База очищена. Аккаунт разработчика сохранён.' });
  }
  return json(res, 404, { ok: false, error: 'Метод не найден' });
}

const STATIC_FILES = new Set(['/sw.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/og-image.png', '/splash.js']);
const MIME = { '.webmanifest': 'application/manifest+json; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
// Абсолютный адрес сайта для og:image / og:url (Telegram и соцсети требуют полные URL).
function siteOrigin(req) {
  if (/^https?:\/\/[a-z0-9.\-:\[\]]+$/i.test(PUBLIC_URL)) return PUBLIC_URL;
  const first = v => String(v || '').split(',')[0].trim();
  const proto = first(req.headers['x-forwarded-proto']).toLowerCase() === 'https' || req.socket.encrypted ? 'https' : 'http';
  let host = first(req.headers['x-forwarded-host']) || String(req.headers.host || '');
  if (!/^[a-z0-9.\-:\[\]]+$/i.test(host)) host = 'localhost';
  return `${proto}://${host}`;
}
function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    renewSession(req, res);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    if (PAGE_PERM[pathname]) {
      const user = auth(req);
      if (!user) { res.writeHead(302, { Location: '/login.html' }); return res.end(); }
      if (!can(user, PAGE_PERM[pathname])) { res.writeHead(302, { Location: `/${user.home}` }); return res.end(); }
    }
    if (pathname === '/login.html' && auth(req)) {
      const user = auth(req); res.writeHead(302, { Location: `/${user.home}` }); return res.end();
    }
    if (!STATIC_FILES.has(pathname) && !/^\/(index|login|diary|studio|zhurnal|STplus)\.html$/.test(pathname)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Страница не найдена');
    }
    const file = path.join(ROOT, pathname.slice(1));
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Страница не найдена'); }
      const ext = path.extname(file);
      if (ext === '.html' && data.includes('__ORIGIN__')) data = Buffer.from(data.toString('utf8').replaceAll('__ORIGIN__', siteOrigin(req)), 'utf8');
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.png' ? 'public, max-age=3600' : 'no-store' }); res.end(data);
    });
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) console.error(error);
    if (!res.headersSent) json(res, status, { ok: false, error: status === 500 ? 'Внутренняя ошибка сервера' : error.message });
    else res.end();
  }
});
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error('');
    console.error(`ПОРТ ЗАНЯТ: ${HOST}:${PORT} уже используется другим процессом.`);
    console.error('Что сделать:');
    console.error('  Остановите второй процесс, чтобы приложение могло слушать обязательный порт 3000.');
    console.error(`  Узнать виновника внутри контейнера: ss -ltnp | grep ${PORT}`);
  } else {
    console.error('Критическая ошибка сервера:', err);
  }
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`Электронный дневник: http://${HOST}:${PORT}`);
  console.log(`Разработчик: ${DEV_LOGIN} (пароль получен из DEV_PASWORD)`);
  console.log(`Данные: ${DB_FILE}`);
});
function shutdown() {
  server.close(() => { try { writeDBNow(); } finally { process.exit(0); } });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
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
/* Живая база никогда не лежит в дереве репозитория: при `git pull`, `git checkout -- .`
   или чистой клонировании на том же пути git перезапишет файл рядом с кодом.
   Поэтому по умолчанию используется каталог data/ рядом с сервером (в него же попадают
   резервные копии и загруженные картинки), а прежний ./data.json переносится туда сам. */
const LEGACY_DB_FILE = path.join(ROOT, 'data.json');
function resolveDbFile() {
  if (process.env.DATA_FILE) return path.resolve(process.env.DATA_FILE);
  const modern = path.join(ROOT, 'data', 'data.json');
  if (fs.existsSync(modern) || !fs.existsSync(LEGACY_DB_FILE)) return modern;
  try {
    fs.mkdirSync(path.dirname(modern), { recursive: true });
    fs.copyFileSync(LEGACY_DB_FILE, modern);
    console.log(`Старая база перенесена из ${LEGACY_DB_FILE} в ${modern} — дальше используется новый файл, репозиторий больше не хранит данные.`);
  } catch (e) {
    console.error('Не удалось перенести базу в каталог data/, работаем со старым файлом:', e.message);
    return LEGACY_DB_FILE;
  }
  return modern;
}
const DB_FILE = resolveDbFile();
const DATA_DIR = path.dirname(DB_FILE);
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const BACKUP_KEEP = 36;
const BACKUP_EVERY_MS = 5 * 60 * 1000;
/* Одноразовая очистка демонстрационных данных делалась по признаку «версия ниже CLEAN_DB_VERSION».
   Теперь сброс возможен ТОЛЬКО пока в базе нет ни одной учётной записи: расширение схемы
   больше не уничтожает данные, миграции ниже только добавляют недостающие поля. */
const SCHEMA_VERSION = 4;
const CLEAN_DB_VERSION = SCHEMA_VERSION;
/* Логин приводим к нижнему регистру: при входе пользовательский ввод
   тоже нормализуется, иначе совпадение не случится. */
const DEV_LOGIN = String(process.env.DEV_LOGIN || '').trim().toLowerCase();
// Основной формат — DEV_PASWORD; также принимаем распространённый вариант с двумя S.
const DEV_PASSWORD = String(process.env.DEV_PASWORD || process.env.DEV_PASSWORD || '').trim();
const COOKIE = 'sd_session';
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
/* Скользящая сессия: при активности срок продлевается, но не чаще раза в 12 часов. */
const SESSION_RENEW_AFTER = 12 * 60 * 60 * 1000;
const MAX_BODY = 3 * 1024 * 1024;   // запас под base64 картинок профиля
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
  /* gradeMeta: кто и когда выставил оценку. Сама оценка в DB.grades остаётся числом,
     чтобы не менять формат во всех клиентах; наружу она уходит только автору, куратору,
     самому студенту и разработчику. */
  gradeMeta: {},
  ev: {},
  sch: createBlankWeek(),
  chats: {},
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
const PAGE_PERM = { '/diary.html': 'diary', '/studio.html': 'studio', '/zhurnal.html': 'journal', '/STplus.html': 'plus', '/chat.html': 'diary' };

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
const readJSONFile = file => {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) throw new Error('файл пуст');
    return JSON.parse(raw);
  } catch (e) { return null; }
};
/* Резервные копии: перед записью храним предыдущее содержимое не чаще раза в 5 минут.
   Это страховка от обрыва записи (питание, контейнер), а не от каждой правки. */
let lastBackupAt = 0;
function backupCurrent() {
  try {
    if (!fs.existsSync(DB_FILE)) return;
    const now = Date.now();
    if (lastBackupAt && now - lastBackupAt < BACKUP_EVERY_MS) return;
    lastBackupAt = now;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    fs.copyFileSync(DB_FILE, path.join(BACKUP_DIR, `data-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`));
    const keep = fs.readdirSync(BACKUP_DIR).filter(f => /^data-.*\.json$/.test(f)).sort();
    while (keep.length > BACKUP_KEEP) fs.rmSync(path.join(BACKUP_DIR, keep.shift()), { force: true });
  } catch (e) { console.error('Резервная копия не создана:', e.message); }
}
const latestBackup = () => {
  try {
    const list = fs.readdirSync(BACKUP_DIR).filter(f => /^data-.*\.json$/.test(f)).sort();
    return list.length ? path.join(BACKUP_DIR, list[list.length - 1]) : null;
  } catch (e) { return null; }
};
/* Читаем базу, а при повреждении файла — последнюю резервную копию.
   Битый файл не удаляем: он остаётся рядом как data.json.corrupt-<дата>. */
function loadDatabase() {
  const direct = readJSONFile(DB_FILE);
  if (direct) return direct;
  if (!fs.existsSync(DB_FILE)) return null;
  const backup = latestBackup();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try { fs.copyFileSync(DB_FILE, `${DB_FILE}.corrupt-${stamp}`); } catch (e) { /* если не удалось — не критично */ }
  if (backup) {
    const restored = readJSONFile(backup);
    if (restored) {
      console.error(`Файл ${DB_FILE} повреждён. Восстановлена резервная копия ${backup}. Испорченная версия сохранена как ${DB_FILE}.corrupt-${stamp}.`);
      return restored;
    }
  }
  console.error(`Файл ${DB_FILE} повреждён и читается, резервных копий нет — старт с пустой базы. Испорченная версия сохранена как ${DB_FILE}.corrupt-${stamp}.`);
  return null;
}
/* Миграция только досоздаёт структуры: ни одна существующая запись не удаляется и не обнуляется. */
function migrate() {
  for (const [key, value] of Object.entries(DEFAULTS)) if (DB[key] === undefined) DB[key] = clone(value);
  if (!Array.isArray(DB.accounts)) DB.accounts = [];
  if (!Array.isArray(DB.groups)) DB.groups = clone(DEFAULTS.groups);
  if (!DB.groups.length) DB.groups = clone(DEFAULTS.groups);
  for (const g of DB.groups) { if (!Array.isArray(g.schedule)) g.schedule = createBlankWeek(); if (!g.times || typeof g.times !== 'object') g.times = {}; }
  if (!DB.sessions || typeof DB.sessions !== 'object') DB.sessions = {};
  if (!DB.chats || typeof DB.chats !== 'object') DB.chats = {};
  if (!DB.gradeMeta || typeof DB.gradeMeta !== 'object') DB.gradeMeta = {};
  for (const account of DB.accounts) {
    if (account.pass && !account.passHash) account.passHash = hashPassword(account.pass);
    delete account.pass;
    if (!account.id) account.id = id();
    if (!Array.isArray(account.blocked)) account.blocked = [];
    if (!Array.isArray(account.designs)) account.designs = [];
    account.profile = normalizeProfile(account.profile);
  }
  for (const chat of Object.values(DB.chats)) if (!chat.code) chat.code = newChatCode();
  DB.version = SCHEMA_VERSION;
}
function readDB() {
  DB = loadDatabase() || clone(DEFAULTS);
  /* Демонстрационные данные вычищаем один раз и только в пустой базе:
     как только появились аккаунты — база считается рабочей и не трогается. */
  const demoOnly = !DB.accounts.length && !Object.keys(DB.sessions || {}).length && !Object.keys(DB.grades || {}).length;
  if (Number(DB.version || 0) < SCHEMA_VERSION && demoOnly) DB = clone(DEFAULTS);
  migrate();
  /* Аккаунт разработчика всегда берётся из переменных окружения: если в файле осталась
     запись с ролью dev, она пересоздаётся, чтобы смена пароля в env вступила в силу. */
  DB.accounts = DB.accounts.filter(a => a.role !== 'dev');
  DB.accounts.push({ id: 'developer', fio: 'Разработчик', login: DEV_LOGIN, passHash: hashPassword(DEV_PASSWORD), role: 'dev', subj: '', group: '', studentIndex: null, blocked: [], designs: ['aurora', 'ocean', 'sunset', 'rose', 'crimson', 'gold', 'acid'], profile: normalizeProfile() });
  purgeSessions();
  ensurePush();
  writeDBNow();
}
function writeDBNow() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  backupCurrent();
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
const PREF_DEFAULTS = { schedule: true, grades: true, hw: true, events: false, chat: true, quiet: true, remind: 30 };
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
  for (const k of ['schedule', 'grades', 'hw', 'events', 'chat', 'quiet']) o[k] = !!(v && v[k]);
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
/* Неделя и время пар принадлежат группе аккаунта; DB.sch / DB.times — запасной вариант
   для аккаунтов без группы и для баз, созданных до появления групп. */
function groupOf(ref) { return DB.groups.find(g => g.id === ref || g.name === ref) || null; }
function scheduleOf(group) { return group && Array.isArray(group.schedule) ? group.schedule : (Array.isArray(DB.sch) ? DB.sch : []); }
function timesOf(group) { const own = group && group.times; return own && Object.keys(own).length ? own : (DB.times || {}); }

/* Рейтинг считается здесь, наружу уходят только средние баллы и счётчики:
   чужие оценки по каждой паре студенту видеть незачем. */
const ATT_KEYS = ['У', 'Н', 'О', 'Б'];
const ATT_PENALTY = { Н: 1, О: .5, У: .25, Б: 0 };   // больничный и уважительная почти не снижают балл
const GRADE_WEIGHT = 6, VISIT_WEIGHT = 4;

function studentIndicesOf(group) {
  if (!group) return [];
  const accounts = DB.accounts.filter(a => ROLES_STUDENT.includes(a.role) && (a.group === group.id || a.group === group.name));
  return [...new Set(accounts.map(a => Number(a.studentIndex)).filter(Number.isInteger))];
}
/* Number(null) даёт 0, поэтому «свой» индекс студента вытаскиваем аккуратно: у преподавателя его нет */
function ownIndexOf(account) {
  const v = account && account.studentIndex;
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function ratingOf(user) {
  const group = groupOf(user.group);
  const own = ownIndexOf(user);
  const inGroup = studentIndicesOf(group);
  const indices = inGroup.length ? inGroup : (own == null ? [] : [own]);
  const mine = new Set(indices);
  const stats = new Map(indices.map(i => [i, { sum: 0, count: 0, grades: { 2: 0, 3: 0, 4: 0, 5: 0 }, marks: { У: 0, Н: 0, О: 0, Б: 0 }, late: 0 }]));
  const checked = new Set();   // пары, на которых посещаемость хотя бы у одного отмечали
  for (const [key, value] of Object.entries(DB.att)) {
    const rec = parseRecordKey(key, true);
    if (!rec || !mine.has(rec.student) || !value || !ATT_KEYS.includes(value.t)) continue;
    checked.add(`${rec.day}:${rec.pair}`);
    const s = stats.get(rec.student);
    s.marks[value.t]++; s.late += Number(value.min) || 0;
  }
  for (const [key, value] of Object.entries(DB.grades)) {
    const rec = parseRecordKey(key, true), grade = Number(value);
    if (!rec || !mine.has(rec.student) || ![2, 3, 4, 5].includes(grade)) continue;
    const s = stats.get(rec.student);
    s.sum += grade; s.count++; s.grades[grade]++;
  }
  const rows = indices.map(index => {
    const s = stats.get(index);
    const missed = ATT_KEYS.reduce((n, t) => n + s.marks[t], 0);
    const avg = s.count ? s.sum / s.count : null;
    const gradeScore = avg == null ? null : (avg - 2) / 3 * 100;
    const account = DB.accounts.find(a => ROLES_STUDENT.includes(a.role) && Number(a.studentIndex) === index);
    const profile = account ? account.profile : null;
    const visitScore = checked.size ? Math.max(0, 100 - ATT_KEYS.reduce((pen, t) => pen + s.marks[t] * ATT_PENALTY[t], 0) / checked.size * 100) : null;
    const parts = [[gradeScore, GRADE_WEIGHT], [visitScore, VISIT_WEIGHT]].filter(([v]) => v != null);
    const weight = parts.reduce((a, [, w]) => a + w, 0);
    const round1 = v => (v == null ? null : Math.round(v * 10) / 10);
    return {
      index, name: String(DB.students[index] || `Студент ${index + 1}`),
      login: account ? account.login : '', avatar: (profile && profile.avatar) || '',
      verified: !!(account && account.verified),
      status: profile && profile.status && profile.status.kind === 'emoji' ? profile.status.value : '',
      avg: avg == null ? null : Math.round(avg * 100) / 100, gradeCount: s.count, gradeCounts: s.grades,
      marks: s.marks, missed, lateMinutes: s.late, checkedLessons: checked.size,
      gradeScore: round1(gradeScore), visitScore: round1(visitScore),
      /* Студент без оценок или без отметок не может обходить тех, у кого данные полные */
      complete: gradeScore != null && visitScore != null,
      score: weight ? round1(parts.reduce((a, [v, w]) => a + v * w, 0) / weight) : null
    };
  }).sort((a, b) => (b.complete - a.complete) || (b.score ?? -1) - (a.score ?? -1) || (b.avg ?? -1) - (a.avg ?? -1) || a.name.localeCompare(b.name, 'ru'));
  rows.forEach((row, i) => { row.place = row.score == null ? null : i + 1; });
  return { group: group ? group.name : null, students: rows, me: own != null && mine.has(own) ? own : null };
}

/* ================= ПРОФИЛИ ПОЛЬЗОВАТЕЛЕЙ =================
   Оформление (тема), аватар, баннер, био и статус хранятся прямо в аккаунте,
   картинки — файлами в data/media, чтобы база оставалась маленькой.
   Три оформления общедоступны, остальные выдаёт разработчик из Студии Плюс. */
const PROFILE_DESIGNS = [
  { id: 'aurora', name: 'Аврора', hint: 'Фирменные сине-фиолетовые тона', exclusive: false, colors: ['#4f8cff', '#a855f7'] },
  { id: 'ocean', name: 'Океан', hint: 'Глубокий сине-голубой градиент', exclusive: false, colors: ['#0ea5e9', '#22d3ee'] },
  { id: 'sunset', name: 'Закат', hint: 'Тёплый оранжево-розовый свет', exclusive: false, colors: ['#fb7185', '#fbbf24'] },
  { id: 'rose', name: 'Розовые тона', hint: 'Всё розовое — нежное оформление для девочек', exclusive: true, colors: ['#f472b6', '#e879f9'] },
  { id: 'crimson', name: 'Чёрный с красным', hint: 'Чёрный фон и красные акценты', exclusive: true, colors: ['#ef4444', '#7f1d1d'] },
  { id: 'gold', name: 'Золотой резерв', hint: 'Тёмное золото для первых строк рейтинга', exclusive: true, colors: ['#f5c451', '#b8860b'] },
  { id: 'acid', name: 'Кислотный неон', hint: 'Ярко-салатовый неон на графите', exclusive: true, colors: ['#a3e635', '#22c55e'] },
];
const DESIGN_IDS = PROFILE_DESIGNS.map(d => d.id);
const PUBLIC_DESIGNS = PROFILE_DESIGNS.filter(d => !d.exclusive).map(d => d.id);
const EMOJI_MAX = 8;

function normalizeProfile(value) {
  const p = value && typeof value === 'object' ? value : {};
  const design = DESIGN_IDS.includes(p.design) ? p.design : 'aurora';
  const kind = p.status?.kind === 'media' ? 'media' : p.status?.kind === 'emoji' ? 'emoji' : '';
  const statusValue = kind ? safeText(p.status.value, 300) : '';
  return {
    bio: safeText(p.bio, 300),
    avatar: safeMediaPath(p.avatar),
    banner: safeMediaPath(p.banner),
    design,
    status: kind && statusValue ? { kind, value: statusValue } : null,
  };
}
/* Наружу уходим только путями вида /media/<файл> — ничего похожего на путь вне каталога. */
function safeMediaPath(value) {
  const v = String(value || '');
  return /^\/media\/[a-z0-9._-]{6,70}\.(png|jpg|jpeg|webp|gif)$/i.test(v) && !v.includes('..') ? v : '';
}
function designOf(account) {
  const granted = Array.isArray(account.designs) ? account.designs.filter(d => DESIGN_IDS.includes(d)) : [];
  const own = account.profile?.design || 'aurora';
  return [...new Set([...PUBLIC_DESIGNS, ...granted, own])];
}
function isDesignAllowed(account, designId) {
  return PUBLIC_DESIGNS.includes(designId) || (Array.isArray(account.designs) && account.designs.includes(designId));
}
function profileView(account) {
  if (!account) return null;
  const p = account.profile || normalizeProfile();
  return {
    login: account.login, fio: account.fio, role: account.role, roleLabel: ROLE_LABEL[account.role] || account.role,
    group: account.group || '', subj: account.subj || '', bio: p.bio, avatar: p.avatar, banner: p.banner,
    design: p.design, status: p.status, verified: !!account.verified,
    designs: designOf(account),
  };
}

const MEDIA_KINDS = { avatar: 400 * 1024, banner: 900 * 1024, status: 400 * 1024 };
const MEDIA_SIGNATURES = [
  { mime: 'image/png', ext: 'png', test: b => b.startsWith([0x89, 0x50, 0x4e, 0x47]) },
  { mime: 'image/jpeg', ext: 'jpg', test: b => b.startsWith([0xff, 0xd8, 0xff]) },
  { mime: 'image/gif', ext: 'gif', test: b => b.startsWithAscii('GIF8') },
  { mime: 'image/webp', ext: 'webp', test: b => b.startsWithAscii('RIFF') && b.slice(8, 12).join() === '87,69,66,80' },
];
function byteList(buffer) {
  return {
    startsWith: arr => arr.every((byte, i) => buffer[i] === byte),
    startsAscii: text => String.fromCharCode(...buffer.subarray(0, text.length)) === text,
    slice: (from, to) => Array.from(buffer.subarray(from, to)),
    length: buffer.length,
  };
}
function decodeImageData(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([\s\S]+)$/.exec(String(dataUrl || '').trim());
  if (!m) throw Object.assign(new Error('Нужно изображение PNG, JPEG, WebP или GIF'), { status: 400 });
  let buffer;
  try { buffer = Buffer.from(m[2], 'base64'); } catch (e) { throw Object.assign(new Error('Не удалось прочитать изображение'), { status: 400 }); }
  const bytes = byteList(buffer);
  const kind = MEDIA_SIGNATURES.find(s => s.mime === m[1] && s.test(bytes));
  if (!kind) throw Object.assign(new Error('Формат файла не совпадает с заявленным'), { status: 400 });
  return { buffer, ext: kind.ext };
}
/* Файлы медиа живут в data/media — рядом с базой, поэтому вместе с ней и бэкапятся. */
function saveMediaFile(login, kind, dataUrl) {
  const limit = MEDIA_KINDS[kind];
  if (!limit) throw Object.assign(new Error('Неизвестный тип изображения'), { status: 400 });
  const { buffer, ext } = decodeImageData(dataUrl);
  if (buffer.length > limit) throw Object.assign(new Error(`Файл слишком большой (до ${Math.round(limit / 1024)} КБ)`), { status: 400 });
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const name = `${kind[0]}${login.replace(/[^a-z0-9._-]/gi, '').slice(0, 24)}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(MEDIA_DIR, name), buffer, { mode: 0o600 });
  return `/media/${name}`;
}
function removeMediaFile(url) {
  const file = safeMediaPath(url);
  if (!file) return;
  const name = file.slice('/media/'.length);
  const stillUsed = DB.accounts.some(a => a.profile && (a.profile.avatar === file || a.profile.banner === file || a.profile.status?.value === file));
  if (stillUsed) return;
  try { fs.rmSync(path.join(MEDIA_DIR, name), { force: true }); } catch (e) { /* файл уже удалён — не беда */ }
}

/* ================= ЧАТЫ =================
   У каждой группы общий чат появляется сам; личные диалоги заводятся по первому
  сообщению и только между теми, кто пересекается по группе либо служит в системе. */
const MSG_MAX = 2000, MSG_KEEP = 300;
const ROLE_LABEL = { student: 'студент', starosta: 'староста', teacher: 'преподаватель', curator: 'куратор', admin: 'дежурный администратор', dev: 'разработчик' };
const groupChatId = group => `g:${group.id}`;
const directChatId = (a, b) => `d:${[a, b].sort().join('~')}`;
const accountOf = login => DB.accounts.find(a => a.login === login) || null;
/* Дежурный администратор и разработчик видят чаты всех групп */
const isService = account => !!account && (account.role === 'dev' || account.role === 'admin');
/* Короткий адрес чата: домен/chat/<код>. Символы без похожих (0/o, 1/l/i), чтобы код диктовали по телефону. */
const CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
function newChatCode() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const bytes = crypto.randomBytes(9);
    const code = Array.from(bytes, b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    if (!Object.values(DB.chats).some(c => c.code === code)) return code;
  }
  return crypto.randomBytes(9).toString('hex');
}
/* Блокировка: пользователь, которого заблокировали, не может начать диалог и писать в него. */
const blocksOf = account => new Set(Array.isArray(account && account.blocked) ? account.blocked : []);
const isBlocked = (by, who) => blocksOf(accountOf(by)).has(who);
function normalizeChat(chat) {
  if (!Array.isArray(chat.msgs)) chat.msgs = [];
  if (!chat.reads || typeof chat.reads !== 'object') chat.reads = {};
  if (!chat.pins || typeof chat.pins !== 'object') chat.pins = {};
  if (!chat.code) chat.code = newChatCode();
  return chat;
}

function teachesGroup(teacher, group) {
  return !!teacher && scheduleOf(group).some(day => day.lessons.some(l => sameTeacher(l.teacher, teacher.fio)));
}
function groupsOf(account) {
  if (!account) return [];
  const own = groupOf(account.group);
  if (account.role !== 'teacher') return own ? [own] : [];
  const list = DB.groups.filter(g => teachesGroup(account, g));
  return own && !list.includes(own) ? [own, ...list] : list;
}
function memberLogins(group) {
  if (!group) return [];
  const set = new Set(DB.accounts.filter(a => a.group === group.id || a.group === group.name).map(a => a.login));
  for (const a of DB.accounts) if (a.role === 'teacher' && teachesGroup(a, group)) set.add(a.login);
  return [...set];
}
function directAllowed(a, b) {
  if (!a || !b || a.login === b.login) return false;
  if (isBlocked(a.login, b.login) || isBlocked(b.login, a.login)) return false;
  if (isService(a) || isService(b)) return true;
  const bg = groupsOf(b);
  return groupsOf(a).some(g => bg.includes(g));
}
function ensureGroupChat(group) {
  const cid = groupChatId(group);
  if (!DB.chats[cid]) DB.chats[cid] = { id: cid, kind: 'group', group: group.id, title: group.name, created: new Date().toISOString(), members: [], reads: {}, pins: {} };
  return normalizeChat(DB.chats[cid]);
}
function ensureDirectChat(a, b) {
  const cid = directChatId(a.login, b.login);
  if (!DB.chats[cid]) DB.chats[cid] = { id: cid, kind: 'direct', members: [a.login, b.login].sort(), title: '', created: new Date().toISOString(), reads: {}, pins: {} };
  const chat = normalizeChat(DB.chats[cid]);
  if (!Array.isArray(chat.members) || chat.members.length !== 2) chat.members = [a.login, b.login].sort();
  return chat;
}
/* Собеседник создал комнату со своими людьми: видит её только состав, без исключений для служебных ролей. */
function createRoom(user, title, logins) {
  const members = [...new Set([user.login, ...(logins || []).map(safeLogin)])].filter(l => l !== user.login && accountOf(l));
  if (!members.length) throw Object.assign(new Error('Выберите хотя бы одного участника'), { status: 400 });
  const name = safeText(title, 80) || `Комната · ${user.fio.split(' ')[0]}`;
  if (members.length > 60) throw Object.assign(new Error('В комнате не больше 60 человек'), { status: 400 });
  for (const login of members) if (!directAllowed(user, accountOf(login))) throw Object.assign(new Error('С некоторыми участниками чат недоступен'), { status: 403 });
  const cid = `r:${id().slice(0, 8)}`;
  const chat = normalizeChat({ id: cid, kind: 'room', members: [user.login, ...members].sort(), title: name, owner: user.login, created: new Date().toISOString(), reads: {}, pins: {} });
  DB.chats[cid] = chat;
  return chat;
}
function chatMembers(chat) {
  if (chat.kind === 'direct' || chat.kind === 'room') return (chat.members || []).filter(accountOf);
  return memberLogins(groupOf(chat.group)).map(accountOf).filter(Boolean);
}
function canSeeChat(user, chat) {
  if (chat.kind === 'group') return isService(user) || memberLogins(groupOf(chat.group)).includes(user.login);
  return (chat.members || []).includes(user.login);
}
function chatsOf(user) {
  const list = (isService(user) ? DB.groups : groupsOf(user)).map(ensureGroupChat);
  for (const chat of Object.values(DB.chats)) {
    if (chat.kind === 'group') continue;
    if (!(chat.members || []).includes(user.login)) continue;
    /* Личную переписку с заблокированным убираем из списка: она ждёт в «Заблокированных»,
       а после разблокировки возвращается со всеми сообщениями. */
    if (chat.kind === 'direct') {
      const peer = peerLogin(chat, user.login);
      if (isBlocked(user.login, peer) || isBlocked(peer, user.login)) continue;
    }
    list.push(normalizeChat(chat));
  }
  return list;
}
const peerLogin = (chat, login) => (chat.members || []).find(other => other !== login) || '';
function chatMeta(user, chat) {
  const group = chat.kind === 'group' ? groupOf(chat.group) : null;
  const peer = chat.kind === 'direct' ? accountOf(peerLogin(chat, user.login)) : null;
  const count = chatMembers(chat).length;
  return {
    id: chat.code || chat.id, rawId: chat.id, kind: chat.kind,
    title: group ? group.name : (peer ? peer.fio : chat.title || 'Диалог'),
    subtitle: group ? `${count} в чате` : (peer ? `${ROLE_LABEL[peer.role] || peer.role} · ${peer.group || 'без группы'}` : `${count} участников`),
    peer: peer ? profileView(peer) : null,
    owner: chat.kind === 'room' ? chat.owner : null,
    pinned: !!chat.pins[user.login],
    count,
  };
}
function chatSummary(user, chat) {
  const last = chat.msgs[chat.msgs.length - 1] || null;
  const read = Number(chat.reads[user.login]) || 0;
  return {
    ...chatMeta(user, chat),
    last: last ? { mine: last.by === user.login, name: last.name, text: last.deleted ? 'сообщение удалено' : cut(last.text, 90), ts: last.ts } : null,
    unread: chat.msgs.filter(m => m.by !== user.login && !m.deleted && m.ts > read).length,
  };
}
function contactsOf(user) {
  const out = [];
  for (const other of DB.accounts) {
    if (other.login === user.login || !directAllowed(user, other)) continue;
    const cid = directChatId(user.login, other.login);
    const p = other.profile || normalizeProfile();
    out.push({ login: other.login, fio: other.fio, role: other.role, roleLabel: ROLE_LABEL[other.role] || other.role,
      group: other.group || '', subj: other.subj || '', avatar: p.avatar, verified: !!other.verified,
      chatId: DB.chats[cid] ? DB.chats[cid].code : null });
  }
  return out.sort((a, b) => a.fio.localeCompare(b.fio, 'ru'));
}
/* Список тех, кого пользователь заблокировал — чтобы показать в чатах и вернуть по кнопке. */
function blockedList(user) {
  return (Array.isArray(user.blocked) ? user.blocked : []).map(login => {
    const a = accountOf(login);
    return a ? { login: a.login, fio: a.fio, roleLabel: ROLE_LABEL[a.role] || a.role } : { login, fio: login, roleLabel: '' };
  });
}

const msgRate = new Map();
/* Наружу отдаём только код, но по старому внутреннему идентификатору чат тоже находится —
   так работают ссылки, которые пользователи могли сохранить до появления кодов. */
function findChat(user, ref) {
  const wanted = decodeURIComponent(String(ref || ''));
  let chat = Object.values(DB.chats).find(c => c.code === wanted) || DB.chats[wanted];
  if (!chat && wanted.startsWith('g:')) {
    const group = groupOf(wanted.slice(2));
    if (!group || !(isService(user) || memberLogins(group).includes(user.login))) return null;
    chat = ensureGroupChat(group);
  }
  return chat && canSeeChat(user, chat) ? normalizeChat(chat) : null;
}
function memberViews(chat) {
  return chatMembers(chat).slice(0, 120).map(a => ({
    login: a.login, fio: a.fio, role: a.role, roleLabel: ROLE_LABEL[a.role] || a.role,
    avatar: a.profile?.avatar || '', verified: !!a.verified,
  }));
}
/* Сообщения отдаём вместе с аватаром, галочкой и статусом автора — так чат рисует подпись сразу. */
function messageView(message, viewer) {
  const author = accountOf(message.by);
  const profile = author?.profile || null;
  return {
    id: message.id, mine: message.by === viewer.login, by: message.by,
    name: author ? firstNameOf(author.fio) : message.name, fio: author ? author.fio : message.name, role: message.role || author?.role || '',
    text: message.deleted ? '' : message.text, deleted: !!message.deleted, edited: message.edited || 0,
    system: !!message.system, ts: message.ts,
    avatar: profile?.avatar || '', verified: !!author?.verified, status: profile?.status || null,
    design: profile?.design || 'aurora', canManage: message.by === viewer.login || isService(viewer),
  };
}
function firstNameOf(fio) {
  const parts = String(fio || '').trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[1][0]}.` : String(fio || '');
}
function unreadTotal(account) {
  let total = 0;
  for (const chat of chatsOf(account)) {
    const read = Number(chat.reads[account.login]) || 0;
    total += chat.msgs.filter(m => m.by !== account.login && !m.deleted && m.ts > read).length;
  }
  return total;
}

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
    for (const a of DB.accounts.filter(x => ROLES_STUDENT.includes(x.role) && x.studentIndex === rec.student && x.login !== user.login)) {
      const lesson = lessonAt(a, rec.day, rec.pair);
      notifyUser(a, 'grades', { title: `Новая оценка: ${after[key]}`, body: `${lesson ? lesson.title : `${rec.pair} пара`} · ${dayLabel(rec.day)}` });
    }
  }
}
function homeworkChanged(before, after, user) {
  for (const key of changedKeys(before, after)) {
    const next = after[key]; if (!next || JSON.stringify(before[key]) === JSON.stringify(next)) continue;
    const rec = parseRecordKey(key, false); if (!rec) continue;
    const body = `${cut(next.text, 140)}${next.due ? ` · срок: ${next.due}` : ''}`;
    for (const a of accountsWhere(ROLES_STUDENT, user.login)) {
      const lesson = lessonAt(a, rec.day, rec.pair);
      notifyUser(a, 'hw', { title: `Новое ДЗ · ${lesson ? lesson.title : `${rec.pair} пара`} (${dayLabel(rec.day)})`, body });
    }
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
  const lessons = scheduleOf(groupOf(account.group))?.[weekdayOf(day)]?.lessons || [];
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
      const times = timesOf(groupOf(account.group));
      const lessons = lessonsFor(account, day).filter(l => times[l.n]).sort((a, b) => a.n - b.n);
      lessons.forEach((l, i) => {
        const [start] = times[l.n];
        const prev = lessons[i - 1], gap = prev ? start - times[prev.n][1] : Infinity;
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
  const p = account.profile || normalizeProfile();
  return {
    id: account.id, fio: account.fio, login: account.login, role: account.role, group: account.group || '', subj: account.subj || '',
    studentIndex: account.studentIndex ?? null, perms: PERMS[account.role] || {}, home: HOME[account.role] || 'diary.html',
    bio: p.bio, avatar: p.avatar, banner: p.banner, design: p.design, status: p.status,
    verified: !!account.verified, designs: designOf(account), blocked: (Array.isArray(account.blocked) ? account.blocked : []).length,
  };
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
function lessonAt(account, day, pair) {
  const lessons = scheduleOf(groupOf(account && account.group))?.[weekdayOf(day)]?.lessons || [];
  return lessons.find(lesson => Number(lesson.n) === Number(pair)) || null;
}
function currentPair(user) {
  const now = new Date(), minutes = now.getHours() * 60 + now.getMinutes();
  const times = timesOf(groupOf(user && user.group));
  for (const [number, interval] of Object.entries(times || {})) if (minutes >= interval[0] && minutes < interval[1]) return Number(number);
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
  const lesson = lessonAt(user, day, pair);
  return !!lesson && sameTeacher(lesson.teacher, user.fio);
}

/* ---------- ПРИВАТНОСТЬ ОЦЕНОК ----------
   Оценка видна: преподавателю, который её выставил, куратору группы студента,
   самому студенту и разработчику. Староста и дежурный администратор видят только
   количество — так оценку не «собирают» по всему потоку в чужом журнале. */
function gradeAuthor(key) {
  const meta = DB.gradeMeta[key];
  return meta && typeof meta === 'object' ? { by: String(meta.by || ''), at: String(meta.at || '') } : { by: '', at: '' };
}
function canSeeGrade(user, key) {
  if (user.role === 'dev') return true;
  const student = Number(String(key).split(':')[2]);
  if (ROLES_STUDENT.includes(user.role) && user.studentIndex === student) return true;
  const author = gradeAuthor(key).by;
  if (author && author === user.login) return true;
  if (user.role !== 'curator') return false;
  const group = groupOf(user.group);
  if (!group) return false;
  const account = DB.accounts.find(a => ROLES_STUDENT.includes(a.role) && Number(a.studentIndex) === student);
  return !!account && (account.group === group.id || account.group === group.name);
}
/* Формат в ответе оставляем прежним — числа: ни один клиент не перестаёт их читать.
   Сверху добавляются meta (кто выставил) и hidden (сколько скрытых оценок у студента). */
function gradeView(user) {
  const grades = {}, meta = {}, mine = new Set();
  for (const [key, value] of Object.entries(DB.grades)) {
    if (!canSeeGrade(user, key)) continue;
    mine.add(key);
    grades[key] = Number(value);
    const author = gradeAuthor(key);
    if (author.by) meta[key] = { by: author.by, byName: accountOf(author.by)?.fio || '', at: author.at };
  }
  const hidden = {};
  for (const key of Object.keys(DB.grades)) {
    if (mine.has(key)) continue;
    const student = Number(String(key).split(':')[2]);
    if (Number.isInteger(student)) hidden[student] = (hidden[student] || 0) + 1;
  }
  return { grades, meta, hidden };
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
    const group = groupOf(user.group);
    const groupAccounts = DB.accounts.filter(a => a.role === 'student' && (a.group === group?.id || a.group === group?.name));
    const groupStudentIndices = [...new Set(groupAccounts.map(a => Number(a.studentIndex)).filter(Number.isInteger))];
    const curator = user.role === 'curator';
    const visibleIndices = curator ? new Set(groupStudentIndices) : null;
    /* Оценки фильтруются по правилу «видна автору, куратору, студенту и разработчику»:
       раньше любой преподаватель или староста получал всю таблицу оценок группы. */
    const view = gradeView(user);
    const att = staff ? Object.fromEntries(Object.entries(DB.att).filter(([key]) => !visibleIndices || visibleIndices.has(Number(key.split(':')[2])))) : Object.fromEntries(Object.entries(DB.att).filter(([key]) => Number(key.split(':')[2]) === user.studentIndex));
    const students = curator ? DB.students.map((name, i) => groupStudentIndices.includes(i) ? name : null) : (staff ? DB.students : undefined);
    return json(res, 200, { grades: view.grades, gradeMeta: view.meta, hiddenGrades: view.hidden, att, hw: DB.hw, sch: scheduleOf(group), ev: DB.ev, times: timesOf(group), groupInfo: group ? { name: group.name, specialty: group.specialty, course: group.course, curatorLogin: group.curatorLogin, starostaLogin: group.starostaLogin } : null, start: SCHEDULE_START_ISO, students, groupStudentIndices: curator ? groupStudentIndices : undefined, revision: DB.updatedAt || null });
  }
  if (pathname === '/api/rating' && req.method === 'GET') {
    const user = requireAuth(req, res); if (!user) return;
    return json(res, 200, { ok: true, ...ratingOf(user), revision: DB.updatedAt || null });
  }

  /* ---------- ЧАТЫ: список, создание личного диалога, чтение и отправка ---------- */
  if (pathname === '/api/chats' && req.method === 'GET') {
    const user = requireAuth(req, res); if (!user) return;
    const account = accountOf(user.login);
    const chats = chatsOf(account).map(chat => chatSummary(account, chat))
      .sort((a, b) => (b.pinned - a.pinned) || (b.last ? b.last.ts : 0) - (a.last ? a.last.ts : 0) || a.title.localeCompare(b.title, 'ru'));
    return json(res, 200, { ok: true, chats, contacts: contactsOf(account), blocked: blockedList(account), designs: PROFILE_DESIGNS });
  }
  if (pathname === '/api/chats' && req.method === 'POST') {
    const user = requireAuth(req, res); if (!user) return;
    const input = await readBody(req), other = accountOf(safeLogin(input.to));
    if (!other) return json(res, 404, { ok: false, error: 'Аккаунт не найден' });
    if (isBlocked(user.login, other.login) || isBlocked(other.login, user.login)) return json(res, 403, { ok: false, error: 'Чат с этим человеком недоступен' });
    if (!directAllowed(user, other)) return json(res, 403, { ok: false, error: 'Чат с этим человеком недоступен' });
    const chat = ensureDirectChat(accountOf(user.login), other);
    return json(res, 200, { ok: true, id: chat.code, rawId: chat.id });
  }
  if (pathname === '/api/chats/unread' && req.method === 'GET') {
    const user = requireAuth(req, res); if (!user) return;
    return json(res, 200, { ok: true, unread: unreadTotal(accountOf(user.login)) });
  }
  if (pathname === '/api/rooms' && req.method === 'POST') {
    const user = requireAuth(req, res); if (!user) return;
    const input = await readBody(req);
    const list = Array.isArray(input.members) ? input.members : input.members ? [input.members] : [];
    const chat = createRoom(accountOf(user.login), input.title, list);
    DB.updatedAt = new Date().toISOString(); saveDB();
    const message = { id: id(), by: user.login, name: user.fio, role: user.role, text: safeText(input.first, MSG_MAX) || `Комната «${chat.title}» создана`, ts: Date.now(), system: true };
    chat.msgs.push(message);
    DB.updatedAt = new Date().toISOString(); saveDB();
    return json(res, 201, { ok: true, id: chat.code, title: chat.title, members: chatMembers(chat).length });
  }
  /* Одна группа-код после /api/chat/ — вложенные маршруты (/pin, /message/…) разбираются отдельно. */
  const chatOneMatch = /^\/api\/chat\/([^/]+)$/.exec(pathname);
  if (chatOneMatch && req.method === 'GET') {
    const user = requireAuth(req, res); if (!user) return;
    const account = accountOf(user.login);
    const chat = findChat(account, chatOneMatch[1]);
    if (!chat) return json(res, 404, { ok: false, error: 'Чат не найден' });
    const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
    const last = chat.msgs.length ? chat.msgs[chat.msgs.length - 1].ts : 0;
    if ((Number(chat.reads[account.login]) || 0) < last) { chat.reads[account.login] = last; saveDB(); }
    const messages = chat.msgs.filter(m => m.ts > after).map(m => messageView(m, account));
    return json(res, 200, { ok: true, chat: chatMeta(account, chat), members: memberViews(chat), messages, total: chat.msgs.length });
  }
  if (chatOneMatch && req.method === 'POST') {
    const user = requireAuth(req, res); if (!user) return;
    const account = accountOf(user.login);
    const chat = findChat(account, chatOneMatch[1]);
    if (!chat) return json(res, 404, { ok: false, error: 'Чат не найден' });
    if (chat.kind === 'direct') {
      const other = peerLogin(chat, account.login);
      if (isBlocked(other, account.login)) return json(res, 403, { ok: false, error: 'Пользователь ограничил переписку' });
    }
    const input = await readBody(req), text = safeText(input.text, MSG_MAX);
    if (!text) return json(res, 400, { ok: false, error: 'Сообщение пустое' });
    const now = Date.now();
    if (now - (msgRate.get(user.login) || 0) < 700) return json(res, 429, { ok: false, error: 'Слишком часто — подождите секунду' });
    msgRate.set(user.login, now);
    const message = { id: id(), by: account.login, name: account.fio, role: account.role, text, ts: now };
    chat.msgs.push(message);
    if (chat.msgs.length > MSG_KEEP) chat.msgs.splice(0, chat.msgs.length - MSG_KEEP);
    chat.reads[account.login] = now;
    DB.updatedAt = new Date().toISOString();
    saveDB();
    /* Пуш шлём только личному собеседнику: уведомлять всю группу из-за каждого сообщения слишком шумно */
    if (chat.kind === 'direct' && !isBlocked(account.login, peerLogin(chat, account.login))) {
      const other = accountOf(peerLogin(chat, account.login));
      if (other) notifyUser(other, 'chat', { title: `Новое сообщение · ${cut(account.fio, 40)}`, body: cut(text, 120), url: `/chat/${chat.code}` });
    }
    return json(res, 200, { ok: true, message: messageView(message, account) });
  }
  /* Правка и удаление своего сообщения: админские роли могут убрать чужое (защита от спама). */
  const msgMatch = /^\/api\/chat\/([^/]+)\/message\/([\w-]+)$/.exec(pathname);
  if (msgMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const user = requireAuth(req, res); if (!user) return;
    const account = accountOf(user.login);
    const chat = findChat(account, decodeURIComponent(msgMatch[1]));
    if (!chat) return json(res, 404, { ok: false, error: 'Чат не найден' });
    const message = chat.msgs.find(m => m.id === msgMatch[2]);
    if (!message) return json(res, 404, { ok: false, error: 'Сообщение не найдено' });
    if (message.by !== account.login && !isService(account)) return json(res, 403, { ok: false, error: 'Можно менять только свои сообщения' });
    if (req.method === 'DELETE') { message.deleted = true; delete message.text; }
    else {
      const text = safeText((await readBody(req)).text, MSG_MAX);
      if (!text) return json(res, 400, { ok: false, error: 'Сообщение пустое' });
      message.text = text; message.edited = Date.now();
    }
    DB.updatedAt = new Date().toISOString(); saveDB();
    return json(res, 200, { ok: true, message: messageView(message, account) });
  }
  /* Закрепить/открепить чат — настройка конкретного пользователя, у собеседника она своя. */
  const pinMatch = /^\/api\/chat\/([^/]+)\/pin$/.exec(pathname);
  if (pinMatch && req.method === 'POST') {
    const user = requireAuth(req, res); if (!user) return;
    const account = accountOf(user.login);
    const chat = findChat(account, decodeURIComponent(pinMatch[1]));
    if (!chat) return json(res, 404, { ok: false, error: 'Чат не найден' });
    const input = await readBody(req);
    if (input.pinned) chat.pins[account.login] = Date.now(); else delete chat.pins[account.login];
    saveDB();
    return json(res, 200, { ok: true, pinned: !!input.pinned });
  }
  /* Блокировка: скрывает переписку, запрещает собеседнику писать и убирает его из списка контактов. */
  if (pathname === '/api/block' && req.method === 'POST') {
    const user = requireAuth(req, res); if (!user) return;
    const account = accountOf(user.login), input = await readBody(req), login = safeLogin(input.login);
    if (!login || login === user.login) return json(res, 400, { ok: false, error: 'Некорректный пользователь' });
    if (!accountOf(login)) return json(res, 404, { ok: false, error: 'Аккаунт не найден' });
    const unblock = req.method === 'POST' && input.unblock === true;
    const list = Array.isArray(account.blocked) ? account.blocked : (account.blocked = []);
    if (unblock) account.blocked = list.filter(x => x !== login);
    else if (!list.includes(login)) list.push(login);
    DB.updatedAt = new Date().toISOString(); saveDB();
    return json(res, 200, { ok: true, blocked: !unblock, blockedList: blockedList(account) });
  }

  /* ---------- ПРОФИЛЬ: свои настройки, чужая карточка, загрузка картинок ---------- */
  if (pathname === '/api/profile' && req.method === 'GET') {
    const user = requireAuth(req, res); if (!user) return;
    return json(res, 200, { ok: true, profile: profileView(accountOf(user.login)), designs: PROFILE_DESIGNS });
  }
  if (pathname === '/api/profile' && req.method === 'PUT') {
    const user = requireAuth(req, res); if (!user) return;
    const account = accountOf(user.login), input = await readBody(req);
    const p = normalizeProfile({ ...account.profile, bio: input.bio !== undefined ? safeText(input.bio, 300) : account.profile?.bio });
    if (input.design !== undefined) {
      const design = safeText(input.design, 20);
      if (!isDesignAllowed(account, design)) return json(res, 403, { ok: false, error: 'Это оформление выдаёт разработчик из Студии Плюс' });
      p.design = design;
    }
    if (input.status !== undefined) {
      const kind = input.status === null ? '' : safeText(input.status.kind, 10);
      const value = input.status === null ? '' : safeText(input.status.value, 300);
      if (!kind) p.status = null;
      else if (kind === 'emoji') {
        const chars = Array.from(value).slice(0, EMOJI_MAX).join('');
        p.status = chars ? { kind: 'emoji', value: chars } : null;
      } else if (kind === 'media') {
        if (!safeMediaPath(value)) return json(res, 400, { ok: false, error: 'Сначала загрузите картинку статуса' });
        p.status = { kind: 'media', value };
      } else return json(res, 400, { ok: false, error: 'Неизвестный тип статуса' });
    }
    /* Пустая строка или null в avatar/banner — убрать картинку (файл удаляем после сохранения базы). */
    const stale = [];
    for (const field of ['avatar', 'banner']) {
      if (input[field] === undefined) continue;
      const wanted = input[field] === null || input[field] === '' ? '' : safeMediaPath(input[field]);
      if (input[field] && !wanted) return json(res, 400, { ok: false, error: 'Некорректный адрес картинки' });
      const previous = account.profile?.[field];
      p[field] = wanted;
      if (previous && previous !== wanted) stale.push(previous);
    }
    account.profile = p;
    DB.updatedAt = new Date().toISOString(); saveDB();
    stale.forEach(removeMediaFile);
    return json(res, 200, { ok: true, profile: profileView(account) });
  }
  if (pathname === '/api/profile/media' && req.method === 'POST') {
    const user = requireAuth(req, res); if (!user) return;
    const account = accountOf(user.login), input = await readBody(req);
    const kind = safeText(input.kind, 12);
    if (!MEDIA_KINDS[kind]) return json(res, 400, { ok: false, error: 'Неизвестный тип изображения' });
    let fileUrl;
    try { fileUrl = saveMediaFile(account.login, kind, input.data); }
    catch (e) { return json(res, e.status || 400, { ok: false, error: e.message }); }
    const p = normalizeProfile({ ...account.profile });
    const previous = kind === 'status' ? (p.status?.kind === 'media' ? p.status.value : '') : (p[kind] || '');
    if (kind === 'status') p.status = { kind: 'media', value: fileUrl }; else p[kind] = fileUrl;
    account.profile = p;
    removeMediaFile(previous);
    DB.updatedAt = new Date().toISOString(); saveDB();
    return json(res, 200, { ok: true, url: fileUrl, profile: profileView(account) });
  }
  const profileMatch = /^\/api\/profile\/([a-z0-9_.-]{3,50})$/.exec(pathname);
  if (profileMatch && req.method === 'GET') {
    const user = requireAuth(req, res); if (!user) return;
    const other = accountOf(profileMatch[1]);
    if (!other) return json(res, 404, { ok: false, error: 'Аккаунт не найден' });
    const account = accountOf(user.login);
    const cid = directChatId(account.login, other.login);
    const chat = DB.chats[cid];
    return json(res, 200, {
      ok: true, profile: profileView(other),
      canChat: !!directAllowed(account, other),
      chatId: chat && canSeeChat(account, chat) ? chat.code : null,
      blocked: isBlocked(account.login, other.login), blockedMe: isBlocked(other.login, account.login),
    });
  }
  /* Выдача эксклюзивных оформлений, галочки «проверенный» и статуса — только разработчик. */
  const grantMatch = /^\/api\/accounts\/([a-z0-9_.-]{3,50})\/grant$/.exec(pathname);
  if (grantMatch && req.method === 'POST') {
    const user = requireAuth(req, res); if (!user) return;
    if (user.role !== 'dev') return json(res, 403, { ok: false, error: 'Выдавать привилегии может только разработчик' });
    const other = accountOf(grantMatch[1]);
    if (!other) return json(res, 404, { ok: false, error: 'Аккаунт не найден' });
    const input = await readBody(req);
    if (input.design !== undefined) {
      const design = safeText(input.design, 20), take = input.grant !== false;
      if (!DESIGN_IDS.includes(design)) return json(res, 400, { ok: false, error: 'Неизвестное оформление' });
      const granted = new Set(Array.isArray(other.designs) ? other.designs : []);
      if (take) granted.add(design); else { granted.delete(design); if (other.profile?.design === design) other.profile.design = 'aurora'; }
      other.designs = [...granted].filter(d => DESIGN_IDS.includes(d));
    }
    if (input.verified !== undefined) other.verified = !!input.verified;
    if (input.statusEmoji !== undefined) {
      const chars = Array.from(safeText(input.statusEmoji, 40)).slice(0, EMOJI_MAX).join('');
      other.profile = normalizeProfile({ ...other.profile, status: chars ? { kind: 'emoji', value: chars } : null });
    }
    if (input.statusMedia !== undefined) {
      const value = safeMediaPath(input.statusMedia);
      other.profile = normalizeProfile({ ...other.profile, status: value ? { kind: 'media', value } : null });
    }
    DB.updatedAt = new Date().toISOString(); saveDB();
    return json(res, 200, { ok: true, profile: profileView(other) });
  }

  if (pathname.startsWith('/api/state/') && req.method === 'PUT') {
    const part = pathname.split('/')[3], user = requireAuth(req, res); if (!user) return;
    const input = await readBody(req);
    if (part === 'sch') {
      if (!can(user, 'schedule')) return json(res, 403, { ok: false, error: 'Нет права менять расписание' });
      const group = groupOf(user.group);
      if (group) group.schedule = sanitizeSchedule(input, timesOf(group)); else DB.sch = sanitizeSchedule(input); scheduleChanged(user.login);
    } else if (part === 'ev') {
      if (!can(user, 'events')) return json(res, 403, { ok: false, error: 'Нет права менять мероприятия' });
      const prevEv = DB.ev; DB.ev = sanitizeEvents(input); eventsChanged(prevEv || {}, DB.ev, user);
    } else if (part === 'times') {
      if (!can(user, 'times')) return json(res, 403, { ok: false, error: 'Нет права менять время пар' });
      const group = groupOf(user.group);
      if (group) group.times = sanitizeTimes(input); else DB.times = sanitizeTimes(input); scheduleChanged(user.login);
    } else if (part === 'grades') {
      if (!can(user, 'grades') || !validStateObject(input)) return json(res, 403, { ok: false, error: 'Нет права менять оценки' });
      const curatorGroup = user.role === 'curator' || user.role === 'dev' ? studentIndicesOf(groupOf(user.group)) : null;
      const next = clone(DB.grades), meta = { ...DB.gradeMeta };
      const touched = [];
      for (const [key, value] of Object.entries(input)) {
        const record = parseRecordKey(key, true);
        if (!record) return json(res, 400, { ok: false, error: 'Некорректный ключ оценки' });
        const removal = value === null || value === undefined || value === '';
        if (!removal && ![2, 3, 4, 5].includes(Number(value))) return json(res, 400, { ok: false, error: 'Некорректная оценка' });
        /* Право на правку: разработчик — всё, куратор — свою группу, преподаватель — только свою текущую пару. */
        const allowed = user.role === 'dev'
          || (user.role === 'curator' && curatorGroup.includes(record.student))
          || (user.role !== 'curator' && teacherOwns(user, record.day, record.pair) && record.day === todayOffset() && currentPair(user) === record.pair);
        if (!allowed) return json(res, 403, { ok: false, error: user.role === 'curator' ? 'Оценки доступны только вашей группе' : 'Оценки доступны только на своей текущей паре' });
        /* Снять чужую оценку преподаватель не может: её выставил другой человек. */
        const author = gradeAuthor(key).by;
        if (removal && user.role === 'teacher' && author && author !== user.login) return json(res, 403, { ok: false, error: 'Эту оценку выставил другой преподаватель' });
        if (removal) { delete next[key]; delete meta[key]; touched.push(key); continue; }
        if (Number(next[key]) === Number(value)) continue;   // значение не изменилось — автора не переустанавливаем
        next[key] = Number(value);
        meta[key] = { by: user.login, at: new Date().toISOString() };
        touched.push(key);
      }
      const prevGrades = DB.grades; DB.grades = next; DB.gradeMeta = meta;
      gradesChanged(prevGrades, DB.grades, user);
    } else if (part === 'att') {
      if (!validStateObject(input) || (!can(user, 'attendance') && !can(user, 'ownAttendance'))) return json(res, 403, { ok: false, error: 'Нет права менять посещаемость' });
      const next = clone(DB.att);
      for (const [key, value] of Object.entries(input)) {
        const record = parseRecordKey(key, true);
        const removal = value === null || value === undefined;
        if (!record) return json(res, 400, { ok: false, error: 'Некорректный ключ посещаемости' });
        if (!removal && (!['У', 'Н', 'О', 'Б'].includes(value.t) || (value.t === 'О' && (!Number.isInteger(value.min) || value.min < 1 || value.min > 300)))) return json(res, 400, { ok: false, error: 'Некорректная отметка посещаемости' });
        if (user.role === 'teacher' && (!teacherOwns(user, record.day, record.pair) || record.day !== todayOffset() || currentPair(user) !== record.pair)) return json(res, 403, { ok: false, error: 'Отметки доступны только на своей текущей паре' });
        if (removal) delete next[key]; else next[key] = value;
      }
      DB.att = next;
    } else if (part === 'hw') {
      if (!validStateObject(input) || (!can(user, 'homework') && !can(user, 'ownHomework'))) return json(res, 403, { ok: false, error: 'Нет права менять ДЗ' });
      const next = clone(DB.hw);
      for (const [key, value] of Object.entries(input)) {
        const record = parseRecordKey(key, false);
        const before = DB.hw[key], removal = value === null || value === undefined;
        if (!record) return json(res, 400, { ok: false, error: 'Некорректный ключ ДЗ' });
        if (user.role === 'teacher' && !teacherOwns(user, record.day, record.pair)) return json(res, 403, { ok: false, error: 'Можно менять ДЗ только своего предмета' });
        if (user.role === 'starosta' && before?.byRole === 'teacher') return json(res, 403, { ok: false, error: 'ДЗ преподавателя нельзя изменить' });
        if (removal) { delete next[key]; continue; }
        if (!safeText(value.text, 2000)) return json(res, 400, { ok: false, error: 'Введите текст ДЗ' });
        next[key] = { text: safeText(value.text, 2000), due: safeText(value.due, 80), src: safeText(value.src, 120), by: user.fio, byRole: user.role === 'teacher' ? 'teacher' : user.role, updatedAt: new Date().toISOString() };
      }
      const prevHw = DB.hw; DB.hw = next; homeworkChanged(prevHw, next, user);
    } else return json(res, 404, { ok: false, error: 'Неизвестный раздел' });
    DB.updatedAt = new Date().toISOString(); saveDB();
    return json(res, 200, { ok: true, part, revision: DB.updatedAt });
  }

  if (pathname === '/api/schedule/import' && req.method === 'POST') {
    const user = requireAuth(req, res, 'schedule'); if (!user) return;
    const input = await readBody(req);
    const group = groupOf(user.group);
    let times = timesOf(group);
    if (input.times && typeof input.times === 'object' && Object.keys(input.times).length) {
      if (!can(user, 'times')) return json(res, 403, { ok: false, error: 'Нет права менять время пар' });
      times = sanitizeTimes({ ...times, ...input.times });
    }
    const sch = sanitizeSchedule(input.sch, times);
    if (group) { group.times = times; group.schedule = sch; } else { DB.times = times; DB.sch = sch; }
    scheduleChanged(user.login);
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
    DB.groups = DB.groups.filter(g => g !== group);
    for (const [cid, chat] of Object.entries(DB.chats)) if (chat.kind === 'group' && (chat.group === gid || chat.title === gid)) delete DB.chats[cid];
    saveDB(); return json(res, 200, { ok: true });
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
  /* Правка аккаунта разработчиком: ФИО, роль, группа, предмет, сброс пароля. */
  const accountEditMatch = /^\/api\/accounts\/([a-z0-9_.-]{3,50})$/.exec(pathname);
  if (accountEditMatch && ['PATCH', 'PUT'].includes(req.method)) {
    const user = requireAuth(req, res); if (!user) return;
    if (user.role !== 'dev') return json(res, 403, { ok: false, error: 'Править аккаунты может только разработчик' });
    const login = accountEditMatch[1], other = accountOf(login);
    if (!other) return json(res, 404, { ok: false, error: 'Аккаунт не найден' });
    if (other.role === 'dev') return json(res, 403, { ok: false, error: 'Аккаунт разработчика управляется через env' });
    const input = await readBody(req);
    if (input.fio !== undefined) {
      const fio = safeText(input.fio, 150);
      if (!fio) return json(res, 400, { ok: false, error: 'Укажите ФИО' });
      other.fio = fio;
    }
    if (input.subj !== undefined) other.subj = safeText(input.subj, 300);
    if (input.password !== undefined) {
      if (String(input.password).length < 8) return json(res, 400, { ok: false, error: 'Пароль должен содержать не менее 8 символов' });
      other.passHash = hashPassword(input.password);
      for (const [key, session] of Object.entries(DB.sessions)) if (session.login === login) delete DB.sessions[key];
    }
    if (input.role !== undefined) {
      const role = safeText(input.role, 20);
      if (!['student', 'starosta', 'teacher', 'curator', 'admin'].includes(role)) return json(res, 400, { ok: false, error: 'Некорректная роль' });
      const needsGroup = ['student', 'starosta', 'curator'].includes(role);
      let groupRecord = null;
      if (needsGroup) {
        const groupName = input.group !== undefined ? safeText(input.group, 80) : other.group;
        groupRecord = DB.groups.find(g => g.id === groupName || g.name === groupName);
        if (!groupRecord) return json(res, 400, { ok: false, error: 'Выберите существующую группу' });
      }
      if (role !== other.role && ['curator', 'starosta'].includes(other.role)) {
        for (const g of DB.groups) { if (g.curatorLogin === login) g.curatorLogin = ''; if (g.starostaLogin === login) g.starostaLogin = ''; }
      }
      if (['student', 'starosta'].includes(role) && !Number.isInteger(other.studentIndex)) {
        const shortName = other.fio.split(' ').slice(0, 2).join(' ');
        const found = DB.students.indexOf(shortName);
        other.studentIndex = found >= 0 ? found : (DB.students.push(shortName) - 1);
      }
      if (role === 'teacher') other.studentIndex = null;
      other.role = role;
      other.group = needsGroup ? groupRecord.id : '';
      if (role === 'curator' && groupRecord) {
        if (groupRecord.curatorLogin && groupRecord.curatorLogin !== login) return json(res, 409, { ok: false, error: 'У группы уже назначен куратор' });
        groupRecord.curatorLogin = login;
      }
      if (role === 'starosta' && groupRecord) {
        if (groupRecord.starostaLogin && groupRecord.starostaLogin !== login) return json(res, 409, { ok: false, error: 'У группы уже назначен староста' });
        groupRecord.starostaLogin = login;
      }
    }
    DB.updatedAt = new Date().toISOString(); saveDB();
    return json(res, 200, { ok: true, user: accountView(other) });
  }
  /* Смена собственного пароля: старый спрашиваем обязательно. */
  if (pathname === '/api/password' && req.method === 'POST') {
    const user = requireAuth(req, res); if (!user) return;
    const account = accountOf(user.login), input = await readBody(req);
    if (!verifyPassword(input.current, account.passHash)) return json(res, 401, { ok: false, error: 'Текущий пароль неверный' });
    if (String(input.password || '').length < 8) return json(res, 400, { ok: false, error: 'Новый пароль должен содержать не менее 8 символов' });
    account.passHash = hashPassword(input.password);
    const currentHash = sha256(cookies(req)[COOKIE] || '');
    for (const [key, session] of Object.entries(DB.sessions)) if (session.login === account.login && key !== currentHash) delete DB.sessions[key];
    saveDB();
    return json(res, 200, { ok: true });
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
    for (const [cid, chat] of Object.entries(DB.chats)) if ((chat.members || []).includes(login)) delete DB.chats[cid];
    for (const [key, session] of Object.entries(DB.sessions)) if (session.login === login) delete DB.sessions[key];
    for (const other of DB.accounts) if (Array.isArray(other.blocked)) other.blocked = other.blocked.filter(x => x !== login);
    const p = removed.profile;
    if (p) for (const file of [p.avatar, p.banner, p.status?.value]) removeMediaFile(file);
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
    /* Картинки профиля относятся к удалённым аккаунтам — чистим и каталог медиа. */
    try { fs.rmSync(MEDIA_DIR, { recursive: true, force: true }); } catch (e) { console.error('Каталог media не очищен:', e.message); }
    console.log(`База данных очищена разработчиком. Файл: ${DB_FILE}`);
    return json(res, 200, { ok: true, message: 'База очищена. Аккаунт разработчика сохранён.' });
  }
  return json(res, 404, { ok: false, error: 'Метод не найден' });
}

const STATIC_FILES = new Set(['/sw.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/og-image.png', '/splash.js', '/theme.js', '/theme.css']);
const MIME = { '.webmanifest': 'application/manifest+json; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon' };
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
    /* Картинки профилей: только файлы из data/media, по строгим именам. */
    if (pathname.startsWith('/media/')) {
      const name = pathname.slice('/media/'.length);
      if (!safeMediaPath('/media/' + name)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Файл не найден');
      }
      return fs.readFile(path.join(MEDIA_DIR, name), (error, data) => {
        if (error) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Файл не найден'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(name).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=31536000, immutable' });
        res.end(data);
      });
    }
    /* Страница чатов доступна и как /chat.html, и как /chat/<код> — код виден в адресе и по нему
       открывается нужный чат, такую ссылку можно отправить собеседнику. */
    const chatCode = /^\/chat\/([a-z0-9]{4,24})$/i.exec(pathname);
    const file = chatCode || pathname === '/chat' || pathname === '/chat/' ? 'chat.html' : pathname.slice(1);
    const guarded = chatCode || pathname === '/chat' || pathname === '/chat/' ? '/chat.html' : pathname;
    if (PAGE_PERM[guarded]) {
      const user = auth(req);
      if (!user) { res.writeHead(302, { Location: `/login.html?next=${encodeURIComponent(pathname)}` }); return res.end(); }
      if (!can(user, PAGE_PERM[guarded])) { res.writeHead(302, { Location: `/${user.home}` }); return res.end(); }
    }
    if (pathname === '/login.html' && auth(req)) {
      const user = auth(req); res.writeHead(302, { Location: `/${user.home}` }); return res.end();
    }
    if (!STATIC_FILES.has(pathname) && !/^\/(index|login|diary|studio|zhurnal|STplus|chat)\.html$/.test(pathname) && !chatCode && pathname !== '/chat' && pathname !== '/chat/') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Страница не найдена');
    }
    fs.readFile(path.join(ROOT, file), (error, data) => {
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
/**
 * Tsunagari WhatsApp Bot (Evolution + Notion + Trello + OpenAI) — “produção”
 * server.js v3 (sem Redis; robusto contra concorrência, duplicatas e oscilações)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

// ===== ENV =====
const {
  // OpenAI
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",

  // Evolution
  EVOLUTION_SERVER_URL,
  EVOLUTION_APIKEY,
  EVOLUTION_INSTANCE = "n8n Tsunagari",
  EVOLUTION_SEND_PATH = "/message/sendText",

  // Admin alerts
  ADMIN_WHATSAPP = "",

  // Production knobs
  HANDOFF_MINUTES = "180",
  COOLDOWN_MS = "1500",
  DEDUPE_TTL_MS = "600000",
  MISSING_REPEAT_SUPPRESS_MS = "60000",

  MAX_BODY_BYTES = "1048576",          // 1MB
  FLUSH_STATE_MS = "500",             // debounce flush
  LOCK_STALE_MS = "60000",            // 60s failsafe
  ADMIN_ALERT_COOLDOWN_MS = "120000", // 2min

  // Notion
  NOTION_TOKEN,
  NOTION_WELCOME_NAME = "Mensagem de boas vindas:",
  NOTION_DB_RESTAURANTE = "2bf12169-2df7-806a-82cc-d8c1c3e39202",
  NOTION_DB_POLITICA = "2b512169-2df7-80f2-ab82-c358e0393ace",
  NOTION_DB_PRECOS = "2b512169-2df7-8065-84c2-ea856c101a2d",
  NOTION_DB_PROMOCOES = "2b512169-2df7-8005-b897-d229a7c10f32",
  NOTION_DB_RESERVAS = "2b412169-2df7-80c8-ab03-fcd7af2b673e",
  NOTION_DB_REGRAS = "2b512169-2df7-804d-a6ed-f7417e299ef5",
  NOTION_DB_CARDAPIO = "",

  // Trello
  TRELLO_KEY,
  TRELLO_TOKEN,
  TRELLO_BOARD_ID = "692c6640823f97382fc10a57",

  // Reserva rules
  RESERVA_MAX_TOTAL_DIA = "13",
  RESERVA_MAX_2P_DIA = "4",
  RESERVA_HORA_MAX = "19:45",

  // Calendar rules
  FECHADO_DOMINGO = "1",
  MAX_ADVANCE_DAYS = "120",
} = process.env;

// ===== Helpers =====
function must(name, val) {
  if (!val) throw new Error(`Falta ${name} nas Environment Variables do EasyPanel`);
}
function nowIso() { return new Date().toISOString(); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeGreeting(text) {
  const t = normalizeText(text);
  return /^(oi|ola|oie+|bom dia|boa tarde|boa noite)\b/.test(t);
}

/**
 * Intent de reserva mais rígido:
 * NÃO usa “pra amanhã/pra hoje” como gatilho sozinho
 */
function looksLikeReservaIntent(text) {
  const t = normalizeText(text);
  return (
    t.includes("reserva") ||
    t.includes("reservar") ||
    t.includes("quero reservar") ||
    t.includes("mesa") ||
    t.includes("agendar") ||
    t.includes("marcar")
  );
}

function isAffirmative(text) {
  const t = normalizeText(text);
  return (
    t === "sim" || t === "s" || t === "ok" || t === "okk" || t === "blz" ||
    t === "beleza" || t === "pode" || t === "pode sim" || t === "pode ser" ||
    t === "fechado" || t === "confirmo" || t === "confirmado"
  );
}

function extractIncomingText(bodyJson) {
  const msg = bodyJson?.data?.message || {};
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    ""
  ).trim();
}

function getIncomingMessageId(bodyJson) {
  return bodyJson?.data?.key?.id || bodyJson?.data?.messageId || bodyJson?.data?.id || "";
}

// ===== Hard rules =====
function asksNonJapaneseFood(text) {
  const t = normalizeText(text);
  return /\b(pizza|hamburguer|hamburger|hambúrguer|burger|x[-\s]?burger|lanche|esfiha|pastel|churrasco|lasanha|macarrao|macarrão)\b/.test(t);
}

function looksLikeOrderIntent(text) {
  const t = normalizeText(text);
  return (
    /\b(pedido|pedir|quero pedir|vou querer|me ve|me vê|manda|entrega|delivery|retirar|take away|para viagem)\b/.test(t) ||
    /\b(ifood|i-food|ubereats|uber eats|rappi)\b/.test(t)
  );
}

// ======= Global State (in-memory + flush to file) =======
const STATE_PATH = path.join(process.cwd(), "state.json");
let STATE = { conversations: {}, admin: {} };
let flushTimer = null;
let flushDirty = false;

function loadStateFromDisk() {
  try {
    STATE = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (!STATE.conversations) STATE.conversations = {};
    if (!STATE.admin) STATE.admin = {};
  } catch {
    STATE = { conversations: {}, admin: {} };
  }
}

function atomicWriteFile(filePath, content) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

function scheduleFlush() {
  flushDirty = true;
  if (flushTimer) return;
  const ms = Math.max(50, Number(FLUSH_STATE_MS || 500));
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!flushDirty) return;
    flushDirty = false;
    try {
      atomicWriteFile(STATE_PATH, JSON.stringify(STATE, null, 2));
    } catch (e) {
      console.error(`[${nowIso()}] state_flush_failed`, e?.message || e);
    }
  }, ms);
}

function getConv(jid) { return STATE.conversations[jid] || null; }
function setConv(jid, conv) { STATE.conversations[jid] = conv; scheduleFlush(); }
function clearConv(jid) { delete STATE.conversations[jid]; scheduleFlush(); }

function setHandoffPause(remoteJid, minutes) {
  const existing = getConv(remoteJid) || { mode: null, data: {} };
  existing.handoffUntil = Date.now() + minutes * 60 * 1000;
  existing.handoffAt = Date.now();
  existing.mode = existing.mode || null;
  existing.data = existing.data || {};
  setConv(remoteJid, existing);
}

function shouldThrottle(existingConv) {
  const cooldown = Math.max(0, Number(COOLDOWN_MS || 0));
  if (!cooldown) return false;
  const last = Number(existingConv?.lastBotReplyAt || 0);
  return Date.now() - last < cooldown;
}

function markBotReplied(remoteJid) {
  const c = getConv(remoteJid) || { mode: null, data: {} };
  c.lastBotReplyAt = Date.now();
  setConv(remoteJid, c);
}

function isDuplicateAndMark(remoteJid, msgId) {
  if (!msgId) return false;
  const ttl = Math.max(60_000, Number(DEDUPE_TTL_MS || 600_000));
  const c = getConv(remoteJid) || { mode: null, data: {} };
  if (!c.seen) c.seen = {};
  for (const [id, ts] of Object.entries(c.seen)) {
    if (Date.now() - Number(ts || 0) > ttl) delete c.seen[id];
  }
  if (c.seen[msgId]) {
    setConv(remoteJid, c);
    return true;
  }
  c.seen[msgId] = Date.now();
  setConv(remoteJid, c);
  return false;
}

// ===== Lock / queue per remoteJid =====
const jidQueue = new Map();

function withJidLock(remoteJid, fn) {
  const prev = jidQueue.get(remoteJid) || Promise.resolve();

  const task = prev
    .catch(() => {})
    .then(async () => {
      const staleMs = Math.max(5_000, Number(LOCK_STALE_MS || 60_000));
      return await Promise.race([
        fn(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("lock_stale_timeout")), staleMs)),
      ]);
    })
    .finally(() => {
      if (jidQueue.get(remoteJid) === task) jidQueue.delete(remoteJid);
    });

  jidQueue.set(remoteJid, task);
  return task;
}

// ===== fetch retry + circuit breaker =====
class CircuitBreaker {
  constructor({ failThreshold = 4, resetMs = 60_000 } = {}) {
    this.failThreshold = failThreshold;
    this.resetMs = resetMs;
    this.failCount = 0;
    this.openUntil = 0;
  }
  canRun() { return !this.openUntil || Date.now() > this.openUntil; }
  success() { this.failCount = 0; this.openUntil = 0; }
  fail() {
    this.failCount++;
    if (this.failCount >= this.failThreshold) this.openUntil = Date.now() + this.resetMs;
  }
}

const CB = {
  notion: new CircuitBreaker({ failThreshold: 4, resetMs: 60_000 }),
  trello: new CircuitBreaker({ failThreshold: 4, resetMs: 60_000 }),
  openai: new CircuitBreaker({ failThreshold: 4, resetMs: 60_000 }),
  evolution: new CircuitBreaker({ failThreshold: 6, resetMs: 30_000 }),
};

async function fetchWithRetry(url, opts = {}, { tries = 4, baseDelayMs = 300, service = "generic" } = {}) {
  let lastErr = null;

  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.status === 429 || (r.status >= 500 && r.status <= 599)) {
        const body = await r.text().catch(() => "");
        lastErr = new Error(`${service} http ${r.status}: ${body.slice(0, 500)}`);
      } else {
        return r;
      }
    } catch (e) {
      lastErr = e;
    }

    const delay = baseDelayMs * Math.pow(2, i) + Math.floor(Math.random() * 200);
    await sleep(delay);
  }

  throw lastErr || new Error(`${service} fetch failed`);
}

// ===== Evolution send + admin notify =====
async function evolutionSendText({ remoteJid, text }) {
  if (!CB.evolution.canRun()) throw new Error("evolution_circuit_open");
  const number = (remoteJid || "").split("@")[0];
  const url =
    EVOLUTION_SERVER_URL.replace(/\/$/, "") +
    EVOLUTION_SEND_PATH +
    "/" +
    encodeURIComponent(EVOLUTION_INSTANCE);

  try {
    const r = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: EVOLUTION_APIKEY },
        body: JSON.stringify({ number, text }),
      },
      { tries: 4, baseDelayMs: 250, service: "evolution" }
    );
    const body = await r.text();
    if (!r.ok) throw new Error(`Evolution send failed ${r.status}: ${body}`);
    CB.evolution.success();
    return body;
  } catch (e) {
    CB.evolution.fail();
    throw e;
  }
}

async function notifyAdminOncePerWindow(key, text) {
  if (!ADMIN_WHATSAPP) return;
  const cool = Math.max(10_000, Number(ADMIN_ALERT_COOLDOWN_MS || 120_000));
  const lastAt = Number(STATE.admin?.[key] || 0);
  if (Date.now() - lastAt < cool) return;

  STATE.admin[key] = Date.now();
  scheduleFlush();

  try {
    await evolutionSendText({ remoteJid: `${ADMIN_WHATSAPP}@s.whatsapp.net`, text });
  } catch (e) {
    console.error(`[${nowIso()}] admin_notify_failed`, e?.message || e);
  }
}

// ===== Notion =====
async function notionQueryAllRows(dbId, pageSize = 100) {
  if (!CB.notion.canRun()) throw new Error("notion_circuit_open");

  let cursor = undefined;
  const rows = [];

  try {
    for (let i = 0; i < 20; i++) {
      const body = { page_size: pageSize };
      if (cursor) body.start_cursor = cursor;

      const r = await fetchWithRetry(
        `https://api.notion.com/v1/databases/${dbId}/query`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${NOTION_TOKEN}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
        { tries: 4, baseDelayMs: 350, service: "notion" }
      );

      const j = await r.json();
      if (!r.ok) throw new Error(`Notion query failed ${r.status}: ${JSON.stringify(j)}`);

      for (const p of j.results || []) {
        const name = p.properties?.Nome?.title?.map((t) => t.plain_text).join("") || "";
        const text = p.properties?.Texto?.rich_text?.map((t) => t.plain_text).join("") || "";
        const nm = name.trim();
        const tx = text.trim();
        if (!nm && !tx) continue;
        rows.push({ name: nm, text: tx });
      }

      if (!j.has_more) break;
      cursor = j.next_cursor;
    }

    CB.notion.success();
    return rows;
  } catch (e) {
    CB.notion.fail();
    throw e;
  }
}

async function notionFindExactByName(dbId, name) {
  if (!CB.notion.canRun()) throw new Error("notion_circuit_open");
  try {
    const r = await fetchWithRetry(
      `https://api.notion.com/v1/databases/${dbId}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${NOTION_TOKEN}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          page_size: 10,
          filter: { property: "Nome", title: { equals: name } },
        }),
      },
      { tries: 4, baseDelayMs: 350, service: "notion" }
    );

    const j = await r.json();
    if (!r.ok) throw new Error(`Notion query failed ${r.status}: ${JSON.stringify(j)}`);

    const page = j.results?.[0];
    if (!page) return null;

    const text = page.properties?.Texto?.rich_text?.map((t) => t.plain_text).join("") || "";
    CB.notion.success();
    return text.trim() || null;
  } catch (e) {
    CB.notion.fail();
    throw e;
  }
}

// ===== Knowledge cache =====
let KNOWLEDGE = [];
let lastLoadAt = 0;
let knowledgeLoading = null;

async function loadKnowledge() {
  const dbs = [
    { name: "restaurante", id: NOTION_DB_RESTAURANTE },
    { name: "politica", id: NOTION_DB_POLITICA },
    { name: "precos", id: NOTION_DB_PRECOS },
    { name: "promocoes", id: NOTION_DB_PROMOCOES },
    { name: "reservas", id: NOTION_DB_RESERVAS },
    { name: "regras", id: NOTION_DB_REGRAS },
  ];
  if (NOTION_DB_CARDAPIO) dbs.push({ name: "cardapio", id: NOTION_DB_CARDAPIO });

  const all = [];
  for (const db of dbs) {
    const rows = await notionQueryAllRows(db.id);
    for (const r of rows) all.push({ ...r, db: db.name });
  }

  KNOWLEDGE = all;
  lastLoadAt = Date.now();
  console.log(`[${nowIso()}] Knowledge loaded: ${KNOWLEDGE.length} rows`);
}

async function ensureKnowledgeFresh() {
  const maxAgeMs = 5 * 60 * 1000;
  if (Date.now() - lastLoadAt <= maxAgeMs) return;
  if (knowledgeLoading) return knowledgeLoading;

  knowledgeLoading = (async () => {
    try { await loadKnowledge(); }
    finally { knowledgeLoading = null; }
  })();

  return knowledgeLoading;
}

// ===== Retrieve =====
function simpleRetrieve(question, knowledgeRows, k = 12) {
  const q = normalizeText(question);
  const qWords = new Set(q.split(" ").filter((w) => w.length >= 3));

  const scored = [];
  for (const row of knowledgeRows) {
    const hay = normalizeText(row.name + " " + row.text);
    let score = 0;
    for (const w of qWords) if (hay.includes(w)) score++;
    if (score > 0) scored.push({ score, row });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((x) => x.row);
}

// ===== Links / sanitize =====
function shouldAllowLinks(question) {
  const q = normalizeText(question);
  return (
    q.includes("link") ||
    q.includes("cardapio") ||
    q.includes("cardápio") ||
    q.includes("menu") ||
    q.includes("endereco") ||
    q.includes("endereço") ||
    q.includes("maps") ||
    q.includes("localizacao") ||
    q.includes("localização") ||
    q.includes("como chegar")
  );
}
function unmarkdownLinks(t) {
  return (t || "").replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi, "$2");
}
function stripLinks(text) {
  let t = text || "";
  t = t.replace(/\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/gi, "");
  t = t.replace(/https?:\/\/\S+/gi, "");
  return t;
}
function sanitizeAnswer(text, question) {
  let t = (text || "").trim();

  // remove leading greeting
  t = t.replace(
    /^(oi|ol[aá]|oie+)\s*[!,.:;\-–—]*\s*(?:[A-Za-zÀ-ÿ0-9_.-]{2,30})?\s*[!,.:;\-–—]*\s*/i,
    ""
  );

  // remove closings
  const closings = [
    /\babracos\b\.?\s*$/i,
    /\babraços\b\.?\s*$/i,
    /\baproveite( o)? seu dia\b\.?\s*$/i,
    /\btenha um (otimo|ótimo) dia\b\.?\s*$/i,
    /\bate mais\b\.?\s*$/i,
    /\baté mais\b\.?\s*$/i,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    const before = t;
    for (const re of closings) t = t.replace(re, "");
    t = t.trim();
    if (t !== before) changed = true;
  }

  if (shouldAllowLinks(question)) t = unmarkdownLinks(t);
  else t = stripLinks(t);

  t = t.replace(/[ \t]+ /g, " ").replace(/ {3,}/g, " ").trim();
  return t.trim();
}

// ===== OpenAI =====
async function openaiAnswer({ question, retrieved }) {
  if (!CB.openai.canRun()) throw new Error("openai_circuit_open");

  const sys = `
Você é a Liz, assistente do restaurante Tsunagari (WhatsApp).
Tom:
- Carinhoso e acolhedor.
- Use 1 a 2 emojis leves quando combinar (🍣✨🙏😊❤️🍷). Não exagerar.
- NÃO use o nome do cliente.
- NÃO comece com saudação ("Olá", "Oi", "Oie").
- NÃO finalize com despedidas ("abraços", "até mais", "aproveite o dia").
Conteúdo:
- Responda SOMENTE o que o cliente perguntou. Não fuja do assunto.
- NÃO envie links a menos que o cliente peça link.
- Não invente informações; use apenas os trechos fornecidos.
- Se faltou informação, faça uma pergunta curta e objetiva.
Formato:
- 1 a 3 linhas curtas, estilo WhatsApp.
`.trim();

  const context = retrieved
    .map((r, i) => `[#${i + 1}] (${r.db}) ${r.name} ${r.text}`)
    .join(" ");

  const user = `
Pergunta do cliente: ${question}
Trechos do Notion: ${context || "(nenhuma informação relevante encontrada)"}
`.trim();

  try {
    const r = await fetchWithRetry(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          input: [{ role: "system", content: sys }, { role: "user", content: user }],
          temperature: 0.25,
        }),
      },
      { tries: 4, baseDelayMs: 400, service: "openai" }
    );

    const j = await r.json();
    if (!r.ok) throw new Error(`OpenAI failed ${r.status}: ${JSON.stringify(j)}`);

    const out = (j.output || []).flatMap((o) => o.content || []);
    const raw = out
      .filter((c) => c.type === "output_text")
      .map((c) => c.text)
      .join("")
      .trim();

    CB.openai.success();
    return sanitizeAnswer(raw, question);
  } catch (e) {
    CB.openai.fail();
    throw e;
  }
}

// ===== Reserva parsing / validation =====
function parseDateToListName(text) {
  const m = text.match(/\b([0-3]?\d)\/([01]?\d)(?:\/(\d{2}|\d{4}))?\b/);
  if (!m) return null;
  let dd = m[1].padStart(2, "0");
  let mm = m[2].padStart(2, "0");
  let yy = m[3];
  if (!yy) {
    const now = new Date();
    yy = String(now.getFullYear()).slice(-2);
  } else if (yy.length === 4) {
    yy = yy.slice(-2);
  }
  return `${dd}/${mm}/${yy}`;
}

function parseDateBR(text) {
  const m = text.match(/\b([0-3]?\d)\/([01]?\d)(?:\/(\d{2}|\d{4}))?\b/);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  let yyyy = m[3] ? Number(m[3].length === 2 ? "20" + m[3] : m[3]) : new Date().getFullYear();
  return { dd, mm, yyyy };
}

function dateBRToUTCDate({ dd, mm, yyyy }) {
  return new Date(Date.UTC(yyyy, mm - 1, dd, 0, 0, 0));
}
function isSundayBR(dateObj) {
  return dateBRToUTCDate(dateObj).getUTCDay() === 0;
}
function isPastDateBR(dateObj) {
  const d = dateBRToUTCDate(dateObj);
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  return d < todayUTC;
}
function daysFromTodayBR(dateObj) {
  const d = dateBRToUTCDate(dateObj);
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const diffMs = d - todayUTC;
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

function parseTime(text) {
  const m = text.match(/\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/);
  if (!m) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

// FIX: pegar nome completo
function parseName(text) {
  const m = text.match(/nome\s*[:\-]\s*([^\r\n]+)\s*$/i);
  if (m) return m[1].trim();
  const m2 = text.match(/no nome de\s+([^\r\n]+)\s*$/i);
  if (m2) return m2[1].trim();
  return null;
}

function parseNameSmart(text) {
  const explicit = parseName(text);
  if (explicit) return explicit;

  const hasDate = /\b([0-3]?\d)\/([01]?\d)(?:\/(\d{2}|\d{4}))?\b/.test(text);
  const hasTime = /\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/.test(text);
  if (!hasDate && !hasTime) return null;

  const idxDate = text.search(/\b([0-3]?\d)\/([01]?\d)(?:\/(\d{2}|\d{4}))?\b/);
  const idxTime = text.search(/\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/);

  let cut = -1;
  if (idxDate >= 0 && idxTime >= 0) cut = Math.min(idxDate, idxTime);
  else cut = Math.max(idxDate, idxTime);
  if (cut <= 0) return null;

  let candidate = text.slice(0, cut).trim();
  candidate = candidate.replace(/^[\-\s:–—]+/, "").replace(/[\-\s:–—]+$/, "").trim();
  candidate = candidate.replace(/^\d+\s+/, "").trim();

  const words = candidate.split(/\s+/).filter(Boolean);
  if (!words.length) return null;

  const bad = new Set(["reserva", "reservar", "quero", "mesa", "agendar", "marcar"]);
  if (words.length === 1 && bad.has(normalizeText(words[0]))) return null;

  return words.slice(0, 6).join(" ").trim() || null;
}

function looksLikeStandaloneName(text) {
  const raw = (text || "").trim();
  if (!raw) return false;
  if (/\d/.test(raw)) return false;
  if (raw.length < 4 || raw.length > 60) return false;

  const t = normalizeText(raw);
  if (/\b(reserva|reservar|mesa|amanha|hoje|horario|horário|pessoas|adultos|criancas|crianças)\b/.test(t)) return false;

  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;

  if (!/^[A-Za-zÀ-ÿ'.-]+(\s+[A-Za-zÀ-ÿ'.-]+)+$/.test(raw)) return false;
  return true;
}

function parseAdultsChildren(text) {
  const t = normalizeText(text);
  const m = t.match(/\b(\d+)\s*adult[oa]s?\b.*?\b(\d+)\s*crianc[ao]s?\b/);
  if (m) return { adultos: Number(m[1]), criancas: Number(m[2]) };

  const mA = t.match(/\b(\d+)\s*adult[oa]s?\b/);
  if (mA) return { adultos: Number(mA[1]), criancas: 0 };

  const mC = t.match(/\b(\d+)\s*crianc[ao]s?\b/);
  if (mC) return { adultos: 0, criancas: Number(mC[1]) };

  return null;
}

function parsePeopleTotalFallback(text) {
  const t = normalizeText(text);

  const m2 = t.match(/\b(\d+)\s*(pessoas|pessoa|lugares|lugar)\b/);
  if (m2) return Number(m2[1]);

  const nums = [...t.matchAll(/\b(\d{1,2})\b/g)].map((x) => Number(x[1]));
  if (nums.length) {
    const time = parseTime(text);
    if (time) {
      const hour = Number(time.split(":")[0]);
      const filtered = nums.filter((n) => n !== hour);
      if (filtered.length) return filtered[filtered.length - 1];
    }
    return nums[nums.length - 1];
  }
  return null;
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function isTimeAllowed(hhmm) {
  return timeToMinutes(hhmm) <= timeToMinutes(RESERVA_HORA_MAX);
}

function peopleTotalFromConvData(data) {
  if (data?.adultos != null && data?.criancas != null) {
    return Number(data.adultos) + Number(data.criancas);
  }
  if (data?.pessoasTotal != null) return Number(data.pessoasTotal);
  return null;
}

function peopleLabelFromConvData(data) {
  if (data?.adultos != null && data?.criancas != null) {
    const c = Number(data.criancas);
    return `${data.adultos} adultos e ${data.criancas} criança${c === 1 ? "" : "s"}`;
  }
  if (data?.pessoasTotal != null) {
    const n = Number(data.pessoasTotal);
    return `${data.pessoasTotal} pessoa${n === 1 ? "" : "s"}`;
  }
  return "";
}

function peopleShortLabelFromConvData(data) {
  if (data?.adultos != null && data?.criancas != null) {
    return `${data.adultos}ad+${data.criancas}c`;
  }
  if (data?.pessoasTotal != null) return String(data.pessoasTotal);
  return "";
}

// ===== Trello =====
async function trelloGet(url) {
  if (!CB.trello.canRun()) throw new Error("trello_circuit_open");
  const full = new URL(url);
  full.searchParams.set("key", TRELLO_KEY);
  full.searchParams.set("token", TRELLO_TOKEN);

  try {
    const r = await fetchWithRetry(full.toString(), {}, { tries: 4, baseDelayMs: 350, service: "trello" });
    const t = await r.text();
    if (!r.ok) throw new Error(`Trello GET failed ${r.status}: ${t}`);
    CB.trello.success();
    return JSON.parse(t);
  } catch (e) {
    CB.trello.fail();
    throw e;
  }
}

async function trelloPost(url, bodyObj) {
  if (!CB.trello.canRun()) throw new Error("trello_circuit_open");
  const full = new URL(url);
  full.searchParams.set("key", TRELLO_KEY);
  full.searchParams.set("token", TRELLO_TOKEN);

  try {
    const r = await fetchWithRetry(
      full.toString(),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyObj ? JSON.stringify(bodyObj) : undefined,
      },
      { tries: 4, baseDelayMs: 350, service: "trello" }
    );
    const t = await r.text();
    if (!r.ok) throw new Error(`Trello POST failed ${r.status}: ${t}`);
    CB.trello.success();
    return JSON.parse(t);
  } catch (e) {
    CB.trello.fail();
    throw e;
  }
}

async function trelloFindListByName(boardId, listName) {
  const lists = await trelloGet(`https://api.trello.com/1/boards/${boardId}/lists?fields=name,closed&limit=1000`);
  return (lists || []).find((l) => !l.closed && l.name === listName) || null;
}

async function trelloEnsureList(boardId, listName) {
  const found = await trelloFindListByName(boardId, listName);
  if (found) return found;
  return await trelloPost(`https://api.trello.com/1/lists?idBoard=${boardId}&name=${encodeURIComponent(listName)}`, null);
}

function parsePeopleFromCardName(name) {
  const m2 = (name || "").match(/-\s*(\d{1,2})\s*ad\+\s*(\d{1,2})\s*c\s*$/i);
  if (m2) return Number(m2[1]) + Number(m2[2]);
  const m = (name || "").match(/-\s*(\d{1,2})\s*$/);
  if (m) return Number(m[1]);
  return null;
}

async function trelloCountList(listId) {
  const cards = await trelloGet(`https://api.trello.com/1/lists/${listId}/cards?fields=name&limit=1000`);
  const total = cards.length;
  const twoP = cards.filter((c) => parsePeopleFromCardName(c.name) === 2).length;
  return { total, twoP };
}

async function trelloCreateReservaCard({ listId, nome, hora, pessoasLabel, telefone, idempotencyKey }) {
  const title = `${nome} - ${hora} - ${pessoasLabel}`;
  const desc = `Telefone/WhatsApp: ${telefone}\nIdempotency: ${idempotencyKey}`;
  return await trelloPost(`https://api.trello.com/1/cards?idList=${listId}`, { name: title, desc });
}

// ===== Reserva templates =====
async function getNotionReservaTemplate(name, fallback) {
  const t = await notionFindExactByName(NOTION_DB_RESERVAS, name);
  return t && t.trim() ? t.trim() : fallback;
}

async function buildConfirmMessageFromNotionOrFallback({ nome, dataList, hora, peopleLabel }) {
  const tpl =
    (await notionFindExactByName(
      NOTION_DB_RESERVAS,
      "Mensagem para mandar para o cliente da confirmaçao da reserva"
    )) || "";

  if (tpl.trim()) {
    const reservaBlock =
      `RESERVA: ` +
      `Nome: ${nome} ` +
      `Data: ${dataList} ` +
      `N° de pessoas: ${peopleLabel} ` +
      `Horário: ${hora}`;

    if (/RESERVA:/i.test(tpl)) {
      return tpl.replace(/RESERVA:\s*[\s\S]*$/i, reservaBlock).trim();
    }
    return (tpl.trim() + " " + reservaBlock).trim();
  }

  return (
    `Perfeito! 😊 ` +
    `Reserva confirmada: ` +
    `Nome: ${nome} ` +
    `Data: ${dataList} ` +
    `N° de pessoas: ${peopleLabel} ` +
    `Horário: ${hora} ` +
    `❗ 15 minutos de tolerância - Após este período, a mesa pode ser liberada para quem está na fila de espera. ` +
    `Se precisar alterar ou cancelar, é só avisar! 🍣✨`
  );
}

// ===== Anti-spam do “missing” =====
function missingSignature(missingArr) {
  return (missingArr || []).join("|");
}

function shouldSuppressMissingRepeat(conv, missingArr) {
  const sig = missingSignature(missingArr);
  const suppressMs = Math.max(5_000, Number(MISSING_REPEAT_SUPPRESS_MS || 60_000));
  const lastSig = conv?.lastMissingSig || "";
  const lastAt = Number(conv?.lastMissingAskedAt || 0);
  return sig === lastSig && Date.now() - lastAt < suppressMs;
}

function markMissingAsked(remoteJid, conv, missingArr) {
  conv.lastMissingSig = missingSignature(missingArr);
  conv.lastMissingAskedAt = Date.now();
  setConv(remoteJid, conv);
}

// ===== Main webhook =====
async function handleWebhook(bodyJson) {
  const event = String(bodyJson.event || "").toLowerCase();
  if (event !== "messages.upsert") return;

  const remoteJid = bodyJson?.data?.key?.remoteJid;
  if (!remoteJid) return;

  // extra-safety: só DM
  if (remoteJid.endsWith("@g.us")) return;

  await withJidLock(remoteJid, async () => {
    // HANDOFF: humano falou
    if (bodyJson?.data?.key?.fromMe) {
      const mins = Math.max(5, Number(HANDOFF_MINUTES || 180));
      setHandoffPause(remoteJid, mins);
      console.log(`[${nowIso()}] handoff pause set jid=${remoteJid} mins=${mins}`);
      return;
    }

    const incomingText = extractIncomingText(bodyJson);
    if (!incomingText) return;

    const msgId = getIncomingMessageId(bodyJson);

    // paused?
    const pause = getConv(remoteJid);
    if (pause?.handoffUntil && pause.handoffUntil > Date.now()) return;

    // dedupe
    if (isDuplicateAndMark(remoteJid, msgId)) {
      console.log(`[${nowIso()}] dedupe hit jid=${remoteJid} id=${msgId}`);
      return;
    }

    // throttle
    if (shouldThrottle(pause)) return;

    await ensureKnowledgeFresh();

    // Greeting
    if (looksLikeGreeting(incomingText)) {
      const welcome =
        (await notionFindExactByName(NOTION_DB_RESTAURANTE, NOTION_WELCOME_NAME)) ||
        "Oieeee❤️ Aqui é a Liz! Assistente do Tsunagari. Conte comigo!";
      await evolutionSendText({ remoteJid, text: welcome });
      markBotReplied(remoteJid);
      return;
    }

    // Non-japanese foods
    if (asksNonJapaneseFood(incomingText)) {
      await evolutionSendText({
        remoteJid,
        text: "A gente é um restaurante japonês 🍣✨ Então não trabalhamos com pizza/hambúrguer. Quer que eu te mande nosso cardápio ou te explico as opções do rodízio?",
      });
      markBotReplied(remoteJid);
      return;
    }

    // Order intent => notify admin
    const existing = getConv(remoteJid);
    const inReservaFlow = existing?.mode === "reserva";

    if (!inReservaFlow && looksLikeOrderIntent(incomingText)) {
      const from = remoteJid.split("@")[0];
      await notifyAdminOncePerWindow(
        `order:${from}`,
        `⚠️ POSSÍVEL PEDIDO (precisa de atendimento humano)\nCliente: ${from}\nMensagem: ${incomingText}`
      );
      await evolutionSendText({
        remoteJid,
        text: "Entendi! 😊 Só um instante que vou chamar alguém da equipe pra te ajudar por aqui. 🍣",
      });
      markBotReplied(remoteJid);
      return;
    }

    // Reserva flow
    if (looksLikeReservaIntent(incomingText) || inReservaFlow) {
      const conv =
        existing && inReservaFlow ? existing : { mode: "reserva", data: {}, startedAt: Date.now() };

      // confirmar hora max
      if (conv?.awaitingHoraMaxConfirm && isAffirmative(incomingText)) {
        conv.data.hora = RESERVA_HORA_MAX;
        conv.awaitingHoraMaxConfirm = false;
      }

      // parse date object
      const dateObjNow = parseDateBR(incomingText);
      if (dateObjNow) conv.data.dateObj = dateObjNow;

      // fields
      const nomeSmart = parseNameSmart(incomingText);
      const dataList = parseDateToListName(incomingText);
      const hora = parseTime(incomingText);
      const ac = parseAdultsChildren(incomingText);
      const totalFallback = parsePeopleTotalFallback(incomingText);

      if (nomeSmart) conv.data.nome = nomeSmart;
      if (dataList) conv.data.dataList = dataList;
      if (hora) conv.data.hora = hora;

      // nome “solto” dentro do fluxo de reserva
      if (!conv.data.nome && looksLikeStandaloneName(incomingText)) {
        conv.data.nome = incomingText.trim();
      }

      if (ac) {
        conv.data.adultos = ac.adultos;
        conv.data.criancas = ac.criancas;
        conv.data.pessoasTotal = undefined;
      } else if (totalFallback != null && conv.data.adultos == null && conv.data.criancas == null) {
        conv.data.pessoasTotal = totalFallback;
      }

      setConv(remoteJid, conv);

      // date validations
      if (conv.data.dateObj) {
        if (FECHADO_DOMINGO !== "0" && isSundayBR(conv.data.dateObj)) {
          await evolutionSendText({
            remoteJid,
            text: "A gente não abre aos domingos 🙂 Quer reservar pra outro dia? Funcionamos de segunda a sábado, 18:30 às 23h. 🍣",
          });
          clearConv(remoteJid);
          markBotReplied(remoteJid);
          return;
        }

        if (isPastDateBR(conv.data.dateObj)) {
          await evolutionSendText({
            remoteJid,
            text: "Essa data já passou 🙂 Consegue me confirmar a data da reserva (DD/MM)?",
          });
          markBotReplied(remoteJid);
          return;
        }

        const maxDays = Math.max(7, Number(MAX_ADVANCE_DAYS || 120));
        const delta = daysFromTodayBR(conv.data.dateObj);

        if (delta > maxDays) {
          await evolutionSendText({
            remoteJid,
            text: `Consigo te ajudar sim 😊 Só me confirma uma data mais próxima (até ${maxDays} dias).`,
          });
          markBotReplied(remoteJid);
          return;
        }
      }

      // missing
      const missing = [];
      if (!conv.data.nome) missing.push("Nome");
      if (!conv.data.dataList) missing.push("Data (DD/MM ou DD/MM/AAAA)");
      if (!conv.data.hora) missing.push("Horário (ex.: 19:30)");

      const totalNow = peopleTotalFromConvData(conv.data);
      if (totalNow == null) missing.push("N° de pessoas (ex.: 3 adultos e 1 criança)");

      if (missing.length) {
        if (shouldSuppressMissingRepeat(conv, missing)) return;

        const pedir = await getNotionReservaTemplate(
          "dados para a reserva",
          "Para agendar sua reserva precisamos destes dados:\nNome:\nData:\nN° de pessoas: X adultos e X crianças\nHorário:\nAssim que mandar agendamos sua reserva!"
        );

        if (inReservaFlow) {
          await evolutionSendText({
            remoteJid,
            text:
              `Só me confirma rapidinho pra eu fechar sua reserva 😊\n` +
              `${missing.map((m) => `- ${m}`).join("\n")}`,
          });
        } else {
          await evolutionSendText({ remoteJid, text: pedir });
        }

        markMissingAsked(remoteJid, conv, missing);
        markBotReplied(remoteJid);
        return;
      }

      // hour limit
      if (!isTimeAllowed(conv.data.hora)) {
        const msg = await getNotionReservaTemplate(
          "LIMITE HORARIO de reserva",
          `Posso colocar ${RESERVA_HORA_MAX}? É o limite de horário para reserva. Tem 15min de tolerância. 😊`
        );
        conv.awaitingHoraMaxConfirm = true;
        setConv(remoteJid, conv);
        await evolutionSendText({ remoteJid, text: msg });
        markBotReplied(remoteJid);
        return;
      }

      // idempotency key (anti duplicata de card por reentrega)
      const telefone = remoteJid.split("@")[0];
      const peopleLabel = peopleLabelFromConvData(conv.data) || `${totalNow} pessoas`;
      const idemKey = normalizeText(`${telefone}|${conv.data.dataList}|${conv.data.hora}|${conv.data.nome}|${peopleLabel}`);

      if (conv.lastReservaKey === idemKey && Date.now() - Number(conv.lastReservaKeyAt || 0) < 10 * 60 * 1000) {
        await evolutionSendText({
          remoteJid,
          text: "Perfeito! Já registrei sua reserva 😊 Se precisar alterar algum dado, me avisa por aqui.",
        });
        clearConv(remoteJid);
        markBotReplied(remoteJid);
        return;
      }

      // Trello capacity
      const list = await trelloEnsureList(TRELLO_BOARD_ID, conv.data.dataList);
      const counts = await trelloCountList(list.id);

      const maxTotal = Number(RESERVA_MAX_TOTAL_DIA);
      const max2p = Number(RESERVA_MAX_2P_DIA);

      if (counts.total >= maxTotal) {
        const msg = await getNotionReservaTemplate(
          "limite de reserva(checar trello)",
          "❗ Já atingimos o limite de reservas para esse dia. Você pode vir sem reserva, por ordem de chegada. 😊"
        );
        await evolutionSendText({ remoteJid, text: msg });
        clearConv(remoteJid);
        markBotReplied(remoteJid);
        return;
      }

      const isTwoPeople =
        totalNow === 2 &&
        (conv.data.adultos == null || (Number(conv.data.adultos) === 2 && Number(conv.data.criancas) === 0));

      if (isTwoPeople && counts.twoP >= max2p) {
        await evolutionSendText({
          remoteJid,
          text: "Hoje já atingimos o limite de reservas para 2 pessoas. 😊 Mas você pode vir sem reserva por ordem de chegada. 🍣✨",
        });
        clearConv(remoteJid);
        markBotReplied(remoteJid);
        return;
      }

      // Create card
      const pessoasCard = peopleShortLabelFromConvData(conv.data) || String(totalNow);
      await trelloCreateReservaCard({
        listId: list.id,
        nome: conv.data.nome,
        hora: conv.data.hora,
        pessoasLabel: pessoasCard,
        telefone,
        idempotencyKey: idemKey,
      });

      conv.lastReservaKey = idemKey;
      conv.lastReservaKeyAt = Date.now();
      setConv(remoteJid, conv);

      // Confirm
      const confirmMsg = await buildConfirmMessageFromNotionOrFallback({
        nome: conv.data.nome,
        dataList: conv.data.dataList,
        hora: conv.data.hora,
        peopleLabel,
      });

      await evolutionSendText({ remoteJid, text: confirmMsg });
      clearConv(remoteJid);
      markBotReplied(remoteJid);
      return;
    }

    // General doubts => Notion + OpenAI
    const retrieved = simpleRetrieve(incomingText, KNOWLEDGE, 12);
    const answer = await openaiAnswer({ question: incomingText, retrieved });
    await evolutionSendText({ remoteJid, text: answer });
    markBotReplied(remoteJid);
  });
}

// ===== HTTP server =====
const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("OK");
  }

  const maxBytes = Math.max(64 * 1024, Number(MAX_BODY_BYTES || 1048576));
  let size = 0;
  const buf = [];

  req.on("data", (c) => {
    size += c.length;
    if (size > maxBytes) {
      res.writeHead(413, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Payload too large");
      req.destroy();
      return;
    }
    buf.push(c);
  });

  req.on("end", async () => {
    // ACK rápido pro webhook
    if (!res.headersSent) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("OK");
    }

    let bodyJson = null;
    try {
      bodyJson = JSON.parse(Buffer.concat(buf).toString("utf8"));
    } catch {
      return;
    }

    try {
      await handleWebhook(bodyJson);
    } catch (e) {
      const msg = e?.message || String(e);
      console.error(`[${nowIso()}] handler_error`, msg);

      try {
        const remoteJid = bodyJson?.data?.key?.remoteJid || "";
        const incomingText = extractIncomingText(bodyJson);
        const who = remoteJid.split("@")[0] || "(?)";
        await notifyAdminOncePerWindow(
          `err:${who}`,
          `🚨 ERRO no bot\njid: ${who}\nmsg: ${incomingText || "(sem texto)"}\nerr: ${msg.slice(0, 800)}`
        );
      } catch {}
    }
  });
});

// ===== Boot =====
(function boot() {
  // valida env 1x no boot
  must("OPENAI_API_KEY", OPENAI_API_KEY);
  must("NOTION_TOKEN", NOTION_TOKEN);
  must("EVOLUTION_SERVER_URL", EVOLUTION_SERVER_URL);
  must("EVOLUTION_APIKEY", EVOLUTION_APIKEY);
  must("TRELLO_KEY", TRELLO_KEY);
  must("TRELLO_TOKEN", TRELLO_TOKEN);
  must("TRELLO_BOARD_ID", TRELLO_BOARD_ID);

  loadStateFromDisk();

  (async () => {
    try { await loadKnowledge(); }
    catch (e) { console.error(`[${nowIso()}] initial_load_failed`, e?.message || e); }
  })();

  const PORT = Number(process.env.PORT || 3000);
  server.listen(PORT, () => console.log(`[${nowIso()}] Tsunagari bot v3 on :${PORT}`));

  process.on("SIGTERM", () => {
    console.log(`[${nowIso()}] SIGTERM received; closing server...`);
    server.close(() => {
      try { atomicWriteFile(STATE_PATH, JSON.stringify(STATE, null, 2)); } catch {}
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 8000).unref();
  });
})();

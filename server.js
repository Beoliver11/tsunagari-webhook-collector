/**
 * Tsunagari WhatsApp Bot (Evolution + Notion + Trello + OpenAI) — “produção”
 *
 * O que este arquivo resolve:
 * - Handoff automático: fromMe=true pausa a conversa por HANDOFF_MINUTES
 * - Dedupe: ignora messageId repetido (se vier no payload)
 * - Throttle: cooldown por conversa
 * - Reserva: pede dados, domingo fechado, data passada, data muito distante, hora limite com sugestão (19:45)
 * - Pessoas: mantém adultos/crianças (não soma e perde)
 * - Nome: pega nome completo (Nome: ...) + pega nome “solto” quando a conversa está em modo reserva
 * - Falso positivo de reserva: "amanhã/hoje" sozinho NÃO inicia reserva
 * - Anti-spam: não repete a mesma lista de “faltando” a cada mensagem
 * - Pedidos: detecta pedido e avisa ADMIN_WHATSAPP
 * - Alertas de erro: manda erro pro admin
 * - Links: sem markdown; só manda link se cliente pedir
 * - PORT via process.env.PORT (EasyPanel)
 *
 * FIX (domingo / “abre hoje?”):
 * - Perguntas “abre hoje / funciona hoje / estão abertos hoje?” são tratadas por regra
 * - Usa timezone America/Sao_Paulo
 *
 * FIX (mistura de “limite de reservas” em FAQ):
 * - NÃO carrega NOTION_DB_RESERVAS no KNOWLEDGE do FAQ (fica só para templates do fluxo de reserva)
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

  // anti-spam do “faltando”
  MISSING_REPEAT_SUPPRESS_MS = "60000", // 60s

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
function nowIso() {
  return new Date().toISOString();
}
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

// saudação robusta: "Olá," "Olá!" "Oi..."
function looksLikeGreeting(text) {
  const t = normalizeText(text);

  // se tem pergunta/intenção junto, não é saudação pura
  if (t.includes("?")) return false;
  if (looksLikeReservaIntent(t)) return false;
  if (looksLikeOrderIntent(t)) return false;

  // saudação curta
  if (t.length > 25) return false;

  return /^(oi|ola|oie+|bom dia|boa tarde|boa noite)\b/.test(t);
}
/**
 * FIX IMPORTANTE: Intent de reserva MAIS RÍGIDO
 * - NÃO usa “pra amanhã/pra hoje” como gatilho sozinho
 * - só entra em reserva se tiver termos claros (reserva/mesa/agendar/marcar)
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
    t === "sim" ||
    t === "s" ||
    t === "ok" ||
    t === "okk" ||
    t === "blz" ||
    t === "beleza" ||
    t === "pode" ||
    t === "pode sim" ||
    t === "pode ser" ||
    t === "fechado" ||
    t === "confirmo" ||
    t === "confirmado"
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

// ===== FIX: “abre hoje?” (domingo) =====
function weekdaySaoPauloShort() {
  // returns: sun|mon|tue|wed|thu|fri|sat
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", weekday: "short" });
  return fmt.format(new Date()).toLowerCase();
}

function getTodayBRDateObjInSaoPaulo() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA dá YYYY-MM-DD
  const parts = fmt.format(new Date()).split("-");
  const yyyy = Number(parts[0]);
  const mm = Number(parts[1]);
  const dd = Number(parts[2]);
  return { dd, mm, yyyy };
}

function dateObjToDataList(dateObj) {
  const dd = String(dateObj.dd).padStart(2, "0");
  const mm = String(dateObj.mm).padStart(2, "0");
  const yy = String(dateObj.yyyy).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

function isSundaySaoPaulo() {
  return weekdaySaoPauloShort() === "sun";
}
function looksLikeOpenTodayQuestion(text) {
  const t = normalizeText(text);

  if (t.includes("abre hoje") || t.includes("abrem hoje") || t.includes("funciona hoje")) return true;
  if (t.includes("estao abertos hoje") || t.includes("estão abertos hoje")) return true;

  const hasHoje = /\bhoje\b/.test(t);
  const hasOpenVerb = /\b(abre|abrem|aberto|abertos|funciona|funcionam)\b/.test(t);
  return hasHoje && hasOpenVerb;
}

// ======== Persistent state (file) ========
const STATE_PATH = path.join(process.cwd(), "state.json");
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { conversations: {} };
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}
function getConv(state, jid) {
  return state.conversations[jid] || null;
}
function setConv(state, jid, conv) {
  state.conversations[jid] = conv;
  saveState(state);
}
function clearConv(state, jid) {
  delete state.conversations[jid];
  saveState(state);
}

function setHandoffPause(state, remoteJid, minutes) {
  const existing = getConv(state, remoteJid) || { mode: null, data: {} };
  existing.handoffUntil = Date.now() + minutes * 60 * 1000;
  existing.handoffAt = Date.now();
  existing.mode = existing.mode || null;
  existing.data = existing.data || {};
  setConv(state, remoteJid, existing);
}

function shouldThrottle(existingConv) {
  const cooldown = Math.max(0, Number(COOLDOWN_MS || 0));
  if (!cooldown) return false;
  const last = Number(existingConv?.lastBotReplyAt || 0);
  return Date.now() - last < cooldown;
}

function markBotReplied(state, remoteJid) {
  const c = getConv(state, remoteJid) || { mode: null, data: {} };
  c.lastBotReplyAt = Date.now();
  setConv(state, remoteJid, c);
}

function isDuplicateAndMark(state, remoteJid, msgId) {
  if (!msgId) return false;
  const ttl = Math.max(60_000, Number(DEDUPE_TTL_MS || 600_000));
  const c = getConv(state, remoteJid) || { mode: null, data: {} };
  if (!c.seen) c.seen = {};
  for (const [id, ts] of Object.entries(c.seen)) {
    if (Date.now() - Number(ts || 0) > ttl) delete c.seen[id];
  }
  if (c.seen[msgId]) {
    setConv(state, remoteJid, c);
    return true;
  }
  c.seen[msgId] = Date.now();
  setConv(state, remoteJid, c);
  return false;
}

// ===== Notion =====
async function notionQueryAllRows(dbId, pageSize = 100) {
  let cursor = undefined;
  const rows = [];
  for (let i = 0; i < 20; i++) {
    const body = { page_size: pageSize };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Notion query failed ${r.status}: ${JSON.stringify(j)}`);
    for (const p of j.results || []) {
      const name = p.properties?.Nome?.title?.map((t) => t.plain_text).join("") || "";
      const text = p.properties?.Texto?.rich_text?.map((t) => t.plain_text).join("") || "";
      const nm = name.trim();
      const tx = text.trim();
      if (!nm && !tx) continue; // ignora vazio
      rows.push({ name: nm, text: tx });
    }
    if (!j.has_more) break;
    cursor = j.next_cursor;
  }
  return rows;
}

async function notionFindExactByName(dbId, name) {
  const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
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
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Notion query failed ${r.status}: ${JSON.stringify(j)}`);
  const page = j.results?.[0];
  if (!page) return null;
  const text = page.properties?.Texto?.rich_text?.map((t) => t.plain_text).join("") || "";
  return text.trim() || null;
}

// ===== Knowledge cache =====
let KNOWLEDGE = [];
let lastLoadAt = 0;

async function loadKnowledge() {
  // FIX: NÃO incluir NOTION_DB_RESERVAS aqui (evita “limite de reservas” aparecendo em FAQ)
  const dbs = [
    { name: "restaurante", id: NOTION_DB_RESTAURANTE },
    { name: "politica", id: NOTION_DB_POLITICA },
    { name: "precos", id: NOTION_DB_PRECOS },
    { name: "promocoes", id: NOTION_DB_PROMOCOES },
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
  if (Date.now() - lastLoadAt > maxAgeMs) await loadKnowledge();
}

// ===== Evolution send =====
async function evolutionSendText({ remoteJid, text }) {
  const number = (remoteJid || "").split("@")[0];
  const url = EVOLUTION_SERVER_URL.replace(/\/$/, "") + EVOLUTION_SEND_PATH + "/" + encodeURIComponent(EVOLUTION_INSTANCE);
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: EVOLUTION_APIKEY },
    body: JSON.stringify({ number, text }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`Evolution send failed ${r.status}: ${body}`);
  return body;
}

async function notifyAdmin(text) {
  if (!ADMIN_WHATSAPP) return;
  try {
    await evolutionSendText({ remoteJid: `${ADMIN_WHATSAPP}@s.whatsapp.net`, text });
  } catch (e) {
    console.error(`[${nowIso()}] admin_notify_failed`, e?.message || e);
  }
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
  t = t.replace(/\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/gi, ""); // remove markdown link whole
  t = t.replace(/https?:\/\/\S+/gi, ""); // remove raw urls
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

  const context = retrieved.map((r, i) => `[#${i + 1}] (${r.db}) ${r.name} ${r.text}`).join(" ");
  const user = `
Pergunta do cliente: ${question}
Trechos do Notion: ${context || "(nenhuma informação relevante encontrada)"}
`.trim();

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      temperature: 0.25,
    }),
  });

  const j = await r.json();
  if (!r.ok) throw new Error(`OpenAI failed ${r.status}: ${JSON.stringify(j)}`);
  const out = (j.output || []).flatMap((o) => o.content || []);
  const raw = out
    .filter((c) => c.type === "output_text")
    .map((c) => c.text)
    .join("")
    .trim();
  return sanitizeAnswer(raw, question);
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
  const d = dateBRToUTCDate(dateObj);
  return d.getUTCDay() === 0;
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

function parseName(text) {
  const m = text.match(/nome\s*[:\-]\s*([^ \r]+)/i);
  if (m) return m[1].trim();
  const m2 = text.match(/no nome de\s+([^ \r]+)/i);
  if (m2) return m2[1].trim();
  return null;
}

// infer name only when message contains date/time later
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
  return words.slice(0, 4).join(" ").trim() || null;
}

/**
 * FIX: no fluxo de reserva, se ainda falta nome e a pessoa mandar só "Nome Sobrenome",
 * a gente aceita como nome (mesmo sem data/hora na mesma msg).
 */
function looksLikeStandaloneName(text) {
  const raw = (text || "").trim();
  if (!raw) return false;
  if (/\d/.test(raw)) return false; // não pode ter número
  if (raw.length < 4 || raw.length > 60) return false;
  const t = normalizeText(raw);
  // não aceitar frases comuns
  if (/\b(reserva|reservar|mesa|amanha|hoje|horario|horário|pessoas|adultos|criancas|crianças)\b/.test(t))
    return false;
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  // precisa ser basicamente letras/pontos/hífen
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
  const full = new URL(url);
  full.searchParams.set("key", TRELLO_KEY);
  full.searchParams.set("token", TRELLO_TOKEN);
  const r = await fetch(full.toString());
  const t = await r.text();
  if (!r.ok) throw new Error(`Trello GET failed ${r.status}: ${t}`);
  return JSON.parse(t);
}

async function trelloPost(url, bodyObj) {
  const full = new URL(url);
  full.searchParams.set("key", TRELLO_KEY);
  full.searchParams.set("token", TRELLO_TOKEN);
  const r = await fetch(full.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Trello POST failed ${r.status}: ${t}`);
  return JSON.parse(t);
}

async function trelloFindListByName(boardId, listName) {
  const lists = await trelloGet(
    `https://api.trello.com/1/boards/${boardId}/lists?fields=name,closed&limit=1000`
  );
  return (lists || []).find((l) => !l.closed && l.name === listName) || null;
}

async function trelloEnsureList(boardId, listName) {
  const found = await trelloFindListByName(boardId, listName);
  if (found) return found;
  return await trelloPost(
    `https://api.trello.com/1/lists?idBoard=${boardId}&name=${encodeURIComponent(listName)}`,
    null
  );
}

function parsePeopleFromCardName(name) {
  const m = (name || "").match(/-\s*(\d{1,2})\s*$/);
  if (m) return Number(m[1]);
  const m2 = (name || "").match(/-\s*(\d{1,2})\s*ad\+\s*(\d{1,2})\s*c\s*$/i);
  if (m2) return Number(m2[1]) + Number(m2[2]);
  return null;
}

async function trelloCountList(listId) {
  const cards = await trelloGet(`https://api.trello.com/1/lists/${listId}/cards?fields=name&limit=1000`);
  const total = cards.length;
  const twoP = cards.filter((c) => parsePeopleFromCardName(c.name) === 2).length;
  return { total, twoP };
}

async function trelloCreateReservaCard({ listId, nome, hora, pessoasLabel, telefone }) {
  const title = `${nome} - ${hora} - ${pessoasLabel}`;
  const desc = `Telefone/WhatsApp: ${telefone}`;
  return await trelloPost(`https://api.trello.com/1/cards?idList=${listId}`, { name: title, desc });
}

// ===== Reserva messages =====
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
      `RESERVA: ` + `Nome: ${nome} ` + `Data: ${dataList} ` + `N° de pessoas: ${peopleLabel} ` + `Horário: ${hora}`;
    if (/RESERVA:/i.test(tpl)) {
      const replaced = tpl.replace(/RESERVA:\s*[\s\S]*$/i, reservaBlock);
      return replaced.trim();
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
  if (sig === lastSig && Date.now() - lastAt < suppressMs) return true;
  return false;
}
function markMissingAsked(state, remoteJid, conv, missingArr) {
  conv.lastMissingSig = missingSignature(missingArr);
  conv.lastMissingAskedAt = Date.now();
  setConv(state, remoteJid, conv);
}

// ===== Main webhook =====
async function handleWebhook(bodyJson) {
  must("OPENAI_API_KEY", OPENAI_API_KEY);
  must("NOTION_TOKEN", NOTION_TOKEN);
  must("EVOLUTION_SERVER_URL", EVOLUTION_SERVER_URL);
  must("EVOLUTION_APIKEY", EVOLUTION_APIKEY);
  must("TRELLO_KEY", TRELLO_KEY);
  must("TRELLO_TOKEN", TRELLO_TOKEN);
  must("TRELLO_BOARD_ID", TRELLO_BOARD_ID);

  const event = String(bodyJson.event || "").toLowerCase();
  if (event !== "messages.upsert") return;

  const remoteJid = bodyJson?.data?.key?.remoteJid;
  if (!remoteJid) return;

  // HANDOFF: humano falou
  if (bodyJson?.data?.key?.fromMe) {
    const state = loadState();
    const mins = Math.max(5, Number(HANDOFF_MINUTES || 180));
    setHandoffPause(state, remoteJid, mins);
    console.log(`[${nowIso()}] handoff pause set jid=${remoteJid} mins=${mins}`);
    return;
  }

  const incomingText = extractIncomingText(bodyJson);
  if (!incomingText) return;

  const state = loadState();
  const msgId = getIncomingMessageId(bodyJson);

  // dedupe
  if (isDuplicateAndMark(state, remoteJid, msgId)) {
    console.log(`[${nowIso()}] dedupe hit jid=${remoteJid} id=${msgId}`);
    return;
  }

  // paused?
  const pause = getConv(state, remoteJid);
  if (pause?.handoffUntil && pause.handoffUntil > Date.now()) return;

  // throttle
  if (shouldThrottle(pause)) return;

  await ensureKnowledgeFresh();

  // ===== FIX DOMINGO: “abre hoje?” por regra (antes de Greeting/FAQ/OpenAI) =====
  if (looksLikeOpenTodayQuestion(incomingText)) {
    if (FECHADO_DOMINGO !== "0" && isSundaySaoPaulo()) {
      await evolutionSendText({
        remoteJid,
        text: "Hoje (domingo) a gente não abre 🙂\nFuncionamos de segunda a sábado, 18:30 às 23h. 🍣✨",
      });
      markBotReplied(state, remoteJid);
      return;
    }

    await evolutionSendText({
      remoteJid,
      text: "Hoje a gente abre a partir das 18:30 e vai até 23h 🍣✨\nQuer que eu te ajude com uma reserva?",
    });
    markBotReplied(state, remoteJid);
    return;
  }

  // Greeting
  if (looksLikeGreeting(incomingText)) {
    const welcome =
      (await notionFindExactByName(NOTION_DB_RESTAURANTE, NOTION_WELCOME_NAME)) ||
      "Oieeee❤️ Aqui é a Liz! Assistente do Tsunagari. Conte comigo!";
    await evolutionSendText({ remoteJid, text: welcome });
    markBotReplied(state, remoteJid);
    return;
  }

  // Non-japanese foods
  if (asksNonJapaneseFood(incomingText)) {
    await evolutionSendText({
      remoteJid,
      text: "A gente é um restaurante japonês 🍣✨ Então não trabalhamos com pizza/hambúrguer. Quer que eu te mande nosso cardápio ou te explico as opções do rodízio?",
    });
    markBotReplied(state, remoteJid);
    return;
  }

  // Order intent => notify admin
  const existing = getConv(state, remoteJid);
  const inReservaFlow = existing?.mode === "reserva";
  if (!inReservaFlow && looksLikeOrderIntent(incomingText)) {
    const from = remoteJid.split("@")[0];
    await notifyAdmin(`⚠️ POSSÍVEL PEDIDO (precisa de atendimento humano)\nCliente: ${from}\nMensagem: ${incomingText}`);
    await evolutionSendText({
      remoteJid,
      text: "Entendi! 😊 Só um instante que vou chamar alguém da equipe pra te ajudar por aqui. 🍣",
    });
    markBotReplied(state, remoteJid);
    return;
  }

  // Reserva flow
  if (looksLikeReservaIntent(incomingText) || inReservaFlow) {
    const conv = existing && inReservaFlow ? existing : { mode: "reserva", data: {}, startedAt: Date.now() };

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

    // FIX: nome “solto” dentro do fluxo de reserva
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

    setConv(state, remoteJid, conv);

    // date validations
    if (conv.data.dateObj) {
      if (FECHADO_DOMINGO !== "0" && isSundayBR(conv.data.dateObj)) {
        await evolutionSendText({
          remoteJid,
          text: "A gente não abre aos domingos 🙂 Quer reservar pra outro dia? Funcionamos de segunda a sábado, 18:30 às 23h. 🍣",
        });
        clearConv(state, remoteJid);
        markBotReplied(state, remoteJid);
        return;
      }
      if (isPastDateBR(conv.data.dateObj)) {
        await evolutionSendText({ remoteJid, text: "Essa data já passou 🙂 Consegue me confirmar a data da reserva (DD/MM)?" });
        markBotReplied(state, remoteJid);
        return;
      }
      const maxDays = Math.max(7, Number(MAX_ADVANCE_DAYS || 120));
      const delta = daysFromTodayBR(conv.data.dateObj);
      if (delta > maxDays) {
        await evolutionSendText({ remoteJid, text: `Consigo te ajudar sim 😊 Só me confirma uma data mais próxima (até ${maxDays} dias).` });
        markBotReplied(state, remoteJid);
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
      // FIX: não ficar repetindo a MESMA lista de faltantes
      if (shouldSuppressMissingRepeat(conv, missing)) return;

      const pedir = await getNotionReservaTemplate(
        "dados para a reserva",
        "Para agendar sua reserva precisamos destes dados:\nNome:\nData:\nN° de pessoas: X adultos e X crianças\nHorário:\nAssim que mandar agendamos sua reserva!"
      );
      if (inReservaFlow) {
        await evolutionSendText({
          remoteJid,
          text: `Só me confirma rapidinho pra eu fechar sua reserva 😊\n${missing.map((m) => `- ${m}`).join("\n")}`,
        });
      } else {
        await evolutionSendText({ remoteJid, text: pedir });
      }

      markMissingAsked(state, remoteJid, conv, missing);
      markBotReplied(state, remoteJid);
      return;
    }

    // hour limit
    if (!isTimeAllowed(conv.data.hora)) {
      const msg = await getNotionReservaTemplate(
        "LIMITE HORARIO de reserva",
        `Posso colocar ${RESERVA_HORA_MAX}? É o limite de horário para reserva. Tem 15min de tolerância. 😊`
      );
      conv.awaitingHoraMaxConfirm = true;
      setConv(state, remoteJid, conv);
      await evolutionSendText({ remoteJid, text: msg });
      markBotReplied(state, remoteJid);
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
      clearConv(state, remoteJid);
      markBotReplied(state, remoteJid);
      return;
    }

    const totalForLimits = peopleTotalFromConvData(conv.data);
    const isTwoPeople =
      totalForLimits === 2 &&
      (conv.data.adultos == null || (Number(conv.data.adultos) === 2 && Number(conv.data.criancas) === 0));

    if (isTwoPeople && counts.twoP >= max2p) {
      await evolutionSendText({
        remoteJid,
        text: "Hoje já atingimos o limite de reservas para 2 pessoas. 😊 Mas você pode vir sem reserva por ordem de chegada. 🍣✨",
      });
      clearConv(state, remoteJid);
      markBotReplied(state, remoteJid);
      return;
    }

    // Create card
    const telefone = remoteJid.split("@")[0];
    const pessoasCard = peopleShortLabelFromConvData(conv.data) || String(totalForLimits);
    await trelloCreateReservaCard({
      listId: list.id,
      nome: conv.data.nome,
      hora: conv.data.hora,
      pessoasLabel: pessoasCard,
      telefone,
    });

    // Confirm
    const peopleLabel = peopleLabelFromConvData(conv.data) || `${totalForLimits} pessoas`;
    const confirmMsg = await buildConfirmMessageFromNotionOrFallback({
      nome: conv.data.nome,
      dataList: conv.data.dataList,
      hora: conv.data.hora,
      peopleLabel,
    });
    await evolutionSendText({ remoteJid, text: confirmMsg });

    clearConv(state, remoteJid);
    markBotReplied(state, remoteJid);
    return;
  }

  // General doubts => Notion + OpenAI
  const retrieved = simpleRetrieve(incomingText, KNOWLEDGE, 12);
  const answer = await openaiAnswer({ question: incomingText, retrieved });
  await evolutionSendText({ remoteJid, text: answer });
  markBotReplied(state, remoteJid);
}

// ===== HTTP server =====
const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("OK");
  }
  let buf = [];
  req.on("data", (c) => buf.push(c));
  req.on("end", async () => {
    // ACK rápido pro webhook
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("OK");

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
      // alerta admin
      try {
        const remoteJid = bodyJson?.data?.key?.remoteJid || "";
        const incomingText = extractIncomingText(bodyJson);
        await notifyAdmin(
          `🚨 ERRO no bot\njid: ${remoteJid.split("@")[0] || "(?)"}\nmsg: ${incomingText || "(sem texto)"}\nerr: ${msg.slice(0, 800)}`
        );
      } catch {}
    }
  });
});

// ===== Boot =====
(async () => {
  try {
    await loadKnowledge();
  } catch (e) {
    console.error(`[${nowIso()}] initial_load_failed`, e?.message || e);
  }
  const PORT = Number(process.env.PORT || 3000);
  server.listen(PORT, () => console.log(`[${nowIso()}] Tsunagari bot v2.1 (domingo-fix) on :${PORT}`));
})();

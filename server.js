/**
 * Tsunagari WhatsApp Bot (Evolution + Notion + Trello + OpenAI) — "produção"
 *
 * Ajustes (mar/2026):
 * - Notion reorganizado: FAQ / Templates / Regras / Links
 * - Pessoas na reserva: salvar APENAS total (inclui adultos+crianças+adolescentes+bebê)
 * - Mantém FIX domingo / "abre hoje?" determinístico (America/Sao_Paulo)
 * - Mantém: FAQ sem poluição de reservas (não usa DB de templates no knowledge)
 * - Mantém: Reserva parcial (hora sem data => assume HOJE SP)
 * - Mantém: Greeting não dispara dentro do fluxo de reserva
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

// Lock em memória: evita que duas mensagens do mesmo número sejam processadas
// simultaneamente (race condition no state.json)
const PROCESSING_LOCK = new Set();

// ===== ENV =====
const {
  // OpenAI
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o",

  // Evolution
  EVOLUTION_SERVER_URL,
  EVOLUTION_APIKEY,
  EVOLUTION_INSTANCE = "n8n Tsunagari",
  EVOLUTION_SEND_PATH = "/message/sendText",

  // Alerts / humans
  ADMIN_WHATSAPP = "",
  HUMAN_NUMBERS = "",

  // Production knobs
  HANDOFF_MINUTES = "180",
  COOLDOWN_MS = "1500",
  DEDUPE_TTL_MS = "600000",
  MISSING_REPEAT_SUPPRESS_MS = "60000",

  // Notion
  NOTION_TOKEN,

  // NOVO (recomendado): Notion DBs por função
  NOTION_DB_FAQ = "2bf12169-2df7-806a-82cc-d8c1c3e39202", // DB — FAQ (Respostas)
  NOTION_DB_TEMPLATES = "516f3fa8-2a01-473d-ab97-e77c51ab4ae7", // DB — Templates (Mensagens prontas)
  NOTION_DB_BOT_RULES = "3988d97a6fb94ce397224dccaa9d41ef", // DB — Regras do Bot (Evento / Data / Dia da semana)
  NOTION_DB_CARDAPIO = "", // opcional

  // Antigo (compat): caso você ainda use os DBs antigos
  NOTION_WELCOME_NAME = "Mensagem de boas vindas:",
  NOTION_DB_RESTAURANTE = "2bf12169-2df7-806a-82cc-d8c1c3e39202",
  NOTION_DB_POLITICA = "2b512169-2df7-80f2-ab82-c358e0393ace",
  NOTION_DB_PRECOS = "2b512169-2df7-8065-84c2-ea856c101a2d",
  NOTION_DB_PROMOCOES = "2b512169-2df7-8005-b897-d229a7c10f32",
  NOTION_DB_RESERVAS = "2b412169-2df7-80c8-ab03-fcd7af2b673e", // ⚠️ antigo (templates de reserva)
  NOTION_DB_REGRAS = "2b512169-2df7-804d-a6ed-f7417e299ef5",

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

// ===== Mesas (regras internas) =====
// Observação: a alocação é interna; o cliente não deve receber detalhes de "melhor lugar" etc.
const TABLES = {
  round: { count: 3, min: 6, max: 11, labelName: "mesa:redonda", labelColor: "blue" },
  sofa: { count: 5, min: 2, max: 5, labelName: "mesa:sofa", labelColor: "green" },
  normal: { count: 2, min: 2, max: 7, labelName: "mesa:normal", labelColor: "yellow" },
};

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

// ===== intents / parsing =====
function looksLikeReservaDuvida(text) {
  // Pessoa PERGUNTA se precisa reservar — não afirma que quer reservar
  const t = normalizeText(text);
  if (!t.includes("?") && !/\b(precisa|preciso|tenho que|tem que|obrigat|necessari|e preciso|é preciso|opcional)\b/.test(t)) return false;
  return (
    /\b(precisa|preciso|tenho que|tem que|e obrigatorio|e necessario|e preciso)\b/.test(t) ||
    /\b(posso|da|da pra|consigo)\s+(ir|vir|aparecer|entrar)\s+sem\b/.test(t) ||
    /\b(sem reserva|sem fazer reserva)\b/.test(t) && t.includes("?") ||
    t.includes("opcional") ||
    t.includes("obrigat")
  );
}

function looksLikeReservaJaFeita(text) {
  const t = normalizeText(text);
  return (
    /\b(ja|já)\s+(fiz|fiz a|reservei|confirmei)\b/.test(t) ||
    /\b(fiz|fiz a|confirmei)\s+(minha|a|uma)?\s*reserva\b/.test(t) ||
    t.includes("reserva confirmada") ||
    t.includes("confirmei minha reserva") ||
    t.includes("ja reservei") ||
    t.includes("já reservei")
  );
}

function looksLikeReservaIntent(text) {
  if (looksLikeReservaJaFeita(text)) return false; // reserva já feita não é intent de reservar
  const t = normalizeText(text);
  return (
    t.includes("reserva") ||
    t.includes("reservar") ||
    t.includes("agendar") ||
    /\bmarcar\s+(mesa|reserva|lugar|horario)\b/.test(t) ||
    /\b(quero|preciso|tem|ha)\s+(uma?\s+)?mesa\b/.test(t)
  );
}
function looksLikeSofaRequest(text) {
  // Pedido EXPLÍCITO de mesa de sofazinho/sofá.
  // (Não confundir com a palavra "mesa" genérica.)
  const t = normalizeText(text);
  return /\b(sofazinho|sofazinhozinho|sofa|sof[aá])\b/.test(t);
}
function looksLikeOrderIntent(text) {
  const t = normalizeText(text);
  return (
    // intenção explícita de pedir/pedido (evita "pedir informações", "pedir o cardápio")
    /\b(fazer um pedido|quero pedir|vou pedir|vou querer|meu pedido|numero do pedido)\b/.test(t) ||
    // retirar só em contexto de retirada de comida
    /\b(retirar no local|retirar o pedido|buscar o pedido)\b/.test(t) ||
    // delivery/entrega + verbo de ação explícito (não só "tem delivery?")
    /\b(pedir|encomendar|fazer pedido)\b.{0,30}\b(delivery|entrega)\b/.test(t) ||
    /\b(delivery|entrega)\b.{0,30}\b(quero|vou|posso pedir|fazer pedido)\b/.test(t)
  );
}
// ===== Gatilhos para o motor de regras =====
function looksLikePromoIntent(text) {
  const t = normalizeText(text);
  return /\b(desconto|descontos|promocao|promocoes|oferta|ofertas|cupom|cupons|promo)\b/.test(t);
}
function looksLikeDeliveryIntent(text) {
  const t = normalizeText(text);
  return /\b(delivery|entrega|take away|para viagem|ifood|i-food|rappi|ubereats|uber eats)\b/.test(t);
}
function looksLikeHorarioIntent(text) {
  const t = normalizeText(text);
  return /\b(horario|hora|abre|abrem|fecha|fechado|funciona|funcionam|aberto|quando abre)\b/.test(t);
}

function looksLikeWantsHuman(text) {
  const t = normalizeText(text);
  return (
    /\b(falar com|fala com|chamar|chama|quero|preciso|me passa|passa para|passando para)\b.{0,30}\b(atendente|atendentes|humano|humana|pessoa|alguem|responsavel|gerente|assistente)\b/.test(t) ||
    /\b(atendente|humano|humana|pessoa real|alguem real|assistente humana?)\b.{0,20}\b(por favor|pf|pfv|agora|ja|me ajuda)\b/.test(t) ||
    /\bquero (ser atendido|atendimento humano|falar com um humano|falar com uma pessoa|falar com assistente)\b/.test(t) ||
    /\b(assistente humana?|atendimento humano)\b/.test(t) ||
    t === "atendente" || t === "humano" || t === "humana" || t === "falar com atendente" || t === "quero atendente"
  );
}
function looksLikeOptOut(text) {
  const t = normalizeText(text);
  return /\b(parar|pare|stop|cancelar mensagens|nao quero receber|não quero receber|remover meu numero|remover meu número|descadastrar|sair|cancelar notificacoes|cancelar notificações)\b/.test(
    t
  );
}

function isEmojiOnly(text) {
  // Retorna true se a mensagem contém apenas emojis (e espaços) — sem texto real
  const stripped = (text || "").replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]/gu, "");
  return stripped.length === 0 && (text || "").trim().length > 0;
}

function looksLikeCancelReserva(text) {
  const t = normalizeText(text);
  return (
    /\b(cancelar|cancela|cancelamento|desmarcar|desmarca|desmarquei|cancelei|remover|tirar)\b.{0,30}\b(reserva|mesa|lugar)\b/.test(t) ||
    /\b(reserva|mesa|lugar)\b.{0,30}\b(cancelar|cancela|cancelamento|desmarcar|desmarca)\b/.test(t) ||
    /\b(nao|não)\s+(vou|vamos|consigo|podemos)\s+(mais\s+)?(ir|comparecer|aparecer)\b/.test(t)
  );
}

function looksLikeGreeting(text) {
  // Saudação "pura", curta, e sem intenção junto
  const t = normalizeText(text);
  if (t.includes("?")) return false;
  if (looksLikeReservaIntent(t)) return false;
  if (looksLikeOrderIntent(t)) return false;
  if (t.length > 25) return false;
  return /^(oi|ola|oie+|bom dia|boa tarde|boa noite)\b/.test(t);
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

function extractIncomingMediaType(bodyJson) {
  const msg = bodyJson?.data?.message || {};
  if (msg.audioMessage || msg.pttMessage) return "audio";
  if (msg.stickerMessage) return "sticker";
  if (msg.documentMessage) return "document";
  if (msg.imageMessage && !msg.imageMessage.caption) return "image";
  if (msg.videoMessage && !msg.videoMessage.caption) return "video";
  return null;
}

// ===== FIX domingo: "abre hoje?" determinístico (timezone SP) =====
function weekdaySaoPauloShort() {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    weekday: "short",
  });
  return fmt.format(new Date()).toLowerCase(); // sun|mon|...
}
function isSundaySaoPaulo() {
  return weekdaySaoPauloShort() === "sun";
}
function todayStrSaoPaulo() {
  // Retorna "YYYY-MM-DD" no fuso de SP — para comparar com datas do Notion
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());
}
function currentWeekdaySP() {
  // Retorna 'seg'|'ter'|'qua'|'qui'|'sex'|'sab'|'dom'
  const map = { Sun: "dom", Mon: "seg", Tue: "ter", Wed: "qua", Thu: "qui", Fri: "sex", Sat: "sab" };
  const short = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", weekday: "short" }).format(new Date());
  return map[short] || "dom";
}
function todayInfoSaoPaulo() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const fmtWeekday = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
  });
  const tomorrowName = fmtWeekday.format(tomorrow); // ex: "quarta-feira"
  return `${fmt.format(now)} — amanhã será ${tomorrowName}`;
  // ex: "terça-feira, 26/05/2026 — amanhã será quarta-feira"
}
function looksLikeOpenTodayQuestion(text) {
  const t = normalizeText(text);
  if (t.includes("abre hoje") || t.includes("abrem hoje") || t.includes("funciona hoje")) return true;
  if (t.includes("estao abertos hoje") || t.includes("estão abertos hoje")) return true;
  const hasHoje = /\bhoje\b/.test(t);
  const hasOpenVerb = /\b(abre|abrem|aberto|abertos|funciona|funcionam)\b/.test(t);
  return hasHoje && hasOpenVerb;
}

function looksLikeSundayQuestion(text) {
  const t = normalizeText(text);
  const hasDomingo = /\b(domingo|domingos)\b/.test(t);
  if (!hasDomingo) return false;
  // qualquer intenção de ir, reservar ou perguntar horário no domingo
  return /\b(abre|abrem|aberto|fecha|fechado|funciona|funcionam|atende|horario|hora|reserva|reservar|ir|vou|vamos|posso|pode|da para|daria|consegue|jantar|comer|visitar|aparecer)\b/.test(t);
}

function looksLikeComingTodayIntent(text) {
  const t = normalizeText(text);
  if (!/\bhoje\b/.test(t)) return false;
  return /\b(ir|vou|vamos|posso|pode|da para|daria|consegue|reservar|reserva|jantar|comer|visitar|aparecer|passar|mesa)\b/.test(t);
}

// ===== Handoff inteligente =====
function looksLikeSensitiveTopic(text) {
  const t = normalizeText(text);
  return /\b(hospital|uti|emergencia|emergência|acidente|sangue|ferido|morreu|morte|falecimento|luto|amea(c|ç)a|suicid|assalt|violenc|violência|policia|polícia)\b/.test(
    t
  );
}
function looksLikeInsistence(text) {
  const t = normalizeText(text);
  return /\b(insisto|tem como|não tem como|nao tem como|por favor|mas eu|mas preciso|eu preciso)\b/.test(t);
}

function looksLikeFrustration(text) {
  // Cliente mandou só "?", "??", "???" ou "!" — sinal claro de confusão/frustração
  return /^[?!]{1,6}$/.test((text || "").trim());
}

function looksLikeDiaDoNamorados(text) {
  const t = normalizeText(text);
  return (
    t.includes("namorados") ||
    t.includes("namorado") ||
    t.includes("12 de junho") ||
    /\b12\/06\b/.test(t) ||
    (t.includes("dia 12") && t.includes("junho")) ||
    (t.includes("dia 12") && t.includes("namorad"))
  );
}

// ======== Persistent state (file) ========
const STATE_PATH = process.env.STATE_PATH || path.join(__dirname, "state.json");
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
function notionTextFromProp(prop) {
  if (!prop) return "";
  if (prop.type === "title") return (prop.title || []).map((t) => t.plain_text).join("");
  if (prop.type === "rich_text") return (prop.rich_text || []).map((t) => t.plain_text).join("");
  if (prop.type === "select") return prop.select?.name || "";
  return "";
}

function notionPickProp(page, candidates) {
  const props = page?.properties || {};
  for (const key of candidates) {
    if (props[key]) return props[key];
  }
  return null;
}

async function notionQueryAllRowsFlexible(dbId, pageSize = 100) {
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
      // Suporta DB antigo (Nome/Texto) e novo (Título/Resposta/...)
      const titleProp = notionPickProp(p, ["Título", "Titulo", "Nome", "Nome do template", "Name"]);
      const textProp = notionPickProp(p, ["Resposta", "Texto", "Mensagem", "Valor", "Text"]);
      const catProp = notionPickProp(p, ["Categoria", "Tipo"]);
      const kwProp = notionPickProp(p, ["Palavras-chaves", "Palavras-chave", "Palavras chave", "Palavras_chave", "Keywords"]);
      const activeProp = notionPickProp(p, ["Ativo", "Ativa", "Active"]);

      const name = notionTextFromProp(titleProp).trim();
      const text = notionTextFromProp(textProp).trim();
      const categoria = notionTextFromProp(catProp).trim();
      const keywords = notionTextFromProp(kwProp).trim();
      const ativo = activeProp?.type === "checkbox" ? Boolean(activeProp.checkbox) : true;

      if (!name && !text) continue;
      rows.push({ name, text, categoria, keywords, ativo });
    }

    if (!j.has_more) break;
    cursor = j.next_cursor;
  }

  return rows;
}

async function notionFindExactTextByTitleFlexible(dbId, title, { textPropCandidates } = {}) {
  const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      page_size: 10,
      filter: { property: "Nome", title: { equals: title } },
    }),
  });

  // Se o DB novo não tem propriedade "Nome", a query acima falha. Vamos fazer fallback sem filtro.
  if (!r.ok) {
    // fallback: varrer e achar por name
    const rows = await notionQueryAllRowsFlexible(dbId, 100);
    const hit = rows.find((x) => normalizeText(x.name) === normalizeText(title));
    return hit?.text?.trim() || null;
  }
  const j = await r.json().catch(() => ({}));

  const page = j.results?.[0];
  if (!page) return null;
  const prop = notionPickProp(page, textPropCandidates || ["Texto", "Resposta", "Mensagem", "Valor"]);
  const text = notionTextFromProp(prop);
  return text.trim() || null;
}

// ===== Knowledge cache (FAQ) =====
let KNOWLEDGE = [];
let lastLoadAt = 0;

let TEMPLATE_CACHE = new Map();
let lastTemplatesLoadAt = 0;

async function loadTemplates() {
  if (!NOTION_DB_TEMPLATES) {
    TEMPLATE_CACHE = new Map();
    lastTemplatesLoadAt = Date.now();
    return;
  }
  const rows = await notionQueryAllRowsFlexible(NOTION_DB_TEMPLATES);
  const m = new Map();
  for (const r of rows) {
    if (r.ativo === false) continue;
    const key = String(r.name || "").trim();
    const val = String(r.text || "").trim();
    if (!key || !val) continue;
    m.set(normalizeText(key), val);
  }
  TEMPLATE_CACHE = m;
  lastTemplatesLoadAt = Date.now();
  console.log(`[${nowIso()}] Templates loaded: ${TEMPLATE_CACHE.size}`);
}

async function ensureTemplatesFresh() {
  const maxAgeMs = 5 * 60 * 1000;
  if (Date.now() - lastTemplatesLoadAt > maxAgeMs) await loadTemplates();
}

async function loadKnowledge() {
  const all = [];

  // Se DB novo de FAQ existe, usa ele. Caso contrário cai no legado.
  if (NOTION_DB_FAQ) {
    const rows = await notionQueryAllRowsFlexible(NOTION_DB_FAQ);
    for (const r of rows) {
      if (r.ativo === false) continue;
      all.push({ ...r, db: "faq" });
    }

    // Opcional: cardápio (se você quiser que FAQ responda com base nisso)
    if (NOTION_DB_CARDAPIO) {
      const card = await notionQueryAllRowsFlexible(NOTION_DB_CARDAPIO);
      for (const r of card) {
        if (r.ativo === false) continue;
        all.push({ ...r, db: "cardapio" });
      }
    }

    // Regras SOP NÃO entram no knowledge de FAQ (é lógica interna)
    // Templates NÃO entram no knowledge (pra não poluir)
  } else {
    // Legado
    const dbs = [
      { name: "restaurante", id: NOTION_DB_RESTAURANTE },
      { name: "politica", id: NOTION_DB_POLITICA },
      { name: "precos", id: NOTION_DB_PRECOS },
      { name: "promocoes", id: NOTION_DB_PROMOCOES },
      { name: "regras", id: NOTION_DB_REGRAS },
    ];
    if (NOTION_DB_CARDAPIO) dbs.push({ name: "cardapio", id: NOTION_DB_CARDAPIO });

    for (const db of dbs) {
      const rows = await notionQueryAllRowsFlexible(db.id);
      for (const r of rows) all.push({ ...r, db: db.name });
    }
  }

  KNOWLEDGE = all;
  lastLoadAt = Date.now();
  console.log(`[${nowIso()}] Knowledge loaded: ${KNOWLEDGE.length} rows`);
}

async function ensureKnowledgeFresh() {
  const maxAgeMs = 5 * 60 * 1000;
  if (Date.now() - lastLoadAt > maxAgeMs) await loadKnowledge();
  await loadTemplates();
}

// ===== Motor de Regras (Notion) =====
let BOT_RULES = [];
let lastBotRulesLoadAt = 0;

async function loadBotRules() {
  if (!NOTION_DB_BOT_RULES) return;
  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_BOT_RULES}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: 100 }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Notion rules failed ${r.status}: ${JSON.stringify(j)}`);

    BOT_RULES = (j.results || [])
      .map((p) => {
        try {
          const props = p.properties;
          return {
            evento: (props["Evento"]?.title || []).map((t) => t.plain_text).join("") || "",
            data: props["Data"]?.date?.start || null,          // "YYYY-MM-DD" ou null
            diaSemana: props["Dia da semana"]?.select?.name || null, // "seg"|"ter"|...|null
            acao: props["Ação"]?.select?.name || "",
            conteudo: (props["Conteúdo"]?.rich_text || []).map((t) => t.plain_text).join("") || "",
          };
        } catch (_) {
          return null;
        }
      })
      .filter((r) => r && r.evento && r.acao);

    lastBotRulesLoadAt = Date.now();
    console.log(`[${nowIso()}] Bot rules loaded: ${BOT_RULES.length}`);
  } catch (e) {
    console.error(`[${nowIso()}] loadBotRules error: ${e.message}`);
  }
}

async function ensureBotRulesFresh() {
  const maxAgeMs = 5 * 60 * 1000; // 5 min cache
  if (Date.now() - lastBotRulesLoadAt > maxAgeMs) await loadBotRules();
}

function extractEventKeywords(eventoName) {
  // Palavras-chave derivadas do nome do evento (ignora palavras curtas e stopwords)
  // Divide também por / e - para nomes como "promoção/não reservar"
  const stop = new Set(["de", "do", "da", "dos", "das", "um", "uma", "para", "com", "nos", "nas", "por", "que", "dia", "toda", "todo", "nos", "nao", "sem", "hoje"]);
  return normalizeText(eventoName)
    .split(/[\s\/\-]+/)
    .filter((w) => w.length > 3 && !stop.has(w));
}

function keywordMatchesText(kw, t) {
  // Match exato ou prefixo (ex: "reservar" bate com "reserva", "namorado" bate com "namorados")
  if (t.includes(kw)) return true;
  // prefixo: keyword começa com a palavra do texto ou vice-versa (conjugações/plural)
  const words = t.split(/\s+/);
  return words.some((w) => (w.length >= 4 && kw.startsWith(w)) || (kw.length >= 4 && w.startsWith(kw)));
}

function ruleMatchesMessage(rule, text) {
  const t = normalizeText(text);
  const today = todayStrSaoPaulo();
  const keywords = extractEventKeywords(rule.evento);

  if (rule.data) {
    // Regra de data específica (ex: Dia dos Namorados = 12/06)
    if (today === rule.data) {
      // Hoje é o dia do evento:
      // - Se não tem keywords → dispara para qualquer mensagem (ex: "Fechado hoje")
      // - Se tem keywords → exige TODAS as keywords na mensagem (mais preciso)
      //   Ex: "reserva hoje" → só dispara se a mensagem tiver "reserva" E "hoje"
      if (keywords.length === 0) return true;
      return keywords.every((kw) => keywordMatchesText(kw, t));
    }
    // Data futura/passada: mensagem menciona a data explicitamente
    const dateObj = parseDateBR(t);
    if (dateObj) {
      const mentioned = `${dateObj.yyyy}-${String(dateObj.mm).padStart(2, "0")}-${String(dateObj.dd).padStart(2, "0")}`;
      if (mentioned === rule.data) return true;
    }
    // Ou mensagem menciona palavras do nome do evento (ex: "namorado", "namorados")
    if (keywords.length > 0 && keywords.some((kw) => keywordMatchesText(kw, t))) return true;
    return false;
  }

  if (rule.diaSemana) {
    // Regra recorrente por dia da semana (ex: sexta = promoção delivery)
    if (currentWeekdaySP() !== rule.diaSemana) return false;
    if (keywords.length === 0) return true;
    return keywords.some((kw) => keywordMatchesText(kw, t));
  }

  return false; // regra incompleta (sem data e sem dia da semana)
}

function getActiveRuleForMessage(text) {
  for (const rule of BOT_RULES) {
    if (ruleMatchesMessage(rule, text)) return rule;
  }
  return null;
}

// ===== Evolution send =====
async function evolutionSendText({ remoteJid, text }) {
  const number = (remoteJid || "").split("@")[0];
  const url =
    EVOLUTION_SERVER_URL.replace(/\/$/, "") +
    EVOLUTION_SEND_PATH +
    "/" +
    encodeURIComponent(EVOLUTION_INSTANCE);

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: EVOLUTION_APIKEY },
    body: JSON.stringify({ number, text }),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`Evolution send failed ${r.status}: ${body}`);
  return body;
}

async function evolutionSendTyping({ remoteJid, durationMs = 1500 }) {
  const number = (remoteJid || "").split("@")[0];
  const url =
    EVOLUTION_SERVER_URL.replace(/\/$/, "") +
    "/chat/sendPresence/" +
    encodeURIComponent(EVOLUTION_INSTANCE);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: EVOLUTION_APIKEY },
      body: JSON.stringify({ number, presence: "composing", delay: durationMs }),
    });
    await new Promise((r) => setTimeout(r, Math.min(durationMs, 2500)));
  } catch {
    // typing indicator é best-effort; ignora erros
  }
}

async function notifyAdmin(text) {
  if (!ADMIN_WHATSAPP) return;
  try {
    await evolutionSendText({ remoteJid: `${ADMIN_WHATSAPP}@s.whatsapp.net`, text });
  } catch (e) {
    console.error(`[${nowIso()}] admin_notify_failed`, e?.message || e);
  }
}

function parseHumanNumbers() {
  return String(HUMAN_NUMBERS || "")
    .split(/[,;\s]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function notifyHumans(text) {
  const nums = parseHumanNumbers();
  if (!nums.length) return;
  for (const num of nums) {
    try {
      await evolutionSendText({ remoteJid: `${num}@s.whatsapp.net`, text });
    } catch (e) {
      console.error(`[${nowIso()}] human_notify_failed num=${num}`, e?.message || e);
    }
  }
}

/**
 * Handoff inteligente:
 * - chama humanos (HUMAN_NUMBERS + ADMIN_WHATSAPP)
 * - manda msg pro cliente
 * - PAUSA o chat por HANDOFF_MINUTES (para o bot não ficar atrapalhando)
 * - NÃO cria card no Trello
 */
async function handoffToHuman({ state, remoteJid, reason, incomingText, customClientMsg }) {
  const from = remoteJid.split("@")[0];

  // 1. Mensagem pro cliente (template Notion ou fallback, ou customizada)
  const clientMsg = customClientMsg || await getTemplate(
    "HANDOFF_CLIENTE",
    "Entendi. Só um instante que vou chamar um atendente pra te ajudar direitinho por aqui. 🙏"
  ).catch(() => "Entendi. Só um instante que vou chamar um atendente pra te ajudar direitinho por aqui. 🙏");
  await evolutionSendText({ remoteJid, text: clientMsg });

  // 2. Alert formatado para o atendente
  const alert = [
    "🙋 *ATENDIMENTO HUMANO*",
    `Motivo: ${reason}`,
    `Cliente: https://wa.me/${from}`,
    `Mensagem: "${incomingText}"`,
  ].join("\n");

  // 3. Notifica humanos; admin só se não estiver já em HUMAN_NUMBERS (evita duplicata)
  const humanNums = new Set(parseHumanNumbers());
  try {
    await notifyHumans(alert);
    if (ADMIN_WHATSAPP && !humanNums.has(ADMIN_WHATSAPP)) {
      await notifyAdmin(alert);
    }
  } catch (e) {
    console.error(`[${nowIso()}] handoff_notify_failed`, e?.message || e);
  }

  // 4. Pausa a conversa
  const mins = Math.max(5, Number(HANDOFF_MINUTES || 180));
  const c = { mode: null, data: {} };
  setConv(state, remoteJid, c);
  setHandoffPause(state, remoteJid, mins);
  markBotReplied(state, remoteJid);
}

// ===== Retrieve =====
function simpleRetrieve(question, knowledgeRows, k = 12) {
  const q = normalizeText(question);
  const qWords = new Set(q.split(" ").filter((w) => w.length >= 3));
  const scored = [];

  for (const row of knowledgeRows) {
    // inclui categoria/keywords pra ajudar o retrieve
    const hay = normalizeText(`${row.name} ${row.categoria || ""} ${row.keywords || ""} ${row.text || ""}`);
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
    q.includes("menu") ||
    q.includes("endereco") ||
    q.includes("maps") ||
    q.includes("localizacao") ||
    q.includes("como chegar") ||
    q.includes("site") ||
    q.includes("grupo") ||
    q.includes("tsulovers") ||
    q.includes("instagram") ||
    q.includes("reserva") ||
    q.includes("reservar")
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
  t = t.replace(
    /^(oi|ol[aá]|oie+)\s*[!,.:;\-–—]*\s*(?:[A-Za-zÀ-ÿ0-9_.-]{2,30})?\s*[!,.:;\-–—]*\s*/i,
    ""
  );
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
async function openaiAnswer({ question, retrieved, history = [] }) {
  const sundayWarning =
    FECHADO_DOMINGO !== "0" && isSundaySaoPaulo()
      ? "\n⚠️ HOJE É DOMINGO — O RESTAURANTE ESTÁ FECHADO. Não abrimos aos domingos. Se alguém perguntar sobre horário, visita ou reserva hoje, informe que estamos fechados e que funcionamos de segunda a sábado, 18:30 às 23h."
      : "";

  const sys = `
Você é a Liz, assistente do restaurante Tsunagari (WhatsApp).
Hoje é ${todayInfoSaoPaulo()} (horário de Brasília). Use essa informação para responder corretamente sobre promoções, horários ou eventos do dia.${sundayWarning}
Tom:
- Carinhoso e acolhedor.
- Use 1 a 2 emojis leves quando combinar (🍣✨🙏😊❤️🍷). Não exagerar.
- NÃO use o nome do cliente.
- NÃO comece com saudação ("Olá", "Oi", "Oie").
- NÃO finalize com despedidas.
Conteúdo:
- Responda APENAS o que o cliente perguntou. Seja direto.
- NÃO mencione promoções, descontos ou ofertas proativamente. Só fale de promoções se o cliente perguntar explicitamente sobre desconto ou promoção.
- CARDÁPIO: O restaurante NÃO tem "barca" — o nome correto é "combinado". Se o cliente perguntar sobre barca, corrija gentilmente dizendo que trabalhamos com combinados.
- PROMOÇÕES DO GRUPO TSULOVERS: Se o cliente mencionar uma promoção do grupo de WhatsApp Tsulovers, responda sobre ESSA promoção específica (use os trechos do Notion). NUNCA confunda com a promoção de aniversário.
- ANIVERSÁRIO: NUNCA mencione a promoção/política de aniversário de forma proativa. Só fale sobre aniversário se o cliente mencionar explicitamente a palavra "aniversário", "aniversariante" ou "comemoração de aniversário". Quando falar sobre aniversário, use APENAS as informações literalmente descritas nos trechos do Notion — NUNCA infira, complete ou extrapole detalhes que não estão escritos. Se o cliente perguntar algo específico sobre aniversário que não consta nos trechos (ex: qual tipo de rodízio o aniversariante ganha), diga que não tem essa informação no momento e sugira confirmar diretamente com o restaurante.
- NÃO envie links a menos que o cliente peça link.
- HORÁRIOS: O restaurante funciona de segunda a sábado, das 18:30 às 23h. NUNCA diga "18h" ou "18:00" — o horário correto de abertura é 18:30 (dezoito e meia), sem exceção. DOMINGOS: o restaurante está FECHADO aos domingos.
- PREÇOS: Se os preços estiverem nos trechos do Notion, informe-os normalmente. NUNCA invente ou estime valores que não estejam nos trechos. Se não houver nenhum trecho com preço, diga que não tem essa informação no momento. IMPORTANTE: o preço do rodízio é FIXO e não muda por data — se o cliente perguntar o valor "para o dia X" ou "para a data Y", responda com o preço padrão do Notion (não existe preço especial por data, a menos que haja uma promoção explícita nos trechos).
- RESERVAS: reserva é OPCIONAL (o cliente pode vir sem reserva por ordem de chegada). Se o cliente perguntar se precisa reservar, como reservar, onde reservar ou qualquer coisa sobre reservas, diga que é opcional e que se quiser pode reservar pelo site https://tsunagari-site.vercel.app. Nunca instrua o cliente a enviar dados de reserva pelo WhatsApp.
- Não invente informações; use apenas os trechos fornecidos.
- Se faltou informação, faça uma pergunta curta e objetiva.
Formato:
- 1 a 3 linhas curtas, estilo WhatsApp.
  `.trim();

  const context = (retrieved || [])
    .map((r, i) => `[#${i + 1}] (${r.db}) ${r.name} ${r.text}`)
    .join(" ");

  const user = `Pergunta do cliente: ${question}\nTrechos do Notion: ${context || "(nenhuma informação relevante encontrada)"}`;

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: [
        { role: "system", content: sys },
        ...history.map((h) => ({ role: h.role, content: h.content })),
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

// ===== Other rules =====
function asksNonJapaneseFood(text) {
  const t = normalizeText(text);
  return /\b(pizza|hamburguer|hamburger|hambúrguer|burger|x[-\s]?burger|lanche|esfiha|pastel|churrasco|lasanha|macarrao|macarrão)\b/.test(
    t
  );
}

// ===== Reserva parsing / validation =====
const MONTH_NAMES_PT = {
  janeiro: 1, jan: 1,
  fevereiro: 2, fev: 2,
  marco: 3, março: 3, mar: 3,
  abril: 4, abr: 4,
  maio: 5, mai: 5,
  junho: 6, jun: 6,
  julho: 7, jul: 7,
  agosto: 8, ago: 8,
  setembro: 9, set: 9,
  outubro: 10, out: 10,
  novembro: 11, nov: 11,
  dezembro: 12, dez: 12,
};

// Tenta extrair { dd, mm, yyyy } de texto em linguagem natural (ex: "11 de abril", "abril 11")
function parseDateByMonthName(text) {
  const t = normalizeText(text);
  const monthPattern = Object.keys(MONTH_NAMES_PT).join("|");
  // "11 de abril [de 2026]" ou "11 abril"
  const re1 = new RegExp(`\\b([0-3]?\\d)\\s+(?:de\\s+)?(${monthPattern})(?:\\s+(?:de\\s+)?(\\d{4}))?\\b`);
  // "abril 11 [de 2026]" ou "abril, 11"
  const re2 = new RegExp(`\\b(${monthPattern})[,\\s]+([0-3]?\\d)(?:\\s+(?:de\\s+)?(\\d{4}))?\\b`);
  let m = t.match(re1);
  if (m) {
    const dd = Number(m[1]);
    const mm = MONTH_NAMES_PT[m[2]];
    const yyyy = m[3] ? Number(m[3]) : new Date().getFullYear();
    if (dd >= 1 && dd <= 31 && mm) return { dd, mm, yyyy };
  }
  m = t.match(re2);
  if (m) {
    const mm = MONTH_NAMES_PT[m[1]];
    const dd = Number(m[2]);
    const yyyy = m[3] ? Number(m[3]) : new Date().getFullYear();
    if (dd >= 1 && dd <= 31 && mm) return { dd, mm, yyyy };
  }
  return null;
}

function parseDateToListName(text) {
  const m = text.match(/\b([0-3]?\d)\/([01]?\d)(?:\/(\d{2}|\d{4}))?\b/);
  if (m) {
    let dd = m[1].padStart(2, "0");
    let mm = m[2].padStart(2, "0");
    let yy = m[3];
    if (!yy) yy = String(new Date().getFullYear()).slice(-2);
    else if (yy.length === 4) yy = yy.slice(-2);
    return `${dd}/${mm}/${yy}`;
  }
  const byName = parseDateByMonthName(text);
  if (byName) {
    const dd = String(byName.dd).padStart(2, "0");
    const mm = String(byName.mm).padStart(2, "0");
    const yy = String(byName.yyyy).slice(-2);
    return `${dd}/${mm}/${yy}`;
  }
  return null;
}

function parseDateBR(text) {
  const m = text.match(/\b([0-3]?\d)\/([01]?\d)(?:\/(\d{2}|\d{4}))?\b/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yyyy = m[3]
      ? Number(m[3].length === 2 ? "20" + m[3] : m[3])
      : new Date().getFullYear();
    return { dd, mm, yyyy };
  }
  return parseDateByMonthName(text);
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
  return Math.floor((d - todayUTC) / (24 * 60 * 60 * 1000));
}

function parseTime(text) {
  const m = text.match(/\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/);
  if (m) return `${m[1].padStart(2, "0")}:${m[2]}`;
  // "19h" sem minutos
  const m2 = text.match(/\b([01]?\d|2[0-3])h\b/i);
  if (m2) return `${m2[1].padStart(2, "0")}:00`;
  return null;
}

function parseName(text) {
  const m = text.match(/nome\s*[:\-]\s*([^\r\n]+)/i);
  if (m) return m[1].trim();
  const m2 = text.match(/no nome de\s+([^\r\n]+)/i);
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
  if (raw.length < 2 || raw.length > 60) return false;

  const t = normalizeText(raw);
  if (/\b(reserva|reservar|mesa|amanha|hoje|horario|horário|pessoas|adultos|criancas|crianças)\b/.test(t))
    return false;

  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 5) return false;

  if (!/^[A-Za-zÀ-ÿ'.-]+(\s+[A-Za-zÀ-ÿ'.-]+)*$/.test(raw)) return false;
  return true;
}

/**
 * NOVO: extrai e SOMA total de pessoas.
 * - entende adulto(s), criança(s), adolescente(s), bebê(s)
 * - se não vier por categoria, cai no fallback "X pessoas"
 */
function parsePeopleTotal(text) {
  const t = normalizeText(text);

  const buckets = [
    { re: /\b(\d+)\s*(adulto|adulta|adultos|adultas)\b/g },
    { re: /\b(\d+)\s*(crianca|criancas|criança|crianças)\b/g },
    { re: /\b(\d+)\s*(adolescente|adolescentes)\b/g },
    { re: /\b(\d+)\s*(bebe|bebes|bebê|bebês)\b/g },
  ];

  let sum = 0;
  let matchedAny = false;

  for (const b of buckets) {
    for (const m of t.matchAll(b.re)) {
      matchedAny = true;
      sum += Number(m[1]);
    }
  }

  if (matchedAny) return sum;

  // fallback: "X pessoas/lugares"
  const m2 = t.match(/\b(\d+)\s*(pessoas|pessoa|lugares|lugar)\b/);
  if (m2) return Number(m2[1]);

  // fallback: último número (evitando confundir com hora/data)
  // remove datas tipo 10/03 e 10/03/2026 antes de extrair números
  const noDates = t.replace(/\b[0-3]?\d\/[01]?\d(?:\/\d{2,4})?\b/g, " ");
  const nums = [...noDates.matchAll(/\b(\d{1,2})\b/g)].map((x) => Number(x[1]));
  if (nums.length) {
    const time = parseTime(text);
    if (time) {
      const [hourStr, minStr] = time.split(":");
      const hour = Number(hourStr);
      const min = Number(minStr);
      const filtered = nums.filter((n) => n !== hour && n !== min);
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

// HOJE (SP) para reserva parcial
function getTodayBRDateObjInSaoPaulo() {
  // en-CA -> YYYY-MM-DD
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [yyyy, mm, dd] = fmt.format(new Date()).split("-").map((x) => Number(x));
  return { dd, mm, yyyy };
}
function dateObjToDataList(dateObj) {
  const dd = String(dateObj.dd).padStart(2, "0");
  const mm = String(dateObj.mm).padStart(2, "0");
  const yy = String(dateObj.yyyy).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

// ===== Trello =====
async function trelloGet(url) {
  const full = new URL(url);
  full.searchParams.set("key", TRELLO_KEY);
  full.searchParams.set("token", TRELLO_TOKEN);
  const r = await fetch(full.toString());
  const t = await r.text();
  if (!r.ok) throw new Error(`Trello GET failed ${r.status}: ${t}`);
  try {
    return JSON.parse(t);
  } catch {
    throw new Error(`Trello GET invalid JSON (${r.status}): ${t.slice(0, 200)}`);
  }
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
  try {
    return JSON.parse(t);
  } catch {
    throw new Error(`Trello POST invalid JSON (${r.status}): ${t.slice(0, 200)}`);
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
  // novo formato esperado: "- 8p" ou "- 8"
  const m = (name || "").match(/-\s*(\d{1,2})\s*p\b/i);
  if (m) return Number(m[1]);
  const m2 = (name || "").match(/-\s*(\d{1,2})\s*$/);
  if (m2) return Number(m2[1]);

  // legado: "- 2ad+1c"
  const m3 = (name || "").match(/-\s*(\d{1,2})\s*ad\+\s*(\d{1,2})\s*c\s*$/i);
  if (m3) return Number(m3[1]) + Number(m3[2]);
  return null;
}

let TRELLO_LABEL_CACHE = null; // { byName: Map(name->id) }
let TRELLO_LABEL_CACHE_AT = 0;
const TRELLO_LABEL_CACHE_TTL = 60 * 60 * 1000; // 1 hora

async function trelloGetBoardLabels(boardId) {
  const labels = await trelloGet(`https://api.trello.com/1/boards/${boardId}/labels?limit=1000&fields=name,color`);
  const byName = new Map();
  for (const l of labels || []) byName.set(String(l.name || "").trim(), l.id);
  return { labels, byName };
}

async function trelloEnsureLabel(boardId, name, color) {
  if (!TRELLO_LABEL_CACHE || Date.now() - TRELLO_LABEL_CACHE_AT > TRELLO_LABEL_CACHE_TTL) {
    TRELLO_LABEL_CACHE = await trelloGetBoardLabels(boardId);
    TRELLO_LABEL_CACHE_AT = Date.now();
  }
  const hit = TRELLO_LABEL_CACHE.byName.get(name);
  if (hit) return hit;

  const created = await trelloPost(
    `https://api.trello.com/1/labels?idBoard=${boardId}&name=${encodeURIComponent(name)}&color=${encodeURIComponent(color || "blue")}`,
    null
  );
  TRELLO_LABEL_CACHE.byName.set(name, created.id);
  return created.id;
}

async function trelloGetMesaLabelIds(boardId) {
  return {
    round: await trelloEnsureLabel(boardId, TABLES.round.labelName, TABLES.round.labelColor),
    sofa: await trelloEnsureLabel(boardId, TABLES.sofa.labelName, TABLES.sofa.labelColor),
    normal: await trelloEnsureLabel(boardId, TABLES.normal.labelName, TABLES.normal.labelColor),
  };
}

async function trelloCountListWithMesas(listId, boardId) {
  const labelIds = await trelloGetMesaLabelIds(boardId);
  const cards = await trelloGet(`https://api.trello.com/1/lists/${listId}/cards?fields=name,idLabels&limit=1000`);

  const total = (cards || []).length;
  const twoP = (cards || []).filter((c) => parsePeopleFromCardName(c.name) === 2).length;

  let round = 0, sofa = 0, normal = 0;
  for (const c of cards || []) {
    const ids = c.idLabels || [];
    if (ids.includes(labelIds.round)) round++;
    if (ids.includes(labelIds.sofa)) sofa++;
    if (ids.includes(labelIds.normal)) normal++;
  }

  return { total, twoP, mesas: { round, sofa, normal }, labelIds };
}

function pickMesaType({ pessoasTotal, counts }) {
  const n = Number(pessoasTotal);
  if (!Number.isFinite(n) || n <= 0) return null;

  const avail = {
    round: counts.mesas.round < TABLES.round.count,
    sofa: counts.mesas.sofa < TABLES.sofa.count,
    normal: counts.mesas.normal < TABLES.normal.count,
  };

  // 2–5: SOFA, senão NORMAL
  if (n >= 2 && n <= 5) {
    if (avail.sofa) return "sofa";
    if (avail.normal) return "normal";
    return null;
  }

  // 6–7: REDONDA, senão NORMAL
  if (n >= 6 && n <= 7) {
    if (avail.round) return "round";
    if (avail.normal) return "normal";
    return null;
  }

  // 8–11: REDONDA
  if (n >= 8 && n <= 11) {
    if (avail.round) return "round";
    return null;
  }

  return null; // 1 pessoa ou 12+ sai do fluxo convencional
}

async function trelloCreateHandoffCard({ boardId, from, reason, incomingText }) {
  const list = await trelloEnsureList(boardId, "Atendimentos");
  const title = `${from} — ${reason.slice(0, 80)}`;
  const desc = [
    `Telefone: ${from}`,
    `Link: https://wa.me/${from}`,
    `Motivo: ${reason}`,
    `Mensagem: ${incomingText}`,
  ].join("\n");
  return await trelloPost(`https://api.trello.com/1/cards?idList=${list.id}`, { name: title, desc });
}

async function trelloCreateReservaCard({ listId, boardId, mesaType, nome, hora, pessoasTotal, telefone }) {
  const pessoasLabel = `${Number(pessoasTotal)}p`;
  const title = `${nome} - ${hora} - ${pessoasLabel}`;
  const desc = `Telefone/WhatsApp: ${telefone}`;

  const mesaLabelIds = await trelloGetMesaLabelIds(boardId);
  const idLabels = [];
  if (mesaType && mesaLabelIds[mesaType]) idLabels.push(mesaLabelIds[mesaType]);

  return await trelloPost(`https://api.trello.com/1/cards?idList=${listId}`, { name: title, desc, idLabels });
}

// ===== Templates (Notion) =====
async function getTemplate(templateKey, fallback) {
  // Novo: DB templates (com cache)
  if (NOTION_DB_TEMPLATES) {
    await ensureTemplatesFresh();
    const hit = TEMPLATE_CACHE.get(normalizeText(templateKey));
    if (hit && hit.trim()) return hit.trim();
    return fallback;
  }

  // Legado: DB reservas como templates
  const t = await notionFindExactTextByTitleFlexible(NOTION_DB_RESERVAS, templateKey, {
    textPropCandidates: ["Texto"],
  });
  return t && t.trim() ? t.trim() : fallback;
}

async function buildConfirmMessageFromNotionOrFallback({ nome, dataList, hora, pessoasTotal }) {
  // tenta achar template específico
  const tplKey = "RESERVA_CONFIRMADA";
  const tpl = (await getTemplate(tplKey, "")) || "";

  const peopleLabel = `${Number(pessoasTotal)} pessoa${Number(pessoasTotal) === 1 ? "" : "s"}`;

  if (tpl.trim()) {
    // se o usuário quiser usar variáveis, tenta substituir
    return tpl
      .replace(/\{\{\s*nome\s*\}\}/gi, nome)
      .replace(/\{\{\s*data\s*\}\}/gi, dataList)
      .replace(/\{\{\s*hora\s*\}\}/gi, hora)
      .replace(/\{\{\s*pessoas\s*\}\}/gi, peopleLabel)
      .trim();
  }

  return (
    `Perfeito! 😊\n` +
    `Reserva confirmada:\n` +
    `Nome: ${nome}\n` +
    `Data: ${dataList}\n` +
    `Horário: ${hora}\n` +
    `Pessoas: ${peopleLabel}\n` +
    `❗ 15 minutos de tolerância - após esse período, a mesa pode ser liberada.`
  );
}

// ===== Anti-spam do "missing" =====
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

  // Handoff automático: humano falou
  if (bodyJson?.data?.key?.fromMe) {
    const state = loadState();
    const mins = Math.max(5, Number(HANDOFF_MINUTES || 180));
    const existingConv = getConv(state, remoteJid);
    if (existingConv) {
      existingConv.humanRepliedAt = Date.now(); // cancela o lembrete de 10min
      setConv(state, remoteJid, existingConv);
    }
    setHandoffPause(state, remoteJid, mins);
    console.log(`[${nowIso()}] handoff pause set jid=${remoteJid} mins=${mins}`);
    return;
  }

  const incomingText = extractIncomingText(bodyJson);
  const mediaType = !incomingText ? extractIncomingMediaType(bodyJson) : null;
  if (!incomingText && !mediaType) return;

  // Lock por JID: evita race condition quando 2 mensagens chegam ao mesmo tempo
  if (PROCESSING_LOCK.has(remoteJid)) {
    // Aguarda brevemente e tenta de novo (a primeira já deve ter terminado)
    await new Promise((r) => setTimeout(r, 800));
    if (PROCESSING_LOCK.has(remoteJid)) return; // ainda ocupado, descarta
  }
  PROCESSING_LOCK.add(remoteJid);

  try {

  const state = loadState();

  const msgId = getIncomingMessageId(bodyJson);

  // dedupe
  if (isDuplicateAndMark(state, remoteJid, msgId)) {
    console.log(`[${nowIso()}] dedupe hit jid=${remoteJid} id=${msgId}`);
    return;
  }

  // paused?
  const existing = getConv(state, remoteJid);
  if (existing?.handoffUntil && existing.handoffUntil > Date.now()) return;

  // Cancelamento de reserva — chama atendente antes do motor de regras
  if (incomingText && looksLikeCancelReserva(incomingText)) {
    await handoffToHuman({ state, remoteJid, reason: "Cancelamento de reserva", incomingText });
    return;
  }

  // Mensagem só com emojis — responde com ❤️ gentil e encerra
  if (incomingText && isEmojiOnly(incomingText)) {
    await evolutionSendText({ remoteJid, text: "❤️" });
    markBotReplied(state, remoteJid);
    return;
  }

  // ===== Motor de Regras do Notion =====
  if (incomingText) {
    await ensureBotRulesFresh();
    const activeRule = getActiveRuleForMessage(incomingText);
    if (activeRule) {
      console.log(`[${nowIso()}] regra_ativa jid=${remoteJid} titulo="${activeRule.titulo}" acao=${activeRule.acao}`);

      if (activeRule.acao === "chamar_atendente") {
        await handoffToHuman({ state, remoteJid, reason: `Regra ativa: ${activeRule.titulo}`, incomingText });
        return;
      }

      if (activeRule.acao === "responder" && activeRule.conteudo) {
        // Envia o conteúdo da regra DIRETAMENTE — sem passar pelo OpenAI.
        // O usuário controla a mensagem exata no campo "Conteúdo" do Notion.
        const ruleConv = getConv(state, remoteJid) || { mode: null, data: {} };
        const history = (ruleConv.history || []).slice(-6);

        const typingMs = Math.min(2000, 600 + activeRule.conteudo.length * 15);
        await evolutionSendTyping({ remoteJid, durationMs: typingMs });

        await evolutionSendText({ remoteJid, text: activeRule.conteudo });

        ruleConv.history = [
          ...history,
          { role: "user", content: incomingText },
          { role: "assistant", content: activeRule.conteudo },
        ].slice(-8);
        setConv(state, remoteJid, ruleConv);
        markBotReplied(state, remoteJid);
        return;
      }
    }
  }

  // Opt-out (cliente pediu para parar)
  if (looksLikeOptOut(incomingText)) {
    const msg = await getTemplate(
      "OPTOUT_CONFIRMADO",
      "Tudo certo — não vou te enviar mensagens por aqui. Se quiser voltar, é só me chamar. 🙏"
    );
    await evolutionSendText({ remoteJid, text: msg });
    clearConv(state, remoteJid);
    markBotReplied(state, remoteJid);
    return;
  }

  // Cliente pediu explicitamente para falar com atendente
  if (looksLikeWantsHuman(incomingText)) {
    await handoffToHuman({
      state,
      remoteJid,
      reason: "cliente pediu atendimento humano",
      incomingText,
    });
    return;
  }

  // Frustração / confusão ("?", "??") => handoff imediato
  if (looksLikeFrustration(incomingText)) {
    await handoffToHuman({
      state,
      remoteJid,
      reason: "cliente confuso ou frustrado (enviou apenas '?'/'!')",
      incomingText,
    });
    return;
  }

  // Assunto delicado => handoff (FURA throttle)
  if (looksLikeSensitiveTopic(incomingText)) {
    await handoffToHuman({
      state,
      remoteJid,
      reason: "assunto delicado / fora do escopo (ex.: hospital/emergência/luto)",
      incomingText,
    });
    return;
  }

  // Dia dos Namorados (12/06) — sistema especial de reservas, handoff imediato (FURA throttle)
  if (looksLikeDiaDoNamorados(incomingText)) {
    await handoffToHuman({
      state,
      remoteJid,
      reason: "Dia dos Namorados (12/06) — sistema especial de reservas",
      incomingText,
    });
    return;
  }

  // ===== Guard de domingo — fura throttle (igual ao assunto delicado) =====
  if (FECHADO_DOMINGO !== "0" && isSundaySaoPaulo()) {
    const isDomingoQuestion =
      looksLikeOpenTodayQuestion(incomingText) ||
      looksLikeSundayQuestion(incomingText) ||
      looksLikeComingTodayIntent(incomingText) ||
      // reserva só se for sobre HOJE (não bloqueia reservas futuras feitas num domingo)
      (looksLikeReservaIntent(incomingText) && /\bhoje\b/.test(normalizeText(incomingText)));
    if (isDomingoQuestion) {
      await evolutionSendText({
        remoteJid,
        text: "Hoje é domingo e a gente não abre 🙁\nFuncionamos de segunda a sábado, das 18:30 às 23h. Te esperamos na semana! 🍣✨",
      });
      markBotReplied(state, remoteJid);
      return;
    }
  }

  // throttle
  if (shouldThrottle(existing)) return;

  await ensureKnowledgeFresh();

  // Mídia sem texto (foto, áudio, sticker, documento sem legenda)
  if (mediaType && !incomingText) {
    const mediaMsg = await getTemplate(
      "MEDIA_SEM_TEXTO",
      "Recebi! Me escreve o que precisa que te ajudo 😊"
    );
    await evolutionSendTyping({ remoteJid, durationMs: 800 });
    await evolutionSendText({ remoteJid, text: mediaMsg });
    markBotReplied(state, remoteJid);
    return;
  }

  // "Abre hoje?"
  if (looksLikeOpenTodayQuestion(incomingText)) {
    await evolutionSendText({
      remoteJid,
      text: "Sim, abrimos hoje! Das 18:30 às 23h 🍣✨",
    });
    markBotReplied(state, remoteJid);
    return;
  }

  const inReservaFlow = existing?.mode === "reserva";

  // Greeting (SÓ se NÃO estiver em reserva)
  if (!inReservaFlow && looksLikeGreeting(incomingText)) {
    // novo: template BOAS_VINDAS, se existir
    let welcome = null;
    if (NOTION_DB_TEMPLATES) {
      welcome = await getTemplate("BOAS_VINDAS", "");
    }
    if (!welcome) {
      // legado
      welcome = await notionFindExactTextByTitleFlexible(NOTION_DB_RESTAURANTE, NOTION_WELCOME_NAME, {
        textPropCandidates: ["Texto"],
      });
    }

    await evolutionSendText({
      remoteJid,
      text: welcome || "Oieeee❤️ Aqui é a Liz! Assistente do Tsunagari. Conte comigo!",
    });
    markBotReplied(state, remoteJid);
    return;
  }

  // Non-japanese foods
  if (asksNonJapaneseFood(incomingText)) {
    await evolutionSendText({
      remoteJid,
      text: "A gente é um restaurante japonês 🍣✨ Então não trabalhamos com pizza/hambúrguer. Quer que eu te mande nosso cardápio ou te explico as opções?",
    });
    markBotReplied(state, remoteJid);
    return;
  }

  // Order intent => handoff completo (pausa o bot + card Trello + alerta)
  if (!inReservaFlow && looksLikeOrderIntent(incomingText)) {
    await handoffToHuman({
      state,
      remoteJid,
      reason: "possível pedido/delivery — requer atendimento humano",
      incomingText,
    });
    return;
  }

  // Reserva já confirmada pelo cliente — só acknowledges
  if (looksLikeReservaJaFeita(incomingText)) {
    await evolutionSendText({
      remoteJid,
      text: "Que ótimo! Te esperamos 🍣✨ Qualquer dúvida é só chamar!",
    });
    markBotReplied(state, remoteJid);
    return;
  }

  // ===== Reserva — redireciona para o site =====
  if (looksLikeReservaIntent(incomingText) || looksLikeSofaRequest(incomingText) || inReservaFlow) {
    if (inReservaFlow) clearConv(state, remoteJid);

    const reservaText = looksLikeReservaDuvida(incomingText)
      // Pessoa quer saber se é obrigatório → explica que é opcional
      ? "As reservas são opcionais 😊 Você pode vir sem reserva, por ordem de chegada!\n\nMas se quiser garantir seu lugar, acesse nosso site 🍣\nhttps://tsunagari-site.vercel.app"
      // Pessoa quer reservar → só o link
      : "Faça sua reserva pelo nosso site! 🍣\nAcesse: https://tsunagari-site.vercel.app";

    await evolutionSendText({ remoteJid, text: reservaText });
    markBotReplied(state, remoteJid);
    return;

    /* RESERVA WHATSAPP — desativado em 21/05/2026 (substituído pelo site)
    const conv = existing && inReservaFlow ? existing : { mode: "reserva", data: {}, startedAt: Date.now() };

    // Se está esperando confirmação do limite e cliente insiste em horário impossível => handoff
    if (conv?.awaitingHoraMaxConfirm && !isAffirmative(incomingText)) {
      const tNew = parseTime(incomingText);
      const insisted = looksLikeInsistence(incomingText) || (tNew && !isTimeAllowed(tNew));
      if (insisted) {
        await handoffToHuman({
          state,
          remoteJid,
          reason: `insistência em horário fora do limite (limite=${RESERVA_HORA_MAX})`,
          incomingText,
        });
        return;
      }
    }

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
    const pessoasTotal = parsePeopleTotal(incomingText);

    if (nomeSmart) conv.data.nome = nomeSmart;
    if (dataList) conv.data.dataList = dataList;
    if (hora) conv.data.hora = hora;

    const pediuSofa = looksLikeSofaRequest(incomingText);
    if (pediuSofa) conv.data.pediuSofa = true;

    // Reserva parcial: se tem hora e não tem data => assumir HOJE (SP)
    if (!conv.data.dataList && conv.data.hora) {
      const todayObj = getTodayBRDateObjInSaoPaulo();
      conv.data.dateObj = todayObj;
      conv.data.dataList = dateObjToDataList(todayObj);
    }

    // nome "solto" dentro do fluxo de reserva
    if (!conv.data.nome && looksLikeStandaloneName(incomingText)) {
      conv.data.nome = incomingText.trim();
    }

    if (pessoasTotal != null) conv.data.pessoasTotal = pessoasTotal;

    setConv(state, remoteJid, conv);

    // Early check: grupo grande => handoff imediato (sem precisar coletar mais dados)
    if (pessoasTotal != null && Number(pessoasTotal) >= 12) {
      const np = Number(pessoasTotal);
      await handoffToHuman({
        state,
        remoteJid,
        incomingText,
        reason: `grupo grande (${np} pessoas) — garantia de R$50/assento necessária`,
        customClientMsg: `Para reservas de ${np} pessoas, trabalhamos com uma garantia de reserva de R$50 por assento (totalmente reembolsado no dia da visita 🙂). Vou chamar um atendente para confirmar os detalhes contigo! 🙏`,
      });
      return;
    }

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
        await evolutionSendText({
          remoteJid,
          text: "Essa data já passou 🙂 Consegue me confirmar a data da reserva (DD/MM)?",
        });
        markBotReplied(state, remoteJid);
        return;
      }
      const maxDays = Math.max(7, Number(MAX_ADVANCE_DAYS || 120));
      const delta = daysFromTodayBR(conv.data.dateObj);
      if (delta > maxDays) {
        await evolutionSendText({
          remoteJid,
          text: `Consigo te ajudar sim 😊 Só me confirma uma data mais próxima (até ${maxDays} dias).`,
        });
        markBotReplied(state, remoteJid);
        return;
      }
    }

    // missing
    const missing = [];
    if (!conv.data.nome) missing.push("Nome");
    if (!conv.data.dataList) missing.push("Data (DD/MM ou DD/MM/AAAA)");
    if (!conv.data.hora) missing.push("Horário (ex.: 19:30)");
    if (conv.data.pessoasTotal == null) missing.push("N° de pessoas (ex.: 4 adultos, 2 adolescentes e 2 crianças)");

    if (missing.length) {
      if (shouldSuppressMissingRepeat(conv, missing)) return;

      const pedir = await getTemplate(
        "RESERVA_PEDIR_DADOS",
        "Para fazer sua reserva, me manda por favor:\n- Nome completo\n- Data (DD/MM)\n- Horário\n- N° de pessoas"
      );

      if (inReservaFlow) {
        await evolutionSendText({
          remoteJid,
          text: `Para completar sua reserva só me confirma rapidinho 😊\n${missing.map((m) => `- ${m}`).join("\n")}`,
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
      const msg = await getTemplate(
        "RESERVA_SUGERIR_HORARIO_LIMITE",
        `Posso colocar ${RESERVA_HORA_MAX}? É o limite de horário para reserva. 😊`
      );
      conv.awaitingHoraMaxConfirm = true;
      setConv(state, remoteJid, conv);
      await evolutionSendText({ remoteJid, text: msg });
      markBotReplied(state, remoteJid);
      return;
    }

    // Trello capacity
    const list = await trelloEnsureList(TRELLO_BOARD_ID, conv.data.dataList);
    const counts = await trelloCountListWithMesas(list.id, TRELLO_BOARD_ID);
    const maxTotal = Number(RESERVA_MAX_TOTAL_DIA);
    const n = Number(conv.data.pessoasTotal);

    // Gatilho: 12+ pessoas => handoff (safety net — normalmente já disparado antes)
    if (n >= 12) {
      await handoffToHuman({
        state,
        remoteJid,
        incomingText,
        reason: `grupo grande (${n} pessoas) — garantia de R$50/assento necessária`,
        customClientMsg: `Para reservas de ${n} pessoas, trabalhamos com uma garantia de reserva de R$50 por assento (totalmente reembolsado no dia da visita 🙂). Vou chamar um atendente para confirmar os detalhes contigo! 🙏`,
      });
      return;
    }

    // Gatilho: pediu sofá explicitamente => handoff
    if (conv.data.pediuSofa) {
      await handoffToHuman({
        state,
        remoteJid,
        reason: "cliente pediu sofazinho/sofá — alocação manual necessária",
        incomingText,
      });
      return;
    }

    // Capacidade total atingida
    if (counts.total >= maxTotal) {
      if (n >= 6) {
        await handoffToHuman({
          state,
          remoteJid,
          reason: `capacidade total atingida para grupo grande (${n} pessoas)`,
          incomingText,
        });
        return;
      }
      const msg = await getTemplate(
        "RESERVA_SEM_VAGAS",
        "❗ Já atingimos o limite de reservas para esse dia. Você pode vir sem reserva, por ordem de chegada. 😊"
      );
      await evolutionSendText({ remoteJid, text: msg });
      clearConv(state, remoteJid);
      markBotReplied(state, remoteJid);
      return;
    }

    // Limite 2 pessoas
    if (n === 2 && counts.twoP >= Number(RESERVA_MAX_2P_DIA)) {
      await evolutionSendText({
        remoteJid,
        text: "Hoje já atingimos o limite de reservas para 2 pessoas. 😊 Mas você pode vir sem reserva por ordem de chegada. 🍣✨",
      });
      clearConv(state, remoteJid);
      markBotReplied(state, remoteJid);
      return;
    }

    // Escolher mesa
    const mesaType = pickMesaType({ pessoasTotal: n, counts });
    if (!mesaType) {
      if (n >= 6) {
        await handoffToHuman({
          state,
          remoteJid,
          reason: `sem mesa disponível para ${n} pessoas`,
          incomingText,
        });
        return;
      }
      const msg = await getTemplate(
        "RESERVA_SEM_VAGAS",
        "❗ Já atingimos o limite de reservas para esse dia. Você pode vir sem reserva, por ordem de chegada. 😊"
      );
      await evolutionSendText({ remoteJid, text: msg });
      clearConv(state, remoteJid);
      markBotReplied(state, remoteJid);
      return;
    }

    // Create card
    const telefone = remoteJid.split("@")[0];
    await trelloCreateReservaCard({
      listId: list.id,
      boardId: TRELLO_BOARD_ID,
      mesaType,
      nome: conv.data.nome,
      hora: conv.data.hora,
      pessoasTotal: conv.data.pessoasTotal,
      telefone,
    });

    // Confirm
    const confirmMsg = await buildConfirmMessageFromNotionOrFallback({
      nome: conv.data.nome,
      dataList: conv.data.dataList,
      hora: conv.data.hora,
      pessoasTotal: conv.data.pessoasTotal,
    });

    await evolutionSendText({ remoteJid, text: confirmMsg });

    clearConv(state, remoteJid);
    markBotReplied(state, remoteJid);
    return;
    */
  }

  // ===== FAQ (Notion + OpenAI) =====
  // Se o cliente perguntou sobre promoção/delivery mas nenhuma regra estava ativa,
  // injeta contexto explícito pra o OpenAI não inventar nem pescar promoções permanentes
  await ensureBotRulesFresh();
  const askedAboutPromo = looksLikePromoIntent(incomingText) || looksLikeDeliveryIntent(incomingText);
  const hasActivePromoRule = askedAboutPromo && getActiveRuleForMessage(incomingText) !== null;
  const noPromoCtx = askedAboutPromo && !hasActivePromoRule
    ? [{ db: "regra_ativa", name: "Status promoções", text: "Não há nenhuma promoção especial ativa hoje. Se o cliente perguntar de promoção do dia, informe que hoje não temos promoção especial." }]
    : [];

  const retrieved = [...noPromoCtx, ...simpleRetrieve(incomingText, KNOWLEDGE, 12)];

  // Contexto: últimas 3 trocas da conversa
  const faqConv = getConv(state, remoteJid) || { mode: null, data: {} };
  const history = (faqConv.history || []).slice(-6);

  // Typing enquanto OpenAI processa
  const typingMs = Math.min(3000, 800 + incomingText.length * 20);
  await evolutionSendTyping({ remoteJid, durationMs: typingMs });

  let answer;
  try {
    answer = await openaiAnswer({ question: incomingText, retrieved, history });
  } catch (e) {
    console.error(`[${nowIso()}] openai_failed`, e?.message || e);
    answer = await getTemplate(
      "OPENAI_FALLBACK",
      "Tive uma dificuldade aqui! Me manda sua pergunta novamente ou aguarda um instante. 🙏"
    ).catch(() => "Tive uma dificuldade aqui! Me manda sua pergunta novamente ou aguarda um instante. 🙏");
  }

  await evolutionSendText({ remoteJid, text: answer });

  // Salva histórico (máx. 4 pares = 8 mensagens)
  faqConv.history = [
    ...history,
    { role: "user", content: incomingText },
    { role: "assistant", content: answer },
  ].slice(-8);
  setConv(state, remoteJid, faqConv);
  markBotReplied(state, remoteJid);

  } finally {
    PROCESSING_LOCK.delete(remoteJid);
  }
}

// ===== HTTP server =====
const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    const payload = JSON.stringify({
      status: "ok",
      uptime_s: Math.floor(process.uptime()),
      knowledge_rows: KNOWLEDGE.length,
      templates: TEMPLATE_CACHE.size,
      knowledge_loaded_at: lastLoadAt ? new Date(lastLoadAt).toISOString() : null,
    });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(payload);
  }

  let buf = [];
  req.on("data", (c) => buf.push(c));
  req.on("end", async () => {
    // Validação de origem: se WEBHOOK_SECRET estiver configurado, exige o header
    const secret = process.env.WEBHOOK_SECRET;
    if (secret) {
      const incoming =
        req.headers["x-webhook-secret"] ||
        (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
      if (incoming !== secret) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        return res.end("Unauthorized");
      }
    }

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
      try {
        const remoteJid = bodyJson?.data?.key?.remoteJid || "";
        const incomingText = extractIncomingText(bodyJson);
        await notifyAdmin(
          `🚨 ERRO no bot jid: ${remoteJid.split("@")[0] || "(?)"} msg: ${incomingText || "(sem texto)"} err: ${msg.slice(
            0,
            800
          )}`
        );
      } catch {}
    }
  });
});

// ===== Boot =====
(async () => {
  try {
    await loadKnowledge();
    await loadTemplates();
    await loadBotRules();
  } catch (e) {
    console.error(`[${nowIso()}] initial_load_failed`, e?.message || e);
  }

  try {
    await trelloEnsureList(TRELLO_BOARD_ID, "Atendimentos");
    console.log(`[${nowIso()}] Trello lista "Atendimentos" pronta`);
  } catch (e) {
    console.error(`[${nowIso()}] trello_boot_failed`, e?.message || e);
  }

  // Lembrete de handoff: reenviar alerta se nenhum humano respondeu em 10 minutos
  const HANDOFF_REMINDER_MS = 10 * 60 * 1000;
  setInterval(async () => {
    try {
      const st = loadState();
      const now = Date.now();
      const humanNums = new Set(parseHumanNumbers());

      for (const [jid, conv] of Object.entries(st.conversations || {})) {
        if (!conv.handoffAt) continue;
        if (conv.humanRepliedAt) continue;        // humano já respondeu
        if (conv.handoffReminderSentAt) continue; // lembrete já enviado
        if (now - conv.handoffAt < HANDOFF_REMINDER_MS) continue;

        const from = jid.split("@")[0];
        const since = new Date(conv.handoffAt).toLocaleTimeString("pt-BR", {
          timeZone: "America/Sao_Paulo",
        });
        const reminder = [
          "⏰ *SEM RESPOSTA HÁ 10 MINUTOS*",
          `Cliente aguardando: https://wa.me/${from}`,
          `Handoff às: ${since}`,
        ].join("\n");

        for (const num of humanNums) {
          await evolutionSendText({ remoteJid: `${num}@s.whatsapp.net`, text: reminder }).catch(() => {});
        }
        if (ADMIN_WHATSAPP && !humanNums.has(ADMIN_WHATSAPP)) {
          await evolutionSendText({ remoteJid: `${ADMIN_WHATSAPP}@s.whatsapp.net`, text: reminder }).catch(() => {});
        }

        conv.handoffReminderSentAt = now;
        setConv(st, jid, conv);
        console.log(`[${nowIso()}] handoff_reminder_sent jid=${jid}`);
      }
    } catch (e) {
      console.error(`[${nowIso()}] handoff_reminder_check_failed`, e?.message || e);
    }
  }, 2 * 60 * 1000); // verifica a cada 2 minutos

  const PORT = Number(process.env.PORT || 3000);
  server.listen(PORT, () => console.log(`[${nowIso()}] Tsunagari bot on :${PORT}`));
})();

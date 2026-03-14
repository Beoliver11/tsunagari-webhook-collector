/**
 * Tsunagari WhatsApp Bot (Evolution + Notion + Trello + OpenAI) — “produção”
 *
 * Ajustes (mar/2026):
 * - Notion reorganizado: FAQ / Templates / Regras / Links
 * - Pessoas na reserva: salvar APENAS total (inclui adultos+crianças+adolescentes+bebê)
 * - Mantém FIX domingo / “abre hoje?” determinístico (America/Sao_Paulo)
 * - Mantém: FAQ sem poluição de reservas (não usa DB de templates no knowledge)
 * - Mantém: Reserva parcial (hora sem data => assume HOJE SP)
 * - Mantém: Greeting não dispara dentro do fluxo de reserva
 */

const http = require("http");
const fs = require("fs");
const path = require("path");

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

  // Jobs / cron
  CRON_TOKEN = "",

  // Notion
  NOTION_TOKEN,

  // NOVO (recomendado): Notion DBs por função
  NOTION_DB_FAQ = "2bf12169-2df7-806a-82cc-d8c1c3e39202", // DB — FAQ (Respostas)
  NOTION_DB_TEMPLATES = "516f3fa8-2a01-473d-ab97-e77c51ab4ae7", // DB — Templates (Mensagens prontas)
  NOTION_DB_REGRAS_SOP = "7501bc29-7b0b-40e5-806c-23b43e56ad40", // DB — Regras (SOP)
  NOTION_DB_LINKS = "9269b2de-6d30-4f64-9f57-64feb7f9a371", // DB — Links & Contatos
  NOTION_DB_CLIENTES = "536003b4-9498-4a88-8e12-58c83866192c", // DB — CLIENTES (CRM)
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
function looksLikeSofaRequest(text) {
  // Pedido EXPLÍCITO de mesa de sofazinho/sofá.
  // (Não confundir com a palavra "mesa" genérica.)
  const t = normalizeText(text);
  return /\b(sofazinho|sofazinhozinho|sofa|sof[aá])\b/.test(t);
}
function looksLikeOrderIntent(text) {
  const t = normalizeText(text);
  // Evitar falso positivo em frases tipo "manda o cardápio"
  return (
    /\b(pedido|pedir|quero pedir|vou querer|entrega|delivery|retirar|take away|para viagem)\b/.test(t) ||
    /\b(ifood|i-food|ubereats|uber eats|rappi)\b/.test(t)
  );
}
function looksLikeOptOut(text) {
  const t = normalizeText(text);
  return /\b(parar|pare|stop|cancelar mensagens|nao quero receber|não quero receber|remover meu numero|remover meu número|descadastrar|sair|cancelar notificacoes|cancelar notificações)\b/.test(
    t
  );
}

function looksLikeGreeting(text) {
  // Saudação “pura”, curta, e sem intenção junto
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

// ===== FIX domingo: “abre hoje?” determinístico (timezone SP) =====
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
function looksLikeOpenTodayQuestion(text) {
  const t = normalizeText(text);
  if (t.includes("abre hoje") || t.includes("abrem hoje") || t.includes("funciona hoje")) return true;
  if (t.includes("estao abertos hoje") || t.includes("estão abertos hoje")) return true;
  const hasHoje = /\bhoje\b/.test(t);
  const hasOpenVerb = /\b(abre|abrem|aberto|abertos|funciona|funcionam)\b/.test(t);
  return hasHoje && hasOpenVerb;
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
      const kwProp = notionPickProp(p, ["Palavras-chave", "Palavras chave", "Palavras_chave", "Keywords"]);
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

function dateObjToISODate(dateObj) {
  if (!dateObj) return null;
  const yyyy = String(dateObj.yyyy).padStart(4, "0");
  const mm = String(dateObj.mm).padStart(2, "0");
  const dd = String(dateObj.dd).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseBirthdayDDMM(text) {
  const m = String(text || "").match(/\b([0-3]?\d)\/([01]?\d)\b/);
  if (!m) return null;
  const dd = m[1].padStart(2, "0");
  const mm = m[2].padStart(2, "0");
  return `${dd}/${mm}`;
}

function daysBetweenISO(isoA, isoB) {
  const a = new Date(isoA + "T00:00:00Z");
  const b = new Date(isoB + "T00:00:00Z");
  return Math.floor((b - a) / (24 * 60 * 60 * 1000));
}

async function notionFindClientePageByTelefone(telefone) {
  if (!NOTION_DB_CLIENTES) return null;
  const tel = String(telefone || "").trim();
  if (!tel) return null;

  try {
    const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_CLIENTES}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        page_size: 10,
        filter: { property: "Telefone", title: { equals: tel } },
      }),
    });
    const j = await r.json();
    if (r.ok) {
      const page = j.results?.[0];
      if (page) return page;
    }
  } catch {}

  let cursor = undefined;
  for (let i = 0; i < 20; i++) {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_CLIENTES}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Notion clientes query failed ${r.status}: ${JSON.stringify(j)}`);
    for (const page of j.results || []) {
      const titleProp = notionPickProp(page, ["Telefone", "phone", "Phone"]);
      const v = notionTextFromProp(titleProp).trim();
      if (v === tel) return page;
    }
    if (!j.has_more) break;
    cursor = j.next_cursor;
  }
  return null;
}

function buildClientePropsPatch(patch) {
  const props = {};
  if (patch.telefone != null) {
    props["Telefone"] = { title: [{ text: { content: String(patch.telefone) } }] };
  }
  if (patch.nome != null) {
    props["Nome"] = { rich_text: [{ text: { content: String(patch.nome) } }] };
  }
  if (patch.ultimaConversaISO != null) {
    props["Última conversa"] = { date: { start: patch.ultimaConversaISO } };
  }
  if (patch.ultimaReservaISO != null) {
    props["Última reserva"] = { date: { start: patch.ultimaReservaISO } };
  }
  if (patch.ultimoReengajamentoISO != null) {
    props["Último reengajamento enviado"] = { date: { start: patch.ultimoReengajamentoISO } };
  }
  if (patch.aniversarioDDMM != null) {
    props["Aniversário (DD/MM)"] = { rich_text: [{ text: { content: String(patch.aniversarioDDMM) } }] };
  }
  if (patch.consentAniversario != null) {
    props["Consentimento Aniversário"] = { checkbox: Boolean(patch.consentAniversario) };
  }
  if (patch.consentReengajamento != null) {
    props["Consentimento Reengajamento"] = { checkbox: Boolean(patch.consentReengajamento) };
  }
  if (patch.optOut != null) {
    props["Opt-out"] = { checkbox: Boolean(patch.optOut) };
  }
  if (patch.ativo != null) {
    props["Ativo"] = { checkbox: Boolean(patch.ativo) };
  }
  if (patch.ultimoAniversarioAno != null) {
    props["Último aniversário enviado (ano)"] = { number: Number(patch.ultimoAniversarioAno) };
  }
  return props;
}

async function upsertClienteByTelefone(telefone, patch) {
  if (!NOTION_DB_CLIENTES) return null;
  const tel = String(telefone || "").trim();
  if (!tel) return null;

  const page = await notionFindClientePageByTelefone(tel);
  const props = buildClientePropsPatch({ telefone: tel, ...patch });

  if (page?.id) {
    const r = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ properties: props }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Notion cliente update failed ${r.status}: ${JSON.stringify(j)}`);
    return j;
  }

  const r = await fetch(`https://api.notion.com/v1/pages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { database_id: NOTION_DB_CLIENTES },
      properties: { ...props, Ativo: { checkbox: true }, "Opt-out": { checkbox: false } },
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Notion cliente create failed ${r.status}: ${JSON.stringify(j)}`);
  return j;
}

function todayISOInSaoPaulo() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

function todayDDMMInSaoPaulo() {
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
  });
  return fmt.format(new Date());
}

async function queryClientesForProactive() {
  if (!NOTION_DB_CLIENTES) return [];
  const filter = {
    and: [
      { property: "Ativo", checkbox: { equals: true } },
      { property: "Opt-out", checkbox: { equals: false } },
    ],
  };

  let cursor = undefined;
  const pages = [];
  for (let i = 0; i < 50; i++) {
    const body = { page_size: 100, filter };
    if (cursor) body.start_cursor = cursor;

    const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_CLIENTES}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Notion clientes query failed ${r.status}: ${JSON.stringify(j)}`);

    for (const pg of j.results || []) pages.push(pg);
    if (!j.has_more) break;
    cursor = j.next_cursor;
  }
  return pages;
}

async function runBirthdayJob() {
  const today = todayDDMMInSaoPaulo();
  const yearNum = Number(
    new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric" }).format(new Date())
  );

  const pages = await queryClientesForProactive();
  const tpl = await getTemplate(
    "ANIVERSARIO_MSG",
    "Feliz aniversário! 🎉\nA Liz aqui, em nome da equipe do Tsunagari.\nQuando quiser, é só me chamar pra reservar 🍣✨"
  );

  let sent = 0;
  for (const page of pages) {
    const tel = notionTextFromProp(notionPickProp(page, ["Telefone"]))?.trim();
    const ddmm = notionTextFromProp(page.properties?.["Aniversário (DD/MM)"])?.trim();
    const consent = page.properties?.["Consentimento Aniversário"]?.checkbox === true;
    const lastYear = page.properties?.["Último aniversário enviado (ano)"]?.number;

    if (!tel) continue;
    if (!consent) continue;
    if (ddmm !== today) continue;
    if (Number(lastYear) == yearNum) continue;

    await evolutionSendText({ remoteJid: `${tel}@s.whatsapp.net`, text: tpl });
    await upsertClienteByTelefone(tel, { ultimoAniversarioAno: yearNum });
    sent += 1;
  }
  return sent;
}

async function runReengagementJob() {
  const todayISO = todayISOInSaoPaulo();
  const pages = await queryClientesForProactive();

  const tpl = await getTemplate(
    "REENGAJAMENTO_29D_MSG",
    "Oii! A Liz aqui, em nome da equipe do Tsunagari 😊\nFaz um tempinho que você não vem… vai deixar fazer 30? 🍣✨\nQuer que eu faça uma reserva pra essa semana?"
  );

  let sent = 0;
  for (const page of pages) {
    const tel = notionTextFromProp(notionPickProp(page, ["Telefone"]))?.trim();
    if (!tel) continue;

    const consent = page.properties?.["Consentimento Reengajamento"]?.checkbox === true;
    if (!consent) continue;

    const ultimaReserva = page.properties?.["Última reserva"]?.date?.start;
    if (!ultimaReserva) continue;

    const lastSent = page.properties?.["Último reengajamento enviado"]?.date?.start;
    if (lastSent) {
      const sinceLast = daysBetweenISO(lastSent.slice(0, 10), todayISO);
      if (sinceLast < 29) continue;
    }

    const days = daysBetweenISO(ultimaReserva.slice(0, 10), todayISO);
    if (days < 29) continue;

    await evolutionSendText({ remoteJid: `${tel}@s.whatsapp.net`, text: tpl });
    await upsertClienteByTelefone(tel, { ultimoReengajamentoISO: todayISO });
    sent += 1;
  }
  return sent;
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
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // fallback: varrer e achar por name
    const rows = await notionQueryAllRowsFlexible(dbId, 100);
    const hit = rows.find((x) => normalizeText(x.name) === normalizeText(title));
    return hit?.text?.trim() || null;
  }

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
    await evolutionSendText({ remoteJid: `${num}@s.whatsapp.net`, text });
  }
}

/**
 * Handoff inteligente:
 * - chama humanos (HUMAN_NUMBERS + ADMIN_WHATSAPP)
 * - manda msg pro cliente
 * - PAUSA o chat por HANDOFF_MINUTES (para o bot não ficar atrapalhando)
 * - NÃO cria card no Trello
 */
async function handoffToHuman({ state, remoteJid, reason, incomingText }) {
  const from = remoteJid.split("@")[0];

  await evolutionSendText({
    remoteJid,
    text: "Entendi. Só um instante que vou chamar um atendente pra te ajudar direitinho por aqui. 🙏",
  });

  const alert = `🙋 ATENDIMENTO HUMANO Motivo: ${reason} Cliente: ${from} Mensagem: ${incomingText}`;
  await notifyHumans(alert);
  await notifyAdmin(alert);

  // pausa conversa
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
async function openaiAnswer({ question, retrieved }) {
  const sys = `
Você é a Liz, assistente do restaurante Tsunagari (WhatsApp).
Tom:
- Carinhoso e acolhedor.
- Use 1 a 2 emojis leves quando combinar (🍣✨🙏😊❤️🍷). Não exagerar.
- NÃO use o nome do cliente.
- NÃO comece com saudação ("Olá", "Oi", "Oie").
- NÃO finalize com despedidas.
Conteúdo:
- Responda SOMENTE o que o cliente perguntou.
- NÃO envie links a menos que o cliente peça link.
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
function parseDateToListName(text) {
  const m = text.match(/\b([0-3]?\d)\/([01]?\d)(?:\/(\d{2}|\d{4}))?\b/);
  if (!m) return null;
  let dd = m[1].padStart(2, "0");
  let mm = m[2].padStart(2, "0");
  let yy = m[3];
  if (!yy) yy = String(new Date().getFullYear()).slice(-2);
  else if (yy.length === 4) yy = yy.slice(-2);
  return `${dd}/${mm}/${yy}`;
}

function parseDateBR(text) {
  const m = text.match(/\b([0-3]?\d)\/([01]?\d)(?:\/(\d{2}|\d{4}))?\b/);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = m[3]
    ? Number(m[3].length === 2 ? "20" + m[3] : m[3])
    : new Date().getFullYear();
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
  return Math.floor((d - todayUTC) / (24 * 60 * 60 * 1000));
}

function parseTime(text) {
  const m = text.match(/\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/);
  if (!m) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

function parseName(text) {
  const m = text.match(/nome\s*[:\-]\s*([^\r ]+)\s*$/i);
  if (m) return m[1].trim();
  const m2 = text.match(/no nome de\s+([^\r ]+)\s*$/i);
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
  if (/\b(reserva|reservar|mesa|amanha|hoje|horario|horário|pessoas|adultos|criancas|crianças)\b/.test(t))
    return false;

  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;

  if (!/^[A-Za-zÀ-ÿ'.-]+(\s+[A-Za-zÀ-ÿ'.-]+)+$/.test(raw)) return false;
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
      const hour = Number(time.split(":")[0]);
      const filtered = nums.filter((n) => n != hour);
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

async function trelloCountList(listId) {
  const cards = await trelloGet(`https://api.trello.com/1/lists/${listId}/cards?fields=name&limit=1000`);
  const total = cards.length;
  const twoP = cards.filter((c) => parsePeopleFromCardName(c.name) === 2).length;
  return { total, twoP };
}

let TRELLO_LABEL_CACHE = null; // { byName: Map(name->id) }

async function trelloGetBoardLabels(boardId) {
  const labels = await trelloGet(`https://api.trello.com/1/boards/${boardId}/labels?limit=1000&fields=name,color`);
  const byName = new Map();
  for (const l of labels || []) byName.set(String(l.name || "").trim(), l.id);
  return { labels, byName };
}

async function trelloEnsureLabel(boardId, name, color) {
  if (!TRELLO_LABEL_CACHE) TRELLO_LABEL_CACHE = await trelloGetBoardLabels(boardId);
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
    setHandoffPause(state, remoteJid, mins);
    console.log(`[${nowIso()}] handoff pause set jid=${remoteJid} mins=${mins}`);
    return;
  }

  const incomingText = extractIncomingText(bodyJson);
  if (!incomingText) return;

  const state = loadState();

  // CRM: última conversa (sempre)
  try {
    const telefone = remoteJid.split("@")[0];
    await upsertClienteByTelefone(telefone, { ultimaConversaISO: new Date().toISOString() });
  } catch (e) {
    console.error(`[${nowIso()}] crm_update_failed`, e?.message || e);
  }

  const msgId = getIncomingMessageId(bodyJson);

  // dedupe
  if (isDuplicateAndMark(state, remoteJid, msgId)) {
    console.log(`[${nowIso()}] dedupe hit jid=${remoteJid} id=${msgId}`);
    return;
  }

  // paused?
  const existing = getConv(state, remoteJid);
  if (existing?.handoffUntil && existing.handoffUntil > Date.now()) return;

  // Opt-out (cliente pediu para parar)
  if (looksLikeOptOut(incomingText)) {
    const telefone = remoteJid.split("@")[0];
    try {
      await upsertClienteByTelefone(telefone, { optOut: true });
    } catch {}
    const msg = await getTemplate(
      "OPTOUT_CONFIRMADO",
      "Tudo certo — não vou te enviar mensagens por aqui. Se quiser voltar, é só me chamar. 🙏"
    );
    await evolutionSendText({ remoteJid, text: msg });
    clearConv(state, remoteJid);
    markBotReplied(state, remoteJid);
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

  // throttle
  if (shouldThrottle(existing)) return;

  await ensureKnowledgeFresh();

  // Templates cache
  await ensureTemplatesFresh();

  // Captura aniversário (DD/MM) com consentimento
  try {
    const ddmm = parseBirthdayDDMM(incomingText);
    if (ddmm) {
      const conv0 = getConv(state, remoteJid) || { mode: null, data: {} };
      if (!conv0.pendingBirthdayDDMM) {
        conv0.pendingBirthdayDDMM = ddmm;
        setConv(state, remoteJid, conv0);
        const ask = await getTemplate(
          "CONSENT_ANIVERSARIO_PERGUNTA",
          `Posso anotar seu aniversário (${ddmm}) e te mandar uma mensagem de parabéns nesse dia? (sim/não)`
        );
        await evolutionSendText({ remoteJid, text: ask });
        markBotReplied(state, remoteJid);
        return;
      }
    }
  } catch {}

  // FIX domingo “abre hoje?”
  if (looksLikeOpenTodayQuestion(incomingText)) {
    if (FECHADO_DOMINGO !== "0" && isSundaySaoPaulo()) {
      await evolutionSendText({
        remoteJid,
        text: "Hoje (domingo) a gente não abre 🙂 Funcionamos de segunda a sábado, 18:30 às 23h. 🍣✨",
      });
      markBotReplied(state, remoteJid);
      return;
    }

    await evolutionSendText({
      remoteJid,
      text: "Hoje a gente abre a partir das 18:30 e vai até 23h 🍣✨ Quer que eu te ajude com uma reserva?",
    });
    markBotReplied(state, remoteJid);
    return;
  }

  const inReservaFlow = existing?.mode === "reserva";

  // Confirmação de consentimento de reengajamento
  if (existing?.pendingReengagementConsent) {
    const askedAt = Number(existing.pendingReengagementAskedAt || 0);
    if (Date.now() - askedAt < 10 * 60 * 1000) {
      if (isAffirmative(incomingText)) {
        const telefone = remoteJid.split("@")[0];
        await upsertClienteByTelefone(telefone, { consentReengajamento: true });
        existing.pendingReengagementConsent = null;
        setConv(state, remoteJid, existing);
        await evolutionSendText({ remoteJid, text: "Fechado! 😊" });
        markBotReplied(state, remoteJid);
        return;
      }
      const t = normalizeText(incomingText);
      if (/\b(nao|não|negativo|n)\b/.test(t)) {
        existing.pendingReengagementConsent = null;
        setConv(state, remoteJid, existing);
        await evolutionSendText({ remoteJid, text: "Tudo bem 😊" });
        markBotReplied(state, remoteJid);
        return;
      }
    } else {
      existing.pendingReengagementConsent = null;
      setConv(state, remoteJid, existing);
    }
  }

  // Confirmação de consentimento de aniversário
  if (existing?.pendingBirthdayDDMM) {
    if (isAffirmative(incomingText)) {
      const telefone = remoteJid.split("@")[0];
      await upsertClienteByTelefone(telefone, {
        aniversarioDDMM: existing.pendingBirthdayDDMM,
        consentAniversario: true,
      });
      existing.pendingBirthdayDDMM = null;
      setConv(state, remoteJid, existing);
      await evolutionSendText({ remoteJid, text: "Perfeito! Já deixei anotado 😊" });
      markBotReplied(state, remoteJid);
      return;
    }
    const t = normalizeText(incomingText);
    if (/\b(nao|não|negativo|n)\b/.test(t)) {
      existing.pendingBirthdayDDMM = null;
      setConv(state, remoteJid, existing);
      await evolutionSendText({ remoteJid, text: "Tudo bem 😊" });
      markBotReplied(state, remoteJid);
      return;
    }
  }

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

  // Order intent => notify admin (só fora de reserva)
  if (!inReservaFlow && looksLikeOrderIntent(incomingText)) {
    const from = remoteJid.split("@")[0];
    await notifyAdmin(`⚠️ POSSÍVEL PEDIDO (precisa de atendimento humano) Cliente: ${from} Mensagem: ${incomingText}`);
    await evolutionSendText({
      remoteJid,
      text: "Entendi! 😊 Só um instante que vou chamar alguém da equipe pra te ajudar por aqui. 🍣",
    });
    markBotReplied(state, remoteJid);
    return;
  }

  // ===== Reserva flow =====
  if (looksLikeReservaIntent(incomingText) || looksLikeSofaRequest(incomingText) || inReservaFlow) {
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

    // nome “solto” dentro do fluxo de reserva
    if (!conv.data.nome && looksLikeStandaloneName(incomingText)) {
      conv.data.nome = incomingText.trim();
    }

    if (pessoasTotal != null) conv.data.pessoasTotal = pessoasTotal;

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

    // Gatilho: 12+ pessoas => handoff
    if (n >= 12) {
      await handoffToHuman({
        state,
        remoteJid,
        reason: `grupo grande (${n} pessoas) — requer atendimento manual`,
        incomingText,
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

    // CRM: salvar última reserva (data da reserva)
    try {
      const telefone = remoteJid.split("@")[0];
      const iso = dateObjToISODate(conv.data.dateObj);
      if (iso) await upsertClienteByTelefone(telefone, { ultimaReservaISO: iso });
    } catch {}

    // pergunta consentimento de reengajamento (uma vez, pós-reserva)
    let askedReengagement = false;
    try {
      const telefone = remoteJid.split("@")[0];
      const page = await notionFindClientePageByTelefone(telefone);
      const already = page?.properties?.["Consentimento Reengajamento"]?.checkbox === true;
      const optout = page?.properties?.["Opt-out"]?.checkbox === true;
      if (!already && !optout) {
        const ask = await getTemplate(
          "CONSENT_REENGAJAMENTO_PERGUNTA",
          "Posso te mandar uma mensagem de vez em quando pra facilitar uma nova reserva? (sim/não)"
        );
        const c2 = { mode: null, data: {}, pendingReengagementConsent: true, pendingReengagementAskedAt: Date.now() };
        setConv(state, remoteJid, c2);
        await evolutionSendText({ remoteJid, text: ask });
        askedReengagement = true;
      }
    } catch {}
    if (!askedReengagement) clearConv(state, remoteJid);
    markBotReplied(state, remoteJid);
    return;
  }

  // ===== FAQ (Notion + OpenAI) =====
  const retrieved = simpleRetrieve(incomingText, KNOWLEDGE, 12);
  const answer = await openaiAnswer({ question: incomingText, retrieved });
  await evolutionSendText({ remoteJid, text: answer });
  markBotReplied(state, remoteJid);
}

// ===== HTTP server =====
const server = http.createServer((req, res) => {
  // Jobs endpoint (para cron). Protegido por CRON_TOKEN.
  if (req.method === "POST" && req.url && req.url.startsWith("/jobs/daily")) {
    const token =
      req.headers["x-cron-token"] || new URL(req.url, "http://localhost").searchParams.get("token") || "";
    if (CRON_TOKEN && String(token) !== String(CRON_TOKEN)) {
      res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("UNAUTHORIZED");
    }

    (async () => {
      try {
        must("NOTION_TOKEN", NOTION_TOKEN);
        must("EVOLUTION_SERVER_URL", EVOLUTION_SERVER_URL);
        must("EVOLUTION_APIKEY", EVOLUTION_APIKEY);
        if (!NOTION_DB_CLIENTES) throw new Error("NOTION_DB_CLIENTES não configurado");

        await ensureTemplatesFresh();
        const b = await runBirthdayJob();
        const r = await runReengagementJob();
        console.log(`[${nowIso()}] jobs/daily done birthday=${b} reengagement=${r}`);
      } catch (e) {
        console.error(`[${nowIso()}] jobs/daily error`, e?.message || e);
        try {
          await notifyAdmin(`🚨 ERRO jobs/daily: ${(e?.message || String(e)).slice(0, 700)}`);
        } catch {}
      }
    })();

    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("OK");
  }

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
  } catch (e) {
    console.error(`[${nowIso()}] initial_load_failed`, e?.message || e);
  }
  const PORT = Number(process.env.PORT || 3000);
  server.listen(PORT, () => console.log(`[${nowIso()}] Tsunagari bot on :${PORT}`));
})();

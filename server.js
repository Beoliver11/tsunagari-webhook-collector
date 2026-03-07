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
} = process.env;

function must(name, val) {
  if (!val) throw new Error(`Falta ${name} nas Environment Variables do EasyPanel`);
}

function normalizeText(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeGreeting(text) {
  const t = normalizeText(text);
  return /^(oi|ola|oie+|olá, vim pelo instagram|bom dia|boa tarde|boa noite)\b/.test(t);
}


function looksLikeReservaIntent(text) {
  const t = normalizeText(text);
  return (
    t.includes("reserva") ||
    t.includes("reservar") ||
    t.includes("quero reservar") ||
    t.includes("mesa") ||
    t.includes("agendar") ||
    t.includes("marcar") ||
    t.includes("pra hoje") ||
    t.includes("para hoje") ||
    t.includes("pra amanha") ||
    t.includes("para amanha")
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

// ======== Simple persistent state (file) ========
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
      rows.push({ name: name.trim(), text: text.trim() });
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
  console.log("Knowledge loaded:", KNOWLEDGE.length, "rows");
}

async function ensureKnowledgeFresh() {
  const maxAgeMs = 5 * 60 * 1000;
  if (Date.now() - lastLoadAt > maxAgeMs) await loadKnowledge();
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

// ===== Answer sanitization =====
function shouldAllowLinks(question) {
  const q = normalizeText(question);
  return (
    q.includes("link") ||
    q.includes("cardapio") ||
    q.includes("menu") ||
    q.includes("endereco") ||
    q.includes("maps") ||
    q.includes("localizacao") ||
    q.includes("como chegar")
  );
}

function stripLinks(text) {
  let t = text;
  t = t.replace(/\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/gi, "[link removido]");
  t = t.replace(/https?:\/\/\S+/gi, "");
  return t;
}

function sanitizeAnswer(text, question) {
  let t = (text || "").trim();

  // remove leading greeting + optional name
  t = t.replace(
    /^(oi|ol[aá]|oie+)\s*[!,.:;\-–—]*\s*(?:[A-Za-zÀ-ÿ0-9_.-]{2,30})?\s*[!,.:;\-–—]*\s*/i,
    ""
  );

  // remove “despedidas”
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

  if (!shouldAllowLinks(question)) {
    t = stripLinks(t).replace(/\s+ /g, " ").trim();
  }
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

  const context = retrieved
    .map((r, i) => `[#${i + 1}] (${r.db}) ${r.name} ${r.text}`)
    .join(" ");

  const user = `
Pergunta do cliente: ${question}
Trechos do Notion: ${context || "(nenhuma informação relevante encontrada)"}
`.trim();

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
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

// ===== Reserva parsing =====
function parseDateToListName(text) {
  // accepts dd/mm, dd/mm/yy, dd/mm/yyyy
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

function parseTime(text) {
  const m = text.match(/\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/);
  if (!m) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

function parseAdultsChildren(text) {
  const t = normalizeText(text);

  // "3 adultos e 1 criança"
  const m = t.match(/\b(\d+)\s*adult[oa]s?\b.*?\b(\d+)\s*crianc[ao]s?\b/);
  if (m) return { adultos: Number(m[1]), criancas: Number(m[2]) };

  // "3 adultos" (sem criança)
  const mA = t.match(/\b(\d+)\s*adult[oa]s?\b/);
  if (mA) return { adultos: Number(mA[1]), criancas: 0 };

  // "1 criança" (sem adulto)
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

// FIX 1: parse "Nome: Bernardo Oliveira" (pega a linha inteira)
function parseName(text) {
  // "Nome: Bernardo Oliveira"
  const m = text.match(/nome\s*[:\-]\s*([^\n\r]+)/i);
  if (m) return m[1].trim();

  // "no nome de Bernardo Oliveira"
  const m2 = text.match(/no nome de\s+([^\n\r]+)/i);
  if (m2) return m2[1].trim();

  return null;
}

// FIX 2: quando o cliente manda tudo junto (nome + data + hora + pessoas), inferir nome
function parseNameSmart(text) {
  // 1) Se já tem Nome: ..., usa isso
  const explicit = parseName(text);
  if (explicit) return explicit;

  const hasDate = /\b([0-3]?\d)\/([01]?\d)(?:\/(\d{2}|\d{4}))?\b/.test(text);
  const hasTime = /\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/.test(text);

  if (!hasDate && !hasTime) return null;

  // pega o começo da mensagem até antes da data ou da hora
  const idxDate = text.search(/\b([0-3]?\d)\/([01]?\d)(?:\/(\d{2}|\d{4}))?\b/);
  const idxTime = text.search(/\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/);

  let cut = -1;
  if (idxDate >= 0 && idxTime >= 0) cut = Math.min(idxDate, idxTime);
  else cut = Math.max(idxDate, idxTime);

  if (cut <= 0) return null;

  let candidate = text.slice(0, cut).trim();

  // limpar pontuação comum no começo/fim
  candidate = candidate.replace(/^[\-\s:–—]+/, "").replace(/[\-\s:–—]+$/, "").trim();

  // se a pessoa colocou "3 adultos..." antes da data (raro), remove números no começo
  candidate = candidate.replace(/^\d+\s+/, "").trim();

  // limitar tamanho (nome)
  const words = candidate.split(/\s+/).filter(Boolean);
  if (words.length < 1) return null;

  // evita pegar "Reserva" / "Quero reservar" como nome
  const badStarters = new Set([
    "reserva",
    "reservar",
    "quero",
    "mesa",
    "agendar",
    "marcar",
  ]);
  if (words.length === 1 && badStarters.has(normalizeText(words[0]))) return null;

  // se vier muito grande, corta para 4 palavras
  const cleaned = words.slice(0, 4).join(" ").trim();
  return cleaned || null;
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function isTimeAllowed(hhmm) {
  return timeToMinutes(hhmm) <= timeToMinutes(RESERVA_HORA_MAX);
}

// ===== Trello helpers =====
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

  // create list
  return await trelloPost(
    `https://api.trello.com/1/lists?idBoard=${boardId}&name=${encodeURIComponent(listName)}`,
    null
  );
}

function parsePeopleFromCardName(name) {
  // expected: "Nome - HH:MM - N"
  const m = (name || "").match(/-\s*(\d{1,2})\s*$/);
  if (!m) return null;
  return Number(m[1]);
}

async function trelloCountList(listId) {
  const cards = await trelloGet(
    `https://api.trello.com/1/lists/${listId}/cards?fields=name&limit=1000`
  );
  const total = cards.length;
  const twoP = cards.filter((c) => parsePeopleFromCardName(c.name) === 2).length;
  return { total, twoP };
}

async function trelloCreateReservaCard({ listId, nome, hora, pessoas, telefone }) {
  const title = `${nome} - ${hora} - ${pessoas}`;
  const desc = `Telefone/WhatsApp: ${telefone}`;
  return await trelloPost(`https://api.trello.com/1/cards?idList=${listId}`, {
    name: title,
    desc,
  });
}

// ===== Reserva messages =====
async function getNotionReservaTemplate(name, fallback) {
  const t = await notionFindExactByName(NOTION_DB_RESERVAS, name);
  return t && t.trim() ? t.trim() : fallback;
}

function buildConfirmMessage({ nome, dataList, hora, pessoas }) {
  return (
    `Perfeito! 😊 ` +
    `Reserva confirmada:\n` +
    `Nome: ${nome}\n` +
    `Data: ${dataList}\n` +
    `Horário: ${hora}\n` +
    `Pessoas: ${pessoas}\n` +
    `⏰ Tolerância de 15min. Após esse período, a mesa pode ser liberada pra quem estiver aguardando.\n` +
    `Se precisar alterar ou cancelar, é só avisar! 🍣✨`
  );
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
      must("OPENAI_API_KEY", OPENAI_API_KEY);
      must("NOTION_TOKEN", NOTION_TOKEN);
      must("EVOLUTION_SERVER_URL", EVOLUTION_SERVER_URL);
      must("EVOLUTION_APIKEY", EVOLUTION_APIKEY);
      must("TRELLO_KEY", TRELLO_KEY);
      must("TRELLO_TOKEN", TRELLO_TOKEN);
      must("TRELLO_BOARD_ID", TRELLO_BOARD_ID);

      if (bodyJson.event !== "messages.upsert") return;
      if (bodyJson?.data?.key?.fromMe) return;

      const remoteJid = bodyJson?.data?.key?.remoteJid;
      const incomingText = extractIncomingText(bodyJson);
      if (!remoteJid || !incomingText) return;

      const state = loadState();
      await ensureKnowledgeFresh();

      // 1) greeting => exact welcome from Notion
      if (looksLikeGreeting(incomingText)) {
        const welcome =
          (await notionFindExactByName(NOTION_DB_RESTAURANTE, NOTION_WELCOME_NAME)) ||
          "Oieeee❤️ Aqui é a Liz! Assistente do Tsunagari. Conte comigo!";
        await evolutionSendText({ remoteJid, text: welcome });
        return;
      }

      // 2) Reserva flow
      const existing = getConv(state, remoteJid);
      const inReservaFlow = existing?.mode === "reserva";

      if (looksLikeReservaIntent(incomingText) || inReservaFlow) {
        const conv =
          existing && inReservaFlow
            ? existing
            : { mode: "reserva", data: {}, startedAt: Date.now() };

        // Extract possible fields from this message
        const nome = parseNameSmart(incomingText);
        const dataList = parseDateToListName(incomingText);
        const hora = parseTime(incomingText);
        const ac = parseAdultsChildren(incomingText);
if (ac) {
  // só atualiza se vier algo explícito
  if (ac.adultos !== null) conv.data.adultos = ac.adultos;
  if (ac.criancas !== null) conv.data.criancas = ac.criancas;
} else {
  // fallback: "4 pessoas"
  const total = parsePeopleTotalFallback(incomingText);
  if (total) conv.data.pessoasTotal = total;
}


        if (nome) conv.data.nome = nome;
        if (dataList) conv.data.dataList = dataList;
        if (hora) conv.data.hora = hora;
        if (pessoas) conv.data.pessoas = pessoas;

        setConv(state, remoteJid, conv);

        // Ask for missing
        const missing = [];
        if (!conv.data.nome) missing.push("Nome");
        if (!conv.data.dataList) missing.push("Data (DD/MM ou DD/MM/AAAA)");
        if (!conv.data.hora) missing.push("Horário (ex.: 19:30)");
        if (!conv.data.pessoas) missing.push("Quantidade de pessoas (número)");

        if (missing.length) {
          const pedir = await getNotionReservaTemplate(
            "dados para a reserva",
            "Perfeito! 😊 Pra eu agendar sua reserva, me manda:\nNome:\nData:\nHorário:\nQuantidade de pessoas:"
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
          return;
        }

        // Validate hour
        if (!isTimeAllowed(conv.data.hora)) {
          await evolutionSendText({
            remoteJid,
            text:
              `Consigo fazer reserva para chegada até ${RESERVA_HORA_MAX} (com 15min de tolerância). 😊\n` +
              `Depois desse horário, pode vir sem reserva mesmo, por ordem de chegada. 🍣✨`,
          });
          return;
        }

        // Trello capacity check
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
          return;
        }

        if (Number(conv.data.pessoas) === 2 && counts.twoP >= max2p) {
          await evolutionSendText({
            remoteJid,
            text:
              `Hoje já atingimos o limite de reservas para 2 pessoas. 😊\n` +
              `Mas você pode vir sem reserva por ordem de chegada. 🍣✨`,
          });
          clearConv(state, remoteJid);
          return;
        }

        // Create card
        const telefone = remoteJid.split("@")[0];
        await trelloCreateReservaCard({
          listId: list.id,
          nome: conv.data.nome,
          hora: conv.data.hora,
          pessoas: conv.data.pessoas,
          telefone,
        });

        // Confirm to customer
        await evolutionSendText({
          remoteJid,
          text: buildConfirmMessage({
            nome: conv.data.nome,
            dataList: conv.data.dataList,
            hora: conv.data.hora,
            pessoas: conv.data.pessoas,
          }),
        });

        clearConv(state, remoteJid);
        return;
      }

      // 3) General doubts => Notion + OpenAI
      const retrieved = simpleRetrieve(incomingText, KNOWLEDGE, 12);
      const answer = await openaiAnswer({ question: incomingText, retrieved });
      await evolutionSendText({ remoteJid, text: answer });
    } catch (e) {
      console.error("handler_error", e?.message || e);
    }
  });
});

// ===== Boot =====
(async () => {
  try {
    await loadKnowledge();
  } catch (e) {
    console.error("initial_load_failed", e?.message || e);
  }

  server.listen(3000, () => console.log("Tsunagari bot v2 on :3000"));
})();

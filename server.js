const http = require("http");

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
  return (
    t === "oi" ||
    t === "ola" ||
    t === "oie" ||
    t === "oiee" ||
    t === "oieee" ||
    t === "bom dia" ||
    t === "boa tarde" ||
    t === "boa noite" ||
    t.startsWith("oi ") ||
    t.startsWith("ola ") ||
    t.startsWith("oie ")
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

// ===== Retrieve (keyword) =====
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

// ===== Output sanitizer =====
function shouldAllowLinks(question) {
  const q = normalizeText(question);
  // só permitir links quando o cliente pedir/for claramente sobre link/cardápio/endereço
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

function stripLinks(text) {
  // remove URLs + markdown-style [texto](url)
  let t = text;
  t = t.replace(/\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/gi, "[link removido]");
  t = t.replace(/https?:\/\/\S+/gi, "");
  return t;
}

function sanitizeAnswer(text, question) {
  let t = (text || "").trim();

  // remove "Olá, Fulano" / "Oi Maria" etc.
  t = t.replace(
    /^(oi|ol[aá]|oie+)\s*[!,.:;\-–—]*\s*(?:[A-Za-zÀ-ÿ0-9_.-]{2,30})?\s*[!,.:;\-–—]*\s*/i,
    ""
  );

  // remove encerramentos
  const closings = [
    /\babracos\b\.?\s*$/i,
    /\babraços\b\.?\s*$/i,
    /\baproveite( o)? seu dia\b\.?\s*$/i,
    /\btenha um (otimo|ótimo) dia\b\.?\s*$/i,
    /\bate mais\b\.?\s*$/i,
    /\baté mais\b\.?\s*$/i,
    /\bqualquer coisa\b\.?\s*$/i,
    /\bqualquer dúvida\b\.?\s*$/i,
    /\bé so avisar\b\.?\s*$/i,
    /\bé só avisar\b\.?\s*$/i,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    const before = t;
    for (const re of closings) t = t.replace(re, "");
    t = t.trim();
    if (t !== before) changed = true;
  }

  // remove links se a pergunta não pediu link
  if (!shouldAllowLinks(question)) {
    t = stripLinks(t).replace(/\s+\n/g, "\n").trim();
  }

  // não adiciona frase final automática
  return t.trim();
}

// ===== OpenAI =====
async function openaiAnswer({ question, retrieved }) {
  const sys = `
Você é a Liz, assistente do restaurante Tsunagari (WhatsApp).

Regras obrigatórias:
- NÃO use o nome do cliente.
- NÃO comece com saudação ("Olá", "Oi", "Oie").
- Responda SOMENTE o que o cliente perguntou. Não mude de assunto.
- NÃO envie links a menos que o cliente peça explicitamente um link (ex.: "me manda o link do cardápio").
- NÃO finalize com despedidas/fechamento ("abraços", "aproveite o dia", "até mais", "é só avisar").
- Tom carinhoso e educado.
- Não invente informações; use apenas os trechos fornecidos.
- Se fizer follow-up, no máximo 1 pergunta curta e opcional (ex.: "Quer que eu te envie a carta de vinhos?").

Formato:
- 1 a 3 linhas curtas, estilo WhatsApp.
`.trim();

  const context = retrieved
    .map((r, i) => `[#${i + 1}] (${r.db}) ${r.name}\n${r.text}`)
    .join("\n\n");

  const user = `
Pergunta do cliente:
${question}

Trechos do Notion:
${context || "(nenhuma informação relevante encontrada)"}
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
      temperature: 0.2,
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

// ===== HTTP server =====
const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("OK");
  }

  let buf = [];
  req.on("data", (c) => buf.push(c));

  req.on("end", async () => {
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

      if (bodyJson.event !== "messages.upsert") return;
      if (bodyJson?.data?.key?.fromMe) return;

      const remoteJid = bodyJson?.data?.key?.remoteJid;
      const incomingText = extractIncomingText(bodyJson);
      if (!remoteJid || !incomingText) return;

      await ensureKnowledgeFresh();

      if (looksLikeGreeting(incomingText)) {
        const welcome =
          (await notionFindExactByName(NOTION_DB_RESTAURANTE, NOTION_WELCOME_NAME)) ||
          "Oieeee❤️\nAqui é a Liz! Assistente do Tsunagari.\nConte comigo!";
        await evolutionSendText({ remoteJid, text: welcome });
        return;
      }

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
  server.listen(3000, () => console.log("Tsunagari bot v1 on :3000"));
})();

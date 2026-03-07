const http = require("http");

let last = {
  at: null,
  method: null,
  url: null,
  headers: null,
  bodyRaw: null,
  bodyJson: null,
};

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj, null, 2));
}

const server = http.createServer((req, res) => {
  // Endpoint pra ver o último payload fácil no navegador
  if (req.method === "GET" && (req.url === "/last" || req.url === "/last/")) {
    return sendJson(res, 200, last);
  }

  // Healthcheck simples
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("OK");
  }

  let body = [];
  req.on("data", (c) => body.push(c));
  req.on("end", () => {
    const bodyRaw = Buffer.concat(body).toString("utf8");
    let bodyJson = null;
    try {
      bodyJson = JSON.parse(bodyRaw);
    } catch {}

    last = {
      at: new Date().toISOString(),
      method: req.method,
      url: req.url,
      headers: req.headers,
      bodyRaw,
      bodyJson,
    };

    console.log("---- INCOMING REQUEST ----");
    console.log("AT:", last.at);
    console.log("METHOD:", req.method);
    console.log("URL:", req.url);
    console.log("BODY_RAW:", bodyRaw);
    if (bodyJson) console.log("BODY_JSON:", JSON.stringify(bodyJson, null, 2));

    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("OK");
  });
});

server.listen(3000, () => console.log("Webhook collector on :3000"));

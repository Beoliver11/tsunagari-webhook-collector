const http = require("http");

const server = http.createServer((req, res) => {
  let body = [];
  req.on("data", (c) => body.push(c));
  req.on("end", () => {
    body = Buffer.concat(body).toString("utf8");

    console.log("---- INCOMING REQUEST ----");
    console.log("METHOD:", req.method);
    console.log("URL:", req.url);
    console.log("HEADERS:", JSON.stringify(req.headers, null, 2));
    console.log("BODY_RAW:", body);

    try {
      const j = JSON.parse(body);
      console.log("BODY_JSON:", JSON.stringify(j, null, 2));
    } catch {}

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  });
});

server.listen(3000, () => console.log("Webhook collector on :3000"));

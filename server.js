const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { processRequest, authorizeAction, getDashboard } = require("./src/controlPlane");
const { scenarios } = require("./src/sampleData");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": contentTypes[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === "GET" && url.pathname === "/api/scenarios") {
      sendJson(res, 200, { scenarios });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/dashboard") {
      sendJson(res, 200, getDashboard());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/intercept") {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || "{}");
      const result = await processRequest(payload);
      sendJson(res, result.accepted ? 200 : 422, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/action") {
      const raw = await readBody(req);
      const payload = JSON.parse(raw || "{}");
      const result = authorizeAction(payload);
      sendJson(res, result.allowed ? 200 : 403, result);
      return;
    }

    if (req.method === "GET") {
      serveStatic(res, url.pathname);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`ControlPlane.ai prototype running at http://localhost:${PORT}`);
});

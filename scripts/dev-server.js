#!/usr/bin/env node
"use strict";
// Local server: serves index.html and runs the same /api/v2/* handlers Vercel runs.
// Loads .env.local / .env (both git-ignored) without ever printing their values.
//
//   npm run dev            → http://localhost:3000        (v2 console: /?v=2)
//   PORT=3100 npm run dev  → another port

const fs = require("fs");
const http = require("http");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadEnvFile(path.join(ROOT, ".env.local"));
loadEnvFile(path.join(ROOT, ".env"));

const z = require("../api/_lib/zuper");
const ROUTES = {
  "/api/v2/config": require("../api/v2/config"),
  "/api/v2/ingest": require("../api/v2/ingest"),
  "/api/v2/lead": require("../api/v2/lead"),
};

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  const route = ROUTES[pathname];
  if (route) {
    try {
      await route(req, res);
    } catch {
      // Deliberately generic: error text could contain a target URL.
      if (!res.headersSent) z.sendJson(res, 500, { ok: false, error: { kind: "internal", message: "Proxy handler failed." } });
    }
    return;
  }
  if (pathname === "/" || pathname === "/index.html") {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(path.join(ROOT, "index.html")).pipe(res);
    return;
  }
  res.statusCode = 404;
  res.end("Not found");
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
  console.log(`Mock Lead Generator  http://localhost:${port}   (v2 console: http://localhost:${port}/?v=2)`);
  console.log(`Webhook env          ${z.SOURCES.map((s) => `${s} ${z.webhookEnvUrl(s) ? "set" : "-"}`).join("   ")}`);
  const lead = z.leadApiEnv();
  console.log(`Lead API env         ${lead.baseUrl && lead.apiKey ? "set" : "-"}`);
});

"use strict";
// Proxy route tests: `npm test` (Node ≥ 18, no dependencies).
// Spins up a fake upstream plus a server mounting the real handlers, and checks that
// payloads are forwarded verbatim and that secrets never come back to the browser.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");

const z = require("../api/_lib/zuper");
const handlers = {
  "/api/v2/config": require("../api/v2/config"),
  "/api/v2/ingest": require("../api/v2/ingest"),
  "/api/v2/lead": require("../api/v2/lead"),
};

const TOKEN = "tok_9f8e7d6c5b4a3210ZZ";
const ENV_KEYS = Object.keys(process.env).filter((k) => k.startsWith("ZUPER_") || k === "VERCEL");
const received = [];
let upstreamPort;
let proxyPort;
let upstream;
let proxy;

const listen = (srv) => new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv.address().port)));

test.before(async () => {
  ENV_KEYS.forEach((k) => delete process.env[k]);
  upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    if (req.url.includes("/denied/")) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ message: "bad token" }));
    }
    if (req.url.includes("/echo-token/")) {
      res.writeHead(200, { "content-type": "text/plain", "x-echo": req.url });
      return res.end(`you called ${req.url}`);
    }
    res.writeHead(201, { "content-type": "application/json", "set-cookie": "s=1", "x-request-id": "req-1" });
    res.end(JSON.stringify({ success: true, data: { lead_uid: "lead-123" } }));
  });
  proxy = http.createServer((req, res) => handlers[new URL(req.url, "http://x").pathname](req, res));
  upstreamPort = await listen(upstream);
  proxyPort = await listen(proxy);
});

test.after(() => {
  upstream.close();
  proxy.close();
});

test.beforeEach(() => {
  received.length = 0;
  Object.keys(process.env).filter((k) => k.startsWith("ZUPER_") || k === "VERCEL").forEach((k) => delete process.env[k]);
});

const call = async (path, init = {}) => {
  const res = await fetch(`http://127.0.0.1:${proxyPort}${path}`, {
    method: init.body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    ...init,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
};

const upstreamUrl = (p) => `http://127.0.0.1:${upstreamPort}${p}`;

test("maskUrl keeps host and plain path words, masks token-like segments and query values", () => {
  const masked = z.maskUrl(`https://development.zuperpro.com/api/v1/lead-intake/angi/${TOKEN}?key=abcdef123456&src=angi`);
  assert.ok(masked.startsWith("https://development.zuperpro.com/api/v1/lead-intake/angi/"), masked);
  assert.ok(!masked.includes(TOKEN), masked);
  assert.ok(!masked.includes("abcdef123456"), masked);
  assert.ok(masked.includes("src=angi"), masked);
  assert.equal(z.isSecretSegment("webhooks"), false);
  assert.equal(z.isSecretSegment("3fa85f64-5717-4562-b3fc-2c963f66afa6"), true);
});

test("config reports configured sources with masked URLs only", async () => {
  process.env.ZUPER_WEBHOOK_URL_ANGI = `https://development.zuperpro.com/hooks/angi/${TOKEN}`;
  const { status, json, text } = await call("/api/v2/config");
  assert.equal(status, 200);
  assert.equal(json.sources.angi.configured, true);
  assert.equal(json.sources.thumbtack.configured, false);
  assert.ok(!text.includes(TOKEN), "token leaked in config response");
});

test("ingest forwards the exact body to the env URL and wraps the upstream response", async () => {
  process.env.ZUPER_WEBHOOK_URL_ANGI = upstreamUrl(`/hooks/angi/${TOKEN}`);
  const body = JSON.stringify({ firstName: "Ana", fee: 42.5 });
  const { status, json, text } = await call("/api/v2/ingest", { body: { source: "angi", body } });
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.upstream.status, 201);
  assert.equal(json.upstream.headers["x-request-id"], "req-1");
  assert.equal(json.upstream.headers["set-cookie"], undefined);
  assert.equal(json.target.origin, "server");
  assert.equal(received.length, 1);
  assert.equal(received[0].body, body);
  assert.equal(received[0].headers["content-type"], "application/json");
  assert.ok(!text.includes(TOKEN), "token leaked in ingest response");
});

test("upstream 4xx is returned as data, not as a proxy failure", async () => {
  process.env.ZUPER_WEBHOOK_URL_THUMBTACK = upstreamUrl(`/denied/${TOKEN}`);
  const { status, json } = await call("/api/v2/ingest", { body: { source: "thumbtack", body: "{}" } });
  assert.equal(status, 200);
  assert.equal(json.upstream.status, 401);
  assert.equal(JSON.parse(json.upstream.body).message, "bad token");
});

test("upstream echoes of the token are scrubbed from headers and body", async () => {
  process.env.ZUPER_WEBHOOK_URL_LSA = upstreamUrl(`/echo-token/${TOKEN}`);
  const { json, text } = await call("/api/v2/ingest", { body: { source: "lsa", body: "{}" } });
  assert.equal(json.upstream.status, 200);
  assert.ok(!text.includes(TOKEN), "token leaked via upstream echo");
});

test("signing secret adds an HMAC-SHA256 signature of the raw body", async () => {
  process.env.ZUPER_WEBHOOK_URL_META = upstreamUrl(`/hooks/meta/${TOKEN}`);
  process.env.ZUPER_WEBHOOK_SIGNING_SECRET_META = "shh-secret";
  const body = JSON.stringify({ id: "1", full_name: "Ana Lee" });
  const { json } = await call("/api/v2/ingest", { body: { source: "meta", body } });
  assert.equal(json.target.signed, true);
  const expected = `sha256=${crypto.createHmac("sha256", "shh-secret").update(body).digest("hex")}`;
  assert.equal(received[0].headers["x-hub-signature-256"], expected);
});

test("not configured → 400 not_configured", async () => {
  const { status, json } = await call("/api/v2/ingest", { body: { source: "angi", body: "{}" } });
  assert.equal(status, 400);
  assert.equal(json.error.kind, "not_configured");
});

test("invalid JSON payload is rejected before anything is sent", async () => {
  process.env.ZUPER_WEBHOOK_URL_ANGI = upstreamUrl(`/hooks/angi/${TOKEN}`);
  const { status, json } = await call("/api/v2/ingest", { body: { source: "angi", body: "{nope" } });
  assert.equal(status, 400);
  assert.equal(json.error.kind, "invalid_payload");
  assert.equal(received.length, 0);
});

test("browser-entered URLs must be on the allowlist", async () => {
  const { status, json, text } = await call("/api/v2/ingest", { body: { source: "angi", body: "{}", targetUrl: `https://evil.example.com/x/${TOKEN}` } });
  assert.equal(status, 400);
  assert.equal(json.error.kind, "host_not_allowed");
  assert.ok(!text.includes(TOKEN));
});

test("localhost targets are refused when running on Vercel", async () => {
  process.env.VERCEL = "1";
  const { json } = await call("/api/v2/ingest", { body: { source: "angi", body: "{}", targetUrl: upstreamUrl("/hooks/angi/x") } });
  assert.equal(json.error.kind, "host_not_allowed");
});

test("network failures are reported without leaking the token", async () => {
  process.env.ZUPER_WEBHOOK_URL_ANGI = `http://127.0.0.1:1/hooks/angi/${TOKEN}`;
  const { status, json, text } = await call("/api/v2/ingest", { body: { source: "angi", body: "{}" } });
  assert.equal(status, 502);
  assert.equal(json.error.kind, "network");
  assert.ok(!text.includes(TOKEN));
});

test("lead lookup forwards the API key header and validates the lead id", async () => {
  process.env.ZUPER_LEAD_API_BASE_URL = upstreamUrl("");
  process.env.ZUPER_LEAD_API_KEY = "key-abc-123456";
  const ok = await call("/api/v2/lead", { body: { leadId: "lead-123" } });
  assert.equal(ok.json.ok, true);
  assert.equal(received[0].method, "GET");
  assert.equal(received[0].url, "/api/v1/leads/lead-123");
  assert.equal(received[0].headers["x-api-key"], "key-abc-123456");
  assert.ok(!ok.text.includes("key-abc-123456"));

  const bad = await call("/api/v2/lead", { body: { leadId: "../../etc" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.kind, "invalid_lead_id");
});

test("recent-leads lookup lists the newest leads first", async () => {
  process.env.ZUPER_LEAD_API_BASE_URL = upstreamUrl("/api/v1");
  process.env.ZUPER_LEAD_API_KEY = "key-abc-123456";
  process.env.ZUPER_LEAD_API_PATH = "/leads/{id}";
  const { json } = await call("/api/v2/lead", { body: { action: "recent" } });
  assert.equal(json.ok, true);
  assert.equal(received[0].method, "GET");
  assert.equal(received[0].url, "/api/v1/leads?page=1&limit=25&sort_by=created_at&sort=DESC");
  assert.equal(received[0].headers["x-api-key"], "key-abc-123456");
});

test("a browser-supplied Lead API base URL never receives the server key", async () => {
  process.env.ZUPER_LEAD_API_BASE_URL = upstreamUrl("");
  process.env.ZUPER_LEAD_API_KEY = "server-key-999999";
  const { json } = await call("/api/v2/lead", { body: { leadId: "lead-1", baseUrl: upstreamUrl("") } });
  assert.equal(json.error.kind, "not_configured");
  assert.equal(received.length, 0);
});

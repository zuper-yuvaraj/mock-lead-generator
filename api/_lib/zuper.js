"use strict";
// Shared helpers for the v2 proxy routes (api/v2/*).
//
// Webhook URLs and API keys are secrets. Nothing in here logs them, and anything
// echoed back to the browser (target URL, upstream headers/body, error text) is
// masked or scrubbed first. Files under api/_lib are not exposed as routes by Vercel.

const crypto = require("crypto");

const SOURCES = ["angi", "thumbtack", "lsa", "meta"];
const DEFAULT_ALLOWED_HOSTS = ["zuperpro.com", "zuper.co"];
const DEFAULT_SIGNATURE_HEADER = "X-Hub-Signature-256";
const DEFAULT_LEAD_API_PATH = "/api/v1/leads/{id}";
const DEFAULT_LEAD_API_KEY_HEADER = "x-api-key";
const UPSTREAM_TIMEOUT_MS = 20000;
const MAX_UPSTREAM_BODY = 1000000;
const USER_AGENT = "ZuperGrow-MockLeadGenerator/2.0";
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

// ------------------------------------------------------------
// Environment
// ------------------------------------------------------------
const env = (name) => {
  const v = process.env[name];
  return typeof v === "string" && v.trim() ? v.trim() : null;
};
const sourceEnv = (prefix, source) => env(`${prefix}_${source.toUpperCase()}`);

const webhookEnvUrl = (source) => sourceEnv("ZUPER_WEBHOOK_URL", source);
const signingSecret = (source) => sourceEnv("ZUPER_WEBHOOK_SIGNING_SECRET", source);
const signatureHeader = () => {
  const h = env("ZUPER_WEBHOOK_SIGNATURE_HEADER");
  return h && HEADER_NAME.test(h) ? h : DEFAULT_SIGNATURE_HEADER;
};

// Optional static auth headers per source, as JSON: ZUPER_WEBHOOK_HEADERS_META={"X-Token":"..."}
function extraHeaders(source) {
  const raw = sourceEnv("ZUPER_WEBHOOK_HEADERS", source);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    return Object.fromEntries(Object.entries(parsed).filter(([k, v]) => HEADER_NAME.test(k) && typeof v === "string"));
  } catch {
    return {};
  }
}

function leadApiEnv() {
  return {
    baseUrl: env("ZUPER_LEAD_API_BASE_URL"),
    apiKey: env("ZUPER_LEAD_API_KEY"),
    path: env("ZUPER_LEAD_API_PATH") || DEFAULT_LEAD_API_PATH,
    keyHeader: env("ZUPER_LEAD_API_KEY_HEADER") || DEFAULT_LEAD_API_KEY_HEADER,
  };
}

function allowedHosts() {
  const raw = env("ZUPER_ALLOWED_HOSTS");
  return raw ? raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : DEFAULT_ALLOWED_HOSTS;
}

// ------------------------------------------------------------
// Masking
// ------------------------------------------------------------
const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// Plain words ("api", "webhooks", "lead-intake") stay readable; anything token-like is masked.
function isSecretSegment(seg) {
  const s = safeDecode(seg || "");
  if (s.length < 8) return false;
  if (/^[a-z]+([-_.][a-z]+)*$/.test(s) || /^[A-Z]+([-_.][A-Z]+)*$/.test(s)) return false;
  return /\d/.test(s) || s.length >= 16;
}

function maskSecret(s) {
  const str = String(s);
  return str.length <= 8 ? "••••••" : `${str.slice(0, 3)}••••••${str.slice(-3)}`;
}

function maskUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return maskSecret(raw);
  }
  const path = u.pathname.split("/").map((seg) => (isSecretSegment(seg) ? maskSecret(seg) : seg)).join("/");
  const query = [];
  u.searchParams.forEach((v, k) => query.push(`${k}=${v.length >= 6 ? maskSecret(v) : v}`));
  const auth = u.username || u.password ? "••••@" : "";
  return `${u.protocol}//${auth}${u.host}${path}${query.length ? `?${query.join("&")}` : ""}`;
}

// Every string that must never be echoed back: the URL itself and its secret parts.
function secretParts(rawUrl, extra = []) {
  const parts = new Set(extra.filter((s) => typeof s === "string" && s.length >= 4));
  if (rawUrl) {
    parts.add(rawUrl);
    try {
      const u = new URL(rawUrl);
      parts.add(u.href);
      u.pathname.split("/").forEach((seg) => {
        if (isSecretSegment(seg)) {
          parts.add(seg);
          parts.add(safeDecode(seg));
        }
      });
      u.searchParams.forEach((v) => {
        if (v.length >= 6) parts.add(v);
      });
      if (u.username) parts.add(u.username);
      if (u.password) parts.add(u.password);
    } catch {
      /* not a URL — the raw string is already in the set */
    }
  }
  return [...parts].filter(Boolean).sort((a, b) => b.length - a.length);
}

function scrub(text, secrets) {
  let out = String(text);
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join(maskSecret(s));
  return out;
}

// ------------------------------------------------------------
// Target validation
// ------------------------------------------------------------
const isLocalHost = (h) => h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";

// trusted = URL came from server env. Browser-supplied URLs must match the host allowlist,
// so the deployed proxy can't be used to POST to arbitrary hosts.
function checkTarget(raw, { trusted }) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, kind: "invalid_url", message: "The configured URL is not a valid URL." };
  }
  const host = u.hostname.toLowerCase();
  if (isLocalHost(host)) {
    if (process.env.VERCEL) return { ok: false, kind: "host_not_allowed", message: "localhost targets are only allowed when the tool runs locally." };
    return { ok: true, url: u };
  }
  if (u.protocol !== "https:") return { ok: false, kind: "insecure_url", message: "Use an https:// URL (http is only allowed for localhost)." };
  if (!trusted) {
    const list = allowedHosts();
    if (!list.some((s) => host === s || host.endsWith(`.${s}`))) {
      return {
        ok: false,
        kind: "host_not_allowed",
        message: `The proxy only forwards browser-entered URLs to ${list.join(", ")}. Set ZUPER_ALLOWED_HOSTS on the server to allow ${host}, or configure the URL as a server env var.`,
      };
    }
  }
  return { ok: true, url: u };
}

// ------------------------------------------------------------
// HTTP plumbing — plain Node req/res so the same handlers run on Vercel and in scripts/dev-server.js
// ------------------------------------------------------------
async function readJson(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") return req.body ? JSON.parse(req.body) : {};
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString("utf8") || "{}");
    return req.body; // already parsed by Vercel
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

const fail = (res, status, kind, message, extra = {}) => sendJson(res, status, { ok: false, error: { kind, message }, ...extra });

// Calls the upstream and returns a browser-safe envelope. Redirects are not followed so a
// 3xx is reported as-is instead of silently re-sending the payload somewhere else.
async function forward({ url, method, headers, body, secrets }) {
  const started = Date.now();
  try {
    const res = await fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    let text = await res.text();
    const truncated = text.length > MAX_UPSTREAM_BODY;
    if (truncated) text = text.slice(0, MAX_UPSTREAM_BODY);
    const outHeaders = {};
    res.headers.forEach((v, k) => {
      if (k !== "set-cookie") outHeaders[k] = scrub(v, secrets);
    });
    return {
      ok: true,
      upstream: { status: res.status, statusText: res.statusText, headers: outHeaders, body: scrub(text, secrets), truncated, latencyMs: Date.now() - started },
    };
  } catch (err) {
    const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
    const cause = err && err.cause;
    const message = timedOut
      ? `No response within ${UPSTREAM_TIMEOUT_MS / 1000}s.`
      : (cause && cause.message) || (err && err.message) || "Request failed.";
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: { kind: timedOut ? "timeout" : "network", code: (cause && cause.code) || null, message: scrub(message, secrets) },
    };
  }
}

const hmacSha256 = (secret, body) => crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");

module.exports = {
  SOURCES,
  DEFAULT_LEAD_API_PATH,
  DEFAULT_LEAD_API_KEY_HEADER,
  HEADER_NAME,
  USER_AGENT,
  webhookEnvUrl,
  signingSecret,
  signatureHeader,
  extraHeaders,
  leadApiEnv,
  allowedHosts,
  isSecretSegment,
  maskSecret,
  maskUrl,
  secretParts,
  scrub,
  checkTarget,
  readJson,
  sendJson,
  fail,
  forward,
  hmacSha256,
};

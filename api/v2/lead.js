"use strict";
// POST /api/v2/lead — optional: read the created Lead back from the Zuper Lead API after a send,
// so the console can show the full Lead (including the source-specific data it kept).
// The ingestion webhook is asynchronous ("Enqueued for processing") and doesn't return the Lead.
//
// Request:  { action?: "get" | "recent", leadId?, baseUrl?, apiKey?, path?, keyHeader? }
//   get    → GET {base}{path with {id}}                        (Get Lead Details)
//   recent → GET {base}{path without /{id}}?page=1&limit=25&sort_by=created_at&sort=DESC   (List Leads)
//   Without baseUrl the server env is used (ZUPER_LEAD_API_BASE_URL / _KEY / _PATH / _KEY_HEADER).
//   A browser-supplied baseUrl must come with its own apiKey: the server key is only ever
//   sent to the server-configured base URL.
// Response: same envelope as /api/v2/ingest.

const z = require("../_lib/zuper");

const LEAD_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PATH_TEMPLATE = /^\/[A-Za-z0-9_\-./]*\{id\}[A-Za-z0-9_\-./]*$/;
const RECENT_LIMIT = 25;

module.exports = async function lead(req, res) {
  if (req.method !== "POST") return z.fail(res, 405, "method_not_allowed", "Use POST.");

  let input;
  try {
    input = await z.readJson(req);
  } catch {
    return z.fail(res, 400, "bad_request", "Request body must be JSON.");
  }

  const action = input && input.action === "recent" ? "recent" : "get";
  const leadId = String((input && input.leadId) || "").trim();
  if (action === "get" && !LEAD_ID.test(leadId)) return z.fail(res, 400, "invalid_lead_id", "Lead ID may only contain letters, digits, '-' and '_'.");

  const fromBrowser = typeof input.baseUrl === "string" && input.baseUrl.trim();
  const cfg = fromBrowser
    ? {
        baseUrl: input.baseUrl.trim(),
        apiKey: typeof input.apiKey === "string" ? input.apiKey.trim() : "",
        path: (typeof input.path === "string" && input.path.trim()) || z.DEFAULT_LEAD_API_PATH,
        keyHeader: (typeof input.keyHeader === "string" && input.keyHeader.trim()) || z.DEFAULT_LEAD_API_KEY_HEADER,
      }
    : z.leadApiEnv();

  if (!cfg.baseUrl || !cfg.apiKey) {
    return z.fail(res, 400, "not_configured", fromBrowser ? "Enter both the Lead API base URL and an API key." : "Lead API is not configured on the server (ZUPER_LEAD_API_BASE_URL and ZUPER_LEAD_API_KEY).");
  }
  if (!PATH_TEMPLATE.test(cfg.path) || cfg.path.includes("..")) return z.fail(res, 400, "invalid_path", "Lead API path must start with / and contain {id}, e.g. /api/v1/leads/{id}.");
  if (!z.HEADER_NAME.test(cfg.keyHeader)) return z.fail(res, 400, "invalid_header", "API key header name is invalid.");

  const secrets = z.secretParts(cfg.baseUrl, [cfg.apiKey]);
  const base = z.checkTarget(cfg.baseUrl, { trusted: !fromBrowser });
  if (!base.ok) return z.fail(res, 400, base.kind, z.scrub(base.message, secrets));

  const root = base.url.href.replace(/\/+$/, "");
  let url;
  if (action === "recent") {
    url = new URL(root + cfg.path.slice(0, cfg.path.indexOf("{id}")).replace(/\/+$/, ""));
    url.search = new URLSearchParams({ page: "1", limit: String(RECENT_LIMIT), sort_by: "created_at", sort: "DESC" }).toString();
  } else {
    url = new URL(root + cfg.path.replace("{id}", encodeURIComponent(leadId)));
  }
  const targetInfo = { masked: z.maskUrl(url.href), origin: fromBrowser ? "browser" : "server" };
  const result = await z.forward({
    url,
    method: "GET",
    headers: { accept: "application/json", "user-agent": z.USER_AGENT, [cfg.keyHeader]: cfg.apiKey },
    secrets,
  });
  if (!result.ok) return z.sendJson(res, 502, { ok: false, target: targetInfo, error: result.error, latencyMs: result.latencyMs });
  return z.sendJson(res, 200, { ok: true, target: targetInfo, upstream: result.upstream });
};

"use strict";
// POST /api/v2/ingest — forwards a source payload to that source's Zuper ingestion webhook.
//
// Request:  { source: "angi"|"thumbtack"|"lsa"|"meta", body: "<raw JSON string>", targetUrl?: "<browser-entered URL>" }
// Response: { ok: true, target: { masked, origin, signed }, upstream: { status, statusText, headers, body, latencyMs } }
//       or  { ok: false, error: { kind, message }, target? }
//
// The upstream result is always wrapped (even 4xx/5xx) so the console can show the real
// status and body. Without targetUrl the URL comes from ZUPER_WEBHOOK_URL_<SOURCE> and never
// reaches the browser; the URL travels in the POST body, so it stays out of access logs.

const z = require("../_lib/zuper");

module.exports = async function ingest(req, res) {
  if (req.method !== "POST") return z.fail(res, 405, "method_not_allowed", "Use POST.");

  let input;
  try {
    input = await z.readJson(req);
  } catch {
    return z.fail(res, 400, "bad_request", "Request body must be JSON.");
  }

  const source = String((input && input.source) || "").toLowerCase();
  if (!z.SOURCES.includes(source)) return z.fail(res, 400, "unknown_source", `Unknown source. Expected one of: ${z.SOURCES.join(", ")}.`);

  const body = input.body;
  if (typeof body !== "string" || !body.trim()) return z.fail(res, 400, "invalid_payload", "Payload is empty.");
  try {
    JSON.parse(body);
  } catch (e) {
    return z.fail(res, 400, "invalid_payload", `Payload is not valid JSON: ${e.message}`);
  }

  const browserUrl = typeof input.targetUrl === "string" && input.targetUrl.trim() ? input.targetUrl.trim() : null;
  const rawUrl = browserUrl || z.webhookEnvUrl(source);
  if (!rawUrl) {
    return z.fail(res, 400, "not_configured", `No webhook URL configured for ${source}. Set ZUPER_WEBHOOK_URL_${source.toUpperCase()} on the server or enter one in the console.`);
  }

  const secretHeaders = z.extraHeaders(source);
  const secrets = z.secretParts(rawUrl, Object.values(secretHeaders));
  const target = z.checkTarget(rawUrl, { trusted: !browserUrl });
  if (!target.ok) return z.fail(res, 400, target.kind, z.scrub(target.message, secrets));

  const headers = { "content-type": "application/json", "user-agent": z.USER_AGENT, ...secretHeaders };
  const signing = z.signingSecret(source);
  if (signing) headers[z.signatureHeader()] = `sha256=${z.hmacSha256(signing, body)}`;

  const targetInfo = { masked: z.maskUrl(target.url.href), origin: browserUrl ? "browser" : "server", signed: !!signing };
  const result = await z.forward({ url: target.url, method: "POST", headers, body, secrets });
  if (!result.ok) return z.sendJson(res, 502, { ok: false, target: targetInfo, error: result.error, latencyMs: result.latencyMs });
  return z.sendJson(res, 200, { ok: true, target: targetInfo, upstream: result.upstream });
};

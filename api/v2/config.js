"use strict";
// GET /api/v2/config — which sources have a server-side webhook configured, with masked URLs.
// The console also uses this to detect whether the proxy exists (it doesn't on file:// or plain static hosting).

const z = require("../_lib/zuper");

module.exports = function config(req, res) {
  if (req.method !== "GET") return z.fail(res, 405, "method_not_allowed", "Use GET.");

  const sources = {};
  for (const source of z.SOURCES) {
    const url = z.webhookEnvUrl(source);
    sources[source] = { configured: !!url, masked: url ? z.maskUrl(url) : null, signed: !!z.signingSecret(source) };
  }
  const lead = z.leadApiEnv();
  return z.sendJson(res, 200, {
    ok: true,
    runtime: process.env.VERCEL ? "vercel" : "local",
    sources,
    leadApi: {
      configured: !!(lead.baseUrl && lead.apiKey),
      masked: lead.baseUrl ? z.maskUrl(lead.baseUrl).replace(/\/+$/, "") + lead.path : null,
      path: lead.path,
      keyHeader: lead.keyHeader,
    },
    allowedHosts: z.allowedHosts(),
  });
};

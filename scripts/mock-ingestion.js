#!/usr/bin/env node
"use strict";
// LOCAL MOCK of the Zuper Dev ingestion webhooks and Lead API, for rehearsing the v2 console
// offline. Only two things here mirror the real dev v1 service: the queued webhook reply
// (200 {"type":"success","message":"Enqueued for processing"}) and the Lead API routes / lead_*
// field names from the Lead API Postman collection. Everything else (pipeline/status/address
// shapes, the other envelopes) is an invented fixture — the shapes rotate to prove the console
// doesn't depend on one of them.
//
//   npm run mock   → http://localhost:4010
//
//   POST /hooks/:source/:token          behaviour is picked by the token's prefix:
//     queued_… 200 "Enqueued for processing"; the Lead appears ~2s later  (what dev v1 does)
//     bad_…    401                      boom_…   500 (HTML body)
//     async_…  202, no Lead in body     slow_…   201 after 3s
//     alt_…    201, camelCase envelope  idonly_… 201 with only the Lead ID
//     other    201, envelope with the full Lead
//     A source lead sent twice → the existing Lead is kept (dedup).
//   GET  /api/v1/leads?page&limit&sort_by&sort   List Leads (newest first)   } any x-api-key
//   GET  /api/v1/leads/:lead_uid                 Get Lead Details            } header
//
//   MOCK_CORS=1 adds permissive CORS headers, for testing the console's Direct transport.

const crypto = require("crypto");
const http = require("http");

const PORT = Number(process.env.MOCK_PORT) || 4010;
const CORS = process.env.MOCK_CORS === "1";

const leads = new Map(); // lead_uid → { lead, readyAt }
const refs = new Map(); // `${source}:${ref}` → lead_uid

const firstWord = (s) => String(s || "").trim().split(/\s+/)[0] || "";
const restWords = (s) => String(s || "").trim().split(/\s+/).slice(1).join(" ");
const fieldData = (p, name) => {
  const f = ((p.lead_data && p.lead_data.field_data) || []).find((x) => x.name === name);
  return f ? f.values[0] : undefined;
};

// Mini adapters: just enough mapping to produce a believable Lead for each source.
const ADAPTERS = {
  angi: (p) => ({
    ref: p.leadOid,
    source: "Angi",
    lead: {
      first_name: p.firstName, last_name: p.lastName, email: p.email, phone: p.primaryPhone,
      address: { street: p.address, city: p.city, state: p.stateProvince, zip_code: p.postalCode },
      service: p.taskName, description: p.leadDescription,
    },
    extra: { fee: p.fee, trusted_form_url: p.trustedFormUrl, sr_oid: p.srOid, sp_entity_id: p.spEntityId, match_type: p.matchType },
  }),
  thumbtack: (p) => {
    const d = p.data || {};
    const c = d.customer || {};
    const r = d.request || {};
    const loc = r.location || {};
    return {
      ref: d.negotiationID,
      source: "Thumbtack",
      lead: {
        first_name: c.firstName, last_name: c.lastName, phone: c.phone,
        address: { city: loc.city, state: loc.state, zip_code: loc.zipCode },
        service: r.category && r.category.name, description: r.description,
      },
      extra: { questions: r.details, estimate: d.estimate, lead_price: d.leadPrice, charge_state: d.chargeState },
    };
  },
  lsa: (p) => {
    const c = p.contactDetails || {};
    const conv = (p.conversations || [])[0] || {};
    return {
      ref: p.id,
      source: "Google LSA",
      lead: {
        first_name: firstWord(c.consumerName), last_name: restWords(c.consumerName), phone: c.phoneNumber,
        address: { city: c.city, state: c.state, zip_code: c.zipCode },
        service: p.serviceType, description: conv.messageDetails && conv.messageDetails.text,
      },
      extra: { lead_type: p.leadType, lead_price_micros: p.leadPriceMicros, charge_status: p.chargeStatus },
    };
  },
  meta: (p) => {
    if (p.lead_data) {
      const g = p.lead_data;
      return {
        ref: g.id,
        source: "Meta",
        lead: {
          first_name: firstWord(fieldData(p, "full_name")), last_name: restWords(fieldData(p, "full_name")),
          email: fieldData(p, "email"), phone: fieldData(p, "phone_number"), address: { zip_code: fieldData(p, "zip_code") },
        },
        extra: { campaign_name: g.campaign_name, ad_name: g.ad_name, form_answers: g.field_data },
      };
    }
    const { full_name, email, phone_number, street_address, city, state, zip_code, id, ...rest } = p;
    return {
      ref: id,
      source: "Meta",
      lead: {
        first_name: firstWord(full_name), last_name: restWords(full_name), email, phone: phone_number,
        address: { street: street_address, city, state, zip_code },
      },
      extra: rest,
    };
  },
};

const MEDIUM = { angi: "ANGI", thumbtack: "THUMBTACK", lsa: "GOOGLE_LSA", meta: "META" };
const DEFAULT_PIPELINE_UID = crypto.randomUUID();

// lead_* names, external_id, medium, lead_type: from the Lead API Postman collection.
// lead_address / lead_pipeline / lead_status / source_data shapes: invented for the mock.
function toLead(source, mapped) {
  const m = mapped.lead;
  return {
    lead_uid: crypto.randomUUID(),
    lead_first_name: m.first_name || null,
    lead_last_name: m.last_name || null,
    lead_full_name: [m.first_name, m.last_name].filter(Boolean).join(" "),
    lead_email: m.email || null,
    lead_contact_no: { mobile: m.phone || null },
    lead_address: m.address,
    lead_summary: m.description || null,
    service: m.service || null,
    lead_type: "INBOUND",
    medium: MEDIUM[source],
    external_id: String(mapped.ref == null ? "" : mapped.ref),
    lead_pipeline: { pipeline_uid: DEFAULT_PIPELINE_UID, pipeline_name: "Default Pipeline" },
    lead_status: { status_name: "New", status_type: "NEW" },
    created_at: new Date().toISOString(),
    source_data: mapped.extra,
  };
}

function altShape(lead) {
  return {
    ok: true,
    result: {
      leadId: lead.lead_uid,
      contact: { firstName: lead.lead_first_name, lastName: lead.lead_last_name, emailAddress: lead.lead_email, phoneNumber: lead.lead_contact_no.mobile },
      location: { city: lead.lead_address.city, stateCode: lead.lead_address.state, postalCode: lead.lead_address.zip_code },
      leadSource: lead.medium,
      stage: "NEW",
      pipelineName: "Default",
    },
  };
}

function send(res, status, body, type = "application/json") {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.setHeader("X-Request-Id", crypto.randomUUID());
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  if (CORS) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type, x-api-key");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return send(res, 204, "");
  }
  const url = new URL(req.url, "http://localhost");

  const hook = url.pathname.match(/^\/hooks\/([a-z]+)\/([^/]+)$/);
  if (hook && req.method === "POST") {
    const [, source, token] = hook;
    const adapter = ADAPTERS[source];
    if (!adapter) return send(res, 404, { error: "NOT_FOUND", message: "Unknown source" });
    if (token.startsWith("bad_")) return send(res, 401, { error: "UNAUTHORIZED", message: "Invalid or rotated webhook token" });
    if (token.startsWith("boom_")) return send(res, 500, "<html><body><h1>500 Internal Server Error</h1></body></html>", "text/html");
    if (token.startsWith("slow_")) await sleep(3000);

    let payload;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: "INVALID_JSON", message: "Body is not valid JSON" });
    }
    const mapped = adapter(payload);
    if (!mapped.lead.first_name && !mapped.lead.phone && !mapped.lead.email) {
      return send(res, 400, { error: "VALIDATION_FAILED", message: "No contact details found in the payload", source });
    }

    const queued = token.startsWith("queued_");
    const refKey = `${source}:${mapped.ref}`;
    const existing = refs.get(refKey);
    if (existing) {
      if (queued) return send(res, 200, { type: "success", message: "Enqueued for processing" });
      return send(res, 200, { success: true, duplicate: true, message: "Lead already ingested — existing lead returned", data: leads.get(existing).lead });
    }

    const lead = toLead(source, mapped);
    const isAsync = queued || token.startsWith("async_");
    leads.set(lead.lead_uid, { lead, readyAt: Date.now() + (isAsync ? 2000 : 0) });
    refs.set(refKey, lead.lead_uid);

    if (queued) return send(res, 200, { type: "success", message: "Enqueued for processing" });
    if (isAsync) return send(res, 202, { accepted: true, ingestion_id: `ing_${crypto.randomBytes(6).toString("hex")}` });
    if (token.startsWith("alt_")) return send(res, 201, altShape(lead));
    if (token.startsWith("idonly_")) return send(res, 201, { lead_uid: lead.lead_uid });
    return send(res, 201, { success: true, message: "Lead created", data: lead });
  }

  if (url.pathname === "/api/v1/leads" && req.method === "GET") {
    if (!req.headers["x-api-key"]) return send(res, 401, { error: "UNAUTHORIZED", message: "Missing x-api-key" });
    const limit = Math.min(Number(url.searchParams.get("limit")) || 10, 100);
    const ready = [...leads.values()].filter((e) => e.readyAt <= Date.now()).map((e) => e.lead);
    ready.sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
    return send(res, 200, { type: "success", data: ready.slice(0, limit), total_records: ready.length });
  }

  const leadGet = url.pathname.match(/^\/api\/v1\/leads\/([^/]+)$/);
  if (leadGet && req.method === "GET") {
    if (!req.headers["x-api-key"]) return send(res, 401, { error: "UNAUTHORIZED", message: "Missing x-api-key" });
    const entry = leads.get(decodeURIComponent(leadGet[1]));
    if (!entry || entry.readyAt > Date.now()) return send(res, 404, { error: "NOT_FOUND", message: "Lead not found" });
    return send(res, 200, { type: "success", data: entry.lead });
  }

  send(res, 404, { error: "NOT_FOUND" });
});

server.listen(PORT, () => {
  console.log(`Mock ingestion server  http://localhost:${PORT}   (CORS ${CORS ? "on" : "off"})`);
  console.log(`  webhook  POST http://localhost:${PORT}/hooks/<angi|thumbtack|lsa|meta>/<token>`);
  console.log(`  lead API GET  http://localhost:${PORT}/api/v1/leads[/<lead_uid>]   (any x-api-key)`);
});

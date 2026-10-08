# Zuper Grow · Mock Lead Generator

A single page with two versions. The switch under the logo changes between them, and `?v=2` opens v2 directly.

- **v1 · Generator** is the original tool. It makes realistic Angi, Thumbtack, Google LSA and Meta payloads and posts them to a workflow webhook. It is unchanged.
- **v2 · Ingestion** is a console for the Lead Source Ingestion service. It sends a source payload to that source's Zuper webhook and shows:
  - the HTTP response
  - the Lead that was created
  - how the payload's fields mapped onto the Lead (**Lead Mapping**)
  - the source-specific data that was kept (**Additional Source Data**)
  - a list of **Recent Tests**

```
source payload → Zuper webhook → source adapter → Lead object → default pipeline / New
```

## Run locally

```bash
cp .env.example .env.local   # add the webhook URLs (this file is git-ignored)
npm run dev                  # http://localhost:3000/?v=2   (PORT=3100 npm run dev for another port)
```

No `npm install` is needed. It runs on Node 18 or later with no dependencies.

## Configuring webhooks (v2)

Each source has its own ingestion webhook, and **the token in the URL is a secret**.

| Env var | Purpose |
|---|---|
| `ZUPER_WEBHOOK_URL_ANGI` / `_THUMBTACK` / `_LSA` / `_META` | Ingestion webhook for each source |
| `ZUPER_WEBHOOK_SIGNING_SECRET_<SOURCE>` | Optional. Adds an HMAC-SHA256 signature of the body (`X-Hub-Signature-256: sha256=…`) |
| `ZUPER_WEBHOOK_HEADERS_<SOURCE>` | Optional. Extra static headers, given as JSON |
| `ZUPER_LEAD_API_BASE_URL`, `ZUPER_LEAD_API_KEY` | Optional. After a send, fetches the created Lead (`GET /api/v1/leads/{id}` with an `x-api-key` header; override these with `_PATH` and `_KEY_HEADER`) |
| `ZUPER_ALLOWED_HOSTS` | Domains the proxy will forward URLs entered in the browser to. Default: `zuperpro.com,zuper.co` |

- **Server env (preferred).** Set the variables in `.env.local`, or in the Vercel project settings. The browser only ever receives a masked version, such as `…/angi/tok••••••210`.
- **Entered in the console.** Use *Zuper Dev webhooks → Set* in the left panel. The URL is kept in that browser's localStorage only, shown masked, and sent to the proxy inside the request body, so it never appears in a URL or a log. It takes priority over the server env URL until you remove it.

Requests go **browser → `/api/v2/ingest` → Zuper**. This proxy lives in `api/v2/*` and runs as a Vercel function, or inside `npm run dev` locally. It avoids CORS problems and keeps the server-side URLs out of the browser. The *Direct* transport skips the proxy, but only works if the endpoint sends CORS headers.

> When deployed, anyone who can open the tool can send leads through the server-configured webhooks. Keep the deployment behind Vercel Deployment Protection, or only set the env vars where that's acceptable.

## Rehearsing offline

```bash
npm run mock    # fake ingestion + Lead API on http://localhost:4010 (invented response shapes)
```

Point a source at `http://localhost:4010/hooks/<source>/<token>`. The start of the token picks the behaviour:

| Token prefix | Response |
|---|---|
| `queued_` | 200 "Enqueued for processing"; the Lead appears about 2 seconds later (what dev v1 does) |
| `bad_` | 401 |
| `boom_` | 500 |
| `async_` | 202 with no Lead |
| `alt_` | camelCase envelope |
| `idonly_` | only the Lead ID |
| anything else | the full Lead |

Sending the same lead again tests deduplication.

## Tests

```bash
npm test        # proxy routes: forwarding, signing, allowlist, no secrets in responses
```

## Notes

- **The dev v1 webhook is asynchronous.** It replies `200 {"type":"success","message":"Enqueued for processing"}`, and the source adapter creates the Lead in the background a few seconds later. The webhook never returns the Lead. To show it, the console reads it back through the Lead API (Postman collection, API-5688):
  1. It polls `GET /api/v1/leads?sort_by=created_at&sort=DESC` and matches your payload by external ID, email, phone or name.
  2. It then calls `GET /api/v1/leads/{lead_uid}`.

  This needs `ZUPER_LEAD_API_BASE_URL=https://development.zuperpro.com` and an `x-api-key` for the **same company** as the webhook. You can set these in the env or under *Endpoints → Lead API*.
- The Lead Mapping table compares two things:
  - **The source → Lead field pairs** are the tool's own config (`V2_MAPPINGS` in `index.html`).
  - **Lead values, Lead IDs and the ✓ marks** come only from the real response. Field names are matched by common aliases, so the page keeps working if the response format changes.
- The Meta **Zapier** payload is modelled on what Zapier's "Facebook Lead Ads → New Lead" trigger outputs. Check it against a real Zap run.

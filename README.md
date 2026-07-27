[日本語版はこちら / Japanese version](README.ja.md)

# multi-network-dashboard

A self-hosted dashboard that gives a single view over network estates managed by
**HPE Aruba Networking Central** and **Juniper Mist**.

It was originally the `network-investigation` plugin inside Corstack. That plugin
grew its own polling, storage and UI concerns, so it was split out into this
standalone Docker application, and the Global Overview, Webhook Log and Central
Streaming features were added on top.

## Features

The UI is a set of tabs, each backed by an independent plugin under `plugins/`.

### Network Investigation (`plugins/network-investigation`)

Ask a question in natural language ("check the health and alerts for site X") and
the backend runs the Claude CLI against the Central / Mist MCP servers, streaming
the tool calls and the answer back over SSE.

- Site → platform routing table, so a Central-only question never loads the Mist MCP server
- Threaded history, per-session sharing (Markdown / plain text / mail)
- Charts, Mermaid diagrams and topology rendering in answers
- Scheduled queries (cron) with the results appended to the query history

### Global Overview (`plugins/global-overview`)

Polls the Central and Mist REST APIs directly (no MCP in the path) and renders a
cross-platform estate summary: per-site health, device and client counts, active
alerts, plus a Leaflet map with a pin per site. Clicking a site opens a detail
page with SLE metrics, device tables, connected clients, alerts and events.

Both clients are rate limited (Central's quota is shared account-wide, so this app
deliberately uses only part of it) and the poll result is cached on disk, so the UI
never fans out requests on its own.

### Webhook Log (`plugins/webhook-feed`)

Central and Mist webhooks are received by a Google Apps Script and written into a
Google Spreadsheet; this tab reads that sheet with a service account and shows a
unified, filterable feed. Severe alerts can optionally trigger an automatic
pre-investigation through the Network Investigation plugin.

The webhook receiver itself lives in a separate repository:
**[central-mist-webhook-to-google-sheets](https://github.com/kshimonoj/central-mist-webhook-to-google-sheets)** —
set that up first if you want this tab to have data.

### Central Streaming (`plugins/central-streaming`)

Subscribes to the Central Streaming API over WebSocket, decodes the protobuf
CloudEvents (AP monitoring, AP events, audit trail, geofence, location, location
analytics) and shows them as a live feed. Site IDs are resolved to names from the
Global Overview snapshot without issuing extra HTTP requests.

## Requirements

- Docker / Docker Compose
- A Claude Code OAuth token (`claude setup-token`) — the investigation plugin shells out to the `claude` CLI
- Central API credentials (OAuth2 client credentials) and/or a Mist API token
- Optional: a Google service account with read access to the webhook spreadsheet

## Setup

```bash
cp .env.example .env      # then fill in the values
docker compose up -d --build
# http://localhost:8092
```

Secrets are never baked into the image: `.env`, `secrets/` and `data/` are all
excluded by `.gitignore` and `.dockerignore`, and are mounted at runtime instead.

### Environment variables

Names only — see `.env.example` for the accompanying notes. Do not commit values.

| Variable | Purpose |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude CLI authentication |
| `NETINV_MODEL` | Default model for the investigation agent |
| `CENTRAL_BASE_URL` | Central API base URL |
| `CENTRAL_CLIENT_ID` | Central OAuth2 client id |
| `CENTRAL_CLIENT_SECRET` | Central OAuth2 client secret |
| `CENTRAL_TOKEN_URL` | Central token endpoint |
| `CENTRAL_RATE_PER_SEC` / `CENTRAL_RATE_BURST` | Central client-side rate limit |
| `MIST_BASE_URL` | Mist API base URL |
| `MIST_API_TOKEN` | Mist API token |
| `MIST_ORG_ID` | Mist organization id (resolved at startup if omitted) |
| `MIST_RATE_PER_SEC` / `MIST_RATE_BURST` | Mist client-side rate limit |
| `MIST_ALARM_WINDOW_SEC` | Mist alarm aggregation window |
| `GLOBAL_OVERVIEW_POLL_MS` | Global Overview poll interval |
| `GLOBAL_OVERVIEW_MIN_REFRESH_MS` | Minimum interval for a manual refresh |
| `WEBHOOK_LOG_SPREADSHEET_ID` | Spreadsheet holding the webhook log |
| `WEBHOOK_LOG_SA_KEY_FILE` | Path to the service account JSON key |
| `WEBHOOK_FEED_POLL_MS` | Webhook Log poll interval |
| `WEBHOOK_FEED_MIN_REFRESH_MS` | Minimum interval for a manual refresh |
| `WEBHOOK_FEED_AUTO_ENABLED` | Enable automatic pre-investigation |
| `WEBHOOK_FEED_AUTO_MAX_PER_CYCLE` | Cost cap: investigations per poll |
| `WEBHOOK_FEED_AUTO_MAX_AGE_MS` | Ignore rows older than this |

## Layout

```
server/       Express entry point; mounts each plugin's router
src/          App shell (tabs, theming)
plugins/      One directory per feature; <plugin>/view/ is the React side
instructions/ Task specifications and per-task findings notes
data/         Runtime state and caches (git-ignored)
secrets/      Service account keys (git-ignored)
```

Runtime state is kept as files under `data/` rather than in a database. Each file
has exactly one writer, and derived data (site maps, status caches, snapshots) is
always regenerable from Central / Mist.

## Development

```bash
npm install
npm run dev        # tsx watch on server/index.ts
npm run typecheck
npm run build
```

## Notes

The `instructions/` directory keeps the original task specs and the findings notes
written while building each feature — including API quirks that are not documented
upstream. Real site names, device identifiers and tenant IDs have been redacted
from those notes with placeholders such as `<SITE_A>` and `<CENTRAL_SITE_ID>`.

# Marks

Marks is a local-first automation toolkit for running **LLM-guided operations** across HTTP APIs, WebSocket services, and Gmail from the command line.

The repository currently contains:

- A Python CLI agent (`marks.py`) that loads API specs and executes tool calls through an LM Studio OpenAI-compatible model.
- A local Gmail wrapper (`gmailwrap.mjs`) that provides list/read/send operations via the `himalaya` CLI.
- A Node.js WebSocket proxy client (`lmstudio-proxy-client.js`) that relays chat/model requests from a remote control channel to a local LM Studio instance.
- A reference endpoint inventory (`apis.txt`) for external API surface planning.

## Features

### 1) Spec-driven tool generation (HTTP + WS)

`marks.py` reads one or more JSON specs and dynamically generates:

- HTTP tools for `GET`, `POST`, `PUT`, `PATCH`, `DELETE`
- WebSocket connect tools per spec channel
- Generic WS tools (`ws_send`, `ws_recv`, etc.) for active sockets

It supports both OpenAI-style **tools/tool_choice** and legacy **functions/function_call** in LM Studio-compatible chat completions.

### 2) Resolve → Execute → Verify safety workflow

For each request, the agent runs a phased flow:

1. **RESOLVE** (read-first lookup)
2. **EXECUTE** (perform writes if needed)
3. **VERIFY** (read-back confirmation before final answer)

For update-like requests, the workflow attempts to resolve a specific target entity first and enforces write/verify guardrails unless disabled by flags.

### 3) Action gate for risky operations

Write-like operations are blocked by default (HTTP mutation methods, WebSocket sends, and Gmail send) unless the operator explicitly passes:

```bash
--gate ALLOW
```

### 4) Local Gmail tools

When enabled with `--gmailwrap <path>`, the CLI exposes:

- `gmail_list(folder, page, pageSize)`
- `gmail_read(id)`
- `gmail_send(to, subject, body)`

`gmail_send` adds a request-id marker and attempts to verify the message in Sent folders to reduce accidental duplicate sends.

### 5) Remote control WebSocket clients (LM proxy + Marks tools agent)

`lmstudio-proxy-client.js` connects to a server-side WebSocket channel and proxies model listing + chat completions (including streaming deltas/cancel support) to a local LM Studio API.

`marks.py` can also connect to the same control channel (`--control-ws-url`) and answer `chat` messages by running the Marks tool-enabled workflow (resolve/execute/verify + HTTP/WS/Gmail tools).

---

## Module-by-module guide

## `marks.py`

Primary orchestrator CLI.

### Responsibilities

- Connect to LM Studio OpenAI-compatible endpoints (`/v1/models`, `/v1/chat/completions`)
- Parse JSON specs and derive tool sets from paths + server URLs
- Execute HTTP calls with argument normalization and fallback rules
- Manage WebSocket connections and messaging tools
- Optionally bridge Gmail operations via `gmailwrap.mjs`
- Enforce operation safety guards and verification checks
- Produce final user-facing response after tool interaction

### Important internal areas

- **OpenAICompat client**: model selection, chat completions (streaming and non-streaming)
- **Tool framework**: `ToolDef`, spec-name sanitization, HTTP/WS tool builders
- **HTTP execution layer**: URL/path/query/header/body normalization and request dispatch
- **WS manager**: connection lifecycle and generic send/receive tooling
- **Gmail adapter**: subprocess execution of `gmailwrap.mjs` with JSON result parsing
- **Policy logic**: write-intent detection, read-before-write behavior, and verify pairing

## `gmailwrap.mjs`

Local adapter around the `himalaya` mail CLI.

### Responsibilities

- Execute Himalaya commands with optional account selection fallback
- Return structured JSON for list/read operations
- Send message templates with unique request identifiers
- Attempt post-send verification by scanning common Sent folders
- Surface fatal authentication/connection errors while treating ambiguous send outcomes carefully to avoid duplicate sends

### CLI subcommands

- `list [folder] [page] [pageSize]`
- `read <id>`
- `send <to> <subject> <body...>`

## `lmstudio-proxy-client.js`

WebSocket client for remote orchestration of local LM Studio.

### Responsibilities

- Connect/reconnect to control WS endpoint with exponential backoff + heartbeat
- Handle control message types (`models`, `chat`, `cancel`, ping/pong)
- Proxy to local LM Studio API (`/models`, `/chat/completions`)
- Stream deltas/chunks to control plane when chat streaming is enabled
- Abort in-flight model requests on cancellation or disconnect

## `apis.txt`

Reference inventory of expected/observed external API and WebSocket endpoints. This file is planning/reference documentation, not executable code.

---


## HTTP API documentation

The canonical OpenAPI specification is in `docs/openapi.json`.

Covered HTTP endpoints:

- `GET /health`
- `GET /api/apps`
- `GET /api/geocode`
- `GET /api/lookup`
- `GET /api/parcel`
- `GET /api/section`
- `GET /api/aliquots`
- `GET /api/subdivision`
- `GET /api/static-map`
- `GET /api/utilities`
- `GET /api/project-file/template`
- `POST /api/project-file/compile`
- `GET /api/fld-config`
- `GET /api/localstorage-sync`
- `POST /api/localstorage-sync`
- `POST /extract`
- `GET /api/ros-pdf`

The OpenAPI spec includes request parameters, request bodies, and response schemas for each route so it can be used directly by tooling.

## CLI usage

## Prerequisites

- Python 3.9+
- Node.js 18+
- Python deps for `marks.py`:
  - `requests`
  - `websocket-client`
- Optional for Gmail integration:
  - `himalaya` CLI configured with your mail account

## Main agent CLI (`marks.py`)

```bash
python3 marks.py "<request>" <spec1.json> [spec2.json ...] [options]
# control WS mode (same protocol as lmstudio-proxy-client.js)
python3 marks.py <spec1.json> [spec2.json ...] --control-ws-url wss://server/ws/lmproxy
```

### Core options

- `--stream` stream assistant text where supported
- `--trace` verbose tool arguments + results
- `--no-debug` suppress summary logs
- `--resolve-steps <n>` max RESOLVE loop steps
- `--execute-steps <n>` max EXECUTE loop steps
- `--no-write-guard` disable confirmed-write requirement
- `--no-verify-guard` disable read-back verification requirement

### LLM connection options

- `--llm-base-url` (default `LMSTUDIO_BASE_URL` or `http://localhost:1234/v1`)
- `--llm-key` (default `OPENAI_API_KEY` or `lm_studio`)
- `--model` (default `LMSTUDIO_MODEL` or `local-model`)
- `--llm-timeout` (default `LMSTUDIO_TIMEOUT` or `240`)
- `--llm-retries` (default `LMSTUDIO_RETRIES` or `1`)

### Spec transport overrides

- `--http-base-url` (or `MARKS_HTTP_BASE_URL`)
- `--ws-base-url` (or `MARKS_WS_BASE_URL`)
- `--bearer` add `Authorization: Bearer <token>`
- `--header "Key: Value"` repeatable custom headers

### Gmail and action gate

- `--gmailwrap <path>` (or `MARKS_GMAILWRAP`) to enable Gmail tools
- `--gate ALLOW` (or `MARKS_GATE=ALLOW`) to unlock write/send actions

### Control WebSocket mode (`marks.py`)

- `--control-ws-url` (or `CONTROL_WS_URL`) connect to lmstudio-proxy-client compatible control channel
- `--control-token` (or `CONTROL_TOKEN`) sends `x-control-token` header
- `--client-id` (or `CLIENT_ID`) override hello identity

## Gmail wrapper CLI (`gmailwrap.mjs`)

```bash
node gmailwrap.mjs list [folder] [page] [pageSize]
node gmailwrap.mjs read <id>
node gmailwrap.mjs send <to> <subject> <body...>
```

Environment variables:

- `GMAIL_ACCOUNT` optional Himalaya account name
- `GMAIL_FROM` sender address for message template

## LM proxy client (`lmstudio-proxy-client.js`)

```bash
npm start
# or
node lmstudio-proxy-client.js
```

Required environment:

- `CONTROL_WS_URL` control WebSocket URL

Optional environment:

- `CONTROL_TOKEN` shared secret header value
- `LM_BASE_URL` local LM Studio base (default `http://127.0.0.1:1234/v1`)
- `LM_API_KEY` local LM Studio bearer token if required
- `CLIENT_ID` identity override
- `FORWARD_RAW_STREAM=true|false`
- `LOG_LEVEL=debug|info|warn|error`

---

## API and WebSocket endpoints used by this repository

This project primarily **consumes** APIs (it does not expose a local HTTP server itself).

## LM Studio OpenAI-compatible HTTP endpoints

Used by `marks.py` and/or `lmstudio-proxy-client.js`:

- `GET /v1/models`
- `POST /v1/chat/completions`

## Control WebSocket endpoint

Used by `lmstudio-proxy-client.js` and optional control mode in `marks.py`:

- `WS <CONTROL_WS_URL>`

Control message types handled:

- Inbound: `ping`, `pong`, `models`, `chat`, `cancel`
- Outbound: `hello`, `started`, `delta`, `chunk` (optional), `done`, `models`, `cancelled`, `error`, `ping`, `pong`

## Spec-defined HTTP/WS endpoints

`marks.py` loads endpoints from provided JSON specs at runtime. Any path in those specs can become callable tools depending on method/channel definitions.

For external endpoint planning/reference catalog, see `apis.txt`.

---

## Development notes

- Install Node dependency:

```bash
npm install
```

- Start proxy client:

```bash
npm start
```

- Example agent run:

```bash
python3 marks.py "Find parcel by APN and summarize owner" apis.json --llm-base-url http://localhost:1234/v1
```

My current version looks like this, its the stable snapshot:

#!/usr/bin/env node
/**
 * solver.js — LM Studio “tool + solver” agent that can run:
 *   1) one-shot CLI: node solver.js "question" [flags]
 *   2) listen mode (WS control client): node solver.js --listen [flags]
 *
 * IMPORTANT:
 * - This file is written as an ES module. If your Node project is not ESM
 *   (no `"type":"module"` in package.json), rename this file to `solver.mjs`.
 *
 * No environment variables are required. Edit the CONFIG blob below.
 */

import os from "node:os";
import process from "node:process";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

/* =========================
   CONFIG (EDIT THIS BLOB)
   ========================= */
const CONFIG = {
  control: {
    // WS endpoint on your server that sends {type:"chat"} jobs.
    // Example: "wss://record-of-survey-795c317ace89.herokuapp.com/ws/lmproxy"
    wsUrl: "wss://record-of-survey-795c317ace89.herokuapp.com/ws/lmproxy",
    // Optional shared secret (sent as header x-control-token)
    token: ""
  },

  lm: {
    // LM Studio OpenAI-compatible base URL (MUST include /v1)
    baseUrl: "http://127.0.0.1:1234/v1",
    // LM Studio typically doesn’t need a key; leave empty unless you use one
    apiKey: ""
  },

  api: {
    // Your SURVEY-CAD server base URL (https://record-of-survey-...herokuapp.com)
    baseUrl: "https://record-of-survey-795c317ace89.herokuapp.com",
    // Presence WS path on that server (per your browser app)
    crewPresenceWsPath: "/ws/crew-presence",
    // Optional: if your presence WS expects a token, include it here (sent as query param ?token=)
    presenceToken: ""
  },

  defaults: {
    model: "local-model",
    temperature: 0.2,
    maxTokens: 900,
    stream: true,

    // safety gate for HTTP writes (POST/PUT/PATCH/DELETE)
    allowWrite: false,

    // retry behavior when tool calls fail
    toolRepairRounds: 5,

    // solver decomposition depth
    solverMaxSteps: 15,
    solverMaxReplans: 12
  },

  timeouts: {
    httpMs: 20_000,
    presenceWsMs: 6_000
  },

  logLevel: "info" // debug|info|warn|error
};

/* =========================
   API REFERENCE (embedded for the LLM)
   ========================= */
const API_REFERENCE = String.raw`
# SURVEY-CAD API (embedded reference)

Base URL: ${CONFIG.api.baseUrl}

API Endpoint Catalog (LLM-friendly, zero-ambiguity)

Base URL: [http://localhost:3000](http://localhost:3000)
Rule of thumb: If you start with an address, prefer /api/lookup (the address hub), then fan out to parcel/PLSS/subdivision/map. If you start with lat/lon, go straight to the lat/lon endpoints.

HEALTH

* GET /health -> { ok: true }
  Purpose: Liveness probe / “is the server up?” check.
  Use when: boot verification, monitoring, debugging networking/proxy issues.
  Inputs: none
  Output you rely on: ok (boolean)
  Next: if ok=true, call /api/apps or your workflow endpoint.

APPS

* GET /api/apps
  Purpose: Returns the catalog of available browser tools/apps and their entry paths.
  Use when: rendering a launcher UI, confirming what tools are deployed, feature discovery.
  Inputs: none
  Outputs you rely on (typical): app list entries containing a browser path/URL and display metadata.
  Next: open returned app paths in a browser OR choose endpoints below.

GEOSPATIAL (Address ↔ Coordinate ↔ Parcel/PLSS/Subdivision/Map)
Core decision:

* If you have an address: start with GET /api/lookup?address=... (preferred).

* If you only need a coordinate: use GET /api/geocode?address=....

* GET /api/geocode?address=...
  Purpose: Convert an address string into lat/lon only.
  Goal(s): “Turn an address into coordinates.”
  Inputs (required): address (string)
  Outputs you rely on: lat and lon (or location.lat / location.lon)
  Next (common): Use returned lat/lon with /api/parcel, /api/section, /api/aliquots, /api/subdivision, /api/static-map.

* GET /api/lookup?address=...
  Purpose: Address -> “survey context” lookup (preferred address entrypoint).
  Goal(s): “Address -> everything needed to drive downstream survey context.”
  Inputs (required): address (string)
  Outputs you rely on: lat and lon (plus any normalized address/context metadata if present)
  Next (typical fan-out using returned lat/lon):

  * /api/parcel?lon=...&lat=... to get parcel polygon
  * /api/section?lon=...&lat=... to get PLSS section
  * /api/aliquots?lon=...&lat=... to get aliquot polygons
  * /api/subdivision?lon=...&lat=... to get subdivision boundary/name
  * /api/static-map?lon=...&lat=...&address=... to get a quick map snapshot

* GET /api/parcel?lon=...&lat=...&outSR=4326&searchMeters=40
  Purpose: Find the parcel near a coordinate and return parcel geometry/attributes.
  Goal(s): “Get parcel polygon near this coordinate.”
  Inputs (required): lon, lat (numbers)
  Inputs (optional defaults): outSR=4326, searchMeters=40
  Outputs you rely on: parcel geometry (polygon) + parcel identifier/attributes (implementation-specific)
  Next (common): Overlay with /api/subdivision and /api/utilities; produce a map snapshot via /api/static-map.

* GET /api/section?lon=...&lat=...
  Purpose: Return the PLSS section containing the coordinate (Township/Range/Section context).
  Goal(s): “Which PLSS section is this point in?”
  Inputs (required): lon, lat
  Outputs you rely on: township/range/section fields (names implementation-specific)
  Next: /api/aliquots?lon=...&lat=... to get quarter/aliquot polygons.

* GET /api/aliquots?lon=...&lat=...&outSR=4326
  Purpose: Return aliquot polygons/labels for the coordinate’s PLSS context.
  Goal(s): “Get aliquot polygons/labels for PLSS overlays and indexing.”
  Inputs (required): lon, lat
  Inputs (optional default): outSR=4326
  Outputs you rely on: aliquot list with label + geometry (polygons) (field names may vary)
  Next: Render polygons; derive index labels; combine with /api/section.

* GET /api/subdivision?lon=...&lat=...&outSR=4326
  Purpose: Identify subdivision near a coordinate and return subdivision boundary/metadata.
  Goal(s): “Find subdivision boundary/name near coordinate.”
  Inputs (required): lon, lat
  Inputs (optional default): outSR=4326
  Outputs you rely on: subdivision geometry + subdivision name (if available)
  Next: Overlay with parcel + utilities; attach subdivision name to project metadata.

* GET /api/static-map?lon=...&lat=...&address=...
  Purpose: Generate/return a static map representation for a location.
  Goal(s): “Get a quick map snapshot for display/export.”
  Inputs (required): lon, lat
  Inputs (optional): address (string label)
  Outputs you rely on: either an image response (png/jpg) OR a JSON payload containing a URL (implementation-specific)
  Next: Embed in UI; store as a resource in a project bundle.

UTILITIES

* GET /api/utilities?address=...&outSR=2243&sources=power,water
  Purpose: Fetch utility-related records/maps for an address and return geometry in a target spatial reference for export/overlay.
  Goal(s): “Fetch power/water utility records for an address.”
  Inputs (required): address (string)
  Inputs (optional default): outSR=2243
  Inputs (required for coverage): sources (comma-separated list like power,water)
  Outputs you rely on: list of utility records with geometry + attributes (field names vary)
  Next: Export to CSV/points; render overlays; attach to project resources.

PROJECT

* GET /api/project-file/template?projectName=...&client=...&address=...&resources=[...]
  Purpose: Create a starter project-file JSON template from basic metadata and optional resources.
  Goal(s): “Generate a project template / prefill project editor.”
  Inputs (required): projectName, client, address (strings)
  Inputs (optional): resources (JSON array encoded in query string)
  Outputs you rely on: a projectFile template object (field name may vary)
  Next: POST /api/project-file/compile to compile/normalize the project.

* POST /api/project-file/compile (body: {projectFile:{...}} or {project:{...}})
  Purpose: Compile/normalize a project object into canonical project output (often including an archive plan).
  Goal(s): “Finalize project file and generate bundle plan.”
  Inputs (required): JSON body containing either projectFile or project
  Outputs you rely on: compiled project file + (often) archive plan (implementation-specific)
  Next: Save compiled project; execute archive plan actions as needed.

FIELD-TO-FINISH

* GET /api/fld-config?file=config/MLS.fld
  Purpose: Parse an .fld config and return rules usable by LineSmith (code -> linework/symbol behavior).
  Goal(s): “Load field-to-finish rules for drafting/auto-linework.”
  Inputs (required): file (server-readable path string)
  Outputs you rely on: rules, rulesByCode, columns, versionTag (names may vary)
  Next: Apply rules in drafting UI; drive code parsing and symbol mapping.

LOCALSTORAGE SYNC (REST)

* GET /api/localstorage-sync
  Purpose: Fetch authoritative shared snapshot/version/checksum for browser localStorage-backed app state.
  Goal(s): “Bootstrap new client” “Recover from checksum mismatch” “Fallback sync when WS down.”
  Inputs: none
  Outputs you rely on: snapshot, version, checksum
  Next: Connect WS /ws/localstorage-sync for diff-based realtime updates; on mismatch, re-fetch and rebase.

* POST /api/localstorage-sync (body: {version:number, snapshot:object})
  Purpose: Publish a full snapshot (bootstrap / fallback sync write path).
  Goal(s): “Force publish state” “Fallback publish when WS unavailable.”
  Inputs (required): version (number), snapshot (object)
  Outputs you rely on: success indicator + updated checksum/version (implementation-specific)
  Next: Reconnect WS and resume diffs.

ROS/OCR

* POST /extract
  Purpose: Run ROS/plat OCR extraction.
  Goal(s): “Extract text + geometry-like primitives (bearings/distances/symbol crops/etc.).”
  Inputs: implementation-specific (file upload or JSON job spec)
  Outputs you rely on: extracted text/features (implementation-specific)
  Next: Save extracted JSON/SVG outputs; feed results into drafting/linework pipeline.

* GET /api/ros-pdf?url=...
  Purpose: Proxy/fetch remote PDF for processing (avoid browser CORS and enable server-side OCR pipeline).
  Goal(s): “Fetch a PDF by URL so it can be processed.”
  Inputs (required): url (string)
  Outputs you rely on: PDF bytes (or an error)
  Next: Run /extract using the fetched PDF (by bytes or stored reference depending on implementation).

WEBSOCKETS

* WS GET /ws/localstorage-sync (diff sync)
  Purpose: Real-time differential synchronization of localStorage state across tabs/devices.
  Goal(s): “Keep multiple browsers/devices converged on the same app state.”
  Client responsibilities:

  * Wrap localStorage writes into diffs (set/remove/clear)
  * Send diffs with a base checksum
  * Apply server broadcast diffs and verify checksum
  * Recover via GET /api/localstorage-sync when checksum mismatches
    Next: none; this is the live channel.

* WS GET /ws/lineforge?room=... (collab)
  Purpose: Live collaboration for drafting apps (LineSmith/ArrowHead): shared state, optimistic concurrency acks, edit locks, peer updates.
  Goal(s): “Multi-user shared editing for drawings.”
  Inputs (required): room (string)
  Outputs you rely on: state updates + ack/reject + lock messages (exact schema implementation-specific)
  Next: none; this is the live channel.

* WS GET /ws/crew-presence (presence)
  Purpose: Presence-only channel: track online crew members.
  Goal(s): “Who is online?”
  Inputs: none
  Server -> client messages:

  * {type:'crew-presence-welcome', online:[crewMemberId,...]}
  * {type:'crew-presence-update',  online:[crewMemberId,...]}
    Next: map IDs to names if needed (see below).

NOTES FOR “HUMAN READABLE” OUTPUTS

* Presence returns crewMemberId UUIDs only. To display names, map UUID -> crew profile.
  If your wider platform provides a crew directory endpoint (commonly GET /api/crew), use it to build an id->displayName map.
  Do not assume /api/crew exists unless this deployment explicitly includes it.

`;

/* =========================
   Utilities
   ========================= */

function log(level, ...args) {
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  const cur = order[String(CONFIG.logLevel || "info")] ?? 20;
  const lvl = order[level] ?? 20;
  if (lvl < cur) return;
  // eslint-disable-next-line no-console
  console[level](...args);
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

function safeJsonParse(s) {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function normalizePath(p) {
  const s = String(p || "");
  if (!s) return "/";
  return s.startsWith("/") ? s : `/${s}`;
}

function stripTrailingSlashes(s) {
  return String(s || "").replace(/\/+$/, "");
}

function joinUrl(base, path) {
  return stripTrailingSlashes(base) + normalizePath(path);
}

function buildWsUrlFromHttp(httpBaseUrl, wsPath, queryObj = null) {
  const u = new URL(httpBaseUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = normalizePath(wsPath);
  u.search = "";
  if (queryObj && typeof queryObj === "object") {
    for (const [k, v] of Object.entries(queryObj)) {
      if (v === undefined || v === null || v === "") continue;
      u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

function isWriteMethod(m) {
  const method = String(m || "GET").toUpperCase();
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function truncate(obj, maxChars = 9000) {
  const s = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `\n…(truncated ${s.length - maxChars} chars)`;
}

function extractLikelyJson(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  const candidate = s.slice(first, last + 1);
  const parsed = safeJsonParse(candidate);
  if (parsed.ok) return parsed.value;
  return null;
}

/* =========================
   CLI Args (override CONFIG)
   ========================= */

function parseArgs(argv) {
  const out = {
    prompt: null,

    listen: false,

    baseUrl: CONFIG.lm.baseUrl,
    model: CONFIG.defaults.model,
    lmApiKey: CONFIG.lm.apiKey,

    apiBaseUrl: CONFIG.api.baseUrl,
    crewPresenceWsPath: CONFIG.api.crewPresenceWsPath,
    presenceToken: CONFIG.api.presenceToken,

    controlWsUrl: CONFIG.control.wsUrl,
    controlToken: CONFIG.control.token,

    temperature: CONFIG.defaults.temperature,
    maxTokens: CONFIG.defaults.maxTokens,
    stream: CONFIG.defaults.stream,

    allowWrite: CONFIG.defaults.allowWrite,

    toolRepairRounds: CONFIG.defaults.toolRepairRounds,
    httpTimeoutMs: CONFIG.timeouts.httpMs,
    presenceTimeoutMs: CONFIG.timeouts.presenceWsMs,

    solverMaxSteps: CONFIG.defaults.solverMaxSteps,
    solverMaxReplans: CONFIG.defaults.solverMaxReplans
  };

  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }

    const key = a.slice(2);
    const next = argv[i + 1];
    const hasValue = next !== undefined && !String(next).startsWith("--");

    const val = hasValue ? next : null;
    if (hasValue) i++;

    switch (key) {
      case "listen":
        out.listen = true;
        break;

      case "base-url":
        out.baseUrl = String(val || out.baseUrl);
        break;

      case "model":
        out.model = String(val || out.model);
        break;

      case "lm-api-key":
        out.lmApiKey = String(val || out.lmApiKey);
        break;

      case "api-base-url":
        out.apiBaseUrl = String(val || out.apiBaseUrl);
        break;

      case "crew-presence-path":
        out.crewPresenceWsPath = String(val || out.crewPresenceWsPath);
        break;

      case "presence-token":
        out.presenceToken = String(val || out.presenceToken);
        break;

      case "control-ws-url":
        out.controlWsUrl = String(val || out.controlWsUrl);
        break;

      case "control-token":
        out.controlToken = String(val || out.controlToken);
        break;

      case "temperature":
        out.temperature = clamp(Number(val ?? out.temperature), 0, 2);
        break;

      case "max-tokens":
        out.maxTokens = clamp(Number(val ?? out.maxTokens), 64, 8192);
        break;

      case "no-stream":
        out.stream = false;
        break;

      case "allow-write":
        out.allowWrite = true;
        break;

      case "tool-repair-rounds":
        out.toolRepairRounds = clamp(Number(val ?? out.toolRepairRounds), 0, 10);
        break;

      case "http-timeout-ms":
        out.httpTimeoutMs = clamp(Number(val ?? out.httpTimeoutMs), 1000, 120000);
        break;

      case "presence-timeout-ms":
        out.presenceTimeoutMs = clamp(Number(val ?? out.presenceTimeoutMs), 1000, 60000);
        break;

      case "solver-max-steps":
        out.solverMaxSteps = clamp(Number(val ?? out.solverMaxSteps), 1, 20);
        break;

      case "solver-max-replans":
        out.solverMaxReplans = clamp(Number(val ?? out.solverMaxReplans), 0, 10);
        break;

      default:
        // ignore unknown flags
        break;
    }
  }

  if (positional.length) out.prompt = positional.join(" ").trim();
  return out;
}

/* =========================
   LM Studio client (OpenAI-compatible)
   ========================= */

function lmHeaders(apiKey) {
  const h = { "content-type": "application/json" };
  if (apiKey) h["authorization"] = `Bearer ${apiKey}`;
  return h;
}

async function streamSse(resp, onData, signal) {
  const reader = resp.body?.getReader?.();
  if (!reader) throw new Error("No readable stream body (Node/Fetch streaming not available).");

  const decoder = new TextDecoder("utf-8");
  let buf = "";

  while (true) {
    if (signal?.aborted) throw Object.assign(new Error("cancelled"), { name: "AbortError" });

    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let split;
    while ((split = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, split);
      buf = buf.slice(split + 2);

      for (const line of block.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (!payload) continue;
        if (payload === "[DONE]") return;

        const parsed = safeJsonParse(payload);
        if (parsed.ok) onData(parsed.value);
      }
    }
  }
}

async function lmChat({ baseUrl, apiKey, body, onDelta, signal }) {
  const url = `${stripTrailingSlashes(baseUrl)}/chat/completions`;
  const wantsStream = body.stream !== false;

  const resp = await fetch(url, {
    method: "POST",
    headers: lmHeaders(apiKey),
    body: JSON.stringify(body),
    signal
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    const err = new Error(`LM chat failed: ${resp.status} ${resp.statusText} ${t}`.trim());
    err.http_status = resp.status;
    throw err;
  }

  const contentType = resp.headers.get("content-type") || "";

  if (wantsStream && contentType.includes("text/event-stream")) {
    let assembled = "";

    await streamSse(
      resp,
      (chunk) => {
        const deltaText = chunk?.choices?.[0]?.delta?.content;
        if (typeof deltaText === "string" && deltaText.length) {
          assembled += deltaText;
          if (onDelta) onDelta(deltaText);
        }
      },
      signal
    );

    return assembled;
  }

  const data = await resp.json();
  return (
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    ""
  );
}

async function lmListModels({ baseUrl, apiKey }) {
  const url = `${stripTrailingSlashes(baseUrl)}/models`;
  const resp = await fetch(url, { headers: lmHeaders(apiKey) });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`LM /models failed: ${resp.status} ${resp.statusText} ${t}`.trim());
  }
  return await resp.json();
}

/* =========================
   Emitters (CLI + WS)
   ========================= */

function createCliEmitter() {
  return {
    started: (id) => {
      if (id) process.stdout.write(`[started] ${id}\n`);
    },
    delta: (s) => {
      if (!s) return;
      process.stdout.write(String(s));
    },
    done: (id, message) => {
      if (id) process.stdout.write(`\n[done] ${id}\n`);
      process.stdout.write(String(message || "").trimEnd() + "\n");
    },
    error: (id, err) => {
      if (id) process.stdout.write(`\n[error] ${id}\n`);
      process.stdout.write(String(err?.message || err || "error") + "\n");
    }
  };
}

function createWsEmitter(ws, id) {
  const wsSend = (obj) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(obj));
  };

  return {
    started: () => wsSend({ type: "started", id }),
    delta: (s) => {
      if (!s) return;
      wsSend({ type: "delta", id, delta: String(s) });
    },
    done: (message) => wsSend({ type: "done", id, message: String(message || "") }),
    error: (err) =>
      wsSend({
        type: "error",
        id,
        error: { message: String(err?.message || err || "error"), http_status: err?.http_status }
      })
  };
}

/* =========================
   Tool implementations
   ========================= */

async function apiHttp({ apiBaseUrl, httpTimeoutMs, allowWrite }, action) {
  const method = String(action?.method || "GET").toUpperCase();
  const path = normalizePath(action?.path || "/health");

  if (isWriteMethod(method) && !allowWrite) {
    const e = new Error(`Write method ${method} blocked (enable --allow-write).`);
    e.http_status = 403;
    throw e;
  }

  const u = new URL(joinUrl(apiBaseUrl, path));
  const query = action?.query && typeof action.query === "object" ? action.query : null;
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      u.searchParams.set(k, String(v));
    }
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), httpTimeoutMs);

  try {
    const headers = { "content-type": "application/json" };
    const body = action?.body !== undefined ? JSON.stringify(action.body) : undefined;

    const resp = await fetch(u.toString(), { method, headers, body, signal: controller.signal });
    const ct = resp.headers.get("content-type") || "";
    const text = await resp.text().catch(() => "");

    let data = null;
    if (ct.includes("application/json") && text) {
      const parsed = safeJsonParse(text);
      data = parsed.ok ? parsed.value : { _raw: text };
    } else {
      data = text;
    }

    return {
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText,
      url: u.toString(),
      method,
      data
    };
  } finally {
    clearTimeout(t);
  }
}

async function crewPresence({ apiBaseUrl, crewPresenceWsPath, presenceToken, presenceTimeoutMs }, action) {
  const wsUrl = buildWsUrlFromHttp(apiBaseUrl, crewPresenceWsPath, presenceToken ? { token: presenceToken } : null);

  return await new Promise((resolve, reject) => {
    let done = false;
    let timer = null;

    const ws = new WebSocket(wsUrl);

    function finish(ok, payload) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { ws.close(); } catch {}
      ok ? resolve(payload) : reject(payload);
    }

    timer = setTimeout(() => {
      finish(true, { ok: true, online: [], note: "timeout_no_update" });
    }, presenceTimeoutMs);

    ws.on("open", () => {
      // optional identify (your browser sends this)
      const crewMemberId = action?.crewMemberId ?? null;
      ws.send(JSON.stringify({ type: "crew-presence-identify", crewMemberId }));
    });

    ws.on("message", (data) => {
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      const parsed = safeJsonParse(text);
      if (!parsed.ok) return;

      const msg = parsed.value;
      if (msg?.type === "crew-presence-welcome" || msg?.type === "crew-presence-update") {
        const online = Array.isArray(msg.online) ? msg.online : [];
        finish(true, { ok: true, online });
      }
    });

    ws.on("error", (err) => finish(true, { ok: false, online: [], error: err?.message || String(err) }));
    ws.on("close", () => {
      if (!done) finish(true, { ok: true, online: [], note: "closed_no_update" });
    });
  });
}

/* =========================
   LLM-driven router + tool planner
   ========================= */

async function routeDecision({ prompt, args, emit, signal }) {
  // LLM-first router (no “question-specific hacks”)
  const sys = `You are a router for an agent with three modes:
- chat: normal conversational answer, no external calls needed.
- tool: use tools (HTTP/WebSocket) to fetch/act in SURVEY-CAD API.
- solver: for complex multi-step problems needing decomposition, retries, and adaptation.

Return ONLY JSON:
{"route":"chat"|"tool"|"solver","reason":"...","confidence":0..1}

Rules:
- If the user asks about live system state (who is online, add crew member, fetch records), choose tool.
- If the user asks for a complex multi-layer plan / recursive solving, choose solver.
- Otherwise choose chat.`;

  const text = await lmChat({
    baseUrl: args.baseUrl,
    apiKey: args.lmApiKey,
    body: {
      model: args.model,
      temperature: 0.0,
      max_tokens: 220,
      stream: false,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: `User prompt:\n${prompt}` }
      ]
    },
    signal
  });

  const j = extractLikelyJson(text);
  if (j && (j.route === "chat" || j.route === "tool" || j.route === "solver")) return j;

  // minimal fallback if model returns junk
  return { route: "chat", reason: "router_parse_failed", confidence: 0.2 };
}

async function proposeToolActions({ prompt, args, emit, toolResults, signal }) {
  const sys = `You are a tool planner for SURVEY-CAD.

You can emit a JSON plan with actions. Return ONLY JSON:
{
  "actions":[
    {"type":"crew_presence","crewMemberId":null},
    {"type":"api_http","method":"GET","path":"/api/crew","query":{}},
    {"type":"api_http","method":"POST","path":"/api/crew","body":{...}}
  ],
  "note":"short optional"
}

Allowed actions:
- crew_presence: connect to /ws/crew-presence, read online IDs.
- api_http: call documented HTTP endpoints.

Hard requirements:
- Prefer HUMAN-READABLE outputs. If you obtain opaque IDs (UUIDs), plan follow-up API calls to fetch names (e.g., GET /api/crew) and map IDs to names before answering.
- If user asks to create/update data, use POST/PUT only if allowed; otherwise propose a read-only alternative or ask for --allow-write.
- If a previous attempt failed, use the error text to fix the payload and RETRY.

API reference:
${API_REFERENCE}

If the user's task is answerable without tools, return {"actions":[], "note":"no_tools_needed"}.

If tools ARE needed, return 1–4 actions maximum.`;

  const user = toolResults
    ? `User prompt:\n${prompt}\n\nPrevious tool results/errors:\n${truncate(toolResults, 7000)}`
    : `User prompt:\n${prompt}`;

  const text = await lmChat({
    baseUrl: args.baseUrl,
    apiKey: args.lmApiKey,
    body: {
      model: args.model,
      temperature: 0.1,
      max_tokens: 600,
      stream: false,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user }
      ]
    },
    signal
  });

  const j = extractLikelyJson(text);
  if (j && Array.isArray(j.actions)) return j;

  return { actions: [], note: "planner_parse_failed" };
}

function hasFailures(toolResults) {
  return toolResults.some((r) => r && r.ok === false);
}

async function synthesizeAnswer({ prompt, args, toolResults, emit, signal }) {
  const sys = `You are the final answer writer.

Use ONLY the tool results. Do not invent endpoints or data.
Make the answer HUMAN-READABLE; prefer names over IDs.
If IDs appear and no names were fetched, say that and recommend the next tool call (e.g. GET /api/crew) that would resolve them.

Keep it concise.`;

  const text = await lmChat({
    baseUrl: args.baseUrl,
    apiKey: args.lmApiKey,
    body: {
      model: args.model,
      temperature: 0.2,
      max_tokens: args.maxTokens,
      stream: args.stream,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: `Prompt:\n${prompt}\n\nTool results:\n${truncate(toolResults, 9000)}` }
      ]
    },
    onDelta: args.stream ? (d) => emit.delta(d) : null,
    signal
  });

  if (!args.stream) emit.delta(text);
  return text;
}

/* =========================
   Tool route runner (with repair)
   ========================= */

async function runToolRoute({ prompt, args, emit, signal }) {
  const toolResults = [];
  let plan = await proposeToolActions({ prompt, args, emit, toolResults: null, signal });

  for (let round = 0; round <= args.toolRepairRounds; round++) {
    const actions = Array.isArray(plan?.actions) ? plan.actions : [];

    if (!actions.length) {
      // No actions proposed; still produce a response (chat-style) without “giving up”
      emit.delta(`[augment] no_actions -> synthesize\n`);
      const final = await lmChat({
        baseUrl: args.baseUrl,
        apiKey: args.lmApiKey,
        body: {
          model: args.model,
          temperature: 0.2,
          max_tokens: args.maxTokens,
          stream: args.stream,
          messages: [
            {
              role: "system",
              content:
`Answer the user directly if possible.
If the task needs tools but none were used, explain what tool info is missing and what you would call next.`
            },
            { role: "user", content: prompt }
          ]
        },
        onDelta: args.stream ? (d) => emit.delta(d) : null,
        signal
      });

      if (!args.stream) emit.delta(final);
      return final;
    }

    // Execute actions
    toolResults.length = 0;

    for (const a of actions.slice(0, 4)) {
      const type = String(a?.type || "");
      try {
        if (type === "crew_presence") {
          emit.delta(`[ws] crew-presence\n`);
          const res = await crewPresence(
            {
              apiBaseUrl: args.apiBaseUrl,
              crewPresenceWsPath: args.crewPresenceWsPath,
              presenceToken: args.presenceToken,
              presenceTimeoutMs: args.presenceTimeoutMs
            },
            a
          );
          toolResults.push({ type, ok: true, result: res });
          emit.delta(`[ws:ok] online=${Array.isArray(res.online) ? res.online.length : 0}\n`);
        } else if (type === "api_http") {
          const method = String(a?.method || "GET").toUpperCase();
          const path = normalizePath(a?.path || "/health");
          emit.delta(`[http] ${method} ${path}\n`);
          const res = await apiHttp(
            { apiBaseUrl: args.apiBaseUrl, httpTimeoutMs: args.httpTimeoutMs, allowWrite: args.allowWrite },
            a
          );
          toolResults.push({ type, ok: res.ok, result: res });
          if (!res.ok) {
            emit.delta(`[tool:error] HTTP ${res.status} ${res.statusText}: ${truncate(res.data, 1200)}\n`);
          } else {
            emit.delta(`[http:ok]\n`);
          }
        } else {
          toolResults.push({ type, ok: false, error: "unknown_action_type", action: a });
          emit.delta(`[tool:error] unknown action type: ${type}\n`);
        }
      } catch (e) {
        toolResults.push({ type, ok: false, error: e?.message || String(e), action: a, http_status: e?.http_status });
        emit.delta(`[tool:error] ${e?.message || String(e)}\n`);
      }
    }

    emit.delta("\n");

    // If everything ok, synthesize and return
    if (!hasFailures(toolResults)) {
      const final = await synthesizeAnswer({ prompt, args, toolResults, emit, signal });
      if (!args.stream) emit.delta("\n");
      return final;
    }

    // Repair: feed tool results/errors back into planner
    if (round === args.toolRepairRounds) break;

    emit.delta(`[repair] round=${round + 1}/${args.toolRepairRounds}\n`);
    plan = await proposeToolActions({ prompt, args, emit, toolResults, signal });
    emit.delta("\n");
  }

  // Final attempt: synthesize even with failures (don’t give up)
  const final = await synthesizeAnswer({ prompt, args, toolResults, emit, signal });
  if (!args.stream) emit.delta("\n");
  return final;
}

/* =========================
   Solver route runner (decompose + adapt)
   ========================= */

async function makeSolverPlan({ prompt, args, emit, signal }) {
  const sys = `You are a recursive problem solver.

Return ONLY JSON:
{
  "goal":"...",
  "steps":[
    {"id":"S1","kind":"tool"|"chat","title":"...","details":"..."},
    ...
  ]
}

Rules:
- Use 3–${args.solverMaxSteps} steps.
- Use kind="tool" if you need API/WebSocket info or actions.
- Use kind="chat" for reasoning/synthesis without external calls.
- Prefer human-readable outcomes; if IDs appear in tool steps, include a follow-up tool step to resolve names.`;

  const text = await lmChat({
    baseUrl: args.baseUrl,
    apiKey: args.lmApiKey,
    body: {
      model: args.model,
      temperature: 0.1,
      max_tokens: 900,
      stream: false,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: `Prompt:\n${prompt}\n\nAPI reference:\n${API_REFERENCE}` }
      ]
    },
    signal
  });

  const j = extractLikelyJson(text);
  if (j && Array.isArray(j.steps) && j.steps.length) return j;

  return {
    goal: prompt,
    steps: [{ id: "S1", kind: "chat", title: "Answer", details: "Answer directly." }]
  };
}

async function assessGoal({ prompt, args, emit, state, signal }) {
  const sys = `You are a completion checker.

Return ONLY JSON: {"done":true|false,"reason":"..."}

Decide if the user's request is fully satisfied based on the current state.`;
  const text = await lmChat({
    baseUrl: args.baseUrl,
    apiKey: args.lmApiKey,
    body: {
      model: args.model,
      temperature: 0.0,
      max_tokens: 180,
      stream: false,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: `Prompt:\n${prompt}\n\nState:\n${truncate(state, 8000)}` }
      ]
    },
    signal
  });

  const j = extractLikelyJson(text);
  if (j && typeof j.done === "boolean") return j;
  return { done: true, reason: "assess_parse_failed_default_done" };
}

async function runSolverRoute({ prompt, args, emit, signal }) {
  let plan = await makeSolverPlan({ prompt, args, emit, signal });
  let state = {
    goal: plan.goal || prompt,
    steps: [],
    toolRuns: [],
    notes: []
  };

  for (let replan = 0; replan <= args.solverMaxReplans; replan++) {
    emit.delta(`[plan] goal: ${state.goal}\n`);
    emit.delta(`[plan] steps: ${plan.steps.length}\n\n`);

    for (const step of plan.steps.slice(0, args.solverMaxSteps)) {
      emit.delta(`[step] ${step.id || ""} ${step.kind || ""} — ${step.title || ""}\n`);
      if (step.details) emit.delta(`[step] ${step.details}\n\n`);

      if (step.kind === "tool") {
        // Run tool route on the step.details (or whole prompt if missing)
        const stepPrompt = step.details ? `${prompt}\n\n(Working on step: ${step.title})\n${step.details}` : prompt;
        const before = Date.now();
        const answer = await runToolRoute({ prompt: stepPrompt, args, emit, signal });
        const after = Date.now();
        state.toolRuns.push({ step: step.id, ms: after - before, output: answer });
        state.steps.push({ id: step.id, kind: "tool", title: step.title, ok: true });
        emit.delta("\n");
      } else {
        // chat reasoning step
        const sys = `You are solving one step of a multi-step task. Be direct.`;
        const stepText = await lmChat({
          baseUrl: args.baseUrl,
          apiKey: args.lmApiKey,
          body: {
            model: args.model,
            temperature: args.temperature,
            max_tokens: args.maxTokens,
            stream: args.stream,
            messages: [
              { role: "system", content: sys },
              { role: "user", content: `Main prompt:\n${prompt}\n\nStep:\n${step.title}\n${step.details || ""}\n\nCurrent state:\n${truncate(state, 8000)}` }
            ]
          },
          onDelta: args.stream ? (d) => emit.delta(d) : null,
          signal
        });

        if (!args.stream) emit.delta(stepText);
        state.steps.push({ id: step.id, kind: "chat", title: step.title, ok: true, output: stepText });
        emit.delta("\n\n");
      }

      const assess = await assessGoal({ prompt, args, emit, state, signal });
      if (assess.done) {
        emit.delta(`[solver] done: ${assess.reason}\n\n`);
        // Final answer: use the last meaningful output if any; otherwise synthesize from state
        const final = await lmChat({
          baseUrl: args.baseUrl,
          apiKey: args.lmApiKey,
          body: {
            model: args.model,
            temperature: 0.2,
            max_tokens: args.maxTokens,
            stream: args.stream,
            messages: [
              {
                role: "system",
                content:
`Write the final answer for the user using the completed state.
Prefer human-readable results; do not include raw UUIDs unless unavoidable.`
              },
              { role: "user", content: `Prompt:\n${prompt}\n\nState:\n${truncate(state, 9000)}` }
            ]
          },
          onDelta: args.stream ? (d) => emit.delta(d) : null,
          signal
        });

        if (!args.stream) emit.delta(final);
        return final;
      }
    }

    if (replan === args.solverMaxReplans) break;

    // Replan based on accumulated state/errors
    emit.delta(`[replan] ${replan + 1}/${args.solverMaxReplans}\n`);
    plan = await makeSolverPlan({
      prompt: `${prompt}\n\nWe attempted steps and may be incomplete. Replan using this state:\n${truncate(state, 8000)}`,
      args,
      emit,
      signal
    });
    emit.delta("\n");
  }

  // If still not done, produce best-effort final
  const final = await lmChat({
    baseUrl: args.baseUrl,
    apiKey: args.lmApiKey,
    body: {
      model: args.model,
      temperature: 0.2,
      max_tokens: args.maxTokens,
      stream: args.stream,
      messages: [
        {
          role: "system",
          content:
`Provide the best possible answer. If incomplete, say what remains and what next tool call would resolve it.`
        },
        { role: "user", content: `Prompt:\n${prompt}\n\nState:\n${truncate(state, 9000)}` }
      ]
    },
    onDelta: args.stream ? (d) => emit.delta(d) : null
  });

  if (!args.stream) emit.delta(final);
  return final;
}

/* =========================
   Main entry (CLI)
   ========================= */

async function runOneShot({ prompt, args }) {
  const emit = createCliEmitter();
  emit.delta(`[router] deciding…\n`);

  const decision = await routeDecision({ prompt, args, emit });
  emit.delta(`[router] route=${decision.route} reason=${decision.reason || ""}\n\n`);

  if (decision.route === "chat") {
    emit.started("cli");
    const txt = await lmChat({
      baseUrl: args.baseUrl,
      apiKey: args.lmApiKey,
      body: {
        model: args.model,
        temperature: args.temperature,
        max_tokens: args.maxTokens,
        stream: args.stream,
        messages: [{ role: "user", content: prompt }]
      },
      onDelta: args.stream ? (d) => emit.delta(d) : null
    });
    emit.done("cli", txt);
    return;
  }

  if (decision.route === "solver") {
    emit.started("cli");
    const txt = await runSolverRoute({ prompt, args, emit });
    emit.done("cli", txt);
    return;
  }

  // tool
  emit.started("cli");
  const txt = await runToolRoute({ prompt, args, emit });
  emit.done("cli", txt);
}

/* =========================
   Listen mode (WS control client)
   ========================= */

function computeBackoffMs(attempt) {
  const base = Math.min(30_000, 500 * Math.pow(1.6, attempt));
  const jitter = Math.floor(Math.random() * 400);
  return base + jitter;
}

function startControlWsListener(args) {
  const wsUrl = String(args.controlWsUrl || "").trim();
  if (!wsUrl) die("Missing control.wsUrl in CONFIG (or pass --control-ws-url).");

  let ws = null;
  let reconnectAttempt = 0;

  // Track in-flight cancel
  const inflight = new Map(); // id -> AbortController

  const wsSend = (obj) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(obj));
  };

  function connect() {
    reconnectAttempt += 1;
    const backoff = computeBackoffMs(reconnectAttempt - 1);
    log("info", `Connecting to control WS: ${wsUrl} (attempt ${reconnectAttempt}, backoff ${backoff}ms)`);

    ws = new WebSocket(wsUrl, {
      headers: args.controlToken ? { "x-control-token": args.controlToken } : undefined
    });

    ws.on("open", () => {
      reconnectAttempt = 0;
      log("info", "WS connected.");

      wsSend({
        type: "hello",
        client_id: `${os.hostname()}-${randomUUID().slice(0, 8)}`,
        capabilities: {
          models: true,
          chat: true,
          solver: true,
          tool: true,
          cancel: true
        },
        ts: Date.now()
      });

      wsSend({ type: "ping", ts: Date.now() });
    });

    ws.on("message", async (data) => {
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      const parsed = safeJsonParse(text);
      if (!parsed.ok) {
        wsSend({ type: "error", id: null, error: { message: "bad_json" } });
        return;
      }

      const msg = parsed.value;
      const type = String(msg?.type || "");
      const id = String(msg?.id || "");

      if (type === "ping") { wsSend({ type: "pong", ts: Date.now() }); return; }
      if (type === "pong") return;

      if (type === "models") {
        try {
          const data = await lmListModels({ baseUrl: args.baseUrl, apiKey: args.lmApiKey });
          wsSend({ type: "models", id, ok: true, data });
        } catch (e) {
          wsSend({ type: "models", id, ok: false, error: { message: e?.message || String(e) } });
        }
        return;
      }

      if (type === "cancel") {
        const controller = inflight.get(id);
        if (controller) {
          controller.abort();
          inflight.delete(id);
          wsSend({ type: "cancelled", id, ok: true });
        } else {
          wsSend({ type: "cancelled", id, ok: false, error: { message: "not_inflight" } });
        }
        return;
      }

      if (type !== "chat") {
        wsSend({ type: "error", id: id || null, error: { message: `unknown_type:${type}` } });
        return;
      }

      const body = msg?.body;
      const messages = Array.isArray(body?.messages) ? body.messages : null;
      if (!messages || messages.length === 0) {
        wsSend({ type: "error", id, error: { message: "chat missing body.messages[]" } });
        return;
      }

      // Convert messages to a single prompt for routing/solver/tool
      const prompt = messages
        .map((m) => `${String(m?.role || "user").toUpperCase()}: ${String(m?.content || "")}`)
        .join("\n\n")
        .trim();

      const emit = createWsEmitter(ws, id);
      const controller = new AbortController();
      inflight.set(id, controller);

      try {
        emit.delta(`[router] deciding…\n`);
        const decision = await routeDecision({ prompt, args, emit, signal: controller.signal });
        emit.delta(`[router] route=${decision.route} reason=${decision.reason || ""}\n\n`);
        emit.started();

        if (decision.route === "chat") {
          // Normal chat pass-through using the incoming messages
          const txt = await lmChat({
            baseUrl: args.baseUrl,
            apiKey: args.lmApiKey,
            body: {
              model: body?.model || args.model,
              messages,
              temperature: body?.temperature ?? args.temperature,
              max_tokens: body?.max_tokens ?? args.maxTokens,
              stream: true
            },
            onDelta: (d) => emit.delta(d),
            signal: controller.signal
          });
          emit.done(txt);
          return;
        }

        if (decision.route === "solver") {
          const txt = await runSolverRoute({ prompt, args, emit, signal: controller.signal });
          emit.done(txt);
          return;
        }

        const txt = await runToolRoute({ prompt, args, emit, signal: controller.signal });
        emit.done(txt);
      } catch (e) {
        emit.error(e);
      } finally {
        inflight.delete(id);
      }
    });

    ws.on("close", (code, reason) => {
      log("warn", `WS closed code=${code} reason=${reason?.toString?.() || ""}`);
      // cancel inflight
      for (const [, controller] of inflight) controller.abort();
      inflight.clear();
      const wait = computeBackoffMs(reconnectAttempt);
      setTimeout(connect, wait);
    });

    ws.on("error", (err) => {
      log("warn", `WS error: ${err?.message || err}`);
      // close handler will reconnect
    });
  }

  connect();
}

/* =========================
   Entrypoint
   ========================= */

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.listen) {
    startControlWsListener(args);
    return;
  }

  if (!args.prompt) {
    die(
      `Usage:
  node solver.js "question" [--base-url ...] [--model ...] [--api-base-url ...] [--allow-write]
  node solver.js --listen [--control-ws-url ...] [--allow-write]

Edit CONFIG at the top to avoid passing flags.`
    );
  }

  await runOneShot({ prompt: args.prompt, args });
}

main().catch((e) => {
  console.error(e?.stack || e?.message || String(e));
  process.exit(1);
});

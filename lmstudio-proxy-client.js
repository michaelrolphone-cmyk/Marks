// lmstudio-proxy-client.js
// Node 18+ (uses built-in fetch)
//
// This is a WS *client* that connects to your server and proxies requests to
// a local LM Studio OpenAI-compatible API.
//
// Env:
//   CONTROL_WS_URL=wss://your-server.example/ws/lmproxy
//   CONTROL_TOKEN=optionalSharedSecret
//   LM_BASE_URL=http://127.0.0.1:1234/v1    (note the /v1 per LM Studio docs)
//   LM_API_KEY=optional (LM Studio typically doesn't require one)
//   CLIENT_ID=optional (defaults to hostname+random)
//   FORWARD_RAW_STREAM=true|false (default false)
//   LOG_LEVEL=debug|info|warn|error (default info)

import os from "node:os";
import process from "node:process";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const CONTROL_WS_URL = process.env.CONTROL_WS_URL || "";
if (!CONTROL_WS_URL) {
  console.error("Missing CONTROL_WS_URL env var.");
  process.exit(1);
}

const CONTROL_TOKEN = process.env.CONTROL_TOKEN || "";
const LM_BASE_URL = (process.env.LM_BASE_URL || "http://127.0.0.1:1234/v1").replace(/\/+$/, "");
const LM_API_KEY = process.env.LM_API_KEY || "";
const FORWARD_RAW_STREAM = (process.env.FORWARD_RAW_STREAM || "false").toLowerCase() === "true";
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();

const CLIENT_ID =
  process.env.CLIENT_ID ||
  `${os.hostname()}-${randomUUID().slice(0, 8)}`;

function log(level, ...args) {
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  if ((order[level] || 20) < (order[LOG_LEVEL] || 20)) return;
  console[level](...args);
}

function safeJsonParse(s) {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

function lmHeaders() {
  const h = { "content-type": "application/json" };
  if (LM_API_KEY) h["authorization"] = `Bearer ${LM_API_KEY}`;
  return h;
}

// Track in-flight by id so server can cancel
const inflight = new Map(); // id -> AbortController

async function lmListModels() {
  const resp = await fetch(`${LM_BASE_URL}/models`, { headers: lmHeaders() });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`LM /models failed: ${resp.status} ${resp.statusText} ${t}`.trim());
  }
  return await resp.json(); // OpenAI style: { data: [...] }
}

/**
 * Parse SSE "data: ..." blocks, stop on [DONE].
 * For LM Studio streaming, response is text/event-stream (SSE). :contentReference[oaicite:2]{index=2}
 */
async function streamSse(resp, onData) {
  const reader = resp.body?.getReader?.();
  if (!reader) throw new Error("No readable stream body (Node/Fetch streaming not available).");

  const decoder = new TextDecoder("utf-8");
  let buf = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // SSE events separated by blank line
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

async function lmChat({ id, body, onDelta, onChunk }) {
  const controller = new AbortController();
  inflight.set(id, controller);

  try {
    const resp = await fetch(`${LM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: lmHeaders(),
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw Object.assign(new Error(`LM chat failed: ${resp.status} ${resp.statusText} ${t}`.trim()), {
        http_status: resp.status
      });
    }

    const contentType = resp.headers.get("content-type") || "";
    const wantsStream = body.stream !== false;

    if (wantsStream && contentType.includes("text/event-stream")) {
      const chunks = [];
      let assembled = "";

      await streamSse(resp, (chunk) => {
        chunks.push(chunk);
        if (onChunk) onChunk(chunk);

        // OpenAI delta text:
        const deltaText = chunk?.choices?.[0]?.delta?.content;
        if (typeof deltaText === "string" && deltaText.length) {
          assembled += deltaText;
          if (onDelta) onDelta(deltaText);
        }
      });

      // Try to determine final usage / finish_reason from last chunk (if present)
      const last = chunks[chunks.length - 1];
      const finish_reason = last?.choices?.[0]?.finish_reason ?? null;
      const usage = last?.usage ?? null;

      return {
        message: assembled,
        finish_reason,
        usage,
        raw: FORWARD_RAW_STREAM ? { stream_events: chunks } : undefined
      };
    } else {
      const data = await resp.json();
      const text =
        data?.choices?.[0]?.message?.content ??
        data?.choices?.[0]?.text ??
        "";

      return {
        message: text,
        finish_reason: data?.choices?.[0]?.finish_reason ?? null,
        usage: data?.usage ?? null,
        raw: data
      };
    }
  } finally {
    inflight.delete(id);
  }
}

// --- WS client with reconnect/backoff ---

let ws = null;
let reconnectAttempt = 0;
let heartbeatTimer = null;

function wsSend(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    wsSend({ type: "ping", ts: Date.now() });
  }, 25_000);
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function computeBackoffMs(attempt) {
  const base = Math.min(30_000, 500 * Math.pow(1.6, attempt));
  const jitter = Math.floor(Math.random() * 400);
  return base + jitter;
}

async function handleControlMessage(msg) {
  const type = String(msg?.type || "");
  const id = String(msg?.id || "");

  if (type === "pong" || type === "ping") {
    // optional: respond to server pings
    if (type === "ping") wsSend({ type: "pong", ts: Date.now() });
    return;
  }

  if (type === "models") {
    try {
      const data = await lmListModels();
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
      wsSend({ type: "cancelled", id, ok: true });
    } else {
      wsSend({ type: "cancelled", id, ok: false, error: { message: "not_inflight" } });
    }
    return;
  }

  if (type === "chat") {
    // Expected payload from server:
    // {
    //   type:"chat",
    //   id:"req-123",
    //   body:{
    //     model:"model-id",
    //     messages:[{role:"user",content:"..."}],
    //     temperature:0.2,
    //     max_tokens:512,
    //     stream:true
    //   }
    // }
    const body = msg?.body;
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      wsSend({ type: "error", id, error: { message: "chat missing body.messages[]" } });
      return;
    }

    wsSend({ type: "started", id });

    try {
      const result = await lmChat({
        id,
        body,
        onDelta: (delta) => wsSend({ type: "delta", id, delta }),
        onChunk: FORWARD_RAW_STREAM ? (chunk) => wsSend({ type: "chunk", id, chunk }) : null
      });

      wsSend({
        type: "done",
        id,
        message: result.message,
        finish_reason: result.finish_reason,
        usage: result.usage,
        raw: result.raw
      });
    } catch (e) {
      const isAbort = e?.name === "AbortError";
      wsSend({
        type: "error",
        id,
        error: {
          message: isAbort ? "cancelled" : (e?.message || String(e)),
          http_status: e?.http_status
        }
      });
    }
    return;
  }

  wsSend({ type: "error", id: id || null, error: { message: `unknown_type:${type}` } });
}

function connect() {
  reconnectAttempt += 1;
  const backoff = computeBackoffMs(reconnectAttempt - 1);

  log("info", `Connecting to control WS: ${CONTROL_WS_URL} (attempt ${reconnectAttempt}, backoff ${backoff}ms)`);

  ws = new WebSocket(CONTROL_WS_URL, {
    headers: CONTROL_TOKEN ? { "x-control-token": CONTROL_TOKEN } : undefined
  });

  ws.on("open", () => {
    reconnectAttempt = 0;
    log("info", "WS connected.");

    wsSend({
      type: "hello",
      client_id: CLIENT_ID,
      lm_base_url: LM_BASE_URL,
      capabilities: {
        models: true,
        chat: true,
        stream: true,
        cancel: true,
        forward_raw_stream: FORWARD_RAW_STREAM
      },
      ts: Date.now()
    });

    startHeartbeat();
  });

  ws.on("message", async (data) => {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    const parsed = safeJsonParse(text);
    if (!parsed.ok) {
      wsSend({ type: "error", id: null, error: { message: "bad_json" } });
      return;
    }

    try {
      await handleControlMessage(parsed.value);
    } catch (e) {
      wsSend({ type: "error", id: parsed.value?.id ?? null, error: { message: e?.message || String(e) } });
    }
  });

  ws.on("close", (code, reason) => {
    stopHeartbeat();
    log("warn", `WS closed code=${code} reason=${reason?.toString?.() || ""}`);

    // Abort all in-flight on disconnect
    for (const [, controller] of inflight) controller.abort();
    inflight.clear();

    // Reconnect
    const wait = computeBackoffMs(reconnectAttempt);
    setTimeout(connect, wait);
  });

  ws.on("error", (err) => {
    log("warn", `WS error: ${err?.message || err}`);
    // close handler will reconnect
  });
}

connect();


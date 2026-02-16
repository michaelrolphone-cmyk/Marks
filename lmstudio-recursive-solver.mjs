#!/usr/bin/env node
/**
 * lmstudio-recursive-solver.mjs
 *
 * Recursive planner/solver using LM Studio + OPTIONAL SURVEY-CAD API actions.
 *
 * LM Studio:
 *   - OpenAI-compatible server, default: http://localhost:1234/v1
 *
 * SURVEY-CAD API (remote):
 *   - default: https://record-of-survey-795c317ace89.herokuapp.com
 *
 * Capabilities:
 *  1) Ask LLM to decompose problem into tasks
 *  2) Recursively solve tasks; break down tasks when needed
 *  3) Reflect + revise plan when wrong path detected
 *  4) Persist state.json (resume supported)
 *  5) NEW: LLM may request HTTP calls to your API via an `actions` array
 *
 * Usage:
 *   node lmstudio-recursive-solver.mjs "Your problem here"
 *   node lmstudio-recursive-solver.mjs --stdin
 *   node lmstudio-recursive-solver.mjs --resume ./runs/run-.../state.json
 *
 * LM Studio options:
 *   --base-url <url>      (default: http://localhost:1234/v1)
 *   --model <name>        (default: local-model)
 *
 * API options:
 *   --api-base-url <url>  (default: https://record-of-survey-795c317ace89.herokuapp.com)
 *   --allow-write         allow POST/PUT/PATCH/DELETE to allowlisted endpoints
 *   --allow-write-any     allow writes to ANY path (dangerous)
 *   --api-timeout-ms <n>  default 45000
 *
 * Control:
 *   --temperature <num>   (default: 0.2)
 *   --max-depth <n>       (default: 4)
 *   --max-steps <n>       (default: 50)  root loop (task picks)
 *   --max-llm-calls <n>   (default: 200) total LLM calls budget
 *   --max-actions <n>     (default: 40)  total API actions budget
 *   --max-actions-per-turn <n> (default: 4)  actions per solver turn
 *   --max-turns-per-task <n>   (default: 6)  solver inner loop
 *
 * Output:
 *   --out <dir>           (default: ./runs/run-YYYY-MM-DD_HHMMSS)
 *   --state <file>        (default: <out>/state.json)
 *
 * Helpers:
 *   --list-models         list LM Studio models
 *   --stdin               read problem from stdin
 *   --no-revise           disable plan revision
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";

const DEFAULTS = {
  baseUrl: "http://localhost:1234/v1",
  model: "local-model",
  temperature: 0.2,

  // Recursive controls
  maxDepth: 4,
  maxSteps: 50,

  // Budgeting
  maxLlmCalls: 200,
  maxActions: 40,
  maxActionsPerTurn: 4,
  maxTurnsPerTask: 6,

  allowRevise: true,

  // SURVEY-CAD API
  apiBaseUrl: "https://record-of-survey-795c317ace89.herokuapp.com",
  apiTimeoutMs: 45000,
  allowWrite: false,
  allowWriteAny: false,
};

// Allowlisted write endpoints (only used when --allow-write is set)
const WRITE_ALLOWLIST = new Set([
  "/api/localstorage-sync",
  "/api/project-file/compile",
  "/extract",
]);

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function uid(prefix = "T") {
  return `${prefix}${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { args._.push(a); continue; }
    const key = a.slice(2);
    const hasValue = (i + 1 < argv.length) && !argv[i + 1].startsWith("--");
    if (key === "stdin" || key === "list-models" || key === "no-revise" || key === "allow-write" || key === "allow-write-any") {
      args[key] = true;
    } else if (hasValue) {
      args[key] = argv[++i];
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function readStdinAll() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => data += c);
    process.stdin.on("end", () => resolve(data));
  });
}

function logInfo(msg) { console.log(`\x1b[36m[i]\x1b[0m ${msg}`); }
function logOk(msg) { console.log(`\x1b[32m[✓]\x1b[0m ${msg}`); }
function logWarn(msg) { console.log(`\x1b[33m[!]\x1b[0m ${msg}`); }
function logErr(msg) { console.error(`\x1b[31m[x]\x1b[0m ${msg}`); }

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function truncateForModel(x, limit = 9000) {
  const s = typeof x === "string" ? x : JSON.stringify(x, null, 2);
  if (s.length <= limit) return s;
  return s.slice(0, limit) + `\n…(truncated ${s.length - limit} chars)…`;
}

function tryExtractJson(text) {
  const s = String(text ?? "");
  const firstObj = s.indexOf("{");
  const firstArr = s.indexOf("[");
  let start = -1;
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);

  if (start === -1) throw new Error("No JSON start found in model output.");

  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    } else {
      if (ch === '"') { inStr = true; continue; }
      if (ch === open) depth++;
      if (ch === close) depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        return JSON.parse(candidate);
      }
    }
  }
  throw new Error("JSON appears truncated or unbalanced.");
}

async function httpFetch(url, method, body, { timeoutMs = 120000, headers = {}, expect = "json" } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });

    const contentType = res.headers.get("content-type") || "";
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${errText.slice(0, 1200)}`);
    }

    if (expect === "bytes") {
      const ab = await res.arrayBuffer();
      return { ok: true, contentType, data: Buffer.from(ab) };
    }
    if (expect === "text") {
      const txt = await res.text();
      return { ok: true, contentType, data: txt };
    }

    // default json (but tolerate non-json if server returns bytes)
    const txt = await res.text();
    try {
      return { ok: true, contentType, data: JSON.parse(txt) };
    } catch {
      return { ok: true, contentType, data: txt };
    }
  } finally {
    clearTimeout(t);
  }
}

async function chatCompletion({ baseUrl, model, temperature, messages }, state, { retries = 3 } = {}) {
  if (state.exec.llmCalls >= state.config.maxLlmCalls) {
    throw new Error(`LLM call budget exceeded (max-llm-calls=${state.config.maxLlmCalls}).`);
  }
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const payload = { model, temperature, messages };
      const out = await httpFetch(url, "POST", payload, { timeoutMs: 180000, expect: "json" });
      const raw = out.data;
      const choice = raw?.choices?.[0];
      const content = choice?.message?.content ?? "";
      state.exec.llmCalls++;
      return { raw, content };
    } catch (e) {
      lastErr = e;
      const backoff = 400 * Math.pow(2, attempt) + Math.random() * 150;
      await sleep(backoff);
    }
  }
  throw lastErr;
}

// -----------------------------
// SURVEY-CAD API action execution
// -----------------------------
function normalizePath(p) {
  if (!p) return "/";
  const s = String(p).trim();
  if (!s.startsWith("/")) return "/" + s;
  return s;
}
function isWriteMethod(m) {
  const mm = String(m || "GET").toUpperCase();
  return mm !== "GET" && mm !== "HEAD";
}

async function runApiAction(state, action) {
  if (state.exec.actionsTaken >= state.config.maxActions) {
    throw new Error(`API action budget exceeded (max-actions=${state.config.maxActions}).`);
  }

  const method = String(action.method || "GET").toUpperCase();
  const p = normalizePath(action.path || action.endpoint || "/health");
  const query = (action.query && typeof action.query === "object") ? action.query : {};
  const body = (action.body && typeof action.body === "object") ? action.body : null;

  if (isWriteMethod(method)) {
    if (!state.config.allowWrite && !state.config.allowWriteAny) {
      throw new Error(`Write method ${method} blocked. Run with --allow-write (allowlist) or --allow-write-any (dangerous).`);
    }
    if (!state.config.allowWriteAny && !WRITE_ALLOWLIST.has(p)) {
      throw new Error(`Write to ${p} blocked by allowlist. Use --allow-write-any to override.`);
    }
  }

  // Build URL
  const base = state.config.apiBaseUrl.replace(/\/$/, "");
  const url = new URL(base + p);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, String(v));
  }

  // Decide expected response type
  // - bytes for pdf/images
  // - json by default
  const expect = String(action.expect || "").toLowerCase() || (
    p.includes("ros-pdf") || p.includes("static-map") ? "bytes" : "json"
  );

  const timeoutMs = action.timeoutMs != null ? Number(action.timeoutMs) : state.config.apiTimeoutMs;

  const headers = (action.headers && typeof action.headers === "object") ? action.headers : {};

  const startedAt = new Date().toISOString();
  const resp = await httpFetch(url.toString(), method, body, { timeoutMs, headers, expect });

  state.exec.actionsTaken++;

  // Save artifacts
  const apiDir = path.join(state.outDir, "api");
  ensureDirSync(apiDir);

  const safeNameBase = String(action.saveAs || action.name || `${method}_${p.replace(/[\/\?\&\=]+/g, "_")}`)
    .slice(0, 120)
    .replace(/[^a-zA-Z0-9_\-.]/g, "_");

  let savedFile = null;
  let summary;

  if (expect === "bytes") {
    const ext = resp.contentType.includes("pdf") ? ".pdf"
      : (resp.contentType.includes("png") ? ".png"
      : (resp.contentType.includes("jpeg") || resp.contentType.includes("jpg") ? ".jpg" : ".bin"));
    savedFile = path.join(apiDir, `${safeNameBase}${ext}`);
    await fsp.writeFile(savedFile, resp.data);
    summary = { savedFile, contentType: resp.contentType, bytes: resp.data.length };
  } else {
    savedFile = path.join(apiDir, `${safeNameBase}.json`);
    const jsonOut = {
      url: url.toString(),
      method,
      path: p,
      query,
      requestBody: body,
      contentType: resp.contentType,
      response: resp.data
    };
    await fsp.writeFile(savedFile, JSON.stringify(jsonOut, null, 2), "utf8");
    summary = { savedFile, contentType: resp.contentType, responsePreview: truncateForModel(resp.data, 2500) };
  }

  const finishedAt = new Date().toISOString();
  return {
    ok: true,
    startedAt,
    finishedAt,
    request: { method, url: url.toString(), path: p, query, body },
    response: {
      contentType: resp.contentType,
      expect,
      data: (expect === "bytes") ? { savedFile, bytes: resp.data.length } : resp.data
    },
    artifact: summary
  };
}

// -----------------------------
// Prompts
// -----------------------------
function apiQuickRef(apiBaseUrl) {
  // Keep this compact but sufficient for the model to choose endpoints.
  return `
SURVEY-CAD API QUICK REF (base: ${apiBaseUrl})

Health / apps:
- GET /health -> {ok:true}
- GET /api/apps -> {apps:[{id,title,path}]}

Survey/Geo:
- GET /api/geocode?address=...
- GET /api/lookup?address=...
- GET /api/parcel?lon=...&lat=...&outSR=4326&searchMeters=40
- GET /api/section?lon=...&lat=...
- GET /api/aliquots?lon=...&lat=...&outSR=4326
- GET /api/subdivision?lon=...&lat=...&outSR=4326
- GET /api/static-map?lon=...&lat=...&address=...  (may return image bytes)

Utilities:
- GET /api/utilities?address=...&outSR=2243&sources=power,water

Project file:
- GET /api/project-file/template?projectName=...&client=...&address=...&resources=<json-encoded-array>
- POST /api/project-file/compile  body: {"projectFile":{...}} OR {"project":{...}}

FLD:
- GET /api/fld-config?file=config/MLS.fld

LocalStorage Sync:
- GET /api/localstorage-sync
- POST /api/localstorage-sync body: {"version":<ms>,"snapshot":{...}}

ROS/OCR:
- POST /extract (schema depends on server)
- GET /api/ros-pdf?url=https://...  (returns PDF bytes)
`.trim();
}

function planPrompt(problem, maxTasks = 8, apiBaseUrl) {
  return [
    {
      role: "system",
      content:
`You are a rigorous problem decomposition engine.
Return ONLY valid JSON. No markdown, no commentary.
Your job: turn the user's problem into an actionable task list with clear success criteria.

You MAY incorporate real-world verification steps by calling the SURVEY-CAD API via the runner later. Keep plan tasks concrete.

${apiQuickRef(apiBaseUrl)}

JSON schema:
{
  "goal": "string",
  "assumptions": ["string", ...],
  "constraints": ["string", ...],
  "tasks": [
    {
      "title": "string",
      "description": "string",
      "success_criteria": ["string", ...],
      "can_decompose": true|false,
      "priority": 1..5
    }
  ],
  "stop_condition": "string"
}

Rules:
- tasks length <= ${maxTasks}
- Tasks ordered by dependency (earlier enables later).
- Prefer concrete outputs (draft, algorithm, checklist, proof sketch, code, test plan).`
    },
    { role: "user", content: `Problem:\n${problem}` }
  ];
}

function solveTaskPrompt({ problem, plan, task, contextSummary, depth, apiBaseUrl, allowWrite, toolResultsSummary }) {
  const planBrief = {
    goal: plan.goal,
    constraints: plan.constraints?.slice?.(0, 8) ?? [],
    stop_condition: plan.stop_condition
  };

  return [
    {
      role: "system",
      content:
`You are an expert solver inside a recursive planner/executor.

CRITICAL: Return ONLY valid JSON. No markdown. No extra keys beyond schema.

You have access to SURVEY-CAD API via the runner if you need real data.
To request an API call, include an "actions" array with items shaped like:

{
  "type": "api_http",
  "method": "GET" | "POST",
  "path": "/api/lookup",
  "query": { "address": "..." },
  "body": { ... },              // only for POST
  "expect": "json" | "text" | "bytes",
  "saveAs": "optional_filename_base"
}

Runner policy:
- GET is allowed by default.
- Writes require allowWrite=true. Current allowWrite=${allowWrite}.
- Even if allowWrite=true, writes are allowlisted unless allowWriteAny was enabled.

${apiQuickRef(apiBaseUrl)}

JSON schema:
{
  "status": "done" | "needs_breakdown" | "blocked" | "revise_plan",
  "result": "string",
  "confidence": 0.0-1.0,
  "notes": ["string", ...],
  "blockers": ["string", ...],
  "sub_tasks": [
    { "title":"string","description":"string","success_criteria":["string",...],"can_decompose":true|false,"priority":1..5 }
  ],
  "plan_feedback": {
    "is_plan_working": true|false,
    "suggested_changes": ["string", ...]
  },
  "actions": [
    { "type":"api_http","method":"GET","path":"/health","query":{} }
  ]
}

Rules:
- If task is too large/ambiguous, use status="needs_breakdown" and propose sub_tasks.
- If you discover the plan path is wrong, use status="revise_plan".
- If you need API data, request 1-4 actions max, then wait for results.
- Depth=${depth}. Keep breakdown limited.`
    },
    {
      role: "user",
      content:
`Overall problem:
${problem}

Current plan summary:
${JSON.stringify(planBrief, null, 2)}

Task to solve (depth ${depth}):
${JSON.stringify({
  title: task.title,
  description: task.description,
  success_criteria: task.success_criteria,
}, null, 2)}

Context so far (completed work summary):
${contextSummary || "(none)"}

Recent tool/API results (summary):
${toolResultsSummary || "(none)"}`
    }
  ];
}

function reflectPrompt({ problem, plan, progressSnapshot }) {
  return [
    {
      role: "system",
      content:
`You are a reflection engine for an iterative problem solver.
Return ONLY JSON, no markdown.

Schema:
{
  "progress_summary": "string",
  "risks": ["string", ...],
  "next_focus": "string",
  "plan_health": "green" | "yellow" | "red"
}`
    },
    {
      role: "user",
      content:
`Problem:
${problem}

Plan:
${JSON.stringify({ goal: plan.goal, stop_condition: plan.stop_condition }, null, 2)}

Progress snapshot:
${JSON.stringify(progressSnapshot, null, 2)}`
    }
  ];
}

function revisePlanPrompt({ problem, currentPlan, completedSummaries, issues, apiBaseUrl }) {
  return [
    {
      role: "system",
      content:
`You are a replanner. Return ONLY valid JSON.

${apiQuickRef(apiBaseUrl)}

Schema:
{
  "goal": "string",
  "assumptions": ["string", ...],
  "constraints": ["string", ...],
  "tasks": [
    { "title":"string","description":"string","success_criteria":["string",...],"can_decompose":true|false,"priority":1..5 }
  ],
  "stop_condition": "string",
  "rationale": "string"
}

Rules:
- Keep tasks <= 10.
- Preserve what is already completed by not re-adding identical tasks.
- Adjust ordering and scope to fix the failure mode.`
    },
    {
      role: "user",
      content:
`Problem:
${problem}

Current plan:
${JSON.stringify(currentPlan, null, 2)}

Completed work summaries:
${completedSummaries}

Issues / failure mode:
${issues}`
    }
  ];
}

// -----------------------------
// State model
// -----------------------------
function newState({ problem, config, outDir, stateFile }) {
  return {
    version: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    problem,
    config,
    outDir,
    stateFile,
    plan: null,
    tasks: {},         // id -> task node
    rootTaskIds: [],
    exec: {
      stepsTaken: 0,
      lastTaskId: null,
      reflection: null,
      llmCalls: 0,
      actionsTaken: 0,
    },
    history: [],       // events
    final: null,
  };
}

function taskNodeFromModelTask(modelTask, { parentId = null, depth = 0 }) {
  return {
    id: uid("T"),
    parentId,
    depth,
    title: String(modelTask.title || "Untitled task").slice(0, 180),
    description: String(modelTask.description || ""),
    success_criteria: Array.isArray(modelTask.success_criteria) ? modelTask.success_criteria.map(String) : [],
    can_decompose: !!modelTask.can_decompose,
    priority: clamp(Number(modelTask.priority ?? 3), 1, 5),
    status: "pending",         // pending|expanded|done|blocked
    attempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    children: [],
    outputs: [],               // {ts, kind, content, meta}
    blockers: [],
    toolResults: [],           // per-task tool/API results
  };
}

function summarizeCompleted(state, maxChars = 4000) {
  const done = Object.values(state.tasks).filter(t => t.status === "done");
  done.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  let txt = "";
  for (const t of done) {
    const last = t.outputs?.slice?.(-1)?.[0];
    const snippet = (last?.content || "").slice(0, 900);
    txt += `\n- ${t.title}\n  ${snippet}\n`;
    if (txt.length > maxChars) break;
  }
  return txt.trim() || "(none)";
}

function summarizeRecentToolResults(task, maxChars = 3500) {
  const rows = (task.toolResults || []).slice(-6);
  let s = "";
  for (const r of rows) {
    s += `\n- ${r.request?.method} ${r.request?.path}  (${r.response?.contentType || "?"})`;
    if (r.artifact?.savedFile) s += `\n  saved: ${r.artifact.savedFile}`;
    if (r.response?.expect !== "bytes") {
      s += `\n  response: ${truncateForModel(r.response?.data, 900)}`;
    } else {
      s += `\n  response: <bytes saved>`;
    }
    s += "\n";
    if (s.length > maxChars) break;
  }
  return s.trim() || "(none)";
}

function pickNextTaskId(state) {
  const byDepth = Object.values(state.tasks)
    .filter(t => t.status === "pending")
    .sort((a, b) => a.depth - b.depth || a.priority - b.priority || a.createdAt.localeCompare(b.createdAt));
  return byDepth.length ? byDepth[0].id : null;
}

async function saveState(state) {
  state.updatedAt = new Date().toISOString();
  await fsp.writeFile(state.stateFile, JSON.stringify(state, null, 2), "utf8");
}

async function writeArtifact(state, name, content) {
  const file = path.join(state.outDir, name);
  await fsp.writeFile(file, content, "utf8");
  return file;
}

// -----------------------------
// Main flow
// -----------------------------
async function listModels(baseUrl) {
  const url = `${baseUrl.replace(/\/$/, "")}/models`;
  const out = await httpFetch(url, "GET", null, { timeoutMs: 30000, expect: "json" });
  const data = out?.data?.data ?? out?.data ?? [];
  for (const m of data) console.log(m?.id ?? JSON.stringify(m));
}

async function generatePlan(state) {
  logInfo("Generating initial plan (task list)...");
  const messages = planPrompt(state.problem, 8, state.config.apiBaseUrl);
  const { content } = await chatCompletion({
    baseUrl: state.config.baseUrl,
    model: state.config.model,
    temperature: state.config.temperature,
    messages
  }, state);

  const plan = tryExtractJson(content);
  if (!plan || !Array.isArray(plan.tasks)) throw new Error("Plan JSON missing 'tasks' array.");

  state.plan = {
    goal: String(plan.goal || "Solve the problem"),
    assumptions: Array.isArray(plan.assumptions) ? plan.assumptions.map(String) : [],
    constraints: Array.isArray(plan.constraints) ? plan.constraints.map(String) : [],
    stop_condition: String(plan.stop_condition || "All tasks completed with success criteria met."),
  };

  state.rootTaskIds = [];
  for (const mt of plan.tasks.slice(0, 10)) {
    const node = taskNodeFromModelTask(mt, { parentId: null, depth: 0 });
    state.tasks[node.id] = node;
    state.rootTaskIds.push(node.id);
  }

  state.history.push({ ts: new Date().toISOString(), type: "plan_generated", plan: state.plan, roots: state.rootTaskIds });
  await saveState(state);

  logOk(`Plan created with ${state.rootTaskIds.length} root tasks.`);
}

async function maybeRevisePlan(state, issues) {
  if (!state.config.allowRevise) return false;

  logWarn("Revising plan (LLM says the current path is wrong)...");
  const completedSummaries = summarizeCompleted(state, 6000);

  const messages = revisePlanPrompt({
    problem: state.problem,
    currentPlan: state.plan,
    completedSummaries,
    issues,
    apiBaseUrl: state.config.apiBaseUrl
  });

  const { content } = await chatCompletion({
    baseUrl: state.config.baseUrl,
    model: state.config.model,
    temperature: Math.max(0.1, state.config.temperature),
    messages
  }, state);

  const newPlan = tryExtractJson(content);
  if (!newPlan || !Array.isArray(newPlan.tasks)) {
    logWarn("Plan revision returned invalid JSON; continuing with current plan.");
    return false;
  }

  const existingTitles = new Set(Object.values(state.tasks).map(t => t.title.trim().toLowerCase()));
  const added = [];

  for (const mt of newPlan.tasks.slice(0, 10)) {
    const title = String(mt.title || "").trim().toLowerCase();
    if (!title || existingTitles.has(title)) continue;
    const node = taskNodeFromModelTask(mt, { parentId: null, depth: 0 });
    state.tasks[node.id] = node;
    state.rootTaskIds.push(node.id);
    added.push(node.id);
    existingTitles.add(title);
  }

  state.plan.goal = String(newPlan.goal || state.plan.goal);
  state.plan.assumptions = Array.isArray(newPlan.assumptions) ? newPlan.assumptions.map(String) : state.plan.assumptions;
  state.plan.constraints = Array.isArray(newPlan.constraints) ? newPlan.constraints.map(String) : state.plan.constraints;
  state.plan.stop_condition = String(newPlan.stop_condition || state.plan.stop_condition);

  state.history.push({
    ts: new Date().toISOString(),
    type: "plan_revised",
    rationale: String(newPlan.rationale || ""),
    addedRootTaskIds: added
  });
  await saveState(state);

  logOk(`Plan revised. Added ${added.length} new root task(s).`);
  return true;
}

async function reflect(state) {
  const progressSnapshot = {
    stepsTaken: state.exec.stepsTaken,
    llmCalls: state.exec.llmCalls,
    actionsTaken: state.exec.actionsTaken,
    counts: {
      pending: Object.values(state.tasks).filter(t => t.status === "pending").length,
      expanded: Object.values(state.tasks).filter(t => t.status === "expanded").length,
      done: Object.values(state.tasks).filter(t => t.status === "done").length,
      blocked: Object.values(state.tasks).filter(t => t.status === "blocked").length,
    },
    lastTask: state.exec.lastTaskId ? {
      id: state.exec.lastTaskId,
      title: state.tasks[state.exec.lastTaskId]?.title,
      status: state.tasks[state.exec.lastTaskId]?.status,
    } : null
  };

  const { content } = await chatCompletion({
    baseUrl: state.config.baseUrl,
    model: state.config.model,
    temperature: 0.2,
    messages: reflectPrompt({ problem: state.problem, plan: state.plan, progressSnapshot })
  }, state);

  try {
    const refl = tryExtractJson(content);
    state.exec.reflection = refl;
    state.history.push({ ts: new Date().toISOString(), type: "reflection", ...refl });
    await saveState(state);
    logInfo(`Reflection: ${refl.plan_health?.toUpperCase?.() || "?"} — ${refl.next_focus || ""}`);
  } catch {
    // optional
  }
}

function validateActionsShape(actions) {
  if (!Array.isArray(actions)) return [];
  const out = [];
  for (const a of actions) {
    if (!a || typeof a !== "object") continue;
    if (String(a.type || "api_http") !== "api_http") continue;
    if (!a.path && !a.endpoint) continue;
    out.push(a);
  }
  return out;
}

async function solveOneTask(state, taskId) {
  const task = state.tasks[taskId];
  if (!task) throw new Error(`Unknown taskId: ${taskId}`);

  task.attempts++;
  task.updatedAt = new Date().toISOString();
  state.exec.lastTaskId = taskId;

  logInfo(`Solving (depth ${task.depth}) — ${task.title}`);

  // Inner loop: allow solver -> actions -> solver -> ...
  let lastIssues = null;

  for (let turn = 0; turn < state.config.maxTurnsPerTask; turn++) {
    const contextSummary = summarizeCompleted(state, 5000);
    const toolResultsSummary = summarizeRecentToolResults(task, 3200);

    const messages = solveTaskPrompt({
      problem: state.problem,
      plan: state.plan,
      task,
      contextSummary,
      depth: task.depth,
      apiBaseUrl: state.config.apiBaseUrl,
      allowWrite: state.config.allowWrite || state.config.allowWriteAny,
      toolResultsSummary
    });

    const { content } = await chatCompletion({
      baseUrl: state.config.baseUrl,
      model: state.config.model,
      temperature: state.config.temperature,
      messages
    }, state);

    let out;
    try {
      out = tryExtractJson(content);
    } catch (e) {
      task.status = "blocked";
      task.blockers = [`Model output was not valid JSON: ${e.message}`];
      task.outputs.push({ ts: new Date().toISOString(), kind: "raw_model_output", content: String(content).slice(0, 8000) });
      state.history.push({ ts: new Date().toISOString(), type: "task_blocked", taskId, reason: "invalid_json" });
      await saveState(state);
      return;
    }

    const status = out.status;
    const result = String(out.result || "");
    const confidence = Number(out.confidence ?? 0);
    const notes = Array.isArray(out.notes) ? out.notes.map(String) : [];
    const blockers = Array.isArray(out.blockers) ? out.blockers.map(String) : [];
    const subTasks = Array.isArray(out.sub_tasks) ? out.sub_tasks : [];
    const planFeedback = out.plan_feedback || {};
    const actions = validateActionsShape(out.actions);

    if (result) {
      task.outputs.push({
        ts: new Date().toISOString(),
        kind: "result",
        content: result,
        meta: { confidence, notes, turn }
      });
    }

    // If model requested actions, run them (bounded), then continue to next turn
    if (actions.length) {
      const toRun = actions.slice(0, state.config.maxActionsPerTurn);
      logInfo(`Running ${toRun.length} API action(s)...`);

      for (const action of toRun) {
        try {
          const apiResult = await runApiAction(state, action);
          task.toolResults.push(apiResult);
          task.outputs.push({
            ts: new Date().toISOString(),
            kind: "api_action",
            content: truncateForModel(apiResult, 6000),
            meta: { action }
          });
          state.history.push({ ts: new Date().toISOString(), type: "api_action", taskId, action: apiResult.request, artifact: apiResult.artifact });
          await saveState(state);
          logOk(`API OK: ${apiResult.request.method} ${apiResult.request.path}`);
        } catch (e) {
          const msg = String(e?.message || e);
          task.toolResults.push({
            ok: false,
            error: msg,
            request: action
          });
          task.outputs.push({
            ts: new Date().toISOString(),
            kind: "api_action_error",
            content: msg,
            meta: { action }
          });
          state.history.push({ ts: new Date().toISOString(), type: "api_action_error", taskId, error: msg, action });
          await saveState(state);
          logWarn(`API ERROR: ${msg}`);
        }
      }

      // Continue solver with new toolResults in context
      continue;
    }

    // No actions requested: finalize this turn based on status
    if (status === "done") {
      task.status = "done";
      task.updatedAt = new Date().toISOString();
      state.history.push({ ts: new Date().toISOString(), type: "task_done", taskId, confidence });
      await saveState(state);
      logOk(`Done: ${task.title} (conf ${confidence.toFixed(2)})`);
      return;
    }

    if (status === "needs_breakdown") {
      if (task.depth >= state.config.maxDepth) {
        task.status = "blocked";
        task.blockers = ["Max depth reached; cannot further decompose. Treating as blocked."];
        state.history.push({ ts: new Date().toISOString(), type: "task_blocked", taskId, reason: "max_depth" });
        await saveState(state);
        logWarn(`Blocked (max depth): ${task.title}`);
        return;
      }

      const children = [];
      for (const st of subTasks.slice(0, 8)) {
        const child = taskNodeFromModelTask(st, { parentId: task.id, depth: task.depth + 1 });
        state.tasks[child.id] = child;
        children.push(child.id);
        task.children.push(child.id);
      }

      task.status = "expanded";
      task.updatedAt = new Date().toISOString();
      state.history.push({ ts: new Date().toISOString(), type: "task_expanded", taskId, children });
      await saveState(state);

      logInfo(`Expanded into ${children.length} subtask(s).`);
      return;
    }

    if (status === "blocked") {
      task.status = "blocked";
      task.blockers = blockers.length ? blockers : ["Blocked with unspecified reasons."];
      task.updatedAt = new Date().toISOString();
      state.history.push({ ts: new Date().toISOString(), type: "task_blocked", taskId, blockers: task.blockers });
      await saveState(state);
      logWarn(`Blocked: ${task.title}`);
      if (task.blockers.length) logWarn(`  blockers: ${task.blockers.join(" | ")}`);
      return;
    }

    if (status === "revise_plan") {
      const issues = [
        ...(Array.isArray(planFeedback?.suggested_changes) ? planFeedback.suggested_changes.map(String) : []),
        ...(notes || [])
      ].join("\n") || "LLM requested plan revision.";
      lastIssues = issues;

      task.status = "done";
      task.updatedAt = new Date().toISOString();
      state.history.push({ ts: new Date().toISOString(), type: "task_done_with_revision_request", taskId, issues });
      await saveState(state);

      await maybeRevisePlan(state, issues);
      return;
    }

    // Unknown status: treat as blocked
    task.status = "blocked";
    task.blockers = [`Unknown status: ${String(status)}`];
    state.history.push({ ts: new Date().toISOString(), type: "task_blocked", taskId, reason: "unknown_status" });
    await saveState(state);
    return;
  }

  // If we exit inner loop, we ran out of turns—mark blocked with diagnostic
  task.status = "blocked";
  task.blockers = [`Max turns per task reached (${state.config.maxTurnsPerTask}). Last issues: ${lastIssues || "n/a"}`];
  task.updatedAt = new Date().toISOString();
  state.history.push({ ts: new Date().toISOString(), type: "task_blocked", taskId, reason: "max_turns" });
  await saveState(state);
  logWarn(`Blocked (max turns): ${task.title}`);
}

async function synthesizeFinal(state) {
  logInfo("Synthesizing final answer...");
  const completed = Object.values(state.tasks).filter(t => t.status === "done");
  completed.sort((a, b) => a.depth - b.depth || a.createdAt.localeCompare(b.createdAt));

  const payload = completed.map(t => {
    const last = t.outputs?.slice?.(-1)?.[0];
    return {
      title: t.title,
      depth: t.depth,
      result: (last?.content || "").slice(0, 5000),
      success_criteria: t.success_criteria
    };
  });

  const messages = [
    {
      role: "system",
      content:
`You are a synthesis engine.
Return ONLY JSON.

Schema:
{
  "final_answer": "string",
  "key_artifacts": ["string", ...],
  "open_questions": ["string", ...],
  "next_steps": ["string", ...]
}

Rules:
- Use the completed task results as evidence.
- If anything is uncertain, say so plainly.`
    },
    {
      role: "user",
      content:
`Problem:
${state.problem}

Plan goal:
${state.plan?.goal || ""}

Completed task results:
${JSON.stringify(payload, null, 2)}`
    }
  ];

  const { content } = await chatCompletion({
    baseUrl: state.config.baseUrl,
    model: state.config.model,
    temperature: Math.max(0.1, state.config.temperature),
    messages
  }, state);

  const out = tryExtractJson(content);
  const md =
`# Final Answer

${out.final_answer || ""}

## Key Artifacts
${(out.key_artifacts || []).map(x => `- ${x}`).join("\n")}

## Open Questions
${(out.open_questions || []).map(x => `- ${x}`).join("\n")}

## Next Steps
${(out.next_steps || []).map(x => `- ${x}`).join("\n")}
`;

  const finalMd = await writeArtifact(state, "final.md", md);
  const finalJson = await writeArtifact(state, "final.json", JSON.stringify(out, null, 2));

  state.final = { ts: new Date().toISOString(), ...out, files: { finalMd, finalJson } };
  state.history.push({ ts: new Date().toISOString(), type: "final_synthesized", files: state.final.files });
  await saveState(state);

  logOk(`Wrote ${finalMd}`);
  console.log("\n" + md);
}

// -----------------------------
// Entry
// -----------------------------
async function main() {
  const args = parseArgs(process.argv);

  const config = {
    // LM Studio
    baseUrl: String(args["base-url"] || DEFAULTS.baseUrl),
    model: String(args.model || DEFAULTS.model),
    temperature: args.temperature != null ? Number(args.temperature) : DEFAULTS.temperature,

    // recursion
    maxDepth: args["max-depth"] != null ? Number(args["max-depth"]) : DEFAULTS.maxDepth,
    maxSteps: args["max-steps"] != null ? Number(args["max-steps"]) : DEFAULTS.maxSteps,

    // budgets
    maxLlmCalls: args["max-llm-calls"] != null ? Number(args["max-llm-calls"]) : DEFAULTS.maxLlmCalls,
    maxActions: args["max-actions"] != null ? Number(args["max-actions"]) : DEFAULTS.maxActions,
    maxActionsPerTurn: args["max-actions-per-turn"] != null ? Number(args["max-actions-per-turn"]) : DEFAULTS.maxActionsPerTurn,
    maxTurnsPerTask: args["max-turns-per-task"] != null ? Number(args["max-turns-per-task"]) : DEFAULTS.maxTurnsPerTask,

    allowRevise: !args["no-revise"] && DEFAULTS.allowRevise,

    // SURVEY-CAD API
    apiBaseUrl: String(args["api-base-url"] || DEFAULTS.apiBaseUrl),
    apiTimeoutMs: args["api-timeout-ms"] != null ? Number(args["api-timeout-ms"]) : DEFAULTS.apiTimeoutMs,
    allowWrite: !!args["allow-write"],
    allowWriteAny: !!args["allow-write-any"],
  };

  if (args["list-models"]) {
    await listModels(config.baseUrl);
    return;
  }

  let state;
  if (args.resume) {
    const p = path.resolve(String(args.resume));
    logInfo(`Resuming from ${p}`);
    const txt = await fsp.readFile(p, "utf8");
    state = JSON.parse(txt);
    state.config = { ...state.config, ...config };
    // ensure new exec fields exist
    state.exec = state.exec || {};
    state.exec.llmCalls = Number(state.exec.llmCalls || 0);
    state.exec.actionsTaken = Number(state.exec.actionsTaken || 0);
    await saveState(state);
  } else {
    let problem = "";
    if (args.stdin) {
      problem = (await readStdinAll()).trim();
    } else if (args._.length) {
      problem = args._.join(" ").trim();
    } else {
      logErr('No problem provided. Use: node lmstudio-recursive-solver.mjs "..." or --stdin');
      process.exitCode = 2;
      return;
    }
    if (!problem) {
      logErr("Problem is empty.");
      process.exitCode = 2;
      return;
    }

    const outDir = path.resolve(String(args.out || path.join(process.cwd(), "runs", `run-${nowStamp()}`)));
    ensureDirSync(outDir);
    const stateFile = path.resolve(String(args.state || path.join(outDir, "state.json")));

    state = newState({ problem, config, outDir, stateFile });
    await saveState(state);
  }

  logInfo(`LM Studio base URL: ${state.config.baseUrl}`);
  logInfo(`Model: ${state.config.model}`);
  logInfo(`Out dir: ${state.outDir}`);
  logInfo(`State file: ${state.stateFile}`);
  logInfo(`SURVEY-CAD API base: ${state.config.apiBaseUrl}`);
  logInfo(`API writes: ${state.config.allowWriteAny ? "ENABLED (ANY)" : (state.config.allowWrite ? "ENABLED (ALLOWLIST)" : "disabled")}`);

  // Optional quick health check (GET only; safe)
  try {
    const health = await runApiAction(state, { type: "api_http", method: "GET", path: "/health", expect: "json", saveAs: "health" });
    state.history.push({ ts: new Date().toISOString(), type: "api_health_check", artifact: health.artifact });
    await saveState(state);
    logOk("API health check OK.");
  } catch (e) {
    logWarn(`API health check failed (continuing): ${String(e?.message || e)}`);
  }

  if (!state.plan) {
    await generatePlan(state);
  } else {
    logOk("Plan already exists (from state).");
  }

  // Execution loop
  while (state.exec.stepsTaken < state.config.maxSteps) {
    const nextId = pickNextTaskId(state);
    if (!nextId) break;

    state.exec.stepsTaken++;
    await saveState(state);

    await solveOneTask(state, nextId);

    if (state.exec.stepsTaken % 3 === 0) {
      await reflect(state);
    }
  }

  const pending = Object.values(state.tasks).filter(t => t.status === "pending").length;
  const blocked = Object.values(state.tasks).filter(t => t.status === "blocked").length;

  if (pending > 0) logWarn(`Stopped with ${pending} pending task(s). (step budget reached or no runnable tasks)`);
  if (blocked > 0) logWarn(`There are ${blocked} blocked task(s). Check state.json for blockers.`);

  await synthesizeFinal(state);
}

main().catch((e) => {
  logErr(e?.stack || e?.message || String(e));
  process.exitCode = 1;
});

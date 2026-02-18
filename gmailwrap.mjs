#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

function runRaw(cmd, args, input) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", d => (out += d));
    p.stderr.on("data", d => (err += d));
    p.on("close", code => resolve({ code: code ?? 0, stdout: out, stderr: err }));
    if (input != null) p.stdin.end(input);
    else p.stdin.end();
  });
}

function tryParseJson(s) {
  try { return JSON.parse((s ?? "").trim()); } catch { return null; }
}

const account = (process.env.GMAIL_ACCOUNT || "").trim(); // optional
const from = (process.env.GMAIL_FROM || "you@gmail.com").trim(); // should match your Gmail identity

async function runHimalaya(args, input) {
  // Prefer global --account <name> if present, but fallback if unsupported.
  if (account) {
    const r1 = await runRaw("himalaya", ["--account", account, ...args], input);
    const e = (r1.stderr || "").toLowerCase();
    if (r1.code !== 0 && (e.includes("unexpected argument '--account'") || e.includes("found argument '--account'") || e.includes("unknown argument '--account'"))) {
      return await runRaw("himalaya", args, input);
    }
    return r1;
  }
  return await runRaw("himalaya", args, input);
}

function isFatalSendError(stderrText) {
  const s = (stderrText || "").toLowerCase();
  return (
    s.includes("authenticationfailed") ||
    s.includes("invalid credentials") ||
    s.includes("cannot authenticate") ||
    s.includes("cannot build imap client") ||
    s.includes("connection refused") ||
    s.includes("getaddrinfo") ||
    s.includes("timed out") ||
    s.includes("no such file") ||
    s.includes("not found") ||
    s.includes("permission denied")
  );
}

async function listFolder(folder, page, pageSize) {
  const r = await runHimalaya(
    ["envelope", "list", "--folder", folder, "--page", String(page), "--page-size", String(pageSize), "--output", "json"],
    null
  );
  if (r.code !== 0) {
    return { ok: false, folder, error: (r.stderr || r.stdout || `exit ${r.code}`).trim(), code: r.code, stderr: r.stderr, stdout: r.stdout };
  }
  const parsed = tryParseJson(r.stdout);
  if (!parsed) {
    return { ok: false, folder, error: "Could not parse JSON from himalaya envelope list.", code: r.code, stderr: r.stderr, stdout: r.stdout };
  }
  return { ok: true, folder, page, pageSize, envelopes: parsed, warning: (r.stderr || "").trim() || null };
}

async function readMessage(id) {
  const r = await runHimalaya(["message", "read", String(id)], null);
  if (r.code !== 0) {
    return { ok: false, id, error: (r.stderr || r.stdout || `exit ${r.code}`).trim(), code: r.code, stderr: r.stderr, stdout: r.stdout };
  }
  return { ok: true, id: Number(id), text: r.stdout, warning: (r.stderr || "").trim() || null };
}

async function verifySentByRequestId(requestId) {
  // Folder names vary; try common ones.
  const candidates = [
    "Sent",
    "Sent Mail",
    "[Gmail]/Sent Mail",
    "[Google Mail]/Sent Mail",
  ];

  for (const folder of candidates) {
    const listed = await listFolder(folder, 1, 15);
    if (!listed.ok) continue;

    const envs = Array.isArray(listed.envelopes) ? listed.envelopes : [];
    for (const env of envs.slice(0, 10)) {
      const mid = env?.id ?? env?.messageId ?? env?.uid ?? env?.seq ?? null;
      if (mid == null) continue;

      const read = await readMessage(mid);
      if (!read.ok) continue;

      const blob = (read.text || "");
      if (blob.includes(requestId)) {
        return { verified: true, folder, id: Number(mid) };
      }
    }
  }

  return { verified: false, folder: null, id: null };
}

const [op, ...rest] = process.argv.slice(2);

(async () => {
  try {
    if (op === "list") {
      const folder = rest[0] || "INBOX";
      const page = Number(rest[1] || "1");
      const pageSize = Number(rest[2] || "20");
      const res = await listFolder(folder, page, pageSize);
      console.log(JSON.stringify(res));
      process.exit(res.ok ? 0 : 1);
      return;
    }

    if (op === "read") {
      const id = rest[0];
      if (!id) throw new Error("missing id");
      const res = await readMessage(id);
      console.log(JSON.stringify(res));
      process.exit(res.ok ? 0 : 1);
      return;
    }

    if (op === "send") {
      const to = rest[0];
      const subject = rest[1] || "";
      const body = rest.slice(2).join(" ") || "";
      if (!to) throw new Error("missing to");

      const requestId = `marks-${randomUUID()}`;

      const template =
`From: ${from}
To: ${to}
Subject: ${subject}
X-Marks-Request-Id: ${requestId}

${body}

--
marks-request-id: ${requestId}
`;

      const r = await runHimalaya(["template", "send"], template);

      // If it's clearly fatal, fail hard.
      if (r.code !== 0 && isFatalSendError(r.stderr)) {
        const out = {
          ok: false,
          error: (r.stderr || r.stdout || `exit ${r.code}`).trim(),
          code: r.code,
          stderr: (r.stderr || "").trim() || null,
          stdout: (r.stdout || "").trim() || null,
          requestId,
        };
        console.log(JSON.stringify(out));
        process.exit(1);
        return;
      }

      // Otherwise: treat as success to prevent duplicate sends, and try to verify.
      const verify = await verifySentByRequestId(requestId);

      const out = {
        ok: true,
        to,
        subject,
        requestId,
        verified: verify.verified,
        verifiedFolder: verify.folder,
        verifiedId: verify.id,
        sendExitCode: r.code,
        sendWarning: (r.stderr || "").trim() || null,
      };

      console.log(JSON.stringify(out));
      process.exit(0);
      return;
    }

    // usage
    console.log(JSON.stringify({
      ok: false,
      error: "usage: gmailwrap.mjs list [folder] [page] [pageSize] | read <id> | send <to> <subject> <body...>"
    }));
    process.exit(2);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e?.message || e) }));
    process.exit(1);
  }
})();


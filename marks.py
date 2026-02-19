#!/usr/bin/env python3
"""
Marks — OpenAPI HTTP + WebSocket + Local CLI tools (Gmailwrap) agent CLI (LM Studio) using OpenAI-compatible tool calling.

Key behaviors:
- HTTP tools accept BOTH:
    - {"json_body": {...}}   (preferred)
    - flat args {...}        (fallback => treated as JSON body for POST/PUT/PATCH/DELETE)
- RESOLVE (read-only) → EXECUTE (write) → VERIFY (read back) workflow

Additions in this version:
- Local Gmailwrap tools:
    - gmail_list(folder="INBOX", page=1, pageSize=10)
    - gmail_read(id)
    - gmail_send(to, subject, body)
- Action gate:
    Blocks ANY modifying/deleting/emailing actions unless `--gate ALLOW` is passed.
    This includes:
      - HTTP POST/PUT/PATCH/DELETE
      - ws_send
      - gmail_send
"""

import argparse
import json
import os
import queue
import re
import socket
import sys
import threading
import time
import uuid
import subprocess
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlencode, urljoin, urlparse, urlunparse, parse_qsl

import requests
import websocket  # websocket-client


# ---------------------------
# logging / sanitization
# ---------------------------

def ts() -> str:
    return datetime.now().strftime("%H:%M:%S")


def log(kind: str, msg: str, enabled: bool = True) -> None:
    if enabled:
        print(f"[{ts()}] [{kind}] {msg}")


def eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


_TOKEN_NOISE_RE = re.compile(r"<\|[^|]+\|>")


def clean_model_text(s: str) -> str:
    if not s:
        return s
    s = _TOKEN_NOISE_RE.sub("", s)
    s = re.sub(r"</?commentary[^>]*>", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\s+\n", "\n", s)
    return s.strip()


# ---------------------------
# OpenAI-compatible client (LM Studio)
# ---------------------------

class OpenAICompat:
    """
    Works against /v1/chat/completions.

    Sends BOTH:
      - tools/tool_choice  (new)
      - functions/function_call (legacy)
    and parses BOTH:
      - tool_calls
      - function_call
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        timeout_s: int = 180,
        retries: int = 1,
        retry_backoff_s: float = 0.8,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.timeout_s = timeout_s
        self.retries = retries
        self.retry_backoff_s = retry_backoff_s

    def _headers(self) -> Dict[str, str]:
        return {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
        }

    def list_models(self) -> List[str]:
        url = f"{self.base_url}/models"
        r = requests.get(url, headers=self._headers(), timeout=15)
        r.raise_for_status()
        j = r.json()
        data = j.get("data") or []
        ids = []
        for it in data:
            mid = it.get("id")
            if mid:
                ids.append(mid)
        return ids

    def choose_model(self, requested: str) -> str:
        ids = self.list_models()
        if not ids:
            return requested
        if requested in ids:
            return requested

        preferred = None
        for cand in ("openai/gpt-oss-20b", "gpt-oss-20b", "zai-org_glm-4.7-flash"):
            for mid in ids:
                if mid == cand or mid.endswith("/" + cand) or cand in mid:
                    preferred = mid
                    break
            if preferred:
                break

        chosen = preferred or ids[0]
        log("init", f"Requested model '{requested}' not found. Using '{chosen}'.", True)
        return chosen

    def chat_completions(
        self,
        messages: List[Dict[str, Any]],
        tools: Optional[List[Dict[str, Any]]] = None,
        functions: Optional[List[Dict[str, Any]]] = None,
        temperature: float = 0.0,
        max_tokens: int = 900,
        stream: bool = False,
    ) -> Dict[str, Any]:
        url = f"{self.base_url}/chat/completions"

        payload: Dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": stream,
        }

        if tools is not None:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        if functions is not None:
            payload["functions"] = functions
            payload["function_call"] = "auto"

        attempt = 0
        while attempt <= self.retries:
            attempt += 1
            try:
                if not stream:
                    r = requests.post(url, headers=self._headers(), json=payload, timeout=self.timeout_s)
                    r.raise_for_status()
                    return r.json()

                r = requests.post(url, headers=self._headers(), json=payload, timeout=self.timeout_s, stream=True)
                r.raise_for_status()

                assembled_content = ""
                tool_by_index: Dict[int, Dict[str, Any]] = {}
                legacy_fn_name: Optional[str] = None
                legacy_fn_args = ""

                for raw_line in r.iter_lines(decode_unicode=True):
                    if not raw_line:
                        continue
                    line = raw_line.strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[len("data:"):].strip()
                    if data == "[DONE]":
                        break

                    try:
                        chunk = json.loads(data)
                    except Exception:
                        continue

                    delta = chunk.get("choices", [{}])[0].get("delta", {}) or {}

                    if "content" in delta and delta["content"]:
                        assembled_content += delta["content"]
                        print(delta["content"], end="", flush=True)

                    if "tool_calls" in delta and isinstance(delta["tool_calls"], list):
                        for tc in delta["tool_calls"]:
                            idx = tc.get("index")
                            if idx is None:
                                continue
                            cur = tool_by_index.get(idx)
                            if not cur:
                                cur = {"id": tc.get("id"), "type": tc.get("type", "function"),
                                       "function": {"name": None, "arguments": ""}}
                                tool_by_index[idx] = cur
                            fn = tc.get("function") or {}
                            if fn.get("name"):
                                cur["function"]["name"] = fn["name"]
                            if "arguments" in fn and fn["arguments"]:
                                cur["function"]["arguments"] += fn["arguments"]

                    if "function_call" in delta and isinstance(delta["function_call"], dict):
                        fc = delta["function_call"]
                        if fc.get("name"):
                            legacy_fn_name = fc["name"]
                        if "arguments" in fc and fc["arguments"]:
                            legacy_fn_args += fc["arguments"]

                tool_calls: List[Dict[str, Any]] = []
                for idx in sorted(tool_by_index.keys()):
                    tool_calls.append(tool_by_index[idx])

                msg_obj: Dict[str, Any] = {
                    "role": "assistant",
                    "content": assembled_content if assembled_content else None,
                }
                if tool_calls:
                    msg_obj["tool_calls"] = tool_calls
                elif legacy_fn_name:
                    msg_obj["function_call"] = {"name": legacy_fn_name, "arguments": legacy_fn_args}

                return {"choices": [{"message": msg_obj}]}

            except Exception as e:
                s = str(e).lower()
                transient = ("timed out" in s) or ("connection" in s) or ("reset" in s) or ("temporarily" in s)
                if attempt <= self.retries and transient:
                    backoff = self.retry_backoff_s * (2 ** (attempt - 1))
                    log("llm", f"LLM error: {e}. Retrying after {backoff:.2f}s", True)
                    time.sleep(backoff)
                    continue
                raise


# ---------------------------
# tool framework
# ---------------------------

@dataclass
class ToolDef:
    name: str
    description: str
    parameters: Dict[str, Any]
    fn: Any  # callable(args)->Any (jsonable)


def _sanitize_prefix(name: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "_", name).strip("_").lower()
    return s or "spec"


def _sanitize_path(path: str) -> str:
    s = path.strip("/")
    s = s.replace("{", "").replace("}", "")
    s = re.sub(r"[^a-zA-Z0-9]+", "_", s).strip("_")
    return s or "root"


HTTP_METHODS = ("get", "post", "put", "patch", "delete")


def _resolve_server_url(server_obj: Dict[str, Any]) -> str:
    url = server_obj.get("url", "")
    vars_ = server_obj.get("variables") or {}
    for k, v in vars_.items():
        default = (v or {}).get("default", "")
        url = url.replace("{%s}" % k, str(default))
    return url


def _detect_spec_kind(spec: Dict[str, Any]) -> Tuple[bool, bool]:
    servers = spec.get("servers") or []
    http = False
    ws = False
    for s in servers:
        u = _resolve_server_url(s)
        if u.startswith("http://") or u.startswith("https://"):
            http = True
        if u.startswith("ws://") or u.startswith("wss://"):
            ws = True
    if not servers and spec.get("paths"):
        http = True
    return http, ws


# ---------------------------
# HTTP tools
# ---------------------------

def _http_call(
    base_url: str,
    method: str,
    path: str,
    path_params: Dict[str, Any],
    query_params: Dict[str, Any],
    headers: Dict[str, str],
    json_body: Any,
    timeout_s: int,
) -> Dict[str, Any]:
    filled = path
    for k, v in (path_params or {}).items():
        filled = filled.replace("{" + k + "}", str(v))

    bu = base_url if base_url.endswith("/") else base_url + "/"
    full = urljoin(bu, filled.lstrip("/"))

    if query_params:
        parsed = urlparse(full)
        existing = dict(parse_qsl(parsed.query, keep_blank_values=True))
        merged = {**existing, **{k: v for k, v in query_params.items() if v is not None}}
        new_q = urlencode(merged, doseq=True)
        full = urlunparse(parsed._replace(query=new_q))

    try:
        resp = requests.request(
            method=method.upper(),
            url=full,
            headers=headers or {},
            json=json_body,
            timeout=max(1, int(timeout_s)),
        )
        out: Dict[str, Any] = {
            "ok": 200 <= resp.status_code < 300,
            "status": resp.status_code,
            "method": method.upper(),
            "url": full,
        }
        try:
            out["json"] = resp.json()
        except Exception:
            out["text"] = (resp.text or "")[:20000]
        return out
    except Exception as e:
        return {"ok": False, "status": None, "method": method.upper(), "url": full, "error": str(e)}


_HTTP_META_KEYS = {"path_params", "query_params", "headers", "json_body", "timeout_s", "body", "params", "query", "path"}

def normalize_http_tool_args(method: str, args: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, str], Any, int]:
    """
    Returns: (path_params, query_params, headers, json_body, timeout_s)

    Accepts both:
      - structured args with json_body
      - flat args (fallback)
    """
    args = args or {}

    hp = args.get("path_params") or args.get("path") or {}
    qp = args.get("query_params") or args.get("query") or args.get("params") or {}
    hd = args.get("headers") or {}
    to = int(args.get("timeout_s", 30))

    jb = args.get("json_body", None)
    if jb is None and "body" in args:
        jb = args.get("body")

    # Flat-args fallback:
    extra = {k: v for k, v in args.items() if k not in _HTTP_META_KEYS}

    m = (method or "").lower()
    if jb is None and m in ("post", "put", "patch", "delete") and extra:
        jb = extra

    # For GET, if model sends flat args, treat as query params
    if m == "get" and extra and not qp:
        qp = extra

    if not isinstance(hp, dict):
        hp = {}
    if not isinstance(qp, dict):
        qp = {}
    if not isinstance(hd, dict):
        hd = {}
    return hp, qp, {str(k): str(v) for k, v in hd.items()}, jb, to


def build_http_tools(prefix: str, spec: Dict[str, Any], base_url: str, default_headers: Dict[str, str]) -> List[ToolDef]:
    tools: List[ToolDef] = []
    paths = spec.get("paths") or {}
    for path, item in paths.items():
        if not isinstance(item, dict):
            continue
        for m in HTTP_METHODS:
            op = item.get(m)
            if not isinstance(op, dict):
                continue

            summary = (op.get("summary") or "").strip()
            operation_id = (op.get("operationId") or "").strip()
            name_tail = _sanitize_prefix(operation_id) if operation_id else _sanitize_path(path)

            canonical = f"{prefix}__{m.upper()}__{name_tail}"
            alias = f"{prefix}_{m}_{name_tail}"

            # allow additionalProperties=True so models can send flat bodies without schema fights
            parameters = {
                "type": "object",
                "properties": {
                    "path_params": {"type": "object", "additionalProperties": True, "default": {}},
                    "query_params": {"type": "object", "additionalProperties": True, "default": {}},
                    "headers": {"type": "object", "additionalProperties": True, "default": {}},
                    "json_body": {"description": "JSON request body.", "default": None},
                    "timeout_s": {"type": "integer", "default": 30},
                    "body": {"description": "(alias) JSON request body", "default": None},
                    "query": {"description": "(alias) query params", "type": "object", "additionalProperties": True, "default": {}},
                    "path": {"description": "(alias) path params", "type": "object", "additionalProperties": True, "default": {}},
                },
                "required": [],
                "additionalProperties": True,
            }

            desc = summary or f"{m.upper()} {path}"

            def make_fn(_method=m, _path=path):
                def fn(args: Dict[str, Any]) -> Dict[str, Any]:
                    hp, qp, hd, jb, to = normalize_http_tool_args(_method, args or {})
                    merged_headers = {**default_headers, **hd}
                    return _http_call(base_url, _method, _path, hp, qp, merged_headers, jb, to)
                return fn

            fn = make_fn()
            tools.append(ToolDef(name=canonical, description=desc, parameters=parameters, fn=fn))
            if alias != canonical:
                tools.append(ToolDef(name=alias, description=f"(alias) {desc}", parameters=parameters, fn=fn))
    return tools


# ---------------------------
# WebSocket manager + tools
# ---------------------------

class WSConnection:
    def __init__(self, conn_id: str, url: str, headers: Dict[str, str]):
        self.conn_id = conn_id
        self.url = url
        self.headers = headers
        self._q: "queue.Queue[str]" = queue.Queue()
        self._wsapp: Optional[websocket.WebSocketApp] = None
        self._thread: Optional[threading.Thread] = None

    def connect(self) -> None:
        header_list = [f"{k}: {v}" for k, v in (self.headers or {}).items()]

        def on_message(_wsapp, message):
            self._q.put(message)

        def on_error(_wsapp, err):
            self._q.put(json.dumps({"type": "ws-error", "error": str(err)}, ensure_ascii=False))

        def on_close(_wsapp, status_code, msg):
            self._q.put(json.dumps({"type": "ws-closed", "status": status_code, "message": msg}, ensure_ascii=False))

        self._wsapp = websocket.WebSocketApp(
            self.url,
            header=header_list,
            on_message=on_message,
            on_error=on_error,
            on_close=on_close,
        )

        def run():
            self._wsapp.run_forever(ping_interval=None)

        self._thread = threading.Thread(target=run, daemon=True)
        self._thread.start()

    def send_json(self, obj: Any) -> None:
        if not self._wsapp:
            raise RuntimeError("WebSocket not connected")
        self._wsapp.send(json.dumps(obj, ensure_ascii=False))

    def recv(self, timeout_s: float = 2.0, max_messages: int = 50) -> List[str]:
        msgs: List[str] = []
        deadline = time.time() + max(0.01, float(timeout_s))
        while len(msgs) < max_messages and time.time() < deadline:
            try:
                remaining = max(0.01, deadline - time.time())
                msgs.append(self._q.get(timeout=remaining))
            except queue.Empty:
                break
        return msgs

    def close(self) -> None:
        if self._wsapp:
            try:
                self._wsapp.close()
            except Exception:
                pass


class WSManager:
    def __init__(self):
        self._conns: Dict[str, WSConnection] = {}

    def connect(self, url: str, headers: Dict[str, str]) -> str:
        conn_id = str(uuid.uuid4())
        c = WSConnection(conn_id, url, headers)
        self._conns[conn_id] = c
        c.connect()
        return conn_id

    def send(self, conn_id: str, message_json: Any) -> None:
        c = self._conns.get(conn_id)
        if not c:
            raise KeyError(f"Unknown connection id: {conn_id}")
        c.send_json(message_json)

    def recv(self, conn_id: str, timeout_s: float, max_messages: int) -> List[str]:
        c = self._conns.get(conn_id)
        if not c:
            raise KeyError(f"Unknown connection id: {conn_id}")
        return c.recv(timeout_s=timeout_s, max_messages=max_messages)

    def close(self, conn_id: str) -> None:
        c = self._conns.pop(conn_id, None)
        if c:
            c.close()

    def list(self) -> List[Dict[str, Any]]:
        return [{"id": cid, "url": c.url} for cid, c in self._conns.items()]


def _ws_url_join(base: str, path: str) -> str:
    base = base.rstrip("/")
    if not path.startswith("/"):
        path = "/" + path
    return base + path


def build_ws_connect_tools(
    prefix: str,
    spec: Dict[str, Any],
    ws_base_url: str,
    ws_manager: WSManager,
    default_headers: Dict[str, str],
) -> List[ToolDef]:
    tools: List[ToolDef] = []
    paths = spec.get("paths") or {}
    for path, item in paths.items():
        if not isinstance(item, dict):
            continue
        get_op = item.get("get")
        if not isinstance(get_op, dict):
            continue
        xws = get_op.get("x-websocket")
        if not isinstance(xws, dict):
            continue

        summary = (get_op.get("summary") or "").strip()
        desc = summary or f"Connect WebSocket {path}"

        tool_tail = _sanitize_path(path)
        canonical = f"{prefix}__WS_CONNECT__{tool_tail}"
        alias = f"{prefix}_ws_connect_{tool_tail}"

        parameters = {
            "type": "object",
            "properties": {
                "query_params": {"type": "object", "additionalProperties": True, "default": {}},
                "headers": {"type": "object", "additionalProperties": True, "default": {}},
            },
            "additionalProperties": True,
        }

        def make_fn(_path=path):
            def fn(args: Dict[str, Any]) -> Dict[str, Any]:
                args = args or {}
                qp = args.get("query_params") or {}
                hd = args.get("headers") or {}

                full = _ws_url_join(ws_base_url, _path)
                if qp:
                    parsed = urlparse(full)
                    existing = dict(parse_qsl(parsed.query, keep_blank_values=True))
                    merged = {**existing, **{k: v for k, v in qp.items() if v is not None}}
                    q = urlencode(merged, doseq=True)
                    full = urlunparse(parsed._replace(query=q))

                merged_headers = {**default_headers, **{str(k): str(v) for k, v in hd.items()}}
                conn_id = ws_manager.connect(full, merged_headers)
                return {"ok": True, "connection_id": conn_id, "url": full}
            return fn

        fn = make_fn()
        tools.append(ToolDef(name=canonical, description=desc, parameters=parameters, fn=fn))
        if alias != canonical:
            tools.append(ToolDef(name=alias, description=f"(alias) {desc}", parameters=parameters, fn=fn))
    return tools


def build_generic_ws_tools(ws_manager: WSManager) -> List[ToolDef]:
    def ws_connections(_args: Dict[str, Any]) -> Dict[str, Any]:
        return {"ok": True, "connections": ws_manager.list()}

    def ws_send(args: Dict[str, Any]) -> Dict[str, Any]:
        cid = (args or {}).get("connection_id")
        msg = (args or {}).get("message")
        if not cid:
            return {"ok": False, "error": "connection_id required"}
        try:
            ws_manager.send(cid, msg)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def ws_recv(args: Dict[str, Any]) -> Dict[str, Any]:
        cid = (args or {}).get("connection_id")
        if not cid:
            return {"ok": False, "error": "connection_id required"}
        to = float((args or {}).get("timeout_s", 2.0))
        mm = int((args or {}).get("max_messages", 50))
        try:
            msgs = ws_manager.recv(cid, timeout_s=to, max_messages=mm)
            parsed_msgs = []
            for m in msgs:
                try:
                    parsed_msgs.append(json.loads(m))
                except Exception:
                    parsed_msgs.append(m)
            return {"ok": True, "messages": parsed_msgs}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def ws_close(args: Dict[str, Any]) -> Dict[str, Any]:
        cid = (args or {}).get("connection_id")
        if not cid:
            return {"ok": False, "error": "connection_id required"}
        try:
            ws_manager.close(cid)
            return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    return [
        ToolDef(
            name="ws_connections",
            description="List active WebSocket connections.",
            parameters={"type": "object", "properties": {}, "additionalProperties": False},
            fn=ws_connections,
        ),
        ToolDef(
            name="ws_send",
            description="Send a JSON message on a WebSocket connection.",
            parameters={
                "type": "object",
                "properties": {"connection_id": {"type": "string"}, "message": {}},
                "required": ["connection_id", "message"],
                "additionalProperties": False,
            },
            fn=ws_send,
        ),
        ToolDef(
            name="ws_recv",
            description="Receive messages from a WebSocket connection (batch).",
            parameters={
                "type": "object",
                "properties": {
                    "connection_id": {"type": "string"},
                    "timeout_s": {"type": "number", "default": 2.0},
                    "max_messages": {"type": "integer", "default": 50},
                },
                "required": ["connection_id"],
                "additionalProperties": False,
            },
            fn=ws_recv,
        ),
        ToolDef(
            name="ws_close",
            description="Close a WebSocket connection.",
            parameters={
                "type": "object",
                "properties": {"connection_id": {"type": "string"}},
                "required": ["connection_id"],
                "additionalProperties": False,
            },
            fn=ws_close,
        ),
    ]


# ---------------------------
# Local Gmailwrap tools
# ---------------------------

def _extract_json_from_text(text: str) -> Optional[Any]:
    """
    Try to parse JSON from stdout even if extra text is present.
    """
    if not text:
        return None
    t = text.strip()
    try:
        return json.loads(t)
    except Exception:
        pass
    # find first { or [
    start = None
    for i, ch in enumerate(t):
        if ch in "{[":
            start = i
            break
    if start is None:
        return None
    # find last } or ]
    end = None
    for i in range(len(t) - 1, -1, -1):
        if t[i] in "}]":
            end = i
            break
    if end is None or end <= start:
        return None
    frag = t[start:end + 1]
    try:
        return json.loads(frag)
    except Exception:
        return None


def _run_gmailwrap(gmailwrap_path: str, argv: List[str], timeout_s: int = 60) -> Dict[str, Any]:
    cmd = ["node", gmailwrap_path] + argv
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=max(1, int(timeout_s)))
    except Exception as e:
        return {"ok": False, "error": f"gmailwrap exec failed: {e}", "cmd": " ".join(cmd)}

    out = (p.stdout or "").strip()
    err = (p.stderr or "").strip()
    parsed = _extract_json_from_text(out)

    if isinstance(parsed, dict) and "ok" in parsed:
        # trust wrapper's ok/error schema
        if err and "stderr" not in parsed:
            parsed["stderr"] = err[:4000]
        return parsed

    # wrapper didn’t return JSON; synthesize
    ok = (p.returncode == 0)
    res: Dict[str, Any] = {"ok": ok, "code": p.returncode, "cmd": " ".join(cmd)}
    if parsed is not None:
        res["json"] = parsed
    if out:
        res["stdout"] = out[:12000]
    if err:
        res["stderr"] = err[:12000]
    if not ok and "error" not in res:
        res["error"] = "gmailwrap returned non-zero exit code"
    return res


def build_gmailwrap_tools(gmailwrap_path: str) -> List[ToolDef]:
    gmailwrap_path = os.path.abspath(gmailwrap_path)

    def gmail_list(args: Dict[str, Any]) -> Dict[str, Any]:
        args = args or {}
        folder = str(args.get("folder") or "INBOX")
        page = int(args.get("page") or 1)
        page_size = int(args.get("pageSize") or args.get("page_size") or 10)
        timeout_s = int(args.get("timeout_s") or 60)
        return _run_gmailwrap(gmailwrap_path, ["list", folder, str(page), str(page_size)], timeout_s=timeout_s)

    def gmail_read(args: Dict[str, Any]) -> Dict[str, Any]:
        args = args or {}
        mid = args.get("id") or args.get("message_id")
        if not mid:
            return {"ok": False, "error": "id required"}
        timeout_s = int(args.get("timeout_s") or 60)
        return _run_gmailwrap(gmailwrap_path, ["read", str(mid)], timeout_s=timeout_s)

    def gmail_send(args: Dict[str, Any]) -> Dict[str, Any]:
        args = args or {}
        to = args.get("to")
        subject = args.get("subject")
        body = args.get("body")
        if body is None:
            body = args.get("text") or args.get("message") or args.get("content") or ""
        if isinstance(body, list):
            body = "\n".join(str(x) for x in body)
        if not to or not subject:
            return {"ok": False, "error": "to and subject required"}
        timeout_s = int(args.get("timeout_s") or 90)
        return _run_gmailwrap(gmailwrap_path, ["send", str(to), str(subject), str(body)], timeout_s=timeout_s)

    tools: List[ToolDef] = [
        ToolDef(
            name="gmail_list",
            description="List email envelopes. Args: folder (default INBOX), page (default 1), pageSize (default 10).",
            parameters={
                "type": "object",
                "properties": {
                    "folder": {"type": "string", "default": "INBOX"},
                    "page": {"type": "integer", "default": 1},
                    "pageSize": {"type": "integer", "default": 10},
                    "timeout_s": {"type": "integer", "default": 60},
                },
                "required": [],
                "additionalProperties": True,
            },
            fn=gmail_list,
        ),
        ToolDef(
            name="gmail_read",
            description="Read an email by id.",
            parameters={
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "timeout_s": {"type": "integer", "default": 60},
                },
                "required": ["id"],
                "additionalProperties": True,
            },
            fn=gmail_read,
        ),
        ToolDef(
            name="gmail_send",
            description="Send an email. Args: to, subject, body.",
            parameters={
                "type": "object",
                "properties": {
                    "to": {"type": "string"},
                    "subject": {"type": "string"},
                    "body": {"type": "string"},
                    "timeout_s": {"type": "integer", "default": 90},
                },
                "required": ["to", "subject", "body"],
                "additionalProperties": True,
            },
            fn=gmail_send,
        ),
    ]
    return tools


# ---------------------------
# policy helpers
# ---------------------------

WRITE_HINTS = ("set ", "update ", "change ", "modify ", "assign ", "grant ", "revoke ", "delete ", "remove ", "add ", "create ")

def is_write_request(user_request: str) -> bool:
    s = (user_request or "").strip().lower()
    # include email-ish requests as writes
    if re.match(r"^(e-?mail|send|message|notify|mail)\b", s):
        return True
    return s.startswith(WRITE_HINTS) or any(w in s for w in (" update", " set ", " change ", " modify ", " assign "))

def is_update_intent(user_request: str) -> bool:
    s = (user_request or "").strip().lower()
    # emailing is a write, but not an "update entity" workflow that requires lookup
    if re.match(r"^(e-?mail|send|message|notify|mail)\b", s):
        return False
    if s.startswith(("add ", "create ", "new ", "register ")):
        return False
    return ("set " in s) or ("update" in s) or ("change" in s) or ("modify" in s) or ("assign" in s)

def extract_verify_pair(user_request: str) -> Tuple[Optional[str], Optional[str]]:
    s = (user_request or "").strip()
    m = re.search(r"\b(?:set|update|change|modify)\b\s+.+?\s+([a-zA-Z0-9_\-]+)\s+to\s+(.+)$", s, flags=re.IGNORECASE)
    if m:
        field = m.group(1).strip()
        value = m.group(2).strip().strip('"').strip("'")
        if field and value:
            return field, value
    return None, None


def extract_user_request_from_messages(messages: List[Dict[str, Any]]) -> str:
    """Best-effort conversion of chat messages into a single user request."""
    for message in reversed(messages or []):
        if str(message.get("role", "")).lower() != "user":
            continue
        content = message.get("content")
        if isinstance(content, str) and content.strip():
            return content.strip()
        if isinstance(content, list):
            chunks: List[str] = []
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str):
                    chunks.append(part["text"].strip())
            merged = "\n".join([c for c in chunks if c]).strip()
            if merged:
                return merged

    if messages:
        fallback = messages[-1].get("content")
        if isinstance(fallback, str) and fallback.strip():
            return fallback.strip()
    return ""


def should_use_tools_for_request(
    user_request: str,
    client: OpenAICompat,
    all_tools: List[ToolDef],
    stream: bool,
) -> bool:
    """
    Decide whether a request should run through tool orchestration or be answered
    directly as a normal conversational turn.

    Returns True when tools are needed; False for plain conversational requests.
    """
    text = (user_request or "").strip()
    if not text:
        return False

    # Fast path for obvious action requests.
    lowered = text.lower()
    action_patterns = (
        r"\b(get|fetch|find|lookup|search|check|show|list|read)\b",
        r"\b(create|add|set|update|change|modify|delete|remove|send|email|notify)\b",
        r"\b(api|endpoint|websocket|ws|gmail|inbox|message id|record|database|system)\b",
    )
    if any(re.search(p, lowered) for p in action_patterns):
        return True

    tool_names = ", ".join(sorted({t.name for t in all_tools}))
    classifier_prompt = (
        "You are a strict router for a tool-using assistant.\n"
        "Return exactly one token: NEEDS_TOOLS or CONVERSATIONAL.\n"
        "Choose NEEDS_TOOLS only if the user asks for real-world actions or system-specific data that requires tools.\n"
        "Choose CONVERSATIONAL for chit-chat, explanations, brainstorming, writing help, or general knowledge.\n"
        f"Available tools: {tool_names}"
    )

    resp = client.chat_completions(
        messages=[
            {"role": "system", "content": classifier_prompt},
            {"role": "user", "content": text},
        ],
        tools=None,
        functions=None,
        max_tokens=8,
        stream=stream,
    )
    msg = (resp.get("choices") or [{}])[0].get("message") or {}
    content = clean_model_text(msg.get("content") or "").upper()
    return "NEEDS_TOOLS" in content


def answer_conversational_request(user_request: str, client: OpenAICompat, stream: bool) -> str:
    """Proxy conversational requests directly to the LLM without tools."""
    resp = client.chat_completions(
        messages=[
            {
                "role": "system",
                "content": (
                    "You are Marks in conversational proxy mode. "
                    "Answer the user directly and clearly."
                ),
            },
            {"role": "user", "content": user_request},
        ],
        tools=None,
        functions=None,
        max_tokens=600,
        stream=stream,
    )
    if stream:
        print("")

    msg = (resp.get("choices") or [{}])[0].get("message") or {}
    final = clean_model_text(msg.get("content") or "")
    return final if final else "Done."


# ---------------------------
# Tool formatting + classification
# ---------------------------

def tool_defs_to_openai_tools(tool_defs: List[ToolDef]) -> List[Dict[str, Any]]:
    return [{
        "type": "function",
        "function": {
            "name": t.name,
            "description": t.description,
            "parameters": t.parameters,
        }
    } for t in tool_defs]

def tool_defs_to_legacy_functions(tool_defs: List[ToolDef]) -> List[Dict[str, Any]]:
    return [{
        "name": t.name,
        "description": t.description,
        "parameters": t.parameters,
    } for t in tool_defs]

def is_http_tool(name: str) -> bool:
    return ("__GET__" in name) or ("__POST__" in name) or ("__PUT__" in name) or ("__PATCH__" in name) or ("__DELETE__" in name) or re.search(r"_(get|post|put|patch|delete)_", name) is not None

def is_http_read_tool(name: str) -> bool:
    return ("__GET__" in name) or re.search(r"_get_", name) is not None

def is_http_write_tool(name: str) -> bool:
    return ("__POST__" in name) or ("__PUT__" in name) or ("__PATCH__" in name) or ("__DELETE__" in name) or re.search(r"_(post|put|patch|delete)_", name) is not None

def is_ws_connect_tool(name: str) -> bool:
    return "__WS_CONNECT__" in name or "_ws_connect_" in name

def is_ws_read_tool(name: str) -> bool:
    return name in ("ws_recv", "ws_connections", "ws_close") or is_ws_connect_tool(name)

def is_ws_write_tool(name: str) -> bool:
    return name == "ws_send"

def is_local_read_tool(name: str) -> bool:
    return name in ("gmail_list", "gmail_read")

def is_local_write_tool(name: str) -> bool:
    return name in ("gmail_send",)

def allowed_in_resolve(name: str) -> bool:
    if is_http_tool(name):
        return is_http_read_tool(name)
    if is_ws_connect_tool(name) or name in ("ws_recv", "ws_connections", "ws_close"):
        return True
    if is_local_read_tool(name):
        return True
    return False

def infer_http_method_from_tool_name(name: str) -> Optional[str]:
    if "__GET__" in name or re.search(r"_get_", name): return "get"
    if "__POST__" in name or re.search(r"_post_", name): return "post"
    if "__PUT__" in name or re.search(r"_put_", name): return "put"
    if "__PATCH__" in name or re.search(r"_patch_", name): return "patch"
    if "__DELETE__" in name or re.search(r"_delete_", name): return "delete"
    return None


# ---------------------------
# Tool-call extraction compatibility
# ---------------------------

def normalize_tool_calls_from_message(msg: Dict[str, Any]) -> List[Dict[str, Any]]:
    tcs = msg.get("tool_calls")
    if isinstance(tcs, list) and tcs:
        return tcs

    fc = msg.get("function_call")
    if isinstance(fc, dict) and fc.get("name"):
        return [{
            "id": f"legacy_{uuid.uuid4()}",
            "type": "function",
            "function": {
                "name": fc.get("name"),
                "arguments": fc.get("arguments") or "{}",
            }
        }]
    return []


# ---------------------------
# Simple resolved-target finder (generic for firstName/lastName lists)
# ---------------------------

_STOPWORDS = {
    "set","update","change","modify","assign","grant","revoke","delete","remove","add","create",
    "role","to","company","owner","the","a","an","of","and","for","with","crew","member","members",
}

def _tokens_from_request(req: str) -> List[str]:
    words = re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)?", req or "")
    out = []
    for w in words:
        wl = w.lower()
        wl = re.sub(r"'s$", "", wl)
        if wl.endswith("s") and len(wl) > 3:
            # helps "coleens" -> "coleen"
            wl2 = wl[:-1]
            out.append(wl2)
        out.append(wl)
    # unique preserve order
    seen = set()
    final = []
    for t in out:
        if t in _STOPWORDS:
            continue
        if t not in seen:
            seen.add(t)
            final.append(t)
    return final

def _walk_json(obj: Any) -> List[Any]:
    nodes = [obj]
    out = []
    while nodes:
        cur = nodes.pop()
        out.append(cur)
        if isinstance(cur, dict):
            for v in cur.values():
                nodes.append(v)
        elif isinstance(cur, list):
            for v in cur:
                nodes.append(v)
    return out

def find_resolved_person_target(user_request: str, last_read: Any) -> Optional[Dict[str, Any]]:
    """
    Look through last_read JSON for lists of dicts that look like people:
      dict has id + firstName + lastName (or at least firstName/lastName)
    Then pick best match based on tokens found in request.
    """
    if last_read is None:
        return None
    toks = _tokens_from_request(user_request)
    if not toks:
        return None

    best = None
    best_score = 0

    for node in _walk_json(last_read):
        if isinstance(node, list) and node and all(isinstance(x, dict) for x in node):
            for rec in node:
                fn = (rec.get("firstName") or "").strip().lower()
                ln = (rec.get("lastName") or "").strip().lower()
                rid = rec.get("id")
                if not (fn or ln):
                    continue

                score = 0
                for t in toks:
                    if fn and (t == fn or fn.startswith(t) or t.startswith(fn)):
                        score += 3
                    if ln and (t == ln or ln.startswith(t) or t.startswith(ln)):
                        score += 2
                # bonus if both match-ish
                if fn and ln and any(t == fn for t in toks) and any(t == ln for t in toks):
                    score += 2
                # prefer having id
                if rid:
                    score += 1

                if score > best_score:
                    best_score = score
                    best = rec

    if best and best_score >= 3:
        return best
    return None


# ---------------------------
# prompt policy
# ---------------------------

def make_system_prompt(phase: str, tool_index: str) -> str:
    phase = phase.upper()
    return (
        "You are Marks, an execution agent for a real system.\n"
        "You MUST use tool calls to do work. Do NOT write pseudo-code. Do NOT claim actions you didn't execute.\n"
        "Never invent endpoints. Only use the provided tools by exact name.\n\n"
        "IMPORTANT TOOL ARG RULES:\n"
        "- For HTTP tools, prefer arguments as {\"json_body\": {...}, \"query_params\": {...}, \"path_params\": {...}}.\n"
        "- If you instead pass a flat object, the runtime will treat it as the JSON body for write methods.\n\n"
        "Policy: READ/RESOLVE → WRITE → VERIFY\n"
        "- For update/change requests, you MUST look up existing data first.\n"
        "- Do NOT create a new entity when the request is to update an existing entity.\n"
        "- After any write, you MUST verify by reading back and confirming the change.\n\n"
        f"Current phase: {phase}\n"
        + (
            "RESOLVE phase rules:\n"
            "- Use ONLY read tools (HTTP GET, WS_CONNECT, ws_recv, ws_connections, ws_close, gmail_list, gmail_read).\n"
            "- Do NOT call write tools.\n"
            "- Goal: gather identifiers/current state needed for the write.\n"
            "When you have enough information AND you have performed at least one successful READ tool call, say exactly: RESOLVE_COMPLETE\n"
            if phase == "RESOLVE" else
            "EXECUTE phase rules:\n"
            "- Perform the required write(s) via tools.\n"
            "- Then perform verification read(s) via tools.\n"
            "- Only then provide the final answer.\n"
        )
        + "\nTOOL INDEX (names you may call):\n"
        + tool_index
    )


def summarize_tool_result(tool_name: str, result_obj: Any) -> str:
    if isinstance(result_obj, dict):
        if "status" in result_obj and "url" in result_obj:
            return f"{tool_name} -> {result_obj.get('status')} {result_obj.get('url')}"
        if tool_name == "ws_recv":
            ok = result_obj.get("ok")
            n = len(result_obj.get("messages") or [])
            return f"{tool_name} -> ok={ok} messages={n}"
        if tool_name.startswith("ws_") or "WS_CONNECT" in tool_name or "_ws_connect_" in tool_name:
            return f"{tool_name} -> ok={result_obj.get('ok')}"
        if tool_name.startswith("gmail_"):
            return f"{tool_name} -> ok={result_obj.get('ok')}"
    return f"{tool_name} -> (result)"


# ---------------------------
# staged run with guards
# ---------------------------

def _is_action_gated_write_tool(name: str) -> bool:
    if not name:
        return False
    return is_http_write_tool(name) or is_ws_write_tool(name) or is_local_write_tool(name)


def run_phase(
    client: OpenAICompat,
    phase: str,
    messages: List[Dict[str, Any]],
    tool_defs: List[ToolDef],
    max_steps: int,
    stream: bool,
    debug: bool,
    trace: bool,
    require_lookup_before_write: bool,
    lookup_evidence: Dict[str, Any],
    track_write: Dict[str, Any],
    verify_pair: Tuple[Optional[str], Optional[str]],
    action_gate_on: bool,
    action_gate_unlocked: bool,
    user_write_req: bool,
    user_update_intent: bool,
) -> None:
    tool_map = {t.name: t for t in tool_defs}
    openai_tools = tool_defs_to_openai_tools(tool_defs)
    legacy_functions = tool_defs_to_legacy_functions(tool_defs)

    for step in range(1, max_steps + 1):
        log("executor", f"{phase.lower()} step {step}/{max_steps}…", True)

        resp = client.chat_completions(
            messages,
            tools=openai_tools,
            functions=legacy_functions,
            max_tokens=900,
            stream=stream,
        )
        if stream:
            print("")

        msg = (resp.get("choices") or [{}])[0].get("message") or {}
        content = clean_model_text(msg.get("content") or "")
        if content:
            log("think", content, True)

        tool_calls = normalize_tool_calls_from_message(msg)

        # RESOLVE completion: only accept if we actually have read evidence
        if phase.upper() == "RESOLVE" and not tool_calls:
            if "RESOLVE_COMPLETE" in (content or ""):
                if lookup_evidence.get("has_read_ok"):
                    return
                messages.append({"role": "user", "content": "You said RESOLVE_COMPLETE, but you have not performed a successful READ tool call yet. Call a READ tool now, then say RESOLVE_COMPLETE."})
                continue

            messages.append({"role": "user", "content": "Continue resolving by calling a READ tool (HTTP GET or WS_CONNECT+ws_recv or gmail_list/gmail_read). Do NOT write. When ready, say RESOLVE_COMPLETE."})
            continue

        if not tool_calls:
            return

        messages.append({
            "role": "assistant",
            "content": msg.get("content") if msg.get("content") else None,
            "tool_calls": tool_calls,
        })

        for tc in tool_calls:
            tc_id = tc.get("id") or f"tc_{uuid.uuid4()}"
            fn = (tc.get("function") or {})
            name = fn.get("name")
            arg_str = fn.get("arguments") or "{}"

            try:
                args = json.loads(arg_str) if isinstance(arg_str, str) else (arg_str or {})
                if not isinstance(args, dict):
                    args = {}
            except Exception:
                args = {}

            # Phase restriction (resolve-only)
            if phase.upper() == "RESOLVE" and name and (not allowed_in_resolve(name)):
                result_obj = {"ok": False, "error": f"Tool '{name}' disabled in RESOLVE phase. Use READ tools only."}
                if debug:
                    log("tool", f"BLOCKED {name} (resolve-only)", True)

            # Action gate for any write/modify/email/delete actions
            elif action_gate_on and name and _is_action_gated_write_tool(name) and not action_gate_unlocked:
                result_obj = {"ok": False, "error": "Action gate locked. Re-run with --gate ALLOW to permit modifications/deletes/emails."}
                if debug:
                    log("tool", f"BLOCKED {name} (action gate locked)", True)

            # Write guard for updates: must have a successful read first
            elif require_lookup_before_write and name and (is_http_write_tool(name) or is_ws_write_tool(name) or is_local_write_tool(name)) and not lookup_evidence.get("has_read_ok"):
                result_obj = {"ok": False, "error": "Write blocked: you must first read/resolve existing data (use HTTP GET or WS_CONNECT+ws_recv or gmail_list/gmail_read) before writing."}
                if debug:
                    log("tool", f"BLOCKED {name} (lookup required)", True)

            # Wrong-target guard when we resolved a person target (HTTP writes only)
            elif require_lookup_before_write and name and is_http_write_tool(name) and lookup_evidence.get("resolved_target") is not None:
                target = lookup_evidence["resolved_target"]
                method = infer_http_method_from_tool_name(name) or "post"
                _, _, _, jb, _ = normalize_http_tool_args(method, args)

                if isinstance(jb, dict):
                    tid = target.get("id")
                    tfn = (target.get("firstName") or "").strip().lower()
                    tln = (target.get("lastName") or "").strip().lower()

                    bid = jb.get("id")
                    bfn = (jb.get("firstName") or "").strip().lower()
                    bln = (jb.get("lastName") or "").strip().lower()

                    mismatch = False
                    if tid and bid and str(bid) != str(tid):
                        mismatch = True
                    if (bfn or bln) and ((tfn and bfn and bfn != tfn) or (tln and bln and bln != tln)):
                        mismatch = True

                    if mismatch:
                        result_obj = {
                            "ok": False,
                            "error": "Write blocked: body does not match the resolved target entity. Use the resolved target id/name and update only requested fields.",
                            "resolved_target": {"id": tid, "firstName": target.get("firstName"), "lastName": target.get("lastName")},
                        }
                        if debug:
                            log("tool", f"BLOCKED {name} (wrong target)", True)
                    else:
                        tool = tool_map.get(name)
                        if not tool:
                            result_obj = {"ok": False, "error": f"Unknown tool: {name}"}
                        else:
                            if trace:
                                log("tool", f"CALL {name} args={json.dumps(args, ensure_ascii=False)[:1400]}", True)
                            try:
                                result_obj = tool.fn(args)
                            except Exception as e:
                                result_obj = {"ok": False, "error": str(e)}
                            if debug:
                                log("tool", summarize_tool_result(name or "?", result_obj), True)
                            if trace:
                                log("tool", f"RESULT {name} {json.dumps(result_obj, ensure_ascii=False)[:2000]}", True)

            else:
                if trace:
                    log("tool", f"CALL {name} args={json.dumps(args, ensure_ascii=False)[:1400]}", True)

                tool = tool_map.get(name)
                if not tool:
                    result_obj = {"ok": False, "error": f"Unknown tool: {name}"}
                else:
                    try:
                        result_obj = tool.fn(args)
                    except Exception as e:
                        result_obj = {"ok": False, "error": str(e)}

                if debug:
                    log("tool", summarize_tool_result(name or "?", result_obj), True)
                if trace:
                    log("tool", f"RESULT {name} {json.dumps(result_obj, ensure_ascii=False)[:2000]}", True)

            # Evidence tracking
            if isinstance(result_obj, dict) and result_obj.get("ok") is True:
                if name and (is_http_read_tool(name) or is_ws_read_tool(name) or is_local_read_tool(name)):
                    lookup_evidence["has_read_ok"] = True
                    lookup_evidence["last_read"] = result_obj

                    if lookup_evidence.get("resolved_target") is None:
                        try:
                            candidate = find_resolved_person_target(messages[1]["content"], result_obj.get("json") or result_obj)
                            if candidate:
                                lookup_evidence["resolved_target"] = candidate
                        except Exception:
                            pass

                if name and (is_http_write_tool(name) or is_ws_write_tool(name) or is_local_write_tool(name)):
                    track_write["did_write"] = True
                    track_write["write_ok"] = True
                    track_write["last_write"] = result_obj

                    # For gmail_send: treat success as verified (no deterministic read-back)
                    if name == "gmail_send":
                        track_write["did_verify_read"] = True
                        track_write["verified_match"] = True
                        track_write["verification_read"] = result_obj

                if track_write.get("did_write") and name and (is_http_read_tool(name) or is_ws_read_tool(name) or is_local_read_tool(name)):
                    track_write["did_verify_read"] = True
                    field, value = verify_pair
                    if field and value:
                        blob = json.dumps(result_obj, ensure_ascii=False).lower()
                        if (field.lower() in blob) and (str(value).lower() in blob):
                            track_write["verified_match"] = True
                            track_write["verification_read"] = result_obj
                    else:
                        track_write["verified_match"] = True
                        track_write["verification_read"] = result_obj

            messages.append({
                "role": "tool",
                "tool_call_id": tc_id,
                "content": json.dumps(result_obj, ensure_ascii=False),
            })

        # If this is a write request that does NOT need "update intent" lookup (like sending an email),
        # and we have at least one successful READ, end RESOLVE immediately to avoid repeated blocked writes.
        if phase.upper() == "RESOLVE" and user_write_req and (not user_update_intent) and lookup_evidence.get("has_read_ok"):
            return


# ---------------------------
# runtime helpers
# ---------------------------

def build_runtime(args: argparse.Namespace, debug: bool) -> Tuple[OpenAICompat, WSManager, List[ToolDef], Dict[str, str]]:
    default_headers: Dict[str, str] = {}
    if args.bearer:
        default_headers["Authorization"] = f"Bearer {args.bearer}"
    for h in args.header:
        if ":" in h:
            k, v = h.split(":", 1)
            default_headers[k.strip()] = v.strip()

    ws_manager = WSManager()
    all_tools: List[ToolDef] = []

    client = OpenAICompat(
        base_url=args.llm_base_url,
        api_key=args.llm_key,
        model=args.model,
        timeout_s=max(10, int(args.llm_timeout)),
        retries=max(0, int(args.llm_retries)),
        retry_backoff_s=0.8,
    )
    client.model = client.choose_model(client.model)

    for spec_path in args.specs:
        with open(spec_path, "r", encoding="utf-8") as f:
            spec = json.load(f)

        info_obj = spec.get("info") or {}
        title = info_obj.get("title") or os.path.basename(spec_path)
        prefix = _sanitize_prefix(title)

        http_capable, ws_capable = _detect_spec_kind(spec)
        servers = spec.get("servers") or []
        resolved_servers = [_resolve_server_url(s) for s in servers]

        http_base = ""
        ws_base = ""

        for u in resolved_servers:
            if not http_base and (u.startswith("http://") or u.startswith("https://")):
                http_base = u
            if not ws_base and (u.startswith("ws://") or u.startswith("wss://")):
                ws_base = u

        if args.http_base_url:
            http_base = args.http_base_url
        if args.ws_base_url:
            ws_base = args.ws_base_url

        if http_base and not http_base.endswith("/"):
            http_base += "/"

        log("init", f"Loaded spec '{spec_path}' as prefix='{prefix}' (http={http_capable}, ws={ws_capable})", True)

        if http_capable:
            http_tools = build_http_tools(prefix, spec, http_base, default_headers)
            all_tools.extend(http_tools)
            log("init", f"HTTP tools for {prefix}: {len(http_tools)} (base={http_base or 'None'})", True)

        if ws_capable:
            ws_tools = build_ws_connect_tools(prefix, spec, ws_base, ws_manager, default_headers)
            all_tools.extend(ws_tools)
            log("init", f"WS connect tools for {prefix}: {len(ws_tools)} (base={ws_base or 'None'})", True)

    all_tools.extend(build_generic_ws_tools(ws_manager))

    if args.gmailwrap:
        gmail_tools = build_gmailwrap_tools(args.gmailwrap)
        all_tools.extend(gmail_tools)
        log("init", f"Local Gmail tools loaded from {args.gmailwrap}", True)

    log("init", f"Total tools loaded: {len(all_tools)} from {len(args.specs)} spec file(s)", True)
    return client, ws_manager, all_tools, default_headers


def execute_agent_request(
    user_request: str,
    args: argparse.Namespace,
    client: OpenAICompat,
    all_tools: List[ToolDef],
    debug: bool,
    trace: bool,
    action_gate_on: bool,
    action_gate_unlocked: bool,
) -> str:
    if not should_use_tools_for_request(user_request, client, all_tools, bool(args.stream)):
        if debug:
            log("policy", "Request classified as conversational; responding without tools.", True)
        return answer_conversational_request(user_request, client, bool(args.stream))

    uniq_names = []
    seen = set()
    for t in all_tools:
        if t.name not in seen:
            seen.add(t.name)
            uniq_names.append(t.name)
    tool_index = "\n".join(f"- {n}" for n in uniq_names)

    write_req = is_write_request(user_request)
    update_intent = is_update_intent(user_request)
    verify_field, verify_value = extract_verify_pair(user_request)
    if debug:
        log("policy", f"write_req={write_req} update_intent={update_intent} verify_hint=({verify_field!r},{verify_value!r})", True)

    lookup_evidence = {"has_read_ok": False, "last_read": None, "resolved_target": None}
    track_write = {"did_write": False, "write_ok": False, "did_verify_read": False, "verified_match": False, "verification_read": None}

    messages: List[Dict[str, Any]] = [
        {"role": "system", "content": make_system_prompt("RESOLVE", tool_index)},
        {"role": "user", "content": user_request},
        {"role": "user", "content": "First: call the single most relevant READ tool (HTTP GET, or WS_CONNECT+ws_recv, or gmail_list/gmail_read). Do NOT write yet."},
    ]

    run_phase(
        client=client,
        phase="RESOLVE",
        messages=messages,
        tool_defs=all_tools,
        max_steps=max(1, int(args.resolve_steps)),
        stream=bool(args.stream),
        debug=debug,
        trace=trace,
        require_lookup_before_write=False,
        lookup_evidence=lookup_evidence,
        track_write=track_write,
        verify_pair=(verify_field, verify_value),
        action_gate_on=action_gate_on,
        action_gate_unlocked=action_gate_unlocked,
        user_write_req=write_req,
        user_update_intent=update_intent,
    )

    if lookup_evidence.get("resolved_target"):
        t = lookup_evidence["resolved_target"]
        messages.append({
            "role": "user",
            "content": (
                "RESOLVED TARGET (use this exact entity for updates; do not modify others): "
                f"id={t.get('id')} name={t.get('firstName','')} {t.get('lastName','')}. "
                "When writing, include this id and keep other fields unchanged unless requested."
            )
        })

    messages = [{"role": "system", "content": make_system_prompt("EXECUTE", tool_index)}, *messages[1:]]
    require_lookup = (write_req and update_intent)

    run_phase(
        client=client,
        phase="EXECUTE",
        messages=messages,
        tool_defs=all_tools,
        max_steps=max(1, int(args.execute_steps)),
        stream=bool(args.stream),
        debug=debug,
        trace=trace,
        require_lookup_before_write=require_lookup,
        lookup_evidence=lookup_evidence,
        track_write=track_write,
        verify_pair=(verify_field, verify_value),
        action_gate_on=action_gate_on,
        action_gate_unlocked=action_gate_unlocked,
        user_write_req=write_req,
        user_update_intent=update_intent,
    )

    if write_req and not args.no_write_guard and not track_write.get("write_ok"):
        messages.append({"role": "user", "content": "You have not completed a confirmed successful write. Use tools to do the write, then verify by reading back (or for email, ensure send succeeded)."})
    if write_req and not args.no_verify_guard and not track_write.get("verified_match"):
        messages.append({"role": "user", "content": "You must verify the change by reading back and confirming it. Then provide the final result."})
    messages.append({"role": "user", "content": "Now provide the final user-facing answer. Do not mention tool names, planning, or internal rules."})

    resp = client.chat_completions(
        messages,
        tools=tool_defs_to_openai_tools(all_tools),
        functions=tool_defs_to_legacy_functions(all_tools),
        max_tokens=600,
        stream=bool(args.stream),
    )
    if args.stream:
        print("")

    msg = (resp.get("choices") or [{}])[0].get("message") or {}
    final = clean_model_text(msg.get("content") or "")

    if write_req and not args.no_write_guard and not track_write.get("write_ok"):
        return "I could not complete the requested action because no confirmed successful write occurred via tools."
    if write_req and not args.no_verify_guard and not track_write.get("verified_match"):
        return "A write may have been attempted, but I could not verify the result successfully."
    return final if final else "Done."


def run_control_ws_loop(
    args: argparse.Namespace,
    client: OpenAICompat,
    all_tools: List[ToolDef],
    debug: bool,
    trace: bool,
    action_gate_on: bool,
    action_gate_unlocked: bool,
) -> None:
    ws_url = args.control_ws_url
    token = args.control_token
    client_id = args.client_id or f"{socket.gethostname()}-{uuid.uuid4().hex[:8]}"
    inflight_cancel: Dict[str, threading.Event] = {}
    send_lock = threading.Lock()

    wsapp_ref: Dict[str, Optional[websocket.WebSocketApp]] = {"ws": None}

    def send_obj(obj: Dict[str, Any]) -> None:
        wsapp = wsapp_ref["ws"]
        if not wsapp:
            return
        with send_lock:
            try:
                wsapp.send(json.dumps(obj, ensure_ascii=False))
            except Exception:
                return

    def on_open(wsapp: websocket.WebSocketApp) -> None:
        send_obj({
            "type": "hello",
            "client_id": client_id,
            "lm_base_url": args.llm_base_url,
            "capabilities": {
                "models": True,
                "chat": True,
                "stream": False,
                "cancel": True,
                "tools": True,
            },
            "ts": int(time.time() * 1000),
        })

    def run_chat(msg_id: str, body: Dict[str, Any]) -> None:
        cancel_evt = inflight_cancel[msg_id]
        messages = body.get("messages") if isinstance(body, dict) else None
        user_request = extract_user_request_from_messages(messages if isinstance(messages, list) else [])
        if not user_request:
            send_obj({"type": "error", "id": msg_id, "error": {"message": "chat missing body.messages[]"}})
            inflight_cancel.pop(msg_id, None)
            return

        try:
            result = execute_agent_request(user_request, args, client, all_tools, debug, trace, action_gate_on, action_gate_unlocked)
            if cancel_evt.is_set():
                send_obj({"type": "cancelled", "id": msg_id, "ok": True})
            else:
                send_obj({"type": "done", "id": msg_id, "message": result, "finish_reason": "stop", "usage": None})
        except Exception as e:
            send_obj({"type": "error", "id": msg_id, "error": {"message": str(e)}})
        finally:
            inflight_cancel.pop(msg_id, None)

    def on_message(_wsapp: websocket.WebSocketApp, raw: str) -> None:
        try:
            msg = json.loads(raw)
        except Exception:
            send_obj({"type": "error", "id": None, "error": {"message": "bad_json"}})
            return

        mtype = str(msg.get("type") or "")
        msg_id = str(msg.get("id") or "")

        if mtype == "ping":
            send_obj({"type": "pong", "ts": int(time.time() * 1000)})
            return
        if mtype == "pong":
            return
        if mtype == "models":
            try:
                send_obj({"type": "models", "id": msg_id, "ok": True, "data": {"data": [{"id": client.model}]}})
            except Exception as e:
                send_obj({"type": "models", "id": msg_id, "ok": False, "error": {"message": str(e)}})
            return
        if mtype == "cancel":
            evt = inflight_cancel.get(msg_id)
            if evt:
                evt.set()
                send_obj({"type": "cancelled", "id": msg_id, "ok": True})
            else:
                send_obj({"type": "cancelled", "id": msg_id, "ok": False, "error": {"message": "not_inflight"}})
            return
        if mtype == "chat":
            body = msg.get("body")
            if not isinstance(body, dict):
                send_obj({"type": "error", "id": msg_id, "error": {"message": "chat missing body.messages[]"}})
                return
            send_obj({"type": "started", "id": msg_id})
            inflight_cancel[msg_id] = threading.Event()
            threading.Thread(target=run_chat, args=(msg_id, body), daemon=True).start()
            return

        send_obj({"type": "error", "id": msg_id or None, "error": {"message": f"unknown_type:{mtype}"}})

    headers = [f"x-control-token: {token}"] if token else None
    backoff_s = 1.0
    while True:
        log("ws", f"Connecting to control WS: {ws_url}", True)
        wsapp = websocket.WebSocketApp(
            ws_url,
            header=headers,
            on_open=on_open,
            on_message=on_message,
        )
        wsapp_ref["ws"] = wsapp
        wsapp.run_forever(ping_interval=25)
        time.sleep(backoff_s)
        backoff_s = min(30.0, backoff_s * 1.6)


# ---------------------------
# main
# ---------------------------

def main() -> None:
    ap = argparse.ArgumentParser(description="Marks — tool-calling agent for HTTP + WS specs + local Gmailwrap (LM Studio)")
    ap.add_argument("request", nargs="?", default="", help="User request (required unless --control-ws-url is used)")
    ap.add_argument("specs", nargs="*", help="One or more JSON spec files (HTTP and/or WS)")

    ap.add_argument("--stream", action="store_true", help="Stream assistant text to CLI (if supported)")
    ap.add_argument("--trace", action="store_true", help="Verbose tool call logging (args + results)")
    ap.add_argument("--no-debug", action="store_true", help="Suppress tool action summaries")

    ap.add_argument("--llm-base-url", default=os.environ.get("LMSTUDIO_BASE_URL", "http://localhost:1234/v1"))
    ap.add_argument("--llm-key", default=os.environ.get("OPENAI_API_KEY", "lm_studio"))
    ap.add_argument("--model", default=os.environ.get("LMSTUDIO_MODEL", "local-model"))
    ap.add_argument("--llm-timeout", type=int, default=int(os.environ.get("LMSTUDIO_TIMEOUT", "240")))
    ap.add_argument("--llm-retries", type=int, default=int(os.environ.get("LMSTUDIO_RETRIES", "1")))

    ap.add_argument("--http-base-url", default=os.environ.get("MARKS_HTTP_BASE_URL", ""),
                    help="Override HTTP base URL for ALL HTTP specs")
    ap.add_argument("--ws-base-url", default=os.environ.get("MARKS_WS_BASE_URL", ""),
                    help="Override WS base URL for ALL WS specs")

    ap.add_argument("--bearer", default=os.environ.get("MARKS_BEARER", ""),
                    help="Authorization bearer token (adds Authorization: Bearer <token>)")
    ap.add_argument("--header", action="append", default=[],
                    help='Extra header, repeatable. Example: --header "x-control-token: abc"')

    ap.add_argument("--resolve-steps", type=int, default=8, help="Max steps for RESOLVE phase")
    ap.add_argument("--execute-steps", type=int, default=20, help="Max steps for EXECUTE phase")
    ap.add_argument("--no-write-guard", action="store_true", help="Disable 'must have successful write' gate")
    ap.add_argument("--no-verify-guard", action="store_true", help="Disable 'must verify by read-back' gate")

    ap.add_argument("--gmailwrap", default=os.environ.get("MARKS_GMAILWRAP", ""),
                    help="Path to gmailwrap.mjs (Node script). Enables gmail_list/gmail_read/gmail_send tools.")
    ap.add_argument("--gate", default=os.environ.get("MARKS_GATE", ""),
                    help="Unlock modifying/deleting/emailing actions. Use: --gate ALLOW")

    ap.add_argument("--control-ws-url", default=os.environ.get("CONTROL_WS_URL", ""),
                    help="Control WebSocket endpoint compatible with lmstudio-proxy-client protocol")
    ap.add_argument("--control-token", default=os.environ.get("CONTROL_TOKEN", ""),
                    help="Optional x-control-token header for --control-ws-url")
    ap.add_argument("--client-id", default=os.environ.get("CLIENT_ID", ""),
                    help="Optional identity sent in control WS hello")

    args = ap.parse_args()

    if args.control_ws_url and (not args.specs) and args.request:
        args.specs = [args.request]
        args.request = ""

    if not args.specs:
        raise ValueError("At least one spec file is required.")

    debug = not args.no_debug
    trace = bool(args.trace)

    action_gate_on = True
    action_gate_unlocked = (str(args.gate).strip().upper() == "ALLOW")
    log("policy", f"action_gate=on unlocked={action_gate_unlocked}", True)

    client, _ws_manager, all_tools, _headers = build_runtime(args, debug)

    if args.control_ws_url:
        run_control_ws_loop(args, client, all_tools, debug, trace, action_gate_on, action_gate_unlocked)
        return

    if not args.request.strip():
        raise ValueError("request is required unless --control-ws-url is used")

    final = execute_agent_request(args.request, args, client, all_tools, debug, trace, action_gate_on, action_gate_unlocked)

    print("\n" + "=" * 60)
    print(final)
    print("=" * 60 + "\n")



if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nInterrupted.")
        sys.exit(1)
    except Exception as e:
        eprint(f"Fatal error: {e}")
        sys.exit(1)

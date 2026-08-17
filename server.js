import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { fileURLToPath } from "node:url";
import express from "express";
import { HttpsProxyAgent } from "https-proxy-agent";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  BedrockClient,
  ListInferenceProfilesCommand,
  ListFoundationModelsCommand,
} from "@aws-sdk/client-bedrock";
import { CodeAgent } from "./code-agent/index.js";
import { CodeSessionManager } from "./code-agent/sessions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3210);

// ---------------------------------------------------------------------------
// Corporate proxy / SSL inspection
//   HTTPS_PROXY   : http://proxy.example.co.jp:8080
//   AWS_CA_BUNDLE : C:\certs\zscaler-root.pem  (also honours NODE_EXTRA_CA_CERTS)
// ---------------------------------------------------------------------------
const proxyUrl =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  null;

const caPath = process.env.AWS_CA_BUNDLE || process.env.NODE_EXTRA_CA_CERTS || null;
let ca;
if (caPath) {
  try {
    ca = fs.readFileSync(caPath);
  } catch (err) {
    console.warn(`[warn] CA bundle not readable: ${caPath} (${err.message})`);
  }
}

function buildAgent() {
  if (proxyUrl) return new HttpsProxyAgent(proxyUrl, { ca, keepAlive: true });
  return new https.Agent({ ca, keepAlive: true });
}

const requestHandler = new NodeHttpHandler({
  httpsAgent: buildAgent(),
  requestTimeout: 0, // streaming responses stay open
  connectionTimeout: 15_000,
});

// Region intentionally not set from AWS_REGION/AWS_DEFAULT_REGION here: doing
// so ourselves shadowed the SDK's own resolver and skipped its fallback to
// the active AWS profile's `region` in ~/.aws/config, so AWS_PROFILE-only
// setups (no separate AWS_REGION) silently ran against us-east-1 instead of
// the profile's actual region. Letting clientConfig omit `region` lets the
// SDK resolve it the normal way (env vars, then profile config, then IMDS).
const clientConfig = { requestHandler };
const runtime = new BedrockRuntimeClient(clientConfig);
const control = new BedrockClient(clientConfig);

let REGION = "us-east-1";
try {
  REGION = await runtime.config.region();
} catch (err) {
  console.warn(`[warn] could not resolve an AWS region automatically, defaulting to ${REGION}: ${err.message}`);
}

// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "32mb" }));
app.use(express.static(path.join(__dirname, "public")));

/** ------------------------------------------------------------------
 *  Local folder access
 *  Roots are registered from the settings panel at runtime and kept in
 *  memory only. Nothing outside a registered root can ever be read.
 *  ----------------------------------------------------------------- */
const IMAGE_FORMATS = { ".png":"png", ".jpg":"jpeg", ".jpeg":"jpeg", ".gif":"gif", ".webp":"webp" };
const DOC_FORMATS = { ".pdf":"pdf", ".doc":"doc", ".docx":"docx", ".xls":"xls", ".xlsx":"xlsx",
                      ".csv":"csv", ".txt":"txt", ".md":"md", ".html":"html", ".htm":"html" };
const MAX_FILE_BYTES = 4.5 * 1024 * 1024;
const MAX_LISTED = 2000;
const MAX_DEPTH = 5;

let allowedRoots = [];

function insideRoots(target) {
  const abs = path.resolve(target);
  return allowedRoots.some(
    (root) => abs === root || abs.startsWith(root + path.sep)
  );
}

const codeAgent = new CodeAgent({ insideRoots });
const codeSessions = new CodeSessionManager({ insideRoots });

app.post("/api/roots", (req, res) => {
  const wanted = Array.isArray(req.body?.roots) ? req.body.roots : [];
  const ok = [], bad = [];
  for (const raw of wanted) {
    const p = String(raw).trim().replace(/^["']|["']$/g, "");
    if (!p) continue;
    try {
      const abs = path.resolve(p);
      if (fs.statSync(abs).isDirectory()) ok.push(abs);
      else bad.push({ path: p, reason: "フォルダではありません" });
    } catch {
      bad.push({ path: p, reason: "見つかりません" });
    }
  }
  allowedRoots = ok;
  res.json({ roots: ok, rejected: bad });
});

app.get("/api/files", (_req, res) => {
  const files = [];
  let truncated = false;
  const walk = (dir, root, depth) => {
    if (files.length >= MAX_LISTED || depth > MAX_DEPTH) { truncated = true; return; }
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files.length >= MAX_LISTED) { truncated = true; return; }
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name.startsWith("~$")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full, root, depth + 1); continue; }
      const ext = path.extname(e.name).toLowerCase();
      const kind = IMAGE_FORMATS[ext] ? "image" : DOC_FORMATS[ext] ? "document" : null;
      if (!kind) continue;
      let size = 0, mtime = 0;
      try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch { continue; }
      files.push({ path: full, name: e.name, rel: path.relative(root, full), root, size, mtime, kind });
    }
  };
  for (const root of allowedRoots) walk(root, root, 0);
  files.sort((a, b) => b.mtime - a.mtime);
  res.json({ roots: allowedRoots, files, truncated });
});

/** ------------------------------------------------------------------
 *  Claude Code integration (Code Agent) — Phase 0/1
 *  BedrockChat never launches Claude Code itself; it only asks CodeAgent
 *  to do so, and only ever sees CodeAgent's normalized events — never the
 *  CLI's own JSONL output (see code-agent/claude-code.js for why: it
 *  carries far more than should reach the browser). Repository access
 *  reuses allowedRoots / insideRoots() above, no new access-control
 *  mechanism. No diff review, no commit/push here — see code-agent/
 *  index.js for the boundary this keeps.
 *
 *  This SSE stream is independent of /api/chat's: different endpoint,
 *  different payload shape, no shared state.
 *  ----------------------------------------------------------------- */
app.get("/api/code/repos", (_req, res) => {
  res.json({ repos: codeAgent.listRepos(allowedRoots) });
});

app.post("/api/code/requests", (req, res) => {
  const result = codeAgent.createRequest(req.body ?? {}, allowedRoots);
  if (!result.ok) return res.status(result.status).json({ errors: result.errors });
  res.status(202).json({ requestId: result.request.requestId, status: result.request.status });
});

function requestSummary(record) {
  return {
    requestId: record.requestId,
    status: record.status,
    repoPath: record.repoPath,
    mode: record.mode,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.summary ? { summary: record.summary } : {}),
    ...(record.durationMs != null ? { durationMs: record.durationMs } : {}),
    ...(record.costUsd != null ? { costUsd: record.costUsd } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(record.git.before || record.git.after ? { git: record.git } : {}),
  };
}

app.get("/api/code/requests/:id", (req, res) => {
  const record = codeAgent.getRequest(req.params.id);
  if (!record) return res.status(404).json({ error: "not found" });
  res.json(requestSummary(record));
});

app.post("/api/code/requests/:id/cancel", (req, res) => {
  const result = codeAgent.cancelRequest(req.params.id);
  if (!result.ok) return res.status(result.status).json({ errors: result.errors });
  res.status(202).json({ requestId: result.request.requestId, status: result.request.status });
});

app.get("/api/code/requests/:id/events", (req, res) => {
  const record = codeAgent.getRequest(req.params.id);
  if (!record) return res.status(404).json({ error: "not found" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (evt) => res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);

  for (const evt of record.events) send(evt); // replay history so late/reconnecting subscribers catch up

  const onEvent = (evt) => send(evt);
  codeAgent.subscribe(record.requestId, onEvent);
  req.on("close", () => codeAgent.unsubscribe(record.requestId, onEvent));
});

/** ------------------------------------------------------------------
 *  Claude Code chat sessions — continuing conversations, as opposed to
 *  the one-shot /api/code/requests above. A session's first turn is sent
 *  via POST /sessions; later turns via POST /sessions/:id/messages, which
 *  resume the same underlying Claude Code conversation (see
 *  code-agent/sessions.js). Independent endpoint, independent SSE stream —
 *  no shared state with /api/chat or /api/code/requests.
 *  ----------------------------------------------------------------- */
function sessionSummary(record) {
  return {
    sessionId: record.sessionId,
    status: record.status,
    repoPath: record.repoPath,
    mode: record.mode,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    eventCount: record.events.length,
    // The event index the current (or most recently run) turn began at —
    // lets a client reattach its SSE stream after losing the connection
    // (e.g. a browser refresh) and skip only prior turns' replayed events.
    turnStartIndex: record.turnStartIndex,
    busy: record.busy,
    workflow: record.workflow,
    ...(record.error ? { error: record.error } : {}),
  };
}

app.post("/api/code/sessions", (req, res) => {
  const result = codeSessions.createSession(req.body ?? {}, allowedRoots);
  if (!result.ok) return res.status(result.status).json({ errors: result.errors });
  res.status(202).json({
    sessionId: result.session.sessionId,
    status: result.session.status,
    turnStartIndex: result.session.turnStartIndex,
  });
});

// Creates a session and immediately starts it in the Plan -> Approval ->
// Edit -> Test -> Diff -> Approval -> Commit workflow — the one-shot
// "実装を依頼" entry point's counterpart to POST /sessions, sharing the
// exact same workflow machinery (and the same safety guarantees) as
// starting a plan mid-conversation with 📋.
app.post("/api/code/sessions/plan", (req, res) => {
  const result = codeSessions.createSessionWithPlan(req.body ?? {}, allowedRoots);
  if (!result.ok) return res.status(result.status).json({ errors: result.errors });
  res.status(202).json({
    sessionId: result.session.sessionId,
    status: result.session.status,
    turnStartIndex: result.session.turnStartIndex,
  });
});

app.post("/api/code/sessions/:id/messages", (req, res) => {
  const result = codeSessions.sendMessage(req.params.id, req.body?.prompt);
  if (!result.ok) return res.status(result.status).json({ errors: result.errors });
  res.status(202).json({
    sessionId: result.session.sessionId,
    status: result.session.status,
    turnStartIndex: result.session.turnStartIndex,
  });
});

app.get("/api/code/sessions/:id", (req, res) => {
  const record = codeSessions.getSession(req.params.id);
  if (!record) return res.status(404).json({ error: "not found" });
  res.json(sessionSummary(record));
});

app.post("/api/code/sessions/:id/cancel", (req, res) => {
  const result = codeSessions.cancelTurn(req.params.id);
  if (!result.ok) return res.status(result.status).json({ errors: result.errors });
  res.status(202).json({ sessionId: result.session.sessionId, status: result.session.status });
});

/** ------------------------------------------------------------------
 *  Workflow: Plan -> Human Approval -> Edit -> Test -> Diff -> Human
 *  Approval -> Commit, layered on top of a chat session (see
 *  code-agent/sessions.js for the full state diagram). Optional and
 *  explicit — an ordinary chat session never enters a workflow on its
 *  own. Only /workflow/commit and the branch creation inside
 *  /plan/approve ever mutate the repository's git state, and only ever
 *  in direct response to one of these human-triggered calls.
 *  ----------------------------------------------------------------- */
app.post("/api/code/sessions/:id/plan", (req, res) => {
  const result = codeSessions.startPlan(req.params.id, req.body?.prompt);
  if (!result.ok) return res.status(result.status).json({ errors: result.errors });
  res.status(202).json({ sessionId: result.session.sessionId, status: result.session.status });
});

app.post("/api/code/sessions/:id/workflow/approve", (req, res) => {
  const result = codeSessions.approvePlan(req.params.id);
  if (!result.ok) return res.status(result.status).json({ errors: result.errors });
  res.status(202).json({ sessionId: result.session.sessionId, status: result.session.status });
});

app.post("/api/code/sessions/:id/workflow/revise", (req, res) => {
  const result = codeSessions.requestChanges(req.params.id, req.body?.feedback);
  if (!result.ok) return res.status(result.status).json({ errors: result.errors });
  res.status(202).json({ sessionId: result.session.sessionId, status: result.session.status });
});

app.post("/api/code/sessions/:id/workflow/commit", (req, res) => {
  const result = codeSessions.commitWorkflow(req.params.id, req.body?.message);
  if (!result.ok) return res.status(result.status).json({ errors: result.errors });
  res.status(200).json({ sessionId: result.session.sessionId });
});

app.post("/api/code/sessions/:id/workflow/discard", (req, res) => {
  const result = codeSessions.discardWorkflow(req.params.id);
  if (!result.ok) return res.status(result.status).json({ errors: result.errors });
  res.status(200).json({ sessionId: result.session.sessionId });
});

app.post("/api/code/sessions/:id/workflow/cancel", (req, res) => {
  const result = codeSessions.cancelWorkflow(req.params.id);
  if (!result.ok) return res.status(result.status).json({ errors: result.errors });
  res.status(200).json({ sessionId: result.session.sessionId });
});

app.get("/api/code/sessions/:id/diff", (req, res) => {
  const result = codeSessions.getFullDiff(req.params.id);
  if (!result.ok) return res.status(result.status).json({ errors: result.errors });
  res.json(result.diff);
});

app.get("/api/code/sessions/:id/events", (req, res) => {
  const record = codeSessions.getSession(req.params.id);
  if (!record) return res.status(404).json({ error: "not found" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (evt) => res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt)}\n\n`);

  for (const evt of record.events) send(evt); // replay history so late/reconnecting subscribers catch up

  const onEvent = (evt) => send(evt);
  codeSessions.subscribe(record.sessionId, onEvent);
  req.on("close", () => codeSessions.unsubscribe(record.sessionId, onEvent));
});

app.get("/api/config", (_req, res) => {
  res.json({
    region: REGION,
    proxy: proxyUrl ? proxyUrl.replace(/\/\/.*@/, "//***@") : null,
    caBundle: caPath || null,
  });
});

/**
 * Chat history backup — a local JSON file, not a database. The browser's
 * localStorage stays the fast/offline copy the UI actually reads and writes
 * from turn to turn; this is just a durable server-side mirror so clearing
 * browser data (common on managed corporate PCs when they get slow) doesn't
 * wipe out conversation history. 127.0.0.1-only, single-user, so no auth and
 * no concurrency handling beyond "last write wins".
 */
const HISTORY_FILE = path.join(__dirname, "data", "history.json");

app.get("/api/history", (_req, res) => {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return res.json({ threads: [], current: null });
    const raw = fs.readFileSync(HISTORY_FILE, "utf8");
    const data = JSON.parse(raw);
    res.json({ threads: Array.isArray(data.threads) ? data.threads : [], current: data.current ?? null });
  } catch (err) {
    console.warn("[warn] failed to read history file:", err.message);
    res.status(500).json({ error: "履歴の読み込みに失敗しました" });
  }
});

app.post("/api/history", (req, res) => {
  const { threads, current } = req.body ?? {};
  if (!Array.isArray(threads)) {
    return res.status(400).json({ error: "threads must be an array" });
  }
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    const tmpFile = `${HISTORY_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify({ threads, current: current ?? null }), "utf8");
    fs.renameSync(tmpFile, HISTORY_FILE); // atomic swap — a crash mid-write can't corrupt the real file
    res.json({ ok: true });
  } catch (err) {
    console.warn("[warn] failed to write history file:", err.message);
    res.status(500).json({ error: "履歴の保存に失敗しました" });
  }
});

/**
 * Turns an AWS SDK error into a specific, actionable Japanese message.
 * First-run users hitting this endpoint with no AWS setup at all is the
 * single biggest onboarding wall this app has — the raw SDK error (a
 * generic "could not load credentials" or an opaque AccessDeniedException)
 * doesn't tell them what to actually go do about it, so we classify the
 * handful of failure modes that actually happen and name the fix.
 */
function classifyAwsError(err) {
  const msg = err?.message || String(err);
  const name = err?.name || "";
  if (/region is missing/i.test(msg)) {
    return "AWSの設定が見つかりません。`aws configure` を実行してリージョンと認証情報を設定するか、AWS_REGION / AWS_PROFILE 環境変数を指定してください。";
  }
  if (name === "CredentialsProviderError" || /could not load credentials|unable to locate credentials|resolve credentials/i.test(msg)) {
    return "AWSの認証情報が見つかりません。`aws configure` でアクセスキーを設定するか、AWS_PROFILE 環境変数で使うプロファイルを指定してください。";
  }
  if (name === "UnrecognizedClientException" || /security token|invalid.*credentials/i.test(msg)) {
    return "AWSの認証情報が無効です（期限切れの可能性があります）。認証情報を再取得・再設定してください。";
  }
  if (name === "AccessDeniedException" || /access denied|not authorized/i.test(msg)) {
    return "この認証情報には Bedrock を呼び出す権限がありません。IAMポリシーに bedrock:ListFoundationModels ・ bedrock:ListInferenceProfiles ・ bedrock:InvokeModel を許可するか、AWSコンソールでモデルアクセスを有効化してください。";
  }
  if (/getaddrinfo|enotfound|etimedout|econnrefused/i.test(msg)) {
    return "AWSに接続できませんでした。プロキシ設定 (HTTPS_PROXY) やCA証明書 (AWS_CA_BUNDLE) が必要な環境ではないか確認してください。";
  }
  return msg;
}

/** Model list, read live from the account so IDs never go stale. */
app.get("/api/models", async (_req, res) => {
  const models = new Map();
  let lastErr = null;
  try {
    const profiles = await control.send(new ListInferenceProfilesCommand({ maxResults: 100 }));
    for (const p of profiles.inferenceProfileSummaries ?? []) {
      if (!/anthropic|claude/i.test(p.inferenceProfileId ?? "")) continue;
      models.set(p.inferenceProfileId, {
        id: p.inferenceProfileId,
        name: p.inferenceProfileName || p.inferenceProfileId,
        kind: "inference-profile",
      });
    }
  } catch (err) {
    console.warn("[warn] ListInferenceProfiles failed:", err.message);
    lastErr = err;
  }
  try {
    const fm = await control.send(
      new ListFoundationModelsCommand({ byProvider: "anthropic", byOutputModality: "TEXT" })
    );
    for (const m of fm.modelSummaries ?? []) {
      if (!m.modelId || models.has(m.modelId)) continue;
      if (!(m.inferenceTypesSupported ?? []).includes("ON_DEMAND")) continue;
      models.set(m.modelId, { id: m.modelId, name: m.modelName || m.modelId, kind: "foundation" });
    }
  } catch (err) {
    console.warn("[warn] ListFoundationModels failed:", err.message);
    lastErr = lastErr ?? err;
  }

  const list = [...models.values()].sort((a, b) => b.id.localeCompare(a.id));
  if (!list.length) {
    const hint = lastErr
      ? classifyAwsError(lastErr)
      : "IAM権限を確認するか、画面のモデル欄にIDを直接入力してください。";
    return res.status(502).json({ error: `モデル一覧を取得できませんでした。${hint}` });
  }
  res.json({ models: list });
});

/** Streaming chat. Server-Sent Events: {type:"text"|"thinking"|"usage"|"done"|"error"} */
app.post("/api/chat", async (req, res) => {
  const {
    modelId,
    messages = [],
    system = "",
    temperature = 1,
    maxTokens = 8192,
    thinkingBudget = 0,
  } = req.body ?? {};

  if (!modelId) return res.status(400).json({ error: "modelId is required" });

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  const abort = new AbortController();
  req.on("close", () => abort.abort());

  // Bedrock rejects document names with symbols, extensions or repeated spaces.
  const safeName = (n, i) =>
    (String(n || "").replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N} \-()\[\]]/gu, " ").replace(/\s+/g, " ").trim() ||
      `document ${i + 1}`).slice(0, 64);

  const toContent = (m) => {
    const blocks = [];
    (m.files ?? []).forEach((f, i) => {
      let bytes, format = f.format, kind = f.kind;
      if (f.path) {
        if (!insideRoots(f.path)) throw new Error(`許可フォルダ外のパスです: ${f.path}`);
        const ext = path.extname(f.path).toLowerCase();
        kind = IMAGE_FORMATS[ext] ? "image" : DOC_FORMATS[ext] ? "document" : null;
        if (!kind) throw new Error(`対応していない形式です: ${f.path}`);
        format = kind === "image" ? IMAGE_FORMATS[ext] : DOC_FORMATS[ext];
        const st = fs.statSync(f.path);
        if (st.size > MAX_FILE_BYTES) throw new Error(`4.5MBを超えています: ${f.path}`);
        bytes = fs.readFileSync(f.path);
      } else {
        bytes = Buffer.from(f.data, "base64");
      }
      if (kind === "image") {
        blocks.push({ image: { format, source: { bytes } } });
      } else {
        blocks.push({
          document: { format, name: safeName(f.name, i), source: { bytes } },
        });
      }
    });
    if (m.content?.trim()) blocks.push({ text: m.content });
    else if (!blocks.length) blocks.push({ text: "(empty)" });
    else blocks.push({ text: "添付ファイルを確認してください。" });
    return blocks;
  };

  const useThinking = Number(thinkingBudget) > 0;
  let input;
  try {
    input = {
    modelId,
    messages: messages.map((m) => ({ role: m.role, content: toContent(m) })),
    inferenceConfig: {
      maxTokens: Number(maxTokens),
      // temperature is rejected when extended thinking is on
      ...(useThinking ? {} : { temperature: Number(temperature) }),
    },
    ...(system ? { system: [{ text: system }] } : {}),
    ...(useThinking
      ? {
          additionalModelRequestFields: {
            thinking: { type: "enabled", budget_tokens: Number(thinkingBudget) },
          },
        }
      : {}),
    };
  } catch (err) {
    send({ type: "error", message: err.message });
    send({ type: "done" });
    return res.end();
  }

  try {
    const out = await runtime.send(new ConverseStreamCommand(input), {
      abortSignal: abort.signal,
    });
    for await (const event of out.stream ?? []) {
      if (event.contentBlockDelta?.delta?.text) {
        send({ type: "text", text: event.contentBlockDelta.delta.text });
      } else if (event.contentBlockDelta?.delta?.reasoningContent?.text) {
        send({ type: "thinking", text: event.contentBlockDelta.delta.reasoningContent.text });
      } else if (event.metadata?.usage) {
        send({ type: "usage", usage: event.metadata.usage });
      } else if (event.messageStop) {
        send({ type: "stop", reason: event.messageStop.stopReason });
      } else if (
        event.internalServerException ||
        event.modelStreamErrorException ||
        event.throttlingException ||
        event.validationException
      ) {
        const e =
          event.internalServerException ||
          event.modelStreamErrorException ||
          event.throttlingException ||
          event.validationException;
        send({ type: "error", message: e.message || "stream exception" });
      }
    }
    send({ type: "done" });
  } catch (err) {
    if (err.name !== "AbortError") {
      console.error("[chat]", err);
      // Same classifier /api/models uses — a first-run user who typed a
      // model ID in by hand (because /api/models itself already failed)
      // hits this exact path next, and deserves the same "here's what to
      // actually go fix" message rather than a raw SDK error name.
      send({ type: "error", message: classifyAwsError(err) });
    }
  } finally {
    res.end();
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  Claude Code Chat on AWS Bedrock  →  http://localhost:${PORT}`);
  console.log(`  region : ${REGION}`);
  console.log(`  proxy  : ${proxyUrl || "(none)"}`);
  console.log(`  ca     : ${caPath || "(system default)"}\n`);
});

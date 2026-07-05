#!/usr/bin/env node
// voice-pr — local service. Serves the mic UI and streams batch progress.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { runBatch, runSession, getContext } from "./lib/pipeline.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "public");
const PORT = Number(process.env.PORT || 4100);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

// The Chrome extension calls these endpoints from the github.com origin, so
// every response is CORS-open and preflights are answered.
function cors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

const server = createServer(async (req, res) => {
  try {
    cors(res);
    const url = new URL(req.url, "http://localhost");
    if (req.method === "OPTIONS") return res.writeHead(204).end();
    if (req.method === "GET" && url.pathname === "/api/context")
      return await handleContext(url, res);
    if (req.method === "POST" && url.pathname === "/api/session")
      return await handleStream(req, res, (input, send) => runSession(input, send));
    if (req.method === "POST" && url.pathname === "/api/batch")
      return await handleStream(req, res, (input, send) => runBatch(input, send));
    if (req.method === "GET") return await serveStatic(req, res);
    res.writeHead(405).end("method not allowed");
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end(`error: ${e.message}`);
  }
});

async function handleContext(url, res) {
  const prRef = url.searchParams.get("pr");
  try {
    const ctx = await getContext(prRef);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(ctx));
  } catch (e) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function serveStatic(req, res) {
  const rel = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const path = join(PUBLIC, rel);
  if (!path.startsWith(PUBLIC)) return res.writeHead(403).end("forbidden");
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": MIME[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}

async function handleStream(req, res, runner) {
  const body = await readBody(req);
  const input = JSON.parse(body || "{}");

  // Stream progress as newline-delimited JSON so the client can render it live.
  res.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
  });
  const t0 = Date.now();
  const send = (stage, detail) =>
    res.write(
      JSON.stringify({ stage, detail, t: Math.round((Date.now() - t0) / 1000) }) + "\n"
    );

  try {
    console.log(
      `[req] PR=${input.prRef} ${input.segments ? `${input.segments.length} segments` : "transcript"}`
    );
    const result = await runner(input, send);
    send("result", result);
    console.log(
      result.backend === "orchestrator"
        ? `[req] orchestrator: work item ${result.workItemId} -> ${result.status}`
        : `[req] done: ${result.committed.length} committed`
    );
  } catch (e) {
    console.error(`[req] error: ${e.message}`);
    send("error", { message: e.message });
  } finally {
    res.end();
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}

server.listen(PORT, () => {
  console.log(`\n  🎙️  voice-pr running → http://localhost:${PORT}\n`);
  console.log("  Open it in Chrome, paste a PR URL, hold the button, talk.\n");
});

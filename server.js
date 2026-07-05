#!/usr/bin/env node
// voice-pr — local service. Serves the mic UI and streams batch progress.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { runBatch } from "./lib/pipeline.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "public");
const PORT = Number(process.env.PORT || 4100);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/batch")
      return await handleBatch(req, res);
    if (req.method === "GET") return await serveStatic(req, res);
    res.writeHead(405).end("method not allowed");
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end(`error: ${e.message}`);
  }
});

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

async function handleBatch(req, res) {
  const body = await readBody(req);
  const { prRef, transcript } = JSON.parse(body || "{}");

  // Stream progress as newline-delimited JSON so the browser can render it live.
  res.writeHead(200, {
    "content-type": "application/x-ndjson",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
  });
  const send = (stage, detail) =>
    res.write(JSON.stringify({ stage, detail, t: elapsed() }) + "\n");

  const t0 = Date.now();
  function elapsed() {
    return Math.round((Date.now() - t0) / 1000);
  }

  try {
    console.log(`[batch] PR=${prRef} transcript="${(transcript || "").slice(0, 80)}..."`);
    const result = await runBatch({ prRef, transcript }, send);
    send("result", result);
    console.log(
      result.backend === "orchestrator"
        ? `[batch] orchestrator: work item ${result.workItemId} -> ${result.status}`
        : `[batch] done: ${result.committed.length} committed, ${result.needsClarification.length} unclear`
    );
  } catch (e) {
    console.error(`[batch] error: ${e.message}`);
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

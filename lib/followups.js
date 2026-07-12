import { createHash } from "node:crypto";
import {
  createIssue,
  findIssueByMarker,
  parsePr,
  viewPr,
} from "./github.js";
import { getTracer } from "./trace.js";

export function createFollowupsService(options = {}) {
  const resolvePr = options.resolvePr || resolveFollowupPr;
  const findExisting = options.findIssue || findIssueByMarker;
  const create = options.createIssue || createIssue;
  const locks = new Map();
  const knownIssues = new Map();

  async function createBatch({ prRef, confirmed, items }) {
    if (confirmed !== true)
      throw new Error("explicit confirmation is required to create follow-up issues");
    if (!Array.isArray(items) || !items.length)
      throw new Error("at least one follow-up item is required");
    if (items.length > 50) throw new Error("follow-up batch exceeds 50 items");

    const pr = await resolvePr(prRef);
    const results = await Promise.all(
      items.map(async (item) => {
        const clientItemId = itemId(item);
        if (item?.approved === false)
          return resultFor(clientItemId, "skipped");
        try {
          validateItem(item, clientItemId);
          return await ensureIssue(pr, item, clientItemId);
        } catch (error) {
          getTracer().error("followups.issue.error", error, {
            pr: prKey(pr),
            clientItemId,
          });
          return resultFor(clientItemId, "error", {
            error: error.message,
          });
        }
      })
    );

    return {
      pr: { number: pr.number, url: pr.url, repo: `${pr.owner}/${pr.repo}` },
      results,
    };
  }

  async function ensureIssue(pr, item, clientItemId) {
    const marker = idempotencyMarker(pr, clientItemId);
    return withLock(marker, async () => {
      const cached = knownIssues.get(marker);
      if (cached)
        return resultFor(clientItemId, "existing", { issue: cached });
      getTracer().event("followups.issue.search", {
        pr: prKey(pr),
        clientItemId,
      });
      const existing = await findExisting(pr, marker);
      if (existing) {
        knownIssues.set(marker, existing);
        getTracer().event("followups.issue.existing", {
          pr: prKey(pr),
          clientItemId,
          issue: existing.number,
        });
        return resultFor(clientItemId, "existing", { issue: existing });
      }

      const created = await create(pr, {
        title: deterministicIssueTitle(item, pr),
        body: followupIssueBody(pr, item, marker),
      });
      knownIssues.set(marker, created);
      getTracer().event("followups.issue.created", {
        pr: prKey(pr),
        clientItemId,
        issue: created.number,
      });
      return resultFor(clientItemId, "created", { issue: created });
    });
  }

  async function withLock(key, task) {
    const previous = locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    locks.set(key, current);
    try {
      return await current;
    } finally {
      if (locks.get(key) === current) locks.delete(key);
    }
  }

  return { createBatch };
}

export async function resolveFollowupPr(prRef) {
  const pr = parsePr(prRef);
  const meta = await viewPr(pr);
  pr.url = meta.url;
  pr.title = meta.title;
  return pr;
}

export function idempotencyMarker(pr, clientItemId) {
  const digest = createHash("sha256")
    .update(`${prKey(pr)}\0${clientItemId}`)
    .digest("hex");
  return `<!-- voice-pr-followup:${digest} -->`;
}

export function deterministicIssueTitle(item, pr) {
  const original = originalText(item)
    .replace(/[`#>*_[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const base = original || `PR #${pr.number} review follow-up`;
  const prefix = "Follow up: ";
  const maxBase = 72 - prefix.length;
  return `${prefix}${
    base.length > maxBase ? `${base.slice(0, maxBase - 1).trimEnd()}…` : base
  }`;
}

export function followupIssueBody(pr, item, marker) {
  const anchor = item.anchor && typeof item.anchor === "object" ? item.anchor : item;
  const file = String(anchor.file || "").trim();
  const line = Number.isInteger(anchor.line) && anchor.line > 0 ? anchor.line : null;
  const endLine =
    Number.isInteger(anchor.endLine) && anchor.endLine > line
      ? anchor.endLine
      : null;
  const location = file
    ? `${file}${line ? `:${line}${endLine ? `-${endLine}` : ""}` : ""}`
    : "(not captured)";
  const snippet = String(anchor.snippet || "").trim() || "(not captured)";
  const quotedSnippet = snippet
    .slice(0, 2_000)
    .split("\n")
    .map((lineText) => `> ${lineText}`)
    .join("\n");

  return `## Follow-up
${originalText(item)}

## Source
- PR: ${pr.url}
- Location: \`${location.replace(/`/g, "")}\`

## Captured snippet
${quotedSnippet}

${marker}`;
}

export async function createFollowupIssues(input, { service = followupsService } = {}) {
  return service.createBatch(input);
}

function validateItem(item, clientItemId) {
  if (!item || typeof item !== "object")
    throw new Error("follow-up item must be an object");
  if (!clientItemId)
    throw new Error("follow-up item requires a stable clientItemId");
  if (clientItemId.length > 200)
    throw new Error("follow-up clientItemId exceeds 200 characters");
  const text = originalText(item).trim();
  if (!text)
    throw new Error("follow-up item requires originalText");
  if (text.length > 10_000)
    throw new Error("follow-up originalText exceeds 10000 characters");
}

function itemId(item) {
  return String(
    item?.clientItemId ?? item?.id ?? item?.idempotencyKey ?? ""
  ).trim();
}

function originalText(item) {
  return String(item?.originalText ?? item?.text ?? "").trim();
}

function resultFor(clientItemId, status, { issue = null, error = null } = {}) {
  return {
    id: clientItemId,
    clientItemId,
    status,
    issueUrl: issue?.url || null,
    issueNumber: issue?.number || null,
    error,
    issue,
  };
}

function prKey(pr) {
  return `${pr.owner}/${pr.repo}#${pr.number}`;
}

export const followupsService = createFollowupsService();

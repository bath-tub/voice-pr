// Builds the orchestrator work-item body for one live voice review session.
//
// Design decisions baked in (from the grill-me session):
//  - Speaker is the PR AUTHOR dictating changes to their OWN pushed PR.
//  - Source of truth is the pushed head branch (what the author sees on GitHub).
//  - Confident items -> real edits + one commit each.
//  - Unclear items -> NOT acted on; surfaced back as a clarification comment.
//  - Comments are an "anchored intent trail": each committed change explains
//    WHY that line changed, pinned to the line.

/**
 * Body for a live VOICE REVIEW SESSION captured by the Chrome extension: the
 * author scrolled the diff and spoke, and each spoken chunk is anchored to the
 * file+line that was in their viewport at that moment. This body carries those
 * anchors plus context pointers the polecat should pull via its MCP tools.
 *
 * @param {{pr:object, segments:Array<{text,file,line}>, context:object}} a
 */
export function buildSessionBody({ pr, segments, context = {} }) {
  const anchored = segments
    .map((s, i) => {
      const range = s.endLine && s.endLine !== s.line ? `${s.line}-${s.endLine}` : s.line;
      const loc = s.file
        ? `\`${s.file}${range ? `:${range}` : ""}\``
        : "(no on-screen location — infer from the words)";
      const tok = s.token ? ` (pointing at \`${s.token}\`)` : "";
      const snip = s.snippet ? `\n   > selected code: \`${s.snippet.replace(/\s+/g, " ").trim().slice(0, 200)}\`` : "";
      return `${i + 1}. ${loc}${tok} — "${s.text.trim()}"${snip}`;
    })
    .join("\n");

  // Optional enrichment — listed as available-if-present, never as a blocker.
  const optional = [];
  if (context.jiraKey)
    optional.push(
      `- Jira ticket \`${context.jiraKey}\` (from the branch/title) — if Atlassian tools are available, a quick read can sharpen intent.`
    );
  optional.push(
    `- Slack — if Slack tools are available, a search for "#${pr.number}" + the repo name may surface decisions.`
  );
  if (context.checksSummary)
    optional.push(`- CI / checks: ${context.checksSummary}.`);

  return `This work item came from a **live voice review session**: the PR author
scrolled the diff of ${pr.owner}/${pr.repo} #${pr.number} ("${pr.title}") and spoke
their feedback. Each comment is anchored to the file+line on screen when they said
it. Implement the changes as the author would have. Your worktree is based on the
PR head branch \`${pr.headRefName}\`; the refinery merges your commits back onto it,
so your work updates the PR directly.

## Do this now — the spoken comments (anchored to what was on screen)
${anchored}

The anchor is where they were looking, not necessarily the exact edit site — if a
comment clearly refers to code elsewhere ("the retry loop" while scrolled past it),
follow the meaning over the anchor.

For EACH comment:
- Judge your confidence you know the exact change, from the anchor + the diff (below).
- HIGH: make the minimal correct edit (+ a test if behavior changes). One focused
  commit per item, with the work item id in the message.
- LOW (ambiguous, could map to several places, or too large): DO NOT guess or edit —
  note it in your final message as needing clarification.

Then follow the standard polecat protocol to push + submit to the refinery (target
branch \`${pr.headRefName}\`). Do NOT post PR comments yourself — the voice-pr harness
posts the intent trail after your merge.

## Optional context — DO NOT block on this
The diff + anchors above are enough to do the work; start there. Only IF these tools
are already available to you, you MAY briefly consult them to sharpen intent — if
they are not present, skip them entirely and do NOT spend time searching. Never let
context-gathering delay the edits.
${optional.join("\n")}`;
}

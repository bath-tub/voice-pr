import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [content, commandCenter, background, manifestText] = await Promise.all([
  readFile(new URL("../extension/content.js", import.meta.url), "utf8"),
  readFile(new URL("../extension/diffy-command-center.js", import.meta.url), "utf8"),
  readFile(new URL("../extension/background.js", import.meta.url), "utf8"),
  readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"),
]);
const manifest = JSON.parse(manifestText);

function between(source, start, finish) {
  const from = source.indexOf(start);
  const to = source.indexOf(finish, from + start.length);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  assert.notEqual(to, -1, `missing finish marker: ${finish}`);
  return source.slice(from, to);
}

test("Diffy modules load before content and replace the old two-button pill", () => {
  const scripts = manifest.content_scripts[0].js;
  for (const module of [
    "diffy-state.js",
    "storage.js",
    "diffy-launcher.js",
    "diffy-command-center.js",
  ]) {
    assert.ok(scripts.indexOf(module) < scripts.indexOf("content.js"), `${module} loads first`);
  }
  assert.match(content, /class="vp-diffy-launcher"/);
  assert.match(content, /class="vp-diffy-goblin"/);
  assert.doesNotMatch(content, /class="vp-pill"/);
  assert.doesNotMatch(content, /id="vp-pill-rec"/);
});

test("Q&A has a dedicated endpoint and cannot enter Apply Changes dispatch", () => {
  const qa = between(background, 'if (msg?.type === "diffy-qa")', '// Voice capture for Ask Diffy');
  assert.match(qa, /\/api\/qa/);
  assert.match(qa, /prRef: msg\.prUrl/);
  assert.match(qa, /detailLevel: msg\.explain \? "expanded" : "concise"/);
  assert.doesNotMatch(qa, /\/api\/dispatch|updateJob|runtime\.connect/);
  const ask = between(commandCenter, "async function ask(", "async function blobToB64");
  assert.match(ask, /type: "diffy-qa"/);
  assert.doesNotMatch(ask, /onApply|dispatch port|api\/dispatch/);
});

test("issue creation exists only behind explicit routing confirmation", () => {
  const confirm = between(commandCenter, "async function confirmRouting()", 'body.addEventListener("submit"');
  assert.match(confirm, /type: "diffy-followup-issues"/);
  assert.match(confirm, /choices\[item\.id\] === "issue"/);
  assert.match(commandCenter, /Nothing external happens until you confirm/);
  const issueProxy = between(
    background,
    'if (msg?.type === "diffy-followup-issues")',
    '// hub "jump"'
  );
  assert.match(issueProxy, /\/api\/followups\/issues/);
  assert.match(issueProxy, /confirmed: true/);
  assert.match(issueProxy, /clientItemId: item\.clientItemId \|\| item\.id/);
  assert.match(issueProxy, /originalText: item\.originalText \|\| item\.text/);
  assert.doesNotMatch(background, /slack_send|api\/slack/);
});

test("collapse preserves active Apply Changes state and never dispatches", () => {
  const collapse = between(commandCenter, "function collapse()", "function setActivity");
  assert.doesNotMatch(collapse, /dispatch|onApply|clearPr/);
  const applyClose = between(content, '$("#vp-close").addEventListener', "// Keyboard shortcut");
  assert.doesNotMatch(applyClose, /teardown|sendBundle|clearPending/);
});

test("returning to Apply resumes an active capture instead of tearing it down", () => {
  const navigate = between(
    commandCenter,
    "function navigate(screen)",
    "function open()"
  );
  assert.match(
    navigate,
    /onApply\(\{ resume: true, explicit: true, resumeRecording \}\)/
  );
  const integration = between(
    content,
    "onApply:",
    "onShowPanel:"
  );
  assert.match(integration, /captureOpen \|\| dispatched \|\| mediaRecorder/);
  assert.match(integration, /if \(resume && !explicit\)/);
  assert.match(integration, /if \(resumeRecording && paused\) pauseResume\(\)/);
  assert.match(commandCenter, /released\.resumeApply \|\| applyAutoPaused/);
  assert.match(commandCenter, /const resumeRecording = applyAutoPaused/);
});

test("audio finalization survives teardown after MediaRecorder.stop", () => {
  assert.doesNotMatch(content, /stopResolve/);
  assert.match(content, /const sessionChunks = \[\]/);
  assert.match(content, /const result = audioResultPromise \|\| Promise\.resolve\(null\)/);
  assert.match(content, /return result/);
  assert.match(content, /const dispatchContext = \{/);
  assert.match(content, /const bundle = \{ \.\.\.dispatchContext/);
  assert.match(content, /requestedStream\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
  assert.match(content, /if \(!mediaRecorder\) \{/);
  assert.match(commandCenter, /stream\?\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
});

test("SPA navigation canonicalizes and rebinds PR state instead of retaining stale keys", () => {
  assert.match(content, /DiffyLauncher\.observeNavigation\(window, rebindForNavigation\)/);
  const rebind = between(content, "function rebindForNavigation", "window.DiffyLauncher.observeNavigation");
  assert.match(rebind, /prContext = next/);
  assert.match(rebind, /prUrl = next\.prUrl/);
  assert.match(rebind, /pagePreparationRequested = false/);
  assert.match(rebind, /commandCenter\.bindPr\(next\)/);
  assert.match(
    content,
    /const pendingKey = \(targetPr = prUrl\) => `voicepr:pending:\$\{targetPr\}`/
  );
  assert.match(
    content,
    /const handoffKey = \(targetPr = prUrl\) => `voicepr:handedoff:\$\{targetPr\}`/
  );
  assert.match(content, /pendingKey\(bundle\.prRef\)/);
  assert.match(content, /clearPending\(bundle\.prRef\)/);
});

test("async Diffy work is discarded after the bound PR changes", () => {
  assert.match(commandCenter, /const boundPr = pr/);
  assert.match(commandCenter, /const bindingToken = loadingToken/);
  assert.match(commandCenter, /bindingToken !== loadingToken/);
  assert.match(commandCenter, /pr\?\.prUrl !== boundPr\.prUrl/);
  assert.match(commandCenter, /priorTurns/);
  assert.match(background, /priorTurns: Array\.isArray\(msg\.priorTurns\)/);
  assert.match(content, /prUrl !== requestedPr \|\| pageLoadedAt !== requestedAt/);
  assert.match(commandCenter, /anchor: item\?\.answerAnchor \|\| item\?\.anchor/);
  assert.match(content, /commandCenter\.unbindPr\(\)/);
  const voice = between(
    commandCenter,
    "async function toggleVoice",
    "function cancelVoice"
  );
  assert.ok(
    voice.indexOf("const requestedPr = pr") <
      voice.indexOf("getUserMedia")
  );
  assert.match(voice, /voiceRequestToken/);
  assert.match(voice, /voiceStartingMode/);
  assert.match(voice, /bindingToken !== loadingToken/);
});

test("stale Apply and hub callbacks cannot render into a different PR", () => {
  const sendBundle = between(content, "function sendBundle", "// Copy-to-clipboard");
  assert.match(sendBundle, /const isCurrentPr = \(\) => prUrl === bundle\.prRef/);
  assert.match(sendBundle, /if \(isCurrentPr\(\)\) onEvent\(ev\)/);
  assert.match(sendBundle, /clearPending\(bundle\.prRef\)/);
  const hubRender = between(
    content,
    "function renderHubViewWith",
    "const renderHubView"
  );
  assert.match(hubRender, /const renderPrUrl = prUrl/);
  assert.match(hubRender, /if \(prUrl !== renderPrUrl\) return/);
  const resend = between(content, "function hubResend", "function hubDiscard");
  assert.match(resend, /const recoveryPr = prUrl/);
  assert.match(resend, /if \(prUrl !== recoveryPr\) return/);
});

test("Diffy traces behavior without recording question or follow-up content", () => {
  assert.match(content, /onTrace: \(code, detail\) => trace\(code, detail\)/);
  for (const code of [
    "diffy.open",
    "diffy.mode.enter",
    "diffy.qa.start",
    "diffy.qa.done",
    "diffy.followup.capture",
    "diffy.routing.confirm",
    "diffy.session.finish",
  ])
    assert.match(commandCenter, new RegExp(code.replaceAll(".", "\\.")));
  assert.doesNotMatch(
    commandCenter,
    /onTrace\([^)]*(question\s*:|text\s*:|transcript\s*:)/,
  );
});

test("voice Q&A preserves the anchor captured when recording started", () => {
  assert.match(commandCenter, /anchor: current\.anchor/);
  assert.match(commandCenter, /const anchor = anchorOverride \|\| getAnchor\(\)/);
});

test("Q&A voice cancels a pending Apply microphone request before acquiring audio", () => {
  const applyStart = between(content, "async function start()", "function pauseResume");
  assert.ok(
    applyStart.indexOf("const micRequestToken = ++applyMicRequestToken") <
      applyStart.indexOf("getUserMedia")
  );
  assert.match(applyStart, /micRequestToken !== applyMicRequestToken/);
  const integration = between(content, "beforeVoice:", "copyText,");
  assert.match(integration, /if \(applyMicPending\)/);
  assert.match(integration, /applyMicRequestToken\+\+/);
  assert.match(integration, /return true/);
});

// Local speech-to-text via whisper.cpp — audio never leaves the machine.
import { run } from "./exec.js";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_MODEL = (env = process.env) =>
  `${env.HOME}/.cache/whisper/ggml-large-v3-turbo-q5_0.bin`;

/**
 * Transcribe an audio buffer to timed segments.
 * @param {Buffer} audio  raw audio bytes (webm/opus/wav/…)
 * @param {string} ext    source container extension (for ffmpeg)
 * @returns {Promise<Array<{start:number,end:number,text:string}>>}  start/end in seconds
 */
export async function transcribe(audio, ext = "webm") {
  const config = whisperConfig();
  const dir = await mkdtemp(join(tmpdir(), "vp-stt-"));
  const inPath = join(dir, `a.${ext}`);
  const wav = join(dir, "a.wav");
  const outPrefix = join(dir, "out");
  try {
    await writeFile(inPath, audio);
    // whisper wants 16 kHz mono PCM
    await run("ffmpeg", ["-y", "-i", inPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
    await run(config.bin, buildWhisperArgs({ ...config, wav, outPrefix }));
    const json = JSON.parse(await readFile(`${outPrefix}.json`, "utf8"));
    const segments = (json.transcription || []).map((t) => {
      const segment = {
        start: (t.offsets?.from ?? 0) / 1000,
        end: (t.offsets?.to ?? 0) / 1000,
        text: (t.text || "").trim(),
      };
      const noSpeechProb = readNoSpeechProb(t);
      if (noSpeechProb != null) segment.noSpeechProb = noSpeechProb;
      return segment;
    });
    return filterTranscriptSegments(segments, config);
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function whisperConfig(env = process.env) {
  return {
    bin: env.VOICE_PR_WHISPER_BIN || "whisper-cli",
    model: env.VOICE_PR_WHISPER_MODEL || DEFAULT_MODEL(env),
    noSpeechThreshold: optionalProbability(
      env.VOICE_PR_WHISPER_NO_SPEECH_THOLD,
      "VOICE_PR_WHISPER_NO_SPEECH_THOLD"
    ),
    maxNoSpeechProb: optionalProbability(
      env.VOICE_PR_WHISPER_MAX_NO_SPEECH_PROB,
      "VOICE_PR_WHISPER_MAX_NO_SPEECH_PROB"
    ),
    extraArgs: splitArgs(env.VOICE_PR_WHISPER_ARGS || ""),
  };
}

export function buildWhisperArgs({ model, wav, outPrefix, noSpeechThreshold, extraArgs = [] }) {
  const args = ["-m", model, "-f", wav, "-oj", "-of", outPrefix];
  if (noSpeechThreshold != null) {
    args.push("--no-speech-thold", String(noSpeechThreshold));
  }
  return [...args, ...extraArgs];
}

export function filterTranscriptSegments(segments, { maxNoSpeechProb } = {}) {
  return segments.filter((s) => {
    if (!s.text) return false;
    if (/^\[.*\]$/.test(s.text)) return false;
    if (
      maxNoSpeechProb != null &&
      typeof s.noSpeechProb === "number" &&
      s.noSpeechProb >= maxNoSpeechProb
    ) {
      return false;
    }
    return !isHallucination(s.text);
  });
}

// Whisper hallucinates stock phrases on silence/noise. Drop them when they are
// the entire segment (conservative — only exact, well-known artifacts).
const HALLUCINATIONS = new Set([
  "thank you.", "thank you", "thanks for watching!", "thanks for watching.",
  "you", "you.", ".", "bye.", "bye", "so", "okay.", "please subscribe.",
]);
const HALLUCINATION_PATTERNS = [
  /^thanks? for (watching|listening)[.!]*$/,
  /^(please )?(like and )?subscribe[.!]*$/,
  /^subtitles? by .+$/,
  /^captions? by .+$/,
  /^captioned by .+$/,
];

export function isHallucination(text) {
  const normalized = text.toLowerCase().trim().replace(/\s+/g, " ");
  const bare = normalized.replace(/^[\s"'`.,!?-]+|[\s"'`.,!?-]+$/g, "");
  return (
    HALLUCINATIONS.has(normalized) ||
    HALLUCINATIONS.has(bare) ||
    HALLUCINATION_PATTERNS.some((pattern) => pattern.test(bare))
  );
}

function optionalProbability(value, name) {
  if (value == null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${name} must be a number between 0 and 1`);
  }
  return parsed;
}

function splitArgs(value) {
  if (!value.trim()) return [];
  if (value.trim().startsWith("[")) {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((arg) => typeof arg !== "string")) {
      throw new Error("VOICE_PR_WHISPER_ARGS JSON must be an array of strings");
    }
    return parsed;
  }

  const args = [];
  let cur = "";
  let quote = null;
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        args.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (quote) throw new Error("VOICE_PR_WHISPER_ARGS contains an unterminated quote");
  if (cur) args.push(cur);
  return args;
}

function readNoSpeechProb(segment) {
  const value =
    segment.no_speech_prob ??
    segment.noSpeechProb ??
    segment.no_speech_probability ??
    segment.noSpeechProbability;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Join transcript segments to the anchor timeline: each spoken segment inherits
 * the file/line/selection that was active when the user started saying it.
 * @param {Array} segs      transcript segments (start in seconds)
 * @param {Array} timeline  [{t (ms since rec start), file, line, endLine, snippet}]
 */
export function anchorSegments(segs, timeline = []) {
  const tl = [...timeline].sort((a, b) => a.t - b.t);
  const at = (ms) => {
    let cur = null;
    for (const e of tl) {
      if (e.t <= ms) cur = e;
      else break;
    }
    return cur;
  };
  return segs.map((s) => {
    const a = at(s.start * 1000) || tl[0] || {};
    return {
      text: s.text,
      file: a.file || null,
      line: a.line ?? null,
      endLine: a.endLine ?? null,
      snippet: a.snippet || null,
      token: a.token || null, // the symbol the user was pointing at when speaking
    };
  });
}

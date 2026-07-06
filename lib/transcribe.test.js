import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWhisperArgs,
  filterTranscriptSegments,
  isHallucination,
  whisperConfig,
} from "./transcribe.js";

test("buildWhisperArgs includes configurable no-speech threshold and extra args", () => {
  assert.deepEqual(
    buildWhisperArgs({
      model: "/models/ggml.bin",
      wav: "/tmp/in.wav",
      outPrefix: "/tmp/out",
      noSpeechThreshold: 0.35,
      extraArgs: ["--vad", "--vad-model", "/models/silero.bin"],
    }),
    [
      "-m",
      "/models/ggml.bin",
      "-f",
      "/tmp/in.wav",
      "-oj",
      "-of",
      "/tmp/out",
      "--no-speech-thold",
      "0.35",
      "--vad",
      "--vad-model",
      "/models/silero.bin",
    ]
  );
});

test("whisperConfig reads model, binary, thresholds, and quoted args", () => {
  assert.deepEqual(
    whisperConfig({
      HOME: "/Users/tester",
      VOICE_PR_WHISPER_BIN: "/opt/bin/whisper-cli",
      VOICE_PR_WHISPER_MODEL: "/models/turbo.bin",
      VOICE_PR_WHISPER_NO_SPEECH_THOLD: "0.42",
      VOICE_PR_WHISPER_MAX_NO_SPEECH_PROB: "0.9",
      VOICE_PR_WHISPER_ARGS: '--vad --vad-model "/models/silero vad.bin"',
    }),
    {
      bin: "/opt/bin/whisper-cli",
      model: "/models/turbo.bin",
      noSpeechThreshold: 0.42,
      maxNoSpeechProb: 0.9,
      extraArgs: ["--vad", "--vad-model", "/models/silero vad.bin"],
    }
  );
});

test("whisperConfig rejects invalid probability options", () => {
  assert.throws(
    () =>
      whisperConfig({
        HOME: "/Users/tester",
        VOICE_PR_WHISPER_NO_SPEECH_THOLD: "1.5",
      }),
    /VOICE_PR_WHISPER_NO_SPEECH_THOLD must be a number between 0 and 1/
  );
});

test("isHallucination stays conservative around useful speech", () => {
  assert.equal(isHallucination("Thank you."), true);
  assert.equal(isHallucination("Subtitles by Example"), true);
  assert.equal(isHallucination("you should rename this variable"), false);
  assert.equal(isHallucination("please subscribe to the error event"), false);
});

test("filterTranscriptSegments drops silence artifacts and high no-speech segments", () => {
  const filtered = filterTranscriptSegments(
    [
      { start: 0, end: 1, text: "Thank you." },
      { start: 1, end: 2, text: "[Music]" },
      { start: 2, end: 3, text: "Rename this variable", noSpeechProb: 0.2 },
      { start: 3, end: 4, text: "Update the API client", noSpeechProb: 0.95 },
    ],
    { maxNoSpeechProb: 0.9 }
  );

  assert.deepEqual(filtered, [
    { start: 2, end: 3, text: "Rename this variable", noSpeechProb: 0.2 },
  ]);
});

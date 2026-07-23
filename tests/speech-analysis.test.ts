import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeSpeech,
  cleanTranscript,
  createEmptyVoiceMetrics,
} from "../app/lib/speechAnalysis";

test("cleans filler-heavy transcript while preserving raw metrics", () => {
  const analysis = analyzeSpeech(
    "um I think remote work is like useful because people can focus focus but you know it can hurt teams",
    60,
    {
      longestSilentRunMs: 480,
      samples: [0.24, 0.3, 0.36, 0.34, 0.29, 0.4, 0.27, 0.31],
      silentFrames: 2,
      speechFrames: 8,
      trackingAvailable: true,
    },
  );

  assert.equal(analysis.totalFillers, 3);
  assert.equal(analysis.repeatedStarts.includes("focus"), true);
  assert.equal(analysis.wpm, 20);
  assert.match(analysis.cleanedTranscript, /^I think remote work is useful/);
  assert.notEqual(analysis.tone.label, "tone unavailable");
  assert.ok(analysis.suggestions.length > 0);
});

test("reports unavailable tone without microphone samples", () => {
  const analysis = analyzeSpeech("This is a short answer", 60, createEmptyVoiceMetrics());

  assert.equal(analysis.tone.label, "tone unavailable");
  assert.equal(analysis.tone.averageEnergy, 0);
});

test("removes common disfluencies from cleaned text", () => {
  assert.equal(
    cleanTranscript("I mean, this is basically a strong idea, right?"),
    "This is a strong idea?",
  );
});

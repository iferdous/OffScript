export type VoiceMetricsInput = {
  longestSilentRunMs: number;
  samples: number[];
  silentFrames: number;
  speechFrames: number;
  trackingAvailable: boolean;
};

export type ToneProfile = {
  averageEnergy: number;
  energyRange: number;
  label: string;
  pauseRatio: number;
  summary: string;
};

export type SpeechStructure = {
  averageSentenceWords: number;
  longSentenceCount: number;
  sentenceCount: number;
  tangentSignals: string[];
};

export type VocabularyProfile = {
  label: string;
  uniqueWords: number;
  varietyRatio: number;
};

export type Analysis = {
  cleanedTranscript: string;
  fillerCounts: Array<{ word: string; count: number }>;
  fillerRate: number;
  repeatedStarts: string[];
  structure: SpeechStructure;
  suggestions: string[];
  tone: ToneProfile;
  totalFillers: number;
  vocabulary: VocabularyProfile;
  wordCount: number;
  wpm: number;
};

export const FILLERS = [
  "um",
  "uh",
  "like",
  "you know",
  "i mean",
  "actually",
  "basically",
  "literally",
  "sort of",
  "kind of",
  "kinda",
  "so",
  "right",
];

const SMALL_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "for",
  "i",
  "if",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "was",
  "we",
  "with",
  "you",
]);

const TANGENT_MARKERS = [
  "anyway",
  "back to",
  "side note",
  "i forgot",
  "where was i",
  "random",
  "another thing",
  "also also",
];

export function createEmptyVoiceMetrics(): VoiceMetricsInput {
  return {
    longestSilentRunMs: 0,
    samples: [],
    silentFrames: 0,
    speechFrames: 0,
    trackingAvailable: false,
  };
}

export function countWords(text: string) {
  return tokenize(text).length;
}

export function analyzeSpeech(
  rawTranscript: string,
  durationSeconds: number,
  voiceMetrics: VoiceMetricsInput = createEmptyVoiceMetrics(),
): Analysis {
  const normalized = rawTranscript.toLowerCase();
  const fillerCounts = FILLERS.map((word) => {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const count = (normalized.match(new RegExp(`\\b${escaped}\\b`, "g")) ?? [])
      .length;
    return { word, count };
  }).filter((item) => item.count > 0);
  const totalFillers = fillerCounts.reduce((sum, item) => sum + item.count, 0);
  const wordCount = countWords(rawTranscript);
  const minutes = Math.max(durationSeconds / 60, 0.25);
  const wpm = Math.round(wordCount / minutes);
  const repeatedStarts = findRepeatedStarts(rawTranscript);
  const cleanedTranscript = cleanTranscript(rawTranscript);
  const fillerRate = wordCount > 0 ? Math.round((totalFillers / wordCount) * 100) : 0;
  const vocabulary = analyzeVocabulary(rawTranscript, wordCount);
  const structure = analyzeStructure(rawTranscript);
  const tone = analyzeTone(voiceMetrics);
  const suggestions = buildSuggestions({
    fillerCounts,
    fillerRate,
    repeatedStarts,
    structure,
    tone,
    totalFillers,
    vocabulary,
    wordCount,
    wpm,
  });

  return {
    cleanedTranscript,
    fillerCounts,
    fillerRate,
    repeatedStarts,
    structure,
    suggestions,
    tone,
    totalFillers,
    vocabulary,
    wordCount,
    wpm,
  };
}

export function cleanTranscript(rawTranscript: string) {
  let cleaned = ` ${rawTranscript.trim()} `;

  for (const filler of FILLERS) {
    const escaped = filler.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(new RegExp(`\\b${escaped}\\b[, ]*`, "gi"), "");
  }

  return cleaned
    .replace(/\s+/g, " ")
    .replace(/,\s*([.!?])/g, "$1")
    .replace(/\s+([,.!?])/g, "$1")
    .trim()
    .replace(/(^\w|[.!?]\s+\w)/g, (match) => match.toUpperCase())
    .trim();
}

function tokenize(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\w'\s-]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^['-]+|['-]+$/g, ""))
    .filter(Boolean);
}

function findRepeatedStarts(rawTranscript: string) {
  const words = tokenize(rawTranscript);
  const repeats = new Set<string>();

  for (let index = 1; index < words.length; index += 1) {
    if (words[index] === words[index - 1] && words[index].length > 2) {
      repeats.add(words[index]);
    }
  }

  return [...repeats].slice(0, 5);
}

function analyzeVocabulary(rawTranscript: string, wordCount: number): VocabularyProfile {
  const meaningfulWords = tokenize(rawTranscript).filter(
    (word) => word.length > 2 && !SMALL_WORDS.has(word),
  );
  const uniqueWords = new Set(meaningfulWords).size;
  const varietyRatio =
    wordCount > 0 ? Math.round((uniqueWords / wordCount) * 100) / 100 : 0;

  if (wordCount < 12) {
    return { label: "not enough speech yet", uniqueWords, varietyRatio };
  }

  if (varietyRatio < 0.32) {
    return { label: "repetitive", uniqueWords, varietyRatio };
  }

  if (varietyRatio > 0.58) {
    return { label: "varied", uniqueWords, varietyRatio };
  }

  return { label: "steady", uniqueWords, varietyRatio };
}

function analyzeStructure(rawTranscript: string): SpeechStructure {
  const words = tokenize(rawTranscript);
  const sentenceChunks = rawTranscript
    .split(/[.!?]+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const estimatedSentences =
    sentenceChunks.length > 0
      ? sentenceChunks
      : Array.from({ length: Math.ceil(words.length / 18) }, (_, index) =>
          words.slice(index * 18, index * 18 + 18).join(" "),
        ).filter(Boolean);
  const sentenceWordCounts = estimatedSentences.map(countWords);
  const averageSentenceWords =
    sentenceWordCounts.length > 0
      ? Math.round(
          sentenceWordCounts.reduce((sum, count) => sum + count, 0) /
            sentenceWordCounts.length,
        )
      : 0;
  const longSentenceCount = sentenceWordCounts.filter((count) => count > 32).length;
  const normalized = rawTranscript.toLowerCase();
  const tangentSignals = TANGENT_MARKERS.filter((marker) =>
    normalized.includes(marker),
  );

  return {
    averageSentenceWords,
    longSentenceCount,
    sentenceCount: estimatedSentences.length,
    tangentSignals,
  };
}

function analyzeTone(voiceMetrics: VoiceMetricsInput): ToneProfile {
  if (!voiceMetrics.trackingAvailable || voiceMetrics.samples.length < 6) {
    return {
      averageEnergy: 0,
      energyRange: 0,
      label: "tone unavailable",
      pauseRatio: 0,
      summary: "Tone needs microphone energy data. Record a round with mic access enabled.",
    };
  }

  const average =
    voiceMetrics.samples.reduce((sum, sample) => sum + sample, 0) /
    voiceMetrics.samples.length;
  const averageEnergy = Math.round(average * 100);
  const sorted = [...voiceMetrics.samples].sort((a, b) => a - b);
  const low = sorted[Math.floor(sorted.length * 0.15)] ?? 0;
  const high = sorted[Math.floor(sorted.length * 0.85)] ?? 0;
  const energyRange = Math.round((high - low) * 100);
  const pauseRatio = Math.round(
    (voiceMetrics.silentFrames /
      Math.max(voiceMetrics.silentFrames + voiceMetrics.speechFrames, 1)) *
      100,
  );

  if (averageEnergy < 18) {
    return {
      averageEnergy,
      energyRange,
      label: "held back",
      pauseRatio,
      summary: "Your voice energy reads low. Practice opening with a little more volume and breath support.",
    };
  }

  if (pauseRatio < 8) {
    return {
      averageEnergy,
      energyRange,
      label: "rushed",
      pauseRatio,
      summary: "You left very little silence. Add a half-second pause after key points so ideas can land.",
    };
  }

  if (pauseRatio > 42) {
    return {
      averageEnergy,
      energyRange,
      label: "hesitant",
      pauseRatio,
      summary: "There were many quiet gaps. Try naming your claim first, then explain it.",
    };
  }

  if (energyRange < 12) {
    return {
      averageEnergy,
      energyRange,
      label: "flat",
      pauseRatio,
      summary: "Your energy stayed very even. Add contrast by stressing the main phrase in each sentence.",
    };
  }

  return {
    averageEnergy,
    energyRange,
    label: "engaged",
    pauseRatio,
    summary: "Your voice had usable energy and enough quiet space to sound intentional.",
  };
}

function buildSuggestions({
  fillerCounts,
  fillerRate,
  repeatedStarts,
  structure,
  tone,
  totalFillers,
  vocabulary,
  wordCount,
  wpm,
}: Pick<
  Analysis,
  | "fillerCounts"
  | "fillerRate"
  | "repeatedStarts"
  | "structure"
  | "tone"
  | "totalFillers"
  | "vocabulary"
  | "wordCount"
  | "wpm"
>) {
  const suggestions: string[] = [];

  if (wordCount < 12) {
    suggestions.push(
      "Say a little more next round. Aim for one claim, one example, and one closing sentence.",
    );
  }

  if (totalFillers > 4 || fillerRate >= 8) {
    const topFiller = fillerCounts[0]?.word ?? "filler words";
    suggestions.push(
      `Your main filler was "${topFiller}". Replace it with a silent pause before continuing.`,
    );
  }

  if (wpm > 165) {
    suggestions.push(
      "Your pace was quick. Slow the first sentence down so listeners can catch the frame.",
    );
  } else if (wpm > 0 && wpm < 95) {
    suggestions.push(
      "Your pace was careful. Add a little more forward motion after each pause.",
    );
  } else if (wpm > 0) {
    suggestions.push("Your pace is in a natural speaking range. Keep that rhythm.");
  }

  if (vocabulary.label === "repetitive") {
    suggestions.push(
      "Your vocabulary repeated itself. Swap one repeated word for a more specific image or verb.",
    );
  }

  if (structure.longSentenceCount > 0 || structure.averageSentenceWords > 26) {
    suggestions.push(
      "Your sentences ran long. Break the next answer into shorter claim, proof, and takeaway beats.",
    );
  }

  if (structure.tangentSignals.length > 0) {
    suggestions.push(
      "You drifted into side paths. Use a phrase like “the point is” to return to your main claim.",
    );
  }

  if (tone.label !== "tone unavailable" && tone.label !== "engaged") {
    suggestions.push(tone.summary);
  }

  if (repeatedStarts.length > 0) {
    suggestions.push(
      `You repeated ${repeatedStarts
        .map((word) => `"${word}"`)
        .join(", ")}. Pause, then restart the sentence cleanly.`,
    );
  }

  if (suggestions.length === 0) {
    suggestions.push(
      "Strong start. For the next rep, practice landing with one memorable final sentence.",
    );
  }

  return suggestions.slice(0, 5);
}

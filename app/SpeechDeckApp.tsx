import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { TOPICS, type SpeechTopic, type TopicCategory } from "./data/topics";
import {
  createSeededRandom,
  createTopicPool,
  drawHand,
  recordLockedTopic,
  type TopicPoolState,
} from "./lib/topicEngine";

type SpeechRecognitionResultLike = {
  isFinal: boolean;
  [index: number]: { transcript: string };
};

type SpeechRecognitionEventLike = Event & {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
};

type SpeechRecognitionErrorEventLike = Event & {
  error: string;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
    webkitAudioContext?: typeof AudioContext;
  }
}

type Screen = "roll" | "practice" | "review";
type PracticeStatus = "idle" | "recording" | "paused" | "finished";

type SlotMachineState = {
  primed: boolean;
  reelOffset: number;
  sequence: SpeechTopic[];
  spinning: boolean;
  spinId: number;
  winnerId: string | null;
  winHighlight: boolean;
};

type CategoryFilter = TopicCategory | "Any";
type DifficultyFilter = SpeechTopic["difficulty"] | "Any";
type LandingFilterKey = "time" | "difficulty" | "category";

type SlotTopicRowData = {
  topic: SpeechTopic;
  dimmed: boolean;
  winning: boolean;
};

type SlotCategoryMeta = {
  label: string;
  color: string;
};

type Analysis = {
  cleanedTranscript: string;
  fillerCounts: Array<{ word: string; count: number }>;
  totalFillers: number;
  wordCount: number;
  wpm: number;
  repeatedStarts: string[];
  suggestions: string[];
};

const DEFAULT_SECONDS = 60;
const MAX_SPINS = 3;
const SLOT_ROW_HEIGHT = 56;
const SLOT_FAST_DISTANCE = 18 * SLOT_ROW_HEIGHT;
const SLOT_FINAL_OFFSET = SLOT_ROW_HEIGHT - SLOT_FAST_DISTANCE;
const SLOT_SPIN_DURATION_MS = 3400;
const SLOT_REEL_START_MS = 180;
const SLOT_WIN_HIGHLIGHT_MS = 2900;
const SLOT_CATEGORY_META: Record<TopicCategory, SlotCategoryMeta> = {
  Tech: { label: "Tech", color: "#4A7FBF" },
  Finance: { label: "Finance", color: "#4C9A6B" },
  "Hot takes": { label: "Hot takes", color: "#C15B3E" },
  Storytelling: { label: "Storytelling", color: "#B25680" },
  Debate: { label: "Debate", color: "#B8863D" },
  General: { label: "General", color: "#7B6FB0" },
};
const SLOT_CATEGORIES = Object.keys(SLOT_CATEGORY_META) as TopicCategory[];
const SLOT_DIFFICULTIES: SpeechTopic["difficulty"][] = [
  "warm-up",
  "stretch",
  "pressure",
];
const FILLERS = [
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

function formatTime(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(1, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function buildInitialPool() {
  const random = createSeededRandom(20260718);
  const pool = createTopicPool(TOPICS, random);
  return { hand: [] as SpeechTopic[], state: pool };
}

function countWords(text: string) {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function getSpeechRecognition() {
  if (typeof window === "undefined") {
    return null;
  }

  const Recognition =
    window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;

  return Recognition ? new Recognition() : null;
}

function analyzeSpeech(rawTranscript: string, durationSeconds: number): Analysis {
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
  const suggestions = buildSuggestions({
    fillerCounts,
    repeatedStarts,
    totalFillers,
    wordCount,
    wpm,
  });

  return {
    cleanedTranscript,
    fillerCounts,
    totalFillers,
    wordCount,
    wpm,
    repeatedStarts,
    suggestions,
  };
}

function cleanTranscript(rawTranscript: string) {
  let cleaned = ` ${rawTranscript.trim()} `;

  for (const filler of FILLERS) {
    const escaped = filler.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned.replace(new RegExp(`\\b${escaped}\\b[, ]*`, "gi"), "");
  }

  return cleaned
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/(^\w|[.!?]\s+\w)/g, (match) => match.toUpperCase())
    .trim();
}

function findRepeatedStarts(rawTranscript: string) {
  const words = rawTranscript
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const repeats = new Set<string>();

  for (let index = 1; index < words.length; index += 1) {
    if (words[index] === words[index - 1] && words[index].length > 2) {
      repeats.add(words[index]);
    }
  }

  return [...repeats].slice(0, 5);
}

function buildSuggestions({
  fillerCounts,
  repeatedStarts,
  totalFillers,
  wordCount,
  wpm,
}: Pick<
  Analysis,
  "fillerCounts" | "repeatedStarts" | "totalFillers" | "wordCount" | "wpm"
>) {
  const suggestions: string[] = [];

  if (wordCount < 12) {
    suggestions.push(
      "Say a little more next round. Aim for one claim, one example, and one closing sentence.",
    );
  }

  if (totalFillers > 4) {
    const topFiller = fillerCounts[0]?.word ?? "filler words";
    suggestions.push(
      `Your main filler was "${topFiller}". Try replacing that sound with a full silent pause.`,
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

  return suggestions.slice(0, 4);
}

function playCue(
  kind: "click" | "tick" | "orbit" | "land" | "start" | "finish",
  muted = false,
) {
  if (typeof window === "undefined" || muted) {
    return;
  }

  const AudioContext =
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;

  if (!AudioContext) {
    return;
  }

  const context = new AudioContext();
  const now = context.currentTime;
  const master = context.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(kind === "orbit" ? 0.035 : 0.055, now + 0.01);
  master.gain.exponentialRampToValueAtTime(0.0001, now + (kind === "orbit" ? 0.8 : 0.4));
  master.connect(context.destination);

  const hits =
    kind === "orbit"
      ? [
          { at: 0, freq: 110 },
          { at: 0.18, freq: 132 },
          { at: 0.36, freq: 118 },
        ]
      : kind === "land"
        ? [
            { at: 0, freq: 74 },
            { at: 0.08, freq: 48 },
          ]
        : kind === "tick"
          ? [{ at: 0, freq: 980 }]
          : kind === "click"
            ? [
                { at: 0, freq: 160 },
                { at: 0.035, freq: 80 },
              ]
        : kind === "start"
          ? [{ at: 0, freq: 440 }]
          : [{ at: 0, freq: 220 }];

  for (const hit of hits) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = kind === "orbit" || kind === "land" || kind === "click" ? "triangle" : "sine";
    oscillator.frequency.setValueAtTime(hit.freq, now + hit.at);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(32, hit.freq * 0.55),
      now + hit.at + (kind === "tick" ? 0.04 : 0.16),
    );
    gain.gain.setValueAtTime(0.0001, now + hit.at);
    gain.gain.exponentialRampToValueAtTime(kind === "tick" ? 0.12 : 0.36, now + hit.at + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + hit.at + (kind === "tick" ? 0.055 : 0.19));
    oscillator.connect(gain);
    gain.connect(master);
    oscillator.start(now + hit.at);
    oscillator.stop(now + hit.at + (kind === "tick" ? 0.07 : 0.22));
  }

  window.setTimeout(() => void context.close(), kind === "orbit" ? 900 : 500);
}

function playSlotWhir(muted: boolean) {
  if (typeof window === "undefined" || muted) {
    return;
  }

  const AudioContext =
    window.AudioContext ??
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;

  if (!AudioContext) {
    return;
  }

  const context = new AudioContext();
  const now = context.currentTime;
  const master = context.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(0.11, now + 0.04);
  master.gain.setValueAtTime(0.11, now + 2.44);
  master.gain.exponentialRampToValueAtTime(0.0001, now + 2.6);
  master.connect(context.destination);

  const oscillator = context.createOscillator();
  const tick = context.createOscillator();
  const tickGain = context.createGain();

  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(118, now);
  oscillator.frequency.exponentialRampToValueAtTime(72, now + 2.6);
  oscillator.connect(master);
  oscillator.start(now);
  oscillator.stop(now + 2.6);

  tick.type = "square";
  tick.frequency.setValueAtTime(26, now);
  tick.frequency.exponentialRampToValueAtTime(12, now + 2.6);
  tickGain.gain.setValueAtTime(0.025, now);
  tick.connect(tickGain);
  tickGain.connect(master);
  tick.start(now);
  tick.stop(now + 2.6);

  window.setTimeout(() => void context.close(), 2700);
}

function getEligibleTopics(
  categoryFilter: CategoryFilter,
  difficultyFilter: DifficultyFilter,
) {
  const eligibleTopics = TOPICS.filter((topic) => {
    const categoryMatches =
      categoryFilter === "Any" || topic.category === categoryFilter;
    const difficultyMatches =
      difficultyFilter === "Any" || topic.difficulty === difficultyFilter;
    return categoryMatches && difficultyMatches;
  });

  return eligibleTopics.length > 0 ? eligibleTopics : TOPICS;
}

function pickRandomTopic(topics: SpeechTopic[], exceptId?: string | null) {
  const choices = topics.filter((topic) => topic.id !== exceptId);
  const source = choices.length > 0 ? choices : topics;
  return source[Math.floor(Math.random() * source.length)] ?? TOPICS[0];
}

function buildSlotSequence(
  winner: SpeechTopic | null,
  topics: SpeechTopic[] = TOPICS,
) {
  const winningTopic = winner ?? topics[0] ?? TOPICS[0];
  const sequence = Array.from({ length: 18 }, (_, index) =>
    index === 17 ? winningTopic : pickRandomTopic(topics, winningTopic.id),
  );
  const topBuffer = pickRandomTopic(topics, winningTopic.id);
  const bottomBuffer = pickRandomTopic(topics, winningTopic.id);

  return [topBuffer, ...sequence, bottomBuffer];
}

export function SpeechDeckApp() {
  const initialDraw = useMemo(buildInitialPool, []);
  const [screen, setScreen] = useState<Screen>("roll");
  const [pool, setPool] = useState<TopicPoolState>(initialDraw.state);
  const [activeTopic, setActiveTopic] = useState<SpeechTopic | null>(null);
  const [hasRolled, setHasRolled] = useState(false);
  const [slotOpen, setSlotOpen] = useState(false);
  const [slot, setSlot] = useState<SlotMachineState>({
    primed: false,
    reelOffset: 0,
    sequence: buildSlotSequence(TOPICS[0] ?? null, TOPICS),
    spinning: false,
    spinId: 0,
    winnerId: null,
    winHighlight: false,
  });
  const [spinsLeft, setSpinsLeft] = useState(MAX_SPINS);
  const [muted, setMuted] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("Any");
  const [difficultyFilter, setDifficultyFilter] = useState<DifficultyFilter>("Any");
  const [duration, setDuration] = useState(DEFAULT_SECONDS);
  const [remaining, setRemaining] = useState(DEFAULT_SECONDS);
  const [status, setStatus] = useState<PracticeStatus>("idle");
  const [finalTranscript, setFinalTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [manualTranscript, setManualTranscript] = useState("");
  const [speechError, setSpeechError] = useState("");
  const rawTranscript = [finalTranscript, interimTranscript, manualTranscript]
    .filter(Boolean)
    .join(" ")
    .trim();
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const statusRef = useRef(status);
  const remainingRef = useRef(remaining);
  const transcriptRef = useRef(rawTranscript);
  const progress = duration > 0 ? (duration - remaining) / duration : 0;
  const analysis = useMemo(
    () => analyzeSpeech(rawTranscript, duration),
    [duration, rawTranscript],
  );

  useEffect(() => {
    statusRef.current = status;
    remainingRef.current = remaining;
    transcriptRef.current = rawTranscript;
  }, [rawTranscript, remaining, status]);

  useEffect(() => {
    if (status !== "recording") {
      return;
    }

    const timer = window.setInterval(() => {
      setRemaining((current) => {
        if (current <= 1) {
          window.clearInterval(timer);
          finishPractice();
          return 0;
        }

        return current - 1;
      });
    }, 1000);

    return () => window.clearInterval(timer);
  }, [status]);

  function spinSlot() {
    if (slot.primed || slot.spinning || spinsLeft <= 0) {
      return;
    }

    playCue("click", muted);
    playSlotWhir(muted);
    const eligibleTopics = getEligibleTopics(categoryFilter, difficultyFilter);
    const result = drawHand(pool, eligibleTopics, { size: 1 });
    const chosenTopic = result.hand[0] ?? eligibleTopics[0] ?? TOPICS[0];
    const nextSequence = buildSlotSequence(chosenTopic, eligibleTopics);

    setSlot((current) => ({
      ...current,
      primed: true,
      reelOffset: SLOT_ROW_HEIGHT,
      sequence: nextSequence,
      winnerId: chosenTopic.id,
      winHighlight: false,
      spinId: current.spinId + 1,
    }));
    setHasRolled(false);
    setSpinsLeft((current) => Math.max(0, current - 1));

    window.setTimeout(() => {
      setSlot((current) => ({
        ...current,
        primed: false,
        reelOffset: SLOT_FINAL_OFFSET,
        spinning: true,
      }));
    }, SLOT_REEL_START_MS);

    window.setTimeout(() => {
      setSlot((current) => ({
        ...current,
        winHighlight: true,
      }));
      playCue("land", muted);
    }, SLOT_WIN_HIGHLIGHT_MS);

    window.setTimeout(() => {
      setPool(recordLockedTopic(result.state, chosenTopic));
      setActiveTopic(chosenTopic);
      setRemaining(duration);
      setSlot((current) => ({
        ...current,
        reelOffset: SLOT_FINAL_OFFSET,
        spinning: false,
        winHighlight: false,
      }));
      setHasRolled(true);
    }, SLOT_SPIN_DURATION_MS);
  }

  function startPractice() {
    if (!activeTopic) {
      spinSlot();
      return;
    }

    playCue("start", muted);
    setScreen("practice");
    setStatus("recording");
    setRemaining(duration);
    setFinalTranscript("");
    setInterimTranscript("");
    setManualTranscript("");
    setSpeechError("");

    const recognition = getSpeechRecognition();
    recognitionRef.current = recognition;

    if (!recognition) {
      setSpeechError(
        "Live browser transcription is not available here. Type what you said in the notes box while the timer runs.",
      );
      return;
    }

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      let finalText = "";
      let interimText = "";

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result[0]?.transcript ?? "";

        if (result.isFinal) {
          finalText += `${transcript} `;
        } else {
          interimText += transcript;
        }
      }

      if (finalText) {
        setFinalTranscript((current) => `${current} ${finalText}`.trim());
      }

      setInterimTranscript(interimText);
    };
    recognition.onerror = (event) => {
      setSpeechError(
        event.error === "not-allowed"
          ? "Microphone permission was blocked. You can still paste or type the transcript below."
          : "Transcription paused. You can keep speaking or use the notes box.",
      );
    };
    recognition.onend = () => {
      if (statusRef.current === "recording" && remainingRef.current > 0) {
        try {
          recognition.start();
        } catch {
          // Some browsers briefly reject restart calls while closing the old session.
        }
      }
    };

    try {
      recognition.start();
    } catch {
      setSpeechError("The microphone could not start. You can type the transcript below.");
    }

    window.setTimeout(() => {
      if (statusRef.current === "recording" && !transcriptRef.current) {
        setSpeechError(
          "Still listening, but no words have come back yet. Keep speaking clearly or type the raw transcript below.",
        );
      }
    }, 6000);
  }

  function pausePractice() {
    setStatus("paused");
    recognitionRef.current?.stop();
  }

  function resumePractice() {
    setStatus("recording");
    try {
      recognitionRef.current?.start();
    } catch {
      setSpeechError("Transcription could not resume. Keep typing in the notes box.");
    }
  }

  function finishPractice() {
    playCue("finish", muted);
    setStatus("finished");
    recognitionRef.current?.stop();
    setScreen("review");
  }

  function resetPractice() {
    recognitionRef.current?.stop();
    setScreen("roll");
    setStatus("idle");
    setRemaining(duration);
    setFinalTranscript("");
    setInterimTranscript("");
    setManualTranscript("");
    setSpeechError("");
  }

  return (
    <main className="app-shell">
      {screen === "roll" ? (
        <RollScreen
          activeTopic={activeTopic}
          categoryFilter={categoryFilter}
          difficultyFilter={difficultyFilter}
          duration={duration}
          hasRolled={hasRolled}
          muted={muted}
          onCategoryFilterChange={setCategoryFilter}
          onCloseSlot={() => setSlotOpen(false)}
          onDifficultyFilterChange={setDifficultyFilter}
          onDurationChange={(nextDuration) => {
            setDuration(nextDuration);
            setRemaining(nextDuration);
          }}
          onOpenSlot={() => setSlotOpen(true)}
          onSpin={spinSlot}
          onStart={startPractice}
          onToggleMute={() => setMuted((current) => !current)}
          slot={slot}
          slotOpen={slotOpen}
          spinsLeft={spinsLeft}
        />
      ) : null}

      {screen === "practice" ? (
        <PracticeScreen
          activeTopic={activeTopic as SpeechTopic}
          duration={duration}
          manualTranscript={manualTranscript}
          onBack={resetPractice}
          onFinish={finishPractice}
          onManualTranscript={setManualTranscript}
          onPause={pausePractice}
          onResume={resumePractice}
          progress={progress}
          rawTranscript={rawTranscript}
          remaining={remaining}
          setDuration={(nextDuration) => {
            const difference = nextDuration - duration;
            setDuration(nextDuration);
            setRemaining((current) => Math.max(15, current + difference));
          }}
          speechError={speechError}
          status={status}
        />
      ) : null}

      {screen === "review" ? (
        <ReviewScreen
          activeTopic={activeTopic as SpeechTopic}
          analysis={analysis}
          duration={duration}
          onNewSpin={resetPractice}
          onRetry={() => {
            setScreen("practice");
            setStatus("idle");
            setRemaining(duration);
            setFinalTranscript("");
            setInterimTranscript("");
            setManualTranscript("");
          }}
          rawTranscript={rawTranscript}
        />
      ) : null}
    </main>
  );
}

function RollScreen({
  activeTopic,
  categoryFilter,
  difficultyFilter,
  duration,
  hasRolled,
  muted,
  onCategoryFilterChange,
  onCloseSlot,
  onDifficultyFilterChange,
  onDurationChange,
  onOpenSlot,
  onSpin,
  onStart,
  onToggleMute,
  slot,
  slotOpen,
  spinsLeft,
}: {
  activeTopic: SpeechTopic | null;
  categoryFilter: CategoryFilter;
  difficultyFilter: DifficultyFilter;
  duration: number;
  hasRolled: boolean;
  muted: boolean;
  onCategoryFilterChange: (category: CategoryFilter) => void;
  onCloseSlot: () => void;
  onDifficultyFilterChange: (difficulty: DifficultyFilter) => void;
  onDurationChange: (duration: number) => void;
  onOpenSlot: () => void;
  onSpin: () => void;
  onStart: () => void;
  onToggleMute: () => void;
  slot: SlotMachineState;
  slotOpen: boolean;
  spinsLeft: number;
}) {
  const [openFilter, setOpenFilter] = useState<LandingFilterKey | null>(null);
  const timeOptions = [
    { label: "0:30", value: 30 },
    { label: "1:00", value: 60 },
    { label: "1:30", value: 90 },
    { label: "2:00", value: 120 },
    { label: "3:00", value: 180 },
  ];
  const difficultyOptions: Array<{ label: string; value: DifficultyFilter }> = [
    { label: "Any difficulty", value: "Any" },
    ...SLOT_DIFFICULTIES.map((difficulty) => ({
      label: difficulty,
      value: difficulty,
    })),
  ];
  const categoryOptions: Array<{ label: string; value: CategoryFilter }> = [
    { label: "Any category", value: "Any" },
    ...SLOT_CATEGORIES.map((category) => ({
      label: SLOT_CATEGORY_META[category].label,
      value: category,
    })),
  ];

  return (
    <section className="welcome-screen" aria-label="Offscript topic practice">
      <header className="top-bar">
        <nav className="mode-nav" aria-label="Practice modes">
          <span className="mode-label">Random Topics</span>
          <span className="mode-label mode-label-disabled">Interview Prep</span>
          <span className="mode-label mode-label-disabled">Learn Vocab</span>
        </nav>
      </header>

      <section className="landing-grid">
        <div className="landing-copy">
          <p className="wordmark">Offscript</p>
          <h1>Walk in with foggy thoughts. Walk out clearer.</h1>
          <p>
            Pull the lever for an unrehearsed topic. Set your speaking window,
            then talk it out: no notes, no script, no do-overs.
          </p>
          <div className="landing-filters" aria-label="Topic setup filters">
            <LandingFilterMenu
              icon="⏱"
              id="time"
              isOpen={openFilter === "time"}
              label="Speaking time"
              onToggle={() =>
                setOpenFilter((current) => (current === "time" ? null : "time"))
              }
              options={timeOptions}
              selectedValue={duration}
              onSelect={(value) => {
                onDurationChange(value);
                setOpenFilter(null);
              }}
            />
            <LandingFilterMenu
              icon="●"
              id="difficulty"
              isOpen={openFilter === "difficulty"}
              label="Topic difficulty"
              onToggle={() =>
                setOpenFilter((current) =>
                  current === "difficulty" ? null : "difficulty",
                )
              }
              options={difficultyOptions}
              selectedValue={difficultyFilter}
              onSelect={(value) => {
                onDifficultyFilterChange(value);
                setOpenFilter(null);
              }}
            />
            <LandingFilterMenu
              icon="◎"
              id="category"
              isOpen={openFilter === "category"}
              label="Topic category"
              onToggle={() =>
                setOpenFilter((current) =>
                  current === "category" ? null : "category",
                )
              }
              options={categoryOptions}
              selectedValue={categoryFilter}
              onSelect={(value) => {
                onCategoryFilterChange(value);
                setOpenFilter(null);
              }}
            />
          </div>
          <div className="main-actions">
            <button className="primary-pill" type="button" onClick={onOpenSlot}>
              Pull a topic
            </button>
            {activeTopic ? (
              <button className="secondary-pill" type="button" onClick={onStart}>
                Start timer →
              </button>
            ) : null}
          </div>
        </div>
        <button className="slot-preview" type="button" onClick={onOpenSlot}>
          <span className="preview-marquee">OFFSCRIPT</span>
          <span className="preview-reel">
            <span>{activeTopic ? activeTopic.prompt : "Pull for topic"}</span>
          </span>
          <span className="preview-tray" aria-hidden="true">
            {Array.from({ length: MAX_SPINS }, (_, index) => (
              <span data-filled={index < spinsLeft ? "true" : "false"} key={index} />
            ))}
          </span>
          <span className="preview-lever" aria-hidden="true" />
        </button>
      </section>

      {slotOpen ? (
        <section
          className="slot-overlay"
          aria-label="Topic slot machine fullscreen"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              onCloseSlot();
            }
          }}
        >
          <button
            className="corner-exit corner-exit-left"
            type="button"
            onClick={onCloseSlot}
            aria-label="Close topic slot"
          />
          <button
            className="corner-exit corner-exit-right"
            type="button"
            onClick={onCloseSlot}
            aria-label="Close topic slot"
          />

          <div className="slot-scroll-stage">
            <SlotMachine
              muted={muted}
              onSpin={onSpin}
              onToggleMute={onToggleMute}
              slot={slot}
              spinsLeft={spinsLeft}
            />

            <div className="slot-controls" aria-label="Slot machine controls">
              <label className="slot-pill-control">
                Time
                <select
                  value={duration}
                  onChange={(event) => onDurationChange(Number(event.target.value))}
                >
                  <option value={30}>0:30</option>
                  <option value={60}>1:00</option>
                  <option value={90}>1:30</option>
                  <option value={120}>2:00</option>
                  <option value={180}>3:00</option>
                </select>
              </label>
              <label className="slot-pill-control">
                Difficulty
                <select
                  value={difficultyFilter}
                  onChange={(event) =>
                    onDifficultyFilterChange(event.target.value as DifficultyFilter)
                  }
                >
                  <option value="Any">Any</option>
                  {SLOT_DIFFICULTIES.map((difficulty) => (
                    <option key={difficulty} value={difficulty}>
                      {difficulty}
                    </option>
                  ))}
                </select>
              </label>
              <label className="slot-pill-control">
                Category
                <select
                  value={categoryFilter}
                  onChange={(event) =>
                    onCategoryFilterChange(event.target.value as CategoryFilter)
                  }
                >
                  <option value="Any">Any</option>
                  {SLOT_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {SLOT_CATEGORY_META[category].label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {hasRolled && activeTopic && !slot.spinning ? (
              <section className="slot-topic-reveal" aria-live="polite">
                <p>{activeTopic.category}</p>
                <h1>{activeTopic.prompt}</h1>
                <span>{activeTopic.trains}</span>
                <button className="primary-pill" type="button" onClick={onStart}>
                  Start timer →
                </button>
              </section>
            ) : null}
          </div>
        </section>
      ) : null}
    </section>
  );
}

function LandingFilterMenu<TValue extends string | number>({
  icon,
  id,
  isOpen,
  label,
  onSelect,
  onToggle,
  options,
  selectedValue,
}: {
  icon: string;
  id: LandingFilterKey;
  isOpen: boolean;
  label: string;
  onSelect: (value: TValue) => void;
  onToggle: () => void;
  options: Array<{ label: string; value: TValue }>;
  selectedValue: TValue;
}) {
  const selectedOption =
    options.find((option) => option.value === selectedValue) ?? options[0];
  const menuId = `landing-${id}-menu`;

  return (
    <div className="landing-filter-menu">
      <button
        aria-expanded={isOpen}
        aria-controls={menuId}
        aria-label={label}
        className="landing-filter-pill"
        type="button"
        onClick={onToggle}
      >
        <span aria-hidden="true">{icon}</span>
        <strong>{selectedOption?.label}</strong>
      </button>
      {isOpen ? (
        <div className="landing-filter-popover" id={menuId} role="menu">
          {options.map((option) => (
            <button
              className="landing-filter-option"
              data-selected={option.value === selectedValue ? "true" : "false"}
              key={`${id}-${option.value}`}
              onClick={() => onSelect(option.value)}
              role="menuitemradio"
              type="button"
              aria-checked={option.value === selectedValue}
            >
              <span aria-hidden="true">{icon}</span>
              <strong>{option.label}</strong>
              <small aria-hidden="true">✓</small>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SlotMachine({
  muted,
  onSpin,
  onToggleMute,
  slot,
  spinsLeft,
}: {
  muted: boolean;
  onSpin: () => void;
  onToggleMute: () => void;
  slot: SlotMachineState;
  spinsLeft: number;
}) {
  const disabled = slot.primed || slot.spinning || spinsLeft <= 0;
  const isIdle = !slot.winnerId && !slot.primed && !slot.spinning;
  const rows = slot.sequence.map((topic, index) => {
    const centerIndex = slot.winnerId ? 18 : 1;
    return {
      topic,
      dimmed: index !== centerIndex,
      winning: slot.winHighlight && topic.id === slot.winnerId,
    };
  });

  return (
    <section className="slot-cabinet" aria-label="Slot machine topic reveal">
      <div className="cabinet-trim" aria-hidden="true" />
      <header className="slot-marquee">
        <button
          className="speaker-toggle"
          type="button"
          onClick={onToggleMute}
          aria-label={muted ? "Turn sound on" : "Turn sound off"}
        >
          {muted ? "×" : "♪"}
        </button>
        <strong>OFFSCRIPT</strong>
        <span className="marquee-rivet marquee-rivet-left" aria-hidden="true" />
        <span className="marquee-rivet marquee-rivet-right" aria-hidden="true" />
        <span className="marquee-rivet marquee-rivet-bottom-left" aria-hidden="true" />
        <span className="marquee-rivet marquee-rivet-bottom-right" aria-hidden="true" />
      </header>

      <section className="reel-window" aria-label="Topic reel">
        {isIdle ? (
          <p className="reel-idle">Pull for topic</p>
        ) : (
          <>
            <div className="payline" data-win={slot.winHighlight ? "true" : "false"}>
              <span aria-hidden="true" />
            </div>
            <div
              className="reel-list"
              data-spinning={slot.spinning ? "true" : "false"}
              key={slot.spinId}
              style={
                {
                  "--reel-offset": `${slot.reelOffset}px`,
                  "--final-offset": `${SLOT_FINAL_OFFSET}px`,
                } as CSSProperties
              }
            >
              {rows.map((row, index) => (
                <SlotTopicRow
                  key={`${slot.spinId}-${row.topic.id}-${index}`}
                  row={row}
                />
              ))}
            </div>
          </>
        )}
      </section>

      <section className="coin-tray" aria-label={`${spinsLeft} spins left`}>
        <p>Spins</p>
        <span className="tray-coins">
          {Array.from({ length: MAX_SPINS }, (_, index) => (
            <span data-filled={index < spinsLeft ? "true" : "false"} key={index} />
          ))}
        </span>
      </section>

      <button
        className="slot-lever"
        data-pulled={slot.primed ? "true" : "false"}
        disabled={disabled}
        onClick={onSpin}
        type="button"
        aria-label="Pull lever to reveal topic"
      >
        <span className="lever-mount" aria-hidden="true" />
        <span aria-hidden="true" />
      </button>

      <div className="bottom-plinth" aria-hidden="true" />
    </section>
  );
}

function SlotTopicRow({ row }: { row: SlotTopicRowData }) {
  const meta = SLOT_CATEGORY_META[row.topic.category];

  return (
    <div
      className="slot-topic-row"
      data-dimmed={row.dimmed ? "true" : "false"}
      data-winning={row.winning ? "true" : "false"}
    >
      <span
        className="slot-category-dot"
        style={{ "--category-color": meta.color } as CSSProperties}
        aria-hidden="true"
      />
      <span>{row.topic.prompt}</span>
    </div>
  );
}

function PracticeScreen({
  activeTopic,
  duration,
  manualTranscript,
  onBack,
  onFinish,
  onManualTranscript,
  onPause,
  onResume,
  progress,
  rawTranscript,
  remaining,
  setDuration,
  speechError,
  status,
}: {
  activeTopic: SpeechTopic;
  duration: number;
  manualTranscript: string;
  onBack: () => void;
  onFinish: () => void;
  onManualTranscript: (value: string) => void;
  onPause: () => void;
  onResume: () => void;
  progress: number;
  rawTranscript: string;
  remaining: number;
  setDuration: (duration: number) => void;
  speechError: string;
  status: PracticeStatus;
}) {
  return (
    <section className="practice-screen" aria-label="Timed speaking practice">
      <button className="back-link" type="button" onClick={onBack}>
        ← Back
      </button>
      <button className="floating-analysis" type="button" onClick={onFinish}>
        Analyze
      </button>

      <div className="practice-topic">
        <p>Topic:</p>
        <h1>{activeTopic.prompt}</h1>
      </div>

      <div
        className="timer-circle"
        data-live={status === "recording" ? "true" : "false"}
        style={{ "--progress": progress } as CSSProperties}
      >
        <div>
          <strong>{formatTime(remaining)}</strong>
          <div className="time-adjust">
            <button
              className="secondary-pill small"
              type="button"
              onClick={() => setDuration(Math.max(30, duration - 30))}
            >
              −0:30
            </button>
            <button
              className="secondary-pill small"
              type="button"
              onClick={() => setDuration(duration + 30)}
            >
              +0:30
            </button>
          </div>
        </div>
      </div>

      <div className="practice-controls">
        {status === "recording" ? (
          <button className="round-control" type="button" onClick={onPause}>
            pause
          </button>
        ) : (
          <button className="round-control live" type="button" onClick={onResume}>
            speak
          </button>
        )}
        <button className="secondary-pill" type="button" onClick={onFinish}>
          Finish & review
        </button>
      </div>

      <section className="transcript-panel" aria-label="Live transcript">
        <div>
          <p className="panel-kicker">Live transcript</p>
          <p className="transcript-text">
            {rawTranscript ||
              "Start speaking. Your raw words, including filler words, will collect here as the browser returns text."}
          </p>
          {speechError ? <p className="speech-error">{speechError}</p> : null}
        </div>
        <textarea
          aria-label="Manual transcript fallback"
          placeholder="If browser transcription is unavailable, type or paste what you said here."
          value={manualTranscript}
          onChange={(event) => onManualTranscript(event.target.value)}
        />
      </section>
    </section>
  );
}

function ReviewScreen({
  activeTopic,
  analysis,
  duration,
  onNewSpin,
  onRetry,
  rawTranscript,
}: {
  activeTopic: SpeechTopic;
  analysis: Analysis;
  duration: number;
  onNewSpin: () => void;
  onRetry: () => void;
  rawTranscript: string;
}) {
  return (
    <section className="review-screen" aria-label="Speech feedback">
      <header className="review-header">
        <div>
          <p className="tiny-wordmark">Offscript</p>
          <h1>Here’s what your speech sounded like.</h1>
        </div>
        <div className="review-actions">
          <button className="secondary-pill" type="button" onClick={onRetry}>
            Try same topic
          </button>
          <button className="primary-pill" type="button" onClick={onNewSpin}>
            Pull again
          </button>
        </div>
      </header>

      <p className="review-topic">{activeTopic.prompt}</p>

      <div className="score-row">
        <div>
          <span>{analysis.totalFillers}</span>
          <p>filler words</p>
        </div>
        <div>
          <span>{analysis.wpm}</span>
          <p>words per minute</p>
        </div>
        <div>
          <span>{analysis.wordCount}</span>
          <p>total words in {formatTime(duration)}</p>
        </div>
      </div>

      <div className="review-grid">
        <article className="review-block">
          <p className="panel-kicker">Raw version</p>
          <p>{rawTranscript || "No transcript captured yet."}</p>
        </article>
        <article className="review-block">
          <p className="panel-kicker">Cleaned version</p>
          <p>
            {analysis.cleanedTranscript ||
              "Once you record or type a transcript, the cleaned version appears here."}
          </p>
        </article>
        <article className="review-block">
          <p className="panel-kicker">Filler words</p>
          {analysis.fillerCounts.length > 0 ? (
            <ul className="filler-list">
              {analysis.fillerCounts.map((item) => (
                <li key={item.word}>
                  <span>{item.word}</span>
                  <strong>{item.count}</strong>
                </li>
              ))}
            </ul>
          ) : (
            <p>No tracked filler words found.</p>
          )}
        </article>
        <article className="review-block">
          <p className="panel-kicker">What to work on</p>
          <ul className="suggestion-list">
            {analysis.suggestions.map((suggestion) => (
              <li key={suggestion}>{suggestion}</li>
            ))}
          </ul>
        </article>
      </div>
    </section>
  );
}

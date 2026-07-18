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

type WheelState = {
  ballRotation: number;
  rotation: number;
  selectedCategory: TopicCategory | null;
  spinning: boolean;
  spinId: number;
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
const MAX_SPINS = 5;
const SPIN_DURATION_MS = 3200;
const WHEEL_CATEGORIES: Array<{
  category: TopicCategory;
  color: string;
  short: string;
}> = [
  { category: "Culture", color: "#D9A356", short: "Cul" },
  { category: "Music", color: "#B8A6E8", short: "Mus" },
  { category: "Identity", color: "#E08F76", short: "Id" },
  { category: "Work", color: "#6D93B8", short: "Work" },
  { category: "Opinion", color: "#B85F5B", short: "Take" },
  { category: "Abstract", color: "#8F7CCB", short: "Abs" },
  { category: "Story", color: "#D1B15E", short: "Story" },
  { category: "Community", color: "#6DAA82", short: "Comm" },
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

function normalizeDegrees(degrees: number) {
  return ((degrees % 360) + 360) % 360;
}

function getCategoryIndex(category: TopicCategory) {
  return Math.max(
    0,
    WHEEL_CATEGORIES.findIndex((item) => item.category === category),
  );
}

function getTargetRotation({
  currentRotation,
  targetIndex,
}: {
  currentRotation: number;
  targetIndex: number;
}) {
  const sliceAngle = 360 / WHEEL_CATEGORIES.length;
  const sliceCenter = targetIndex * sliceAngle + sliceAngle / 2;
  const desiredRotation = normalizeDegrees(360 - sliceCenter);
  const current = normalizeDegrees(currentRotation);
  const delta = normalizeDegrees(desiredRotation - current);
  const fullTurns = 6 + Math.floor(Math.random() * 3);

  return currentRotation + fullTurns * 360 + delta;
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

function playCue(kind: "roll" | "land" | "start" | "finish") {
  if (typeof window === "undefined") {
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
  master.gain.exponentialRampToValueAtTime(kind === "roll" ? 0.16 : 0.1, now + 0.01);
  master.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
  master.connect(context.destination);

  const hits =
    kind === "roll"
      ? [
          { at: 0, freq: 92 },
          { at: 0.08, freq: 118 },
          { at: 0.18, freq: 76 },
          { at: 0.31, freq: 104 },
        ]
      : kind === "land"
        ? [
            { at: 0, freq: 72 },
            { at: 0.09, freq: 58 },
          ]
        : kind === "start"
          ? [{ at: 0, freq: 440 }]
          : [{ at: 0, freq: 220 }];

  for (const hit of hits) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = kind === "roll" || kind === "land" ? "triangle" : "sine";
    oscillator.frequency.setValueAtTime(hit.freq, now + hit.at);
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(32, hit.freq * 0.55),
      now + hit.at + 0.16,
    );
    gain.gain.setValueAtTime(0.0001, now + hit.at);
    gain.gain.exponentialRampToValueAtTime(0.9, now + hit.at + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + hit.at + 0.19);
    oscillator.connect(gain);
    gain.connect(master);
    oscillator.start(now + hit.at);
    oscillator.stop(now + hit.at + 0.22);
  }

  window.setTimeout(() => void context.close(), 700);
}

export function SpeechDeckApp() {
  const initialDraw = useMemo(buildInitialPool, []);
  const [screen, setScreen] = useState<Screen>("roll");
  const [pool, setPool] = useState<TopicPoolState>(initialDraw.state);
  const [topics, setTopics] = useState<SpeechTopic[]>(initialDraw.hand);
  const [activeTopic, setActiveTopic] = useState<SpeechTopic | null>(null);
  const [hasRolled, setHasRolled] = useState(false);
  const [wheel, setWheel] = useState<WheelState>({
    ballRotation: 0,
    rotation: 0,
    selectedCategory: null,
    spinning: false,
    spinId: 0,
  });
  const [spinsLeft, setSpinsLeft] = useState(MAX_SPINS);
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

  function spinWheel() {
    if (wheel.spinning || spinsLeft <= 0) {
      return;
    }

    playCue("roll");
    const result = drawHand(pool, TOPICS, { size: 1 });
    const chosenTopic = result.hand[0] ?? TOPICS[0];
    const targetIndex = getCategoryIndex(chosenTopic.category);
    const rotation = getTargetRotation({
      currentRotation: wheel.rotation,
      targetIndex,
    });
    const sliceAngle = 360 / WHEEL_CATEGORIES.length;
    const ballRotation = rotation * -0.72 + targetIndex * sliceAngle + 900;

    setWheel((current) => ({
      ballRotation,
      rotation,
      selectedCategory: chosenTopic.category,
      spinning: true,
      spinId: current.spinId + 1,
    }));
    setSpinsLeft((current) => Math.max(0, current - 1));

    window.setTimeout(() => {
      setPool(recordLockedTopic(result.state, chosenTopic));
      setTopics(result.hand);
      setActiveTopic(chosenTopic);
      setHasRolled(true);
      setRemaining(duration);
      setWheel((current) => ({
        ...current,
        ballRotation: 0,
        spinning: false,
      }));
      playCue("land");
    }, SPIN_DURATION_MS);
  }

  function startPractice() {
    if (!activeTopic) {
      spinWheel();
      return;
    }

    playCue("start");
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
    playCue("finish");
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
          duration={duration}
          hasRolled={hasRolled}
          onDurationChange={(nextDuration) => {
            setDuration(nextDuration);
            setRemaining(nextDuration);
          }}
          onSpin={spinWheel}
          onStart={startPractice}
          spinsLeft={spinsLeft}
          topics={topics}
          wheel={wheel}
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
  duration,
  hasRolled,
  onDurationChange,
  onSpin,
  onStart,
  spinsLeft,
  topics,
  wheel,
}: {
  activeTopic: SpeechTopic | null;
  duration: number;
  hasRolled: boolean;
  onDurationChange: (duration: number) => void;
  onSpin: () => void;
  onStart: () => void;
  spinsLeft: number;
  topics: SpeechTopic[];
  wheel: WheelState;
}) {
  const ghostTopic =
    activeTopic && topics.find((topic) => topic.id !== activeTopic.id)
      ? topics.find((topic) => topic.id !== activeTopic.id)
      : null;

  return (
    <section className="welcome-screen" aria-label="Topic spin">
      <header className="top-bar">
        <p className="mode-label">Random Topics</p>
      </header>

      <section className="hero-layout">
        <div className="hero-copy">
          <p className="eyebrow">practice without a script</p>
          <h1 className="brand-mark">Offscript</h1>
          <p className="brand-copy">
            A speaking drill that makes the prompt feel like a scene: spin,
            commit, speak, then see the words you actually used.
          </p>
          <button className="primary-pill analysis-cta" type="button" onClick={onStart}>
            {hasRolled ? "Start speaking" : "Spin first"}
          </button>
        </div>

        <div className="topic-area">
          <div className="soft-controls" aria-label="Session settings">
            <label className="mini-pill">
              Time
              <select
                value={duration}
                onChange={(event) => onDurationChange(Number(event.target.value))}
              >
                <option value={30}>0:30</option>
                <option value={60}>1:00</option>
                <option value={90}>1:30</option>
                <option value={120}>2:00</option>
              </select>
            </label>
            <span className="mini-pill">Improvisation</span>
          </div>

          <div className="topic-stack-soft" data-revealed={hasRolled ? "true" : "false"} aria-live="polite">
            {hasRolled && activeTopic ? (
              <>
                {ghostTopic ? <p className="ghost-topic">{ghostTopic.prompt}</p> : null}
                <h1>{activeTopic.prompt}</h1>
                <p className="ghost-topic lower">{activeTopic.trains}</p>
              </>
            ) : (
              <div className="topic-veil">
                <p>Topic hidden</p>
                <strong>Spin the wheel to reveal the prompt.</strong>
              </div>
            )}
          </div>

          <RouletteWheel
            onSpin={onSpin}
            spinsLeft={spinsLeft}
            wheel={wheel}
          />

          <div className="main-actions">
            <button
              className="primary-pill"
              disabled={wheel.spinning || spinsLeft <= 0}
              type="button"
              onClick={onSpin}
            >
              {wheel.spinning ? "Spinning..." : "Spin wheel"}
            </button>
            <button
              className="secondary-pill"
              disabled={!hasRolled || wheel.spinning}
              type="button"
              onClick={onStart}
            >
              Start timer →
            </button>
          </div>
        </div>
      </section>
    </section>
  );
}

function RouletteWheel({
  onSpin,
  spinsLeft,
  wheel,
}: {
  onSpin: () => void;
  spinsLeft: number;
  wheel: WheelState;
}) {
  const sliceAngle = 360 / WHEEL_CATEGORIES.length;
  const winningIndex = wheel.selectedCategory
    ? getCategoryIndex(wheel.selectedCategory)
    : -1;

  return (
    <section className="roulette-table" aria-label="Category roulette wheel">
      <div className="roulette-pointer" aria-hidden="true">
        <span />
      </div>
      <button
        className="roulette-stage"
        disabled={wheel.spinning || spinsLeft <= 0}
        onClick={onSpin}
        type="button"
        aria-label="Spin topic wheel"
      >
        <span className="rim-studs" aria-hidden="true">
          {Array.from({ length: 24 }, (_, index) => (
            <span
              key={index}
              style={{ "--stud-angle": `${index * 15}deg` } as CSSProperties}
            />
          ))}
        </span>
        <span
          className="roulette-wheel"
          data-spinning={wheel.spinning ? "true" : "false"}
          style={{ "--wheel-rotation": `${wheel.rotation}deg` } as CSSProperties}
        >
          {WHEEL_CATEGORIES.map((item, index) => {
            const angle = index * sliceAngle + sliceAngle / 2;
            const isWinner = !wheel.spinning && winningIndex === index;

            return (
              <span
                className="wheel-label"
                data-winner={isWinner ? "true" : "false"}
                key={item.category}
                style={
                  {
                    "--label-angle": `${angle}deg`,
                  } as CSSProperties
                }
              >
                {item.category}
              </span>
            );
          })}
        </span>
        <span className="spin-tokens" aria-label={`${spinsLeft} spins left`}>
          {Array.from({ length: MAX_SPINS }, (_, index) => (
            <span
              data-filled={index < spinsLeft ? "true" : "false"}
              key={index}
              style={
                {
                  "--token-angle": `${124 + index * 28}deg`,
                } as CSSProperties
              }
            />
          ))}
        </span>
        <span
          className="roulette-ball"
          data-spinning={wheel.spinning ? "true" : "false"}
          style={{ "--ball-rotation": `${wheel.ballRotation}deg` } as CSSProperties}
          aria-hidden="true"
        />
        <span className="roulette-hub">
          <span>Offscript</span>
        </span>
      </button>
    </section>
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
            Spin again
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

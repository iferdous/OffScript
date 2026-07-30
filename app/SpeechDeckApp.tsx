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
import {
  analyzeSpeech,
  createEmptyVoiceMetrics,
  type Analysis,
  type VoiceMetricsInput,
} from "./lib/speechAnalysis";

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
  active: boolean;
  topic: SpeechTopic;
  dimmed: boolean;
  winning: boolean;
};

type SlotCategoryMeta = {
  label: string;
  color: string;
};

type ReviewIconType =
  | "clock"
  | "filler"
  | "grid"
  | "pace"
  | "pause"
  | "spark"
  | "words";

type VoiceCapture = {
  audioContext: AudioContext;
  intervalId: number;
  source: MediaStreamAudioSourceNode;
  stream: MediaStream;
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
const VOICE_SAMPLE_MS = 120;
const MIC_PERMISSION_STORAGE_KEY = "offscript-mic-permission-granted";

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

function getSpeechRecognition() {
  if (typeof window === "undefined") {
    return null;
  }

  const Recognition =
    window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;

  return Recognition ? new Recognition() : null;
}

function rememberMicPermission() {
  try {
    window.localStorage.setItem(MIC_PERMISSION_STORAGE_KEY, "true");
  } catch {
    // Local storage can be unavailable in private/restricted sessions.
  }
}

function forgetMicPermission() {
  try {
    window.localStorage.removeItem(MIC_PERMISSION_STORAGE_KEY);
  } catch {
    // Local storage can be unavailable in private/restricted sessions.
  }
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
  const duration = 2.7;
  const master = context.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(0.075, now + 0.06);
  master.gain.setValueAtTime(0.075, now + 1.85);
  master.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  master.connect(context.destination);

  const noiseBuffer = context.createBuffer(
    1,
    Math.floor(context.sampleRate * duration),
    context.sampleRate,
  );
  const noise = noiseBuffer.getChannelData(0);

  for (let index = 0; index < noise.length; index += 1) {
    noise[index] = (Math.random() * 2 - 1) * 0.8;
  }

  const wheelNoise = context.createBufferSource();
  const bandpass = context.createBiquadFilter();
  const lowpass = context.createBiquadFilter();
  const noiseGain = context.createGain();

  wheelNoise.buffer = noiseBuffer;
  bandpass.type = "bandpass";
  bandpass.frequency.setValueAtTime(360, now);
  bandpass.frequency.exponentialRampToValueAtTime(155, now + duration);
  bandpass.Q.setValueAtTime(0.7, now);
  lowpass.type = "lowpass";
  lowpass.frequency.setValueAtTime(1600, now);
  lowpass.frequency.exponentialRampToValueAtTime(620, now + duration);
  noiseGain.gain.setValueAtTime(0.0001, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.28, now + 0.08);
  noiseGain.gain.setValueAtTime(0.22, now + 1.7);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  wheelNoise.connect(bandpass);
  bandpass.connect(lowpass);
  lowpass.connect(noiseGain);
  noiseGain.connect(master);
  wheelNoise.start(now);
  wheelNoise.stop(now + duration);

  const motor = context.createOscillator();
  const motorGain = context.createGain();
  motor.type = "sawtooth";
  motor.frequency.setValueAtTime(64, now);
  motor.frequency.exponentialRampToValueAtTime(34, now + duration);
  motorGain.gain.setValueAtTime(0.0001, now);
  motorGain.gain.exponentialRampToValueAtTime(0.035, now + 0.08);
  motorGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
  motor.connect(motorGain);
  motorGain.connect(master);
  motor.start(now);
  motor.stop(now + duration);

  const tickTimes = [
    0.08, 0.16, 0.25, 0.35, 0.46, 0.58, 0.72, 0.88, 1.06, 1.26, 1.49, 1.75,
    2.04, 2.34,
  ];

  for (const at of tickTimes) {
    const tick = context.createOscillator();
    const tickGain = context.createGain();
    tick.type = "triangle";
    tick.frequency.setValueAtTime(760 - at * 150, now + at);
    tick.frequency.exponentialRampToValueAtTime(180, now + at + 0.045);
    tickGain.gain.setValueAtTime(0.0001, now + at);
    tickGain.gain.exponentialRampToValueAtTime(0.16, now + at + 0.004);
    tickGain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.055);
    tick.connect(tickGain);
    tickGain.connect(master);
    tick.start(now + at);
    tick.stop(now + at + 0.07);
  }

  window.setTimeout(() => void context.close(), 2900);
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
  const [speechError, setSpeechError] = useState("");
  const [voiceMetrics, setVoiceMetrics] = useState<VoiceMetricsInput>(
    createEmptyVoiceMetrics,
  );
  const rawTranscript = [finalTranscript, interimTranscript]
    .filter(Boolean)
    .join(" ")
    .trim();
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceCaptureRef = useRef<VoiceCapture | null>(null);
  const voiceMetricsRef = useRef<VoiceMetricsInput>(createEmptyVoiceMetrics());
  const acceptingInputRef = useRef(false);
  const statusRef = useRef(status);
  const remainingRef = useRef(remaining);
  const transcriptRef = useRef(rawTranscript);
  const progress = duration > 0 ? (duration - remaining) / duration : 0;
  const analysis = useMemo(
    () => analyzeSpeech(rawTranscript, duration, voiceMetrics),
    [duration, rawTranscript, voiceMetrics],
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

  useEffect(
    () => () => {
      acceptingInputRef.current = false;
      stopVoiceCapture();
      recognitionRef.current?.stop();
    },
    [],
  );

  function resetVoiceMetrics() {
    const nextMetrics = createEmptyVoiceMetrics();
    voiceMetricsRef.current = nextMetrics;
    setVoiceMetrics(nextMetrics);
  }

  async function startVoiceCapture({ reset = false }: { reset?: boolean } = {}) {
    acceptingInputRef.current = true;

    if (reset) {
      resetVoiceMetrics();
    }

    if (
      typeof window === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      voiceCaptureRef.current
    ) {
      return true;
    }

    try {
      if (navigator.permissions?.query) {
        const permission = await navigator.permissions.query({
          name: "microphone" as PermissionName,
        });

        if (permission.state === "denied") {
          forgetMicPermission();
          setSpeechError("Microphone permission is blocked for this site. Allow it in your browser settings, then try again.");
          return false;
        }
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      rememberMicPermission();

      if (!acceptingInputRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }

      const AudioContext =
        window.AudioContext ??
        (window as typeof window & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;

      if (!AudioContext) {
        stream.getTracks().forEach((track) => track.stop());
        return true;
      }

      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.82;
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let silentRunMs = 0;

      const intervalId = window.setInterval(() => {
        if (!acceptingInputRef.current) {
          return;
        }

        analyser.getByteTimeDomainData(data);
        let sumSquares = 0;

        for (const value of data) {
          const centered = (value - 128) / 128;
          sumSquares += centered * centered;
        }

        const rms = Math.sqrt(sumSquares / data.length);
        const energy = Math.max(0, Math.min(1, (rms - 0.006) / 0.08));
        const speaking = rms > 0.014;
        const current = voiceMetricsRef.current;
        const nextSilentRun = speaking ? 0 : silentRunMs + VOICE_SAMPLE_MS;
        silentRunMs = nextSilentRun;
        voiceMetricsRef.current = {
          longestSilentRunMs: Math.max(current.longestSilentRunMs, nextSilentRun),
          samples: [...current.samples, energy].slice(-900),
          silentFrames: current.silentFrames + (speaking ? 0 : 1),
          speechFrames: current.speechFrames + (speaking ? 1 : 0),
          trackingAvailable: true,
        };
      }, VOICE_SAMPLE_MS);

      voiceCaptureRef.current = { audioContext, intervalId, source, stream };
      return true;
    } catch {
      forgetMicPermission();
      const current = voiceMetricsRef.current;
      voiceMetricsRef.current = { ...current, trackingAvailable: false };
      setVoiceMetrics(voiceMetricsRef.current);
      setSpeechError("Microphone access was not granted. Allow mic access once for this local site, then Offscript will reuse it.");
      return false;
    }
  }

  function stopVoiceCapture() {
    const capture = voiceCaptureRef.current;

    if (!capture) {
      return;
    }

    window.clearInterval(capture.intervalId);
    capture.source.disconnect();
    capture.stream.getTracks().forEach((track) => track.stop());
    void capture.audioContext.close();
    voiceCaptureRef.current = null;
    setVoiceMetrics({ ...voiceMetricsRef.current });
  }

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

  async function startPractice() {
    if (!activeTopic) {
      spinSlot();
      return;
    }

    playCue("start", muted);
    setScreen("practice");
    setStatus("recording");
    acceptingInputRef.current = true;
    setRemaining(duration);
    setFinalTranscript("");
    setInterimTranscript("");
    setSpeechError("");
    const microphoneReady = await startVoiceCapture({ reset: true });

    const recognition = getSpeechRecognition();
    recognitionRef.current = recognition;

    if (!recognition) {
      setSpeechError(
        "Live browser transcription is not available in this browser. Try allowing microphone access or use a browser with speech recognition.",
      );
      return;
    }

    if (!microphoneReady) {
      return;
    }

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      if (!acceptingInputRef.current || statusRef.current !== "recording") {
        return;
      }

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
        setFinalTranscript((current) => {
          if (!acceptingInputRef.current || statusRef.current !== "recording") {
            return current;
          }

          return `${current} ${finalText}`.trim();
        });
      }

      if (acceptingInputRef.current && statusRef.current === "recording") {
        setInterimTranscript(interimText);
      }
    };
    recognition.onerror = (event) => {
      if (!acceptingInputRef.current) {
        return;
      }

      setSpeechError(
        event.error === "not-allowed"
          ? "Microphone permission was blocked. Allow mic access, then try the round again."
          : "Transcription paused. You can keep speaking while the browser reconnects.",
      );
    };
    recognition.onend = () => {
      if (
        acceptingInputRef.current &&
        statusRef.current === "recording" &&
        remainingRef.current > 0
      ) {
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
      setSpeechError("The microphone could not start. Check browser mic access and try again.");
    }

    window.setTimeout(() => {
      if (statusRef.current === "recording" && !transcriptRef.current) {
        setSpeechError(
          "Still listening, but no words have come back yet. Keep speaking clearly and check that your microphone is active.",
        );
      }
    }, 6000);
  }

  function pausePractice() {
    setStatus("paused");
    acceptingInputRef.current = false;
    recognitionRef.current?.stop();
    stopVoiceCapture();
  }

  function resumePractice() {
    setStatus("recording");
    acceptingInputRef.current = true;
    void startVoiceCapture().then((microphoneReady) => {
      if (!microphoneReady) {
        return;
      }

      try {
        recognitionRef.current?.start();
      } catch {
        setSpeechError("Transcription could not resume. Check microphone access and try again.");
      }
    });
  }

  function finishPractice() {
    playCue("finish", muted);
    acceptingInputRef.current = false;
    setStatus("finished");
    recognitionRef.current?.stop();
    stopVoiceCapture();
    setScreen("review");
  }

  function resetPractice() {
    acceptingInputRef.current = false;
    recognitionRef.current?.stop();
    setScreen("roll");
    setStatus("idle");
    setRemaining(duration);
    setFinalTranscript("");
    setInterimTranscript("");
    resetVoiceMetrics();
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
          onBack={resetPractice}
          onFinish={finishPractice}
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
            resetVoiceMetrics();
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
      <section className="landing-grid">
        <div className="landing-copy">
          <p className="wordmark">Offscript</p>
          <h1>Train the moment before your mind goes blank.</h1>
          <p>
            Pull a prompt, speak inside the timer, then review the words,
            rhythm, and habits that actually came out.
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
                Start recording →
              </button>
            ) : null}
          </div>
        </div>
        <div className="topic-console">
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
        </div>
      </section>

      {slotOpen ? (
        <section
          className="slot-overlay"
          aria-label="Topic slot machine fullscreen"
        >
          <button
            className="slot-back-button"
            type="button"
            onClick={onCloseSlot}
          >
            ← Back
          </button>
          <button
            className="speaker-toggle overlay-speaker-toggle"
            type="button"
            onClick={onToggleMute}
            aria-label={muted ? "Turn sound on" : "Turn sound off"}
          >
            {muted ? "×" : "♪"}
          </button>

          <div className="slot-scroll-stage">
            <div className="slot-stage-copy">
              <h2>Pull once. Commit fast. Speak clean.</h2>
            </div>
            <SlotMachine
              onSpin={onSpin}
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
                  Start recording →
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
  onSpin,
  slot,
  spinsLeft,
}: {
  onSpin: () => void;
  slot: SlotMachineState;
  spinsLeft: number;
}) {
  const disabled = slot.primed || slot.spinning || spinsLeft <= 0;
  const isIdle = !slot.winnerId && !slot.primed && !slot.spinning;
  const rows = slot.sequence.map((topic, index) => {
    const centerIndex = slot.winnerId ? 18 : 1;
    const active = index === centerIndex;
    return {
      topic,
      active,
      dimmed: !active,
      winning: slot.winHighlight && topic.id === slot.winnerId,
    };
  });

  return (
    <section className="slot-cabinet" aria-label="Slot machine topic reveal">
      <div className="cabinet-trim" aria-hidden="true" />
      <header className="slot-marquee">
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
            <span
              aria-hidden="true"
              data-filled={index < spinsLeft ? "true" : "false"}
              key={index}
            />
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

      {!disabled ? (
        <div className="lever-callout" aria-hidden="true">
          <span>click me</span>
          <svg viewBox="0 0 142 68" role="img">
            <path d="M8 48 C 34 16, 74 10, 112 28" />
            <path d="M102 16 L 124 32 L 96 40" />
            <path d="M28 42 C 32 48, 42 50, 48 44" />
          </svg>
        </div>
      ) : null}

      <div className="bottom-plinth" aria-hidden="true" />
    </section>
  );
}

function SlotTopicRow({ row }: { row: SlotTopicRowData }) {
  const meta = SLOT_CATEGORY_META[row.topic.category];

  return (
    <div
      className="slot-topic-row"
      data-active={row.active ? "true" : "false"}
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

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getReviewScore(analysis: Analysis) {
  if (analysis.wordCount === 0) {
    return 0;
  }

  const paceScore =
    analysis.wpm >= 105 && analysis.wpm <= 160
      ? 22
      : Math.max(4, 22 - Math.abs(132 - analysis.wpm) * 0.18);
  const fillerScore = Math.max(0, 24 - analysis.fillerRate * 2.2);
  const structureScore = Math.max(
    4,
    18 - analysis.structure.longSentenceCount * 5 - Math.max(0, analysis.structure.averageSentenceWords - 24) * 0.4,
  );
  const vocabScore = Math.min(16, analysis.vocabulary.uniqueWords * 0.7);
  const toneScore =
    analysis.tone.label === "engaged"
      ? 20
      : analysis.tone.label === "tone unavailable"
        ? 12
        : 10;

  return clampScore(paceScore + fillerScore + structureScore + vocabScore + toneScore);
}

function ReviewIcon({ type }: { type: ReviewIconType }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 2,
    viewBox: "0 0 24 24",
  };

  if (type === "pace") {
    return (
      <svg {...common} aria-hidden="true">
        <path d="M4 13a8 8 0 0 1 16 0" />
        <path d="m12 13 4-5" />
        <path d="M7 17h10" />
      </svg>
    );
  }

  if (type === "clock") {
    return (
      <svg {...common} aria-hidden="true">
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v5l3 2" />
      </svg>
    );
  }

  if (type === "filler") {
    return (
      <svg {...common} aria-hidden="true">
        <path d="M12 8v5" />
        <path d="M12 17h.01" />
        <path d="M10.2 4.2 3 17a2 2 0 0 0 1.8 3h14.4a2 2 0 0 0 1.8-3L13.8 4.2a2 2 0 0 0-3.6 0Z" />
      </svg>
    );
  }

  if (type === "words") {
    return (
      <svg {...common} aria-hidden="true">
        <path d="M5 7h14" />
        <path d="M5 12h10" />
        <path d="M5 17h7" />
      </svg>
    );
  }

  if (type === "pause") {
    return (
      <svg {...common} aria-hidden="true">
        <path d="M9 6v12" />
        <path d="M15 6v12" />
      </svg>
    );
  }

  if (type === "grid") {
    return (
      <svg {...common} aria-hidden="true">
        <rect x="4" y="4" width="6" height="6" rx="1" />
        <rect x="14" y="4" width="6" height="6" rx="1" />
        <rect x="4" y="14" width="6" height="6" rx="1" />
        <rect x="14" y="14" width="6" height="6" rx="1" />
      </svg>
    );
  }

  return (
    <svg {...common} aria-hidden="true">
      <path d="M12 3v4" />
      <path d="M12 17v4" />
      <path d="M3 12h4" />
      <path d="M17 12h4" />
      <path d="m5.6 5.6 2.8 2.8" />
      <path d="m15.6 15.6 2.8 2.8" />
      <path d="m18.4 5.6-2.8 2.8" />
      <path d="m8.4 15.6-2.8 2.8" />
    </svg>
  );
}

function HighlightedTranscript({
  fillerCounts,
  transcript,
}: {
  fillerCounts: Analysis["fillerCounts"];
  transcript: string;
}) {
  if (!transcript) {
    return null;
  }

  const fillerWords = fillerCounts.map((item) => item.word);

  if (fillerWords.length === 0) {
    return <>{transcript}</>;
  }

  const escaped = fillerWords.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`\\b(${escaped.join("|")})\\b`, "gi");
  const parts = transcript.split(pattern);

  return (
    <>
      {parts.map((part, index) =>
        fillerWords.some((word) => word.toLowerCase() === part.toLowerCase()) ? (
          <mark key={`${part}-${index}`}>{part}</mark>
        ) : (
          <span key={`${part}-${index}`}>{part}</span>
        ),
      )}
    </>
  );
}

function PracticeScreen({
  activeTopic,
  duration,
  onBack,
  onFinish,
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
  onBack: () => void;
  onFinish: () => void;
  onPause: () => void;
  onResume: () => void;
  progress: number;
  rawTranscript: string;
  remaining: number;
  setDuration: (duration: number) => void;
  speechError: string;
  status: PracticeStatus;
}) {
  const isRecording = status === "recording";
  const allSpokenWords = rawTranscript
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean);
  const currentLineStart =
    allSpokenWords.length > 0 ? Math.floor((allSpokenWords.length - 1) / 10) * 10 : 0;
  const spokenWords = allSpokenWords
    .map((word, index) => ({ id: `${index}-${word}`, word }))
    .slice(currentLineStart, currentLineStart + 10);
  const timerStyle = {
    "--progress": progress,
    "--remaining-progress": Math.max(0, 1 - progress),
  } as CSSProperties;

  return (
    <section className="practice-screen" aria-label="Timed speaking practice">
      <button className="back-link" type="button" onClick={onBack}>
        ← Back
      </button>
      <button className="floating-analysis" type="button" onClick={onFinish}>
        Analyze
      </button>

      <div className="recording-console">
        <div className="practice-topic">
          <h1>{activeTopic.prompt}</h1>
        </div>
      </div>

      <div
        className="timer-circle"
        data-live={isRecording ? "true" : "false"}
        style={timerStyle}
      >
        <div>
          <strong>{formatTime(remaining)}</strong>
          <div className="voice-meter" data-live={isRecording ? "true" : "false"} aria-hidden="true">
            {Array.from({ length: 11 }, (_, index) => (
              <span key={index} />
            ))}
          </div>
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
          <p className="recording-state">{isRecording ? "Mic live" : "Mic idle"}</p>
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

      <section className="word-stream-panel" aria-label="Live word stream">
        <div className="word-stream">
          {spokenWords.length > 0 ? (
            spokenWords.map(({ id, word }, index) => (
              <span
                className="spoken-word"
                key={id}
                style={{ "--word-index": index } as CSSProperties}
              >
                {word}
              </span>
            ))
          ) : (
            <p className="word-stream-empty">Your words will appear here as you speak.</p>
          )}
        </div>
        {speechError ? <p className="speech-error">{speechError}</p> : null}
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
  const hasTranscript = analysis.wordCount > 0;
  const hasToneData = analysis.tone.label !== "tone unavailable";
  const score = getReviewScore(analysis);
  const scoreCircumference = 314;
  const scoreOffset = scoreCircumference - (score / 100) * scoreCircumference;
  const topSuggestion = analysis.suggestions[0] ?? "Try another round and aim for one clear claim.";
  const metricCards = [
    {
      icon: "pace" as const,
      label: "Pace",
      tone: "good",
      value: `${analysis.wpm}`,
      unit: "wpm",
    },
    {
      icon: "words" as const,
      label: "Total words",
      tone: "good",
      value: `${analysis.wordCount}`,
      unit: `in ${formatTime(duration)}`,
    },
    {
      icon: "filler" as const,
      label: "Filler words",
      tone: analysis.totalFillers > 0 ? "warn" : "good",
      value: `${analysis.totalFillers}`,
      unit: "tracked",
    },
    {
      icon: "spark" as const,
      label: "Filler load",
      tone: analysis.fillerRate >= 8 ? "warn" : "good",
      value: `${analysis.fillerRate}`,
      unit: "%",
    },
    {
      icon: "grid" as const,
      label: "Unique words",
      tone: "good",
      value: `${analysis.vocabulary.uniqueWords}`,
      unit: analysis.vocabulary.label,
    },
    {
      icon: "pause" as const,
      label: "Quiet space",
      tone: analysis.tone.pauseRatio > 42 ? "warn" : "good",
      value: hasToneData ? `${analysis.tone.pauseRatio}` : "—",
      unit: hasToneData ? "%" : "no mic data",
    },
  ];

  return (
    <section className="review-screen" aria-label="Speech feedback">
      <header className="review-hero">
        <div>
          <button
            className="review-brand wordmark-button"
            type="button"
            onClick={onNewSpin}
          >
            <span aria-hidden="true" />
            Offscript
          </button>
          <h1>Your speech review</h1>
          <p>Here’s what you said, what showed up often, and one place to improve next.</p>
        </div>
        <div className="review-actions">
          <button className="primary-pill" type="button" onClick={onRetry}>
            Practice again
          </button>
          <button className="secondary-pill" type="button" onClick={onNewSpin}>
            New prompt
          </button>
        </div>
      </header>

      <p className="review-topic">— {activeTopic.prompt}</p>

      {!hasTranscript ? (
        <section className="review-empty-state" aria-label="No speech captured">
          <div className="review-empty-icon">
            <ReviewIcon type="spark" />
          </div>
          <h2>No speech captured yet</h2>
          <p>
            Start another round and speak for a few sentences. Your review will
            appear here once Offscript has words to work with.
          </p>
          <button className="primary-pill" type="button" onClick={onRetry}>
            Practice again
          </button>
        </section>
      ) : (
        <>
          <section className="review-summary">
            <article className="review-score-card">
              <svg width="136" height="136" viewBox="0 0 120 120" aria-hidden="true">
                <circle
                  cx="60"
                  cy="60"
                  fill="none"
                  r="50"
                  stroke="rgba(237,233,220,0.08)"
                  strokeWidth="10"
                />
                <circle
                  cx="60"
                  cy="60"
                  fill="none"
                  r="50"
                  stroke="currentColor"
                  strokeDasharray={scoreCircumference}
                  strokeDashoffset={scoreOffset}
                  strokeLinecap="round"
                  strokeWidth="10"
                  transform="rotate(-90 60 60)"
                />
                <text x="60" y="58" textAnchor="middle">
                  {score}
                </text>
                <text className="score-total" x="60" y="77" textAnchor="middle">
                  / 100
                </text>
              </svg>
              <p>Overall clarity</p>
              <span>
                {score >= 75
                  ? "Strong foundation"
                  : score >= 55
                    ? "Useful practice round"
                    : "Needs a fuller answer"}
              </span>
            </article>

            <div className="review-metric-grid">
              {metricCards.map((metric) => (
                <article className="review-stat" data-tone={metric.tone} key={metric.label}>
                  <div className="review-stat-icon">
                    <ReviewIcon type={metric.icon} />
                  </div>
                  <strong>
                    {metric.value}
                    <small>{metric.unit}</small>
                  </strong>
                  <p>{metric.label}</p>
                </article>
              ))}
            </div>
          </section>

          <div className="review-detail-grid">
            <div className="review-column">
              <article className="review-panel review-panel-large">
                <p className="review-panel-title"><span />Transcript</p>
                <p className="review-transcript">
                  <HighlightedTranscript
                    fillerCounts={analysis.fillerCounts}
                    transcript={rawTranscript}
                  />
                </p>
              </article>

              <article className="review-panel">
                <p className="review-panel-title"><span />Filler words</p>
                {analysis.fillerCounts.length > 0 ? (
                  <div className="review-chip-row">
                    {analysis.fillerCounts.map((item) => (
                      <span className="review-chip" key={item.word}>
                        {item.word}
                        <small>×{item.count}</small>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="review-muted">No tracked filler words found.</p>
                )}
              </article>

              <article className="review-panel">
                <p className="review-panel-title"><span />Structure</p>
                <div className="review-lines">
                  <div>
                    <span>Estimated sentence beats</span>
                    <strong>{analysis.structure.sentenceCount}</strong>
                  </div>
                  <div>
                    <span>Average beat length</span>
                    <strong>{analysis.structure.averageSentenceWords} words</strong>
                  </div>
                  <div>
                    <span>Long running beats</span>
                    <strong>{analysis.structure.longSentenceCount}</strong>
                  </div>
                </div>
              </article>
            </div>

            <div className="review-column">
              <article className="review-panel">
                <p className="review-panel-title"><span />Tone and rhythm</p>
                <p className="review-muted">{analysis.tone.summary}</p>
                <div className="review-bars">
                  {[
                    ["Voice energy", analysis.tone.averageEnergy],
                    ["Energy contrast", analysis.tone.energyRange],
                    ["Quiet space", analysis.tone.pauseRatio],
                  ].map(([label, value]) => (
                    <div className="review-bar" key={label}>
                      <div>
                        <span>{label}</span>
                        <strong>{hasToneData ? value : "—"}</strong>
                      </div>
                      <span>
                        <i
                          style={{
                            width: `${hasToneData ? Number(value) : 0}%`,
                          }}
                        />
                      </span>
                    </div>
                  ))}
                </div>
              </article>

              <article className="review-panel review-advice-panel">
                <p className="review-panel-title"><span />What to work on</p>
                <div className="review-advice">
                  <strong>Next rep</strong>
                  <p>{topSuggestion}</p>
                </div>
              </article>

              <article className="review-panel">
                <p className="review-panel-title"><span />Cleaned version</p>
                <p className="review-transcript review-transcript-clean">
                  {analysis.cleanedTranscript}
                </p>
              </article>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

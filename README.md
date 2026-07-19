# Offscript

Offscript is a local-first public speaking practice app for getting better when
there is no script in front of you. Pull the slot machine for a hidden topic, speak
against a timer, then review the raw transcript, cleaned version, filler words,
pace, and concrete suggestions.

## Current V1 Focus

- Casino-inspired slot-machine topic reveal with sound cues
- Hidden topic until the reel settles, then a committed speaking prompt
- No-repeat shuffled topic pool that only reshuffles after the full pool is used
- Category guard so the next draw avoids repeating the last locked category
- Timed speaking screen with browser mic transcription and manual fallback
- Review screen with raw transcript, cleaned transcript, filler counts, WPM, and
  improvement suggestions
- Local Vite app: no OpenAI hosting, no login flow

## Development

Prerequisite: Node.js `>=22.13.0`

```bash
npm install
npm run dev
npm run lint
npm test
```

`npm run dev` serves the app from local Vite at `http://127.0.0.1:5173/` and
opens it automatically in your browser. If that port is already busy, Vite uses
the next available localhost port.

`npm test` runs the local production build and topic-engine tests.

## Project Shape

- `app/SpeechDeckApp.tsx`: slot reveal, timer, transcript capture, and review UI
- `app/data/topics.ts`: topic catalog with categories, skill tags, frameworks,
  and time limits
- `app/lib/topicEngine.ts`: no-repeat pool, deterministic hydration shuffle, and
  category-variety constraints
- `tests/topic-engine.test.ts`: generator behavior tests
- `public/og.png`: social preview asset

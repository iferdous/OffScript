# OutLoud Deck

OutLoud Deck is a local-first public speaking practice app centered on a
smarter random topic generator. Instead of a slot-machine spin, it presents a
three-card deck, asks the speaker to commit, and keeps a short session trail so
practice feels deliberate.

## Current V1 Focus

- Three-topic deck stack with a lock-in action
- No-repeat shuffled topic pool that only reshuffles after the full pool is used
- Category guard so the next draw avoids repeating the last locked category
- Two limited redraws per session
- "Why this one" skill tag for every topic
- Speaking timer and last-10 topic history
- Music/performance-inspired UI with motion ribbons and a social preview image

## Development

Prerequisite: Node.js `>=22.13.0`

```bash
npm install
npm run dev
npm run lint
npm test
```

`npm run dev` serves the app from local Vite at `http://127.0.0.1:5173/`
and opens it automatically in your browser.
There is no external hosting config in this project.

`npm test` runs the local production build and topic-engine tests.

## Project Shape

- `app/SpeechDeckApp.tsx`: interactive deck, lock-in flow, timer, and session UI
- `app/data/topics.ts`: topic catalog with categories, skill tags, frameworks,
  and time limits
- `app/lib/topicEngine.ts`: no-repeat pool, deterministic hydration shuffle, and
  category-variety constraints
- `tests/topic-engine.test.ts`: generator behavior tests
- `public/og.png`: social preview asset

# DegenHive game SDK

The global `DegenHive` that a game calls to start and end runs, save progress and react to the page around it. The message format is in [docs/PROTOCOL.md](../../docs/PROTOCOL.md), sections 4 and 5.

## Use

There is nothing to install. The server adds `<script src="/__dh/sdk.js">` to every HTML page of a build, so `window.DegenHive` exists before your own scripts run. A script that may run first can wait for it:

```js
const ready = (fn) => (window.DegenHive ? fn(window.DegenHive) : addEventListener("degenhive:ready", () => fn(window.DegenHive), { once: true }));
```

Bundler users can import it instead: `import DegenHive from "@degenhive/game-sdk"`. It is the same object; a page only ever has one.

## API

| Call | Returns | Notes |
|---|---|---|
| `DegenHive.version` | `string` | `"1.0.0"` |
| `ready()` | `void` | Once, when the first screen takes input. Within 10 s of load. |
| `session()` | `Promise<Session>` | `mode` is `practice`, `points`, `preview` or `local`. Show it to the player. |
| `runStart()` | `Promise<{ runId, seed }>` | When a run begins. Feed `seed` to `random()`. |
| `runEnd({ score, log? })` | `Promise<RunResult>` | Once per run. `score` is a whole number, 0 to 1,000,000. |
| `save.get()` / `save.set(text)` | `Promise<string \| null>` / `Promise<void>` | Text only, up to 60 KB per player and game. |
| `track(name, props?)` | `void` | `level_start`, `level_complete`, `level_fail`, `funnel_step`, `gameplay_start`, `gameplay_stop`, `custom`. Props are strings, numbers or booleans. |
| `openLink(url)` | `Promise<boolean>` | Host confirm sheet. `true` when the player opens it. `http` and `https` only. |
| `on(event, fn)` | `() => void` | `pause`, `resume`, `mute` (`{ muted }`), `sessionChanged` (a `Session`), `sessionEnding` (`{ secondsLeft }`). Returns the unsubscribe function. |
| `random(seed)` | `() => number` | mulberry32, floats in [0, 1). Same seed, same sequence, in every browser. |

`RunResult` is `{ accepted, counted, best, reason? }`. A rejected promise carries an `Error` with a `code`: `bad_request`, `rate_limited`, `run_unknown`, `run_rejected`, `too_large` or `unavailable`.

Loads, sessions, heartbeats (every 30 s while the tab is visible) and uncaught errors are reported with no call from the game.

## What the SDK checks for you

- A second `runEnd` for the same run is refused with `run_unknown` and a console warning, without sending anything. This is the most common bug in AI-written games.
- A bad `score`, `log` or URL is refused with `bad_request`; an over-size message with `too_large`. Nothing goes to the host.
- A request the host does not answer in 10 s rejects with `unavailable`. A `runEnd` that failed this way can be called again. `openLink` waits up to 10 minutes, because a person has to answer the confirm sheet.
- At most 20 messages a second leave the game. When the queue overflows, `track` events are dropped first.
- Calls made before the page has said hello wait and go out afterwards.

## Local mode

With no host page (the game opened on its own, or no hello within 1,500 ms of load) the SDK runs in local mode:

- `session()` returns `mode: "local"`.
- `runStart()` returns a random seed.
- `runEnd()` logs the result and resolves `{ accepted: true, counted: false, best }`.
- `save` uses `localStorage`.
- `pause` and `resume` fire when the tab is hidden and shown.
- `track`, `ready`, heartbeats and errors are not sent anywhere.

## Example

```js
const DH = window.DegenHive;
let rand, score = 0, running = false, paused = false;

DH.on("pause", () => (paused = true));
DH.on("resume", () => (paused = false));

async function newRun() {
  const { seed } = await DH.runStart();
  rand = DH.random(seed);            // all randomness that changes the score
  score = 0;
  running = true;
}

async function endRun() {
  if (!running) return;              // runEnd once per run
  running = false;
  const r = await DH.runEnd({ score });
  showResult(r.counted ? "Counted for the Lab" : "Not counted", r.best);
}

function tick() {
  if (running && !paused) {
    score += rand() < 0.1 ? 10 : 1;
    if (score >= 500) endRun();
  }
  requestAnimationFrame(tick);
}

DH.session().then(async (s) => { showMode(s.mode); await newRun(); DH.ready(); tick(); });
```

## Build and test

```
npm install
npm test        # builds, type-checks, runs the tests
npm run build   # dist/sdk.js, dist/sdk.mjs, dist/sdk.d.ts
```

`dist/` is committed because the edge server serves `dist/sdk.js` as it is: a minified, single-file script with no dependencies. `dist/sdk.d.ts` holds the types; `dist/sdk.mjs` is the ES module for bundlers. Edit `src/`, then rebuild and commit `dist/` with it.

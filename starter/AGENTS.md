# Building a DegenHive game: agent instructions

You are building one browser game for DegenHive. The game runs in a sandboxed iframe on degenhive.ai. It talks to the page around it only through the `DegenHive` SDK global. Follow this file exactly. The contract is `docs/PROTOCOL.md`; if this file and the protocol disagree, the protocol wins.

## 1. Start from a template

Copy one template into `games/<slug>/` and edit it. Do not start from an empty folder.

| Template | Use it for |
|---|---|
| `starter/canvas/` | 2D games drawn on a `<canvas>` |
| `starter/three/` | 3D games with three.js |

```
cp -R starter/canvas games/<slug>
```

Pick the slug first: 3 to 32 characters, `a-z`, `0-9` and `-`. It starts with a letter, does not end with `-` and has no `--`. It cannot change after the first merge. Set `"slug"` in `game.json` to the same value as the directory name.

Every template is already correct. Change the game, not the structure. Two finished games show the same structure at full size: `examples/hive-runner` (canvas) and `examples/honey-stack` (three.js).

## 2. Hard rules

A build that breaks one of these is refused by the checks.

- [ ] The game is one directory: `game.json`, `assets.json`, `src/`. Nothing else at the top level.
- [ ] Text files live in `src/`. Allowed text types: `html htm js mjs css json glsl frag vert txt md csv`.
- [ ] Binary files (`png jpg jpeg webp gif avif svg mp3 ogg wav m4a woff woff2 ttf otf glb gltf bin`) are listed in `assets.json` and are not committed. If you need none, `assets.json` is `{ "assets": {} }`. Prefer drawing with canvas or three.js primitives and synthesizing sound with WebAudio. That needs no assets at all.
- [ ] `wasm` needs a human approval. Do not use it.
- [ ] Limits: entry file at most 5 MB, whole build at most 30 MB, at most 300 files.
- [ ] Paths are relative, lower-case ASCII letters, digits, `-`, `_`, `.` and `/`, at most 200 characters, no `..`.
- [ ] No wallet code. Never use `window.ethereum`, `window.solana`, `eth_` methods, `personal_sign`, `permit`, EIP-6963 events, or any wallet or blockchain library. Never ask the player for wallet secrets, approvals or signatures.
- [ ] Never touch the outer page: no `window.parent`, `window.top`, `window.opener`, `window.open`, `document.domain`. To open a link use `DegenHive.openLink(url)`.
- [ ] No WebSocket, WebTransport, EventSource or RTCPeerConnection unless the origin is listed in `backends` in `game.json`. Each backend needs a human approval.
- [ ] No `eval` or `new Function` on decoded or fetched strings.
- [ ] No fetches or script loads from outside the build. The only exception is a library from jsDelivr, cdnjs or unpkg: `three`, `phaser`, `pixi.js`, `howler`, `matter-js`, `tone`. Use an exact version in the URL, for example `https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js`. The checks swap it for a pinned copy.
- [ ] Your own code is readable. Do not minify or obfuscate it. Do not bundle it into one long line.
- [ ] No notes to reviewers or checkers in code, comments or strings. Comments describe the code and nothing else.
- [ ] Put CSS in a `.css` file in `src/`. Do not use inline `<style>` blocks or `style="..."` attributes: the content policy in PROTOCOL.md section 6 lists no style rule. Setting styles from JavaScript (`element.style.transform = ...`) is fine.
- [ ] The server adds `<script src="/__dh/sdk.js">` to every HTML page. Do not add it yourself and do not copy the SDK into the game.
- [ ] No service workers (refused). No camera, microphone, location, clipboard reading, USB, Bluetooth.

## 3. game.json

```json
{
  "schema": 1,
  "slug": "my-game",
  "title": "My Game",
  "pitch": "One sentence, at most 120 characters.",
  "owner": "0x0000000000000000000000000000000000000000",
  "entry": "index.html",
  "tags": ["arcade"],
  "controls": ["keyboard", "mouse", "touch"],
  "mobile": true,
  "orientation": "any",
  "scored": true,
  "scoring": { "mode": "best", "maxScore": 10000, "maxPointsPerSecond": 6, "minRunSeconds": 5 },
  "sim": "sim.js",
  "backends": [],
  "sdk": 1
}
```

- Leave `owner` as it is. DegenHive sets it.
- `title` is 1 to 40 characters. `pitch` is 1 to 120 characters.
- `tags`: 1 to 3 of `arcade puzzle action strategy racing idle card word sports shooter platformer rhythm sim casual multiplayer`.
- `controls`: what the game really supports, from `mouse keyboard touch gamepad`.
- `mobile: true` means the game is fully playable on a phone with touch only. Only set it when that is true.
- `orientation`: `landscape`, `portrait` or `any`. Prefer `any` and make the layout fit.
- `scored: true` when the game calls `runEnd`. A Lab can only use a scored game. Then `scoring` is required.
- `scoring.mode`: `best` (the player's best run in a session counts) or `sum` (the runs add up).
- `scoring.maxScore`: the highest score one run can reach, 1 to 1,000,000. It must match the cap in `sim.js`.
- `scoring.maxPointsPerSecond`: the fastest the score can grow. The checks compare each run's score divided by its length in seconds with this value, and flag runs above it. Set it well above the best honest rate you measure, including short runs and bursts. Measure with a bot or a short script that plays `sim.js` (the starters were measured this way). A game that only scores at the end of a long run still needs a value: use the best honest score divided by its run length, with a margin.
- `scoring.minRunSeconds`: a floor, not a target. A run shorter than this does not count for points, but it must still end normally with `runEnd`. Set it to about the shortest run a real player can finish; use 5 when unsure.
- `sim`: `"sim.js"` for scored games built with the template. Use `null` if the game has no pure simulation.
- `backends`: leave `[]`.

## 4. The SDK

`window.DegenHive` exists when your script runs. With no host page around, it runs in local mode and everything below still works.

```ts
DegenHive.ready(): void
DegenHive.session(): Promise<Session>
DegenHive.runStart(): Promise<{ runId: string; seed: number }>
DegenHive.runEnd(result: { score: number; log?: string }): Promise<RunResult>
DegenHive.save.get(): Promise<string | null>
DegenHive.save.set(data: string): Promise<void>
DegenHive.track(name, props?): void
DegenHive.openLink(url: string): Promise<boolean>
DegenHive.on("pause" | "resume" | "mute" | "sessionChanged" | "sessionEnding", fn): () => void
DegenHive.random(seed: number): () => number

type Session = { mode: "practice" | "points" | "preview" | "local"; player: { name: string; avatar: string | null; signedIn: boolean }; lab: { id: string; name: string } | null; muted: boolean; locale: string }
type RunResult = { accepted: boolean; counted: boolean; best: number | null; reason?: string }
```

Do these, in this order:

1. **Boot.** Attach all event handlers. `await DegenHive.session()` inside `try/catch`. Show the first screen (title, a Play button). Then call `DegenHive.ready()` once. It must come within 10 seconds of load.
2. **Mode badge.** Show the session mode on screen: `practice` as "Practice", `points` as "Points on", `preview` as "Preview", `local` as "Local test". Update it on `sessionChanged`; the event payload is the new `Session`.
3. **Run start.** When the player starts a run call `const { seed } = await DegenHive.runStart()`; `seed` is an unsigned 32-bit integer. Create the simulation from that seed: `sim.init(seed, DegenHive.random(seed))`. All randomness that affects the score comes from this generator. Visual-only randomness (particles, shake) may use `Math.random`.
4. **Run end.** When the run is over call `DegenHive.runEnd({ score })` once. `score` is a whole number from 0 to `scoring.maxScore`. Leave `log` out; its format is not defined yet. Guard it with a flag that is reset in the run start function. Wrap it in `try/catch`; a rejected promise has a `.code` such as `run_rejected`.
5. **Best score.** Keep it with `DegenHive.save.set(JSON.stringify({ best }))` and read it with `DegenHive.save.get()` at boot. Up to 60 KB of text. Call `save.set` only when something changed, never every frame.
6. **Pause.** On `pause` stop the simulation and stop timers; show a paused screen. On `resume` continue and do not simulate the time that passed.
7. **Mute.** `session.muted` is the initial state; the `mute` event gives `{ muted }`. Respect it for all sound. Create the `AudioContext` on the first player gesture.
8. **If `runStart` fails**, let the player play an unscored run and do not call `runEnd` for it.

Rate limit: the host accepts 20 SDK messages a second. `track`, `save.set`, `runStart` and `runEnd` all count. Never call them in a frame loop.

## 5. Split the rules out: sim.js

A scored game keeps everything that decides the score in `src/sim.js` as plain functions. `game.js` handles screens, input, sound and drawing.

```js
export function init(seed, random = mulberry32(seed)) { /* returns state */ }
export function step(state, input, dt) { /* advances the state */ }
export function score(state) { /* whole number, 0..MAX_SCORE */ }
export function isOver(state) { /* true when the run is finished */ }
```

`mulberry32` is defined in the template's `sim.js`. It is the same generator as `DegenHive.random`. `game.js` passes `DegenHive.random(seed)` as the second argument, and the default lets the file run on its own.

Rules for `sim.js`:

- [ ] No DOM, no `window`, no `DegenHive` calls, no imports other than your own pure modules.
- [ ] No `Math.random`, `Date`, `performance.now`, `crypto`. Use the generator in `state.rand`.
- [ ] No `Math.sin`, `cos`, `tan`, `pow`, `exp`, `log`, `hypot`: engines round them differently. `+ - * /`, `sqrt`, `abs`, `min`, `max`, `floor` are safe. Use a triangle wave for oscillation.
- [ ] Same seed, same inputs and same step sizes give the same score in every browser.
- [ ] `game.js` calls `step` with a fixed `dt` (`1/60`) from an accumulator loop. Never pass the raw frame time.
- [ ] `score(state)` clamps to the maximum, and the maximum equals `scoring.maxScore` in `game.json`.
- [ ] Anything that happens in the sim and needs a sound or a particle is pushed to `state.events`; `game.js` reads and empties it.
- [ ] `input` is plain data: for example `{ dir, target }` or `{ drop }`. Convert pointer positions to world units in `game.js`.

Replay checks are not live yet. When they ship, they will run `sim.js` against recorded input to verify scores, so keep the file pure now.

## 6. Layout and controls

- [ ] Size the canvas from the container, not from constants. Use a `ResizeObserver` on the canvas, multiply by `devicePixelRatio` (cap it at 2), and redo the layout on every resize. The iframe can be any size, in portrait or landscape.
- [ ] Keep a fixed logical play field and fit it into the container (letterbox), or lay out from the aspect ratio. Test a tall phone size and a wide desktop size.
- [ ] When `mobile` is `true`, every action works by touch alone. Use pointer events (`pointerdown`, `pointermove`, `pointerup`); they cover mouse, touch and pen. Put the listeners on `window`. Set `touch-action: none` in CSS. Never rely on hover, right click or a keyboard key.
- [ ] Keyboard: arrows and WASD for movement, Space or Enter for the main action. Call `preventDefault` on keys the game uses. Call `window.focus()` on the first `pointerdown`; a game iframe starts without keyboard focus.
- [ ] Add `viewport-fit=cover` and respect `env(safe-area-inset-*)` for HUD placement.
- [ ] Respect `prefers-reduced-motion`: no screen shake, fewer animations.
- [ ] Every screen has one obvious way to continue (tap or Space). Ignore stray input for about half a second after a game over screen appears.

## 7. Common mistakes

Check for each of these before you finish.

1. **`runEnd` called twice.** The most common bug. A death handler fires on every frame, or both a timer and a collision end the run. Use a `ended` flag per run and reset it only in the run start function.
2. **`ready()` never called**, or called before the first screen can take input, or only after a long asset load. Call it once, as soon as the title screen works.
3. **`Math.random` in scoring.** Spawn positions, drops, enemy choices and any other value that changes the outcome must come from `DegenHive.random(seed)`.
4. **`localStorage` for the best score.** Use `DegenHive.save`. `localStorage` does not follow the player across devices.
5. **Fixed canvas size.** `canvas.width = 800` with no resize handling. The iframe is not 800 wide.
6. **Mouse-only controls with `mobile: true`.** Hover, click on small targets, keyboard-only actions.
7. **Frame-rate-dependent logic.** Moving by a fixed amount per frame, or passing the raw `dt` into `step`. Use a fixed-step accumulator.
8. **A score that is not an integer**, is negative, or is over `maxScore`. `runEnd` rejects it.
9. **No mode badge.** The player must see whether points are on.
10. **Sound before a gesture.** Browsers block it. Create the `AudioContext` in a pointer or key handler.
11. **Ignoring `pause`.** The game keeps running behind a host sheet.
12. **Inline CSS** (`<style>`, `style=""`). Move it to a `.css` file.
13. **Calling `track` or `save.set` every frame.** Messages over the rate limit are queued or dropped, which delays real calls such as `runEnd`. A host that has to drop many messages closes the game.
14. **A library loaded without an exact version**, or from a host other than jsDelivr, cdnjs or unpkg.
15. **Minified or bundled output** committed as the game. Commit the readable source.

## 8. Test locally

Run these from the root of the `degenhive-games` repository. Run `npm install` once first. The checks use Playwright; if it has no browser yet, run `npx playwright install chromium`.

**1. Run the checks.** They are the same checks a submission gets, including a headless run of your game.

```
node scripts/checks/run.mjs --game games/<slug> --no-fail --shots shots
```

It prints one line per check. It loads the game in a desktop and a phone viewport for about a minute (`--seconds 20` for a shorter run), plays it, and reports: `ready()` timing, runs started and ended, scores, script errors, blocked requests and frame rate. Every line must be `pass`. `WARN` lines about missing `gitleaks` or `clamscan` are fine. `--shots <dir>` saves screenshots; look at them, because they are what the reviewer sees.

**2. Play it.** Put the build into a temporary storage root and serve it:

```
node scripts/deploy/deploy.mjs --game games/<slug> --local <dir>
node tools/edge-dev/server.mjs --root <dir>
```

`<dir>` is any empty folder outside the repository. Run the first command again after every change. The server uses the same routing, content policy and SDK injection as degenhive.ai and swaps library URLs for pinned copies. Open `http://<slug>.localhost:8790/` to play.

For a test with a host page, open `http://localhost:8790/__host?slug=<slug>&log=1`. The page frames the game, answers the SDK like degenhive.ai does and lists every message in a side panel: `ready`, `run.start`, `run.end`, saves and errors. Add `&mode=practice`, `&mode=points` or `&mode=preview` to change the session mode.

Opening `index.html` from disk, or serving `src/` with a plain static server, does not work: the SDK is added by the server, so `DegenHive` would be undefined.

**3. What to check by hand.**

1. The browser console has no errors or warnings from your code.
2. `ready` appears once in the host log, within a second or two of loading.
3. Play two full runs. Each run shows one `run.start` and one `run.end`. Never two `run.end` lines for the same run.
4. Hide the tab and show it again. The game pauses and continues. (With no host page, the SDK sends `pause` and `resume` when the tab is hidden and shown.)
5. Resize to a phone size (390 x 844) and a wide size (1280 x 720). Nothing is cut off or unreachable.
6. The best score is still there after a reload.

An upload preview at https://degenhive.ai/create is a third way to test: it runs the build on the real server and is valid for 24 hours.

## 9. Submit

- Upload the game directory as a zip on https://degenhive.ai/create.
- `npx degenhive deploy` will do the same from the command line. It is coming soon; do not use it yet.
- Or open a pull request that changes exactly one `games/<slug>/` directory.

The checks run first. Then review agents and a person look at it. A refused build comes with a message and a fix prompt; apply the fix and submit again.

## 10. Before you say you are done

- [ ] `game.json` is valid and the slug equals the directory name.
- [ ] `DegenHive.ready()` is called once.
- [ ] `runStart()` is called at the start of every run and its seed feeds `sim.init`.
- [ ] `runEnd({ score })` is called exactly once per run, with a whole number in range.
- [ ] `sim.js` has no `Math.random`, `Date`, `performance.now` or trig.
- [ ] The best score uses `DegenHive.save`.
- [ ] The mode badge shows Practice, Points on, Preview or Local test.
- [ ] Pause and mute work.
- [ ] The layout fits a phone and a desktop window. Touch works if `mobile` is `true`.
- [ ] No wallet APIs, no outer page access, no external requests, no minified code.
- [ ] The console is clean.

# Game protocol

This page covers three things:
- what a game build may contain;
- the `game.json` file;
- the SDK a game calls, and the messages between the game and the DegenHive page that hosts it.

A game runs in a sandboxed iframe on its own origin, `https://<slug>.<game domain>/`. The page around it is degenhive.ai. The game never touches a wallet. Anything that involves money happens in the host page.

## 1. Repository layout

```
games/<slug>/
  game.json      metadata (section 3)
  src/           the game's text files; the entry file is src/<entry>
  assets.json    binary files kept outside git (section 2.3)
```

A pull request changes exactly one `games/<slug>/` directory.

## 2. Build rules

### 2.1 Limits

| Rule | Limit |
|---|---|
| Entry file | `index.html` by default, at most 5 MB |
| Whole build | at most 30 MB |
| Files | at most 300 |
| Paths | relative only, lower-case ASCII letters, digits, `-`, `_`, `.` and `/`, at most 200 characters, no `..`. The `__dh/` path is reserved for DegenHive. |

### 2.2 File types

- **Text, kept in `src/`:** `html htm js mjs css json glsl frag vert txt md csv`
- **Binary, listed in `assets.json`:** `png jpg jpeg webp gif avif svg mp3 ogg wav m4a woff woff2 ttf otf glb gltf bin`
- **`wasm`:** allowed only after a human approves it for that game.
- **Anything else:** the build is refused.

### 2.3 assets.json

```json
{ "assets": { "img/bee.png": { "sha256": "<hex>", "bytes": 1234, "type": "image/png" } } }
```

The bytes are stored by hash. A game uses the path, for example `<img src="img/bee.png">`, and the server serves the bytes for that path.

### 2.4 Code rules

The checks refuse a build whose own code (libraries matched by hash are not checked):
- uses wallet APIs: `window.ethereum`, `window.solana`, `eth_` methods, `personal_sign`, `permit`, EIP-6963 events;
- reaches the outer page: `window.parent` or `window.top` outside the SDK, `window.open`, `document.domain`;
- opens a WebSocket or RTCPeerConnection, unless `backends` declares the origin;
- runs `eval` or `new Function` on decoded or fetched strings;
- holds miner code, or text that asks for a seed phrase, a private key or a wallet signature;
- holds text addressed to an AI reviewer;
- ships minified or obfuscated code of its own. Libraries are fine.

### 2.5 Libraries

Common libraries are swapped for pinned copies we host: three, phaser, pixi.js, howler, matter-js and tone. A game may load a pinned version of one of them from jsdelivr or unpkg, and the server rewrites those URLs to our copies when it serves the game. No other code may load from outside the build at runtime.

## 3. game.json

```json
{
  "schema": 1,
  "slug": "hive-runner",
  "title": "Hive Runner",
  "pitch": "Dodge the wasps, grab the honey, beat your best.",
  "owner": "0x0000000000000000000000000000000000000000",
  "entry": "index.html",
  "tags": ["arcade"],
  "controls": ["keyboard", "touch"],
  "mobile": true,
  "orientation": "any",
  "scored": true,
  "scoring": { "mode": "best", "maxScore": 1000000, "maxPointsPerSecond": 500, "minRunSeconds": 5 },
  "sim": null,
  "backends": [],
  "sdk": 1
}
```

| Field | Rule |
|---|---|
| `schema` | `1` |
| `slug` | 3 to 32 characters: `a-z`, `0-9` and `-`. It starts with a letter, does not end with `-`, and has no `--` (preview hosts use `--`). Fixed after the first merge. Unique. |
| `title` | 1 to 40 characters |
| `pitch` | 1 to 120 characters |
| `owner` | The owner's wallet address. Set by DegenHive and changed only by DegenHive. |
| `entry` | A path inside `src/`, default `index.html` |
| `tags` | 1 to 3 of: `arcade puzzle action strategy racing idle card word sports shooter platformer rhythm sim casual multiplayer` |
| `controls` | 1 or more of: `mouse keyboard touch gamepad` |
| `mobile` | `true` when the game works on a phone |
| `orientation` | `landscape`, `portrait` or `any` |
| `scored` | `true` when the game reports scores with `runEnd`. A Lab can only use a scored game. |
| `scoring.mode` | `best` (a player's best run in a session counts) or `sum` (the session's runs add up) |
| `scoring.maxScore` | The highest score one run can reach. 1 to 1,000,000. |
| `scoring.maxPointsPerSecond` | The highest `score / (durationMs / 1000)` a run may have. Faster runs are refused. |
| `scoring.minRunSeconds` | Shorter runs do not count |
| `sim` | `null`, or a path inside `src/` (for example `sim.js`) to the game's pure simulation: an ES module that exports `init(seed)`, `step(state, input, dt)`, `score(state)` and `isOver(state)`, with no `Math.random`, `Date` or `performance.now`. Replay checks will use it; until then reviewers read it. |
| `backends` | `https://` origins the game connects to. Each one needs a human approval. |
| `sdk` | `1` |

## 4. The SDK

The server adds the SDK to every HTML page of a build as `<script src="/__dh/sdk.js">`. It is the global `DegenHive`. A game written for local play can call the same API: with no host page around, the SDK runs in local mode.

```ts
DegenHive.version: string
DegenHive.ready(): void
DegenHive.session(): Promise<Session>
DegenHive.runStart(): Promise<{ runId: string; seed: number }>
DegenHive.runEnd(result: { score: number; log?: string }): Promise<RunResult>
DegenHive.save.get(): Promise<string | null>
DegenHive.save.set(data: string): Promise<void>
DegenHive.track(name: TrackName, props?: Record<string, string | number | boolean>): void
DegenHive.openLink(url: string): Promise<boolean>
DegenHive.on(event: "pause" | "resume" | "mute" | "sessionChanged" | "sessionEnding", fn: (payload) => void): () => void
DegenHive.random(seed: number): () => number

type Session = {
  mode: "practice" | "points" | "preview" | "local";
  player: { name: string; avatar: string | null; signedIn: boolean };
  lab: { id: string; name: string } | null;
  muted: boolean;
  locale: string;
}
type RunResult = { accepted: boolean; counted: boolean; best: number | null; reason?: string }
type TrackName = "level_start" | "level_complete" | "level_fail" | "funnel_step"
               | "gameplay_start" | "gameplay_stop" | "custom"
```

| Call | Rule |
|---|---|
| `ready()` | Call it once, when the first screen can take input. It must come within 10 seconds of load. |
| `runStart()` | Call it when a run begins. Use `seed` with `DegenHive.random(seed)` for any randomness that affects the score. |
| `runEnd()` | `log` is reserved for replay checks; leave it out for now. Call it once per run. A whole number, `0 ≤ score ≤ scoring.maxScore`. A second call for the same run is refused. Calling `runEnd` twice is the most common bug in AI-written games. |
| `save` | Up to 60 KB of text per player and game, kept by DegenHive. Use it instead of `localStorage` for anything that should follow the player across devices. |
| `track()` | Optional, for level funnels. Loads, sessions, heartbeats and errors are recorded with no call. |
| `openLink()` | Asks the host to show the link in a confirm sheet. Resolves `true` when the player opens it. |
| `random(seed)` | mulberry32. Same seed, same sequence, on every browser. |

**Mode** says what a run is worth:
- `points`: the player holds a pass, and the run counts for the Lab.
- `practice`: the run does not count.
- `preview`: a review or preview build.
- `local`: no host page.

The game should show the mode, so a player always knows if points are on.

**Local mode:**
- `session()` returns `mode: "local"`.
- `runStart()` returns a random seed.
- `runEnd()` logs the result and resolves `{ accepted: true, counted: false, best }`.
- `save` uses `localStorage`.

## 5. Messages between the game and the host

The SDK and the host page talk over a `MessageChannel`. A game never sends these messages itself; the SDK does.

### 5.1 Handshake

1. After the iframe loads, the host sends `{ dh: "hello", v: 1, origin: "<host origin>" }` to `iframe.contentWindow`, addressed to the game origin, and transfers `port2`.
2. The SDK takes the message only if it comes from `window.parent` and its `origin` is on the SDK's built-in host list. It then replies on the port with `{ v: 1, type: "hello.ack", sdk: "<version>" }`.
3. Everything after that goes over the port.
4. With no `hello` within 1,500 ms after the window `load` event, the SDK switches to local mode. The SDK also requires `event.origin` to equal `data.origin`, and a page that is not in a frame goes straight to local mode. A `hello` that arrives after the switch is ignored.

### 5.2 Envelope

```ts
type Request  = { v: 1; id: string; type: string; payload?: object }
type Response = { v: 1; re: string; ok: true; payload?: object }
              | { v: 1; re: string; ok: false; error: { code: string; message: string } }
type Event    = { v: 1; type: string; payload?: object }
```

| Limit | Value |
|---|---|
| Message size | at most 64 KB, except `run.end` with a log: 256 KB. Size is the UTF-8 byte length of the JSON-serialised message, measured the same way by the SDK and the host. |
| Rate | at most 20 messages a second |

The host drops a message that breaks a limit or the schema. After 50 drops it closes the game.

### 5.3 Game to host

| Type | Kind | Payload | Reply |
|---|---|---|---|
| `ready` | event | `{}` | |
| `session.get` | request | `{}` | `Session` |
| `run.start` | request | `{}` | `{ runId, seed }`, where `seed` is an unsigned 32-bit integer |
| `run.end` | request | `{ runId, score, durationMs, log? }`, where `durationMs` is wall-clock time from the `run.start` reply to the `runEnd` call, pauses included | `RunResult` |
| `save.get` | request | `{}` | `{ data: string \| null }` |
| `save.set` | request | `{ data }` | `{}` |
| `track` | event | `{ name, props? }` | |
| `link.open` | request | `{ url }` | `{ opened: boolean }` |
| `heartbeat` | event | `{ visible: boolean, fps?: number }` | (sent by the SDK every 30 s) |
| `error` | event | `{ message, source?, line? }` | (sent by the SDK on `window.onerror` and unhandled rejections) |

### 5.4 Host to game

| Type | Payload |
|---|---|
| `pause` | `{}` (the host opened a sheet, or the tab is hidden) |
| `resume` | `{}` |
| `mute` | `{ muted: boolean }` |
| `session.changed` | `Session` (for example, the player bought a pass and points are now on) |
| `session.ending` | `{ secondsLeft: number }` (the Lab session closes soon) |

### 5.5 Errors

| `code` | Meaning |
|---|---|
| `bad_request` | The payload does not match the schema |
| `rate_limited` | Too many messages |
| `run_unknown` | No such run, or it has already ended |
| `run_rejected` | The run broke a scoring rule. `message` says which. |
| `too_large` | The payload is over its limit |
| `unavailable` | The host or server could not answer. Try again later. |

## 6. Where a game is served

| Kind | Address |
|---|---|
| Live | `https://<slug>.<game domain>/`. The address never changes; each merged build replaces what is behind it. |
| Pull request preview | `https://pr-<number>--<slug>.<preview domain>/` |
| Upload preview | `https://up-<id>--<slug>.<preview domain>/`, valid for 24 hours |
| Local development | `http://<slug>.localhost:8790/`, served by `tools/edge-dev` |

Every response carries:
- a Content-Security-Policy:
  - `default-src 'self'`;
  - `script-src 'self' 'unsafe-inline' blob:`;
  - `style-src 'self' 'unsafe-inline'`;
  - `connect-src 'self'` plus the declared backends;
  - `img-src`, `media-src` and `font-src`: `'self' data: blob:`;
  - `worker-src 'self' blob:`;
  - `'wasm-unsafe-eval'` added to `script-src` only for a game whose wasm a human approved;
  - `frame-src 'none'`, `form-action 'none'`, `base-uri 'none'`, `object-src 'none'`;
  - `frame-ancestors` set to the DegenHive origins;
- a Permissions-Policy that turns off camera, microphone, location, payment, USB, serial, HID, Bluetooth, clipboard reading and publickey-credentials.

The server refuses service-worker scripts.

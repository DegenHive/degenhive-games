# Starter prompt

Paste this into Claude, ChatGPT, Cursor or any other AI coding tool to get a game that is ready for DegenHive. Replace the three parts in angle brackets, then send it.

Save the files it gives you into a folder, with the same paths. Then test and upload as described in [BUILDING.md](BUILDING.md).

## The prompt

````text
Make me a <describe your game idea in one or two sentences> game for DegenHive. It is a <2D canvas | 3D three.js> game. The slug is <my-game> (3 to 32 characters: a-z, 0-9 and -, starts with a letter, does not end with -, no double hyphen).

Follow these rules exactly.

OUTPUT
Give me every file as its own code block, with the file path above it. Complete files only, no "rest of the code here". Files:
- game.json
- assets.json
- src/index.html
- src/style.css
- src/game.js
- src/sim.js
Plain HTML, CSS and JavaScript (ES modules). No build step, no npm, no minified code, no frameworks. Keep comments short and only where they help.

BUILD RULES
- No images, audio files or fonts. Draw everything with canvas (or three.js primitives) and make sounds with WebAudio. Sound must start only after the first tap or key press.
- Put all CSS in src/style.css. No inline <style> and no style="..." attributes.
- No wallet code of any kind. Never use window.ethereum, window.solana, window.parent, window.top, window.open. Never ask the player for wallet secrets, approvals or signatures.
- No network requests, WebSockets or external scripts. The only exception is three.js, if the game is 3D: import it as
  import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
- Do not add a script tag for the DegenHive SDK. It is added for you. The global is `DegenHive`.

GAME.JSON
Use this shape. owner stays as it is.
{ "schema": 1, "slug": "<my-game>", "title": "<Title, 40 characters at most>", "pitch": "<one sentence, 120 characters at most>", "owner": "0x0000000000000000000000000000000000000000", "entry": "index.html", "tags": ["arcade"], "controls": ["keyboard", "mouse", "touch"], "mobile": true, "orientation": "any", "scored": true, "scoring": { "mode": "best", "maxScore": <highest possible score>, "maxPointsPerSecond": <fastest the score can grow, with a safe margin>, "minRunSeconds": 5 }, "sim": "sim.js", "backends": [], "sdk": 1 }
tags: 1 to 3 of arcade puzzle action strategy racing idle card word sports shooter platformer rhythm sim casual multiplayer. maxScore is a whole number up to 1000000. maxPointsPerSecond: the checks divide each run's score by its length in seconds and flag runs above this value, so set it well above the best honest rate, short runs included (measure it with a script that plays sim.js). minRunSeconds: a run shorter than this does not count for points, but must still end with runEnd; use 5. assets.json is exactly { "assets": {} }.

THE DEGENHIVE SDK (use these calls exactly)
- DegenHive.ready(): call once, as soon as the title screen shows and takes input. Attach all DegenHive.on handlers before it.
- await DegenHive.session(): returns { mode, muted, player, lab, locale }. mode is "practice", "points", "preview" or "local". Show it on screen as a small badge: Practice, Points on, Preview, Local test. Update it on the "sessionChanged" event; its payload is the new session object.
- await DegenHive.runStart(): call it when a run begins. It returns { runId, seed }, where seed is an unsigned 32-bit integer.
- DegenHive.random(seed): returns a seeded random function. Every random choice that affects the score or the difficulty must use it. Math.random is allowed only for visual effects.
- await DegenHive.runEnd({ score }): call it exactly ONCE per run, when the run is over. score is a whole number from 0 to maxScore. Do not pass a log. Use a flag per run so a second call is impossible. Calling it twice is the most common bug.
- await DegenHive.save.get() and DegenHive.save.set(string): keep the best score here. Do not use localStorage.
- DegenHive.on("pause", fn) and DegenHive.on("resume", fn): stop and continue the game.
- DegenHive.on("mute", ({ muted }) => ...): mute all sound. session.muted is the initial value.
Wrap SDK calls in try/catch. If runStart fails, let the player play an unscored run and do not call runEnd for it.

SIM.JS
Put all scoring logic in src/sim.js as pure functions, exported by name: export function init(seed, random), step(state, input, dt), score(state), isOver(state). In sim.js: no DOM, no Math.random, no Date, no performance.now, no Math.sin/cos/pow/exp. The random generator comes from the second argument of init. game.js runs step with a fixed dt of 1/60 from an accumulator loop, and draws the state. Events for sounds and particles go in state.events, which game.js empties.

CONTROLS AND LAYOUT
- Touch and keyboard both work. Use pointer events on window (pointerdown, pointermove, pointerup), touch-action: none in CSS, arrows or WASD plus Space or Enter on the keyboard. Call window.focus() on the first pointerdown.
- The canvas fills the window and is resized with a ResizeObserver and devicePixelRatio (capped at 2). Fit a fixed logical play field into the window so it works in portrait and landscape.
- Screens: a title screen with the best score and "Tap or press Space to start", a game over screen with the score, the best score and "Play again", and a paused screen.
- Respect prefers-reduced-motion: no screen shake.

QUALITY
It must feel good: easing, small particles, a light screen shake on hits, synthesized sound effects. Difficulty rises over time. The game must be fair and playable from the first second.

At the end, list the files I should create. Then check the list below and tell me if anything is not true.
- ready() is called once
- runStart() at the start of every run, its seed feeds sim.init
- runEnd called exactly once per run
- no Math.random in sim.js
- best score in DegenHive.save
- mode badge on screen
- pause and mute work
- layout fits a phone and a desktop window
````

For a game that is more than a toy, add one more paragraph describing the mechanics in detail: what the player controls, what hurts, what scores, how difficulty rises.

## If you can give the AI the starter files

If your tool can read the repository (Claude Code, Cursor, Codex), skip the long prompt. Tell it:

```text
Read starter/AGENTS.md and docs/PROTOCOL.md. Copy starter/canvas to games/<slug>. Make it a <idea> game. Follow AGENTS.md.
```

Use `starter/three` for a 3D game.

## Fix prompts

Fix one thing per message. Paste the exact text of the problem. Ask for complete changed files.

**A check refused the game.** Paste the check message and the fix prompt that came with it.

```text
The DegenHive checks refused my game:

<paste the message>

Fix only that. Keep the rest of the game as it is. Return the complete changed files.
```

**Something does not work.**

```text
When I <do this>, <this happens>. I expected <that>.
The browser console shows: <paste the error, or write "nothing">.
Find the cause and fix it. Return the complete changed files, and say which lines changed.
```

**It breaks on a phone or in a narrow window.**

```text
On a phone (portrait, about 390 x 800) the game <describe the problem>.
Fix the layout and the touch controls. Every action must work by touch alone. Use pointer events and resize with a ResizeObserver.
```

**The score looks wrong or a run counts twice.**

```text
Check the run flow. DegenHive.runStart() must be called once per run, and DegenHive.runEnd({ score }) exactly once per run, with a whole number between 0 and maxScore. List every place that can call runEnd, and make each run end go through one function with a per-run flag.
```

**A reviewer asked for a change.**

```text
A reviewer asked: <paste the comment>.
Make the smallest change that does it. Do not touch anything else. Return the complete changed files.
```

**Add a feature.**

```text
Add <feature>. Keep all scoring logic in sim.js with no Math.random, Date or performance.now. If the maximum score or the score growth rate changes, tell me the new maxScore and maxPointsPerSecond for game.json.
```

Tips:
- Paste real error text, not a description of it.
- When the AI changes the rules of the game, ask it for the new `maxScore` and `maxPointsPerSecond`, and update `game.json`.
- After every change, play two full runs and read the console.

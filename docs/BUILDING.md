# Building a game for DegenHive

This guide is for the person who makes the game. You can write it yourself or have an AI write it. The technical contract is [PROTOCOL.md](PROTOCOL.md).

A game goes through five steps:

1. Make it.
2. Test it on your computer.
3. Upload it.
4. It is reviewed: checks, then an agent, then a person.
5. It goes live at `https://<slug>.<game domain>/`.

## 1. Make it

A game is one directory:

```
my-game/
  game.json     name, controls, scoring
  src/          the game's text files (HTML, CSS, JavaScript)
  assets.json   images and sounds, if any
```

Pick one way to start.

**With an AI.** Open [PROMPT.md](PROMPT.md), copy the prompt, fill in your idea and paste it into Claude, ChatGPT or Cursor. Save the files it gives you. If your tool can read this repository, point it at `starter/AGENTS.md` instead.

**From a template.** Copy `starter/canvas` (2D) or `starter/three` (3D) and change it. Two finished games are in `examples/`: `hive-runner` (2D) and `honey-stack` (3D). Read them to see how the SDK is used.

The three things every game must do:

- Call `DegenHive.ready()` once, when the first screen can take input.
- Call `DegenHive.runStart()` when a run begins and `DegenHive.runEnd({ score })` once when it ends.
- Keep the best score with `DegenHive.save`, not `localStorage`.

Rules about what a build may contain:

- Text files in `src/`: `html htm js mjs css json glsl frag vert txt md csv`.
- Images, sounds, fonts and models are listed in `assets.json`. You do not need any: draw with canvas or three.js and make sounds with WebAudio.
- At most 30 MB in all, 300 files, 5 MB for the entry file.
- No wallet code, no reaching the page around the game, no outside requests. Libraries (three, phaser, pixi.js, howler, matter-js, tone) can be loaded from jsDelivr or cdnjs with an exact version.
- Your own code must be readable. Minified or obfuscated code is refused.
- Put CSS in a `.css` file, not in inline `<style>` blocks or `style` attributes.

## 2. Test it

Work from a clone of this repository. Run `npm install` once. The checks use Playwright; if it has no browser yet, run `npx playwright install chromium`.

**Run the checks.** They are the same checks a submission gets, including a headless run of your game:

```
node scripts/checks/run.mjs --game games/<slug> --no-fail --shots shots
```

It prints one line per check. It loads the game in a desktop and a phone viewport, plays it, and reports when `ready()` was called, how many runs started and ended, script errors and blocked requests. Every line must say `pass`. Warnings about `gitleaks` or `clamscan` are fine. The screenshots in `shots/` are what the reviewer sees.

**Play it yourself.** Put the build into a temporary folder and serve it:

```
node scripts/deploy/deploy.mjs --game games/<slug> --local <dir>
node tools/edge-dev/server.mjs --root <dir>
```

`<dir>` is any empty folder outside the repository. Run the first command again after every change. Then open `http://<slug>.localhost:8790/`. To play inside a test host page that answers the SDK like degenhive.ai and lists every message the game sends, open `http://localhost:8790/__host?slug=<slug>&log=1`.

Opening `index.html` from disk does not work, because the SDK is added by the server.

**Upload preview.** You can also zip the game directory and upload it at https://degenhive.ai/create. You get a preview link at once. It runs on the real server and is valid for 24 hours. Nothing goes to review until you submit it.

Check these by hand:

- The console has no errors.
- The title screen works within a second or two of loading, and `ready` shows once in the host log.
- Play two full runs. Each run shows one `run.start` and one `run.end`.
- Hide the tab and show it again. The game pauses and continues.
- Make the window phone-sized (390 x 844) and then wide (1280 x 720). Nothing is cut off. If `mobile` is `true` in `game.json`, everything works with touch only.
- The mode badge shows on screen.
- The best score is still there after a reload.

## 3. Upload it

Pick one way. Each ends in a pull request that changes exactly one `games/<slug>/` directory.

- **Upload on the site.** Zip the game directory and upload it at https://degenhive.ai/create. You get a preview link that works for 24 hours (`https://up-<id>--<slug>.<preview domain>/`). When it works, submit it. That opens a pull request for you.
- **Open the pull request yourself.** Put the directory at `games/<slug>/` and open a pull request. It gets a preview link too (`https://pr-<number>--<slug>.<preview domain>/`).
- **Command line.** `npx degenhive deploy` is coming soon. It will do the same as the upload.

Your slug is the name of the game's address. It has 3 to 32 characters (`a-z`, `0-9`, `-`), starts with a letter, does not end with `-` and has no `--`. It cannot change after the first merge. It must be unique.

## 4. Review

Three things look at every pull request, in order.

1. **Checks.** A program reads every file and plays the game in a headless browser, on a desktop and a phone screen. It refuses a build that has wallet code, reaches the outer page, opens sockets that are not declared, uses `eval` on fetched text, is minified, holds miner code or asks for wallet secrets or signatures. It also validates `game.json`, the limits and the file types. A refusal comes with a message and a short fix prompt you can paste into your AI.
2. **A review agent.** It reads the code, `game.json`, the checks report and the screenshots from the checks run. It never runs the game. Its verdict is advice.
3. **A person.** Reads the report and merges, or asks for changes.

What reviewers look for:

- The game loads and `ready()` is called.
- A full run works and `runEnd` is called once per run, with a whole number between 0 and `maxScore`.
- Controls match `game.json`. A game with `mobile: true` is playable on a phone.
- The scoring numbers fit the game: the best real run is under `maxScore`, and `maxPointsPerSecond` is above the best honest rate.
- Scored games take their randomness from the run seed, and `sim.js` is pure.
- No hidden branches: no special cases for an owner, a date, a key sequence, a URL parameter or a player name.
- The mode badge is shown. The game does not compute or claim rewards.
- No wallet prompts, fake "claim" or "connect" screens, or titles and screens that mislead about money.
- No outside requests. `backends` and `wasm` are used only when a person approved them.
- You have the right to use everything in the game (code, art, sound, names).
- The content is suitable for a general audience.

The rubric is in [REVIEW.md](REVIEW.md).

## 5. Live

When the pull request is merged, the game is live at `https://<slug>.<game domain>/`. The address never changes.

To update a live game, make the change and open a new pull request on the same directory. Each merged build replaces what is behind the address. The slug stays the same; the owner is set by DegenHive.

## How scoring works

A game that sets `scored: true` reports every run with `DegenHive.runEnd({ score })`. What a run is worth depends on the session mode, which `DegenHive.session()` returns and the game shows as a badge:

| Mode | Badge | What it means |
|---|---|---|
| `points` | Points on | The player holds a pass and the run counts for the Lab. |
| `practice` | Practice | The run does not count. |
| `preview` | Preview | A review or preview build. |
| `local` | Local test | No DegenHive page around the game. |

A Lab can only use a scored game.

`scoring` in `game.json` sets the rules:

| Field | Meaning |
|---|---|
| `mode: "best"` | A player's best run in a session counts. |
| `mode: "sum"` | The runs in a session add up. |
| `maxScore` | The highest score one run can reach, 1 to 1,000,000. A higher score is refused. |
| `maxPointsPerSecond` | The fastest the score can grow. The checks compare a run's score divided by its length in seconds with this value and flag runs above it. |
| `minRunSeconds` | A floor. A run shorter than this does not count for points. |

Scores are whole numbers. The run length is measured from the `runStart` reply to the `runEnd` call, so pauses count.

How to pick the numbers:

- `maxScore`: the highest score a perfect player could reach in a run, rounded up. If a run can go on without end, make the game cap the score at this value.
- `maxPointsPerSecond`: play with a bot or a script that runs `sim.js`, find the best honest score per second, short runs included, and set the value well above it.
- `minRunSeconds`: about the shortest run a real player can finish. Use 5 if you are unsure. Short runs must still end with `runEnd`.

Randomness that changes the outcome comes from the seed `runStart` returns, through `DegenHive.random(seed)`. This keeps runs fair and lets DegenHive check them later. Keep the rules in `sim.js` without `Math.random`, `Date` or `performance.now`.

## game.json at a glance

```json
{
  "schema": 1,
  "slug": "hive-runner",
  "title": "Hive Runner",
  "pitch": "Dodge the wasps, grab the honey, beat your best.",
  "owner": "0x0000000000000000000000000000000000000000",
  "entry": "index.html",
  "tags": ["arcade", "casual"],
  "controls": ["keyboard", "mouse", "touch"],
  "mobile": true,
  "orientation": "any",
  "scored": true,
  "scoring": { "mode": "best", "maxScore": 100000, "maxPointsPerSecond": 150, "minRunSeconds": 5 },
  "sim": "sim.js",
  "backends": [],
  "sdk": 1
}
```

`owner` is set by DegenHive; leave it as it is. The full field list is in [PROTOCOL.md](PROTOCOL.md).

## Common refusals

| Message | Fix |
|---|---|
| Uses an Ethereum or Solana wallet | Remove all wallet code. Use `DegenHive.session()` for the player's name. |
| Reaches the page around the game | Remove `window.parent`, `window.top`, `window.open`. Use `DegenHive.openLink(url)`. |
| Minified code | Commit the readable source, not the bundle. |
| Loads a script from outside the build | Use one of the listed libraries, from jsDelivr or cdnjs, with an exact version. |
| `ready()` was not called | Call `DegenHive.ready()` once, when the title screen works. |
| `runEnd` rejected | Call it once per run, with a whole number from 0 to `maxScore`. |

When a check refuses your game, paste its message into your AI together with the fix prompt, as shown in [PROMPT.md](PROMPT.md).

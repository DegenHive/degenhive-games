# degenhive-games

The games on DegenHive. Each game is a folder in `games/<slug>/`.

Every build is a pull request. Checks run on it, an agent reviews it, a human merges it, and the merge goes live at `https://<slug>.<game domain>/`.

## Layout

| Path | What it is |
|---|---|
| `games/<slug>/` | One game: `game.json`, `src/` (text files) and `assets.json` (binaries, stored by hash outside git) |
| `docs/PROTOCOL.md` | The rules for a game: files, `game.json`, the SDK and the messages to the host page |
| `docs/BUILDING.md` | How to build a game, with the starter templates |
| `docs/REVIEW.md` | The review rubric |
| `packages/sdk/` | The SDK, served to every game as `/__dh/sdk.js` |
| `starter/`, `examples/` | Templates and example games |
| `schemas/` | JSON Schemas for `game.json`, `assets.json`, `checks.json` and the verdict |
| `rules/static-rules.json` | The code rules and the pinned library files |
| `scripts/checks/` | The pull-request checks, including the sandbox run |
| `scripts/review/` | The agent review and the pull-request comment |
| `scripts/deploy/` | The deploy to Cloudflare R2 and KV |
| `edge/` | The Cloudflare Worker that serves games |
| `tools/edge-dev/` | The same server for local use |
| `.github/workflows/` | `checks.yml`, `review.yml`, `deploy.yml` |

## Add a game

Read [docs/BUILDING.md](docs/BUILDING.md), then [docs/PROTOCOL.md](docs/PROTOCOL.md). Submit the game from degenhive.ai or with the `degenhive` CLI; that opens the pull request for you. A pull request changes only one `games/<slug>/` folder.

## Run the checks locally

Node 20 or later.

```sh
npm ci
npx playwright install chromium
node scripts/checks/run.mjs --game games/<slug> --base origin/main --assets-root <dir>
```

This writes `checks.json` and the sandbox screenshots. `--assets-root` is a folder holding `assets/<sha256>` files; without it the asset hashes are not verified. `--seconds 20` shortens the sandbox run, `--no-sandbox` skips it. `gitleaks` and `clamscan` are used when they are installed.

## Play a game locally

```sh
node scripts/deploy/deploy.mjs --game games/<slug> --local ../games-data --assets-root <dir>
node tools/edge-dev/server.mjs --root ../games-data --port 8790
```

Open `http://<slug>.localhost:8790/` for the game alone, or `http://localhost:8790/__host?slug=<slug>&log=1` for a test host page that does the SDK handshake and logs every message. Previews are served at `http://pr-<n>--<slug>.localhost:8790/` and `http://up-<id>--<slug>.localhost:8790/`.

## Pipeline

- `checks.yml` runs on every pull request that touches `games/`. It has no secrets and a read-only token, and runs the checks code from the base branch.
- `review.yml` runs after the checks. It reads their results and the pull-request diff as text, never runs the game, asks Claude for a verdict, and posts one comment, the labels and the `degenhive/agent-review` status.
- `deploy.yml` runs on a push to `main` and deploys each changed game.

| Name | Kind | Used by |
|---|---|---|
| `ANTHROPIC_API_KEY` | secret | review. Without it the verdict is "Agent review not configured" and no status is posted. |
| `CF_API_TOKEN`, `CF_ACCOUNT_ID` | secrets | deploy |
| `GAMES_API_BASE`, `GAMES_DEPLOY_SECRET` | secrets | deploy callback to the backend |
| `GAMES_KV_NAMESPACE_ID`, `R2_BUCKET` | variables | deploy (`R2_BUCKET` defaults to `dh-games`) |
| `REVIEW_MODEL` | variable | review (defaults to `claude-sonnet-5-5`) |
| `GAMES_ASSETS_URL` | variable | checks: a public URL that serves `<url>/<sha256>` for asset checks |

Branch protection on `main`: require the `checks` job, the `degenhive/agent-review` status once the review key is set, and one approval from `@DegenHive/game-reviewers`.

## Edge

`edge/` holds the Worker. Routing and headers are in `edge/src/core.mjs`, shared with `tools/edge-dev`. It is not deployed yet; `edge/wrangler.toml` has placeholders for the domains and the KV namespace.

```sh
cd edge
npx wrangler@4.146.0 dev --env dev
npx wrangler@4.146.0 deploy
```

## Tests

```sh
npm test            # unit tests
npm run test:e2e    # a game pull request end to end, with the sandbox run in Chromium
```

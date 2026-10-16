<!--
A game pull request changes only games/<slug>/. Pull requests opened from the DegenHive site or
the degenhive CLI fill this in for you.
-->

## Game

- Slug:
- New game or update:
- What changed:

## Checklist

- [ ] Only files inside `games/<slug>/` are changed.
- [ ] `game.json` follows [docs/PROTOCOL.md](../docs/PROTOCOL.md) section 3.
- [ ] Images, audio, fonts and models are listed in `assets.json`, not committed.
- [ ] `DegenHive.ready()` is called once; `DegenHive.runEnd()` once per run.
- [ ] No wallet code, no requests to other servers, no minified code of my own.

<!--
For a change to the pipeline (scripts, edge, rules, schemas, workflows) instead: say what changes,
why, and how you tested it (npm test, and a checks run on a game).
-->

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateGameJson, validateAssetsJson, validate } from "../scripts/checks/lib/schema.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/games/tiny-canvas/game.json", import.meta.url), "utf8"));
const good = () => structuredClone(fixture);
const errorsFor = (patch) => {
  const g = good();
  patch(g);
  return validateGameJson(g);
};
const hasError = (errors, path) => errors.some((e) => e.path === path);

test("the fixture game.json is valid", () => {
  assert.deepEqual(validateGameJson(good()), []);
});

test("the PROTOCOL.md example is valid", () => {
  const example = {
    schema: 1,
    slug: "hive-runner",
    title: "Hive Runner",
    pitch: "Dodge the wasps, grab the honey, beat your best.",
    owner: "0x0000000000000000000000000000000000000000",
    entry: "index.html",
    tags: ["arcade"],
    controls: ["keyboard", "touch"],
    mobile: true,
    orientation: "any",
    scored: true,
    scoring: { mode: "best", maxScore: 1000000, maxPointsPerSecond: 500, minRunSeconds: 5 },
    sim: null,
    backends: [],
    sdk: 1,
  };
  assert.deepEqual(validateGameJson(example), []);
});

test("optional fields may be left out", () => {
  const g = good();
  delete g.entry;
  delete g.sim;
  delete g.backends;
  assert.deepEqual(validateGameJson(g), []);
});

test("slug rules", () => {
  for (const bad of ["ab", "1abc", "Abc", "a_bc", "a".repeat(33), "abc!", "bee--game", "bee-", "a--"]) {
    assert.ok(hasError(errorsFor((g) => (g.slug = bad)), "/slug"), bad);
  }
  for (const ok of ["abc", "a-b", "hive-runner-2", "a".repeat(32), "a-b-c-d"]) {
    assert.ok(!hasError(errorsFor((g) => (g.slug = ok)), "/slug"), ok);
  }
});

test("title and pitch lengths count characters", () => {
  assert.ok(hasError(errorsFor((g) => (g.title = "")), "/title"));
  assert.ok(hasError(errorsFor((g) => (g.title = "   ")), "/title"));
  assert.ok(hasError(errorsFor((g) => (g.title = "x".repeat(41))), "/title"));
  assert.ok(!hasError(errorsFor((g) => (g.title = "🐝".repeat(40))), "/title"));
  assert.ok(hasError(errorsFor((g) => (g.pitch = "x".repeat(121))), "/pitch"));
});

test("owner must be an address", () => {
  assert.ok(hasError(errorsFor((g) => (g.owner = "0x123")), "/owner"));
  assert.ok(hasError(errorsFor((g) => (g.owner = "alice.eth")), "/owner"));
});

test("tags and controls", () => {
  assert.ok(hasError(errorsFor((g) => (g.tags = [])), "/tags"));
  assert.ok(hasError(errorsFor((g) => (g.tags = ["arcade", "puzzle", "action", "word"])), "/tags"));
  assert.ok(hasError(errorsFor((g) => (g.tags = ["arcade", "arcade"])), "/tags"));
  assert.ok(hasError(errorsFor((g) => (g.tags = ["fps"])), "/tags/0"));
  assert.ok(hasError(errorsFor((g) => (g.controls = [])), "/controls"));
  assert.ok(hasError(errorsFor((g) => (g.controls = ["joystick"])), "/controls/0"));
});

test("scored games need scoring; unscored games do not", () => {
  assert.ok(errorsFor((g) => delete g.scoring).some((e) => e.message.includes('"scoring"')));
  assert.ok(errorsFor((g) => (g.scoring = null)).length > 0);
  assert.deepEqual(
    errorsFor((g) => {
      g.scored = false;
      delete g.scoring;
    }),
    [],
  );
  assert.deepEqual(
    errorsFor((g) => {
      g.scored = false;
      g.scoring = null;
    }),
    [],
  );
});

test("scoring limits", () => {
  assert.ok(hasError(errorsFor((g) => (g.scoring.maxScore = 0)), "/scoring/maxScore"));
  assert.ok(hasError(errorsFor((g) => (g.scoring.maxScore = 1000001)), "/scoring/maxScore"));
  assert.ok(hasError(errorsFor((g) => (g.scoring.maxScore = 1.5)), "/scoring/maxScore"));
  assert.ok(hasError(errorsFor((g) => (g.scoring.maxPointsPerSecond = 0)), "/scoring/maxPointsPerSecond"));
  assert.ok(hasError(errorsFor((g) => (g.scoring.minRunSeconds = -1)), "/scoring/minRunSeconds"));
  assert.ok(hasError(errorsFor((g) => (g.scoring.mode = "max")), "/scoring/mode"));
  assert.ok(hasError(errorsFor((g) => (g.scoring.extra = 1)), "/scoring/extra"));
});

test("entry and sim are relative paths inside src", () => {
  for (const bad of ["../index.html", "/index.html", "Index.html", "a//b.html", "game.js", "__dh/x.html"]) {
    assert.ok(errorsFor((g) => (g.entry = bad)).length > 0, bad);
  }
  assert.deepEqual(errorsFor((g) => (g.entry = "play/index.htm")), []);
  assert.deepEqual(errorsFor((g) => (g.sim = "sim.js")), []);
  assert.ok(errorsFor((g) => (g.sim = "sim.ts")).length > 0);
});

test("backends are https origins", () => {
  assert.deepEqual(errorsFor((g) => (g.backends = ["https://api.example.com", "https://x.example.com:8443"])), []);
  for (const bad of ["http://api.example.com", "https://api.example.com/path", "wss://api.example.com", "https://localhost", "https://API.example.com"]) {
    assert.ok(errorsFor((g) => (g.backends = [bad])).length > 0, bad);
  }
});

test("schema and sdk are fixed, unknown fields are refused", () => {
  assert.ok(hasError(errorsFor((g) => (g.schema = 2)), "/schema"));
  assert.ok(hasError(errorsFor((g) => (g.sdk = 2)), "/sdk"));
  assert.ok(hasError(errorsFor((g) => (g.reward = 5)), "/reward"));
  assert.ok(errorsFor((g) => delete g.title).some((e) => e.message.includes('"title"')));
});

test("assets.json", () => {
  const sha = "a".repeat(64);
  assert.deepEqual(validateAssetsJson({ assets: { "img/a.png": { sha256: sha, bytes: 10, type: "image/png" } } }), []);
  assert.deepEqual(validateAssetsJson({ assets: {} }), []);
  assert.ok(validateAssetsJson({ assets: { "a.png": { sha256: "xyz", bytes: 10, type: "image/png" } } }).length > 0);
  assert.ok(validateAssetsJson({ assets: { "a.png": { sha256: sha, bytes: -1, type: "image/png" } } }).length > 0);
  assert.ok(validateAssetsJson({ files: {} }).length > 0);
});

test("validator: anyOf reports the closest branch", () => {
  const schema = { anyOf: [{ type: "null" }, { type: "object", required: ["a"], properties: { a: { type: "integer" } } }] };
  assert.deepEqual(validate(schema, null), []);
  const errs = validate(schema, { a: "x" });
  assert.equal(errs.length, 1);
  assert.equal(errs[0].path, "/a");
});

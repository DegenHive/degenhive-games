import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sha256Hex, buildHash, buildHashInput } from "../scripts/lib/hash.mjs";
import { loadGame, buildFiles, gameBuildHash } from "../scripts/lib/game.mjs";

const h = (s) => createHash("sha256").update(s).digest("hex");

test("file hash is sha256 of the bytes", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("build hash input is <path>\\t<sha256>\\n per file, sorted by path", () => {
  const files = [
    { path: "b.js", sha256: h("b") },
    { path: "a/z.png", sha256: h("z") },
    { path: "index.html", sha256: h("i") },
    { path: "a.js", sha256: h("a") },
  ];
  assert.equal(buildHashInput(files), `a.js\t${h("a")}\na/z.png\t${h("z")}\nb.js\t${h("b")}\nindex.html\t${h("i")}\n`);
  assert.equal(buildHash(files), h(buildHashInput(files)));
});

test("build hash does not depend on input order", () => {
  const files = [
    { path: "x.js", sha256: h("1") },
    { path: "y.js", sha256: h("2") },
    { path: "img/x.png", sha256: h("3") },
  ];
  assert.equal(buildHash(files), buildHash([...files].reverse()));
});

test("build hash sorts by code unit, not locale", () => {
  // "B" (0x42) < "_" (0x5f) < "a" (0x61); localeCompare would put "_" first.
  const input = buildHashInput([
    { path: "a.js", sha256: h("a") },
    { path: "_.js", sha256: h("_") },
    { path: "B.js", sha256: h("B") },
  ]);
  assert.deepEqual(
    input.trim().split("\n").map((l) => l.split("\t")[0]),
    ["B.js", "_.js", "a.js"],
  );
});

test("build hash refuses bad entries", () => {
  assert.throws(() => buildHash([{ path: "a", sha256: "nothex" }]));
  assert.throws(() => buildHash([{ path: "a", sha256: h("1") }, { path: "a", sha256: h("2") }]));
});

test("a game's build hash covers src files and assets.json entries", () => {
  const game = loadGame(new URL("./fixtures/games/tiny-canvas", import.meta.url).pathname);
  const files = buildFiles(game);
  assert.deepEqual(
    files.map((f) => [f.path, f.store]),
    [
      ["game.js", "src"],
      ["index.html", "src"],
      ["img/dot.png", "asset"],
    ],
  );
  assert.equal(gameBuildHash(game), buildHash(files));
  assert.match(gameBuildHash(game), /^[0-9a-f]{64}$/);
});

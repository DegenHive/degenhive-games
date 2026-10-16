// Compiled by `npm run typecheck` against dist/sdk.d.ts. Not executed.
import DegenHive, { type Session, type RunResult, type DegenHiveError } from "../../dist/sdk";

async function loop(): Promise<void> {
  const session: Session = await DegenHive.session();
  const mode: "practice" | "points" | "preview" | "local" = session.mode;
  const { runId, seed } = await DegenHive.runStart();
  const rand = DegenHive.random(seed);
  const n: number = rand();
  const result: RunResult = await DegenHive.runEnd({ score: Math.floor(n * 100), log: runId });
  const best: number | null = result.best;
  const saved: string | null = await DegenHive.save.get();
  await DegenHive.save.set(JSON.stringify({ best, saved, mode }));
  DegenHive.track("level_complete", { level: 1, perfect: true, name: "x" });
  const opened: boolean = await DegenHive.openLink("https://example.org");
  const off: () => void = DegenHive.on("mute", (p) => {
    const muted: boolean = p.muted;
    void muted;
  });
  DegenHive.on("sessionEnding", (p) => void p.secondsLeft.toFixed());
  DegenHive.on("sessionChanged", (p) => void p.player.name.length);
  DegenHive.on("pause", () => {});
  off();
  void opened;
  try {
    DegenHive.ready();
  } catch (e) {
    const code = (e as DegenHiveError).code;
    void code;
  }
}
void loop;

// @ts-expect-error unknown track name
DegenHive.track("nope");
// @ts-expect-error unknown event
DegenHive.on("paused", () => {});
// @ts-expect-error score must be a number
DegenHive.runEnd({ score: "10" });
// @ts-expect-error props must be string, number or boolean
DegenHive.track("custom", { a: { b: 1 } });
// @ts-expect-error save takes a string
DegenHive.save.set(1);

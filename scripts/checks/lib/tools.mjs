// Outside scanners: gitleaks (secrets) and ClamAV (malware). Each is skipped with a warning
// when it is not on PATH.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

function onPath(cmd, args = ["--version"]) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return !r.error;
}

export function secretsItem(gameDir) {
  const key = "secrets";
  const label = "No secrets";
  if (!onPath("gitleaks", ["version"])) return { key, label, status: "warn", detail: "gitleaks is not installed; secrets were not scanned." };
  const tmp = mkdtempSync(join(tmpdir(), "dh-gitleaks-"));
  const report = join(tmp, "report.json");
  try {
    let r = spawnSync("gitleaks", ["dir", gameDir, "--no-banner", "--redact", "--exit-code", "0", "--report-format", "json", "--report-path", report], { encoding: "utf8" });
    if (r.status !== 0 && /unknown command|Usage:/i.test(r.stderr + r.stdout)) {
      r = spawnSync("gitleaks", ["detect", "--no-git", "--source", gameDir, "--no-banner", "--redact", "--exit-code", "0", "--report-format", "json", "--report-path", report], { encoding: "utf8" });
    }
    if (r.status !== 0 || !existsSync(report)) {
      return { key, label, status: "warn", detail: `gitleaks did not finish: ${String(r.stderr || r.stdout).trim().split("\n").pop()}` };
    }
    const findings = JSON.parse(readFileSync(report, "utf8") || "[]");
    if (!findings.length) return { key, label, status: "pass", detail: "gitleaks found no secrets." };
    const where = findings.slice(0, 8).map((f) => `${relative(gameDir, f.File || f.file || "")}:${f.StartLine || f.startLine || 0} (${f.RuleID || f.ruleID || f.Description})`);
    return {
      key,
      label,
      status: "fail",
      detail: `gitleaks found ${findings.length} possible secret(s): ${where.join(", ")}.`,
      fixPrompt: `Remove the API keys, tokens or passwords at ${where.join(", ")} from the game. A browser game cannot keep a secret: anything in it is public. Revoke the exposed keys, and move any call that needs a key to a server declared in game.json "backends".`,
    };
  } catch (e) {
    return { key, label, status: "warn", detail: `gitleaks failed: ${e.message}` };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function malwareItem(paths) {
  const key = "malware";
  const label = "Malware scan";
  if (!onPath("clamscan")) return { key, label, status: "warn", detail: "ClamAV (clamscan) is not installed; files were not scanned." };
  const targets = paths.filter((p) => existsSync(p));
  if (!targets.length) return { key, label, status: "pass", detail: "Nothing to scan." };
  const r = spawnSync("clamscan", ["--no-summary", "--infected", "--recursive", "--stdout", ...targets], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status === 0) return { key, label, status: "pass", detail: `ClamAV found nothing in ${targets.length} location(s).` };
  if (r.status === 1) {
    const hits = String(r.stdout)
      .split("\n")
      .filter((l) => / FOUND$/.test(l))
      .map((l) => l.replace(/^.*\/(games\/[^:]+|assets\/[0-9a-f]{8})[0-9a-f]*:/, "$1:"));
    return {
      key,
      label,
      status: "fail",
      detail: `ClamAV flagged ${hits.length} file(s): ${hits.slice(0, 6).join("; ")}.`,
      fixPrompt: "Remove the flagged files from the game, scan your machine, and rebuild the game from clean sources.",
    };
  }
  return { key, label, status: "warn", detail: `clamscan could not finish: ${String(r.stderr || r.stdout).trim().split("\n").pop()}` };
}

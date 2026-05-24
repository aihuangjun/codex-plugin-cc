import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

// Guard against test runs polluting the real user plugin data dir. If
// CLAUDE_PLUGIN_DATA is unset or points outside the OS tmpdir (which is what
// happens when `npm test` is invoked from a Claude Code session that inherits
// the host plugin path), redirect it to a per-suite tmp dir so any state the
// companion script writes lands somewhere we can ignore.
const TMPDIR_REAL = (() => {
  try {
    return fs.realpathSync.native(os.tmpdir());
  } catch {
    return os.tmpdir();
  }
})();

function isInsideTmpdir(target) {
  if (!target) {
    return false;
  }
  let resolved = target;
  try {
    resolved = fs.realpathSync.native(target);
  } catch {
    resolved = path.resolve(target);
  }
  const tmpdirWithSep = TMPDIR_REAL.endsWith(path.sep) ? TMPDIR_REAL : `${TMPDIR_REAL}${path.sep}`;
  return resolved === TMPDIR_REAL || resolved.startsWith(tmpdirWithSep);
}

if (!isInsideTmpdir(process.env.CLAUDE_PLUGIN_DATA)) {
  process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-test-suite-"));
}

// Default to fully-isolated state scanning. Tests that want to verify the
// multi-root fallback behavior can override CODEX_COMPANION_LEGACY_ROOTS in
// their own setup.
if (process.env.CODEX_COMPANION_LEGACY_ROOTS == null) {
  process.env.CODEX_COMPANION_LEGACY_ROOTS = "";
}

// Drop the session id inherited from the host Claude Code session. Otherwise
// status/result tests that seed fixture jobs without a sessionId hit the
// filterJobsForCurrentSession path and see an empty list. Tests that
// intentionally exercise session-scoped filtering set the env explicitly when
// spawning subprocesses.
delete process.env.CODEX_COMPANION_SESSION_ID;

export function makeTempDir(prefix = "codex-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: process.platform === "win32" && !path.isAbsolute(command),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}

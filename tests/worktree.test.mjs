import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import {
  resolveWorktreePath,
  generateWorktreeBranch,
  createWorktree
} from "../plugins/codex/scripts/lib/workspace.mjs";

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    windowsHide: true
  });
}

function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  writeFileSync(join(cwd, "README.md"), "# test\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "initial"], { cwd });
}

describe("resolveWorktreePath", () => {
  it("returns path under .claude/worktrees with jobId", () => {
    const result = resolveWorktreePath("/repo", "task-abc123");
    assert.equal(result, "/repo/.claude/worktrees/task-abc123");
  });

  it("handles nested source root", () => {
    const result = resolveWorktreePath("/home/user/projects/myrepo", "task-xyz");
    assert.equal(result, "/home/user/projects/myrepo/.claude/worktrees/task-xyz");
  });
});

describe("generateWorktreeBranch", () => {
  it("generates branch with jobId only when prompt is empty", () => {
    const result = generateWorktreeBranch("task-abc123", "");
    assert.equal(result, "codex-rescue/task-abc123");
  });

  it("generates branch with jobId only when prompt is null", () => {
    const result = generateWorktreeBranch("task-abc123", null);
    assert.equal(result, "codex-rescue/task-abc123");
  });

  it("includes truncated prompt in branch name", () => {
    const result = generateWorktreeBranch("task-abc123", "Fix the authentication bug");
    assert.equal(result, "codex-rescue/task-abc123-fix-the-authentication-bug");
  });

  it("truncates long prompts to 32 characters", () => {
    const longPrompt = "This is a very long prompt that should be truncated to thirty two characters";
    const result = generateWorktreeBranch("task-abc123", longPrompt);
    assert.ok(result.startsWith("codex-rescue/task-abc123-"));
    const suffix = result.replace("codex-rescue/task-abc123-", "");
    assert.ok(suffix.length <= 32, `suffix "${suffix}" is ${suffix.length} chars`);
  });

  it("removes special characters from prompt", () => {
    const result = generateWorktreeBranch("task-abc123", "Fix bug #123 (urgent!)");
    assert.equal(result, "codex-rescue/task-abc123-fix-bug-123-urgent");
  });

  it("converts spaces to hyphens", () => {
    const result = generateWorktreeBranch("task-abc123", "add new feature");
    assert.equal(result, "codex-rescue/task-abc123-add-new-feature");
  });

  it("collapses multiple hyphens", () => {
    const result = generateWorktreeBranch("task-abc123", "fix---bug");
    assert.equal(result, "codex-rescue/task-abc123-fix-bug");
  });

  it("strips leading and trailing hyphens from prompt part", () => {
    const result = generateWorktreeBranch("task-abc123", " -fix bug- ");
    assert.equal(result, "codex-rescue/task-abc123-fix-bug");
  });

  it("handles prompt with only special characters", () => {
    const result = generateWorktreeBranch("task-abc123", "!!!@@@###");
    assert.equal(result, "codex-rescue/task-abc123");
  });
});

describe("createWorktree", () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "codex-worktree-test-"));
    initGitRepo(tempDir);
  });

  afterEach(() => {
    // Remove worktrees first to avoid permission issues
    const worktreesDir = join(tempDir, ".claude", "worktrees");
    if (existsSync(worktreesDir)) {
      const entries = readdirSync(worktreesDir);
      for (const entry of entries) {
        const wtPath = join(worktreesDir, entry);
        run("git", ["worktree", "remove", "--force", wtPath], { cwd: tempDir });
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates a worktree with the correct path and branch", () => {
    const result = createWorktree(tempDir, "task-abc123", "fix bug");

    assert.ok(result.worktreePath.endsWith("/.claude/worktrees/task-abc123"));
    assert.equal(result.worktreeBranch, "codex-rescue/task-abc123-fix-bug");
    assert.equal(result.worktreeBaseBranch, "main");
    assert.ok(existsSync(result.worktreePath));

    // Verify branch exists
    const branchList = run("git", ["branch", "--list"], { cwd: tempDir });
    assert.ok(branchList.stdout.includes("codex-rescue/task-abc123-fix-bug"));
  });

  it("creates worktree without prompt", () => {
    const result = createWorktree(tempDir, "task-xyz", "");

    assert.equal(result.worktreeBranch, "codex-rescue/task-xyz");
    assert.ok(existsSync(result.worktreePath));
  });

  it("reuses existing worktree at the same path", () => {
    // Create first worktree
    const first = createWorktree(tempDir, "task-reuse", "first");

    // Create again at same path (same jobId)
    const second = createWorktree(tempDir, "task-reuse", "first");

    assert.equal(first.worktreePath, second.worktreePath);
    assert.ok(existsSync(second.worktreePath));
  });

  it("throws when path exists but is not a worktree", () => {
    const worktreePath = join(tempDir, ".claude", "worktrees", "task-conflict");
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, "file.txt"), "not a worktree");

    assert.throws(
      () => createWorktree(tempDir, "task-conflict", "test"),
      /Worktree path already exists/
    );
  });
});

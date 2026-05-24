import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderWorktreesBlock, renderTaskResult } from "../plugins/codex/scripts/lib/render.mjs";

describe("renderWorktreesBlock", () => {
  it("returns null when no worktreePath", () => {
    assert.equal(renderWorktreesBlock({}), null);
    assert.equal(renderWorktreesBlock({ worktreePath: null }), null);
  });

  it("renders worktree info with path and branch", () => {
    const result = renderWorktreesBlock({
      worktreePath: "/repo/.claude/worktrees/task-abc123",
      worktreeBranch: "codex-rescue/task-abc123-fix-bug",
      worktreeBaseBranch: "main"
    });

    assert.ok(result.includes("Worktree:"));
    assert.ok(result.includes("/repo/.claude/worktrees/task-abc123"));
    assert.ok(result.includes("codex-rescue/task-abc123-fix-bug"));
    assert.ok(result.includes("git diff main...codex-rescue/task-abc123-fix-bug"));
    assert.ok(result.includes("git merge codex-rescue/task-abc123-fix-bug"));
    assert.ok(result.includes("git worktree remove /repo/.claude/worktrees/task-abc123"));
  });

  it("renders without next steps when no baseBranch", () => {
    const result = renderWorktreesBlock({
      worktreePath: "/repo/.claude/worktrees/task-abc123",
      worktreeBranch: "codex-rescue/task-abc123"
    });

    assert.ok(result.includes("Worktree:"));
    assert.ok(result.includes("/repo/.claude/worktrees/task-abc123"));
    assert.ok(!result.includes("Next steps:"));
  });
});

describe("renderTaskResult with worktree", () => {
  it("appends worktree block to raw output", () => {
    const result = renderTaskResult(
      { rawOutput: "Task completed successfully." },
      {
        worktreePath: "/repo/.claude/worktrees/task-abc123",
        worktreeBranch: "codex-rescue/task-abc123-fix-bug",
        worktreeBaseBranch: "main"
      }
    );

    assert.ok(result.includes("Task completed successfully."));
    assert.ok(result.includes("Worktree:"));
    assert.ok(result.includes("/repo/.claude/worktrees/task-abc123"));
  });

  it("appends worktree block to failure message", () => {
    const result = renderTaskResult(
      { failureMessage: "Task failed." },
      {
        worktreePath: "/repo/.claude/worktrees/task-abc123",
        worktreeBranch: "codex-rescue/task-abc123-fix-bug",
        worktreeBaseBranch: "main"
      }
    );

    assert.ok(result.includes("Task failed."));
    assert.ok(result.includes("Worktree:"));
  });

  it("returns plain output when no worktree", () => {
    const result = renderTaskResult(
      { rawOutput: "Task completed." },
      {}
    );

    assert.equal(result, "Task completed.\n");
    assert.ok(!result.includes("Worktree:"));
  });
});

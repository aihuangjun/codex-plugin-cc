import fs from "node:fs";
import path from "node:path";

import { ensureGitRepository } from "./git.mjs";
import { runCommand } from "./process.mjs";

export function resolveWorkspaceRoot(cwd) {
  try {
    return ensureGitRepository(cwd);
  } catch {
    return cwd;
  }
}

const WORKTREE_DIR = ".claude/worktrees";
const WORKTREE_BRANCH_PREFIX = "codex-rescue";
const WORKTREE_PROMPT_MAX_LENGTH = 32;

export function resolveWorktreePath(sourceRoot, jobId) {
  return path.join(sourceRoot, WORKTREE_DIR, jobId);
}

export function generateWorktreeBranch(jobId, prompt) {
  if (!prompt || !prompt.trim()) {
    return `${WORKTREE_BRANCH_PREFIX}/${jobId}`;
  }

  const normalized = prompt
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!normalized) {
    return `${WORKTREE_BRANCH_PREFIX}/${jobId}`;
  }

  const truncated = normalized.slice(0, WORKTREE_PROMPT_MAX_LENGTH).replace(/-$/, "");
  return `${WORKTREE_BRANCH_PREFIX}/${jobId}-${truncated}`;
}

export function createWorktree(sourceRoot, jobId, prompt) {
  const worktreePath = resolveWorktreePath(sourceRoot, jobId);
  const worktreeBranch = generateWorktreeBranch(jobId, prompt);

  // Get current branch as base
  const baseResult = runCommand("git", ["branch", "--show-current"], { cwd: sourceRoot });
  const baseBranch = baseResult.status === 0 && baseResult.stdout.trim()
    ? baseResult.stdout.trim()
    : "HEAD";

  // Check if worktree path already exists
  if (fs.existsSync(worktreePath)) {
    // Check if it's already a worktree
    const listResult = runCommand("git", ["worktree", "list", "--porcelain"], { cwd: sourceRoot });
    if (listResult.status === 0 && listResult.stdout.includes(worktreePath)) {
      // Reuse existing worktree
      return { worktreePath, worktreeBranch, worktreeBaseBranch: baseBranch };
    }
    // Path exists but not as worktree - error
    throw new Error(
      `Worktree path already exists: ${worktreePath}\n` +
      `Please remove it manually or use a different job ID.`
    );
  }

  // Create parent directory
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  // Create worktree
  const createResult = runCommand(
    "git",
    ["worktree", "add", "-b", worktreeBranch, worktreePath],
    { cwd: sourceRoot }
  );

  if (createResult.status !== 0) {
    throw new Error(
      `Failed to create worktree: ${createResult.stderr || createResult.stdout}`
    );
  }

  return { worktreePath, worktreeBranch, worktreeBaseBranch: baseBranch };
}

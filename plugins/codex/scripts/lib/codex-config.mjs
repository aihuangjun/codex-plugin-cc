import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VALID_SANDBOX_MODES = new Set(["read-only", "workspace-write", "danger-full-access"]);

/**
 * Extract `sandbox_mode` from a Codex config.toml file.
 * Returns null if the file does not exist, cannot be read, or the key is absent/invalid.
 *
 * Only handles the simple `key = "value"` syntax used by Codex config.
 * Does not attempt full TOML parsing — no arrays, tables, or inline tables.
 */
export function readSandboxModeFromFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;

    const match = line.match(/^sandbox_mode\s*=\s*"([^"]*)"/);
    if (!match) continue;

    const value = match[1].trim();
    if (VALID_SANDBOX_MODES.has(value)) {
      return value;
    }
  }

  return null;
}

/**
 * Resolve the effective Codex `sandbox_mode` for a workspace.
 *
 * Precedence (matches Codex CLI behavior):
 *   1. Project-level `.codex/config.toml` in the workspace root
 *   2. User-level `~/.codex/config.toml`
 *
 * Returns the resolved value, or null if nothing is configured.
 */
export function resolveCodexSandboxMode(workspaceRoot) {
  const projectConfig = workspaceRoot
    ? readSandboxModeFromFile(path.join(workspaceRoot, ".codex", "config.toml"))
    : null;
  if (projectConfig) return projectConfig;

  const userConfig = readSandboxModeFromFile(path.join(os.homedir(), ".codex", "config.toml"));
  if (userConfig) return userConfig;

  return null;
}

export { VALID_SANDBOX_MODES };

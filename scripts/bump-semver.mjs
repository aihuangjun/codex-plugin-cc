#!/usr/bin/env node
/**
 * Convenience wrapper around bump-version.mjs that bumps the current version
 * by semver type (patch / minor / major) instead of requiring an explicit number.
 *
 * Usage:
 *   node scripts/bump-semver.mjs patch
 *   node scripts/bump-semver.mjs minor
 *   node scripts/bump-semver.mjs major
 *
 * Reads the current version from package.json, computes the next one, then shells
 * out to scripts/bump-version.mjs so all four manifest locations stay in sync.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const VALID_KINDS = new Set(["patch", "minor", "major"]);

function usage() {
  return [
    "Usage: node scripts/bump-semver.mjs <patch|minor|major>",
    "",
    "Reads package.json's current version, computes the next semver, then runs",
    "scripts/bump-version.mjs to sync package.json + package-lock.json +",
    "plugins/codex/.claude-plugin/plugin.json + .claude-plugin/marketplace.json."
  ].join("\n");
}

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) {
    throw new Error(`package.json has a non-semver version: ${version}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function nextVersion(current, kind) {
  const [major, minor, patch] = parseSemver(current);
  if (kind === "patch") return `${major}.${minor}.${patch + 1}`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major + 1}.0.0`;
}

function main() {
  const [kind] = process.argv.slice(2);
  if (!kind || !VALID_KINDS.has(kind)) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const root = process.cwd();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const next = nextVersion(pkg.version, kind);

  console.log(`${pkg.version} → ${next} (${kind})`);
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "bump-version.mjs"), next], {
    stdio: "inherit"
  });
  process.exitCode = result.status ?? 1;
}

main();

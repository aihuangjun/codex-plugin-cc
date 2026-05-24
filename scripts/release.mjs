#!/usr/bin/env node
/**
 * Tag + push + create a GitHub Release for the current package.json version.
 *
 * Usage:
 *   npm run release                     — release whatever is in package.json
 *   npm run release -- --dry-run        — show what would happen, don't push or create
 *   npm run release -- --repo owner/repo — override the gh release target repo
 *
 * Workflow:
 *   1. Read version from package.json. Refuse if version is missing or not semver.
 *   2. Refuse if working tree is dirty (uncommitted changes).
 *   3. Refuse if v<version> tag already exists locally or on origin.
 *   4. Refuse if CHANGELOG.md has no `## [<version>] — YYYY-MM-DD` heading.
 *   5. Extract that version's section from CHANGELOG.md as release notes
 *      (excluding the heading itself and any `---` separators).
 *   6. Create annotated tag v<version>, push it to origin.
 *   7. Call `gh release create v<version> --repo <owner/repo>
 *      --title "v<version> — <first non-blank line of notes>"
 *      --notes-file <tmp>`.
 *
 * Pre-flight you must have done:
 *   - `npm run bump:patch` (or bump:minor / bump:major / bump-version X.Y.Z)
 *   - Updated `## [Unreleased]` section in CHANGELOG.md into `## [<version>] — <today>`
 *   - Committed both
 *   - Pushed main to origin
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function parseArgs(argv) {
  const out = { dryRun: false, repo: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--repo") {
      out.repo = argv[i + 1];
      i += 1;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function exec(cmd, args, { capture = false, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
  if (!allowFail && r.status !== 0) {
    const detail = capture ? `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() : "";
    throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}${detail ? ` — ${detail}` : ""}`);
  }
  return r;
}

function fail(msg) {
  console.error(`release: ${msg}`);
  process.exitCode = 1;
}

function loadVersion(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (!SEMVER.test(pkg.version ?? "")) {
    throw new Error(`package.json version is not semver: ${pkg.version}`);
  }
  return pkg.version;
}

function assertCleanWorkingTree() {
  const r = exec("git", ["status", "--porcelain"], { capture: true });
  if (r.stdout.trim()) {
    throw new Error("working tree is dirty. Commit or stash everything first:\n" + r.stdout);
  }
}

function tagExistsLocally(tag) {
  const r = exec("git", ["tag", "--list", tag], { capture: true });
  return r.stdout.trim() === tag;
}

function tagExistsOnRemote(tag) {
  const r = exec("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], { capture: true, allowFail: true });
  return Boolean(r.stdout && r.stdout.trim());
}

function extractChangelogSection(root, version) {
  const text = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const headingRe = new RegExp(`^## \\[${version.replace(/\\./g, "\\.")}\\] — `, "m");
  if (!headingRe.test(text)) {
    throw new Error(`CHANGELOG.md has no "## [${version}] — YYYY-MM-DD" heading. Update [Unreleased] before releasing.`);
  }
  const lines = text.split("\n");
  let collecting = false;
  const out = [];
  for (const line of lines) {
    if (collecting) {
      if (/^## \[/.test(line)) break;
      if (/^---$/.test(line.trim())) continue;
      out.push(line);
    } else if (headingRe.test(line)) {
      collecting = true;
    }
  }
  const notes = out.join("\n").trim();
  if (!notes) {
    throw new Error(`CHANGELOG.md "## [${version}]" section is empty.`);
  }
  return notes;
}

function deriveTitle(version, notes) {
  // First non-blank meaningful line of notes (skip "### Added" style headers).
  for (const raw of notes.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("###")) continue;
    if (line.startsWith("- **")) {
      const m = line.match(/^- \*\*(.+?)\*\*/);
      if (m) return `v${version} — ${m[1]}`;
    }
    return `v${version} — ${line.replace(/^- /, "").slice(0, 80)}`;
  }
  return `v${version}`;
}

function resolveRepo(override) {
  if (override) return override;
  const env = process.env.GH_REPO;
  if (env) return env;
  const r = exec("git", ["remote", "get-url", "origin"], { capture: true });
  const url = r.stdout.trim();
  const m = url.match(/[:/]([^:/]+)\/([^/]+?)(?:\.git)?$/);
  if (!m) throw new Error(`Cannot derive owner/repo from origin: ${url}`);
  return `${m[1]}/${m[2]}`;
}

function main() {
  const root = process.cwd();
  const opts = parseArgs(process.argv.slice(2));

  const version = loadVersion(root);
  const tag = `v${version}`;
  const repo = resolveRepo(opts.repo);
  console.log(`release: package.json says ${version} → tag ${tag} → repo ${repo}`);

  if (opts.dryRun) {
    if (tagExistsLocally(tag)) console.log(`release: [dry-run] local tag ${tag} already exists (would normally abort)`);
    if (tagExistsOnRemote(tag)) console.log(`release: [dry-run] remote tag ${tag} already exists (would normally abort)`);
  } else {
    assertCleanWorkingTree();
    if (tagExistsLocally(tag)) throw new Error(`local tag ${tag} already exists. Did you forget to bump first?`);
    if (tagExistsOnRemote(tag)) throw new Error(`remote tag ${tag} already exists on origin.`);
  }

  const notes = extractChangelogSection(root, version);
  const title = deriveTitle(version, notes);
  console.log(`release: title  → ${title}`);
  console.log(`release: notes  → ${notes.split("\n").length} lines extracted from CHANGELOG.md`);

  if (opts.dryRun) {
    console.log("\n--- notes preview ---\n");
    console.log(notes);
    console.log("\n--- dry run, nothing tagged or pushed ---");
    return;
  }

  exec("git", ["tag", "-a", tag, "-m", `Release ${tag}`]);
  console.log(`release: created annotated tag ${tag}`);

  exec("git", ["push", "origin", tag]);
  console.log(`release: pushed ${tag} to origin`);

  const tmpFile = path.join(os.tmpdir(), `codex-plugin-cc-${tag}-notes.md`);
  try {
    fs.writeFileSync(tmpFile, notes);
    exec("gh", ["release", "create", tag, "--repo", repo, "--title", title, "--notes-file", tmpFile]);
    console.log(`release: gh release created → https://github.com/${repo}/releases/tag/${tag}`);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

try {
  main();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}

# Changelog

All notable changes to this fork (`aihuangjun/codex-plugin-cc`, marketplace `openai-codex-opt`) are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

For the upstream `openai/codex-plugin-cc` per-plugin history, see [`plugins/codex/CHANGELOG.md`](plugins/codex/CHANGELOG.md).
For end-user installation and verification scenarios, see [`docs/CHANGES_AND_USAGE.md`](docs/CHANGES_AND_USAGE.md).

---

## [Unreleased]

_No unreleased changes yet. New entries land here during the next development cycle and roll into the next tagged version on release._

## [2.0.2] — 2026-05-24

### Added
- **`/codex:diff`** — targeted diff review by `--file <path>` / `--commit <sha>` / `--range <a>..<b>`. Reuses the structured Chinese review schema. Supports `--background` like the other reviews.
- **`/codex:history`** — list historical review / adversarial-review jobs for the current workspace (verdict, findings count, summary). Supports `--all` for cross-workspace, `--limit <N>`, `--json`.
- **Review next-step suggestion** — when `verdict: needs-attention` and there are `critical` / `high` findings, the review output ends with a copy-pasteable `/codex:rescue --background ...` command focused on the top blocking finding.
- **Background launch payload** — `/codex:review --background`, `/codex:adversarial-review --background`, `/codex:diff --background`, `/codex:rescue --background` all now print a uniform launch block with `Job id` and the four async-control commands (`/codex:status`, `/codex:observe`, `/codex:result`, `/codex:cancel`). Backed by real detached worker enqueue (not a synchronous Bash run wrapped in `run_in_background`).
- **CI**: `npm run check-version` is now wired into the GitHub Actions workflow on PRs and `main` pushes.
- **`npm run bump:patch|minor|major`** — convenience semver bumpers that compute the next version and call the existing `bump-version.mjs` to sync all four manifests (`package.json`, `package-lock.json`, `plugin.json`, `marketplace.json`).
- **Root `CHANGELOG.md`** (this file).

### Changed
- `getJobKindLabel(kind, jobClass)` simplified into a two-entry lookup `{ review, "adversarial-review", task → "rescue" }`. The old `jobClass`-based fallback was redundant.
- Smart-estimate thresholds (`files ≤ 30` AND `total ≤ 3000`) extracted into `SMART_ESTIMATE_THRESHOLDS` in `codex-companion.mjs` with explicit "keep-in-sync" comments in both `commands/review.md` and `commands/adversarial-review.md`.
- `.gitignore` adds `.idea/`, `.vscode/`, `*.swp`, `*.swo`, `.DS_Store`, `Thumbs.db` so IDE state stops surfacing as untracked.

### Internal
- `executeReviewRun` now also accepts a `diffSpec` request shape to support `/codex:diff`.
- `task-worker` dispatches by `storedJob.jobClass` so the same detached-worker path serves rescue, review, adversarial-review, and diff jobs.

---

## [2.0.1] — 2026-05-23

### Fixed (hotfix)
- **`/codex:review` and `/codex:adversarial-review` not actually starting on large diffs.** Root cause: the inherited 1.0.4 "estimate → AskUserQuestion → branch flow" ceremony ran multiple slow `git status` / `git diff --shortstat` calls on large diffs, exhausting Claude's context, and after the user answered the question Claude would conclude the task without ever calling `Bash(node ... review)`.

### Changed
- Rewrote `commands/review.md` and `commands/adversarial-review.md` as **"first-action Bash dispatchers"** with an explicit 3-step decision flow:
  1. `--background` short-circuits to the background flow.
  2. **One** `git diff --shortstat` call estimates size (not three).
  3. Small (files ≤ 30 AND total ≤ 3000) → foreground immediately. Large → one `AskUserQuestion` recommending background. Any answer mandates an immediate `Bash` call as the next action.
- `allowed-tools` tightened to the minimum needed surface.

---

## [2.0.0] — 2026-05-23

### Added
- **Streaming progress for `/codex:review` and `/codex:adversarial-review`** — every Codex protocol event (thread setup, command execution, file change, tool call, reasoning summary, final message) is emitted as `[codex] …` to stderr with zero buffering. Users see what Codex is doing in real time.
- **Chinese output for review verdicts.** Both prompts now have an `<output_language>` block that requires `summary`, `findings.title`, `findings.body`, `findings.recommendation`, `next_steps` etc. in Simplified Chinese; JSON enum values (`approve` / `needs-attention`, `critical` / `high` / `medium` / `low`) and code identifiers stay in their original form.
- **Completion `PushNotification`** — both foreground and background review flows surface a desktop notification when finished.
- **`/codex:review` now accepts an optional focus text** after the flags (previously native-review-only and rejected focus).
- **Marketplace rename to `openai-codex-opt`** so the fork can be installed alongside the official `openai-codex` and dragon's `dragon-cc-codex`.
- **`docs/CHANGES_AND_USAGE.md`** — end-user installation guide, per-scenario verification commands, and troubleshooting clinic.

### Ported from `dragon84867/codex-plugin-cc` 1.0.4 → 1.2.6
- Honor `sandbox_mode` from `~/.codex/config.toml` / `./.codex/config.toml` instead of hard-coding.
- Broker process leak fix: `ensureBrokerSession` defaults to `terminateProcessTree` and idle-exits.
- Codex protocol alignment: add `requestAttestation: false`, drop deprecated `experimentalRawEvents`.
- Background task signal file → `PushNotification` (no manual `/codex:status` polling).
- `/codex:observe` — live, color-coded event viewer for any job (read-only, doesn't lock the thread).
- `/codex:rescue --worktree` — run rescue in an isolated `.claude/worktrees/<jobId>/` so the main working directory stays untouched.
- Cross-workspace job lookup so `/codex:status`, `/codex:observe`, `/codex:result`, `/codex:cancel` find jobs from other Claude sessions.
- `.events.jsonl` append-only event stream behind the observer.

### Removed
- Native review path (`runAppServerReview`, `renderNativeReviewResult`, `validateNativeReviewRequest`, `buildNativeReviewTarget`). All reviews now go through `runAppServerTurn` + a prompt template, which is what lets us guarantee Chinese output and accept focus text.

### Author / metadata
- `author` changed to `shengxia.hj`.

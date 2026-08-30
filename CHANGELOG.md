# Changelog

All notable changes to this fork (`aihuangjun/codex-plugin-cc`, marketplace `openai-codex-opt`) are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

For the upstream `openai/codex-plugin-cc` per-plugin history, see [`plugins/codex/CHANGELOG.md`](plugins/codex/CHANGELOG.md).
For end-user installation and verification scenarios, see [`docs/CHANGES_AND_USAGE.md`](docs/CHANGES_AND_USAGE.md).

---

## [Unreleased]

_No unreleased changes yet. New entries land here during the next development cycle and roll into the next tagged version on release._

## [2.0.6] — 2026-08-30

### Fixed
- **Background tasks (`task --background`, `review --background`) no longer get stuck in `queued` forever.** `enqueueBackgroundTask` spawned the detached worker *before* writing the job record; the worker's first action is to read that record, and whenever `git rev-parse` in the workspace was slow (large repos such as a home directory under git) it reliably won the race, threw `No stored job found`, and died with its stdio discarded — leaving no status change, no `.done` signal, and a Monitor that never fired. Fix: the full record (including the request payload) is persisted before the worker exists, the worker retries the lookup for up to 10 s, its stdout/stderr are appended to the job log, and any failure before `runTrackedJob` takes over now marks the job `failed` and writes the signal file (also covers `uncaughtException` / `unhandledRejection`). A worker started for a job that is no longer `queued` exits without rerunning it.
- **Dead workers are reconciled instead of shown as active forever.** `status` (including `--all`), `status --wait`, `result` and `cancel` now check whether the recorded worker pid is alive (a job that started before the last boot is treated as dead even if its pid number was reused); a `queued`/`running` job whose process is gone (crash, `kill`, harness timeout, reboot) is converted to `failed` with an explanatory message and a `.done` signal. A terminal job file that the state index missed is adopted the same way.
- **Foreground `task` survives the caller being killed.** The Codex turn now runs in the same detached worker as `--background`; the foreground process only waits, streams `[codex] …` progress to stderr and prints the stored result with the original exit-code semantics. If a tool harness kills the waiting process (Claude Code's 2-minute default Bash timeout was a common cause of "rescue returned nothing"), the job keeps running and `/codex:result` still works. Waiting stops after ~9.5 minutes (`--timeout-ms`, `CODEX_COMPANION_FOREGROUND_TIMEOUT_MS`; `0` returns immediately) with a "still running" hint naming the job id — in `--json` mode that is the launch payload plus `status: "running"` and `waitTimedOut: true`. `CODEX_COMPANION_FOREGROUND_INLINE=1` restores the previous in-process behaviour.
- **`task --help` / `-h` print usage instead of sending `--help` to Codex as the prompt**, and a prompt made only of unrecognized flags is rejected up front (the rescue subagent had burned a full Codex run answering `--help`).
- **Job records and `state.json` are written atomically** (temp file + rename), so concurrent readers never parse a half-written document.
- **Stdin is only consumed when it is a pipe, socket or file**; a harness that leaves stdin attached to a character device can no longer block `task` waiting for EOF.
- The `codex-rescue` agent and `codex-cli-runtime` skill now require `timeout: 600000` on the forwarding `Bash` call and return the command's error output instead of "nothing" when Codex cannot be invoked.

## [2.0.5] — 2026-07-13

### Fixed
- **`/codex:rescue` no longer breaks by silently swapping in an unsupported model.** The rescue subagent (an LLM) repeatedly injected a `--model` value inferred from the task text — bogus tokens like `pytest` / `py_compile`, or real-but-account-unsupported models like `o3` / `gpt-4.1` — which overrode the model configured in `~/.codex/config.toml` and made the run fail with `The 'X' model is not supported when using Codex with a ChatGPT account`. Two-layer fix:
  - **Runtime guarantee (deterministic):** `task` now ignores `--model` and always uses the Codex-configured default model, so a mis-injected model can no longer take effect. Per-run overrides are still available by setting `CODEX_COMPANION_ALLOW_MODEL_OVERRIDE=1`; when a `--model` is dropped, the run prints a one-line note explaining why and how to re-enable overrides. (`codex-companion.mjs` gained a `main()` guard so its helpers are unit-testable.)
  - **Actionable error:** if a model is ever rejected by the backend (e.g. with overrides enabled), the task failure now appends a clear hint naming the rejected model and telling the user to retry without `--model` or pick a supported one, instead of surfacing only the raw backend error.
  - **Instruction hardening:** the `codex:rescue` command, the `codex-rescue` agent, and the `codex-cli-runtime` skill now explicitly forbid inferring a model name from the task text (tool/file/framework names in the prompt are never model selections).
  - Covered by new `resolveTaskModel` / `describeModelRejection` unit tests plus runtime tests proving `--model` is ignored by default and honored only when the override env is set.

## [2.0.4] — 2026-07-05

### Added
- **`/codex:transfer`** — merged from upstream `openai/codex-plugin-cc` (#374, shipped there in `1.0.5`). Hands off the current Claude Code session into a resumable Codex thread and prints a `codex resume <session-id>` command. Uses Codex's external-agent session importer; the `SessionStart` hook supplies the transcript path automatically, with `--source <claude-jsonl>` as a manual override. The source must live under `~/.claude/projects`, and older Codex builds without session-import support surface an actionable upgrade error. (Upstream's own `1.0.5` version bump was intentionally not taken — this fork keeps its own `2.0.x` line.)

### Fixed
- **Foreground Codex turns can no longer hang the Claude Code session forever** (the reported "broker busy / no response, Claude Code keeps waiting" stall). `captureTurn` awaited turn completion with no upper bound, so it hung indefinitely when the app-server emitted an `error` (or simply stalled) without ever sending `turn/completed`, or when the app-server crashed/disconnected mid-turn (connection close rejects pending *requests* but never resolved the turn-completion promise). A wedged foreground turn also kept the shared broker's stream slot open, so every other command then returned `BROKER_BUSY` ("queue full"). Fix adds two independent guards: an idle watchdog that aborts after prolonged app-server silence (reset on every turn notification; configurable via `CODEX_COMPANION_TURN_IDLE_TIMEOUT_MS`, default 10 minutes, `0` disables) and client-exit wiring into the completion promise. Either one now fails the turn fast and closes the client, which frees the broker slot and unblocks other commands. Covered by a new `silent-after-error` regression test.

## [2.0.3] — 2026-05-24

### Fixed
- **`/codex:observe` actually runs now.** The dragon-inherited template only printed a "copy this command into a new terminal" hint without invoking `Bash`, so the slash command did nothing. New behavior: as its first action the command calls `AskUserQuestion` with two options — (A) **Run inline here** invokes the companion via `Bash` in this conversation (immediate for completed jobs; blocks until completion or `Ctrl+C` for running jobs, since Claude Code's main pane is batch-rendered), or (B) **Print copy-paste command for a fresh terminal** prints the exact `node ... observe ...` command for a separate terminal where the user gets a true real-time ANSI-colored stream that doesn't block this chat. The companion still also accepts `--snapshot` (dump-and-exit) as an advanced flag, but the slash command no longer auto-uses it — the user chooses.

### Added
- **`npm run release`** (`scripts/release.mjs`) — tag + push + GitHub Release creation for the current `package.json` version. Reads release notes from the matching CHANGELOG section, refuses to run on a dirty tree, refuses if the tag already exists. Supports `--dry-run` and `--repo owner/repo`.
- **Project-level `CLAUDE.md`**: documents that any push / tag / `gh release` / `npm publish` / branch-history-rewriting action must go through `AskUserQuestion` first — added after a `v2.0.3` release was tagged and pushed without user confirmation.

### Internal
- Backfilled git tags `v2.0.0` / `v2.0.1` / `v2.0.2` on the corresponding bump commits; created the first GitHub Release for `v2.0.2`.

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

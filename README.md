# codex-plugin-cc-opt

> **Fork of [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)** maintained by [`aihuangjun`](https://github.com/aihuangjun).
> Marketplace name: `openai-codex-opt` — installable alongside the official version and the `dragon-cc-codex` fork.

[![CI](https://github.com/aihuangjun/codex-plugin-cc/actions/workflows/pull-request-ci.yml/badge.svg)](https://github.com/aihuangjun/codex-plugin-cc/actions/workflows/pull-request-ci.yml)

Use Codex from inside Claude Code for code review or to delegate tasks — with **real-time progress streaming**, **structured Chinese verdicts**, **completion notifications**, and **targeted diff review**.

---

## TL;DR (quick install)

```text
/plugin marketplace add aihuangjun/codex-plugin-cc
/plugin install codex@openai-codex-opt
/reload-plugins
/codex:setup
```

Then in any git repository with changes:

```text
/codex:review                                  # full working-tree review (small diffs auto-run; large diffs ask first)
/codex:diff --file src/auth.js                 # review just one file
/codex:adversarial-review focus on race conditions
/codex:rescue --background fix the failing integration test
/codex:history                                 # past review verdicts for this repo
```

Detailed install, verification scenarios, and troubleshooting: [`docs/CHANGES_AND_USAGE.md`](docs/CHANGES_AND_USAGE.md).
Full release history: [`CHANGELOG.md`](CHANGELOG.md).

---

## What this fork changes vs upstream

| Capability | `openai/codex-plugin-cc` (1.0.4) | `dragon84867/codex-plugin-cc` (1.2.6) | **`openai-codex-opt` (this fork, 2.0.2)** |
|---|---|---|---|
| Live `[codex] …` progress stream during review | ❌ | ❌ | ✅ |
| Chinese verdict / findings / recommendations | ❌ | ❌ | ✅ |
| Completion `PushNotification` (fg & bg) | ❌ | bg only | ✅ both |
| Background launch payload (jobId + 4 control commands) | ❌ | partial | ✅ uniform across review / adversarial / diff / rescue |
| Auto rescue suggestion on `needs-attention` verdicts | ❌ | ❌ | ✅ |
| `/codex:diff` (single file / commit / range) | ❌ | ❌ | ✅ |
| `/codex:history` (past verdicts) | ❌ | ❌ | ✅ |
| `/codex:observe` live event viewer | ❌ | ✅ | ✅ |
| `/codex:rescue --worktree` isolated branch | ❌ | ✅ | ✅ |
| Cross-workspace job lookup | ❌ | ✅ | ✅ |
| `sandbox_mode` from `~/.codex/config.toml` | ❌ hard-coded | ✅ | ✅ |
| Broker process leak fixed | ❌ | ✅ | ✅ |
| Coexists with upstream install | — | ✅ | ✅ |

---

## Command reference

| Command | Purpose |
|---|---|
| `/codex:setup` | Verify Codex CLI, Node, auth status. Toggle stop-time review gate. |
| `/codex:review [focus]` | Structured Chinese review of working-tree (or `--base <ref>` for a branch diff). Small diffs auto-run; large diffs ask first. Append `--background` to detach. |
| `/codex:adversarial-review [focus]` | Same target selection as `/codex:review` but framed as a challenge review (questions the design, looks for failure modes). |
| `/codex:diff --file <path> \| --commit <sha> \| --range <a>..<b>` | Targeted diff review — single file, single commit, or arbitrary range. |
| `/codex:rescue [task]` | Delegate code change / debugging work to Codex. Supports `--background`, `--worktree`, `--resume`, `--fresh`, `--model`, `--effort`. |
| `/codex:transfer [--source <claude-jsonl>]` | Hand off the current Claude Code session into a resumable Codex thread and print a `codex resume <session-id>` command. Source must be under `~/.claude/projects`; `--source` is a manual override. |
| `/codex:status [jobId] [--all]` | Show queued / running jobs (and recent finished). `--all` includes other workspaces. |
| `/codex:observe [jobId]` | Live, color-coded event stream for any running / finished job. Read-only — doesn't lock the Codex thread. |
| `/codex:result [jobId]` | Print the stored final output for a finished job. |
| `/codex:cancel [jobId]` | Abort a queued / running job (sends a turn-interrupt to Codex). |
| `/codex:history [--all] [--limit N]` | Past review / adversarial-review jobs for this workspace, with verdict + findings count. |

`--background` works on `/codex:review`, `/codex:adversarial-review`, `/codex:diff`, and `/codex:rescue`. Every background launch now prints a uniform block:

```
Codex Review started in the background.
  Job id: review-abc1234

Async control:
  /codex:status review-abc1234     — current state, phase, recent progress
  /codex:observe review-abc1234    — live event stream (read-only, Ctrl+C exits observer only)
  /codex:result review-abc1234     — full final output (once status is completed/failed)
  /codex:cancel review-abc1234     — abort the run

A PushNotification will fire automatically when the job finishes.
```

---

## Requirements

- Node.js ≥ 18.18 (CI tests on Node 22).
- Codex CLI (`npm install -g @openai/codex`) — version 0.130+ recommended for stable Chinese-output behavior.
- ChatGPT subscription (incl. Free) or OpenAI API key. Usage counts against your Codex quota. [Pricing](https://developers.openai.com/codex/pricing).

---

## Install (full instructions)

If you already have the official `openai-codex` or dragon's `dragon-cc-codex` installed and want to switch:

```text
/plugin uninstall codex@openai-codex
/plugin marketplace remove openai-codex
```

Then:

```text
/plugin marketplace add aihuangjun/codex-plugin-cc
/plugin install codex@openai-codex-opt
/reload-plugins
/codex:setup
```

Upgrade later with:

```text
/plugin update codex@openai-codex-opt
/reload-plugins
```

Uninstall:

```text
/plugin uninstall codex@openai-codex-opt
/plugin marketplace remove openai-codex-opt
```

---

## Development

```bash
git clone https://github.com/aihuangjun/codex-plugin-cc.git
cd codex-plugin-cc
npm install
npm test
```

Bump version (syncs `package.json`, `package-lock.json`, `plugin.json`, `marketplace.json` in one shot):

```bash
npm run bump:patch    # 2.0.2 → 2.0.3
npm run bump:minor    # 2.0.2 → 2.1.0
npm run bump:major    # 2.0.2 → 3.0.0
npm run bump-version 2.5.0    # explicit version

npm run check-version  # CI runs this; fails the build on drift
```

Cut a release once the bump commit + an updated `## [X.Y.Z] — YYYY-MM-DD` CHANGELOG section are merged into `main`:

```bash
npm run release             # tag + push + gh release create (notes come from CHANGELOG)
npm run release -- --dry-run  # preview title and notes, don't touch git or GitHub
```


---

## Acknowledgements

- Upstream: [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc)
- Many底层 bug 修复 / `/codex:observe` / `--worktree` / signal-file PushNotification cherry-picked from [`dragon84867/codex-plugin-cc`](https://github.com/dragon84867/codex-plugin-cc) 1.0.4 → 1.2.6.

## License

Apache-2.0 (inherited from upstream).

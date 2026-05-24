---
description: List historical Codex review/adversarial-review jobs for this workspace (verdict, findings count, summary)
argument-hint: '[--all] [--limit <N>] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Your single job on this turn is to invoke the companion and return its stdout verbatim.

# CRITICAL — First action

You MUST invoke the `Bash` tool **as the very next action on this turn**. Do not run any other tool first. Do not ask any question. Do not summarize.

# Raw arguments
`$ARGUMENTS`

# Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" history "$ARGUMENTS"
```

After the command returns, print its stdout **verbatim**. Do not paraphrase, summarize, or rewrap the table.

# Argument reference (do NOT auto-add unless the user explicitly asked)

- `--all` — include jobs from all known workspaces (default: only current workspace).
- `--limit <N>` — cap the number of rows (default: 20).
- `--json` — emit raw JSON instead of the markdown table; useful for piping into other tools.

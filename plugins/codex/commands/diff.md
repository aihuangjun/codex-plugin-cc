---
description: Run a Codex review against a specific diff target (single file / single commit / arbitrary range)
argument-hint: '(--file <path>|--commit <sha>|--range <a>..<b>) [focus text]'
disable-model-invocation: true
allowed-tools: Bash(node:*), PushNotification
---

Your single job on this turn is to start the targeted Codex diff review and stream its output back to the user.

# CRITICAL — First action

You MUST invoke the `Bash` tool **as the very next action on this turn**. Do not run any other tool first. Do not ask any question. Do not summarize. Do not estimate diff size yourself — the companion already scopes the input.

# Selector requirement

`$ARGUMENTS` must contain exactly **one** of:

- `--file <path>`     — review only the diff of one file (vs HEAD; falls back to staged if HEAD has none)
- `--commit <sha>`    — review a single commit (`git show <sha>`)
- `--range <a>..<b>`  — review a custom range (`git diff <a>..<b>`); double-dot or triple-dot are both accepted

Optional focus text can follow the selector flags.

# Raw arguments
`$ARGUMENTS`

# Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" diff "$ARGUMENTS"
```

The companion streams `[codex] ...` progress events to stderr in real time so the user can see Codex working.

After the command returns:

1. Return its stdout **verbatim** — Codex emits a structured Chinese verdict (`verdict`, `summary`, `findings`, `recommendations`, `next_steps`); JSON enum values (`approve` / `needs-attention`, `critical` / `high` / `medium` / `low`) and code identifiers stay in their original form. Do not paraphrase, summarize, translate, or add commentary before or after it.
2. Call `PushNotification`:
   ```typescript
   PushNotification({ message: "Codex diff review finished — see the verdict above." })
   ```
3. This command is review-only. Do not fix any issues mentioned in the output.

# Background

Adding `--background` to `$ARGUMENTS` enqueues the diff review into a detached worker. In that mode the command returns immediately with a launch payload (Job id + `/codex:status|observe|result|cancel <jobId>` lines). Print that stdout verbatim and skip the PushNotification step in this turn (the worker will fire its own when it finishes).

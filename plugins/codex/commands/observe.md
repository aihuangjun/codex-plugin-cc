---
description: Snapshot the current event stream of a Codex job; show ANSI-rendered events inline + tell the user how to switch to a live tail
argument-hint: '[job-id] [--cwd <path>]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Your single job on this turn is to fetch the current Codex job event snapshot and print it back to the user.

# CRITICAL — First action

You MUST invoke the `Bash` tool **as the very next action on this turn**. Do not run any other tool first. Do not ask any question. Do not summarize. Do not paraphrase the eventual output.

# Raw arguments
`$ARGUMENTS`

# Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" observe --snapshot $ARGUMENTS
```

`--snapshot` makes the companion dump every event recorded so far (even if the job is still running) and exit immediately — so this slash command stays interactive instead of blocking the conversation on a long tail.

After the command returns:

1. Print its stdout **verbatim** to the user. The output already contains ANSI colors (cyan tool calls, blue command executions, green successes, red failures, yellow file changes, gray reasoning) plus a footer line that explains how to open a live stream in a separate terminal if the job is still running.
2. Do not summarize, recolor, or rewrap the event list.
3. Do not call this command again to "refresh" — if the user wants a fresher snapshot they will re-invoke `/codex:observe` themselves.

# When the user wants persistent live tailing

If they ask for "continuous live updates" rather than a snapshot, tell them to open a separate terminal and run:

```bash
cd <project-root>
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" observe $ARGUMENTS
```

(without `--snapshot`). That mode tails the `.events.jsonl` file until the job completes; `Ctrl+C` only detaches the observer — the Codex job keeps running.

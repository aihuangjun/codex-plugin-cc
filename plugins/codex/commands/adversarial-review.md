---
description: Run a Codex review that challenges the implementation approach and design choices (smart size estimate, streaming progress, Chinese output, completion notification)
argument-hint: '[--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]'
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git diff --shortstat:*), Bash(git status --short:*), AskUserQuestion, PushNotification
---

Your single job on this turn is to start the Codex adversarial review and stream its output back to the user. The review's framing is to question whether the current implementation is the right approach, what assumptions it depends on, and where the design could fail under real-world conditions — but you do not draft that framing yourself; the companion script does.

# Decision flow (execute in order, each step is mandatory)

## Step 1 — Fast path on explicit flag

- If `$ARGUMENTS` contains the literal substring `--background`, go directly to **Background flow**. Do not estimate, do not ask.

## Step 2 — Estimate diff size (ONE Bash call only)

Run exactly **one** Bash call to size the change. Do not run multiple git commands here.

- For working-tree review (default): `git diff --shortstat`
- If `--base <ref>` is in `$ARGUMENTS`: `git diff --shortstat <ref>...HEAD`

Parse the line `N files changed, M insertions(+), K deletions(-)`. Compute total = M + K. If parsing fails, treat as small.

## Step 3 — Branch on size

- **Small** (files ≤ 30 AND total ≤ 3000): go directly to **Foreground flow**. Do not ask.
- **Large** (files > 30 OR total > 3000): use `AskUserQuestion` exactly once with two options (recommended option first, suffixed `(Recommended)`):
  - `Run in background (Recommended)` — for large diffs, foreground will block the conversation for a long time.
  - `Run in foreground`

  After the user answers, **the very next action on this turn is the corresponding `Bash` call below**. Do not summarize, do not announce, do not run any other tool, do not stop.

# Raw arguments
`$ARGUMENTS`

# Foreground flow

Call `Bash` exactly once with this command. Do NOT redirect stderr; the companion streams `[codex] ...` progress events there in real time so the user can see what Codex is doing while it works.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" adversarial-review "$ARGUMENTS"
```

After the command returns:

1. Return its stdout **verbatim**, exactly as-is — Codex emits a structured Chinese verdict (`verdict`, `summary`, `findings`, `recommendations`, `next_steps`); JSON enum values (`approve` / `needs-attention`, `critical` / `high` / `medium` / `low`) and code identifiers stay in their original form. Do not paraphrase, summarize, translate, weaken the adversarial framing, or add commentary before or after it.
2. Call `PushNotification`:
   ```typescript
   PushNotification({ message: "Codex adversarial review finished — see the verdict above." })
   ```
3. Do not fix any issues mentioned in the review output. This command is review-only.

# Background flow

Call `Bash` exactly once with `run_in_background: true`:

```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" adversarial-review "$ARGUMENTS"`,
  description: "Codex adversarial review",
  run_in_background: true
})
```

After launching, tell the user verbatim: "Codex adversarial review started in the background. Use `/codex:status` for progress, or `/codex:observe` in another terminal for a live stream. A PushNotification will fire automatically when it finishes." Do not poll the output and do not wait for completion in this turn.

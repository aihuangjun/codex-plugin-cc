---
description: Run a Codex code review against local git state (streaming progress, Chinese output, completion notification)
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion, PushNotification
---

Run a Codex review through the shared plugin runtime.
Codex returns a structured verdict (`verdict`, `summary`, `findings`, `recommendations`, `next_steps`). Natural-language fields are emitted in **Simplified Chinese**; the JSON enum values (`approve` / `needs-attention`, `critical` / `high` / `medium` / `low`) and code identifiers stay in their original form.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Codex's output verbatim to the user.
- Codex already produces Chinese natural-language output. Do not translate, paraphrase, or re-summarize it.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the review in the foreground.
- If the raw arguments include `--background`, do not ask. Run the review in a Claude background task.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant working-tree status is empty or the explicit branch diff is empty.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- Do not strip `--wait` or `--background` yourself.
- Do not add extra review instructions or rewrite the user's intent.
- The companion script parses `--wait` and `--background`, but Claude Code's `Bash(..., run_in_background: true)` is what actually detaches the run.
- `/codex:review` accepts an optional focus text after the flags. If the user wants a more adversarial framing, suggest `/codex:adversarial-review` instead.

Foreground flow:
- Run (do NOT silence stderr — the companion streams `[codex] ...` progress events there so the user can see what Codex is doing while it works):
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.
- After the review result has been shown to the user, call `PushNotification` to signal completion:
```typescript
PushNotification({
  message: "Codex review finished — see the verdict above."
})
```

Background flow:
- Launch the review with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review "$ARGUMENTS"`,
  description: "Codex review",
  run_in_background: true
})
```
- Do not poll the output or wait for completion in this turn.
- After launching the command, tell the user: "Codex review started in the background. Check `/codex:status` for progress, or run `/codex:observe` in another terminal to watch it live. A PushNotification will fire automatically when it finishes."
- When the background job completes the plugin emits a signal file that triggers PushNotification, so no manual polling is required.

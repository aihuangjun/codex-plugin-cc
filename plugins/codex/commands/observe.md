---
description: Observe a Codex job's event stream — choose inline (blocks the chat) or copy-paste for a fresh terminal (true live tail)
argument-hint: '[job-id] [--cwd <path>]'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

Your single job on this turn is to ask the user how they want to observe, then either run the companion inline or print the exact command they should run in another terminal.

# CRITICAL — First action

You MUST invoke `AskUserQuestion` **as the very next action on this turn**. Do not run any other tool first. Do not summarize. Do not paraphrase. Do not pick a default for the user.

# Raw arguments
`$ARGUMENTS`

# Step 1 — Ask exactly this question

Call `AskUserQuestion` once. Two options, in this order, with these exact labels and descriptions:

**Option A** (put `(Recommended)` after the label only if the job is already known to be completed/failed/cancelled — for running jobs, put `(Recommended)` after option B instead):
- label: `Run inline here`
- description: `Invoke the companion in this conversation. For completed/failed jobs you get the full event history immediately. For running jobs the call will block this conversation until the job finishes or you hit Ctrl+C — Claude Code's main pane renders Bash output once at the end (batch, not streaming), so you won't see events flow line-by-line.`

**Option B**:
- label: `Print copy-paste command for a fresh terminal`
- description: `I print the exact "node ... observe ..." command; you run it in another terminal window. Pros: real-time ANSI-colored event stream that updates line by line (Claude Code's main pane can't actually stream); does NOT block this conversation; Ctrl+C only exits the observer — the Codex job keeps running.`

# Step 2A — User picked "Run inline here"

Invoke `Bash` **immediately as the next action**. Do not summarize first. Do not announce. Do not stop.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" observe $ARGUMENTS
```

After it returns, print its stdout **verbatim** to the user. Do not summarize, recolor, or rewrap the event list.

# Step 2B — User picked "Print copy-paste command for a fresh terminal"

Do not call `Bash`. Print the following verbatim (substituting `$ARGUMENTS` into both places), wrapped in a fenced bash block so it's one-click copyable:

```text
打开一个新终端窗口，运行：

```bash
cd <your-project-root>
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" observe $ARGUMENTS
```

好处：
- 真正的实时事件流（彩色 ANSI），逐行刷新（Claude Code 主窗口做不到这点 — 它对 Bash 输出是批式渲染）
- 不阻塞当前对话，你能边看 observer 边继续在 Claude Code 里做别的事
- `Ctrl+C` 只退观察器，**Codex 任务继续运行**
```

# codex-plugin-cc-opt：变更说明与验证指南

## v2.0.1 紧急修复（2026-05-23）

**2.0.0 的问题**：在大 diff（>50 文件 / >10k 行）场景下，`/codex:review` 与 `/codex:adversarial-review` 在用户回答推荐弹窗 `Wait for results` 之后 **不会真正启动 review** —— `/codex:status` 显示无 job 在跑，用户看不到任何 `[codex] ...` 流式输出。

**根因**：上游 1.0.4 模板带的 "估算 diff 大小 → AskUserQuestion → 走前台/后台流程" 三段式 ceremony，估算阶段跑了 `git status` + 多次 `git diff --shortstat`（其中一次跑得很慢），把 Claude 的 context 占满，回答弹窗后 Claude 误以为任务已结束，遗漏了最关键的 `Bash(node ... review)` 调用。

**修复（smart estimate 方案）**：把两个命令模板改成"分支式决策流"。

1. **Step 1 — Fast path on explicit flag**：如果用户传了 `--background`，跳过一切直接走后台。
2. **Step 2 — Estimate diff size (ONE Bash call only)**：只跑**一条** `git diff --shortstat`（或 `--base` 指定的 ref-diff），解析 `N files changed, M insertions, K deletions`。这一限制避免了 2.0.0 估算阶段 3+ 个 git 命令叠加占满 context 的根因。
3. **Step 3 — Branch on size**：
   - **小 diff**（files ≤ 30 AND total 行 ≤ 3000）→ **直接前台跑**，不问。
   - **大 diff**（files > 30 OR total > 3000）→ AskUserQuestion 推荐用户走后台（避免长时间阻塞对话）。问答后**强约束**：下一个动作必须是对应的 `Bash` 调用，不准 summarize、不准 announce、不准 stop。

`allowed-tools` 收紧到 `Bash(node:*), Bash(git diff --shortstat:*), Bash(git status --short:*), AskUserQuestion, PushNotification` —— 移除了 `Read`/`Glob`/`Grep` 和宽松的 `Bash(git:*)`，把"误启其它工具走神"的机会降到最低。

**用户侧的体验变化**：
- 小改动直接跑，无任何弹窗 ceremony。
- 大改动（>30 文件或 >3000 行）会问一次"前台 / 后台"，**推荐后台**。后台可用 `/codex:observe` 实时看流。
- 想跳过弹窗直接后台跑：`/codex:review --background`。

---

> 本仓库是 [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) 的优化分叉。
> 在上游 1.0.4 的基础上：
> 1. 合入了 [`dragon84867/codex-plugin-cc`](https://github.com/dragon84867/codex-plugin-cc) 1.2.6 已修复的多项底层 bug 与新增能力；
> 2. 自行重构了 `/codex:review` 与 `/codex:adversarial-review`，让它们**过程可见、结果中文、跑完通知**。
>
> 版本号：**2.0.1**
> Marketplace 名：`openai-codex-opt`（可与官方版 `openai-codex`、dragon 版 `dragon-cc-codex` 共存）
> 插件本体名（用于安装）：`codex`

---

## 一、安装

Claude Code 的 marketplace 是去中心化的：没有中央目录，公开 GitHub 仓库 + `.claude-plugin/marketplace.json` 即可。

### Step 1. 卸载官方版（如果之前装过）

在 Claude Code 里逐条执行：

```text
/plugin uninstall codex@openai-codex
/plugin marketplace remove openai-codex
```

> 如果你之前装过 dragon 版 `codex@dragon-cc-codex`，可以保留共存，因为本插件改了 marketplace 名（`openai-codex-opt`）；当然也可以卸：`/plugin uninstall codex@dragon-cc-codex` 然后 `/plugin marketplace remove dragon-cc-codex`。

### Step 2. 安装本插件

```text
/plugin marketplace add aihuangjun/codex-plugin-cc
/plugin install codex@openai-codex-opt
/reload-plugins
```

### Step 3. 检查环境

```text
/codex:setup
```

应看到 Node / npm / Codex CLI 三栏都 ready，并显示 Codex 登录状态。如果未登录，按提示 `!codex login`。

### Step 4. 升级（以后版本更新时）

```text
/plugin update codex@openai-codex-opt
/reload-plugins
```

### Step 5. 卸载本插件

```text
/plugin uninstall codex@openai-codex-opt
/plugin marketplace remove openai-codex-opt
```

---

## 二、变更总览

按类别列出本版本相对官方 1.0.4 的所有差异。

### A. 底层 bug 修复（合自 dragon fork）

| # | 问题 | 修复方式 |
|---|---|---|
| A1 | `sandbox_mode` 硬编码，不读用户配置 | 自动读 `~/.codex/config.toml` 或 `./.codex/config.toml`，缺省回退 `workspace-write` / `read-only` |
| A2 | broker 进程泄漏（孤儿进程累积） | `ensureBrokerSession` 默认 `killProcess = terminateProcessTree`，broker 闲置自动退出 |
| A3 | 与当前 codex 协议存在 drift | `DEFAULT_CAPABILITIES` 加 `requestAttestation: false`，移除已废弃的 `experimentalRawEvents` |
| A4 | 后台任务过程黑盒，看不到 Codex 在干什么 | 新增 `.events.jsonl` append-only 事件流；新增 `/codex:observe` 命令实时观察（带 ANSI 彩色） |
| A5 | 后台任务跑完无通知，需手动 `/codex:status` 轮询 | 任务完成写 signal file，触发 PushNotification 自动唤醒主线程 |
| A6 | `/codex:rescue` 会直接修改主工作目录 | 新增 `--worktree` 隔离模式，Codex 在 `.claude/worktrees/<jobId>/` 独立分支干活 |
| A7 | 跨 workspace job 查询失效（observe/status/result/cancel） | 扫描多个 state root，跨 session 也能定位到 job |

### B. review / adversarial-review 三大增强（本仓库自研）

| # | 能力 | 实现 |
|---|---|---|
| B1 | 过程可见：跑 review 时实时看到 Codex 在干什么 | 前台模式下，companion 将每个 codex 协议事件（启动线程、命令执行、文件改动、工具调用、reasoning）以 `[codex] ...` 前缀实时打印到 stderr，零 buffer |
| B2 | 中文结果输出 | 新增 `prompts/review.md`、重写 `prompts/adversarial-review.md`，在 prompt 顶部加 `<output_language>` 强约束：summary/findings/body/recommendation/next_steps 全用简体中文；JSON 枚举值（verdict/severity）和代码标识符保留英文 |
| B3 | 跑完主动通知 | 命令模板让 Claude Code 在 review 返回结果后调用 `PushNotification`；后台模式则由插件 signal file 自动触发，无需轮询 |
| B4 | review 支持 focus 文本 | 之前 `/codex:review` 是 native-review only、不能加 focus；现在统一走 turn + prompt 模板，可在 flag 后追加 focus 描述 |
| B5 | 去除 native review 死代码 | 移除 `runAppServerReview`、`renderNativeReviewResult`、`validateNativeReviewRequest`、`buildNativeReviewTarget` |
| B6 | reviewName 裸字符串改常量 | 新增 `REVIEW_KINDS = { REVIEW, ADVERSARIAL }` 常量对象，统一 name/template/jobKind/title 字段 |

### C. 工程化 & 元数据

| # | 改动 | 说明 |
|---|---|---|
| C1 | marketplace 改名 `openai-codex` → `openai-codex-opt` | 与官方版、dragon 版共存 |
| C2 | 版本号 1.0.4 → 2.0.0 | 重大重构，按 SemVer major 提升 |
| C3 | 作者改为 `shengxia.hj` | fork 维护者 |
| C4 | 新增 `docs/CHANGES_AND_USAGE.md` | 本文档 |

---

## 三、验证场景

每个变更都给一条可复制粘贴的指令。在 Claude Code 里直接执行，或者按"绕过 Claude Code 直接跑底层"那一节的方式在你自己的终端跑。

### 场景 1：B1 + B2 + B3 — `/codex:review` 中文结果 + 流式过程 + 完成通知

**前置**：在某个 git 仓库里制造点改动（修一个文件、加一个未跟踪文件都行）。

**指令**：

```text
/codex:review
```

或带 focus 文本：

```text
/codex:review 重点看认证和会话管理
```

> 默认前台跑，stderr 流式打 `[codex] ...`。想后台跑加 `--background`。

**期望**：
- Claude Code 主界面流式打印 `[codex] Starting Codex task thread.` → `Thread ready (...)` → `Turn started (...)` → 可能还有 `Running command: ...`、`Reasoning summary captured: ...`、`Assistant message captured: ...`、`Turn completion inferred`。每一行间隔几百毫秒到几秒不等，能感觉到"在动"。
- 跑完后输出 `# Codex Review` markdown 块，里面 `Verdict: approve|needs-attention`，`Summary` / `Findings` / `Recommendation` / `Next steps` **全部中文**；`verdict` / `severity` 枚举值和代码标识符（函数名、变量名、文件路径）保留英文。
- Claude Code 收到 PushNotification 提示 "Codex review finished — see the verdict above."

### 场景 2：B1 + B2 + B3 — `/codex:adversarial-review` 对抗式中文审查

**指令**：

```text
/codex:adversarial-review 这种缓存设计在并发场景会不会出问题
```

**期望**：和场景 1 类似，但中文 findings 更带"挑战式"语气（质疑设计假设、推测失败模式、ship/no-ship 判断），不是常规审查口吻。

### 场景 3：A4 + A5 — 后台任务过程可见 + 完成通知

**指令**：

```text
/codex:rescue --background 调查并修复 src/auth.js 的 token 校验问题
```

紧接着在**另一个终端**（不是 Claude Code 里）：

```bash
cd <你的项目目录>
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" observe
```

或者在 Claude Code 里：

```text
/codex:observe
```

**期望**：
- observe 终端开始**彩色**滚动 Codex 当前在做什么：青色工具调用、蓝色命令执行、绿色 exit 0、红色失败、黄色文件改动、灰色 reasoning。
- 按 `Ctrl+C` 退出 observer，Codex 任务**继续跑**（observer 是只读的，不抢锁）。
- Codex 跑完，Claude Code 主线程收到 PushNotification：`Codex task task-xxxx finished: completed. Run /codex:result task-xxxx to see output.`

### 场景 4：A6 — `--worktree` 工作目录隔离

**前置**：在主工作目录里有未提交的改动。

**指令**：

```text
/codex:rescue --worktree --background 调查这个失败的集成测试
```

**期望**：
- 插件在 `.claude/worktrees/task-xxxx/` 下开一个独立 worktree + 独立分支，Codex 进去干活。
- 你的**主工作目录纹丝不动**，未提交改动还在。
- Codex 完事后通知你，你自己决定要不要 `cd .claude/worktrees/task-xxxx/ && git diff` 看然后合回主分支。

### 场景 5：A1 — sandbox_mode 配置读取

**前置**：在项目下建 `.codex/config.toml`：

```toml
sandbox_mode = "workspace-write"
```

**指令**：

```bash
# 在项目目录下，直接跑底层验证读取结果
node -e '
import("'${CLAUDE_PLUGIN_ROOT:-/Users/hj/.claude/plugins/aihuangjun-codex-plugin-cc/plugins/codex}'/scripts/lib/codex-config.mjs").then(m => {
  console.log(m.resolveCodexSandboxMode(process.cwd()));
});'
```

**期望**：输出 `workspace-write`。若 config.toml 缺失或没写 `sandbox_mode`，输出 `null`（companion 会回退默认）。

### 场景 6：A2 — broker 进程治理

**指令**：
```bash
# 跑任意 review/task，等它结束 6 秒后查 broker 进程数
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review --wait
sleep 6
pgrep -fc app-server-broker
```

**期望**：返回 `0` 或 `1`（之前可能累积几百个孤儿进程）。

### 场景 7：B4 — `/codex:review` 支持 focus 文本

之前的 `/codex:review` 是 native-review only，加 focus 会拒绝。现在改造后接受。

**指令**：

```text
/codex:review 仅关注 SQL 注入和 XSS
```

**期望**：成功执行，Codex 的输出在 findings 里会更聚焦你指定的关注点。

### 场景 8：B5 — `/codex:status` / `/codex:result` 跨 session 查询

**指令**：

```text
/codex:status --all
```

**期望**：列出所有 workspace、所有 session 的 codex job。指定 job id 跨 session 也能取到详情：

```text
/codex:result task-xxxxxxxx
```

---

## 四、绕过 Claude Code 直接跑底层（最适合排错和压力测试）

如果 Claude Code 里看到的体验不够"实时"，直接终端跑能看到最原始的事件流：

```bash
# review 命令
cd <你的 git 项目>
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review --wait

# adversarial-review
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" adversarial-review --wait "focus 文本"

# task（rescue 类） 
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --wait "找出所有 TODO 注释"

# 后台 task + observe
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --background "重构 user.js"
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" observe
```

`CLAUDE_PLUGIN_ROOT` 默认是 `~/.claude/plugins/aihuangjun-codex-plugin-cc/plugins/codex`（具体路径以你机器上 `/plugin install` 后的真实位置为准）。

---

## 五、回归测试

本仓库有 158 个 Node 单元测试，跑：

```bash
cd <仓库根>
npm test
```

期望 157 pass / 1 fail。唯一失败的 `commands lazily start and reuse one shared app-server after first use` 是上游 dragon fork 自带的 timing-flaky 测试，与本次改动无关（已在 dragon HEAD 上二次验证同样失败）。

---

## 六、问题排查

| 现象 | 排查 |
|---|---|
| `/codex:review` 输出还是英文 | 检查 `prompts/review.md` 顶部是否有 `<output_language>` 块；检查 codex CLI 版本是否 ≥ 0.130，旧版可能对 prompt 顶部指令支持不稳定 |
| 看不到 `[codex] ...` 流式输出 | 直接终端跑底层 `node ... review --wait` 验证；如果终端能看到、Claude Code 里看不到，是 Claude Code 渲染 background bash 的策略问题 |
| PushNotification 没弹 | macOS 看通知中心权限；前台模式由 Claude 主动调用，确认 commands/review.md 的 allowed-tools 含 `PushNotification` |
| broker 进程仍在累积 | `pgrep -af app-server-broker` 看 PID，`kill -9` 清掉；下次 review/task 调用时会重启新 broker；如果持续累积，检查是否有 Node 进程异常崩溃 |
| `--worktree` 报"already exists" | `git worktree list` 看是否有残留；用 `git worktree remove .claude/worktrees/<jobId>` 清掉 |

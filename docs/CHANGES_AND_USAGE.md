# codex-plugin-cc-opt：变更说明与验证指南

> 完整版本历史看仓库根 [`CHANGELOG.md`](../CHANGELOG.md)。本文聚焦：**怎么装** + **每个新能力怎么验证**。
>
> 版本：**2.0.2** ｜ marketplace：`openai-codex-opt` ｜ 作者：`shengxia.hj`
> 上游：`openai/codex-plugin-cc` 1.0.4 ｜ 还合并了 `dragon84867/codex-plugin-cc` 1.0.4 → 1.2.6 的底层修复

---

## 一、安装

Claude Code 的 marketplace 是去中心化的：public GitHub 仓库 + 根目录 `.claude-plugin/marketplace.json` 就够了。

### 1. 卸载官方版（之前装过才需要）

```text
/plugin uninstall codex@openai-codex
/plugin marketplace remove openai-codex
```

> 装过 dragon 版 `codex@dragon-cc-codex` 可以保留（marketplace 名不冲突），也可以同样卸掉。

### 2. 安装本插件

```text
/plugin marketplace add aihuangjun/codex-plugin-cc
/plugin install codex@openai-codex-opt
/reload-plugins
/codex:setup        # 应看到 Node / npm / Codex CLI 三栏 ready；未登录按提示 !codex login
```

### 3. 升级 / 卸载

```text
/plugin update codex@openai-codex-opt           # 升级
/plugin uninstall codex@openai-codex-opt        # 卸载插件
/plugin marketplace remove openai-codex-opt     # 卸载 marketplace
```

---

## 二、能力总览

| 类别 | 能力 | 来源 |
|---|---|---|
| review 体验 | `[codex] ...` stderr 实时事件流（前台模式可见 Codex 启动 / turn 状态） | 自研 |
| review 体验 | 结构化中文 verdict / findings / recommendations / next_steps（枚举值和代码标识符保留英文） | 自研 |
| review 体验 | 完成自动 PushNotification（前后台都有） | 自研 |
| review 体验 | `verdict=needs-attention` + critical/high findings 时尾部自动追加可复制的 `/codex:rescue --background ...` | 2.0.2 自研 |
| 新命令 | `/codex:diff (--file \| --commit \| --range)` 灵活 review 目标 | 2.0.2 自研 |
| 新命令 | `/codex:history` 历史 review verdict 表 | 2.0.2 自研 |
| 新命令 | `/codex:observe` 彩色实时事件观察器（只读，不抢线程锁） | dragon |
| 后台任务 | `--background` 后立即返回 launch payload，含 jobId + `/codex:status\|observe\|result\|cancel <jobId>` 四件套 | 2.0.2 自研 |
| 后台任务 | 完成 signal file → PushNotification 自动唤醒（无需轮询） | dragon |
| 隔离 | `/codex:rescue --worktree` 在独立分支干活，主目录不动 | dragon |
| 配置 | 自动读 `~/.codex/config.toml` 或 `./.codex/config.toml` 的 `sandbox_mode` | dragon |
| 治理 | broker 进程闲置自动退出（不再泄漏） | dragon |
| 治理 | 跨 workspace job 查询（status / observe / result / cancel） | dragon |
| 协议 | 与当前 codex 协议对齐（`requestAttestation`、移除 `experimentalRawEvents`） | dragon |

工程化：marketplace 改名 `openai-codex-opt` 与官方/dragon 版共存；CI 跑 `npm test` + `npm run check-version`；`npm run bump:patch\|minor\|major` 一键同步 4 处版本号。

---

## 三、验证场景

每个场景给 1-2 条可复制的指令 + 期望输出。在你正在改动的 git 项目里跑。

### 场景 1：`/codex:review` 与 `/codex:adversarial-review`

**指令**：

```text
/codex:review                              # 默认全工作树
/codex:review 重点看认证和会话管理         # 加 focus 文本
/codex:review --base main                  # 改成对 main 分支的 diff
/codex:adversarial-review 缓存方案的并发安全
```

**期望**：
- 小 diff 直接跑（无弹窗）；大 diff（>30 文件或 >3000 行）会问一次"前台/后台"。
- stderr 实时打 `[codex] Starting Codex task thread.` / `Thread ready (...)` / `Turn started (...)` / `Assistant message captured: ...` / `Turn completion inferred ...`。
- stdout 中文 `# Codex Review` markdown：`Verdict: approve|needs-attention`、中文 `Summary` / `Findings` / `Recommendation` / `Next steps`；`verdict`、`severity` 枚举值和代码标识符（函数名/文件名）保留英文。
- 跑完 Claude Code 收 PushNotification。

`/codex:adversarial-review` 同样规则，但 verdict / findings 带"挑战式"语气（质疑设计假设、推测失败模式）。

### 场景 2：`/codex:diff` 灵活 review 目标（v2.0.2）

```text
/codex:diff --file src/auth.js
/codex:diff --commit HEAD~3
/codex:diff --range main..feature/auth
/codex:diff --file src/auth.js focus on session lifecycle
```

**期望**：同 `/codex:review` 的中文 verdict 结构，但只针对指定文件 / commit / 范围。`--file` / `--commit` / `--range` 必须**恰好一个**。

### 场景 3：后台任务异步控制 + observe + 完成通知（v2.0.2 体验合并）

任一 `--background`：

```text
/codex:review --background
/codex:adversarial-review --background
/codex:diff --file src/auth.js --background
/codex:rescue --background 修一下这个失败的集成测试
```

**期望** — 命令立即（< 1 秒）返回 launch payload：

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

后续四种异步操作（任选）：
- **看状态**：`/codex:status review-abc1234`
- **实时观察**：`/codex:observe review-abc1234`（或在另一个终端跑 `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" observe review-abc1234`）—— 彩色滚动：青色工具调用 / 蓝色命令执行 / 绿色 exit 0 / 红色失败 / 黄色文件改动 / 灰色 reasoning。`Ctrl+C` 只退观察器，任务继续。
- **拿结果**（任务完成后）：`/codex:result review-abc1234`
- **取消**：`/codex:cancel review-abc1234`

任务完成时 Claude Code 主线程自动收到 PushNotification — 不需要轮询。

### 场景 4：`/codex:history` + 自动 rescue 建议（v2.0.2）

```text
/codex:history                  # 本仓库最近 20 条 review
/codex:history --all --limit 5  # 跨 workspace、最近 5 条
/codex:history --json           # 原始 JSON
```

**期望**：表格输出，每行一个历史 review job：时间 / kind / verdict / findings 数 / jobId / summary；表下提示 `/codex:result <jobId>` 看完整 verdict。

**自动 rescue 建议**：跑一次会出 `needs-attention` 的 review（删一段校验代码即可），verdict 段后会追加：

```
💡 建议下一步：
   /codex:rescue --background 修复 <文件> 中的 <第一个 high/critical finding 标题>
   （在后台让 codex 尝试自动修复；不想自动修复可忽略此提示）
```

可直接复制这条 `/codex:rescue ...` 一键修。`approve` verdict 不会追加。

### 场景 5：`/codex:rescue --worktree` 工作目录隔离

**前置**：主目录有未提交改动，不想让 Codex 改主分支。

```text
/codex:rescue --worktree --background 调查并修复这个失败的集成测试
```

**期望**：
- 插件在 `.claude/worktrees/task-xxxx/` 下开独立 worktree + 独立分支，Codex 进去干活。
- **主工作目录纹丝不动**，未提交改动还在。
- Codex 完事后通知你；你自己 `cd .claude/worktrees/task-xxxx/ && git diff` 看然后决定合不合。
- `git worktree remove .claude/worktrees/task-xxxx` 清理。

### 场景 6：配置与排查

**6.1 `sandbox_mode` 配置读取**

```bash
# 在你项目里建 .codex/config.toml
echo 'sandbox_mode = "workspace-write"' > .codex/config.toml

node -e 'import("'${CLAUDE_PLUGIN_ROOT:-/Users/hj/.claude/plugins/cache/openai-codex-opt/codex/2.0.2/scripts}'/lib/codex-config.mjs").then(m=>console.log(m.resolveCodexSandboxMode(process.cwd())))'
```

期望输出 `workspace-write`。缺失或没写则 `null`（companion 会回退默认）。

**6.2 broker 进程不再泄漏**

```bash
# 跑一次 review/task，等 6 秒后看进程数
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review --wait
sleep 6
pgrep -fc app-server-broker
```

期望 `0` 或 `1`（之前可能累积几百个孤儿）。

**6.3 跨 workspace 查询**

```text
/codex:status --all              # 列所有 workspace 的 job
/codex:result task-xxxxxxxx      # 跨 session/workspace 取详情
```

---

### 场景 7：任务可靠性（v2.0.6）——不再"卡在 queued / 长时间无响应"

三个可直接验证的行为：

1. **后台任务一定会结束**（要么 completed/failed，要么可 cancel）：

   ```text
   /codex:rescue --background 只回复 PONG，不要执行任何命令
   ```

   **期望** — 10～30 秒内 `/codex:status <jobId>` 变为 `completed`，`.done` 信号文件出现。旧版在大仓库（如 home 目录本身是 git 仓库）里 100% 卡在 `queued`：worker 比 job 记录先出生、读不到记录就静默退出。

2. **worker 死掉会被识别**：`kill -9` 掉 `/codex:status` 里 running 任务的 pid，再跑 `/codex:status <jobId>`。

   **期望** — 状态变为 `failed`，错误信息 `Worker process <pid> exited before the job finished.`，`.done` 已写出（Monitor 会被唤醒），`/codex:result` 可读。

3. **前台任务被杀不丢结果**：终端里跑 `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task "..."` 然后 `Ctrl+C`。

   **期望** — 打印 "still running" 提示和 job id；稍后 `/codex:result <jobId>` 能拿到结果。前台默认最多等 9.5 分钟（`--timeout-ms` / `CODEX_COMPANION_FOREGROUND_TIMEOUT_MS` 可调），超时同样打印提示并正常退出，任务继续。`CODEX_COMPANION_FOREGROUND_INLINE=1` 可切回旧的进程内执行。

另外：`task --help` 现在打印用法（旧版会把 `--help` 当 prompt 发给 Codex 白跑一轮）；只含 flag 的 prompt 会被直接拒绝。

## 四、绕过 Claude Code 直接跑底层

最适合排错和确认"流式真的实时刷新"（Claude Code 的 stdout 渲染是批式，终端是真流式）：

```bash
cd <你的项目>

# review 三件套
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review --wait
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" adversarial-review --wait "focus"
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" diff --file src/x.js --wait

# rescue (task)
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --wait "找出所有 TODO"

# 后台 + observe
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" task --background "重构 user.js"
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" observe         # 跟最新任务
```

`CLAUDE_PLUGIN_ROOT` 装完后由 Claude Code 注入；终端里需要用绝对路径，如 `~/.claude/plugins/cache/openai-codex-opt/codex/<version>/scripts/codex-companion.mjs`。

---

## 五、回归测试

```bash
git clone https://github.com/aihuangjun/codex-plugin-cc.git
cd codex-plugin-cc
npm install
npm test
```

预期 157 / 158 pass。唯一失败的 `commands lazily start and reuse one shared app-server after first use` 是 dragon fork 自带的 timing-flaky，已在 dragon HEAD 二次确认同样失败，与本 fork 改动无关。

---

## 六、问题排查

| 现象 | 排查 |
|---|---|
| review 还是英文 | 检查 codex CLI ≥ 0.130；旧版对 prompt `<output_language>` 块支持不稳定 |
| 看不到 `[codex] ...` 流 | 直接终端跑底层（见上一节）验证；Claude Code 渲染策略是批式不是逐行，看到几行一次性 dump 是正常的 |
| PushNotification 没弹 | macOS 看通知中心权限；命令模板的 `allowed-tools` 应含 `PushNotification`（升级后默认就有） |
| broker 仍累积 | `pgrep -af app-server-broker` 看 PID 全 `kill -9`；下次 review/task 会重启新 broker |
| `--worktree` 报 "already exists" | `git worktree list` 看残留；`git worktree remove .claude/worktrees/<jobId>` 清掉 |
| `/codex:status` 看不到刚启动的后台 job | 等 1-2 秒（worker spawn 需要时间）再查；或用 launch payload 给的 jobId 直接 `/codex:status <jobId>` |
| 后台任务一直 `queued` / `running` | v2.0.6 起 `/codex:status` 会自动把 worker 已不存在的任务标记为 `failed`；查看 `<jobsDir>/<jobId>.log`，worker 的启动错误现在会写进去 |
| rescue subagent 返回空 | 多半是 Bash 工具 2 分钟超时杀掉了前台进程；v2.0.6 起任务在 detached worker 中继续，`/codex:status` / `/codex:result <jobId>` 可取回；agent 已要求 Bash `timeout: 600000` |

---

## 附录：发布历史摘要

完整变更看 [`CHANGELOG.md`](../CHANGELOG.md)。

- **2.0.2 (2026-05-24)**：新增 `/codex:diff` / `/codex:history`；review 后自动建议 rescue；后台任务统一 launch payload 含 jobId + 4 个控制命令；工程化（CI check-version、`npm run bump:patch|minor|major`、fork-specific README、根 CHANGELOG）。
- **2.0.1 (2026-05-23)**：紧急修复 2.0.0 在大 diff 下 `/codex:review` 启动后 Bash 调用被遗漏的 bug。命令模板改为"三步决策流"：`--background` 直跑后台 ｜ 估算只调一次 `git diff --shortstat` ｜ 小 diff 直接前台、大 diff `AskUserQuestion` 后**强约束**立即 Bash。
- **2.0.0 (2026-05-23)**：流式 `[codex] ...` stderr 事件、中文 verdict、完成 PushNotification；合并 dragon 1.0.4→1.2.6 的所有底层修复与新能力（observe、worktree、broker 治理、协议对齐、events.jsonl、跨 workspace 查询、signal file 通知）；marketplace 改名为 `openai-codex-opt` 与官方/dragon 版共存。

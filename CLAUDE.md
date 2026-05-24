# codex-plugin-cc 项目守门规则

> 这是项目级 Claude Code 守则。每次对话进入这个仓库时由 harness 自动加载到上下文。
> 任何 Claude 在该仓库里工作时**必须**遵守。

## 一、Push / tag / release 类动作必须先问

下面任何动作落地前，**必须**通过 `AskUserQuestion` 拿到用户的明确授权——不能因为"上下文里看起来要发版"就自动执行：

1. **`git push`**（任何远端、任何分支、任何 ref）
2. **`git push --tags`** / 推送任意 tag
3. **`git tag`** 创建本地 tag（创建虽然本地，但下一步几乎必然 push，必须一并对焦）
4. **`gh release create`** / **`gh release edit`** / **`gh release delete`**
5. **`gh pr create`** / **`gh pr merge`** / **`gh pr close`**
6. **`gh issue create`** / **`gh issue close`** / **`gh issue comment`**
7. 任何强制重写远端的命令（`git push --force`、`git push origin :ref`）
8. **`npm publish`** / **`npm run release`**（包含上面这些动作的组合脚本）
9. 修改 GitHub repository settings、collaborators、protected branches 等

问的时候要列出：**做什么** + **影响什么**（哪些用户能立刻看到）+ **是否可逆**。

## 二、CHANGELOG 状态变更也要先问

`CHANGELOG.md` 是 release notes 的真实来源。下面这些编辑必须先问：

- 把 `[Unreleased]` 段提升为 `## [X.Y.Z] — YYYY-MM-DD`（这等于在标记"已发布"）
- 在已有 `## [X.Y.Z]` 段下追加或修改条目（修改已发布版本的 release notes）
- 删除任何已发布版本段

读取或在 `[Unreleased]` 下累积条目可以自由做，不需要问。

## 三、本地 commit 不需要问，但要诚实可逆

`git commit` 本地操作不算"必须先问"。但：

- 不要 `--amend` 已经 push 到远端的 commit。
- 不要 `git rebase -i` 重写已 push 的历史。
- 任何会让本地和远端分叉的操作，落地前要预告。

## 四、bump 版本号不需要问，但要预告

`npm run bump:patch|minor|major` / `npm run bump-version X.Y.Z` 只改本地的 4 个 manifest，没推到远端，可以自由做。但做完要在响应里明确告诉用户："已 bump 到 X.Y.Z，未 commit"，让用户决定下一步。

## 五、对外可见的副作用类操作

任何会让"仓库以外的人"看到的动作，默认归在第一条。不确定算不算"对外可见"的话，按"算"处理 + 先问。

## 六、什么不需要问

- 文件编辑（`Edit` / `Write`）— 本地，可逆
- 本地 commit — 同上
- 跑测试 / lint / build — 只读
- 本地 git checkout / branch / stash — 没动远端
- 给用户列方案、给 dry-run 演示

## 七、违规的代价

如果违反了上面任何一条（push 了不该 push 的、发了不该发的 release 等），落地后立刻：

1. 主动告诉用户哪条规则被违反、做了什么
2. 给出撤回选项（如果可逆）+ 保留选项（如果不可逆）
3. 让用户决定，不要自己挽救

---

**这条 CLAUDE.md 的存在本身就是一次违规的产物**：v2.0.3 release 在没问用户的情况下被发布了。补上这条守则是为了让"先问"成为这个仓库的硬性约束，而不是依赖记忆。

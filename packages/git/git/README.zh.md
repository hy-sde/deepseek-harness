# @deepseek-ai/dsh-git

[English](README.md) | 中文

agent 化提交＋评审工作流（移植自 omp / oh-my-pi）的宿主 `ctx.git` 服务：经 [`ctx.subprocess`](../../subprocess/subprocess/README.zh.md) seam 对 `git` CLI 的轻量、无状态包装，外加面向模型方工具所需的 diff 解析原语与拆分提交执行动词。由 [`@deepseek-ai/dsh-tool-git`](../tool-git/README.zh.md) 消费，模型不直接调用。

## 功能

在组合上注册一个宿主服务（`ctx.git`）。其面：

- **仓库状态** — `isRepo`、`root`、`branch`、`status`、`hasStaged`。
- **Diff 读取** — `diffText`、`fileDiffs`，以及包含派生读形状（`changedFiles`、`numstat`、`has`）的 `diff` 命名空间。diff 以 `--binary` 捕获，因此二进制变更能安然通过暂存往返。
- **暂存** — `addAll`（`git add -A`）、`resetIndex`（`git reset`）、以及 `stageHunks`：把记录的 `--cached` diff 按 hunk 选择切回索引（omp `stage.hunks` 移植）。
- **提交／推送／日志** — `commit`（消息经 stdin）、`push`（`--no-follow-tags`）、`log`。

diff 词汇位于 [`types.ts`](src/types.ts) 与 `diff.ts`（带重命名处理的 numstat、hunk 解析／选择／校验）；拆分机制对应 omp（拓扑提交排序、锁文件自动归位）。

## 执行模型

每条 git 调用都经 `ctx.subprocess`：独立的 wall-clock 超时（`timeoutMs`，默认 120 秒）、`SIGTERM→SIGKILL` 宽限（`graceMs`，默认 5 秒）、有界收集的 stdout／stderr（`maxStdoutBytes`／`maxStderrBytes`），以及转发给所派生进程的中止信号。非零退出对 probe 命令作为数据返回，对其他命令以可读的 [`GitCommandError`](src/service.ts) 抛出。

## 部分 hunk 暂存

`stageHunks` 依据记录的 diff 重建补丁，并以 `git apply --cached` **不加** `--binary` 的方式应用于文本补丁：对携带 `index <old>..<new>` 的头部传入 `--binary`，会使 `git apply` 找到两个 blob 并暂存*整个*新 blob，静默破坏 hunk 粒度。内嵌二进制的补丁仍以 `--binary` 应用。

## 配置

- `gitPath` — 可执行文件名（默认 `git`），经 subprocess seam 解析。
- `timeoutMs`，受上述上限保护 — 每条命令的 wall-clock 预算。
- `maxStdoutBytes`、`maxStderrBytes` — 收集上限。
- `graceMs` — 进程树终止宽限。

## Model Experience

间接，经消费方（`@deepseek-ai/dsh-tool-git` 拥有 `commit`／`commit_apply`／`review` schema、`git:` 提示词 section 与结果渲染）。

#### KV Cache effect

无直接失效；已命名的消费方拥有各自的请求前缀变更。

## 已知限制与待办

- **仅提交／评审子集** — 无交互式 rebase、amend、stash、bisect 或 submodule 动词；编辑器与交互式历史改写留在此 seam 之外。
- **每次调用都 shell-out** — 无持久 git daemon 或进程内索引缓存；每个动词派生 `git` 并收集有界输出。
- **无凭据／存储管线** — 服务假定环境提供 git 认证（SSH agent、credential helper），不管理 remote、密钥或签名。

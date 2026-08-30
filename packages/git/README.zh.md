---
description: "本地 git 仓库: Host git 命令 seam 以及面向模型的 commit/commit_apply/review 工具 工具."
kind: "package-group"
---
# packages/git

[English](README.md) | 中文

## 摘要

`git/` 组提供[`git/`](git/README.zh.md)、[`tool-git/`](tool-git/README.zh.md)。二者共同让 agent 基于暂存的 diff 进行模型驱动的提交与评审。

## 目录

- [相关文档](#related-documentation)

-----

<a id="related-documentation"></a>
## 相关文档

[子系统参考文档](../../docs/subsystems/git.zh.md)拥有穷尽式约定；下方每个包的 README 都会从各自的页面链接到它。

| 包 | 职责 |
|---|---|
| [`git/`](git/README.zh.md) | 基于工作区仓库的 Host git 命令 seam |
| [`tool-git/`](tool-git/README.zh.md) | 面向模型的 `commit`、`commit_apply` 与 `review` 工具 |

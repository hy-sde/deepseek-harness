---
description: "Host VCS 工作树 seam：为读写 agent 仓库的消费方提供文件状态与归属服务。"
kind: "package-group"
---
# packages/vcs

[English](README.md) | 中文

## 摘要

`vcs/` 组提供[`vcs/`](vcs/README.zh.md)。它暴露宿主工作树 seam：为读写工具和共享仓库契约的 git 工具提供 VCS 路径解析与文件状态归属。面向模型的 VCS 行为由 `dsh-tool-git` 承担；本组贡献宿主侧基础。

## 目录

- [相关文档](#related-documentation)

-----

<a id="related-documentation"></a>
## 相关文档

[子系统参考文档](../../docs/subsystems/git.zh.md)拥有工作区与 git 契约；包的 README 会从自己的页面链接到它。

| 包 | 职责 |
|---|---|
| [`vcs/`](vcs/README.zh.md) | 基于工作区工作树的 Host VCS seam |

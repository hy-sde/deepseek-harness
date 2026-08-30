---
description: "仓库 wiki 生命周期：移植的确定性引擎核心及其五个面向模型的工具。"
kind: "package-group"
---
# packages/openwiki

[English](README.md) | 中文

## 摘要

`openwiki/` 组提供 [`openwiki-core/`](openwiki-core/README.zh.md)——进程内运行的移植确定性 wiki 引擎（可恢复的 .run.json 检查点、页面清单、Grounded Claims、OKF 前言修复与索引同步）——以及带五个生命周期工具（`openwiki_begin`、`openwiki_submit_plan`、`openwiki_next_page`、`openwiki_submit_page`、`openwiki_finish`）的 [`tool-openwiki/`](tool-openwiki/README.zh.md)。

## 目录

- [包](#packages)

-----

<a id="packages"></a>
## 包

| 包 | 职责 |
|---|---|
| [`openwiki-core/`](openwiki-core/README.zh.md) | 移植的确定性 openwiki 引擎核心 |
| [`tool-openwiki/`](tool-openwiki/README.zh.md) | 五个仓库 wiki 生命周期工具 + `openwiki:tools` 提示词 section |

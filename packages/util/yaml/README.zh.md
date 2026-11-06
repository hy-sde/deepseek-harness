---
description: "统一 YAML 解析，支持 harness 的 entryList 选项以处理 !!js 表达式标量。"
kind: "package-reference"
---

# dsh-yaml

[English](README.md) | 中文

## 概述

基于 npm `yaml` 包为 harness 提供统一 YAML 解析——`load`/`loadAll`/`dump` 包装器，外加 harness 的 `entryList` 选项：把 `!!js` 表达式标量解析为 `{ $js: '…' }` 对象，而不扩展 YAML schema。

## 目录

- [使用本包](#use-this-package)
- [API](#api)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 harness 代码解析 YAML 文档的地方从 `@deepseek-ai/dsh-yaml` 导入 `load`、`loadAll` 或 `dump`——boot 配置编辑与 vendored 的 `include` fork 共享这一表面，而不是各自依赖 `js-yaml` 或定制的 schema 扩展。

```ts
import { load } from '@deepseek-ai/dsh-yaml'

const config = load('agents:\n  - name: main', { entryList: true })
```

-----

<a id="api"></a>
## API

- `load(text, options?)` / `loadAll(text, options?)` — 解析 YAML 文档；`options.entryList` 把 `!!js` 表达式标量解析为 `{ $js: '…' }` 对象。
- `dump(value, options?)` — 序列化回 YAML；`options.entryList` 把 `{ $js: '…' }` 对象写回为 `!!js` 标量。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 boot 配置编辑和 vendored 的 `include` fork——它们解析 harness 配置文档；没有 YAML 内容作为语义内容进入提示词。

#### KV Cache 效应

没有直接失效；配置在宿主侧解析，从不进入模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些约束适用于包装器表面。

- 只包装经典 `yaml` 包 v2 表面；不翻译 `js-yaml` 特有选项（`JSON_SCHEMA`、`schema` 标签扩展）——从 `js-yaml` 迁移的调用点必须改用 `entryList` 选项或原生 `yaml` 包。
- `entryList` 是由 vendored `include` fork 与 boot 配置编辑共享的可选 load/dump 行为；不带它解析的文档会把 `!!js` 标量保留为普通字符串。

-----

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

Fork 独有包：替代 upstream 的 `js-yaml` 依赖与 vendored `include` 包的 `jsExprTag` schema 扩展。

</details>

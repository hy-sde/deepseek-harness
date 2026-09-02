---
description: "面向模型的 Automic Vault 工具组，供代理与维护者选择、配置或排查基于 host `ctx.av` 服务的只读审计、加固验证、目录与密钥名称列举能力。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-av

[English](README.md) | 中文

## 概述

基于 host `ctx.av` 服务的模型面向 Automic Vault 工具：`av_scan` 审计 Mac 上的凭证暴露，`av_doctor` 验证已安装的加固，`av_catalog` 列出 Automic Vault 认识的检测器与加固器，`av_list` 仅返回已保存密钥的名称。当代理应审计与报告而非改动系统时选择它——硬化、存储与注入值始终是在用户控制的终端中由人做出的决定。成本由每次调用的 `maxFindings` 与 `maxCatalogEntries` 上限加一次汇总后的子进程往返限定；边界是任何工具输出都不含 Secret 值。

## 目录

- [工具表面](#tool-surface)
- [安全规则](#security-rules)
- [配置](#configuration)
- [Model Experience](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

基于 host `ctx.av` 服务的模型面向 [Automic Vault](https://www.automicvault.com/) 工具。表面是有意只读的：审计 Mac 上的凭证暴露、验证加固、查看检测器/加固器目录、列出已保存的密钥名称——绝不把 Secret 值释放进模型上下文。

<a id="tool-surface"></a>
## 工具表面

- `av_scan [severity] [detector] [max_findings]`——完整审计；发现项携带 severity、说明、修复建议、影响的文件/行与产出它的检测器。
- `av_doctor [tool]`——加固验证；每个加固器的健康/问题状态，含修复建议与 stub/target 路径。
- `av_catalog [scope] [max_entries]`——Automic Vault 认识的检测器与加固器（名称 + 文档链接 + 状态），用于让代理正确瞄准 `av_scan` 与 `av_doctor`。
- `av_list`——仅已保存的密钥**名称**，绝不含值。

当 `av` CLI 缺失或损坏时，每个工具退化为结构化 `{ available: false, reason }` 值并给出安装提示（`brew install --cask automic-vault/isotopes/automic-vault`），而不是抛出异常。

<a id="security-rules"></a>
## 安全规则

1. 工具输出绝不包含 Secret 值。`av_list` 仅返回名称；扫描/检查/目录返回路径、配置与建议。
2. 代理报告暴露并提出文档化的修复；运行 `av harden <tool>`、保存密文或向命令注入值，都在用户控制的终端中由人决定。
3. 工具绝不绕过、禁用或自动批准 Automic Vault 授权门或审批。

<a id="configuration"></a>
## 配置

```ts
import { Context } from '@deepseek-ai/cordis'
import toolAvPackage from '@deepseek-ai/dsh-tool-av'

const ctx = new Context()
ctx.plugin(toolAvPackage, {
  maxFindings: 30, // av_scan finding cap
  maxCatalogEntries: 60, // av_catalog entries per scope
  enabled: true, // av:tools prompt section
})
```

<a id="model-experience"></a>
## Model Experience

### 工具 schema

四个工具用严格的 JSON-schema 参数注册，模型看到的是精确的文档化旋钮：`severity`（high/medium/low）、`detector`（来自 `av_catalog` 的名称）、`tool`（加固器名称）、`scope`（detectors/hardeners/both）以及整数上限。

#### What the model sees

工具描述把生成的 [`av_scan`、`av_doctor`、`av_catalog` 与 `av_list` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-av) 落到实处，写明只读契约，并把修复指向由人工运行的 `av harden` 命令，使模型审计与报告而非改动系统。

#### Token effect

每次工具调用在请求前缀增加一个工具 schema（四个小 schema，除三档严重度外无枚举膨胀）；执行是一次子进程往返，原始 stdout 被压缩为紧凑文本渲染。

#### KV Cache effect

没有依赖前序调用的动态字段；`av_catalog` 输出可跨轮复用，但不带来请求前缀失效。

### 结果值

每个工具返回结构化对象，含 `available`/`version` 与各表面字段；提供方保持字段名与 `av` CLI JSON 契约一一对应。

#### What the model sees

发现项、医生结果、目录条目与密钥名称都是纯数据——无密文、无原始 CLI 痕迹。渲染器把同样的事实以文本形式输出到会话面板。

#### Token effect

大型审计由 `maxFindings` 截断，其余以汇总计数呈现，因此无论机器状态如何（100+ 检测器配置可能产出大报告），令牌成本都有界。

#### KV Cache effect

结果值是每次调用的快照；无缓存层、无会改变模型重跑前缀的回读。

### Prompt 段

插件挂载时注册 `av:tools` system-prompt 段，使契约在任何调用之前可见。

#### What the model sees

一张简洁提示卡，提醒模型所有输出只读、加固/存储/注入仍是人工在终端的决定、CLI 缺失时会报告安装提示。

#### Token effect

请求前缀一次性加入三句话；每轮的代价可忽略。

#### KV Cache effect

静态段文本——无失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **无密库动词**——`av save`、`av inject`、`av proxy` 有意缺席；`av save` 只能交互式进行，值的释放保持人机循环。托管工具延后，直到上游 CLI 提供非 TTY 交接且能保证值不进入模型上下文或 argv。
- **无加固自动化**——工具只验证与建议；`av harden`（根权限系统变更）刻意留给用户运行。纯计划模式的加固预览可在不放松边界的前提下稍后加入。
- **过滤是透传**——`severity` 过滤在 CLI 返回完整报告后执行，约束渲染但不约束子进程输出上限。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>

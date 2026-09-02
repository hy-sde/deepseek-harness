---
description: "宿主平面、只读的 Automic Vault CLI 封装，供部署方与维护者选择、配置或排查 `ctx.av` 的审计、加固验证、检测器目录与密钥名称列举能力。"
kind: "package-reference"
---

# @deepseek-ai/dsh-av

[English](README.md) | 中文

## 概述

`ctx.av` 是宿主平面、只读的 Automic Vault 封装：解析 `av` 可执行文件、用 `av --version` 探测，并解析 `av scan --json`、`av doctor [tool] --json`、`av detectors --json`、`av hardeners --json` 与 `av list` 的 JSON 数据面。当代理或工具需要 Vault 事实时选择它——`@deepseek-ai/dsh-tool-av` 中的模型面向工具解析的正是此实例。代价是每次调用一次有界子进程 shell-out 与墙钟超时；边界是严格的：释放值的动词绝不会在此运行，因此 Secret 值不会进入模型上下文或 argv。

## 目录

- [执行的命令](#executed-commands)
- [安全边界](#security-boundary)
- [配置](#configuration)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

DeepSeek Harness 的 Automic Vault 管道：`ctx.av`，一个 host 平面、只读的 [Automic Vault](https://www.automicvault.com/) `av` CLI 封装，通过 `ctx.subprocess` 通道执行。模型面向的工具位于 `@deepseek-ai/dsh-tool-av`，解析此 host 实例。

服务解析 `av` 可执行文件（配置 → `DSH_AV_PATH` → PATH），用 `av --version` 探测，并解析 JSON 数据面：`av scan --json`（审计）、`av doctor [tool] --json`（加固验证）、`av detectors --json` 与 `av hardeners --json`（目录）、以及 `av list`（仅保存的密钥**名称**）。

<a id="executed-commands"></a>
## 执行的命令

| 方法 | CLI 调用 | 用途 |
|---|---|---|
| `probe` | `av --version` | 可达性 + 版本，绝不抛出 |
| `scan` | `av scan --json [detectors…]` | 审计 Mac 上的凭证暴露与风险 |
| `doctor` | `av doctor [tool] --json` | 验证已安装的加固 |
| `detectors` | `av detectors --json` | 检测器目录（喂给 `scan` 过滤器） |
| `hardeners` | `av hardeners --json` | 加固器目录，带 hardened/applicable 状态 |
| `list` | `av list` | 仅保存的密钥名称 |

所有命令通过 `ctx.subprocess` 运行，限制 stdout/stderr 收集、墙钟超时与 SIGTERM→SIGKILL 宽限。非零退出作为数据返回；只有启动失败、信号终止或超时才抛出 `AvCommandError`。

<a id="security-boundary"></a>
## 安全边界

- 本服务**绝不调用释放值的动词**（`av inject`、`av proxy`、`av save`、`av harden`）——它们保持在用户控制的终端中由人完成。
- `av list` 仅返回名称；服务没有任何返回已存 Secret 值的方法，也没有命令在 argv 上携带密文。
- 命令不做 shell 解释；argv 原样经子进程通道传递。

<a id="configuration"></a>
## 配置

```ts
import { Context } from '@deepseek-ai/cordis'
import avPackage from '@deepseek-ai/dsh-av'

const ctx = new Context()
ctx.plugin(avPackage, {
  avPath: '/usr/local/bin/av', // default: DSH_AV_PATH env, else `av` on PATH
  timeoutMs: 120000,
  maxStdoutBytes: 8 * 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  graceMs: 5000,
})
```

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- **无密库动词**——保存、注入、代理 Secret 值有意排除在表面之外；`av save` 本身是交互式的（从 `/dev/tty` 读取），未来的托管工具需要上游 CLI 变更。
- **每次调用都启动子进程**——与 Automic Vault 应用无持久连接；每个动词派生 `av` 并收集受限输出。
- **扫描输出可能很大**——8 MiB stdout 上限约束一次 `av scan`；工具层在渲染前汇总。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>

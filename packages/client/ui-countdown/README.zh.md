---
description: "浏览器侧 UI 插件的任务窗口倒计时组件，显示剩余时间并提供重启控制。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-countdown

[English](README.md) | 中文

## 概述

`dsh-client-ui-countdown` 是一个浏览器侧 UI 插件，为其他插件拥有的任务窗口渲染倒计时徽标：以紧凑的 `h m`/`m s` 单位显示剩余时间，提供 `Start` 与 `Restart` 控件，并暴露计时时长（包括自定义分钟数）的设置界面。它仅负责展示——拥有窗口的插件声明截止时间，本插件负责渲染且不改变模型上下文。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将本插件与拥有任务窗口的插件一同挂载。它通过客户端槽位契约读取拥有方插件发布的截止时间状态，并在每次计时跳动时重新渲染徽标。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `durationMinutes` | 拥有方决定 | 由拥有窗口暴露的计时时长；`Custom minutes` 可覆盖。 |
| `autoStart` | 拥有方决定 | 挂载后立即开始倒计时，还是等待用户按下 `Start`。 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

该插件是纯客户端界面组件：不持久化任何服务端状态，也不拥有宿主服务。计时仅在浏览器侧进行，因此宿主挂起或页面刷新都会重置可见的剩余时间。

-----

<a id="further-exploration"></a>
## 进一步探索

- [UI 基础组件](../../client/ui-primitives/README.zh.md) — 本插件组装的徽标与按钮组件。
- [客户端槽位](../../client/ui-slots/README.zh.md) — 拥有方插件发布截止时间的契约。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 计时器仅存在于浏览器端；宿主挂起或刷新会重置。
- 无跨窗口同步；多个打开的会话各自运行倒计时。

**运行时不变量：** 未发布 companion。本包没有同一进程内可观测的持续运行时关系；其行为由包的测试套件保障。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>

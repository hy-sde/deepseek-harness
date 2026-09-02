---
description: "面向模型的 agent 化浏览器工具，供代理与维护者选择、配置或排查基于 host `ctx.browser` 服务的 `browser` 工具（launch／attach／relay 三种后端）。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-browser

[English](README.md) | 中文

## 概述

模型方浏览器工具通过 launch／attach／relay 三种后端解析宿主 `ctx.browser` 服务，并注册一个 `browser` 工具与 `browser:tools` 提示段：它打开命名标签页、求值 JS、返回带 ARIA 快照的观察结果、截图并关闭标签页，并把标签页键按会话 id 命名空间隔离，并发会话不会互相夺走标签页。当代理必须通过共享宿主服务驱动真实浏览器——包括 harness 自己的 Web GUI——时选择它。步骤同步执行、渲染内容以文本摘要呈现，因此长耗时页面与像素级布局校验是主要边界。

## 目录

- [功能](#what-it-does)
- [ARIA ref](#aria-refs)
- [配置](#configuration)
- [会话隔离](#session-isolation)
- [瞄准本地 harness GUI](#targeting-the-local-harness-gui)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

DeepSeek Harness 的模型方 agent 化浏览器工具（移植自 omp / oh-my-pi），经 **launch／attach／relay** 后端解析宿主 [`ctx.browser`](../../browser/browser/README.zh.md) 服务。处于 agent 平面：本包以预设行挂载，不注册自己的服务。

<a id="what-it-does"></a>
## 功能

注册一个工具（`browser`）与 `browser:tools` 系统提示节：

- **open** — 导航命名标签页（`url`、`wait_until`、可选 `code` 在加载后运行），返回观察（title、url、ARIA 快照）。
- **run** — 在标签页内求值 `code`，然后尽力重观察。
- **state** — 不导航，直接返回当前观察。
- **close** — 关闭一个标签页、`all` 全部标签页，或配合 `kill` 关闭所派生的浏览器。
- **截图** — `screenshot: yes` 写出 PNG（进入 `screenshotDir`，默认 `<cwd>/.dsh-browser`）并返回路径供模型再读。

后端对应 omp 的 `app` 对象：`app.path` 派生带 stealth 补丁的浏览器，`app.cdp_url` 接入既有 CDP 端点，`app.relay` 通过本地 relay＋扩展驱动用户自己的标签页。

<a id="aria-refs"></a>
## ARIA ref

每次观察都携带带 `[ref=eN]` id 的 Playwright ARIA 快照。id 每张快照重新编号，并在下一次快照前保持有效；可用 CSS 选择器作为后备寻址。像素无关紧要时宜选快照而非截图 — 快照便宜，截图不便宜。

<a id="configuration"></a>
## 配置

- `cwd` — 默认工作目录（优先 session header；默认进程 cwd）。
- `maxAriaChars` — 返回给模型的 ARIA 快照上限（默认 20000）。
- `screenshotDir` — 截图输出目录（默认 `<cwd>/.dsh-browser`）。
- `waitUntil` — 默认等待条件（`load`）。
- `timeoutSeconds` — 默认单次调用超时（30）。

<a id="session-isolation"></a>
## 会话隔离

`browser` 服务共享于宿主平面；工具把标签页键按会话 id 命名空间隔离，因此并发会话不会互相夺走标签页。

<a id="targeting-the-local-harness-gui"></a>
## 瞄准本地 harness GUI

工具与 URL 无关，因此也可以直接驱动 harness 自己的 Web GUI（`dsh web`，`http://127.0.0.1:3080`）：`launch` 一个浏览器或 `attach` 到已运行的 Chrome，导航到本地 origin，直接操作 GUI 的会话历史与复盘界面。这样就为同一语料闭环——一个会话既可以是 URL（`session://<id>`），可以是工具结果（`session_query`），也可以是屏幕像素（browser → GUI）——而工具无需任何特判。

<a id="model-experience"></a>
## 模型体验

### 工具 Schema

#### 模型看到的内容

`dsh-tool-browser` 拥有浏览器自动化的 Schema 与结果渲染；已注册的入口点见 [`@deepseek-ai/dsh-tool-browser`](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-browser)。

#### Token 影响

插件挂载期间每次请求的 Schema token；成功的导航与读取步骤返回紧凑摘要。

#### KV Cache 影响

该插件自身不增加请求前缀文本；提供商缓存复用遵循提及浏览器状态的消费方提示。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 每步同步执行；长耗时页面需要显式超时或 `stop`。
- 渲染内容以文本摘要形式呈现给模型；不支持像素级布局校验。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>

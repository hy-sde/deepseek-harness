---
description: "宿主 `ctx.browser` 服务，供代理与维护者选择、配置或排查经 Chrome DevTools Protocol 的 launch、attach 与 relay 三种浏览器后端。"
kind: "package-reference"
---

# @deepseek-ai/dsh-browser

[English](README.md) | 中文

## 概述

宿主 `ctx.browser` 服务经 Chrome DevTools Protocol 持有真实浏览器连接，提供四种后端：`launch` 派生带 stealth 补丁的浏览器，`patch` 使用 CloakBrowser Chromium（源码级 C++ 指纹补丁；默认首选后端），`attach` 接入既有 CDP 端点，`relay` 通过进程内 relay 服务器＋MV3 扩展驱动用户自己的 Chrome 标签页。在这些连接之上，它打开并导航标签页、求值 JS、返回带稳定 `[ref=eN]` id 的 ARIA 快照并关闭标签页。`@deepseek-ai/dsh-tool-browser` 是其预期消费方。代价是每个 cwd+kind 一个连接，服务自身没有启停策略；隐身特性并非安全边界。

## 目录

- [功能](#what-it-does)
- [后端](#backends)
- [配置](#configuration)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

agent 化浏览器工具（移植自 omp / oh-my-pi）的宿主 `ctx.browser` 服务：经 [playwright-core CDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp) 持有真实的浏览器连接，提供三种后端 — **launch**（带 stealth 补丁的浏览器二进制）、**attach**（经 `cdp_url` 接入既有 CDP 端点）、以及 **relay**（通过进程内 relay 服务器＋配套 MV3 扩展驱动用户自己的 Chrome 标签页）。由 [`@deepseek-ai/dsh-tool-browser`](../tool-browser/README.zh.md) 消费，模型不直接调用。

<a id="what-it-does"></a>
## 功能

在组合上注册一个宿主服务（`ctx.browser`）。其面：

- **后端** — `resolveKind` 把工具请求映射为 `launch`／`attach`／`relay`，对应 omp 的 kind 解析（`app.path`→spawn、`app.cdp_url`→attach、`app.relay`／`DSH_BROWSER_RELAY`→relay）；`ensureRelay` 启动进程内 relay 服务器（默认 `http://127.0.0.1:9224`，端口占用时回退到临时端口）。
- **标签页** — `open` 导航一个命名标签页（每个名字一个标签页、每个 cwd+kind 一个浏览器连接）；`run` 在标签页内求值 JS；`observe` 返回 title／url／尺寸＋带 `[ref=eN]` id 的 ARIA 快照；`click`／`type` 按 ARIA ref 或 CSS 选择器寻址元素；`screenshot` 写出 PNG；`close` 关闭标签页，配合 `kill` 还关闭所派生的浏览器。
- **Stealth** — 14 段 omp-puppeteer init 脚本注入每个启动的页面（`src/stealth-scripts.ts`，生成物），压制机显（machine-tell）启动参数，并在浏览器 CDP session 上应用伪装 user-agent＋client-hints 覆盖。

ARIA 快照由打包进来的 Playwright ARIA-snapshot 源码（Apache-2.0，微软）在 `src/aria-bundle.ts` 提供 — 与 omp 用的是同一份生成 bundle — 因此每次快照都带可操作的 `[ref=eN]` id，且在下一次快照前保持有效。

<a id="backends"></a>
## 后端

| kind | 解析 | 浏览器 |
| --- | --- | --- |
| `launch` | `app.path`（或 `browserPath` 配置） | `chromium.launch({ executablePath, headless, args: STEALTH_LAUNCH_ARGS, ignoreDefaultArgs })` |
| `patch` | `app.patch`／`usePatch` 配置（此处为默认） | `cloakbrowser.launch(...)` — CloakBrowser Chromium（71 项源码级 C++ 指纹补丁，逐会话随机化） |
| `attach` | `app.cdp_url` | `chromium.connectOverCDP(cdpUrl)` — 任意真实的 Chrome 系端点 |
| `relay` | `app.relay`／`DSH_BROWSER_RELAY=1` | `chromium.connectOverCDP(relay)` — relay 冒充 Chrome 的 CDP discovery |

`patch` 后端通过 `cloakbrowser` npm 依赖启动 CloakBrowser Chromium — 一个可直接替换 Playwright 的封装，返回常规 `playwright-core` `Browser`（与服务驱动的是同一实例）。指纹随机化在 C++ 层逐会话进行，因此本后端刻意不应用 JS 级 stealth 脚本与 UA 覆盖。首次启动会自动下载打过补丁的 Chromium（约 200 MB，缓存于 `~/.cloakbrowser/`）；`patchOptions` 可传入 `proxy`、`geoip`（按代理 IP 匹配时区与 locale）、`humanize`（拟人化输入）。反检测只是抬高门槛，并不保证站点可访问。

relay（`src/relay/server.ts`、`bridge.ts`，omp 移植）绑定回环地址，提供 `GET /json/version`（扩展接入前返回 503；200 与 503 响应体均携带 `dshRelayProtocol` 构建标记，因此另一构建的陈旧 relay 能在归咎扩展之前被诊断出来 — 版本不匹配绝不会导致连接失败）、`GET /json`、`WS /cdp`（下游 CDP 客户端）、`WS /ext`（扩展，可配置 token 门禁），以及 `GET /ext-assets/*`（便于用户在 `chrome://extensions` → Load unpacked 侧载扩展）。relay 路径会在 `connectOverCDP` 之前等待 `/json/version` 应答 200（有界预算、静默过期），使首次连接不会与冷启动的扩展 service-worker 拨号竞争。bridge 在扩展对每个标签页唯一的 `chrome.debugger` 附着之上，以铸造 session id 的方式复用每条下游 CDP 连接。被 Chrome 丢弃的标签页（memory saver）永远不会被播报或附着 — 丢弃会退役已持有的会话并撤回目标，复活（激活重取）会重新播报并重新附着，而附着动作会等过一次已跟踪的在途分离，而不是被它悄悄撤销 — 与 `omp browser-relay`（MIT）同一设计。

<a id="configuration"></a>
## 配置

- `browserPath` — `launch` 的默认可执行文件（可选；否则由 Playwright 解析）。
- `usePatch` — 默认使用 CloakBrowser 后端（base bundle 行中为 true）。
- `patchOptions` — CloakBrowser 启动参数：`proxy`（URL）、`geoip`（bool）、`humanize`（bool）。
- `headless` — 默认 headless（true）。
- `viewport` — 启动视口（默认 1365×768 @ 1.25）。
- `relayUrl`／`relayToken` — relay 端点与可选的扩展 token。
- `timeoutMs` — 默认导航超时（30000）。

服务位于宿主平面，不持有持久状态，随其所属上下文一同销毁（关闭浏览器并停止 relay）。派生的浏览器（launch，以及 peer 暴露其 pid 时的 patch）会记录进孤儿注册表（`src/orphan-registry.ts`），若本进程死亡则由之后的宿主回收；记录仅在其关闭被确认后才移除 — 关闭失败会让 pid 保持可回收。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 服务不管理浏览器进程的启停策略；消费方需自行限定并释放会话。
- 隐身与指纹特性针对常见自动化检测器，并非安全边界。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>

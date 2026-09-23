---
description: "无需凭据的 WebSearchProvider：把一个查询并发散开到五个公共引擎，并按跨引擎共识整合结果，接入 harness web seam，无需 API 密钥。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-public

[English](README.md) | 中文

## 概述

`dsh-web-search-public` 是一个无需凭据的 `WebSearchProvider`，接入 harness web seam（`ctx.web`）：无需 API 密钥或环境变量，它将一个查询并发散开到五个公共引擎（Startpage、DuckDuckGo、Ecosia、Google 与 Mojeek），并按跨引擎共识整合答案，因此任何单个引擎失败都不会阻塞或拖垮检索。当部署需要零设置的公共网页搜索且能容忍引擎失败时选择它；它只注册 provider，`dsh-tool-web` 拥有面向模型的工具。其代价是共识带来的延迟底线、成倍放大的匿名请求，以及可能因引擎改版而失效的最佳努力解析器。

## 目录

- [配置](#config)
- [映射](#mapping)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

一个无需凭据的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.zh.md)（`ctx.web`）。无需 API 密钥或环境变量，它将一个查询并发散开到五个公共搜索引擎——Startpage、DuckDuckGo、Ecosia、Google 与 Mojeek——并按跨引擎共识整合答案，因此任何单个引擎的被风控、超时或缓慢响应都不会阻塞或拖垮检索。这是对 oh-my-pi `searchPublicWeb` 聚合的忠实移植。

浏览器后端的引擎（Google、Ecosia、Mojeek）在廉价的普通 fetch 遇到机器人墙时会升级到宿主的真实浏览器（`ctx.browser.fetchPageHtml`——隐身 `launch` 或 CloakBrowser `patch`）：enable-JS 重试页、Cloudflare 托管挑战（"Ecosia Firewall"）、Mojeek 的 ALTCHA 工作量证明（在浏览器中点击其复选框自动求解），以及 Google 的 "unusual traffic" `/sorry` 闸门（硬墙——Google 仍会让出链路）。升级属于传输层细节，而非新引擎：未挂载浏览器服务时，这些引擎只是保持仅 fetch；只有当每种传输（fetch 与浏览器）都被封锁时，每引擎断路器才会打开。

这是一个**实现**包：它向 `ctx.web` 注册提供方，不拥有 `ctx.web` 键，也不注册面向模型的工具（后者属于 `@deepseek-ai/dsh-tool-web`）。它是函数／命名空间插件（`inject: ['web']`），负责注册后端，而非默认导出服务。

<a id="config"></a>
## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `timeoutMs` | `30000` | 每引擎传输超时（毫秒），以竞速方式生效，挂起的引擎不会卡住调用。至少为 1000。即便某引擎无视聚合取消，也由它兜底；浏览器后端引擎可能把它花在 fetch → 隐身浏览器升级上，因此默认值为 30 秒（仍低于 60 秒工具预算）。调用本身由下述截止期约束。 |
| `engines` | `startpage, duckduckgo, ecosia, google, mojeek` | 并发散开的引擎 id；此顺序用于共识平票时的决胜。未列出的引擎保持禁用；重复 id 会被丢弃。 |
| `userAgent` | 浏览器形态常量 | 发送给引擎的 User-Agent。这些公共端点期望浏览器形态 UA；如需更严格策略可自行覆盖。 |
| `softDeadlineMs` | `5000` | 软聚合截止期（毫秒）：所有引擎都落定即返回，或此值到点且手中至少有一次成功即返回。若到点仍无成功，则继续等待（至硬截止期）第一次成功。 |
| `hardDeadlineMs` | `30000` | 硬聚合截止期（毫秒）：无论手头有什么（哪怕没有）都返回，让任何病态缓慢的引擎都无法把调用顶到 60 秒检索工具预算。必须 `>= softDeadlineMs`。 |
| `maxRetries` | `1` | 当所有引擎都失败且至少一个引擎死于**可重试**传输类故障（HTTP 5xx、超时或网络级 fetch 失败）时对该聚合的重试次数。每次重试都会在退避后重新执行整个散开过程，因此短暂引擎风控抹掉首次尝试后仍可能拿到结果。`0` 表示禁用重试。硬性封锁（HTTP 4xx）永不重试——它们会打开该引擎的断路器；纯全是“无结果”的聚合属于查询层面，永不重试。 |
| `retryDelayMs` | `2000` | 第 1 次重试前的基准延迟（毫秒）；每次后续尝试翻倍。 |
| `failureCooldownMs` | `300000` | 所有引擎不可用后的快速失败窗口（毫秒）（重试耗尽，或所有引擎都被硬性封锁／熔断）：此窗口内的检索会返回清晰的 `retry in about Ns` 错误，而非再次轰击刚刚限流我们的引擎（那会加深封锁）。`0` 表示禁用该窗口。 |
| `engineBackoffMs` | `300000` | 每引擎断路器基准窗口（毫秒）：硬性封锁（HTTP 4xx）或连续多次零结果的引擎会被跳过该时长，而不是每次检索都再次轰击。窗口会随连续熔断翻倍，直至 `maxEngineBackoffMs`，探测成功后复位。`0` 表示禁用每引擎断路器。 |
| `maxEngineBackoffMs` | `3600000` | 每引擎断路器翻倍窗口的上限（毫秒）。 |

```yaml
- id: web-search-public
  name: '@deepseek-ai/dsh-web-search-public'
  config:
    timeoutMs: 30000
    softDeadlineMs: 5000
    hardDeadlineMs: 30000
    maxRetries: 1
    retryDelayMs: 2000
    failureCooldownMs: 300000
    engineBackoffMs: 300000
    maxEngineBackoffMs: 3600000
```

<a id="mapping"></a>
## 映射

每个引擎的静态 HTML 结果页被归结为 `WebSearchSource` 条目：`url` ← 结果链接（DuckDuckGo `uddg` 与 Google `/url?q=` 跳转包装会被解包）、`title` ← 可见的结果标题文本、`snippet` ← 结果摘要（DuckDuckGo `result__snippet`、Startpage `w-gl__description`、Ecosia `result__quote`、Google `VwiC3b`、Mojeek `p.s`）、`publishedAt` ← DuckDuckGo 结果时间戳（日期前缀）。引擎从不合成 `content`；最终上限由 seam 强制执行，`maxResults` 作为上界传给引擎。请求不携带任何凭据，且 HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝（web 包 AGENTS.md 规则）。

提供方将查询并发散开到所有引擎并整合结果：URL 先按大小写／`www.`／尾部斜杠归一化并在引擎之间去重，再按跨引擎共识（有多少引擎返回了该 URL）排序，其次按最佳引擎内排名，最后按引擎顺序——因此 Startpage 与 DuckDuckGo 都返回的 URL 胜过单引擎命中，同一排位内的平票由更靠前的引擎胜出。最有信息量的摘要（可得的最长者）胜出；同排位平票时取更靠前引擎的标题与 URL。散开过程竞速三种退出方式并取最早者——所有引擎落定、软截止期到点且手中已有成功、或（无成功且并非全部失败时越过软截止期等待首次成功之后）硬截止期——随后中止所有仍在运行的引擎。单引擎失败（传输错误、非 2xx 响应、风控页）与零结果页均被容忍：仅当**所有**引擎都失败时，调用才以 `WebError` `WEB_PROVIDER_ERROR` 失败，其消息聚合了各引擎的原因；调用方中止的请求以 `WEB_ABORTED` 呈现。韧性是分层的：硬性封锁（HTTP 4xx）与连续零结果响应会打开该引擎的断路器，使其在 `engineBackoffMs` 内被跳过（不发网络请求），窗口随连续熔断翻倍；可重试传输故障（HTTP 5xx、超时、网络失败）会在 `maxRetries` 预算内重试整个散开过程，随后同样熔断该引擎；当所有引擎都不可用时，提供方在 `failureCooldownMs`（默认 5 分钟）内以 `retry in about Ns` 错误快速失败，而不是再次轰击刚刚限流我们的引擎。只要配置了至少一个引擎，`available()` 即为真——不存在会失效的凭据门槛。

<a id="model-experience"></a>
## 模型体验

通过 [`dsh-tool-web`](../tool-web/README.zh.md) 间接影响；该工具保留此提供方经共识合并、`maxResults` 限制的 URL、标题、摘要与发布日期，或将聚合错误 `all public search engines failed: ...` 置于消费方的错误包装层内；生成答案与提供方私有字段不进入上下文。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **并行散开成倍放大匿名请求**——每次检索都会同时联系全部五个引擎（单次查询最多 5 个并发抓取），相比单引擎回退链，被风控与按主机限流的风险更高。每引擎断路器会兜底：被硬性封锁或连续零结果的引擎会被跳过而不是反复轰击，因此一旦引擎开始风控，之后的检索只探测幸存者。
- **限流韧性是尽力而为**——硬性封锁会打开对应引擎的断路器（跳过 `engineBackoffMs`，随连续熔断翻倍），可重试传输故障会在预算内重试一次，而当所有引擎都不响时，提供方在 `failureCooldownMs`（默认 5 分钟）内以 `retry in about Ns` 错误快速失败，而不是再次轰击刚刚限流我们的引擎。引擎侧风控本身不在我们控制之内，可能比熔断与冷却更持久；凭据化的 provider 才是稳健之选。
- **共识需要付出延迟底线**——聚合会刻意等待落后者直至软截止期（默认 5 秒）以丰富共识；即使另一引擎早已应答，单个缓慢引擎也会把调用顶到软窗口。降低 `softDeadlineMs` 可换取更低延迟，代价是共识更单薄。
- **匿名引擎会无提示地风控拦截**——Startpage 与 Google 尤其常返回同意页或 CAPTCHA 页而非结果；散开过程将此类页面吸收为空引擎应答，但当所有引擎同时被拦截时，查询仍可能以聚合失败告终。
- **解析器是对特定 HTML 结构的最佳努力式抓取**——引擎偶尔会改版标记；改版后该引擎只返回零结果而非畸形数据，因此聚合是降级而非损坏。
- **不合成 `content`**——引擎只返回来源；seam 的生成答案表面保持未设置。
- **Google 是最脆弱的引擎**——借同意 Cookie 抓取保留以作覆盖，可在不改动聚合契约的前提下从引擎列表中移除。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>

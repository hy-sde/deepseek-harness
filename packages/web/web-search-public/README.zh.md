# @deepseek-ai/dsh-web-search-public

[English](README.md) | 中文

一个无需凭据的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.zh.md)（`ctx.web`）。无需 API 密钥或环境变量，它将一个查询并发散开到五个公共搜索引擎——Startpage、DuckDuckGo、Ecosia、Google 与 Mojeek——并按跨引擎共识整合答案，因此任何单个引擎的被风控、超时或缓慢响应都不会阻塞或拖垮检索。这是对 oh-my-pi `searchPublicWeb` 聚合的忠实移植。

这是一个**实现**包：它向 `ctx.web` 注册提供方，不拥有 `ctx.web` 键，也不注册面向模型的工具（后者属于 `@deepseek-ai/dsh-tool-web`）。它是函数／命名空间插件（`inject: ['web']`），负责注册后端，而非默认导出服务。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `timeoutMs` | `10000` | 每引擎传输超时（毫秒），以竞速方式生效，挂起的引擎不会卡住调用。至少为 1000。即便某引擎无视聚合取消，也由它兜底；调用本身由下述截止期约束。 |
| `engines` | `startpage, duckduckgo, ecosia, google, mojeek` | 并发散开的引擎 id；此顺序用于共识平票时的决胜。未列出的引擎保持禁用；重复 id 会被丢弃。 |
| `userAgent` | 浏览器形态常量 | 发送给引擎的 User-Agent。这些公共端点期望浏览器形态 UA；如需更严格策略可自行覆盖。 |
| `softDeadlineMs` | `5000` | 软聚合截止期（毫秒）：所有引擎都落定即返回，或此值到点且手中至少有一次成功即返回。若到点仍无成功，则继续等待（至硬截止期）第一次成功。 |
| `hardDeadlineMs` | `30000` | 硬聚合截止期（毫秒）：无论手头有什么（哪怕没有）都返回，让任何病态缓慢的引擎都无法把调用顶到 60 秒检索工具预算。必须 `>= softDeadlineMs`。 |

```yaml
- id: web-search-public
  name: '@deepseek-ai/dsh-web-search-public'
  config:
    timeoutMs: 10000
    softDeadlineMs: 5000
    hardDeadlineMs: 30000
```

## 映射

每个引擎的静态 HTML 结果页被归结为 `WebSearchSource` 条目：`url` ← 结果链接（DuckDuckGo `uddg` 与 Google `/url?q=` 跳转包装会被解包）、`title` ← 可见的结果标题文本、`snippet` ← 结果摘要（DuckDuckGo `result__snippet`、Startpage `w-gl__description`、Ecosia `result__quote`、Google `VwiC3b`、Mojeek `p.s`）、`publishedAt` ← DuckDuckGo 结果时间戳（日期前缀）。引擎从不合成 `content`；最终上限由 seam 强制执行，`maxResults` 作为上界传给引擎。请求不携带任何凭据，且 HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝（web 包 AGENTS.md 规则）。

提供方将查询并发散开到所有引擎并整合结果：URL 先按大小写／`www.`／尾部斜杠归一化并在引擎之间去重，再按跨引擎共识（有多少引擎返回了该 URL）排序，其次按最佳引擎内排名，最后按引擎顺序——因此 Startpage 与 DuckDuckGo 都返回的 URL 胜过单引擎命中，同一排位内的平票由更靠前的引擎胜出。最有信息量的摘要（可得的最长者）胜出；同排位平票时取更靠前引擎的标题与 URL。散开过程竞速三种退出方式并取最早者——所有引擎落定、软截止期到点且手中已有成功、或（无成功且并非全部失败时越过软截止期等待首次成功之后）硬截止期——随后中止所有仍在运行的引擎。单引擎失败（传输错误、非 2xx 响应、风控页）与零结果页均被容忍：仅当**所有**引擎都失败时，调用才以 `WebError` `WEB_PROVIDER_ERROR` 失败，其消息聚合了各引擎的原因；调用方中止的请求以 `WEB_ABORTED` 呈现。只要配置了至少一个引擎，`available()` 即为真——不存在会失效的凭据门槛。

## 模型体验

通过 [`dsh-tool-web`](../tool-web/README.zh.md) 间接影响；该工具保留此提供方经共识合并、`maxResults` 限制的 URL、标题、摘要与发布日期，或将聚合错误 `all public search engines failed: ...` 置于消费方的错误包装层内；生成答案与提供方私有字段不进入上下文。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **并行散开成倍放大匿名请求**——每次检索都会同时联系全部五个引擎（单次查询最多 5 个并发抓取），相比单引擎回退链，被风控与按主机限流的风险更高。被风控的引擎只会让聚合降级而不会失败，但限流严重的网络可能看到更多风控，而非更少。
- **共识需要付出延迟底线**——聚合会刻意等待落后者直至软截止期（默认 5 秒）以丰富共识；即使另一引擎早已应答，单个缓慢引擎也会把调用顶到软窗口。降低 `softDeadlineMs` 可换取更低延迟，代价是共识更单薄。
- **匿名引擎会无提示地风控拦截**——Startpage 与 Google 尤其常返回同意页或 CAPTCHA 页而非结果；散开过程将此类页面吸收为空引擎应答，但当所有引擎同时被拦截时，查询仍可能以聚合失败告终。
- **解析器是对特定 HTML 结构的最佳努力式抓取**——引擎偶尔会改版标记；改版后该引擎只返回零结果而非畸形数据，因此聚合是降级而非损坏。
- **不合成 `content`**——引擎只返回来源；seam 的生成答案表面保持未设置。
- **Google 是最脆弱的引擎**——借同意 Cookie 抓取保留以作覆盖，可在不改动聚合契约的前提下从引擎列表中移除。

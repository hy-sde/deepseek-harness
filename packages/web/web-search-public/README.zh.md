# @deepseek-ai/dsh-web-search-public

[English](README.md) | 中文

一个无需凭据的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.md)（`ctx.web`）。无需 API 密钥或环境变量，它按顺序链接五个公共搜索引擎——先 Startpage，再 DuckDuckGo → Ecosia → Google → Mojeek——并返回第一个产生结果的引擎。若某引擎返回零结果、超时或被风控拦截，链路会推进到下一个引擎，因此只要至少一个引擎有响应，检索就能继续工作。

这是一个**实现**包：它向 `ctx.web` 注册提供方，不拥有 `ctx.web` 键，也不注册面向模型的工具（后者属于 `@deepseek-ai/dsh-tool-web`）。它是函数／命名空间插件（`inject: ['web']`），负责注册后端，而非默认导出服务。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `timeoutMs` | `10000` | 每引擎传输超时（毫秒），以竞速方式生效，挂起的引擎不会卡住调用。至少为 1000。链最坏情况为 `engines.length × timeoutMs`（默认五个引擎为 50 秒）。 |
| `engines` | `startpage, duckduckgo, ecosia, google, mojeek` | 按此精确顺序尝试的引擎 id。未列出的引擎保持禁用；重复 id 会被丢弃。 |
| `userAgent` | 浏览器形态常量 | 发送给引擎的 User-Agent。这些公共端点期望浏览器形态 UA；如需更严格策略可自行覆盖。 |

```yaml
- id: web-search-public
  name: '@deepseek-ai/dsh-web-search-public'
  config:
    timeoutMs: 10000
```

## 映射

每个引擎的静态 HTML 结果页被归结为 `WebSearchSource` 条目：`url` ← 结果链接（DuckDuckGo `uddg` 与 Google `/url?q=` 跳转包装会被解包）、`title` ← 可见的结果标题文本、`snippet` ← 结果摘要（DuckDuckGo `result__snippet`、Startpage `w-gl__description`、Ecosia `result__quote`、Google `VwiC3b`、Mojeek `p.s`）、`publishedAt` ← DuckDuckGo 结果时间戳（日期前缀）。引擎从不合成 `content`；最终上限由 seam 强制执行，`maxResults` 作为上界传给引擎。请求不携带任何凭据，且 HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝（web 包 AGENTS.md 规则）。

提供方按配置顺序运行引擎，返回第一个产生至少一条结果的引擎。零结果页、每引擎超时与引擎失败（传输错误、非 2xx 响应、解析为空的风控页）都会推进链路。仅当所有引擎都失败时，调用才抛出 `WebError` `WEB_PROVIDER_ERROR`，其消息聚合了各引擎的原因；调用方中止的请求以 `WEB_ABORTED` 呈现。只要配置了至少一个引擎，`available()` 即为真——不存在会失效的凭据门槛。

## 模型体验

通过 [`dsh-tool-web`](../tool-web/README.md) 间接影响；该工具保留此提供方经 `maxResults` 限制的 URL、标题、摘要与发布日期，或将聚合错误 `all public search engines failed: ...` 置于消费方的错误包装层内；生成答案与提供方私有字段不进入上下文。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **匿名引擎会无提示地风控拦截**——Startpage 与 Google 尤其常返回同意页或 CAPTCHA 页而非结果；链路会在这些页面继续推进，但当所有引擎同时被拦截时，查询仍可能以聚合失败告终。
- **解析器是对特定 HTML 结构的最佳努力式抓取**——引擎偶尔会改版标记；改版后该引擎只返回零结果而非畸形数据，因此链路是降级而非损坏。
- **不合成 `content`**——引擎只返回来源；seam 的生成答案表面保持未设置。
- **Google 在最后且最脆弱**——借同意 Cookie 抓取保留以作覆盖，可在不改动链路契约的前提下从顺序中移除。

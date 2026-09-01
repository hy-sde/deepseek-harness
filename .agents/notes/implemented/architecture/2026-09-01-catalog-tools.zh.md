# Agent Note：设备工具与 `dyn` 目录传输

Status: implemented

[English](2026-09-01-catalog-tools.md) | 中文

## Problem

一套庞大的工具面在每次会话启动时都要付上下文代价：每个可见 schema 都会进入系统提示词，而本 fork 面向模型的工具数已超一百。按提示词规模作答的方案 omp 已有两代——`master` 的 TypeScript `xd://` 发现传输，以及 `omp2` 的 Rust `dyn` 设备传输——但 fork 对两者都没有移植，于是这个以移植为使命、目录还在不断变大的仓库没有任何办法在不彻底砍掉长尾工具可达性的前提下把它们请出提示词。界定这项工作的问题是：不断增长的工具列表是否吞噬上下文，以及如何以发现优先的呈现方式来应对。

## Decision

目录呈现是既有 `ToolPresentationMode` 的一个取值，而非新 preset：`'native' | 'ptc' | 'both' | 'catalog'`。工具在其定义上声明 `device: true` 即选择加入；在 `catalog` 下，注册表不把设备 schema 送上提示词 wire，而是通过保留的 `dyn` 传输（`search` / `docs` / `invoke`）暴露它们——预算建模自 `omp2` 的 `device.rs`（单设备文档上限、外部摘要 200 字节上限），整体形态取自 `master` 的「发现加调用」。

机制全部位于 `packages/core/tools`：

- **模式。** `ctx.tools.presentAs('catalog')`（带作用域，每作用域一格，冲突规则与 `ptc`/`native` 相同）以及 tools 行的 `Config.mode: 'catalog'`。`agent-tool-presentation` 行的 `catalog` 选项立即生效——与 `ptc`/`both` 不同，它不需要代码运行时。
- **设备标志。** `ToolDefinition`（与 `DefineToolOptions`）上的 `device: true` 在非生效的 `catalog` 作用域下是惰性的；在该作用域下它把 schema 撤出提示词，同时把工具留在注册表与作用域可见性中。
- **传输。** `DYN_NAME = 'dyn'` 与 `RUN_CODE` 一样被保留：不可注册、不可限制、不可遮蔽、不出现在全局层，并在能力过滤层之后注入可见映射。因此 `catalog` 装配展示的是急载工具加上恰好一个 `dyn` schema，而不是 N 个设备 schema。
- **wire。** `catalog` 下的提示词装配只投影急载 schema；设备名被排除在 `knownNames` 之外，因此在 `toolOrder` 中命名设备会像 `ptc` 下命名原生工具一样在装配时失败。目录段（`CATALOG_ONLY: 850`，位于 `PTC_ONLY: 800` 与 `FILE_REFERENCE: 900` 之间）携带固定指引外加每设备一行有界摘要，上限 `DEVICE_SUMMARY_CAP = 200` 个 UTF-8 字节（`catalogSummary`/`truncateUtf8`）。
- **守卫。** 设备调用只能通过 `dyn` 的嵌套分发触达设备，该分发以外部执行的 `callId`/`rootCallId`/`parent`/`signal` 重新进入完整的守卫流水线。模型直呼设备名在任何模式下都会在策略之前以未知工具（`UNKNOWN_TOOL`）收束——设备 schema 永远不会成为 wire 上的可调用名。
- **安全契约。** 一条可见性解析器同时喂给 `get()`/`restrict()`/嵌套分发/目录，因此设备要么对某作用域可见、要么在所有地方一并消失——restrict 会把它同时移出目录行、docs 与分发，`nesting`/作用域规则与其余工具一致。

一类方选择加入：5 个包共 36 个设备——codebase-memory（14）、logseq（8）、session-query（5）、openwiki（5）、av（4）。

## Alternatives considered

- 为发现优先的 agent 新增一条 preset 行。否决：呈现只是既有 tools 行的一个轴；preset 会复制一套作用域/冲突机制，并把 `mode` 变成一个跨 preset 的约定问题。
- 在注册时用 allowlist 过滤。否决：这会为每一个消费方改变注册表契约，而不是加一个选择加入标志，并且会把工具从理应展示全部 schema 的自省 API 中删掉。
- 类似 omp 的 sidecar `xd://` 那样搞客户端/环境挂载。否决：fork 在进程内运行引擎；子进程传输会引入进程监管，而提示词节省相比注册表内传输毫无增益。
- 用 `rdp` 式转储或 PTC SDK 来做发现。否决：PTC 是另一个轴（调用面而非提示词代价），而且目录允许直接调用急载工具，这是 PTC 所禁止的。

## Consequences

代价：提示词装配只随设备数量线性增长（每设备一行摘要），外加有预算的 `dyn` 指引；`schemas()`（自省 API）刻意仍然列出被折叠的设备，与 `ptc` 对折叠工具的行为一致——做自省的调用方必须问 `view()` 语义，与 PTC 模式相同的注意点。`dyn` 这一保留名又成为一个任何工具插件都不得注册的名字。预算都是常量（`DEVICE_SUMMARY_CAP`、`CATALOG_SEARCH_LIMIT = 50`），对应 omp2；与 omp 精确取值的偏差按常量记录。目录段在非生效的 `catalog` 作用域外为空，因此原生/提示词型装配不付任何代价。

所得：长尾工具保持「距零提示词代价只差一个 `device: true`」，同时仍然可发现、可调用；发现 + docs + 调用如今成为 fork 可以教导的一等提示词范式；`toolOrder` 的失败落在装配期（提前），而不是调用期的一个静默缺失工具。

## Testing

专门的 `catalog.spec.ts`（18 个测试，位于 `packages/core/tools/tests`）覆盖：wire（急载 + `dyn`，不含设备）、段内容、native 下的惰性标志、toolOrder 失败、保留名、search 的过滤/偏移/截断、200 字节 UTF-8 上限、docs 揭示 schema 与对未知/急载工具的拒绝、带 value + content 的嵌套分发、设备体失败、restrict 撤出、模型直呼拒绝及 `dyn` 提示、嵌套父 token 旁路、`presentAs` 遮蔽/释放、以及按作用域扣留。Typert 将 `ToolDefinition` 形状（含 `device`）逐字节往返到 `tool-cordis/src/api-catalog.ts`。

## Deferred

- 会话中途新增设备时的挂载/会话通知（目录段在提示词装配时生成；运行中新增会在下次装配出现，没有即时通知）。
- 为设备数量或 docs 超出预算的目录提供 `spillStore` 溢出接缝。
- 在生成的工具目录中增加设备摘要列，让选择加入在文档中可审阅。

---
description: "调试适配器协议: 启动适配器的 Host DAP seam 并驱动会话生命周期, 以及基于其操作的面向模型 debug 工具."
kind: "package-group"
---
# packages/debug

[English](README.md) | 中文

## 摘要

`debug/` 组提供[`dap/`](dap/README.zh.md)、[`tool-debug/`](tool-debug/README.zh.md)。二者共同通过 DAP 协议为每个上下文提供唯一的真实调试器会话。

## 目录

- [相关文档](#related-documentation)

-----

<a id="related-documentation"></a>
## 相关文档

[子系统参考文档](../../docs/subsystems/dap.zh.md)拥有穷尽式约定；下方每个包的 README 都会从各自的页面链接到它。

| 包 | 职责 |
|---|---|
| [`dap/`](dap/README.zh.md) | Host DAP seam：启动适配器并驱动调试会话生命周期 |
| [`tool-debug/`](tool-debug/README.zh.md) | 基于 DAP 操作的面向模型 `debug` 工具 |

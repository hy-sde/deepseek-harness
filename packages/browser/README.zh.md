---
description: "无头浏览器自动化: Host BrowserService (启动/隐身/导航/DOM/截图) 与面向模型的 browser 工具."
kind: "package-group"
---
# packages/browser

[English](README.md) | 中文

## 摘要

`browser/` 组提供[`browser/`](browser/README.zh.md)、[`tool-browser/`](tool-browser/README.zh.md)。二者共同为 agent 提供可脚本化的浏览器表面：观察结果是 ARIA 可达性树，截图是 PNG 路径。

## 目录

- [相关文档](#related-documentation)

-----

<a id="related-documentation"></a>
## 相关文档

[子系统参考文档](../../docs/subsystems/browser.zh.md)拥有穷尽式约定；下方每个包的 README 都会从各自的页面链接到它。

| 包 | 职责 |
|---|---|
| [`browser/`](browser/README.zh.md) | Host BrowserService：启动/隐身、导航、DOM 快照与截图 |
| [`tool-browser/`](tool-browser/README.zh.md) | 基于 Host seam 的面向模型 `browser` 工具 |

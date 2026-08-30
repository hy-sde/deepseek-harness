---
description: "Automic Vault 凭据扫描: the host av service wrapping 已安装的 CLI 以及只读、面向模型的 扫描/doctor/目录/列出 工具."
kind: "package-group"
---
# packages/av

[English](README.md) | 中文

## 摘要

`av/` 组提供[`av/`](av/README.zh.md)、[`tool-av/`](tool-av/README.zh.md)。二者共同让 agent 只读地看到暴露的开发工具凭据与机器加固状态，而密钥值始终由人工在终端中处理。

## 目录

- [相关文档](#related-documentation)

-----

<a id="related-documentation"></a>
## 相关文档

[子系统参考文档](../../docs/subsystems/av.zh.md)拥有穷尽式约定；下方每个包的 README 都会从各自的页面链接到它。

| 包 | 职责 |
|---|---|
| [`av/`](av/README.zh.md) | Host 服务，包装已安装的 `av` CLI：暴露扫描、doctor/目录与仅名称的列出 |
| [`tool-av/`](tool-av/README.zh.md) | 面向模型的 `av_scan`、`av_doctor`、`av_catalog` 与 `av_list` 工具 |

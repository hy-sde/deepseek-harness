---
description: "Repository wiki lifecycle: the ported deterministic engine core and its five model-facing tools."
kind: "package-group"
---
# packages/openwiki

English | [中文](README.zh.md)

## Summary

The `openwiki/` group provides [`openwiki-core/`](openwiki-core/README.md), the ported deterministic wiki engine running in-process (resumable .run.json checkpoints, page manifests, Grounded Claims, OKF front-matter repair and index sync), and [`tool-openwiki/`](tool-openwiki/README.md) with the five lifecycle tools (`openwiki_begin`, `openwiki_submit_plan`, `openwiki_next_page`, `openwiki_submit_page`, `openwiki_finish`).

## Table of Contents

- [Packages](#packages)

-----

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`openwiki-core/`](openwiki-core/README.md) | Ported deterministic openwiki engine core |
| [`tool-openwiki/`](tool-openwiki/README.md) | Five repository wiki lifecycle tools + `openwiki:tools` prompt section |

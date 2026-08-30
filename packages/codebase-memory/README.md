---
description: "One-shot codebase-intelligence tool queries against the local codebase-memory daemon."
kind: "package-group"
---
# packages/codebase-memory

English | [中文](README.zh.md)

## Summary

The `codebase-memory/` group provides [`tool-codebase-memory/`](tool-codebase-memory/README.md): one-shot queries (list/index/status/search/query/trace/snippet/schema/architecture/detect/ADR/ingest/delete) that run against the local codebase-memory daemon via the `codebase-memory-mcp cli` mode, sharing its indexes and mutation locks.

## Table of Contents

- [Packages](#packages)

-----

<a id="packages"></a>
## Packages

| Package | Role |
|---|---|
| [`tool-codebase-memory/`](tool-codebase-memory/README.md) | Model-facing codebase-intelligence tools over the local daemon |

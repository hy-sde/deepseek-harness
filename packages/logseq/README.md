---
description: "Embedded LLM-wiki: the logseq-graph host service backed by the logseq CLI and the model-facing logseq tools; the GUI drawer lives in dsh-client-ui-wiki."
kind: "package-group"
---
# packages/logseq

English | [中文](README.zh.md)

## Summary

The `logseq/` group provides [`logseq-graph/`](logseq-graph/README.md)、[`tool-logseq/`](tool-logseq/README.md). Together they give agents a headless LLM-wiki backed by the logseq CLI, with the browser drawer living in dsh-client-ui-wiki.

## Table of Contents

- [Related documentation](#related-documentation)

-----

<a id="related-documentation"></a>
## Related documentation

The [subsystem reference](../../docs/subsystems/wiki.md) owns the exhaustive contracts; each package README below links it from its own pages.

| Package | Role |
|---|---|
| [`logseq-graph/`](logseq-graph/README.md) | Host graph service backed by the installed `logseq` CLI |
| [`tool-logseq/`](tool-logseq/README.md) | Model-facing `logseq_*` tools (list/show/search/query/upsert/remove/graph/server) |

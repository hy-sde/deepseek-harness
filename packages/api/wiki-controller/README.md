---
description: "Host wiki controller: the Typert `wiki` Remote namespace that projects the logseq-graph wire onto declared shapes for the embedded LLM-wiki."
kind: "package-reference"
---
# Wiki Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-wiki-controller` owns the Host `ctx.wikiController` service: the Typert `wiki` Remote namespace that GUI clients use to reach the embedded LLM-wiki graph. Its methods project the logseq-graph wire (`ctx.wikiGraph`, see [dsh-logseq-graph](../../logseq/logseq-graph/README.md)) onto declared request/value shapes — page rows, nested block trees with linked references, tag and property listings, text search, raw Datalog query rows, and upsert/delete/server actions. The controller also classifies failures (`wiki-unavailable` when the graph seam is missing, `wiki-cli-error` carrying the CLI detail, `internal` otherwise).

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the package in a web composition alongside the graph seam and the client UI ([dsh-client-ui-wiki](../../client/ui-wiki/README.md)). Each Remote method maps one-to-one onto a `ctx.wikiGraph` capability: `wiki.listPages` / `wiki.getPage` (page rows and block trees with linked references), `wiki.listTags` / `wiki.listProperties`, `wiki.search` (text search), `wiki.query` (raw Datalog rows), `wiki.upsert` / `wiki.delete` (mutations), and `wiki.server` (graph/server lifecycle status). The value shapes are declared here, so the browser half never depends on the logseq-graph wire type.

-----

<a id="model-experience"></a>
## Model Experience

None, as the wiki controller is a Host RPC surface for GUI clients (the [dsh-tool-logseq](../../logseq/tool-logseq/README.md) package owns the model-facing tools).

#### KV Cache effect

No direct effect; wiki RPC traffic does not alter model requests.

## Known Limitations and Deferred Work

- Search and query cover the mounted graph only; cross-graph federation is out of scope.
- Failures are classified into the three documented categories; CLI stderr detail is surfaced textually rather than structured.

### Dev Note

The controller extends `TypertRemoteService` with namespace `wiki` (see the Typert protocol). Its declared request/value types are the projection contract named in the Cordis catalog policy.

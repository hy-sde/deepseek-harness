---
description: "Local git repository: the host git-command seam plus the model-facing commit/commit_apply/review tools."
kind: "package-group"
---
# packages/git

English | [中文](README.zh.md)

## Summary

The `git/` group provides [`git/`](git/README.md)、[`tool-git/`](tool-git/README.md). Together they give agents model-driven commit and review over the staged diff.

## Table of Contents

- [Related documentation](#related-documentation)

-----

<a id="related-documentation"></a>
## Related documentation

The [subsystem reference](../../docs/subsystems/git.md) owns the exhaustive contracts; each package README below links it from its own pages.

| Package | Role |
|---|---|
| [`git/`](git/README.md) | Host git-command seam over a workspace repository |
| [`tool-git/`](tool-git/README.md) | Model-facing `commit`, `commit_apply`, and `review` tools |

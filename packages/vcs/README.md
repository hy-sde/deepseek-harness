---
description: "Host VCS working-tree seam: offered file-state and attribution services for consumers that read or write the agent's repository."
kind: "package-group"
---
# packages/vcs

English | [中文](README.zh.md)

## Summary

The `vcs/` group provides [`vcs/`](vcs/README.md). It exposes the host working-tree seam: VCS-path resolution and file-state attribution for the read/write tools and the git tooling that share the repository contract. Model-facing VCS behavior is owned by `dsh-tool-git`; this group contributes the host-side groundwork.

## Table of Contents

- [Related documentation](#related-documentation)

-----

<a id="related-documentation"></a>
## Related documentation

The [subsystem reference](../../docs/subsystems/git.md) owns the workspace and git contracts; the package README links it from its own page.

| Package | Role |
|---|---|
| [`vcs/`](vcs/README.md) | Host VCS seam over the workspace working tree |

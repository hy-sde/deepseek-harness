---
description: "Automic Vault credential scanning: the host av service wrapping the installed CLI and the read-only model-facing scan/doctor/catalog/list tools."
kind: "package-group"
---
# packages/av

English | [中文](README.zh.md)

## Summary

The `av/` group provides [`av/`](av/README.md)、[`tool-av/`](tool-av/README.md). Together they give agents read-only visibility into exposed dev-tool credentials and machine hardening, while secret values stay human-in-the-loop.

## Table of Contents

- [Related documentation](#related-documentation)

-----

<a id="related-documentation"></a>
## Related documentation

The [subsystem reference](../../docs/subsystems/av.md) owns the exhaustive contracts; each package README below links it from its own pages.

| Package | Role |
|---|---|
| [`av/`](av/README.md) | Host service wrapping the installed `av` CLI: exposure scan, doctor/catalogs, and name-only listings |
| [`tool-av/`](tool-av/README.md) | Model-facing `av_scan`, `av_doctor`, `av_catalog`, and `av_list` tools |

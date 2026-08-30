---
description: "Debug Adapter Protocol: the host DAP seam that spawns adapters and drives session lifecycle, plus the model-facing debug tool over its operations."
kind: "package-group"
---
# packages/debug

English | [中文](README.zh.md)

## Summary

The `debug/` group provides [`dap/`](dap/README.md)、[`tool-debug/`](tool-debug/README.md). Together they give agents one exclusive real debugger session per context through the DAP protocol.

## Table of Contents

- [Related documentation](#related-documentation)

-----

<a id="related-documentation"></a>
## Related documentation

The [subsystem reference](../../docs/subsystems/dap.md) owns the exhaustive contracts; each package README below links it from its own pages.

| Package | Role |
|---|---|
| [`dap/`](dap/README.md) | Host DAP seam: spawns adapters and drives debug-session lifecycle |
| [`tool-debug/`](tool-debug/README.md) | Model-facing `debug` tool over the DAP operations |

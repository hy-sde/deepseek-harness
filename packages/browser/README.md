---
description: "Headless browser automation: the host BrowserService (launch/stealth/navigation/DOM/screenshots) and the model-facing browser tool."
kind: "package-group"
---
# packages/browser

English | [中文](README.zh.md)

## Summary

The `browser/` group provides [`browser/`](browser/README.md)、[`tool-browser/`](tool-browser/README.md). Together they give agents a scriptable browser surface whose observations are ARIA reachability trees and whose screenshots are PNG paths.

## Table of Contents

- [Related documentation](#related-documentation)

-----

<a id="related-documentation"></a>
## Related documentation

The [subsystem reference](../../docs/subsystems/browser.md) owns the exhaustive contracts; each package README below links it from its own pages.

| Package | Role |
|---|---|
| [`browser/`](browser/README.md) | Host BrowserService: launch/stealth, navigation, DOM snapshots, and screenshots |
| [`tool-browser/`](tool-browser/README.md) | Model-facing `browser` tool over the host seam |

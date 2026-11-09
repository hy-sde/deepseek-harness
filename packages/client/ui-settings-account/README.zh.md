---
description: "打开设置面板的侧边栏设置启动器"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-account

[English](README.md) | 中文

## 概述

提供侧边栏设置启动器：一个"更多"行，打开包含唯一"设置"项的菜单。选择"设置"会关闭菜单、归还焦点，并按当前生效的快捷键打开设置面板。启动器自身不持有账号、凭据或模型状态。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

Web 应用 bundle 通过 `settings.launcher` 插槽挂载启动器。设置外壳提供侧栏几何信息（`wide`）、当前生效的设置快捷键与打开动作；启动器自身不持有任何状态。注册是无条件的：不查询 remote-access 授权、账号快照或凭据状态。

### 布局与行为

展开行的行高为 32px，内容与内嵌悬停填充与导航行对齐；收起的侧栏渲染居中的 36 × 36px 按钮。按钮使用 border-box 尺寸。设置行显示外壳提供的生效按键组合。选择菜单项会关闭菜单、把焦点归还启动器并打开设置。Escape 丢弃打开的菜单而不打开设置；共享的 Menu 组件负责关闭、悬停与焦点。

<a id="understand-the-implementation"></a>
## 理解实现

`apply` 注册八语言的 `settings.account` locale 命名空间，以及一个渲染 `AccountMenu` 的 `settings.launcher` 插槽占用者。组件组合共享的 `Menu` 表面；`listClassName` 为门户卡片提供样式。除此之外不注册任何内容：没有账号流、没有设置分区，也没有配额面板。

<a id="further-exploration"></a>
## 进一步探索

- `packages/client/ui-settings` 声明 `settings.launcher` 插槽契约，并拥有启动器打开的设置面板。
- `packages/client/ui-settings-models` 承载通用的 API key 供应商引导流程。

<a id="model-experience"></a>
## 模型体验

无；启动器只打开面板，从不进入模型提示、Session 日志或工具结果。

#### KV Cache effect

不改变任何模型请求前缀。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 菜单目前只有"设置"一项；未来的侧栏条目会扩展菜单项列表。

<a id="dev-note"></a>
### 开发备注

- 修改任一 README 后，用 `pnpm run verify-translation-pairing --write packages/client/ui-settings-account/README.md` 重新记录配对标题哈希。

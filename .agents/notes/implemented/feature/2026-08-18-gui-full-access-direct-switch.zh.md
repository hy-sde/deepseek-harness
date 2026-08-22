# Agent Note: GUI Full access 直接切换（不再需要风险确认）

Status: implemented

[English](2026-08-18-gui-full-access-direct-switch.md) | 中文

Supersedes [2026-07-31-gui-full-access-confirmation.md](2026-07-31-gui-full-access-confirmation.zh.md) —— 它所引入的风险门禁已被移除。

## 问题

2026-07-31 的「已批准变更」流程将进入 `danger-full-access` 的每条 GUI 路径都关在共享的 `RiskConfirmation` 对话框之后。既然 Full access 现已是新会话的默认值，且审批提示已关闭（`approval/policy: never`），这道门禁就成了每次选择的额外成本：人人都从该预设出发，却仍要求每次切换及切回都勾选并确认；而且整个 harness 目前都在审批关闭状态下运行。

## 决策

**每个权限选择器都直接写入 Full access —— `RiskConfirmation` 对话框、其复选框门禁以及各 popup 的确认状态机全部移除。**在 composer chip、`/permission` popup 或「通用」设置中的权限行选择 `danger-full-access` 时，第一次点击即走与其他预设相同的写入路径。

- 设置行（`PermissionRow`）丢弃 `confirmingFullAccess`/`acknowledged` 状态，与其他选项一样直接调用 `select('danger-full-access')`。
- `/permission` popup 装饰不再附带 `confirmation` 载荷；ui-commands 外壳的通用门禁（`SelectOption.confirmation`、popup 控制器的 `confirming`/`acknowledged` 迁移，以及 `PopupSelectView` 的替换逻辑）整体删除，因为 Full-access 门禁是它唯一的消费方。
- composer chip（`PermissionSelect`）丢弃确认组件状态，并通过与其他每次选择相同的注入 `command` 回调提交 `/permission danger-full-access`。
- `RiskConfirmation`（ui-primitives）及其模块 CSS 与导出全部删除：没有任何界面在使用它。

文案清理跟随各表面进行：`settings.permission` 中的 `confirm.*` 键、`permission.access` namespace（及 `accessZh`/`accessEn`）与 `conversation` locale 中的 `access.confirm.*` 键一并移除。

## 后果

产品标签 `Full access` 保留（它是呈现层名称，不是门禁）；只有对话框消失。新的选择器表面不再有「需确认」构件的积木——如果要重新引入，需要把 `RiskConfirmation` 与各门禁状态一并带回来。验收：`permission-row.spec.tsx`、`browser-plugin.spec.ts`、`input-bar.spec.tsx`、`popup.spec.ts`、`popup-view.spec.tsx` 以及 Web e2e 回放都断言直接写入而非对话框。

# @deepseek-ai/dsh-tool-browser

[English](README.md) | 中文

DeepSeek Harness 的模型方 agent 化浏览器工具（移植自 omp / oh-my-pi），经 **launch／attach／relay** 后端解析宿主 [`ctx.browser`](../../browser/browser/README.zh.md) 服务。处于 agent 平面：本包以预设行挂载，不注册自己的服务。

## 功能

注册一个工具（`browser`）与 `browser:tools` 系统提示节：

- **open** — 导航命名标签页（`url`、`wait_until`、可选 `code` 在加载后运行），返回观察（title、url、ARIA 快照）。
- **run** — 在标签页内求值 `code`，然后尽力重观察。
- **state** — 不导航，直接返回当前观察。
- **close** — 关闭一个标签页、`all` 全部标签页，或配合 `kill` 关闭所派生的浏览器。
- **截图** — `screenshot: yes` 写出 PNG（进入 `screenshotDir`，默认 `<cwd>/.dsh-browser`）并返回路径供模型再读。

后端对应 omp 的 `app` 对象：`app.path` 派生带 stealth 补丁的浏览器，`app.cdp_url` 接入既有 CDP 端点，`app.relay` 通过本地 relay＋扩展驱动用户自己的标签页。

## ARIA ref

每次观察都携带带 `[ref=eN]` id 的 Playwright ARIA 快照。id 每张快照重新编号，并在下一次快照前保持有效；可用 CSS 选择器作为后备寻址。像素无关紧要时宜选快照而非截图 — 快照便宜，截图不便宜。

## 配置

- `cwd` — 默认工作目录（优先 session header；默认进程 cwd）。
- `maxAriaChars` — 返回给模型的 ARIA 快照上限（默认 20000）。
- `screenshotDir` — 截图输出目录（默认 `<cwd>/.dsh-browser`）。
- `waitUntil` — 默认等待条件（`load`）。
- `timeoutSeconds` — 默认单次调用超时（30）。

## 会话隔离

`browser` 服务共享于宿主平面；工具把标签页键按会话 id 命名空间隔离，因此并发会话不会互相夺走标签页。

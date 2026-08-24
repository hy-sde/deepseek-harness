# Av

[English](av.md) | 中文

只读 Automic Vault seam 拆分为一个宿主服务（[dsh-av](../../packages/av/av)，`ctx.av`）与一个消费方（[dsh-tool-av](../../packages/av/tool-av)，`av_scan`、`av_doctor`、`av_catalog` 与 `av_list` 四个 schema）。服务通过 [subprocess seam](subprocess.zh.md) 调用 `av` CLI；工具层负责面向模型方的契约。它配合开发者工具凭据管理器 [Automic Vault](https://www.automicvault.com/)（macOS）工作。

源码：[`packages/av/av/src/service.ts`](../../packages/av/av/src/service.ts)

## 服务面

`ctx.av` 是一个轻量、无状态、只读的封装：单实例服务所有会话，不持有持久状态。它解析 `av` 可执行文件（config → `DSH_AV_PATH` → PATH），用 `av --version` 探测，并解析 CLI 的 JSON 表面：

- **审计** — `scan` 运行 `av scan --json`（可选按具名探测器收窄），返回 finding 级细节：严重程度、说明、修复建议、受影响文件/行，以及产生每条 finding 的探测器。
- **加固验证** — `doctor` 运行 `av doctor [tool] --json`，返回每个加固器的健康状态与带修复建议和 stub/target 路径的 `issues`。
- **目录** — `detectors` 与 `hardeners` 解析 `av detectors --json` / `av hardeners --json`（名称、文档链接、hardened/applicable 状态）。
- **密钥名** — `list` 运行 `av list` 并返回已保存密钥的**名称**，绝不返回值。

每条命令都有独立的 wall-clock 超时、`SIGTERM→SIGKILL` 宽限、有界输出收集，以及转发给所派生进程的中止信号。

## 安全边界

该 seam 按构造只读，绝不释放任何已存储的 Secret Value：

- 没有任何方法调用释放值的动词（`av inject`、`av proxy`、`av save`、`av harden`）；`av save` 本身仅交互式（通过 `termios` 关闭回显从 `/dev/tty` 读取值），因此不存在可包装的非 TTY 保管路径。
- `av_list` 只返回名称，任何命令都不在 argv 上携带密钥。
- 加固、密钥存储与值注入始终由用户在其掌控的终端中人工决策；工具报告暴露与修复步骤，而不变更系统。

## 面向模型的工具

- `av_scan [severity] [detector] [max_findings]` — 完整审计；finding 携带严重程度、说明、修复建议、受影响文件/行与探测器。
- `av_doctor [tool]` — 带每条 issue 的修复建议与 stub/target 路径的加固验证。
- `av_catalog [scope] [max_entries]` — Automic Vault 认识哪些探测器与加固器，含状态与文档链接。
- `av_list` — 仅已保存的密钥名。

当 `av` CLI 缺失或损坏时，每个工具都降级为结构化的 `{ available: false, reason }` 值，并附带安装提示（`brew install --cask automic-vault/isotopes/automic-vault`），而不是抛错。

## 配置

- `dsh-av` — `avPath`、`timeoutMs`、`maxStdoutBytes`、`maxStderrBytes`、`graceMs`；二进制解析也尊重 `DSH_AV_PATH` 环境变量。
- `dsh-tool-av` — `maxFindings`、`maxCatalogEntries`、`enabled`（`av:tools` 提示段）。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxav--avservice"></a>

### `ctx.av` — `AvService`

The `ctx.av` service.

```ts cordis-catalog
/**
 * Check whether the `av` CLI is reachable and answering `av --version`.
 * Never throws: an unavailable binary, launch failure, or timeout surfaces
 * as `{ available: false, reason }`.
 * @returns reachability, CLI version when present, and a human reason on failure.
 */
async probe(): Promise<AvProbe>

/**
 * Audit the Mac for supported credential exposures and hazards
 * (`av scan --json`).
 * @param detectors - optional detector-name filter (from `detectors()`); empty means all.
 * @returns the parsed `av scan --json` report.
 */
async scan(detectors: readonly string[] = []): Promise<ScanReport>

/**
 * Verify installed hardening (`av doctor [tool] --json`).
 * @param selector - optional tool name (e.g. `gh`); empty means all.
 * @returns the parsed `av doctor [tool] --json` report.
 */
async doctor(selector?: string): Promise<DoctorReport>

/**
 * Print detector metadata (`av detectors --json`).
 * @returns the parsed report.
 */
async detectors(): Promise<DetectorsReport>

/**
 * Print hardener metadata (`av hardeners --json`).
 * @returns the parsed report.
 */
async hardeners(): Promise<HardenersReport>

/**
 * List saved secret names (`av list`). NAMES only — never values; the
 * value-releasing verbs are deliberately out of this service's surface.
 * @returns sorted saved secret names (only names, never values).
 */
async list(): Promise<string[]>

/**
 * Run one `av` command. A non-zero exit code is returned as data on the run
 * (callers decide whether it is an error); only a launch failure, a signal
 * kill, or a timeout throws {@link AvCommandError}.
 * @param argv - av arguments (never shell-interpreted).
 * @param options - cwd (required), abort signal, stdin text, timeout override.
 * @returns exit code, collected stdout/stderr, and killed flag; throws {@link AvCommandError} on launch/timeout/signal failures.
 */
async run( argv: readonly string[], options: { cwd: string; signal?: AbortSignal | undefined; stdin?: string | undefined; timeoutMs?: number }, ): Promise<CommandRun>
```

Types: [CommandRun](git.zh.md)

Source: [`packages/av/av/src/service.ts`](../../packages/av/av/src/service.ts)
<!-- END GENERATED cordis-surface -->

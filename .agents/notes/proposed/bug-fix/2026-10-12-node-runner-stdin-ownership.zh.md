# Agent Note：Node runner 中的 cell 观察到的是 EOF stdin，而非控制通道

Status: proposed

[English](2026-10-12-node-runner-stdin-ownership.md) | 中文

## 问题

持久化 JS 内核在 runner 进程本身内评估 cell：`handleExec` 通过 `new Function` 运行 cell 代码，而该进程的 wire loop 恰好在 `process.stdin` 上读取控制帧（`packages/code-runtime/code-runtime-kernels/src/nodejs/runner.ts:473`）。`process.stdin` 是包装 fd 0 的 Node 惰性 getter，因此 wire loop 与任何 cell 共享同一个流。触及 `process.stdin` 的 cell —— 附加 `'data'` 监听器、调用 `read()`、`pipe()` 或 resume 它 —— 会与控制读取方产生竞争：它可能消费 NDJSON 控制帧（内核因等待被 cell 吞掉的回复而卡死）、暂停共享流使 wire loop 饿死，或交错注册相互竞争的监听器。这种失败是静默的：没有任何东西能区分被窃取的帧与丢失的协议。

Python runner 已为完全相同的问题面持有成文的契约：`src/python/runner.ts:70-84` 将 fd 0 复制（dup）为私有的 `_CONTROL_IN`，并把 fd 0 重定向到空设备，于是用户代码读到立即 EOF，而不会阻塞（或窃取）在内核整个生命周期内保持打开的控制通道。JS runner 没有等价物：它唯一的 stdin 保护是宿主侧的 `'error'` 监听器（修复宿主向死子进程写入时崩溃的问题，`src/core/kernel.ts:388`），对进程内竞争毫无作用。

两个约束决定了修复的形状。其一，没有可收割的上游修复：上游在 worker 线程中评估 JS cell，而 worker 线程根本没有 stdin；fork 的持久化内核设计 —— 程序创建的全局变量与快照恢复都在 runner 的全局作用域中 —— 要求使用 runner 进程本身。其二，**runner 进程自身无法复制一个管道描述符**：Node 没有暴露 `dup`/`dup2`（`typeof fs.dup === 'undefined'`），`fs.createReadStream(null, { fd: 0 })` 认领的是描述符*编号*而非副本 —— `closeSync(0)` 之后私有流读到的是错误的东西或直接死亡（EBADF，随后宿主的下一次帧写入 EPIPE），让内核陷入本修复要防止的静默卡死 —— 而 `/dev/fd/0` 式的重开仅 POSIX 可用。因此在 runner 内部玩 fd 手法不是可移植的机制；决策必须上移到 spawn 边界 —— 在那里宿主才能决定 fd 0 *是什么*。

## 提案

**决策：控制通道是一等线路，不是 stdin。宿主以 fd 0 = `'ignore'` 派生 JS runner，并在专用的 fd 3 管道上传递控制帧；runner 的 wire loop 认领 fd 3。cell 于是原生地观察到立即 EOF 的 `process.stdin`，runner 内不需要任何 fd 操作 —— 与 Python runner 可观察的契约相同，只是用 Node 合适的机制达成。**

决策是*契约*本身 —— “fd 0 不承载控制流量；cell 看到 EOF stdin” —— 而每个运行时选择自己的机制：Python 保留其已验证可用的 `_CONTROL_IN` dup，JS 使用 fd 3。

1. **宿主（`src/core/kernel.ts:323`）**：`KernelRuntimeProfile` 增加控制 fd 声明（如 `controlFd?: number`）。对 JS profile，spawn 选项变为 `stdio: ['ignore', 'pipe', 'pipe', 'pipe']`，出站帧写入器指向 `proc.stdio[3]` 而非 `proc.stdin`。未声明的 profile 按今天的方式派生与写入，Python runner 不受影响。
2. **runner（`nodejs/runner.ts:473`）**：boot 阶梯以宿主认证的意图为先键、描述符类型为次键 —— 绝不用 `isFIFO()`，它在 POSIX 上对 libuv spawn 管道为假（它们是 AF_UNIX socketpair，`S_IFSOCK`），在 Windows 上即使 `st.mode` 携带 `S_IFIFO` 也被硬编码为假（nodejs/node#57603）。管道样（pipe-like）判定为 `(st.mode & fs.constants.S_IFIFO) !== 0 || st.isSocket()`。
   - **标记存在**（`DSH_KERNEL_CONTROL_FD=3`，由新宿主在其本就会在 spawn 时合并的 profile env 中设置 —— `src/core/kernel.ts:325`）：探测 fd 3。**管道样 → 认领** —— `new net.Socket({ fd: 3, readable: true, writable: false })` —— 并把现有 `FrameLineSplitter` wire loop 挂到该流上（“流末尾不冲刷尾行”契约 `nodejs/runner.ts:415-423` 原样沿用）。libuv 流包装不是风格选择，而是承重件：spawn 管道 fd 在子进程中是阻塞的，`fs.createReadStream(null, { fd: 3 })` 会让四个线程池 worker 之一在阻塞读中钉死内核整个生命周期 —— 饿死进程将来的一切其他 fs 线程池消费；`net.Socket` 经 libuv 打开 fd（非阻塞），帧正常投递、退出干净。**非管道样 → 大声失败**：标记表明宿主本想给 fd 3 但被 confinement 包装器吃掉了 —— 在仍然可用的 stdout emit 线路上发出点名缺失控制 fd 的 `control-fd-missing` 协议帧，同步刷出（经原始 fd `fs.writeSync(1, line)` —— `emit` 的 `rawStdout.write` 是 fire-and-forget，而 `process.exit()` 在 macOS 上会截断挂起的异步 stdout 写入），再以非零码退出。宿主为该帧增加分发臂 —— `parseKernelFrame` 的默认臂会丢弃未知类型（`src/core/kernel.ts:261`）、run 作用域的 `'error'` 帧在 boot 时因无活动 run 被丢弃、boot 期 stderr 按 stray 摄入 —— 因此 `#handleFrame` 必须以点名诊断快速失败启动；否则操作者只看到笼统的“未就绪即退出”，静默失效问题在上一层重演。绝不回退到空设备线路；静默 EOF 的 loop 正是本决策要防止的死内核卡死。
   - **标记缺失**（旧宿主、手动 TTY 运行）：wire loop 挂在 `process.stdin` 上，即今天的行为。正是标记让这一级安全 —— 在 fd 3 上继承到的外来描述符（本项目自己的 bash 工具环境就会传入一个）绝不会被认领，因为仅凭描述符类型无法认证意图。 `'ready'` 握手只在选定某一级之后发出，宿主绝不会写入无人认领的管道。
3. **confinement 让控制 fd 直接穿透。** 已接线的 confinement 路径会在宿主与 runner 之间插入包装器（`src/core/kernel.ts:322` 的 `config.confine(fullArgv).argv`；Linux 一级是 `packages/sandbox/sandbox-local/src/index.ts:349` 的 bwrap）。bubblewrap 没有 fd 剥离选项，也没有 `--preserve-fd`：它把继承的 fd 2 以上的描述符原样传给沙箱内命令 —— 沙箱子进程的 exec 路径从不关闭多余 fd（上游源码：“Any other fds will been passed on to the child though”）—— 因此 fd 3 管道在现有 profile 下原样存活；唯一要求是宿主以它在 `src/core/kernel.ts:323` 本就控制的 4 项 stdio 派生包装器。真正会关闭继承 fd 的包装器对 JS 控制线路记为不支持，其破坏经上面的 loud-failure 级暴露；真实 bwrap 的 e2e（`packages/sandbox/sandbox-local/tests/bwrap.e2e.ts`）钉住 runner 在现有 profile 下观察到管道样的 fd 3。
4. **cell 看到什么**：fd 0 是 `'ignore'` stdio（所有平台上的空设备）。第一个触及 `process.stdin` 的 cell 会惰性构造 getter 的 Readable —— 落在其上：读取返回立即 EOF，`isTTY` 未定义（不是 TTY —— 断言 falsy 而非 `=== false`）。fd-3 路径下 runner 绝不触及 `process.stdin`，因此没有需要维护的 boot 顺序不变量。
5. **子进程**：cell 以显式 `stdio: 'inherit'` 派生的子进程把空设备作为 stdin（立即 EOF）。以 Node *默认* `stdio: 'pipe'` 派生的子进程拿到的是新管道而非 fd 0 —— 这是普通的 Node 语义，也是相对 Python（`stdin=None` 会继承 fd 0）的刻意分歧；本 note 记录该分歧而非与之对抗。

范围之外：stdout 侧（`emit` 拥有线路；直接的 `process.stdout.write` 按 `installOutputCapture` 的注释是故意不补丁的）、`process.exit()`/SIGINT 语义，以及任何 cell 交互输入特性（真正的 cell stdin 应是宿主中介的绑定，而非 fd 0）。

## 已考虑的替代方案

**runner 内 fd 手法（本提案的第一稿）：用 `fs.createReadStream(null, { fd: 0 })` 认领 fd 0，随后 `closeSync(0)` 再重开空设备。** 以证据拒绝：流认领的是描述符编号而非副本 —— close 会拆毁控制管道（流 EBADF、宿主 EPIPE），或若重开先落地，流读到的是空设备、wire loop 永久失聪。还带有一个 Python 式拼写（`os.devnull` —— Node 中拼写为 `os.devNull`，且本决策下两者都不再需要）和一个 `closeSync(0)` 之后不可达的 TTY 回退。记录于此，因为其失效模式 —— 内核静默死亡 —— 恰是契约所禁止的。

**仅 POSIX 的副本：经 `/dev/fd/0` / `/proc/self/fd/0` 重开。** 以不可移植拒绝：kernels 套件必须保持 Windows 可移植，而 Windows 没有继承管道的等价重开。

**用桩替换 `process.stdin` getter**（抛错的，或 EOF `PassThrough`）。拒绝：错误不是 EOF（偏离 Python 契约）、在 `isTTY` 上说谎、与惰性 getter 的缓存机制相搏斗 —— 且控制通道仍留在共享描述符上。

**在 worker 线程中评估 cell（上游模型）。** 就此缺口而言拒绝：worker 没有 stdin，风险在结构上消失，但持久化模型正是要被重写的东西 —— `state`、程序创建的全局变量与快照恢复都活在 runner 的全局作用域中。那是另一种内核设计，而不是修复。

**只写文档“cell 不得触及 `process.stdin`”而不改代码。** 拒绝：失效模式是内核静默卡死且没有任何诊断；只存在于文字里的契约保护不了线路。

## 验收标准

- 读取 `process.stdin` 的 cell 观察到立即 EOF（只有 `'end'` 而无 `'data'`），且 wire loop 在其后仍能投递下一个 `exec` 帧 —— 由 kernels 套件中以新 stdio 派生、锻炼认领路径（而非仅回退）的回归测试在 POSIX 与 Windows 上共同钉住。
- cell 以显式 `stdio: 'inherit'` 派生的子进程 stdin 读到立即 EOF；默认 `'pipe'` 的子进程拿到新管道（已记录的 Node 分歧）。
- fd-3 模式下 `process.stdin.isTTY` 未定义；kernels 套件保持绿色（86 测试基线），包括其 Windows 可移植性门禁。
- 标记缺失（旧宿主/TTY）：wire loop 的行为与今天完全一致，且 fd 3 上继承的外来描述符被忽略。标记存在但 fd 3 非管道样（会剥离 fd 的包装器）：runner 发出响亮的协议错误并以非零码退出而非卡死，且 `sandboxConfinement` + JS 内核通过其套件、runner 在现有 bwrap profile 下观察到管道样的 fd 3（真实 bwrap e2e）。

## 风险

- **契约以宿主+runner 成对、confinement 为第三方的形式发布。** spawn 选项（含 `DSH_KERNEL_CONTROL_FD` 标记）、出站写入器目标、runner 的 boot 阶梯与 `control-fd-missing` 帧的宿主分发臂必须一起落地；阶梯的大声失败级保证错配的三方可见地失败而非静默卡死。confinement 无需额外旗标 —— bwrap 会穿透继承 fd —— 但任何会剥离 fd 的包装器对 JS 控制线路记为不支持，并经该级暴露。
- **描述符类型本身无法认证线路**：管道样判定为 `(st.mode & S_IFIFO) !== 0 || st.isSocket()` —— 绝不用 `isFIFO()`，它在 POSIX 上漏掉 libuv socketpair、在 Windows 上说谎（nodejs/node#57603）—— 而 env 标记才是区分“宿主意图”与“继承巧合”的依据。
- **宿主写回压**从 `proc.stdin` 移到 `proc.stdio[3]`；序列化出站写入器必须像今天一样处理新流的 `'error'`/`'drain'`。
- 86 测试基线与 Windows 门禁必须保持绿色；fd-3 探测路径需要以新 stdio 派生的测试来锻炼认领路径，而不仅是回退。

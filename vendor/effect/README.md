# @hy-sde-org/effect

A **trimmed source fork** of [`effect`](https://github.com/Effect-TS/effect) (`packages/effect` at tag `effect@4.0.5`, commit `7f524e25cfb49a71ac39b0f44278d08d40dda5de`), carrying only the combinator core that the [DeepSeek Harness](https://github.com/hy-sde) and its plugins consume:

- `Effect` (core combinators, `gen`, `scoped`, `acquireRelease`, promise boundaries, `race`/`raceFirst`, `timeout`/`timeoutOption`, `try`/`tryPromise`, `match`)
- `Cause`, `Exit`, `Deferred`, `Data`, `Scheduler` (incl. `Scheduler.MixedScheduler`)
- Their closed dependency set: `Option`, `Result`, `Context`, `Layer`-free `Logger`/`LogLevel`, `Clock`, `Duration`, `Fiber`/`Scope` surfaces, `Equal`/`Hash`, `Order`/`Equivalence`, `Predicate`/`Function`/`Tuple`/`Struct`/`Iterable`/`Record`/`Array` helpers, and the untouched fiber interpreter (`internal/effect.ts`).

Removed relative to upstream (83% smaller: 62 files / ~65k lines vs 519 files / ~389k): `Schema`, `Stream`/`Sink`/`Channel`, `Layer`, `Schedule`, `Request`/`RequestResolver`, `Metric`, transactional refs (`Tx*`), `Config`, `Platform` filesystem/network/HTTP subsystems, persistence, and their internals. The fiber runtime itself is unmodified, so behavior for the kept surface matches upstream 4.0.5.

MIT-licensed, © the Effect-TS authors (see `LICENSE`). This is **not** a general-purpose republish of `effect` — the removed surface is deliberately absent. Use upstream `effect` unless you specifically want this trimmed core.

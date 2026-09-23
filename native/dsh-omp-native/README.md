# dsh-omp-native

English | [中文](README.zh.md)

Standalone native sidecar extracted from the
[oh-my-pi](https://github.com/stencil-hq/omp) Rust rewrite (omp², MIT). It gives
the DeepSeek Harness two bounded, read-only capabilities that were previously
"Rust-dependent" in the omp backlog — now delivered as one small, statically
linked binary the harness calls over a pinned JSON CLI contract:

- **`pdf`** — page rasterization to PNG via the pure-Rust [hayro]
  (https://crates.io/crates/hayro) renderer, with the same input/page/pixel/
  output bounds the omp2 `read` tool enforces (20 MiB in, 2000 pages,
  1.5M pixels, 8 MiB out).
- **`sqlite`** — read-only querying of SQLite databases with the full oh-my-pi
  table/column target syntax (`db.sqlite`, `db.sqlite:users`,
  `db.sqlite:users?where=...&limit=...`, raw `?q=SELECT ...`), built on
  `rusqlite` with `SQLITE_OPEN_READ_ONLY` + progress interrupts and WAL support.

The harness consumer is `packages/fs/tool-fs/src/read-native.ts`: the `read`
tool routes `.pdf`/`.sqlite` files to this binary when present, sniffing the
magic bytes first, and falls back to the regular read otherwise.

## Layout

```text
native/dsh-omp-native/
  Cargo.toml            standalone crate (edition 2024, stable channel)
  src/main.rs           JSON contract entry
  src/pdf.rs            ported from omp2 crates/tools/src/read/pdf.rs
  src/sqlite.rs         ported from omp2 crates/tools/src/read/sqlite.rs (+ own tests)
  docs/cli-contract.md  pinned external contract
  fixtures/            sample.sqlite + sample.pdf used by the tool-fs spec
```

## Build

```sh
cd native/dsh-omp-native
cargo build --release          # stable channel is sufficient (no nightly)
cargo test --release           # sqlite module unit tests
```

Then either export `DSH_OMP_NATIVE_PATH=/abs/path/to/dsh-omp-native` at
harness-runtime, or leave the binary at
`native/dsh-omp-native/target/release/dsh-omp-native` (the default probe in
`read-native.ts`).

## Attribution

- `src/pdf.rs` — omp² `crates/tools/src/read/pdf.rs` (MIT), `omp_core::Str`
  replaced by `&'static str`.
- `src/sqlite.rs` — omp² `crates/tools/src/read/sqlite.rs` (MIT), `xutf` width
  calls replaced by `unicode-width` so the crate builds on stable (omp²'s own
  workspace pins nightly for its `xutf`).
- Any further capability harvested from omp² should keep the same pattern:
  bounded read-only surface, own subcommand, JSON contract, magic-byte gating
  in the consumer.

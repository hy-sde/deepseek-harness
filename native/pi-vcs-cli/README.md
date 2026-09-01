# pi-vcs-cli

English | [中文](README.zh.md)

A thin, user-installable `pi-vcs` CLI front for the DeepSeek Harness `ctx.vcs` host service — the AV pattern applied to the narrow native slice of the oh-my-pi vcs surface. A Rust binary over [gitoxide](https://github.com/GitoxideLabs/gitoxide) (`gix` 0.85).

The diff renderer is a faithful, [MIT-attributed](https://github.com/gitoxideLabs/gitoxide) port of oh-my-pi's `crates/pi-vcs` git backend, restricted to the narrow slice: git-compatible unified patch text for two-revision and staged (`--cached`) comparisons, repository discovery, and a HEAD-change watch companion. Output for the diff verbs is verified byte-identical to `git diff` for text, binary, rename/copy, and staged surfaces. No jj backend, no mutation verbs.

## Build

```sh
cargo build --release
```

Install `target/release/pi-vcs-cli` as `pi-vcs` on PATH.

Set `DSH_VCS_PATH` to point the harness at a custom path instead of PATH resolution.

## Usage

```
pi-vcs --version
pi-vcs repo-info <dir>
pi-vcs rev-diff <dir> <base> [<head>]
pi-vcs staged-diff <dir>
pi-vcs watch <dir> [--interval-ms N]
```

- Batch verbs print git-compatible unified diff text on stdout (empty when the range is clean).
- `repo-info` prints JSON `{"root":"…","gitDir":"…"}`.
- Errors print one JSON line `{"code":"…","message":"…"}` on stderr and exit non-zero; `code` follows the VcsError taxonomy (`NotARepository`, `RefNotFound`, `ObjectNotFound`, `Backend`, `Unsupported`, …) so the host service matches on structure, not message text.
- `watch` is long-running: one JSON line `{"event":"head","seq":N}` per HEAD move, stat-polling the `HEAD` file plus the branch ref it points to every `--interval-ms`; exits 0 on SIGTERM/SIGINT so the service's disposer terminates cleanly.

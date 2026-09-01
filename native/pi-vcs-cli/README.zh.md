# pi-vcs-cli

[English](README.md) | 中文

一个精简、可用户安装的 `pi-vcs` CLI 前端，服务于 DeepSeek Harness 的 `ctx.vcs` host 服务 —— 将 AV 模式应用于 oh-my-pi vcs 数据面的窄原生切片。一个基于 [gitoxide](https://github.com/GitoxideLabs/gitoxide)（`gix` 0.85）的 Rust 二进制。

差异渲染器是 oh-my-pi `crates/pi-vcs` git 后端的一个忠实、[MIT 署名](https://github.com/gitoxideLabs/gitoxide) 移植，限定于窄切片：两修订与暂存（`--cached`）比较的 git 兼容统一补丁文本、仓库发现、以及 HEAD 变化 watch 伴生进程。差异动词的输出针对文本、二进制、重命名/复制与暂存数据面，均验证为与 `git diff` 逐字节一致。无 jj 后端、无变更动词。

## 构建

```sh
cargo build --release
```

将 `target/release/pi-vcs-cli` 以 `pi-vcs` 安装到 PATH。

设置 `DSH_VCS_PATH` 可让 harness 指向自定义路径，而非 PATH 解析。

## 用法

```
pi-vcs --version
pi-vcs repo-info <dir>
pi-vcs rev-diff <dir> <base> [<head>]
pi-vcs staged-diff <dir>
pi-vcs watch <dir> [--interval-ms N]
```

- 批量动词在 stdout 打印 git 兼容的统一差异文本（范围为干净时为空）。
- `repo-info` 打印 JSON `{"root":"…","gitDir":"…"}`。
- 错误在 stderr 打印一行 JSON `{"code":"…","message":"…"}` 并以非零退出；`code` 遵循 VcsError 分类（`NotARepository`、`RefNotFound`、`ObjectNotFound`、`Backend`、`Unsupported` 等），以便 host 服务按结构而非消息文本匹配。
- `watch` 长驻运行：每次 HEAD 变化输出一行 JSON `{"event":"head","seq":N}`，每隔 `--interval-ms` 对 `HEAD` 文件及其指向的分支引用做 stat 轮询；收到 SIGTERM/SIGINT 时以 0 退出，使服务的释放器能干净终止。

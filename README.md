# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

This fork (`hy-sde/deepseek-harness`) tracks upstream [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) and ships **279 commits of additional capability** on top of it — **16 fork-only package trees**, over **267,000 added lines** — while staying current through continuous re-ports of upstream fixes.

![The fork in product terms — capabilities and customization over upstream stock](.github/assets/fork-brief.png)

What users actually feel:

- **7.7× faster cold type-checks** — 54s → 7s on a 337-project monorepo, output verified byte-identical; the same Go-native compiler drives the editor's language server.
- **Whole-repo code intelligence** — a knowledge graph answers who-calls-this, route, and architecture questions in one step instead of grep-and-read cycles.
- **Independent review on every push** — parallel reviewer agents rank findings P0–P3 and a ship / no-ship verdict gates the push.
- **Agents that survive restarts** — durable conversations keep their transcript in storage and are retried by branching from any point rather than replaying.
- **Curated project memory** — decisions, preferences, and lessons persist across sessions and are injected into future work.
- **Lean prompts, heavy capability** — persistent Python/TypeScript kernels, a bot-capable stealth browser, a real debugger (DAP), and 26 specialist tools that load on demand.

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/hy-sde/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/4MrtZUhpxg">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

`pnpm run dev:web` builds, serves, and rebuilds client bundles on source edits in one terminal, and `make help` lists the matching Make targets for Web and Desktop; the guide's application commands section owns the full table.

For agents, follow [AGENTS.md](AGENTS.md).

## Citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---
description: "组合声明的插件使用建议 skill 提供方，让部署方把每个插件的使用建议发布为可通过手势寻址的 skill。"
kind: "package-reference"
---

# @deepseek-ai/dsh-skill-plugin-use

[English](README.md) | 中文

## 概述

部署方可以通过该提供方的配置为每个已挂载插件声明一条建议 skill：每个条目发布一个 skill，其正文建议模型在本次响应中优先使用该插件的工具。用户在聊天窗口通过 `/名称` 手势触达建议，模型则通过标准 skill 工具触达；建议只在加载它的那次响应内生效，既不绑定会话，也不改路由工具。正文可以是内联配置文本或一个 markdown 文件，声明的工具名会以工具映射行追加到加载正文末尾。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

为每个值得给出使用建议的插件加一条配置，把提供方挂载到组合里，这些建议就会以配置的名称出现在会话 skill 目录中。

### 何时选择

当部署挂载的工具需要第一方使用指引——仅凭 schema 模型无法推断其价值——且希望这份指引能在聊天窗口以 `/名称` 寻址时，选择此提供方。工具自解释的插件请跳过；需要强制力时也请跳过：建议只是提示文本，不是绑定，也不是路由。

### 声明建议

提供方从组合读取配置。每个条目必须提供 kebab-case 的 `name`（同一 token 即手势）、`description`，以及内联 `instructions` 正文与 `instructionsFile` 文件路径二者之一；可选 `whenToUse` 用于目录路由，`tools` 列出插件工具名以生成尾部工具映射行，`modelInvocable: false` 则把建议限制为仅用户手势可达。

```yaml
- name: '@deepseek-ai/dsh-skill-plugin-use'
  config:
    plugins:
      - name: github-ci
        description: Prefer the GitHub CI plugin tools for pipeline questions.
        whenToUse: When the user asks about pull request checks or CI runs.
        instructions: Prefer `ci_status` and `ci_retry`; never guess pipeline state.
        tools: [ci_status, ci_retry]
      - name: notebook
        description: Advise using the notebook plugin for data exploration.
        instructionsFile: advices/notebook.md
```

`instructionsFile` 接受绝对路径、`~` 展开路径以及相对 `config.baseDir` 的路径（默认进程工作目录）；文件型正文在每次加载时重新读取，因此编辑无需重新挂载即可生效。条目校验在挂载时运行：非 kebab 名称、重复名称、缺失描述、正文来源两者皆有或皆无都会使组合加载失败，而配置的文件在发现时不存在时，该条目会像其他缺失 skill 来源一样被静默省略。

### 命名避开客户端命令

斜杠命令在 prompt 组装前由客户端解析，配置的建议永远进不了那个命名空间：与客户端命令同名的建议（例如 `compact` 或 `plan`）会永远被命令遮蔽，因为命令会先拦截输入。请选择不与客户端命令冲突的名称。

### 可观察的成功与失败

配置的建议以 `source: composition` 出现在会话目录中，并可通过手势或 skill 工具加载且附带工具映射行；配置错误的条目会在挂载时以指名条目的 `skill-plugin-use:` TypeError 使挂载失败，而文件缺失的建议则静默缺席目录。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方如何接线；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

提供方是配置驱动的 skill 来源：`apply()` 校验并冻结配置条目，随后注册一个提供方，以配置的提供方名（默认 `plugin-use`）和 `composition` 来源标签、按内置 skill rank（600）为每个条目发布一个候选项。内联条目把正文放在 locator 上；文件型条目在校验时解析路径，每次发现重新检查存在性，每次加载重新读取正文。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口、配置 schema、条目校验与建议提供方 |
| [`tests/skill-plugin-use.spec.ts`](tests/skill-plugin-use.spec.ts) | Context 级注册、发现、实时编辑、省略与校验失败行为 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时，请阅读以下页面。这些页面先介绍该提供方注册到的注册表，再说明建议如何到达模型。

- [skill 子系统参考](../../../docs/subsystems/skills.zh.md)——该提供方实现的注册表与提供方约定。
- [skill 包](../skill/README.zh.md)——该提供方注册到的注册表，以及已加载 skill 的共享渲染。
- [tool-skill 包](../tool-skill/README.zh.md)——手势与 skill 工具如何到达会话目录与模型。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-tool-skill` 间接影响模型；该包会把该提供方的目录条目和所选建议正文渲染给模型。

#### KV Cache 影响

没有建议时该提供方不改变任何请求。每条配置的建议向系统提示添加一个目录条目，每次加载的建议正文在 skill 调用点进入对话；正文按原文追加并带工具映射行，因此每加载一条建议，KV 前缀就在加载它的那次响应内增长一次。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明提供方不做什么。它们是当前包约束，不是任务积压。

- **只有建议，绝不强制**——加载的正文只是提示文本：它不能限制工具、不能改路由调用、不能延续到后续响应，也没有任何机制验证建议被遵循。
- **工具名是文档，不是契约**——`tools` 列表按原文渲染进正文；提供方无法访问 agent 的工具注册表，因此既不能校验名称，也观察不到已挂载的工具。
- **没有文件监听**——发现之后才出现的配置文件在下一次目录失效前不可见，条目的存在性在发现时冻结。
- **工作区 skill 覆盖建议**——内置 rank（600）低于项目与用户 skill rank，工作区同名 skill 会遮蔽建议。
- **手势名必须避开客户端命令**——与客户端命令同名的建议无法通过手势触达，因为命令在客户端先解析。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

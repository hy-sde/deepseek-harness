# @deepseek-ai/dsh-client-ui-wiki

[English](README.md) | 中文

面向 LLM-wiki 工作流的内嵌 wiki 抽屉：一个由侧栏脚部切换的全幅浮动面板，浏览并编辑由宿主
`wikiGraph` 服务提供的 Logseq 图 —— 无需桌面 Logseq。页面、块、标签与搜索都挂在一个
共享 store 后面，store 通过连接层 `wiki` apiproxy 域的类型化线面与宿主通信。

## Surfaces

- `sidebar.footer.action` —— **Wiki** 开关（展开态显示标签；窄轨道只显示图形）。
- `shell.overlay` —— 浮动 **LLM Wiki** 抽屉：搜索、可内联新建的页面列表、带递归大纲的页面视图
  （块内联编辑、加子块、删除、删除页面）与链接引用。

插槽注册都是增量的 —— 挂载本包永远不会改变宿主或模型平面。

## Model Experience

None, as 抽屉只是浏览器表面；模型自己的 wiki 工作走 `@deepseek-ai/dsh-tool-logseq`，从不经过本包。

#### KV Cache effect

本包不产生任何会塑造提示词的数据。

## Known Limitations and Deferred Work

- **依赖宿主服务** —— 对 `ctx.wikiGraph`（经 `wiki` apiproxy 域）挂载；没有它时每次调用都会
  回答清晰的 "wiki service absent" 错误。
- **CLI 延迟** —— 每次读写都会启动 `logseq` CLI 进程；抽屉会显示 loading/busy 状态但不是
  虚拟化的，超大页面会整页重渲染。
- **属性值是引用** —— 以行内 `key:: value` 显示、通过块文本编辑；完整的属性值编辑器暂留在 CLI 侧。

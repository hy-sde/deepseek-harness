/** `wiki` namespace dictionaries: the wiki drawer and sidebar-toggle copy. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'drawer.loading': '加载中…',
  'drawer.backToPages': '‹ 页面',
  'drawer.deletePageTitle': '删除此页面（不可恢复）',
  'drawer.referencedFrom': '被引用自',
  'drawer.placeholder': '在 {name} 上添加块… 回车保存',
  'drawer.searchPlaceholder': '搜索页面与块…',
  'drawer.search': '搜索',
  'drawer.results': '结果',
  'drawer.pages': '页面',
  'drawer.newPagePlaceholder': '新页面标题…',
  'drawer.title': 'LLM Wiki',
  'drawer.closeTitle': '关闭 Wiki（或从侧边栏切换）',
  'drawer.dismiss': '关闭',
  'toggle.closeWiki': '关闭 Wiki',
  'toggle.openWiki': '打开 Wiki',
  'toggle.label': 'Wiki',
  'block.addChild': '添加子块',
  'block.editText': '编辑文本',
  'block.deleteBlock': '删除块',
  'block.saveShortcut': '保存（⌘⏎）',
  'block.save': '保存',
  'block.cancelShortcut': '取消（Esc）',
  'block.cancel': '取消',
  'block.placeholder': '在 #{id} 下添加块… 回车保存',
} satisfies Record<string, string>

/** The wiki namespace key union. */
export type WikiKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'drawer.loading': 'Loading…',
  'drawer.backToPages': '‹ Pages',
  'drawer.deletePageTitle': 'Delete this page (permanent)',
  'drawer.referencedFrom': 'Referenced from',
  'drawer.placeholder': 'block on {name}… Enter saves',
  'drawer.searchPlaceholder': 'Search pages & blocks…',
  'drawer.search': 'Search',
  'drawer.results': 'Results',
  'drawer.pages': 'Pages',
  'drawer.newPagePlaceholder': 'New page title…',
  'drawer.title': 'LLM Wiki',
  'drawer.closeTitle': 'Close wiki (or toggle from sidebar)',
  'drawer.dismiss': 'dismiss',
  'toggle.closeWiki': 'Close wiki',
  'toggle.openWiki': 'Open wiki',
  'toggle.label': 'Wiki',
  'block.addChild': 'Add child block',
  'block.editText': 'Edit text',
  'block.deleteBlock': 'Delete block',
  'block.saveShortcut': 'Save (⌘⏎)',
  'block.save': 'Save',
  'block.cancelShortcut': 'Cancel (Esc)',
  'block.cancel': 'Cancel',
  'block.placeholder': 'child of #{id}… Enter saves',
} satisfies Record<WikiKey, string>

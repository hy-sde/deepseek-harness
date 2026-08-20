import { readFileSync } from 'node:fs'
import { parseTranslationMarkdown, translationStructureSignature, languageSwitcherTargets } from './scripts/translation-pairing.ts'

void (async () => {
  for (const doc of ['docs/tool-catalog', 'docs/config-catalog', 'docs/module-graph']) {
    const source = `${doc}.md`, zh = `${doc}.zh.md`
    const sourceTree = parseTranslationMarkdown(readFileSync(source, 'utf8'))
    const zhTree = parseTranslationMarkdown(readFileSync(zh, 'utf8'))
    const srcSw = languageSwitcherTargets(source)
    const zhSw = languageSwitcherTargets(zh)
    const a = translationStructureSignature(sourceTree, zhSw)
    const b = translationStructureSignature(zhTree, srcSw)
    const fields: [string, (string | number)[], (string | number)[]][] = [
      ['heading', a.headings, b.headings], ['table', a.tables, b.tables],
      ['list', a.lists, b.lists], ['link', a.links, b.links],
    ]
    console.log(`\n######## ${doc}  EN heads/code/tables/lists/links = ${a.headings.length}/${a.code.length}/${a.tables.length}/${a.lists.length}/${a.links.length}  ZH = ${b.headings.length}/${b.code.length}/${b.tables.length}/${b.lists.length}/${b.links.length}`)
    for (const [name, s, t] of fields) {
      const n = Math.max(s.length, t.length)
      for (let i = 0; i < n; i++) {
        if (s[i] !== t[i]) console.log(`  ${name}[${i + 1}] EN=${JSON.stringify(s[i])}  ZH=${JSON.stringify(t[i])}`)
      }
    }
  }
})()

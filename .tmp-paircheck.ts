import { readFileSync } from 'node:fs'
import {
  parseTranslationMarkdown, translationStructureSignature,
  translationStructureDiff, languageSwitcherTargets, partitionGeneratedRegions,
} from './scripts/translation-pairing.ts'

void (async () => {
  for (const doc of ['docs/tool-catalog', 'docs/config-catalog', 'docs/module-graph']) {
    const source = `${doc}.md`, zh = `${doc}.zh.md`
    const sourceTree = parseTranslationMarkdown(readFileSync(source, 'utf8'))
    const zhTree = parseTranslationMarkdown(readFileSync(zh, 'utf8'))
    const srcSw = languageSwitcherTargets(source)
    const zhSw = languageSwitcherTargets(zh)
    const a = translationStructureSignature(sourceTree, zhSw)
    const b = translationStructureSignature(zhTree, srcSw)
    const fields: [string, (string | number)[]][] = [
      ['heading', a.headings], ['code', a.code], ['table', a.tables], ['list', a.lists], ['link', a.links],
    ]
    const zf: [string, (string | number)[]][] = [
      ['heading', b.headings], ['code', b.code], ['table', b.tables], ['list', b.lists], ['link', b.links],
    ]
    console.log(`\n######## ${doc}`)
    console.log('EN counts h/c/t/l/ln:', a.headings.length, a.code.length, a.tables.length, a.lists.length, a.links.length,
      '| ZH counts:', b.headings.length, b.code.length, b.tables.length, b.lists.length, b.links.length)
    for (let f = 0; f < fields.length; f++) {
      const [name, srcV] = fields[f]; const zhV = zf[f][1]
      const n = Math.max(srcV.length, zhV.length)
      for (let i = 0; i < n; i++) {
        if (srcV[i] !== zhV[i]) {
          console.log(`  ${name}[${i + 1}] EN=${JSON.stringify(srcV[i])}`);
          console.log(`  ${name}[${i + 1}] ZH=${JSON.stringify(zhV[i])}`)
          if (name === 'code') console.log('  ...(code needs byte parity, will copy from EN)')
          if (name === 'link') { /* show context below */ }
          if (i > 0 && srcV[i] === srcV[i - 1] && false) {}
        }
      }
    }
  }
})()

import { readFileSync, writeFileSync } from 'node:fs'
import { parseTranslationMarkdown } from './scripts/translation-pairing.ts'

function codeBlocks(fn: string): string[] {
  const tree: any = parseTranslationMarkdown(readFileSync(fn, 'utf8'))
  const out: string[] = []
  const visit = (n: any) => {
    if (n.type === 'code') out.push(`${n.lang ?? ''}${n.meta ? ` ${n.meta}` : ''}\x00${n.value}`)
    if (n.children) n.children.forEach(visit)
  }
  visit(tree)
  return out
}

function sync(fnEn: string, fnZh: string, kind: string): void {
  const en = codeBlocks(fnEn)
  const zh = codeBlocks(fnZh)
  if (en.length !== zh.length) console.log(`[${kind}] code count mismatch EN=${en.length} ZH=${zh.length}`)
  let fixed = 0
  for (let i = 0; i < Math.min(en.length, zh.length); i++) {
    if (en[i] !== zh[i]) {
      // report diff briefly
      const [langMetaEn, bodyEn] = en[i].split('\x00')
      const [langMetaZh, bodyZh] = zh[i].split('\x00')
      console.log(`[${kind}] code[${i + 1}] EN head: ${JSON.stringify(bodyEn.slice(0, 90))}`)
      console.log(`[${kind}] code[${i + 1}] ZH head: ${JSON.stringify(bodyZh.slice(0, 90))}`)
      fixed++
    }
  }
  console.log(`[${kind}] total divergent code blocks: ${fixed}`)
}

sync('docs/tool-catalog.md', 'docs/tool-catalog.zh.md', 'tool')
sync('docs/config-catalog.md', 'docs/config-catalog.zh.md', 'config')

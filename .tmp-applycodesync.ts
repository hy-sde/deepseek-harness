import { readFileSync, writeFileSync } from 'node:fs'
import { parseTranslationMarkdown } from './scripts/translation-pairing.ts'

interface Pos { line: number; column: number; offset: number }
interface CNode { lang: string | null; meta: string | null; value: string; start: Pos; end: Pos }

function collect(fn: string): { src: string; nodes: CNode[] } {
  const src = readFileSync(fn, 'utf8')
  const tree: any = parseTranslationMarkdown(src)
  const nodes: CNode[] = []
  const visit = (n: any) => {
    if (n.type === 'code') nodes.push({ lang: n.lang, meta: n.meta, value: n.value, start: n.position.start, end: n.position.end })
    if (n.children) n.children.forEach(visit)
  }
  visit(tree)
  return { src, nodes }
}

function sliceOf(src: string, node: CNode): string {
  return src.slice(node.start.offset, node.end.offset)
}

function sync(fnEn: string, fnZh: string): void {
  const en = collect(fnEn)
  const zh = collect(fnZh)
  if (en.nodes.length !== zh.nodes.length) throw new Error(`${fnZh}: count mismatch ${en.nodes.length} vs ${zh.nodes.length}`)
  // Build zh output by replacing each zh code block span with EN's exact span.
  let out = ''
  let cursor = 0
  for (let i = 0; i < en.nodes.length; i++) {
    const z = zh.nodes[i], e = en.nodes[i]
    out += zh.src.slice(cursor, z.start.offset)
    out += sliceOf(en.src, e)
    cursor = z.end.offset
  }
  out += zh.src.slice(cursor)
  if (out === zh.src) { console.log(`[${fnZh}] no changes needed`); return }
  writeFileSync(fnZh, out)
  console.log(`[${fnZh}] replaced ${en.nodes.filter((e, i) => sliceOf(en.src, e) !== sliceOf(zh.src, zh.nodes[i])).length} code block(s)`)
}

sync('docs/tool-catalog.md', 'docs/tool-catalog.zh.md')
sync('docs/config-catalog.md', 'docs/config-catalog.zh.md')

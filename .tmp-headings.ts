import { readFileSync } from 'node:fs'
import { parseTranslationMarkdown } from './scripts/translation-pairing.ts'
void (async () => {
  for (const doc of ['docs/tool-catalog', 'docs/config-catalog']) {
    const source = `${doc}.md`, zh = `${doc}.zh.md`
    const s = parseTranslationMarkdown(readFileSync(source, 'utf8'))
    const z = parseTranslationMarkdown(readFileSync(zh, 'utf8'))
    const sh: any[] = [], zh2: any[] = []
    const visit = (n: any, out: any[]) => { if (n.type === 'heading') out.push({ d: n.depth, t: (n.children || []).map((c: any) => c.value ?? '').join('') }); if (n.children) n.children.forEach((c: any) => visit(c, out)) }
    visit(s, sh); visit(z, zh2)
    const n = Math.max(sh.length, zh2.length)
    console.log(`\n######## ${doc} heading side-by-side`)
    for (let i = 0; i < n; i++) {
      const e = sh[i] ? '#'.repeat(sh[i].d) + ' ' + sh[i].t : ''
      const d = zh2[i] ? '#'.repeat(zh2[i].d) + ' ' + zh2[i].t : ''
      console.log(`${i + 1}\t${e === d ? '=' : ' '} EN: ${e}  |  ZH: ${d}`)
    }
  }
})()

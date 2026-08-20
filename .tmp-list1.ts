import { readFileSync } from 'node:fs'
import { parseTranslationMarkdown } from './scripts/translation-pairing.ts'
void (async () => {
  for (const doc of ['docs/config-catalog']) {
    for (const [tag, fn] of [['EN', doc + '.md'], ['ZH', doc + '.zh.md']]) {
      const tree: any = parseTranslationMarkdown(readFileSync(fn, 'utf8'))
      let n = 0, found = 0
      const visit = (node: any) => {
        if (node.type === 'list') {
          n++
          if (n === 1) {
            found = 1
            console.log(`\n### ${tag} LIST#1: ordered=${node.ordered} start=${node.start} items=${node.children.length} (file ${fn})`)
            const item = node.children[0]
            const items = node.children
            console.log('first:', JSON.stringify(items[0]?.children?.[0])?.slice(0, 200))
            console.log('second:', JSON.stringify(items[1]?.children?.[0])?.slice(0, 200))
            console.log('last:', JSON.stringify(items[items.length - 1]?.children?.[0])?.slice(0, 200))
            // print items containing 'code-runtime'
            items.forEach((it: any, i: number) => {
              const text = JSON.stringify(it)
              if (text.includes('code-runtime')) {
                const txt = it.children.map((c: any) => JSON.stringify(c).slice(0, 250)).join(' ')
                console.log(`   item#${i + 1}: ${txt}`)
              }
            })
          }
        }
        if (node.children) node.children.forEach((c: any) => visit(c))
      }
      visit(tree)
      if (!found) console.log(tag, 'no list found?')
    }
  }
})()

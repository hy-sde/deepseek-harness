import { expect, it } from 'vitest'
import { load } from '@deepseek-ai/dsh-yaml'

it('throws on an empty !!js value via the bare package specifier', () => {
  expect(() => load('- id: x\n  config:\n    a: !!js\n', { entryList: true })).toThrow(/non-empty plain string/)
})

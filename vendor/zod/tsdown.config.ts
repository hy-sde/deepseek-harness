import { staticLinked } from '../../packages/client/tsdown.client.ts'

export default staticLinked(
  import.meta.dirname,
  ['lib/types/index.js'],
)

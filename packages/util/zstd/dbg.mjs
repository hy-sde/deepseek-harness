import { compressZstdFrame, decompressZstdFrame, scanZstdFrames } from '../../../../packages/util/zstd/lib/index.js'
const fram = await compressZstdFrame('line one\nline two\nline three\n')
const buf = Buffer.from(fram)
console.log('magic', buf[0].toString(16), buf[1].toString(16), buf[2].toString(16), buf[3].toString(16), 'len', buf.length)
const { frames } = scanZstdFrames(buf)
console.log('frames', frames)
for (const f of frames) {
  const p = await decompressZstdFrame(buf.subarray(f.start, f.end), 128 * 1024 * 1024)
  console.log('decoded:', JSON.stringify(p.toString('utf8')))
}

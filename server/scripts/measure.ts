import { CONFIG, TILES } from '../src/config.ts'
import { docSeed } from '../src/carrier.ts'
import { readImage, type DetectParams } from '../src/detect.ts'
import { demoDocs } from '../src/fixtures.ts'
import { psnr, ssim, maxDeviation } from '../src/metrics.ts'
import { assemble, buildVariants, gridFor } from '../src/variants.ts'
import { randomKey } from '../src/cnsa.ts'

const spec = { bandLo: CONFIG.bandLo, bandHi: CONFIG.bandHi }
const embed = {
  alpha: CONFIG.alpha,
  base: CONFIG.alphaBase,
  slope: CONFIG.alphaSlope,
  floorMul: CONFIG.alphaFloorMul,
  capMul: CONFIG.alphaCapMul,
  activityRef: CONFIG.activityRef,
  activityWindow: CONFIG.activityWindow,
  spec,
}
const detect: DetectParams = {
  spec,
  decoyCount: CONFIG.decoyCount,
  zThreshold: CONFIG.zThreshold,
  residualWindow: CONFIG.residualWindow,
}

const wmKey = randomKey(32)

for (const doc of demoDocs()) {
  const original = doc.build(CONFIG.imageWidth)
  const grid = gridFor(original.width, original.height, CONFIG.gridW, CONFIG.gridH)
  const seed = docSeed(wmKey, doc.key)

  const t0 = performance.now()
  const built = buildVariants(original, grid, seed, embed)
  const buildMs = performance.now() - t0

  // Pick a random codeword and assemble the copy that officer would get.
  const codeword = new Uint8Array(TILES)
  for (let i = 0; i < TILES; i++) codeword[i] = Math.random() < 0.5 ? 0 : 1
  const copy = assemble(grid, built.pairs.map((p, i) => (codeword[i] ? p.b : p.a)))
  const other = assemble(grid, built.pairs.map((p) => p.a))

  const t1 = performance.now()
  const reading = readImage(copy, grid, seed, detect)
  const readMs = performance.now() - t1

  const unmarked = readImage(original, grid, seed, detect)
  const wrongSeed = readImage(copy, grid, docSeed(wmKey, 'a-different-document'), detect)

  let errors = 0
  for (let i = 0; i < TILES; i++) if (reading.codeword[i] !== codeword[i]) errors++

  const zs = reading.tiles.map((t) => Math.abs(t.z)).sort((a, b) => a - b)

  console.log(`\n===== ${doc.name} (${original.width}x${original.height}, ${TILES} tiles) =====`)
  console.log(`  quality   PSNR(orig,copy) ${psnr(original, copy).toFixed(2)} dB   SSIM ${ssim(original, copy).toFixed(4)}   maxdev ${maxDeviation(original, copy)}/255`)
  console.log(`            PSNR(A,B)       ${psnr(other, copy).toFixed(2)} dB   SSIM ${ssim(other, copy).toFixed(4)}`)
  console.log(`  detection codeword errors ${errors}/${TILES}   readable ${reading.readableCount}/${TILES}   meanAbsZ ${reading.meanAbsZ.toFixed(2)}`)
  console.log(`            |z| min ${zs[0].toFixed(2)}  p10 ${zs[Math.floor(TILES * 0.1)].toFixed(2)}  median ${zs[Math.floor(TILES / 2)].toFixed(2)}  max ${zs[TILES - 1].toFixed(2)}`)
  console.log(`  NEGATIVES unmarked original readable ${unmarked.readableCount}/${TILES} (meanAbsZ ${unmarked.meanAbsZ.toFixed(2)})`)
  console.log(`            wrong doc seed   readable ${wrongSeed.readableCount}/${TILES} (meanAbsZ ${wrongSeed.meanAbsZ.toFixed(2)})`)
  console.log(`  timing    build ${buildMs.toFixed(0)} ms   read ${readMs.toFixed(0)} ms`)

  const q = built.quality
  const alphas = q.map((x) => x.alphaEff)
  const hosts = q.map((x) => Math.abs(x.hostProjection))
  console.log(`  alphaEff  min ${Math.min(...alphas).toFixed(2)}  max ${Math.max(...alphas).toFixed(2)}`)
  console.log(`  |host|    mean ${(hosts.reduce((a, b) => a + b, 0) / hosts.length).toFixed(3)}  max ${Math.max(...hosts).toFixed(3)}`)
}

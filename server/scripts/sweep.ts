import { docSeed } from '../src/carrier.ts'
import { readImage, type DetectParams } from '../src/detect.ts'
import { buildSurvey, buildChart } from '../src/fixtures.ts'
import { psnr, ssim } from '../src/metrics.ts'
import { assemble, buildVariants, gridFor } from '../src/variants.ts'
import { randomKey } from '../src/cnsa.ts'

const wmKey = randomKey(32)
const GW = 16, GH = 8, T = GW * GH

type Row = { band: string; win: number; alpha: number; readable: number; medZ: number; errs: number;
             negReadable: number; psnrAB: number; ssimAB: number }

function trial(bandLo: number, bandHi: number, win: number, alpha: number, imgFn: () => any): Row {
  const spec = { bandLo, bandHi }
  const original = imgFn()
  const grid = gridFor(original.width, original.height, GW, GH)
  const seed = docSeed(wmKey, 'sweep-doc')
  const embed = { alpha, base: 0.4, slope: 0.9, floorMul: 0.35, capMul: 2.0, activityRef: 12, activityWindow: 7, spec }
  const built = buildVariants(original, grid, seed, embed)
  const cw = new Uint8Array(T)
  for (let i = 0; i < T; i++) cw[i] = i % 3 === 0 ? 1 : i % 5 === 0 ? 1 : 0
  const copy = assemble(grid, built.pairs.map((p, i) => (cw[i] ? p.b : p.a)))
  const varA = assemble(grid, built.pairs.map((p) => p.a))
  const detect: DetectParams = { spec, decoyCount: 32, zThreshold: 3.5, residualWindow: win }
  const r = readImage(copy, grid, seed, detect)
  const neg = readImage(original, grid, seed, detect)
  let errs = 0
  for (let i = 0; i < T; i++) if (r.codeword[i] !== cw[i]) errs++
  const zs = r.tiles.map((t) => Math.abs(t.z)).sort((a, b) => a - b)
  return { band: `${bandLo}-${bandHi}`, win, alpha, readable: r.readableCount, medZ: zs[Math.floor(T / 2)],
           errs, negReadable: neg.readableCount, psnrAB: psnr(varA, copy), ssimAB: ssim(varA, copy) }
}

console.log('SURVEY (textured) — hunting for median |z| well above the 3.5 gate')
console.log('band        win  alpha  readable  medZ   errs  neg  PSNR(A,B)  SSIM(A,B)')
const bands: [number, number][] = [[0.08, 0.28], [0.15, 0.45], [0.20, 0.55], [0.30, 0.70]]
for (const [lo, hi] of bands) {
  for (const win of [5, 9, 15]) {
    const r = trial(lo, hi, win, 1.2, () => buildSurvey(512))
    console.log(`${r.band.padEnd(11)} ${String(r.win).padStart(3)}  ${r.alpha.toFixed(1)}   ${String(r.readable).padStart(6)}/128  ${r.medZ.toFixed(2).padStart(5)}  ${String(r.errs).padStart(4)}  ${String(r.negReadable).padStart(3)}  ${r.psnrAB.toFixed(2).padStart(8)}  ${r.ssimAB.toFixed(4)}`)
  }
}

import { docSeed } from '../src/carrier.ts'
import { readImage, registerTo, type DetectParams } from '../src/detect.ts'
import { buildSurvey } from '../src/fixtures.ts'
import { psnr, ssim } from '../src/metrics.ts'
import { assemble, buildVariants, gridFor } from '../src/variants.ts'
import { randomKey } from '../src/cnsa.ts'
import { attackSuite } from '../src/attacks.ts'

const wmKey = randomKey(32)
const GW = 16, GH = 8, T = GW * GH
const original = buildSurvey(512)
const grid = gridFor(512, 512, GW, GH)
const seed = docSeed(wmKey, 'band-sweep')
const attacks = attackSuite().filter((a) => !a.expectGeometryMismatch)

const bands: [number, number][] = [[0.15, 0.45], [0.2, 0.55], [0.25, 0.6], [0.3, 0.7], [0.35, 0.8]]
const WIN = 5

console.log('Each cell: readable/128 (codeword errors). Gate needs >= 32 readable and 0 errors.')
console.log('')
process.stdout.write('attack'.padEnd(24))
for (const [lo, hi] of bands) process.stdout.write(`${lo}-${hi}`.padStart(13))
console.log()

const rows: Record<string, string[]> = {}
const quality: string[] = []

for (const [lo, hi] of bands) {
  const spec = { bandLo: lo, bandHi: hi }
  const embed = { alpha: 1.2, base: 0.4, slope: 0.9, floorMul: 0.4, capMul: 2.0, activityRef: 12, activityWindow: 7, spec }
  const detect: DetectParams = { spec, decoyCount: 32, zThreshold: 3.5, residualWindow: WIN }
  const built = buildVariants(original, grid, seed, embed)
  const cw = new Uint8Array(T)
  for (let i = 0; i < T; i++) cw[i] = (i * 7 + 3) % 11 < 5 ? 1 : 0
  const copy = assemble(grid, built.pairs.map((p, i) => (cw[i] ? p.b : p.a)))
  const varA = assemble(grid, built.pairs.map((p) => p.a))
  quality.push(`${psnr(varA, copy).toFixed(1)}dB/${ssim(varA, copy).toFixed(3)}`)

  for (const atk of attacks) {
    const reg = registerTo(atk.apply(copy), 512, 512)
    const r = readImage(reg.img, grid, seed, detect)
    let errs = 0
    for (let i = 0; i < T; i++) if (r.mask[i] && r.codeword[i] !== cw[i]) errs++
    rows[atk.name] ??= []
    rows[atk.name].push(`${r.readableCount}(${errs})`)
  }
  // negative control
  const neg = readImage(original, grid, seed, detect)
  rows['UNMARKED (want 0)'] ??= []
  rows['UNMARKED (want 0)'].push(`${neg.readableCount}`)
}

for (const [name, cells] of Object.entries(rows)) {
  process.stdout.write(name.padEnd(24))
  for (const c of cells) process.stdout.write(c.padStart(13))
  console.log()
}
process.stdout.write('PSNR(A,B)/SSIM'.padEnd(24))
for (const q of quality) process.stdout.write(q.padStart(13))
console.log()

import { docSeed } from '../src/carrier.ts'
import { readImage, registerTo, type DetectParams } from '../src/detect.ts'
import { buildSurvey, buildChart } from '../src/fixtures.ts'
import { psnr, ssim, maxDeviation } from '../src/metrics.ts'
import { assemble, buildVariants, gridFor } from '../src/variants.ts'
import { randomKey } from '../src/cnsa.ts'
import { attackSuite } from '../src/attacks.ts'

const wmKey = randomKey(32)
const GW = 16, GH = 8, T = GW * GH
const spec = { bandLo: 0.25, bandHi: 0.6 }
const grid = gridFor(512, 512, GW, GH)
const attacks = attackSuite().filter((a) => !a.expectGeometryMismatch)
const alphas = [1.2, 1.5, 1.8, 2.1]

for (const [label, img] of [['SURVEY (textured)', buildSurvey(512)], ['CHART (mostly flat)', buildChart(512)]] as const) {
  const seed = docSeed(wmKey, label)
  console.log(`\n===== ${label} — band 0.25-0.6, readable/128 (errors) =====`)
  process.stdout.write('attack'.padEnd(24))
  for (const a of alphas) process.stdout.write(`a=${a}`.padStart(11))
  console.log()
  const rows: Record<string, string[]> = {}
  const quality: string[] = []
  for (const alpha of alphas) {
    const embed = { alpha, base: 0.4, slope: 0.9, floorMul: 0.35, capMul: 2.0, activityRef: 12, activityWindow: 7, spec }
    const detect: DetectParams = { spec, decoyCount: 32, zThreshold: 3.5, residualWindow: 5 }
    const built = buildVariants(img, grid, seed, embed)
    const cw = new Uint8Array(T)
    for (let i = 0; i < T; i++) cw[i] = (i * 7 + 3) % 11 < 5 ? 1 : 0
    const copy = assemble(grid, built.pairs.map((p, i) => (cw[i] ? p.b : p.a)))
    const varA = assemble(grid, built.pairs.map((p) => p.a))
    quality.push(`${psnr(varA, copy).toFixed(1)}/${ssim(varA, copy).toFixed(3)}/${maxDeviation(img, copy)}`)
    for (const atk of attacks) {
      const reg = registerTo(atk.apply(copy), 512, 512)
      const r = readImage(reg.img, grid, seed, detect)
      let e = 0
      for (let i = 0; i < T; i++) if (r.mask[i] && r.codeword[i] !== cw[i]) e++
      rows[atk.name] ??= []
      rows[atk.name].push(`${r.readableCount}(${e})`)
    }
    const neg = readImage(img, grid, seed, detect)
    rows['UNMARKED (want 0)'] ??= []
    rows['UNMARKED (want 0)'].push(`${neg.readableCount}`)
  }
  for (const [n, cells] of Object.entries(rows)) {
    process.stdout.write(n.padEnd(24))
    for (const c of cells) process.stdout.write(c.padStart(11))
    console.log()
  }
  process.stdout.write('PSNR(A,B)/SSIM/maxdev'.padEnd(24))
  for (const q of quality) process.stdout.write(q.padStart(11))
  console.log()
}

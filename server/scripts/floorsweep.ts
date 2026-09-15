import { docSeed } from '../src/carrier.ts'
import { readImage, registerTo, type DetectParams } from '../src/detect.ts'
import { buildChart, buildSurvey } from '../src/fixtures.ts'
import { psnr, ssim, maxDeviation } from '../src/metrics.ts'
import { assemble, buildVariants, gridFor } from '../src/variants.ts'
import { attackSuite } from '../src/attacks.ts'
import { sha512, utf8 } from '../src/bytes.ts'

// Fixed key so runs are comparable.
const wmKey = sha512(utf8('floorsweep-fixed-key')).subarray(0, 32)
const GW = 16, GH = 8, T = GW * GH
const spec = { bandLo: 0.25, bandHi: 0.6 }
const grid = gridFor(512, 512, GW, GH)
const detect: DetectParams = { spec, decoyCount: 32, zThreshold: 3.5, residualWindow: 5 }
const key = ['jpeg q=80', 'blur r=1', 'resize 50%', 'jpeg q=80 + resize 50%']
const attacks = attackSuite().filter((a) => key.includes(a.name))

for (const [label, img] of [['CHART (flat, worst case)', buildChart(512)], ['SURVEY (textured)', buildSurvey(512)]] as const) {
  const seed = docSeed(wmKey, label)
  console.log(`\n===== ${label} =====`)
  console.log('floorMul  PSNR(A,B)  SSIM(A,B)  maxdev  clean  minZ   ' + key.map((k) => k.slice(0, 9).padStart(10)).join(''))
  for (const floorMul of [0.40, 0.32, 0.25, 0.20]) {
    const embed = { alpha: 1.5, base: 0.4, slope: 0.9, floorMul, capMul: 2.0, activityRef: 12, activityWindow: 7, spec }
    const built = buildVariants(img, grid, seed, embed)
    const cw = new Uint8Array(T)
    for (let i = 0; i < T; i++) cw[i] = (i * 7 + 3) % 11 < 5 ? 1 : 0
    const copy = assemble(grid, built.pairs.map((p, i) => (cw[i] ? p.b : p.a)))
    const varA = assemble(grid, built.pairs.map((p) => p.a))
    const clean = readImage(copy, grid, seed, detect)
    const minZ = Math.min(...clean.tiles.map((t) => Math.abs(t.z)))
    const cells = attacks.map((a) => {
      const r = readImage(registerTo(a.apply(copy), 512, 512).img, grid, seed, detect)
      let e = 0
      for (let i = 0; i < T; i++) if (r.mask[i] && r.codeword[i] !== cw[i]) e++
      return `${r.readableCount}(${e})`.padStart(10)
    })
    console.log(
      `${floorMul.toFixed(2).padStart(8)}  ${psnr(varA, copy).toFixed(2).padStart(9)}  ${ssim(varA, copy).toFixed(4).padStart(9)}  ${String(maxDeviation(img, copy)).padStart(6)}  ${String(clean.readableCount).padStart(5)}  ${minZ.toFixed(2).padStart(5)}  ${cells.join('')}`,
    )
  }
}

import { describe, expect, test } from 'bun:test'
import { CONFIG, TILES } from '../src/config.ts'
import { carrierFor, dct2, docSeed, idct2 } from '../src/carrier.ts'
import { readImage, registerTo } from '../src/detect.ts'
import { buildChart, buildSurvey } from '../src/fixtures.ts'
import { maxDeviation, psnr, ssim } from '../src/metrics.ts'
import { makeGrid, readTile } from '../src/tiles.ts'
import { assemble, buildVariants, gridFor, projectLuma } from '../src/variants.ts'
import { attackSuite, addNoise, brightnessContrast, cropPad, jpegLike, resizeRoundTrip } from '../src/attacks.ts'
import type { Bitmap } from '../src/png.ts'
import { DETECT, EMBED, countErrors, fixedCodeword, testKey } from './helpers.ts'

const SIZE = 512
const wmKey = testKey()

function sealed(img: Bitmap, docId = 'test-doc') {
  const grid = gridFor(img.width, img.height, CONFIG.gridW, CONFIG.gridH)
  const seed = docSeed(wmKey, docId)
  const built = buildVariants(img, grid, seed, EMBED)
  const codeword = fixedCodeword(grid.tiles.length)
  const copy = assemble(grid, built.pairs.map((p, i) => (codeword[i] ? p.b : p.a)))
  const variantA = assemble(grid, built.pairs.map((p) => p.a))
  return { grid, seed, built, codeword, copy, variantA }
}

describe('tile geometry', () => {
  test('every pixel belongs to exactly one tile, for any grid shape', () => {
    for (const [gw, gh] of [[16, 8], [8, 8], [7, 5], [3, 11]]) {
      const grid = makeGrid(SIZE, SIZE, gw, gh)
      expect(grid.tiles.length).toBe(gw * gh)
      const seen = new Uint8Array(SIZE * SIZE)
      for (const t of grid.tiles) {
        for (let y = t.y; y < t.y + t.h; y++) for (let x = t.x; x < t.x + t.w; x++) seen[y * SIZE + x]++
      }
      expect(seen.every((n) => n === 1)).toBe(true)
    }
  })

  test('a grid larger than the image is refused rather than silently clamped', () => {
    expect(() => makeGrid(4, 4, 8, 8)).toThrow(/too small/)
  })
})

describe('carrier', () => {
  test('DCT round-trips to the original', () => {
    const src = new Float64Array(32 * 16)
    for (let i = 0; i < src.length; i++) src[i] = Math.sin(i / 3) * 40 + i * 0.1
    const back = idct2(dct2(src, 32, 16), 32, 16)
    for (let i = 0; i < src.length; i++) expect(back[i]).toBeCloseTo(src[i], 8)
  })

  test('is zero-mean and unit-variance, which the detector statistics assume', () => {
    const p = carrierFor(docSeed(wmKey, 'doc'), 3, 32, 64, EMBED.spec)
    const mean = p.reduce((a, b) => a + b, 0) / p.length
    const variance = p.reduce((a, b) => a + (b - mean) ** 2, 0) / p.length
    expect(Math.abs(mean)).toBeLessThan(1e-9)
    expect(variance).toBeCloseTo(1, 6)
  })

  test('differs per tile and per document, and is stable for the same inputs', () => {
    const seedA = docSeed(wmKey, 'doc-a')
    const seedB = docSeed(wmKey, 'doc-b')
    const t0 = carrierFor(seedA, 0, 32, 64, EMBED.spec)
    const t1 = carrierFor(seedA, 1, 32, 64, EMBED.spec)
    const other = carrierFor(seedB, 0, 32, 64, EMBED.spec)
    expect(Array.from(t0)).not.toEqual(Array.from(t1))
    expect(Array.from(t0)).not.toEqual(Array.from(other))
    expect(Array.from(carrierFor(seedA, 0, 32, 64, EMBED.spec))).toEqual(Array.from(t0))
  })
})

describe('informed embedding', () => {
  test('forces the projection to +/- the effective strength regardless of the host', () => {
    const img = buildSurvey(SIZE)
    const { grid, seed, built } = sealed(img)
    for (const rect of grid.tiles.slice(0, 24)) {
      const carrier = carrierFor(seed, rect.index, rect.w, rect.h, EMBED.spec)
      const pair = built.pairs[rect.index]
      const alphaEff = built.quality[rect.index].alphaEff
      expect(projectLuma(pair.a, rect.w, rect.h, carrier)).toBeCloseTo(alphaEff, 6)
      expect(projectLuma(pair.b, rect.w, rect.h, carrier)).toBeCloseTo(-alphaEff, 6)
    }
  })

  test('host projection alone would not separate the variants', () => {
    // If the host term were not cancelled, |host| could exceed alpha and both
    // variants would land on the same side of zero. Show the raw host term is
    // the same order as alpha, which is why cancellation is required.
    const img = buildSurvey(SIZE)
    const { grid, seed, built } = sealed(img)
    const raw = grid.tiles.map((rect) => {
      const carrier = carrierFor(seed, rect.index, rect.w, rect.h, EMBED.spec)
      return Math.abs(projectLuma(readTile(img, rect), rect.w, rect.h, carrier))
    })
    expect(Math.max(...raw)).toBeGreaterThan(0.1)
  })

  test('no tile is left unmarked, so no region is unattributable', () => {
    const { built } = sealed(buildChart(SIZE))
    for (const q of built.quality) expect(q.alphaEff).toBeGreaterThan(0)
  })
})

describe('imperceptibility', () => {
  const cases: [string, Bitmap][] = [
    ['textured survey', buildSurvey(SIZE)],
    ['mostly-flat chart', buildChart(SIZE)],
  ]
  for (const [label, img] of cases) {
    test(`${label}: the two variants are visually identical`, () => {
      const { copy, variantA } = sealed(img, label)
      // A-vs-B is the binding constraint: A - B is twice the carrier, so it
      // always scores worse than original-vs-variant.
      expect(psnr(variantA, copy)).toBeGreaterThanOrEqual(39.5)
      expect(ssim(variantA, copy)).toBeGreaterThanOrEqual(0.92)
      expect(psnr(img, copy)).toBeGreaterThanOrEqual(42)
      expect(ssim(img, copy)).toBeGreaterThanOrEqual(0.96)
      // Peak deviation lands on high-contrast edges, where the strength cap
      // allows the most and where the eye notices the least.
      expect(maxDeviation(img, copy)).toBeLessThanOrEqual(20)
    })
  }
})

describe('detection on a clean copy', () => {
  test('recovers the codeword exactly with every tile readable', () => {
    const { grid, seed, codeword, copy } = sealed(buildSurvey(SIZE))
    const reading = readImage(copy, grid, seed, DETECT)
    expect(reading.readableCount).toBe(TILES)
    expect(countErrors(reading.codeword, codeword)).toBe(0)
  })

  test('two officers get different copies from identical-looking images', () => {
    const img = buildSurvey(SIZE)
    const grid = gridFor(SIZE, SIZE, CONFIG.gridW, CONFIG.gridH)
    const seed = docSeed(wmKey, 'shared-doc')
    const built = buildVariants(img, grid, seed, EMBED)
    const cwA = fixedCodeword(TILES, 0)
    const cwB = fixedCodeword(TILES, 4)
    expect(Array.from(cwA)).not.toEqual(Array.from(cwB))
    const copyA = assemble(grid, built.pairs.map((p, i) => (cwA[i] ? p.b : p.a)))
    const copyB = assemble(grid, built.pairs.map((p, i) => (cwB[i] ? p.b : p.a)))
    expect(Array.from(copyA.rgb)).not.toEqual(Array.from(copyB.rgb))
    expect(psnr(copyA, copyB)).toBeGreaterThanOrEqual(39.5)
    expect(countErrors(readImage(copyA, grid, seed, DETECT).codeword, cwA)).toBe(0)
    expect(countErrors(readImage(copyB, grid, seed, DETECT).codeword, cwB)).toBe(0)
  })
})

/**
 * The sign of a correlation is always defined, so without a magnitude gate the
 * detector would return a complete codeword for any image at all. These are the
 * tests that decide whether the system can be trusted to stay silent.
 */
describe('nothing is read where nothing was written', () => {
  test('the unmarked original has no readable tiles', () => {
    const img = buildSurvey(SIZE)
    const { grid, seed } = sealed(img)
    expect(readImage(img, grid, seed, DETECT).readableCount).toBe(0)
  })

  test('a marked copy read with the wrong document seed has no readable tiles', () => {
    const { grid, copy } = sealed(buildSurvey(SIZE))
    const wrong = docSeed(wmKey, 'some-other-document')
    expect(readImage(copy, grid, wrong, DETECT).readableCount).toBeLessThanOrEqual(1)
  })

  test('pure noise has no readable tiles', () => {
    const grid = gridFor(SIZE, SIZE, CONFIG.gridW, CONFIG.gridH)
    const noise: Bitmap = { width: SIZE, height: SIZE, rgb: new Uint8Array(SIZE * SIZE * 3) }
    let s = 12345
    for (let i = 0; i < noise.rgb.length; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff
      noise.rgb[i] = s & 255
    }
    expect(readImage(noise, grid, docSeed(wmKey, 'test-doc'), DETECT).readableCount).toBeLessThanOrEqual(1)
  })

  test('flat colour images do not crash and read nothing', () => {
    const grid = gridFor(SIZE, SIZE, CONFIG.gridW, CONFIG.gridH)
    for (const value of [0, 128, 255]) {
      const flat: Bitmap = { width: SIZE, height: SIZE, rgb: new Uint8Array(SIZE * SIZE * 3).fill(value) }
      expect(readImage(flat, grid, docSeed(wmKey, 'test-doc'), DETECT).readableCount).toBe(0)
    }
  })

  test('a different fixture that was never sealed reads nothing', () => {
    const { grid, seed } = sealed(buildSurvey(SIZE))
    expect(readImage(buildChart(SIZE), grid, seed, DETECT).readableCount).toBeLessThanOrEqual(1)
  })
})

describe('robustness', () => {
  const { grid, seed, codeword, copy } = sealed(buildSurvey(SIZE), 'robust-doc')

  for (const attack of attackSuite()) {
    if (attack.expectGeometryMismatch || attack.beyondLimit) continue
    test(`survives ${attack.name}`, () => {
      const registered = registerTo(attack.apply(copy), SIZE, SIZE)
      expect(registered.geometryMismatch).toBe(false)
      const reading = readImage(registered.img, grid, seed, DETECT)
      expect(reading.readableCount).toBeGreaterThanOrEqual(CONFIG.minReadable)
      // The property that matters is not how many tiles survive but that the
      // ones that do are right. A readable tile must never be a wrong bit.
      expect(countErrors(reading.codeword, codeword, reading.mask)).toBe(0)
    })
  }

  test('brightness and contrast changes are absorbed entirely by the normalisation', () => {
    const shifted = brightnessContrast(copy, 1.35, 25)
    const reading = readImage(shifted, grid, seed, DETECT)
    expect(reading.readableCount).toBe(TILES)
    expect(countErrors(reading.codeword, codeword)).toBe(0)
  })

  for (const attack of attackSuite().filter((a) => a.beyondLimit)) {
    test(`${attack.name} is past the limit and falls silent instead of answering`, () => {
      const reading = readImage(registerTo(attack.apply(copy), SIZE, SIZE).img, grid, seed, DETECT)
      expect(reading.readableCount).toBeLessThan(CONFIG.minReadable)
    })
  }

  /**
   * Registration compares aspect ratio, which catches a one-sided crop but not a
   * centred one: trimming the same margin from all four sides leaves the ratio
   * untouched. The image then lands on the grid misaligned, and this is the one
   * situation where a tile can read as confidently readable and still be wrong.
   * What protects the verdict is not the per-tile check but the floor on how many
   * tiles must be readable at all, so that is what gets asserted here.
   */
  test('a centred crop collapses below the readable floor rather than naming anyone', () => {
    for (const px of [4, 8, 16, 32]) {
      const registered = registerTo(cropPad(copy, px), SIZE, SIZE)
      if (registered.geometryMismatch) continue
      const reading = readImage(registered.img, grid, seed, DETECT)
      expect(reading.readableCount).toBeLessThan(CONFIG.minReadable)
    }
  })

  test('an off-centre crop changes the aspect ratio and is refused outright', () => {
    const lopsided: Bitmap = { width: 400, height: 512, rgb: new Uint8Array(400 * 512 * 3) }
    for (let y = 0; y < 512; y++) {
      for (let x = 0; x < 400; x++) {
        for (let c = 0; c < 3; c++) lopsided.rgb[(y * 400 + x) * 3 + c] = copy.rgb[(y * SIZE + x) * 3 + c]
      }
    }
    expect(registerTo(lopsided, SIZE, SIZE).geometryMismatch).toBe(true)
  })

  test('a resized leak is registered back onto the grid', () => {
    const scaled = resizeRoundTrip(copy, 0.5)
    const registered = registerTo(scaled, SIZE, SIZE)
    expect(registered.geometryMismatch).toBe(false)
    const reading = readImage(registered.img, grid, seed, DETECT)
    expect(reading.readableCount).toBeGreaterThanOrEqual(CONFIG.minReadable)
    expect(countErrors(reading.codeword, codeword, reading.mask)).toBe(0)
  })

  test('noise degrades readable count without ever flipping a readable bit', () => {
    for (const sigma of [3, 6, 10, 16]) {
      const reading = readImage(addNoise(copy, sigma, sigma), grid, seed, DETECT)
      expect(countErrors(reading.codeword, codeword, reading.mask)).toBe(0)
    }
  })
})

import { dct2, idct2 } from './carrier.ts'
import { resample } from './detect.ts'
import type { Bitmap } from './png.ts'
import type { Grid } from './tiles.ts'

/**
 * Distortions a leaked copy realistically passes through. These are models, not
 * codecs: `jpegLike` reproduces the part of JPEG that decides whether a mark
 * survives, which is coefficient quantisation, without being a JPEG encoder.
 * Saying so plainly is better than being caught approximating.
 */

function clone(img: Bitmap): Bitmap {
  return { width: img.width, height: img.height, rgb: new Uint8Array(img.rgb) }
}

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v))

export function addNoise(img: Bitmap, sigma: number, seed = 1): Bitmap {
  const out = clone(img)
  let s = seed >>> 0 || 1
  const next = () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >> 17
    s ^= s << 5
    s >>>= 0
    return s / 4294967296
  }
  for (let i = 0; i < out.rgb.length; i++) {
    // Sum of four uniforms approximates a gaussian closely enough for a test.
    const g = (next() + next() + next() + next() - 2) * sigma
    out.rgb[i] = clamp(img.rgb[i] + g)
  }
  return out
}

export function boxBlurImage(img: Bitmap, radius: number): Bitmap {
  const out = clone(img)
  const w = img.width
  const h = img.height
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0
        let n = 0
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const yy = y + dy
            const xx = x + dx
            if (yy < 0 || xx < 0 || yy >= h || xx >= w) continue
            sum += img.rgb[(yy * w + xx) * 3 + c]
            n++
          }
        }
        out.rgb[(y * w + x) * 3 + c] = clamp(sum / n)
      }
    }
  }
  return out
}

export function resizeRoundTrip(img: Bitmap, scale: number): Bitmap {
  const w = Math.max(8, Math.round(img.width * scale))
  const h = Math.max(8, Math.round(img.height * scale))
  return resample(resample(img, w, h), img.width, img.height)
}

export function brightnessContrast(img: Bitmap, gain: number, bias: number): Bitmap {
  const out = clone(img)
  for (let i = 0; i < out.rgb.length; i++) out.rgb[i] = clamp(img.rgb[i] * gain + bias)
  return out
}

export function posterize(img: Bitmap, levels: number): Bitmap {
  const out = clone(img)
  const step = 255 / (levels - 1)
  for (let i = 0; i < out.rgb.length; i++) out.rgb[i] = clamp(Math.round(img.rgb[i] / step) * step)
  return out
}

const JPEG_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
]

function qTable(quality: number): Float64Array {
  const q = Math.max(1, Math.min(99, quality))
  const scale = q < 50 ? 5000 / q : 200 - 2 * q
  const table = new Float64Array(64)
  for (let i = 0; i < 64; i++) {
    table[i] = Math.max(1, Math.min(255, Math.floor((JPEG_LUMA[i] * scale + 50) / 100)))
  }
  return table
}

/** 8x8 block DCT, quantise, dequantise, inverse. The part of JPEG that matters here. */
export function jpegLike(img: Bitmap, quality: number): Bitmap {
  const out = clone(img)
  const table = qTable(quality)
  const block = new Float64Array(64)
  for (let c = 0; c < 3; c++) {
    for (let by = 0; by + 8 <= img.height; by += 8) {
      for (let bx = 0; bx + 8 <= img.width; bx += 8) {
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            block[y * 8 + x] = img.rgb[((by + y) * img.width + bx + x) * 3 + c] - 128
          }
        }
        const coef = dct2(block, 8, 8)
        for (let i = 0; i < 64; i++) coef[i] = Math.round(coef[i] / table[i]) * table[i]
        const back = idct2(coef, 8, 8)
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            out.rgb[((by + y) * img.width + bx + x) * 3 + c] = clamp(back[y * 8 + x] + 128)
          }
        }
      }
    }
  }
  return out
}

export function cropPad(img: Bitmap, px: number): Bitmap {
  const w = img.width - 2 * px
  const h = img.height - 2 * px
  if (w <= 0 || h <= 0) throw new Error('crop larger than image')
  const rgb = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        rgb[(y * w + x) * 3 + c] = img.rgb[((y + px) * img.width + x + px) * 3 + c]
      }
    }
  }
  return { width: w, height: h, rgb }
}

export type ColludeStrategy = 'average' | 'interleave' | 'median'

/**
 * Whole tiles taken from one colluder or another.
 *
 * This is the realistic version of interleaving: officers comparing copies see
 * which regions differ and can swap those regions wholesale. Picking per pixel
 * instead would scramble each tile internally and destroy the mark rather than
 * relocate it, which damages the attacker more than the system.
 */
export function colludeByTile(copies: Bitmap[], grid: Grid, seed = 7): Bitmap {
  if (copies.length < 2) throw new Error('collusion needs at least two copies')
  const out = clone(copies[0])
  let s = seed >>> 0 || 1
  const next = () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >> 17
    s ^= s << 5
    s >>>= 0
    return s / 4294967296
  }
  for (const rect of grid.tiles) {
    const from = copies[Math.floor(next() * copies.length) % copies.length]
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      const at = (y * out.width + rect.x) * 3
      for (let i = 0; i < rect.w * 3; i++) out.rgb[at + i] = from.rgb[at + i]
    }
  }
  return out
}

/** What two or more officers can do by comparing the copies they each hold. */
export function collude(copies: Bitmap[], strategy: ColludeStrategy, seed = 7): Bitmap {
  if (copies.length < 2) throw new Error('collusion needs at least two copies')
  const first = copies[0]
  const out = clone(first)
  let s = seed >>> 0 || 1
  const next = () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >> 17
    s ^= s << 5
    s >>>= 0
    return s / 4294967296
  }
  for (let i = 0; i < out.rgb.length; i++) {
    const values = copies.map((c) => c.rgb[i])
    if (strategy === 'average') {
      out.rgb[i] = clamp(values.reduce((a, b) => a + b, 0) / values.length)
    } else if (strategy === 'median') {
      values.sort((a, b) => a - b)
      out.rgb[i] = values[Math.floor(values.length / 2)]
    } else {
      out.rgb[i] = values[Math.floor(next() * values.length) % values.length]
    }
  }
  return out
}

export type Attack = {
  name: string
  apply: (img: Bitmap) => Bitmap
  /** Aspect ratio changes, so registration refuses the image outright. */
  expectGeometryMismatch?: boolean
  /**
   * Past the measured limit. The requirement here is not that the mark survives
   * but that the detector falls silent instead of answering wrongly.
   */
  beyondLimit?: boolean
}

export function attackSuite(): Attack[] {
  return [
    { name: 'none', apply: (i) => i },
    { name: 'noise sigma=3', apply: (i) => addNoise(i, 3, 11) },
    { name: 'noise sigma=6', apply: (i) => addNoise(i, 6, 12) },
    { name: 'noise sigma=10', apply: (i) => addNoise(i, 10, 13) },
    { name: 'jpeg q=90', apply: (i) => jpegLike(i, 90) },
    { name: 'jpeg q=80', apply: (i) => jpegLike(i, 80) },
    { name: 'jpeg q=70', apply: (i) => jpegLike(i, 70) },
    { name: 'jpeg q=50', apply: (i) => jpegLike(i, 50), beyondLimit: true },
    { name: 'blur r=1', apply: (i) => boxBlurImage(i, 1) },
    { name: 'resize 75%', apply: (i) => resizeRoundTrip(i, 0.75) },
    { name: 'resize 50%', apply: (i) => resizeRoundTrip(i, 0.5) },
    { name: 'brightness/contrast', apply: (i) => brightnessContrast(i, 1.2, 15) },
    { name: 'posterize 32', apply: (i) => posterize(i, 32) },
    { name: 'jpeg q=80 + resize 50%', apply: (i) => resizeRoundTrip(jpegLike(i, 80), 0.5) },
    { name: 'crop 8px', apply: (i) => cropPad(i, 8), expectGeometryMismatch: true },
  ]
}

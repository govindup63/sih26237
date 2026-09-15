import type { Bitmap } from './png.ts'
import { luma } from './tiles.ts'

/**
 * Imperceptibility is a claim, so it gets measured rather than asserted. These
 * run in the demo itself, not only in tests, because a judge asking "can you
 * actually see it?" deserves a number on screen.
 */
function sameShape(a: Bitmap, b: Bitmap): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`)
  }
}

export function psnr(a: Bitmap, b: Bitmap): number {
  sameShape(a, b)
  let se = 0
  for (let i = 0; i < a.rgb.length; i++) {
    const d = a.rgb[i] - b.rgb[i]
    se += d * d
  }
  const mse = se / a.rgb.length
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse)
}

export function maxDeviation(a: Bitmap, b: Bitmap): number {
  sameShape(a, b)
  let max = 0
  for (let i = 0; i < a.rgb.length; i++) {
    const d = Math.abs(a.rgb[i] - b.rgb[i])
    if (d > max) max = d
  }
  return max
}

/**
 * Mean SSIM over 8x8 windows on luma. PSNR alone hides structured distortion:
 * a mark spread across a flat region can score well on PSNR and still be
 * visible as banding, which SSIM catches and PSNR does not.
 */
export function ssim(a: Bitmap, b: Bitmap, window = 8): number {
  sameShape(a, b)
  const w = a.width
  const h = a.height
  const ya = luma(toFloat(a), w, h)
  const yb = luma(toFloat(b), w, h)
  const c1 = (0.01 * 255) ** 2
  const c2 = (0.03 * 255) ** 2

  let total = 0
  let windows = 0
  for (let y0 = 0; y0 + window <= h; y0 += window) {
    for (let x0 = 0; x0 + window <= w; x0 += window) {
      let sa = 0
      let sb = 0
      const n = window * window
      for (let y = 0; y < window; y++) {
        for (let x = 0; x < window; x++) {
          sa += ya[(y0 + y) * w + x0 + x]
          sb += yb[(y0 + y) * w + x0 + x]
        }
      }
      const ma = sa / n
      const mb = sb / n
      let va = 0
      let vb = 0
      let cov = 0
      for (let y = 0; y < window; y++) {
        for (let x = 0; x < window; x++) {
          const da = ya[(y0 + y) * w + x0 + x] - ma
          const db = yb[(y0 + y) * w + x0 + x] - mb
          va += da * da
          vb += db * db
          cov += da * db
        }
      }
      va /= n - 1
      vb /= n - 1
      cov /= n - 1
      total += ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2))
      windows++
    }
  }
  return windows === 0 ? 1 : total / windows
}

/** For the UI: shows where the mark actually lives, scaled up to be visible. */
export function amplifiedDifference(a: Bitmap, b: Bitmap, gain = 24): Bitmap {
  sameShape(a, b)
  const rgb = new Uint8Array(a.rgb.length)
  for (let i = 0; i < a.rgb.length; i++) {
    const v = 128 + (a.rgb[i] - b.rgb[i]) * gain
    rgb[i] = v < 0 ? 0 : v > 255 ? 255 : v
  }
  return { width: a.width, height: a.height, rgb }
}

function toFloat(img: Bitmap): Float64Array {
  const out = new Float64Array(img.rgb.length)
  for (let i = 0; i < img.rgb.length; i++) out[i] = img.rgb[i]
  return out
}

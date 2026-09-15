import { carrierFor, decoyCarriers, type CarrierSpec } from './carrier.ts'
import type { Bitmap } from './png.ts'
import { boxBlur, luma, readTile, type Grid } from './tiles.ts'

export type TileReading = {
  index: number
  rho: number
  z: number
  bit: 0 | 1
  readable: boolean
}

export type Reading = {
  tiles: TileReading[]
  codeword: Uint8Array
  mask: Uint8Array
  readableCount: number
  meanAbsZ: number
}

export type DetectParams = {
  spec: CarrierSpec
  decoyCount: number
  zThreshold: number
  residualWindow: number
}

/**
 * High-pass residual. Correlating against the raw tile would put the image's own
 * energy in the denominator, which swamps a mark of about one grey level. Taking
 * the residual first drops the competing noise by roughly an order of magnitude.
 */
export function residual(px: Float64Array, w: number, h: number, window: number): Float64Array {
  const y = luma(px, w, h)
  const lo = boxBlur(y, w, h, Math.max(1, Math.floor(window / 2)))
  const out = new Float64Array(y.length)
  for (let i = 0; i < y.length; i++) out[i] = y[i] - lo[i]
  return out
}

/**
 * Normalised cross-correlation, in [-1, 1]. Normalisation is what makes the
 * reading invariant to brightness and contrast changes: scaling the image scales
 * numerator and denominator alike, and the residual is already zero-mean so an
 * added constant cancels. It also puts every tile on the same scale, which the
 * confidence gate below depends on.
 */
export function normalizedCorr(a: Float64Array, b: Float64Array): number {
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < a.length; i++) {
    num += a[i] * b[i]
    da += a[i] * a[i]
    db += b[i] * b[i]
  }
  const den = Math.sqrt(da * db)
  return den === 0 ? 0 : num / den
}

/**
 * Read one tile.
 *
 * The sign of a correlation is always plus or minus something, so sign alone
 * would hand back a complete codeword for a photograph of a cat. What separates
 * a marked tile from an unmarked one is magnitude, and magnitude only means
 * something relative to what an arbitrary pattern scores on this same image. So
 * the real carrier is z-scored against a bank of decoy carriers. A marked tile
 * measures |z| of roughly 6 to 32; an unmarked tile, or the wrong document's
 * carrier, measures about 0.7. Everything below the threshold is unreadable,
 * and an image with no readable tiles has no watermark rather than a codeword.
 */
export function readTileSignal(
  px: Float64Array,
  index: number,
  w: number,
  h: number,
  seed: Uint8Array,
  params: DetectParams,
): TileReading {
  const res = residual(px, w, h, params.residualWindow)

  // A perfectly uniform tile has no residual at all. Correlating against it
  // leaves float dust in both the real score and the decoy spread, and dividing
  // one by the other manufactures a large z from nothing. Such a tile carries no
  // evidence either way, so it is unreadable by definition.
  let energy = 0
  for (let i = 0; i < res.length; i++) energy += res[i] * res[i]
  if (Math.sqrt(energy / res.length) < 1e-6) {
    return { index, rho: 0, z: 0, bit: 0, readable: false }
  }

  const carrier = carrierFor(seed, index, w, h, params.spec)
  const rho = normalizedCorr(res, carrier)

  const decoys = decoyCarriers(w, h, params.decoyCount, params.spec)
  let sum = 0
  const scores = new Float64Array(decoys.length)
  for (let k = 0; k < decoys.length; k++) {
    scores[k] = normalizedCorr(res, decoys[k])
    sum += scores[k]
  }
  const mean = sum / decoys.length
  let variance = 0
  for (let k = 0; k < scores.length; k++) variance += (scores[k] - mean) ** 2
  const sd = Math.sqrt(variance / scores.length) || 1e-12

  const z = (rho - mean) / sd
  return {
    index,
    rho,
    z,
    bit: z > 0 ? 0 : 1,
    readable: Math.abs(z) >= params.zThreshold,
  }
}

export function readImage(img: Bitmap, grid: Grid, seed: Uint8Array, params: DetectParams): Reading {
  const tiles: TileReading[] = []
  const codeword = new Uint8Array(grid.tiles.length)
  const mask = new Uint8Array(grid.tiles.length)
  let readableCount = 0
  let absZ = 0

  for (const rect of grid.tiles) {
    const reading = readTileSignal(readTile(img, rect), rect.index, rect.w, rect.h, seed, params)
    tiles.push(reading)
    codeword[rect.index] = reading.bit
    mask[rect.index] = reading.readable ? 1 : 0
    if (reading.readable) readableCount++
    absZ += Math.abs(reading.z)
  }

  return {
    tiles,
    codeword,
    mask,
    readableCount,
    meanAbsZ: absZ / grid.tiles.length,
  }
}

export type Registration = { img: Bitmap; resized: boolean; geometryMismatch: boolean }

/**
 * Put a leaked image back on the grid it was marked on. A different aspect ratio
 * means the image was cropped or padded, and re-synchronising a crop is a
 * different problem than this system solves. Guessing there is how a system
 * produces a confident wrong name, so it refuses instead.
 */
export function registerTo(img: Bitmap, targetW: number, targetH: number): Registration {
  if (img.width === targetW && img.height === targetH) {
    return { img, resized: false, geometryMismatch: false }
  }
  const wanted = targetW / targetH
  const actual = img.width / img.height
  if (Math.abs(wanted - actual) / wanted > 0.01) {
    return { img, resized: false, geometryMismatch: true }
  }
  return { img: resample(img, targetW, targetH), resized: true, geometryMismatch: false }
}

/** Bilinear resample. */
export function resample(img: Bitmap, w: number, h: number): Bitmap {
  const rgb = new Uint8Array(w * h * 3)
  const sx = img.width / w
  const sy = img.height / h
  for (let y = 0; y < h; y++) {
    const fy = Math.min(img.height - 1, (y + 0.5) * sy - 0.5)
    const y0 = Math.max(0, Math.floor(fy))
    const y1 = Math.min(img.height - 1, y0 + 1)
    const wy = fy - y0
    for (let x = 0; x < w; x++) {
      const fx = Math.min(img.width - 1, (x + 0.5) * sx - 0.5)
      const x0 = Math.max(0, Math.floor(fx))
      const x1 = Math.min(img.width - 1, x0 + 1)
      const wx = fx - x0
      for (let c = 0; c < 3; c++) {
        const p00 = img.rgb[(y0 * img.width + x0) * 3 + c]
        const p01 = img.rgb[(y0 * img.width + x1) * 3 + c]
        const p10 = img.rgb[(y1 * img.width + x0) * 3 + c]
        const p11 = img.rgb[(y1 * img.width + x1) * 3 + c]
        const top = p00 + (p01 - p00) * wx
        const bottom = p10 + (p11 - p10) * wx
        rgb[(y * w + x) * 3 + c] = Math.round(top + (bottom - top) * wy)
      }
    }
  }
  return { width: w, height: h, rgb }
}

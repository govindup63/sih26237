import { carrierFor, type CarrierSpec } from './carrier.ts'
import type { Bitmap } from './png.ts'
import { boxBlur, luma, makeGrid, readTile, tileActivity, writeTile, type Grid, type TileRect } from './tiles.ts'

export type EmbedParams = {
  alpha: number
  base: number
  slope: number
  floorMul: number
  capMul: number
  activityRef: number
  activityWindow: number
  spec: CarrierSpec
}

export type TileQuality = {
  index: number
  activity: number
  alphaEff: number
  hostProjection: number
  psnrOrigA: number
  psnrAB: number
}

export type VariantPair = { a: Float64Array; b: Float64Array }

/**
 * Projection of a tile's luma onto the carrier. The sign of this is the bit the
 * detector reads, so the embedder forces it to a known value.
 */
export function projectLuma(px: Float64Array, w: number, h: number, carrier: Float64Array): number {
  const y = luma(px, w, h)
  let mean = 0
  for (let i = 0; i < y.length; i++) mean += y[i]
  mean /= y.length
  let sum = 0
  for (let i = 0; i < y.length; i++) sum += (y[i] - mean) * carrier[i]
  return sum / y.length
}

/**
 * Build the two variants of one tile.
 *
 * The naive construction, tile +/- alpha*P, does not work. A natural tile has
 * its own projection onto the carrier, measured here as `h`, and it can easily
 * exceed alpha. Both variants then land on the same side of zero and the sign
 * carries no information at all. So the embedder cancels the host term: variant
 * A is displaced by (alpha - h) and variant B by (-alpha - h), which forces the
 * projections to exactly +alpha and -alpha whatever the image underneath is.
 *
 * Strength follows local activity, but never falls to zero. A tile with no mark
 * would be a genuinely unattributable region, and the claim that no unmarked
 * pixel is ever transmitted has to hold for every tile or it holds for none.
 */
export function buildTileVariants(
  px: Float64Array,
  rect: TileRect,
  carrier: Float64Array,
  params: EmbedParams,
): { pair: VariantPair; quality: Omit<TileQuality, 'psnrOrigA' | 'psnrAB'> } {
  const activity = tileActivity(px, rect.w, rect.h, params.activityWindow)
  const scale = Math.max(
    params.floorMul,
    Math.min(params.capMul, params.base + (params.slope * activity) / params.activityRef),
  )
  const alphaEff = params.alpha * scale
  const host = projectLuma(px, rect.w, rect.h, carrier)

  const a = new Float64Array(px.length)
  const b = new Float64Array(px.length)
  const dA = alphaEff - host
  const dB = -alphaEff - host
  for (let i = 0; i < rect.w * rect.h; i++) {
    const c = carrier[i]
    for (let ch = 0; ch < 3; ch++) {
      const at = i * 3 + ch
      a[at] = px[at] + dA * c
      b[at] = px[at] + dB * c
    }
  }
  return { pair: { a, b }, quality: { index: rect.index, activity, alphaEff, hostProjection: host } }
}

export type BuiltVariants = {
  grid: Grid
  pairs: VariantPair[]
  quality: TileQuality[]
}

export function buildVariants(img: Bitmap, grid: Grid, seed: Uint8Array, params: EmbedParams): BuiltVariants {
  const pairs: VariantPair[] = []
  const quality: TileQuality[] = []
  for (const rect of grid.tiles) {
    const px = readTile(img, rect)
    const carrier = carrierFor(seed, rect.index, rect.w, rect.h, params.spec)
    const { pair, quality: q } = buildTileVariants(px, rect, carrier, params)
    pairs.push(pair)
    quality.push({
      ...q,
      psnrOrigA: psnrArray(px, pair.a),
      psnrAB: psnrArray(pair.a, pair.b),
    })
  }
  return { grid, pairs, quality }
}

/** Put together the one image an officer's keys allow them to build. */
export function assemble(grid: Grid, tiles: Float64Array[]): Bitmap {
  const img: Bitmap = {
    width: grid.imgW,
    height: grid.imgH,
    rgb: new Uint8Array(grid.imgW * grid.imgH * 3),
  }
  for (const rect of grid.tiles) {
    const px = tiles[rect.index]
    if (!px) throw new Error(`tile ${rect.index} missing from the assembly`)
    writeTile(img, rect, px)
  }
  return img
}

export function gridFor(imgW: number, imgH: number, gridW: number, gridH: number): Grid {
  return makeGrid(imgW, imgH, gridW, gridH)
}

function psnrArray(a: Float64Array, b: Float64Array): number {
  let se = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.round(a[i]) - Math.round(b[i])
    se += d * d
  }
  const mse = se / a.length
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse)
}

export { boxBlur }

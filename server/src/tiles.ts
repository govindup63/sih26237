import type { Bitmap } from './png.ts'

export type TileRect = { index: number; x: number; y: number; w: number; h: number }

export type Grid = {
  gridW: number
  gridH: number
  imgW: number
  imgH: number
  tiles: TileRect[]
}

/**
 * Tile boundaries by proportional rounding rather than floor division, so the
 * leftover pixels spread evenly instead of piling into the last row and column.
 * A missed column would be an unmarked stripe down the image, so coverage is
 * asserted rather than assumed.
 */
export function makeGrid(imgW: number, imgH: number, gridW: number, gridH: number): Grid {
  if (imgW < gridW || imgH < gridH) throw new Error(`image ${imgW}x${imgH} too small for a ${gridW}x${gridH} grid`)
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i <= gridW; i++) xs.push(Math.round((i * imgW) / gridW))
  for (let i = 0; i <= gridH; i++) ys.push(Math.round((i * imgH) / gridH))

  const tiles: TileRect[] = []
  for (let row = 0; row < gridH; row++) {
    for (let col = 0; col < gridW; col++) {
      tiles.push({
        index: row * gridW + col,
        x: xs[col],
        y: ys[row],
        w: xs[col + 1] - xs[col],
        h: ys[row + 1] - ys[row],
      })
    }
  }

  const covered = tiles.reduce((n, t) => n + t.w * t.h, 0)
  if (covered !== imgW * imgH) throw new Error(`grid covers ${covered} of ${imgW * imgH} pixels`)
  return { gridW, gridH, imgW, imgH, tiles }
}

/** Interleaved RGB for one tile, as floats so arithmetic does not clip early. */
export function readTile(img: Bitmap, r: TileRect): Float64Array {
  const out = new Float64Array(r.w * r.h * 3)
  for (let y = 0; y < r.h; y++) {
    const src = ((r.y + y) * img.width + r.x) * 3
    const dst = y * r.w * 3
    for (let i = 0; i < r.w * 3; i++) out[dst + i] = img.rgb[src + i]
  }
  return out
}

export function writeTile(img: Bitmap, r: TileRect, px: Float64Array): void {
  for (let y = 0; y < r.h; y++) {
    const dst = ((r.y + y) * img.width + r.x) * 3
    const src = y * r.w * 3
    for (let i = 0; i < r.w * 3; i++) {
      const v = Math.round(px[src + i])
      img.rgb[dst + i] = v < 0 ? 0 : v > 255 ? 255 : v
    }
  }
}

/** Rec.601 luma of an interleaved RGB tile. */
export function luma(px: Float64Array, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h)
  for (let i = 0; i < w * h; i++) {
    out[i] = 0.299 * px[i * 3] + 0.587 * px[i * 3 + 1] + 0.114 * px[i * 3 + 2]
  }
  return out
}

/** Mean of a box filter, used for both activity and the detector's residual. */
export function boxBlur(src: Float64Array, w: number, h: number, radius: number): Float64Array {
  const tmp = new Float64Array(w * h)
  const out = new Float64Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0
      let count = 0
      for (let dx = -radius; dx <= radius; dx++) {
        const xx = x + dx
        if (xx < 0 || xx >= w) continue
        sum += src[y * w + xx]
        count++
      }
      tmp[y * w + x] = sum / count
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0
      let count = 0
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        sum += tmp[yy * w + x]
        count++
      }
      out[y * w + x] = sum / count
    }
  }
  return out
}

/** High-frequency energy. Drives how strongly a tile may be marked. */
export function tileActivity(px: Float64Array, w: number, h: number, window: number): number {
  const y = luma(px, w, h)
  const lo = boxBlur(y, w, h, Math.max(1, Math.floor(window / 2)))
  let sum = 0
  for (let i = 0; i < y.length; i++) sum += (y[i] - lo[i]) ** 2
  return Math.sqrt(sum / y.length)
}

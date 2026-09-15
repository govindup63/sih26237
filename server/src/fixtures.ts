import type { Bitmap } from './png.ts'

/**
 * Demo images are drawn from code so the repository carries no binary assets and
 * every run is reproducible.
 *
 * They deliberately mix flat panels with heavy texture. A smooth gradient is the
 * hardest case for hiding a carrier and the easiest case for detecting one, so an
 * image that is only gradient would make the imperceptibility numbers look bad and
 * the detection numbers look implausibly good. Both regimes need to be present for
 * the measurements to mean anything.
 */

function valueNoise(w: number, h: number, cell: number, seed: number): Float64Array {
  const cols = Math.ceil(w / cell) + 2
  const rows = Math.ceil(h / cell) + 2
  const lattice = new Float64Array(cols * rows)
  let s = seed >>> 0
  const next = () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >> 17
    s ^= s << 5
    s >>>= 0
    return s / 4294967296
  }
  for (let i = 0; i < lattice.length; i++) lattice[i] = next()

  const out = new Float64Array(w * h)
  const smooth = (t: number) => t * t * (3 - 2 * t)
  for (let y = 0; y < h; y++) {
    const gy = y / cell
    const y0 = Math.floor(gy)
    const fy = smooth(gy - y0)
    for (let x = 0; x < w; x++) {
      const gx = x / cell
      const x0 = Math.floor(gx)
      const fx = smooth(gx - x0)
      const a = lattice[y0 * cols + x0]
      const b = lattice[y0 * cols + x0 + 1]
      const c = lattice[(y0 + 1) * cols + x0]
      const d = lattice[(y0 + 1) * cols + x0 + 1]
      const top = a + (b - a) * fx
      const bottom = c + (d - c) * fx
      out[y * w + x] = top + (bottom - top) * fy
    }
  }
  return out
}

function blank(w: number, h: number): Bitmap {
  return { width: w, height: h, rgb: new Uint8Array(w * h * 3) }
}

function put(img: Bitmap, x: number, y: number, r: number, g: number, b: number): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return
  const at = (y * img.width + x) * 3
  img.rgb[at] = Math.max(0, Math.min(255, Math.round(r)))
  img.rgb[at + 1] = Math.max(0, Math.min(255, Math.round(g)))
  img.rgb[at + 2] = Math.max(0, Math.min(255, Math.round(b)))
}

function rect(img: Bitmap, x0: number, y0: number, w: number, h: number, r: number, g: number, b: number): void {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(img, x, y, r, g, b)
}

/** A synthetic overhead survey: terrain texture, a coastline, a grid, flat annotation panels. */
export function buildSurvey(size = 512): Bitmap {
  const img = blank(size, size)
  const coarse = valueNoise(size, size, 64, 0x51a4)
  const medium = valueNoise(size, size, 21, 0x9d3f)
  const fine = valueNoise(size, size, 7, 0x2b77)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x
      const elevation = coarse[i] * 0.6 + medium[i] * 0.3 + fine[i] * 0.1
      // A diagonal coastline splits water from land.
      const shore = (x * 0.55 + y * 0.45) / size
      const isWater = elevation < shore * 0.62
      if (isWater) {
        const depth = Math.max(0, shore * 0.62 - elevation)
        put(img, x, y, 18 + fine[i] * 14, 42 + fine[i] * 20 - depth * 40, 74 - depth * 60 + fine[i] * 24)
      } else {
        const green = 70 + elevation * 90 + fine[i] * 34
        put(img, x, y, 54 + elevation * 70 + fine[i] * 30, green, 44 + elevation * 40 + fine[i] * 22)
      }
    }
  }

  // Reference grid, thin so it does not dominate the tile statistics.
  for (let g = 64; g < size; g += 64) {
    for (let x = 0; x < size; x++) {
      const at = (g * size + x) * 3
      img.rgb[at] = Math.min(255, img.rgb[at] + 26)
      img.rgb[at + 1] = Math.min(255, img.rgb[at + 1] + 30)
      img.rgb[at + 2] = Math.min(255, img.rgb[at + 2] + 24)
    }
    for (let y = 0; y < size; y++) {
      const at = (y * size + g) * 3
      img.rgb[at] = Math.min(255, img.rgb[at] + 26)
      img.rgb[at + 1] = Math.min(255, img.rgb[at + 1] + 30)
      img.rgb[at + 2] = Math.min(255, img.rgb[at + 2] + 24)
    }
  }

  // Flat classification banners, top and bottom. These are the hard case.
  rect(img, 0, 0, size, 26, 24, 28, 36)
  rect(img, 0, size - 26, size, 26, 24, 28, 36)
  // A flat annotation panel over the water.
  rect(img, 24, 300, 150, 84, 32, 38, 48)

  return img
}

/** A chart with large flat areas: the worst case for hiding a carrier. */
export function buildChart(size = 512): Bitmap {
  const img = blank(size, size)
  for (let y = 0; y < size; y++) {
    const shade = 16 + Math.round((y / size) * 20)
    for (let x = 0; x < size; x++) put(img, x, y, shade, shade + 4, shade + 12)
  }
  rect(img, 0, 0, size, 44, 26, 44, 66)
  const bars = [0.32, 0.51, 0.44, 0.68, 0.59, 0.83, 0.72, 0.91, 0.64, 0.77]
  const left = 52
  const right = size - 28
  const top = 78
  const bottom = size - 54
  for (let g = 0; g <= 5; g++) {
    const y = top + Math.round(((bottom - top) * g) / 5)
    for (let x = left; x < right; x++) put(img, x, y, 46, 56, 70)
  }
  const slot = (right - left) / bars.length
  bars.forEach((value, i) => {
    const x0 = Math.round(left + slot * i + slot * 0.2)
    const x1 = Math.round(left + slot * (i + 1) - slot * 0.2)
    const yTop = Math.round(bottom - (bottom - top) * value)
    for (let y = yTop; y < bottom; y++) {
      const t = (y - yTop) / Math.max(1, bottom - yTop)
      for (let x = x0; x < x1; x++) put(img, x, y, 40 + t * 30, 120 + t * 60, 190 - t * 40)
    }
  })
  for (let y = top; y <= bottom; y++) put(img, left, y, 86, 102, 122)
  for (let x = left; x <= right; x++) put(img, x, bottom, 86, 102, 122)
  return img
}

export type DemoDoc = { key: string; name: string; describe: string; build: (size?: number) => Bitmap }

export function demoDocs(): DemoDoc[] {
  return [
    {
      key: 'survey',
      name: 'coastal-survey-07.png',
      describe: 'Synthetic overhead survey. Mixed terrain texture and flat classification banners.',
      build: buildSurvey,
    },
    {
      key: 'chart',
      name: 'fuel-state-chart.png',
      describe: 'Mostly flat gradient. The hardest case for hiding a mark.',
      build: buildChart,
    },
  ]
}

import { be32, sha512, utf8 } from './bytes.ts'

/**
 * The carrier is the secret that makes the whole scheme work. A recipient who
 * learned P for their tiles could subtract it and produce a clean, unattributable
 * image, so the seed behind it is as sensitive as the document key and it never
 * leaves the sealing and forensic side.
 *
 * The pattern is mid-band: energy sits above the image's own dominant low
 * frequencies and below the range JPEG quantisation and downsampling destroy.
 * White noise would lose roughly half its energy to a 50% resize; a low-pass
 * pattern would collide with the image's own structure and be visible.
 */
export type CarrierSpec = { bandLo: number; bandHi: number }

/** Counter-mode SHA-512 expansion. The carrier's secrecy rests on this. */
function xof(seed: Uint8Array, info: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length)
  let filled = 0
  let counter = 0
  while (filled < length) {
    const block = sha512(seed, info, be32(counter))
    const take = Math.min(block.length, length - filled)
    out.set(block.subarray(0, take), filled)
    filled += take
    counter++
  }
  return out
}

const cosCache = new Map<number, Float64Array>()

/** cos(pi*(2n+1)*k / 2N) for every (k, n), plus the orthonormal scale on k. */
function cosTable(n: number): Float64Array {
  const cached = cosCache.get(n)
  if (cached) return cached
  const table = new Float64Array(n * n)
  for (let k = 0; k < n; k++) {
    const scale = k === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n)
    for (let i = 0; i < n; i++) {
      table[k * n + i] = scale * Math.cos((Math.PI * (2 * i + 1) * k) / (2 * n))
    }
  }
  cosCache.set(n, table)
  return table
}

/** Separable orthonormal DCT-II over a h-by-w block. */
export function dct2(src: Float64Array, w: number, h: number): Float64Array {
  const rowT = cosTable(w)
  const colT = cosTable(h)
  const tmp = new Float64Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let k = 0; k < w; k++) {
      let sum = 0
      for (let x = 0; x < w; x++) sum += src[y * w + x] * rowT[k * w + x]
      tmp[y * w + k] = sum
    }
  }
  const out = new Float64Array(w * h)
  for (let x = 0; x < w; x++) {
    for (let k = 0; k < h; k++) {
      let sum = 0
      for (let y = 0; y < h; y++) sum += tmp[y * w + x] * colT[k * h + y]
      out[k * w + x] = sum
    }
  }
  return out
}

/** Separable orthonormal DCT-III, the exact inverse of dct2. */
export function idct2(src: Float64Array, w: number, h: number): Float64Array {
  const rowT = cosTable(w)
  const colT = cosTable(h)
  const tmp = new Float64Array(w * h)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let sum = 0
      for (let k = 0; k < h; k++) sum += src[k * w + x] * colT[k * h + y]
      tmp[y * w + x] = sum
    }
  }
  const out = new Float64Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let k = 0; k < w; k++) sum += tmp[y * w + k] * rowT[k * w + x]
      out[y * w + x] = sum
    }
  }
  return out
}

/** Zero mean, unit variance. Both are relied on by the detector's statistics. */
export function normalizePattern(a: Float64Array): Float64Array {
  let mean = 0
  for (let i = 0; i < a.length; i++) mean += a[i]
  mean /= a.length
  let energy = 0
  for (let i = 0; i < a.length; i++) {
    a[i] -= mean
    energy += a[i] * a[i]
  }
  const sd = Math.sqrt(energy / a.length)
  if (sd === 0) throw new Error('degenerate carrier: zero variance')
  for (let i = 0; i < a.length; i++) a[i] /= sd
  return a
}

/** The per-document secret the carriers are derived from. */
export function docSeed(serverWmKey: Uint8Array, docId: string): Uint8Array {
  return sha512(serverWmKey, utf8('cnsa2/doc-seed/v1'), utf8(docId)).subarray(0, 32)
}

/** Lets the forensic service later prove it used the seed committed at seal time. */
export function seedCommit(seed: Uint8Array): string {
  return Buffer.from(sha512(utf8('cnsa2/seed-commit/v1'), seed)).toString('hex')
}

function buildPattern(bits: Uint8Array, w: number, h: number, spec: CarrierSpec): Float64Array {
  const coef = new Float64Array(w * h)
  let bit = 0
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      // Normalised radial frequency, each axis as a fraction of its Nyquist.
      const f = Math.hypot(r / h, c / w)
      if (f < spec.bandLo || f > spec.bandHi) continue
      const byte = bits[(bit >> 3) % bits.length]
      coef[r * w + c] = (byte >> (bit & 7)) & 1 ? 1 : -1
      bit++
    }
  }
  if (bit === 0) throw new Error(`carrier band [${spec.bandLo}, ${spec.bandHi}] selects no coefficients at ${w}x${h}`)
  // DC is outside any sane band, so the pattern is already zero-mean before
  // normalisation; normalising fixes the variance and any rounding drift.
  return normalizePattern(idct2(coef, w, h))
}

const carrierCache = new Map<string, Float64Array>()

/** The real carrier for one tile of one document. Cached: the detector asks repeatedly. */
export function carrierFor(seed: Uint8Array, index: number, w: number, h: number, spec: CarrierSpec): Float64Array {
  const key = `${Buffer.from(seed).toString('hex')}|${index}|${w}x${h}|${spec.bandLo}|${spec.bandHi}`
  const cached = carrierCache.get(key)
  if (cached) return cached
  const need = Math.ceil((w * h) / 8) + 64
  const bits = xof(seed, concatInfo('cnsa2/carrier/v1', index), need)
  const pattern = buildPattern(bits, w, h, spec)
  carrierCache.set(key, pattern)
  return pattern
}

function concatInfo(label: string, index: number): Uint8Array {
  const tag = utf8(label)
  const out = new Uint8Array(tag.length + 4)
  out.set(tag, 0)
  out.set(be32(index), tag.length)
  return out
}

const decoyCache = new Map<string, Float64Array[]>()

/**
 * Patterns from a fixed public seed, used only to measure what correlation an
 * arbitrary pattern gets on this image. That is the null the real carrier is
 * scored against, and it is what gives the detector a NO_WATERMARK answer
 * instead of always returning some codeword.
 */
export function decoyCarriers(w: number, h: number, count: number, spec: CarrierSpec): Float64Array[] {
  const key = `${w}x${h}|${count}|${spec.bandLo}|${spec.bandHi}`
  const cached = decoyCache.get(key)
  if (cached) return cached
  const publicSeed = sha512(utf8('cnsa2/decoy-seed/v1')).subarray(0, 32)
  const need = Math.ceil((w * h) / 8) + 64
  const out: Float64Array[] = []
  for (let k = 0; k < count; k++) {
    out.push(buildPattern(xof(publicSeed, concatInfo('cnsa2/decoy/v1', k), need), w, h, spec))
  }
  decoyCache.set(key, out)
  return out
}

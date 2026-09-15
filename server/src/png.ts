import { deflateSync, inflateSync } from 'node:zlib'
import { concat } from './bytes.ts'

export type Bitmap = { width: number; height: number; rgb: Uint8Array }

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function be32(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n >>> 0)
  return b
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typed = concat(new Uint8Array([...type].map((c) => c.charCodeAt(0))), data)
  return concat(be32(data.length), typed, be32(crc32(typed)))
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && SIGNATURE.every((b, i) => bytes[i] === b)
}

export function encodePng({ width, height, rgb }: Bitmap): Uint8Array {
  const stride = width * 3
  const raw = new Uint8Array(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  const ihdr = concat(be32(width), be32(height), new Uint8Array([8, 2, 0, 0, 0]))
  return concat(SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array()))
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Only what this project writes: 8-bit truecolor, no interlace, no palette. */
export function decodePng(bytes: Uint8Array): Bitmap {
  if (!isPng(bytes)) throw new Error('not a PNG file')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 8
  let width = 0
  let height = 0
  const idat: Uint8Array[] = []
  while (at + 8 <= bytes.length) {
    const len = view.getUint32(at)
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
    const data = bytes.subarray(at + 8, at + 8 + len)
    if (type === 'IHDR') {
      width = view.getUint32(at + 8)
      height = view.getUint32(at + 12)
      const [depth, color, , , interlace] = [data[8], data[9], data[10], data[11], data[12]]
      if (depth !== 8 || color !== 2 || interlace !== 0) {
        throw new Error(`unsupported PNG (bit depth ${depth}, color type ${color}, interlace ${interlace})`)
      }
    } else if (type === 'IDAT') {
      idat.push(new Uint8Array(data))
    } else if (type === 'IEND') {
      break
    }
    at += 12 + len
  }
  const raw = new Uint8Array(inflateSync(concat(...idat)))
  const stride = width * 3
  const rgb = new Uint8Array(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const left = x >= 3 ? rgb[y * stride + x - 3]! : 0
      const up = y > 0 ? rgb[(y - 1) * stride + x]! : 0
      const upLeft = y > 0 && x >= 3 ? rgb[(y - 1) * stride + x - 3]! : 0
      let value = row[x]!
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) value += paeth(left, up, upLeft)
      else if (filter !== 0) throw new Error(`unsupported PNG row filter ${filter}`)
      rgb[y * stride + x] = value & 0xff
    }
  }
  return { width, height, rgb }
}

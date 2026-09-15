import { createHash, timingSafeEqual } from 'node:crypto'

export function hex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex')
}

export function unhex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'hex'))
}

export function b64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64')
}

export function unb64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'))
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

export function fromUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b)
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export function sha512(...parts: Uint8Array[]): Uint8Array {
  const h = createHash('sha512')
  for (const p of parts) h.update(p)
  return new Uint8Array(h.digest())
}

export function sha512hex(...parts: Uint8Array[]): string {
  return hex(sha512(...parts))
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Deterministic JSON: object keys sorted, no whitespace. Signatures are taken
 * over these exact bytes, so the sender and every recipient have to agree on
 * them byte for byte.
 */
export function canonical(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical: non-finite number')
    return JSON.stringify(value)
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`
  }
  throw new Error(`canonical: cannot serialize ${typeof value}`)
}

export function canonicalBytes(value: unknown): Uint8Array {
  return utf8(canonical(value))
}

export function short(s: string, head = 10, tail = 6): string {
  if (s.length <= head + tail + 3) return s
  return `${s.slice(0, head)}..${s.slice(-tail)}`
}

/** Big-endian uint32. Used to build unambiguous, length-prefixed signed inputs. */
export function be32(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`be32: ${value} is not a uint32`)
  }
  return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255])
}

/**
 * Length-prefixed field. Domain strings joined with a delimiter are only safe
 * while no field can contain the delimiter, which is the kind of assumption that
 * breaks the day someone adds a free-text field. Prefixing removes the question.
 */
export function lenPrefixed(value: Uint8Array | string): Uint8Array {
  const body = typeof value === 'string' ? utf8(value) : value
  return concat(be32(body.length), body)
}

import { be32, hex, sha512, unhex } from './bytes.ts'

/**
 * Leaves and internal nodes are hashed with different prefixes. Without that
 * separation an attacker can present an internal node as if it were a leaf, which
 * is the classic second-preimage weakness in a Merkle tree.
 */
const LEAF = new Uint8Array([0x00])
const NODE = new Uint8Array([0x01])

export function leafHash(...parts: Uint8Array[]): Uint8Array {
  return sha512(LEAF, ...parts)
}

function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha512(NODE, left, right)
}

/**
 * RFC 6962 style: an odd node at a level is promoted rather than duplicated.
 * Duplicating it would make two different leaf counts produce the same root.
 */
export function merkleRoot(leaves: Uint8Array[]): string {
  if (leaves.length === 0) return hex(sha512(LEAF))
  let level = leaves
  while (level.length > 1) {
    const next: Uint8Array[] = []
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? nodeHash(level[i], level[i + 1]) : level[i])
    }
    level = next
  }
  return hex(level[0])
}

/** Sibling hashes from the leaf up to the root. */
export function merkleProof(leaves: Uint8Array[], index: number): string[] {
  if (index < 0 || index >= leaves.length) throw new Error(`leaf ${index} out of range`)
  const proof: string[] = []
  let level = leaves
  let at = index
  while (level.length > 1) {
    const next: Uint8Array[] = []
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        if (i === at || i + 1 === at) proof.push(hex(level[i === at ? i + 1 : i]))
        next.push(nodeHash(level[i], level[i + 1]))
      } else {
        next.push(level[i])
      }
    }
    at = Math.floor(at / 2)
    level = next
  }
  return proof
}

export function verifyProof(leaf: Uint8Array, proof: string[], index: number, count: number, root: string): boolean {
  if (index < 0 || index >= count) return false
  let hash = leaf
  let at = index
  let width = count
  let step = 0
  while (width > 1) {
    const odd = width % 2 === 1
    const isLastOdd = odd && at === width - 1
    if (!isLastOdd) {
      const sibling = proof[step]
      if (sibling === undefined) return false
      hash = at % 2 === 0 ? nodeHash(hash, unhex(sibling)) : nodeHash(unhex(sibling), hash)
      step++
    }
    at = Math.floor(at / 2)
    width = Math.ceil(width / 2)
  }
  return step === proof.length && hex(hash) === root
}

/**
 * A digest of one encrypted variant box. The manifest commits to the root over all
 * of these, so a recipient can prove the package they received is the package the
 * sender signed before decrypting anything in it. Under A/B there is no single
 * plaintext hash that every recipient could check, because every recipient's
 * assembled bytes are different by design, so this is what replaces it.
 */
export function boxLeaf(index: number, variant: 'A' | 'B', iv: Uint8Array, tag: Uint8Array, ct: Uint8Array): Uint8Array {
  return leafHash(
    new Uint8Array([variant === 'A' ? 0x41 : 0x42]),
    be32(index),
    iv,
    tag,
    sha512(ct),
  )
}

/** Merkle tree hash of a slice, the MTH of RFC 6962. */
function mth(leaves: Uint8Array[], from: number, to: number): Uint8Array {
  const slice = leaves.slice(from, to)
  if (slice.length === 0) return sha512(LEAF)
  let level = slice
  while (level.length > 1) {
    const next: Uint8Array[] = []
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? nodeHash(level[i], level[i + 1]) : level[i])
    }
    level = next
  }
  return level[0]
}

/** Largest power of two strictly less than n. */
function splitPoint(n: number): number {
  let k = 1
  while (k * 2 < n) k *= 2
  return k
}

function subproof(m: number, leaves: Uint8Array[], from: number, to: number, b: boolean): Uint8Array[] {
  const n = to - from
  if (m === n) return b ? [] : [mth(leaves, from, to)]
  const k = splitPoint(n)
  if (m <= k) {
    return [...subproof(m, leaves, from, from + k, b), mth(leaves, from + k, to)]
  }
  return [...subproof(m - k, leaves, from + k, to, false), mth(leaves, from, from + k)]
}

/**
 * Proof that a log of `n` entries is an extension of the same log at `m` entries:
 * nothing was removed, reordered, or rewritten, only appended.
 *
 * A plain hash chain cannot show this without handing over the whole history. This
 * is what lets an auditor check that a record is still there, and still in the same
 * place, without being shown every other officer's decryptions.
 */
export function consistencyProof(leaves: Uint8Array[], m: number): string[] {
  if (m < 0 || m > leaves.length) throw new Error(`consistency: ${m} outside 0..${leaves.length}`)
  if (m === 0 || m === leaves.length) return []
  return subproof(m, leaves, 0, leaves.length, true).map(hex)
}

export function verifyConsistency(m: number, n: number, oldRoot: string, newRoot: string, proof: string[]): boolean {
  if (m === 0) return true
  if (m === n) return proof.length === 0 && oldRoot === newRoot
  if (m > n) return false

  let path = proof.map(unhex)
  // When m is a power of two the old root is itself the first node on the path
  // and is not transmitted, so put it back before walking.
  if ((m & (m - 1)) === 0) path = [unhex(oldRoot), ...path]
  if (path.length === 0) return false

  let fn = m - 1
  let sn = n - 1
  while (fn % 2 === 1) {
    fn = Math.floor(fn / 2)
    sn = Math.floor(sn / 2)
  }
  let fr = path[0]
  let sr = path[0]
  for (let i = 1; i < path.length; i++) {
    if (sn === 0) return false
    const c = path[i]
    if (fn % 2 === 1 || fn === sn) {
      fr = nodeHash(c, fr)
      sr = nodeHash(c, sr)
      while (fn !== 0 && fn % 2 === 0) {
        fn = Math.floor(fn / 2)
        sn = Math.floor(sn / 2)
      }
    } else {
      sr = nodeHash(sr, c)
    }
    fn = Math.floor(fn / 2)
    sn = Math.floor(sn / 2)
  }
  return sn === 0 && hex(fr) === oldRoot && hex(sr) === newRoot
}

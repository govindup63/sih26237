import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { ml_kem1024 } from '@noble/post-quantum/ml-kem.js'
import { ml_dsa87 } from '@noble/post-quantum/ml-dsa.js'
import { sha512 as nobleSha512 } from '@noble/hashes/sha2.js'
import { sha512hex, utf8 } from './bytes.ts'

export const SUITE = {
  name: 'CNSA 2.0',
  kem: 'ML-KEM-1024',
  kemSpec: 'FIPS 203',
  sig: 'HashML-DSA-87 (SHA-512 prehash)',
  sigSpec: 'FIPS 204',
  aead: 'AES-256-GCM',
  kdf: 'HKDF-SHA-512',
  hash: 'SHA-512',
} as const

/** FIPS 204 HashML-DSA: sign the SHA-512 digest, not the whole document. */
export const sig87 = ml_dsa87.prehash(nobleSha512)

export const SIZES = {
  kemPublicKey: ml_kem1024.lengths.publicKey,
  kemSecretKey: ml_kem1024.lengths.secretKey,
  kemCipherText: ml_kem1024.lengths.cipherText,
  sharedSecret: 32,
  dsaPublicKey: ml_dsa87.lengths.publicKey,
  dsaSecretKey: ml_dsa87.lengths.secretKey,
  signature: ml_dsa87.lengths.signature,
} as const

export type KeyPair = { publicKey: Uint8Array; secretKey: Uint8Array }

export type Identity = {
  name: string
  role: string
  fp: string
  kem: KeyPair
  dsa: KeyPair
}

export type PublicIdentity = {
  name: string
  role: string
  fp: string
  kemPublicKey: Uint8Array
  dsaPublicKey: Uint8Array
}

export class CnsaError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'CnsaError'
  }
}

/** One identity, two keys: ML-KEM-1024 to receive, ML-DSA-87 to sign. */
export function identityFingerprint(kemPublicKey: Uint8Array, dsaPublicKey: Uint8Array): string {
  return sha512hex(kemPublicKey, dsaPublicKey)
}

export function generateIdentity(name: string, role: string): Identity {
  const kem = ml_kem1024.keygen()
  const dsa = ml_dsa87.keygen()
  return { name, role, fp: identityFingerprint(kem.publicKey, dsa.publicKey), kem, dsa }
}

export function publicOf(id: Identity): PublicIdentity {
  return {
    name: id.name,
    role: id.role,
    fp: id.fp,
    kemPublicKey: id.kem.publicKey,
    dsaPublicKey: id.dsa.publicKey,
  }
}

export function randomKey(len = 32): Uint8Array {
  return new Uint8Array(randomBytes(len))
}

export function hkdf512(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, len = 32): Uint8Array {
  return new Uint8Array(hkdfSync('sha512', ikm, salt, info, len))
}

export type AeadBox = { iv: Uint8Array; ct: Uint8Array; tag: Uint8Array }

/**
 * Seal with a caller-supplied IV.
 *
 * Safe here only because every variant box gets its own key, derived alongside
 * its IV from HKDF, so no (key, IV) pair is ever reused. It makes the sealed
 * package byte-reproducible, which the demo uses to show that sealing the same
 * document twice yields the same Merkle root.
 *
 * The shortcut this must never become: one key per tile with only the IV telling
 * A from B. Under a shared key, ct_A XOR ct_B is A XOR B, which hands every
 * recipient twice the carrier and destroys the whole scheme. Two independent keys
 * remove the possibility rather than relying on nobody trying it.
 */
export function aeadSealWithIv(key: Uint8Array, iv: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): AeadBox {
  if (iv.length !== 12) throw new CnsaError('bad_iv', `AES-GCM needs a 12-byte IV, got ${iv.length}`)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(aad)
  const ct = new Uint8Array(Buffer.concat([c.update(plaintext), c.final()]))
  return { iv, ct, tag: new Uint8Array(c.getAuthTag()) }
}

export function aeadSeal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): AeadBox {
  const iv = randomKey(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(aad)
  const ct = new Uint8Array(Buffer.concat([c.update(plaintext), c.final()]))
  return { iv, ct, tag: new Uint8Array(c.getAuthTag()) }
}

export function aeadOpen(key: Uint8Array, box: AeadBox, aad: Uint8Array, what: string): Uint8Array {
  const d = createDecipheriv('aes-256-gcm', key, box.iv)
  d.setAAD(aad)
  d.setAuthTag(box.tag)
  try {
    return new Uint8Array(Buffer.concat([d.update(box.ct), d.final()]))
  } catch {
    throw new CnsaError('aead_auth_failed', `AES-256-GCM authentication failed for ${what}`)
  }
}

export function kemEncapsulate(publicKey: Uint8Array) {
  return ml_kem1024.encapsulate(publicKey)
}

export function kemDecapsulate(cipherText: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return ml_kem1024.decapsulate(cipherText, secretKey)
}

/**
 * FIPS 204 context strings keep signatures made for one purpose from being
 * replayed as another. Without them an attestation over a block hash is
 * indistinguishable from any other thing a node key might ever sign.
 */
export const SIG_CONTEXT = {
  manifest: utf8('cnsa2/manifest/v1'),
  record: utf8('cnsa2/decrypt-record/v1'),
  attestation: utf8('cnsa2/ledger-attest/v1'),
  treeHead: utf8('cnsa2/tree-head/v1'),
} as const

export function sign(secretKey: Uint8Array, message: Uint8Array, context?: Uint8Array): Uint8Array {
  return context ? sig87.sign(message, secretKey, { context }) : sig87.sign(message, secretKey)
}

export function verify(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array, context?: Uint8Array): boolean {
  try {
    return context
      ? sig87.verify(signature, message, publicKey, { context })
      : sig87.verify(signature, message, publicKey)
  } catch {
    return false
  }
}

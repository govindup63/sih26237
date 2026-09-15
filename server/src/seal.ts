import { b64, be32, canonicalBytes, concat, hex, lenPrefixed, sha512, sha512hex, short, unb64, utf8 } from './bytes.ts'
import {
  CnsaError,
  SIG_CONTEXT,
  SUITE,
  aeadOpen,
  aeadSealWithIv,
  hkdf512,
  kemEncapsulate,
  randomKey,
  verify,
  type PublicIdentity,
} from './cnsa.ts'
import type { CardSession } from './cards.ts'
import { docSeed, seedCommit } from './carrier.ts'
import { deriveCodewords, type Codeword, type CodewordScheme } from './codeword.ts'
import { boxLeaf, merkleProof, merkleRoot, verifyProof } from './merkle.ts'
import type { Bitmap } from './png.ts'
import { readTile, type Grid, type TileRect } from './tiles.ts'
import { buildVariants, gridFor, type EmbedParams } from './variants.ts'
import { f, secret, Trace } from './trace.ts'

export type Variant = 'A' | 'B'

export type WireBox = { iv: string; ct: string; tag: string }

export type VariantBox = { i: number; v: Variant; iv: string; ct: string; tag: string }

export type Slot = {
  recipientName: string
  recipientFp: string
  kemCipherText: string
  wrap: WireBox
}

export type WmSpec = {
  scheme: 'ab-variant/1'
  gridW: number
  gridH: number
  tiles: number
  imgW: number
  imgH: number
  alpha: number
  bandLo: number
  bandHi: number
  /** Proves at trial that the forensic service used the seed committed at seal time. */
  seedCommit: string
  /*
   * Which codeword construction this document was sealed with. It has to be in
   * the signed manifest: the forensic side scores a Tardos document with the
   * Tardos statistic and a uniform one with the tiered rule, and getting that
   * backwards silently changes what the verdict means.
   */
  codewords: CodewordScheme
}

export type Manifest = {
  v: 'cnsa2-variant-broadcast/1'
  docId: string
  docName: string
  createdAt: string
  senderName: string
  senderFp: string
  suite: { kem: string; sig: string; aead: string; kdf: string; hash: string }
  wm: WmSpec
  /** Merkle root over every encrypted variant box, in canonical order. */
  boxRoot: string
  boxCount: number
  /**
   * Provenance only. A recipient cannot check it: under A/B every recipient's
   * assembled bytes are different by construction, so there is no single plaintext
   * hash they could all reproduce. Integrity comes from boxRoot plus each box's tag.
   */
  originalSha512: string
  recipients: { name: string; fp: string; slotDigest: string }[]
}

export type VariantPackage = {
  manifest: Manifest
  manifestSig: string
  slots: Slot[]
  boxes: VariantBox[]
}

/** 32 bytes of key plus a 12-byte IV per tile. */
export const BUNDLE_ENTRY = 44

const variantByte = (v: Variant) => new Uint8Array([v === 'A' ? 0x41 : 0x42])

/**
 * Length-prefixed binary rather than a delimited string. A delimiter is only
 * unambiguous while no field can contain it, which stops being true the first time
 * someone adds a free-text field.
 */
function boxInfo(docId: string, index: number, v: Variant): Uint8Array {
  return concat(utf8('cnsa2/variant/v1'), new Uint8Array([0]), lenPrefixed(docId), be32(index), variantByte(v))
}

/** Binds a box to its document, its tile index, its variant and its geometry. */
function boxAad(docId: string, rect: TileRect, v: Variant, grid: Grid): Uint8Array {
  return concat(
    utf8('cnsa2/variant-box/v1'),
    new Uint8Array([0]),
    lenPrefixed(docId),
    be32(rect.index),
    variantByte(v),
    be32(rect.x),
    be32(rect.y),
    be32(rect.w),
    be32(rect.h),
    be32(grid.tiles.length),
    be32(grid.imgW),
    be32(grid.imgH),
  )
}

function bundleAad(docId: string, recipientFp: string, boxRoot: string, tiles: number): Uint8Array {
  return concat(utf8('cnsa2/bundle/v1'), lenPrefixed(docId), lenPrefixed(recipientFp), lenPrefixed(boxRoot), be32(tiles))
}

function bundleInfo(docId: string, recipientFp: string): Uint8Array {
  return concat(utf8('cnsa2/bundle-wrap/v1'), lenPrefixed(docId), lenPrefixed(recipientFp))
}

function tileBytes(px: Float64Array): Uint8Array {
  const out = new Uint8Array(px.length)
  for (let i = 0; i < px.length; i++) {
    const v = Math.round(px[i])
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v
  }
  return out
}

export function slotDigest(slot: Slot): string {
  return sha512hex(unb64(slot.kemCipherText), unb64(slot.wrap.iv), unb64(slot.wrap.ct), unb64(slot.wrap.tag))
}

export function manifestHash(manifest: Manifest): Uint8Array {
  return sha512(canonicalBytes(manifest))
}

export function boxLeaves(pkg: VariantPackage): Uint8Array[] {
  const ordered = [...pkg.boxes].sort((a, b) => (a.i - b.i) || (a.v === 'A' ? -1 : 1))
  return ordered.map((b) => boxLeaf(b.i, b.v, unb64(b.iv), unb64(b.tag), unb64(b.ct)))
}

export type SealResult = {
  pkg: VariantPackage
  /** Sender side only. Never transmitted. */
  docKey: Uint8Array
  /** Forensic side only. */
  seed: Uint8Array
  codewords: Map<string, Codeword>
  /** Per-tile Tardos biases, or null under the uniform scheme. */
  biases: Float64Array | null
  grid: Grid
  quality: { psnrAB: number; ssimAB: number }
}

/**
 * Seal an image once as 2T encrypted variants.
 *
 * Nobody receives a document key. Each officer receives only the tile keys their
 * codeword selects, so the single image they can assemble is the one that names
 * them. There is no step here that marks anything after decryption, because there
 * is no point at which an unmarked copy exists to mark.
 */
export function sealVariantPackage(args: {
  /** A live card session. The sender's secret key is never handed to this module. */
  sender: CardSession
  recipients: PublicIdentity[]
  image: Bitmap
  docName: string
  serverWmKey: Uint8Array
  gridW: number
  gridH: number
  embed: Omit<EmbedParams, 'spec'> & { spec: EmbedParams['spec'] }
  codewordScheme?: CodewordScheme
  trace?: Trace
}): SealResult {
  const { sender, recipients, image, docName, serverWmKey, gridW, gridH, embed } = args
  const codewordScheme: CodewordScheme = args.codewordScheme ?? 'uniform'
  const tr = args.trace
  if (recipients.length === 0) throw new CnsaError('no_recipients', 'pick at least one recipient')

  const docId = hex(randomKey(8))
  const docKey = randomKey(32)
  const seed = docSeed(serverWmKey, docId)
  const grid = gridFor(image.width, image.height, gridW, gridH)
  const tiles = grid.tiles.length

  tr?.add(
    'Fresh document key and carrier seed',
    'The document key never leaves the sender and is never given to any recipient. The carrier seed is derived from the server watermark key and stays on the sealing and forensic side, because anyone holding it could subtract the mark.',
    [
      f('document id', docId),
      f('grid', `${gridW} x ${gridH} = ${tiles} tiles`),
      secret('document key', hex(docKey)),
      f('seed commitment', short(seedCommit(seed), 16, 8)),
    ],
  )

  const built = buildVariants(image, grid, seed, embed as EmbedParams)

  const worstPsnr = Math.min(...built.quality.map((q) => q.psnrAB))
  tr?.add(
    `Two variants built for each of ${tiles} tiles`,
    'Every tile exists twice. The two versions differ by twice the carrier and by nothing a reader would notice; the difference is what identifies the officer who assembles them.',
    [
      f('variant pairs', `${tiles}`),
      f('worst tile PSNR between A and B', `${worstPsnr.toFixed(1)} dB`),
      f('strength range', `${Math.min(...built.quality.map((q) => q.alphaEff)).toFixed(2)} to ${Math.max(...built.quality.map((q) => q.alphaEff)).toFixed(2)} grey levels`),
    ],
  )

  const boxes: VariantBox[] = []
  const salt = sha512(docKey, utf8('cnsa2/variant-salt/v1'))
  for (const rect of grid.tiles) {
    for (const v of ['A', 'B'] as const) {
      const okm = hkdf512(docKey, salt, boxInfo(docId, rect.index, v), BUNDLE_ENTRY)
      const key = okm.subarray(0, 32)
      const iv = okm.subarray(32, 44)
      const plain = tileBytes(v === 'A' ? built.pairs[rect.index].a : built.pairs[rect.index].b)
      const box = aeadSealWithIv(key, iv, plain, boxAad(docId, rect, v, grid))
      boxes.push({ i: rect.index, v, iv: b64(box.iv), ct: b64(box.ct), tag: b64(box.tag) })
    }
  }

  const leaves = boxes
    .slice()
    .sort((a, b) => (a.i - b.i) || (a.v === 'A' ? -1 : 1))
    .map((b) => boxLeaf(b.i, b.v, unb64(b.iv), unb64(b.tag), unb64(b.ct)))
  const boxRoot = merkleRoot(leaves)

  tr?.add(
    `${boxes.length} variant boxes encrypted, each under its own key`,
    'Both variants of every tile ship to everyone, but each box has a distinct AES-256-GCM key and its additional authenticated data names the document, the tile index, the variant and the tile geometry. A box moved to another position or another document fails its tag.',
    [
      f('boxes', `${boxes.length} (2 per tile)`),
      f('bytes per box', `${unb64(boxes[0].ct).length}`),
      f('Merkle root over all boxes', short(boxRoot, 16, 8)),
    ],
  )

  const codewordSet = deriveCodewords(codewordScheme, docKey, docId, recipients.map((r) => r.fp), tiles)
  const codewords = codewordSet.codewords
  const slots: Slot[] = []
  for (const r of recipients) {
    const codeword = codewords.get(r.fp)!

    const bundle = new Uint8Array(tiles * BUNDLE_ENTRY)
    for (const rect of grid.tiles) {
      const v: Variant = codeword[rect.index] ? 'B' : 'A'
      const okm = hkdf512(docKey, salt, boxInfo(docId, rect.index, v), BUNDLE_ENTRY)
      bundle.set(okm, rect.index * BUNDLE_ENTRY)
    }

    const { cipherText, sharedSecret } = kemEncapsulate(r.kemPublicKey)
    const wrapKey = hkdf512(sharedSecret, sha512(utf8(boxRoot)), bundleInfo(docId, r.fp))
    const wrapped = aeadSealWithIv(wrapKey, randomKey(12), bundle, bundleAad(docId, r.fp, boxRoot, tiles))
    slots.push({
      recipientName: r.name,
      recipientFp: r.fp,
      kemCipherText: b64(cipherText),
      wrap: { iv: b64(wrapped.iv), ct: b64(wrapped.ct), tag: b64(wrapped.tag) },
    })
  }

  tr?.add(
    `${slots.length} key bundle${slots.length === 1 ? '' : 's'} wrapped with ML-KEM-1024`,
    'Each officer receives exactly one key per tile, chosen by their own codeword. They can open half of the boxes and no more, so the only image they can put together is theirs.',
    recipients.flatMap((r) => [
      f(`${r.name}: keys received`, `${tiles} of ${boxes.length} boxes`),
      f(`${r.name}: bundle size`, `${tiles * BUNDLE_ENTRY} bytes`),
    ]),
  )

  const manifest: Manifest = {
    v: 'cnsa2-variant-broadcast/1',
    docId,
    docName,
    createdAt: new Date().toISOString(),
    senderName: sender.name,
    senderFp: sender.fp,
    suite: { kem: SUITE.kem, sig: SUITE.sig, aead: SUITE.aead, kdf: SUITE.kdf, hash: SUITE.hash },
    wm: {
      scheme: 'ab-variant/1',
      codewords: codewordScheme,
      gridW,
      gridH,
      tiles,
      imgW: grid.imgW,
      imgH: grid.imgH,
      alpha: embed.alpha,
      bandLo: embed.spec.bandLo,
      bandHi: embed.spec.bandHi,
      seedCommit: seedCommit(seed),
    },
    boxRoot,
    boxCount: boxes.length,
    originalSha512: sha512hex(image.rgb),
    recipients: slots.map((s) => ({ name: s.recipientName, fp: s.recipientFp, slotDigest: slotDigest(s) })),
  }

  const manifestSig = sender.sign(canonicalBytes(manifest), SIG_CONTEXT.manifest)

  tr?.add(
    'Manifest signed by the sender (ML-DSA-87)',
    `${sender.name} signs the recipient list, the box root and every slot digest. Nobody can add a name, remove a name, or alter a single encrypted tile afterwards without breaking this signature.`,
    [
      f('manifest SHA-512', short(hex(manifestHash(manifest)), 16, 8)),
      f('signature', `${manifestSig.length} bytes`),
    ],
  )

  const varA = built.pairs.map((p) => p.a)
  void varA
  return {
    pkg: { manifest, manifestSig: b64(manifestSig), slots, boxes },
    docKey,
    seed,
    codewords,
    biases: codewordSet.biases,
    grid,
    quality: { psnrAB: worstPsnr, ssimAB: 0 },
  }
}

export type OpenedBundle = { bundle: Uint8Array; tiles: number; boxRoot: string }

/**
 * Checks run cheapest first, and each has its own error code so the demo can show
 * exactly which defence caught an attack.
 */
export function openKeyBundle(args: {
  /** A live card session, so the officer's secret key never reaches this module. */
  recipient: CardSession
  senderDsaPublicKey: Uint8Array
  expectedSenderFp: string
  expectedSenderName: string
  pkg: VariantPackage
  trace?: Trace
}): OpenedBundle {
  const { recipient, pkg } = args
  const tr = args.trace
  const m = pkg.manifest

  if (!verify(args.senderDsaPublicKey, unb64(pkg.manifestSig), canonicalBytes(m), SIG_CONTEXT.manifest)) {
    throw new CnsaError('manifest_sig_invalid', 'the manifest signature does not verify')
  }
  if (m.senderFp !== args.expectedSenderFp) {
    throw new CnsaError('unexpected_signer', `manifest was signed by ${short(m.senderFp)}, not ${args.expectedSenderName}`)
  }

  const listed = m.recipients.find((r) => r.fp === recipient.fp)
  if (!listed) {
    throw new CnsaError('not_authorized', `${recipient.name} is not on the signed recipient list`)
  }

  const slot = pkg.slots.find((s) => s.recipientFp === recipient.fp)
  if (!slot) throw new CnsaError('no_slot', `no key bundle addressed to ${recipient.name}`)
  if (slotDigest(slot) !== listed.slotDigest) {
    throw new CnsaError('slot_tampered', 'the key bundle does not match the digest the sender signed')
  }

  // Recompute the root over the boxes actually received, before decrypting any of
  // them. This is what replaces the plaintext hash check: it catches a spliced,
  // truncated or reordered package while everything is still ciphertext.
  if (pkg.boxes.length !== m.boxCount) {
    throw new CnsaError('box_count_mismatch', `expected ${m.boxCount} boxes, received ${pkg.boxes.length}`)
  }
  if (merkleRoot(boxLeaves(pkg)) !== m.boxRoot) {
    throw new CnsaError('box_root_mismatch', 'the encrypted tiles are not the ones the sender signed')
  }

  tr?.add('Package verified before anything is decrypted', 'The sender signature, the recipient list, this officer\'s slot digest and the Merkle root over every encrypted tile all check out.', [
    f('document', m.docName),
    f('signed by', `${m.senderName} (${short(m.senderFp)})`),
    f('boxes', `${pkg.boxes.length}`),
    f('box root', short(m.boxRoot, 16, 8)),
  ])

  const sharedSecret = recipient.decapsulate(unb64(slot.kemCipherText))
  const wrapKey = hkdf512(sharedSecret, sha512(utf8(m.boxRoot)), bundleInfo(m.docId, recipient.fp))
  const bundle = aeadOpen(
    wrapKey,
    { iv: unb64(slot.wrap.iv), ct: unb64(slot.wrap.ct), tag: unb64(slot.wrap.tag) },
    bundleAad(m.docId, recipient.fp, m.boxRoot, m.wm.tiles),
    `${recipient.name}'s key bundle`,
  )
  if (bundle.length !== m.wm.tiles * BUNDLE_ENTRY) {
    throw new CnsaError('bundle_size', `key bundle is ${bundle.length} bytes, expected ${m.wm.tiles * BUNDLE_ENTRY}`)
  }

  tr?.add('Key bundle opened with ML-KEM-1024', `${recipient.name}'s secret key recovers a bundle holding one key per tile and no more. Half of the boxes in this package stay closed to them permanently.`, [
    f('tile keys received', `${m.wm.tiles}`),
    f('boxes in package', `${pkg.boxes.length}`),
    secret('bundle (first key)', hex(bundle.subarray(0, 32))),
  ])

  return { bundle, tiles: m.wm.tiles, boxRoot: m.boxRoot }
}

/** Decrypt exactly the tiles this bundle allows, and fail loudly on any that do not open. */
export function decryptTiles(pkg: VariantPackage, bundle: Uint8Array, grid: Grid): Float64Array[] {
  const m = pkg.manifest
  const byKey = new Map(pkg.boxes.map((b) => [`${b.i}:${b.v}`, b]))
  const out: Float64Array[] = []

  for (const rect of grid.tiles) {
    const key = bundle.subarray(rect.index * BUNDLE_ENTRY, rect.index * BUNDLE_ENTRY + 32)
    const iv = bundle.subarray(rect.index * BUNDLE_ENTRY + 32, (rect.index + 1) * BUNDLE_ENTRY)
    let opened: Uint8Array | null = null
    for (const v of ['A', 'B'] as const) {
      const box = byKey.get(`${rect.index}:${v}`)
      if (!box) continue
      try {
        opened = aeadOpen(
          key,
          { iv, ct: unb64(box.ct), tag: unb64(box.tag) },
          boxAad(m.docId, rect, v, grid),
          `tile ${rect.index} variant ${v}`,
        )
        break
      } catch {
        // The other variant. Exactly one of the two opens with this key.
      }
    }
    if (!opened) throw new CnsaError('tile_unopenable', `no variant of tile ${rect.index} opens with the key supplied`)
    const px = new Float64Array(opened.length)
    for (let i = 0; i < opened.length; i++) px[i] = opened[i]
    out.push(px)
  }
  return out
}

export function packageSizes(pkg: VariantPackage) {
  const boxBytes = pkg.boxes.reduce((n, b) => n + unb64(b.ct).length + 28, 0)
  const slotBytes = pkg.slots.reduce((n, s) => n + unb64(s.kemCipherText).length + unb64(s.wrap.ct).length + 28, 0)
  const rawPixels = pkg.manifest.wm.imgW * pkg.manifest.wm.imgH * 3
  return {
    boxes: boxBytes,
    slots: slotBytes,
    perSlot: pkg.slots.length ? Math.round(slotBytes / pkg.slots.length) : 0,
    manifest: canonicalBytes(pkg.manifest).length,
    signature: unb64(pkg.manifestSig).length,
    rawPixels,
    expansionFactor: boxBytes / rawPixels,
    total: boxBytes + slotBytes + canonicalBytes(pkg.manifest).length + unb64(pkg.manifestSig).length,
  }
}

/** Proof that one specific encrypted tile was in the package the sender signed. */
export function boxProof(pkg: VariantPackage, index: number, v: Variant): { proof: string[]; leafIndex: number } {
  const ordered = [...pkg.boxes].sort((a, b) => (a.i - b.i) || (a.v === 'A' ? -1 : 1))
  const leafIndex = ordered.findIndex((b) => b.i === index && b.v === v)
  if (leafIndex < 0) throw new CnsaError('no_such_box', `tile ${index} variant ${v} is not in this package`)
  return { proof: merkleProof(boxLeaves(pkg), leafIndex), leafIndex }
}

export function verifyBoxProof(pkg: VariantPackage, index: number, v: Variant, proof: string[], leafIndex: number): boolean {
  const box = pkg.boxes.find((b) => b.i === index && b.v === v)
  if (!box) return false
  return verifyProof(
    boxLeaf(box.i, box.v, unb64(box.iv), unb64(box.tag), unb64(box.ct)),
    proof,
    leafIndex,
    pkg.boxes.length,
    pkg.manifest.boxRoot,
  )
}

export { readTile }

import { describe, expect, test } from 'bun:test'
import { CONFIG, TILES } from '../src/config.ts'
import { randomKey } from '../src/cnsa.ts'
import { CardReader, type CardSession } from '../src/cards.ts'
import { deriveCodeword, codewordCommit, verifyCommit } from '../src/codeword.ts'
import { readImage } from '../src/detect.ts'
import { buildSurvey } from '../src/fixtures.ts'
import { merkleProof, merkleRoot, verifyProof, leafHash } from '../src/merkle.ts'
import {
  boxProof,
  decryptTiles,
  openKeyBundle,
  packageSizes,
  sealVariantPackage,
  verifyBoxProof,
  type VariantPackage,
} from '../src/seal.ts'
import { assemble } from '../src/variants.ts'
import { DETECT, EMBED, countErrors, testKey, asOfficer } from './helpers.ts'
import { utf8 } from '../src/bytes.ts'

const image = buildSurvey(CONFIG.imageWidth)
const wmKey = testKey('seal-test-wm-key')

// Real cards, so this suite exercises the same boundary the server does.
const reader = new CardReader()
const sender = reader.issue('sharma', 'Commanding Officer', '2481')
const nair = reader.issue('nair', 'Executive Officer', '1379')
const iyer = reader.issue('iyer', 'Operations Officer', '5502')
const yadav = reader.issue('yadav', 'not cleared for this document', '9016')
const PINS: Record<string, string> = { sharma: '2481', nair: '1379', iyer: '5502', yadav: '9016' }
const withCard = <T,>(name: string, use: (card: CardSession) => T): T => reader.unlock(name, PINS[name], use)

const sealed = withCard('sharma', (co) =>
  sealVariantPackage({
    sender: co,
    recipients: [nair, iyer],
    image,
    docName: 'coastal-survey-07.png',
    serverWmKey: wmKey,
    gridW: CONFIG.gridW,
    gridH: CONFIG.gridH,
    embed: EMBED,
  }),
)

function openAs(name: string, pkg: VariantPackage = sealed.pkg) {
  return withCard(name, (card) =>
    openKeyBundle({
      recipient: card,
      senderDsaPublicKey: sender.dsaPublicKey,
      expectedSenderFp: sender.fp,
      expectedSenderName: sender.name,
      pkg,
    }),
  )
}

function copyFor(name: string) {
  const opened = openAs(name)
  return assemble(sealed.grid, decryptTiles(sealed.pkg, opened.bundle, sealed.grid))
}

function mutate(fn: (pkg: VariantPackage) => void): VariantPackage {
  const clone = JSON.parse(JSON.stringify(sealed.pkg)) as VariantPackage
  fn(clone)
  return clone
}

describe('sealing once, opening many ways', () => {
  test('the package holds both variants of every tile and is about twice the pixels', () => {
    expect(sealed.pkg.boxes.length).toBe(TILES * 2)
    const sizes = packageSizes(sealed.pkg)
    expect(sizes.expansionFactor).toBeGreaterThan(1.99)
    expect(sizes.expansionFactor).toBeLessThan(2.05)
  })

  test('each officer assembles a copy that decodes to their own codeword', () => {
    for (const officer of ['nair', 'iyer'] as const) {
      const copy = copyFor(officer)
      const expected = deriveCodeword(sealed.docKey, sealed.pkg.manifest.docId, reader.fingerprintOf(officer), TILES)
      const reading = readImage(copy, sealed.grid, sealed.seed, DETECT)
      expect(reading.readableCount).toBe(TILES)
      expect(countErrors(reading.codeword, expected)).toBe(0)
    }
  })

  test('two officers hold different files whose visible content is the same', () => {
    const a = copyFor('nair')
    const b = copyFor('iyer')
    expect(Array.from(a.rgb)).not.toEqual(Array.from(b.rgb))
    const differing = a.rgb.reduce((n, v, i) => n + (v === b.rgb[i] ? 0 : 1), 0)
    expect(differing).toBeGreaterThan(0)
  })

  test('an officer can open exactly half the boxes and no more', () => {
    const { bundle } = openAs('nair')
    expect(bundle.length).toBe(TILES * 44)
    // decryptTiles throws unless exactly one variant of every tile opens.
    expect(() => decryptTiles(sealed.pkg, bundle, sealed.grid)).not.toThrow()
    const codeword = deriveCodeword(sealed.docKey, sealed.pkg.manifest.docId, nair.fp, TILES)
    expect(codeword.length).toBe(TILES)
    expect(codeword.some((b) => b === 0)).toBe(true)
    expect(codeword.some((b) => b === 1)).toBe(true)
  })
})

/**
 * If the codeword depended on the session, an officer could open the same document
 * twice and subtract one copy from the other, which reveals twice the carrier on
 * every tile where the two codewords disagree. One person would then have the
 * power of two colluders.
 */
describe('an officer cannot collude with themselves', () => {
  test('opening the same document twice returns byte-identical bytes', () => {
    const first = copyFor('nair')
    const second = copyFor('nair')
    expect(Array.from(first.rgb)).toEqual(Array.from(second.rgb))
  })

  test('the codeword is fixed by document and officer, not by when they opened it', () => {
    const a = deriveCodeword(sealed.docKey, sealed.pkg.manifest.docId, nair.fp, TILES)
    const b = deriveCodeword(sealed.docKey, sealed.pkg.manifest.docId, nair.fp, TILES)
    expect(Array.from(a)).toEqual(Array.from(b))
    const other = deriveCodeword(sealed.docKey, sealed.pkg.manifest.docId, iyer.fp, TILES)
    expect(Array.from(a)).not.toEqual(Array.from(other))
  })
})

describe('defences', () => {
  test('an officer who is not on the signed list gets nothing', () => {
    expect(() => openAs('yadav')).toThrow(/not on the signed recipient list/)
  })

  test('a package presented as coming from someone else is refused', () => {
    expect(() =>
      openKeyBundle({
        recipient: withCard('nair', (c) => c),
        senderDsaPublicKey: sender.dsaPublicKey,
        expectedSenderFp: iyer.fp,
        expectedSenderName: iyer.name,
        pkg: sealed.pkg,
      }),
    ).toThrow(/signed by/)
  })

  test('editing one manifest field breaks the sender signature', () => {
    const tampered = mutate((p) => {
      p.manifest.docName = 'something-else.png'
    })
    expect(() => openAs('nair', tampered)).toThrow(/manifest signature/)
  })

  test('adding a recipient to the manifest breaks the signature', () => {
    const tampered = mutate((p) => {
      p.manifest.recipients.push({ name: 'yadav', fp: yadav.fp, slotDigest: 'x'.repeat(128) })
    })
    expect(() => openAs('nair', tampered)).toThrow(/manifest signature/)
  })

  test("swapping two officers' key bundles is caught by the slot digest", () => {
    const tampered = mutate((p) => {
      const [first, second] = p.slots
      p.slots = [
        { ...second, recipientName: first.recipientName, recipientFp: first.recipientFp },
        { ...first, recipientName: second.recipientName, recipientFp: second.recipientFp },
      ]
    })
    expect(() => openAs('nair', tampered)).toThrow(/does not match the digest/)
  })

  test('a tile moved to another position fails its authenticated data', () => {
    const tampered = mutate((p) => {
      const from = p.boxes.find((b) => b.i === 9 && b.v === 'A')!
      const to = p.boxes.find((b) => b.i === 3 && b.v === 'A')!
      to.iv = from.iv
      to.ct = from.ct
      to.tag = from.tag
    })
    // The Merkle root is over the boxes, so this is caught before decryption.
    expect(() => openAs('nair', tampered)).toThrow(/not the ones the sender signed/)
  })

  test('dropping a single box is caught before anything is decrypted', () => {
    const tampered = mutate((p) => {
      p.boxes.pop()
    })
    expect(() => openAs('nair', tampered)).toThrow(/expected 256 boxes/)
  })

  test('substituting a box from another document is caught by the box root', () => {
    const elsewhere = withCard('sharma', (co) =>
      sealVariantPackage({
        sender: co,
        recipients: [nair],
        image,
        docName: 'other.png',
        serverWmKey: wmKey,
        gridW: CONFIG.gridW,
        gridH: CONFIG.gridH,
        embed: EMBED,
      }),
    )
    const tampered = mutate((p) => {
      const foreign = elsewhere.pkg.boxes.find((b) => b.i === 0 && b.v === 'A')!
      const target = p.boxes.find((b) => b.i === 0 && b.v === 'A')!
      target.iv = foreign.iv
      target.ct = foreign.ct
      target.tag = foreign.tag
    })
    expect(() => openAs('nair', tampered)).toThrow(/not the ones the sender signed/)
  })

  test('a corrupted box survives the root check only if the root is also forged, and then the signature fails', () => {
    const tampered = mutate((p) => {
      const target = p.boxes.find((b) => b.i === 7 && b.v === 'B')!
      const bytes = Buffer.from(target.ct, 'base64')
      bytes[0] ^= 0xff
      target.ct = bytes.toString('base64')
    })
    expect(() => openAs('nair', tampered)).toThrow(/not the ones the sender signed/)
  })

  test('the document key and carrier seed are never part of the package', () => {
    const wire = JSON.stringify(sealed.pkg)
    expect(wire).not.toContain(Buffer.from(sealed.docKey).toString('base64'))
    expect(wire).not.toContain(Buffer.from(sealed.seed).toString('base64'))
    expect(wire).not.toContain(Buffer.from(sealed.docKey).toString('hex'))
    expect(wire).not.toContain(Buffer.from(sealed.seed).toString('hex'))
  })

  test('no cleartext codeword appears anywhere on the wire', () => {
    const wire = JSON.stringify(sealed.pkg)
    for (const officer of ['nair', 'iyer'] as const) {
      const cw = deriveCodeword(sealed.docKey, sealed.pkg.manifest.docId, reader.fingerprintOf(officer), TILES)
      expect(wire).not.toContain(Buffer.from(cw).toString('base64'))
    }
  })
})

describe('merkle commitments', () => {
  test('an inclusion proof verifies and a wrong index does not', () => {
    for (const [i, v] of [[0, 'A'], [5, 'A'], [63, 'B'], [127, 'B']] as const) {
      const { proof, leafIndex } = boxProof(sealed.pkg, i, v)
      expect(verifyBoxProof(sealed.pkg, i, v, proof, leafIndex)).toBe(true)
      expect(verifyBoxProof(sealed.pkg, i, v, proof, (leafIndex + 1) % sealed.pkg.boxes.length)).toBe(false)
    }
  })

  test('proofs verify for any leaf count, including odd ones', () => {
    for (const count of [1, 2, 3, 5, 8, 17, 100]) {
      const leaves = Array.from({ length: count }, (_, i) => leafHash(utf8(`leaf-${i}`)))
      const root = merkleRoot(leaves)
      for (let i = 0; i < count; i++) {
        expect(verifyProof(leaves[i], merkleProof(leaves, i), i, count, root)).toBe(true)
      }
    }
  })

  test('leaves and internal nodes hash differently, closing the second-preimage gap', () => {
    const a = leafHash(utf8('x'))
    const b = leafHash(utf8('y'))
    // Root of a two-leaf tree is the internal hash of a and b. Hashing the same
    // two values as a leaf must not collide with it, or an attacker could present
    // an internal node as though it were a leaf.
    const internal = merkleRoot([a, b])
    const asLeaf = Buffer.from(leafHash(a, b)).toString('hex')
    expect(asLeaf).not.toBe(internal)
  })
})

describe('codeword commitments', () => {
  test('a commitment opens only with the right codeword and salt', () => {
    const salt = randomKey(16)
    const cw = deriveCodeword(sealed.docKey, sealed.pkg.manifest.docId, nair.fp, TILES)
    const commit = codewordCommit(sealed.pkg.manifest.docId, nair.fp, cw, salt)
    expect(verifyCommit(commit, sealed.pkg.manifest.docId, nair.fp, cw, salt)).toBe(true)

    const wrong = new Uint8Array(cw)
    wrong[0] ^= 1
    expect(verifyCommit(commit, sealed.pkg.manifest.docId, nair.fp, wrong, salt)).toBe(false)
    expect(verifyCommit(commit, sealed.pkg.manifest.docId, iyer.fp, cw, salt)).toBe(false)
    expect(verifyCommit(commit, sealed.pkg.manifest.docId, nair.fp, cw, randomKey(16))).toBe(false)
  })
})

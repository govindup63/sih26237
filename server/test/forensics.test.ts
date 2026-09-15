import { beforeAll, describe, expect, test } from 'bun:test'
import { CONFIG } from '../src/config.ts'
import { publicOf } from '../src/cnsa.ts'
import {
  addNoise,
  attackSuite,
  boxBlurImage,
  collude,
  colludeByTile,
  cropPad,
  jpegLike,
  posterize,
  resizeRoundTrip,
} from '../src/attacks.ts'
import { decide, traceLeak, type Verdict } from '../src/forensics.ts'
import { buildChart, buildSurvey } from '../src/fixtures.ts'
import { openAndAssemble } from '../src/pipeline.ts'
import type { Bitmap } from '../src/png.ts'
import { sealVariantPackage } from '../src/seal.ts'
import { createWorld, officerMeta, publicOfficer, senderIdentity, type World } from '../src/world.ts'
import { DETECT, EMBED, asOfficer } from './helpers.ts'

const CLEARED = ['nair', 'iyer', 'varma', 'menon']

let world: World
let copies: Map<string, Bitmap>
let original: Bitmap

beforeAll(() => {
  world = createWorld()
  const doc = world.docs[0]
  original = doc.build(CONFIG.imageWidth)
  const sealed = asOfficer(world, 'sharma', (co) =>
    sealVariantPackage({
      sender: co,
      recipients: CLEARED.map((n) => publicOfficer(world, n)),
      image: original,
      docName: doc.name,
      serverWmKey: world.serverWmKey,
      gridW: CONFIG.gridW,
      gridH: CONFIG.gridH,
      embed: EMBED,
    }),
  )
  world.keystore.set(sealed.pkg.manifest.docId, {
    docId: sealed.pkg.manifest.docId,
    docName: doc.name,
    docKey: sealed.docKey,
    seed: sealed.seed,
    grid: sealed.grid,
    codewords: sealed.codewords,
    commitSalts: new Map(),
  })

  copies = new Map()
  for (const name of CLEARED) {
    const result = asOfficer(world, name, (card) =>
      openAndAssemble({
        recipient: card,
        sender: senderIdentity(world),
        pkg: sealed.pkg,
        ledger: world.ledger,
        keystore: world.keystore,
        terminal: officerMeta(name).homeTerminal,
      }),
    )
    copies.set(name, result.copy.image)
  }
})

function trace(leaked: Bitmap): Verdict {
  return traceLeak({ leaked, ledger: world.ledger, keystore: world.keystore, detect: DETECT }).verdict
}

function namesIn(v: Verdict): string[] {
  if (v.kind === 'ATTRIBUTED') return [v.candidate.recipientName]
  if (v.kind === 'COLLUSION_SET') return v.members.map((m) => m.recipientName)
  return []
}

describe('attributing a leak', () => {
  test('a clean leak names the officer who assembled it', () => {
    for (const name of CLEARED) {
      const v = trace(copies.get(name)!)
      expect(v.kind).toBe('ATTRIBUTED')
      expect(namesIn(v)).toEqual([name])
    }
  })

  for (const attack of attackSuite()) {
    if (attack.beyondLimit || attack.expectGeometryMismatch) continue
    test(`survives ${attack.name} and still names iyer`, () => {
      const v = trace(attack.apply(copies.get('iyer')!))
      expect(v.kind).toBe('ATTRIBUTED')
      expect(namesIn(v)).toEqual(['iyer'])
    })
  }

  test('the proof bundle carries the evidence, not just the name', () => {
    const proof = traceLeak({ leaked: copies.get('varma')!, ledger: world.ledger, keystore: world.keystore, detect: DETECT })
    expect(proof.verdict.kind).toBe('ATTRIBUTED')
    expect(proof.reading!.readableCount).toBeGreaterThanOrEqual(CONFIG.minReadable)
    expect(proof.checks.every((c) => c.ok)).toBe(true)
    expect(proof.checks.map((c) => c.label)).toEqual(
      expect.arrayContaining([
        'the mark responds to this document and no other',
        'the codeword matches the commitment this officer signed',
        'the issuance record is in the log, provably',
        'a quorum of attesters signed the block holding it',
        'the ledger itself is intact',
      ]),
    )
  })
})

/**
 * A confident wrong name is the only unacceptable outcome. Every test here asserts
 * that the system stays silent rather than guessing.
 */
describe('staying silent', () => {
  const silent: [string, () => Bitmap][] = [
    ['the unmarked original', () => original],
    ['a document that was never sealed', () => buildChart(CONFIG.imageWidth)],
    ['a noisy version of something never sealed', () => addNoise(buildChart(CONFIG.imageWidth), 6, 4)],
    ['pure noise', () => {
      const img: Bitmap = { width: 512, height: 512, rgb: new Uint8Array(512 * 512 * 3) }
      let s = 987654321
      for (let i = 0; i < img.rgb.length; i++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff
        img.rgb[i] = s & 255
      }
      return img
    }],
    ['a flat grey field', () => ({ width: 512, height: 512, rgb: new Uint8Array(512 * 512 * 3).fill(128) })],
    ['a different survey with a different seed', () => buildSurvey(CONFIG.imageWidth)],
  ]

  for (const [label, make] of silent) {
    test(`${label} is never attributed to anybody`, () => {
      const v = trace(make())
      expect(namesIn(v)).toEqual([])
      expect(['NO_WATERMARK', 'INCONCLUSIVE', 'GEOMETRY_MISMATCH']).toContain(v.kind)
    })
  }

  test('compression past the limit gives silence, not a name', () => {
    const v = trace(jpegLike(copies.get('nair')!, 40))
    expect(namesIn(v)).toEqual([])
  })

  test('a cropped leak is refused or falls below the floor, never named', () => {
    for (const px of [4, 8, 16, 32]) {
      const v = trace(cropPad(copies.get('nair')!, px))
      expect(namesIn(v)).toEqual([])
    }
  })

  test('1,000 random unmarked images produce zero attributions', () => {
    let attributed = 0
    let s = 20260914
    const next = () => {
      s ^= s << 13
      s >>>= 0
      s ^= s >> 17
      s ^= s << 5
      s >>>= 0
      return s
    }
    // Full size and full entropy: upsampling a small noise image would smooth it,
    // which makes it easier to reject, not harder.
    for (let trial = 0; trial < 1000; trial++) {
      const img: Bitmap = { width: 512, height: 512, rgb: new Uint8Array(512 * 512 * 3) }
      for (let i = 0; i < img.rgb.length; i++) img.rgb[i] = next() & 255
      const v = trace(img)
      if (namesIn(v).length > 0) attributed++
    }
    expect(attributed).toBe(0)
  }, 120_000)
})

/**
 * Found by clicking through the demo, not by a test: an innocent officer's error
 * rate is a binomial draw around 50%, and one of them landing near 35% is common
 * enough to see on a first run. The rule used to require the runner-up to clear an
 * absolute bar, so when that happened it refused to name the officer sitting at
 * zero. The gap between first and second is what carries the evidence.
 */
describe('an unlucky runner-up does not silence a certain match', () => {
  test('names the owner even when an innocent officer drifts close', () => {
    const tiles = 128
    const mask = new Uint8Array(tiles).fill(1)
    const owner = new Uint8Array(tiles)
    for (let i = 0; i < tiles; i++) owner[i] = i % 2
    const reading = {
      tiles: Array.from({ length: tiles }, (_, index) => ({ index, rho: 0.5, z: 9, bit: owner[index] as 0 | 1, readable: true })),
      codeword: owner,
      mask,
      readableCount: tiles,
      meanAbsZ: 9,
    }
    // An innocent officer who happens to disagree on only 34% of tiles.
    const unlucky = new Uint8Array(owner)
    for (let i = 0; i < Math.round(tiles * 0.34); i++) unlucky[i] ^= 1
    // Differs from the owner on exactly half the tiles, which is where an
    // unrelated officer sits.
    const far = new Uint8Array(owner)
    for (let i = 0; i < tiles; i += 2) far[i] ^= 1

    const verdict = decide(reading, [
      { name: 'iyer', fp: 'fp-carol', codeword: owner },
      { name: 'menon', fp: 'fp-frank', codeword: unlucky },
      { name: 'nair', fp: 'fp-bob', codeword: far },
    ])
    expect(verdict.kind).toBe('ATTRIBUTED')
    if (verdict.kind === 'ATTRIBUTED') expect(verdict.candidate.recipientName).toBe('iyer')
  })

  test('two officers both at zero are still read as a set, not as one name', () => {
    const tiles = 128
    const mask = new Uint8Array(tiles).fill(1)
    const shared = new Uint8Array(tiles)
    for (let i = 0; i < tiles; i++) shared[i] = i % 2
    const reading = {
      tiles: Array.from({ length: tiles }, (_, index) => ({ index, rho: 0.5, z: 9, bit: shared[index] as 0 | 1, readable: true })),
      codeword: shared,
      mask,
      readableCount: tiles,
      meanAbsZ: 9,
    }
    const far = new Uint8Array(shared)
    for (let i = 0; i < tiles; i += 2) far[i] ^= 1
    const verdict = decide(reading, [
      { name: 'nair', fp: 'fp-bob', codeword: shared },
      { name: 'varma', fp: 'fp-dave', codeword: shared },
      { name: 'iyer', fp: 'fp-carol', codeword: far },
    ])
    expect(verdict.kind).toBe('COLLUSION_SET')
    if (verdict.kind === 'COLLUSION_SET') {
      expect(verdict.members.map((m) => m.recipientName).sort()).toEqual(['nair', 'varma'])
    }
  })
})

describe('collusion', () => {
  test('averaging two copies names both colluders and nobody else', () => {
    const v = trace(collude([copies.get('nair')!, copies.get('varma')!], 'average'))
    expect(v.kind).toBe('COLLUSION_SET')
    expect(namesIn(v).sort()).toEqual(['nair', 'varma'])
  })

  /**
   * Codewords are drawn from a random document key, so whether a tile swap is
   * cleanly separable varies run to run. The measured rate is around 97% at 128
   * tiles. What must hold every single time is the other half: nobody outside the
   * pair is ever named.
   */
  test('swapping whole tiles names the pair, or nobody, but never an innocent', () => {
    const grid = world.keystore.get([...world.keystore.keys()][0])!.grid
    let named = 0
    for (const seed of [3, 7, 11, 19, 23]) {
      const v = trace(colludeByTile([copies.get('iyer')!, copies.get('menon')!], grid, seed))
      for (const name of namesIn(v)) expect(['iyer', 'menon']).toContain(name)
      if (v.kind === 'COLLUSION_SET') {
        expect(namesIn(v).sort()).toEqual(['iyer', 'menon'])
        named++
      }
    }
    // Over five swaps it should land the pair at least once.
    expect(named).toBeGreaterThan(0)
  })

  /**
   * The result that decides whether any of this can be trusted. Across every pair,
   * every strategy and many seeds, an officer who was not in the room must never
   * appear in a verdict.
   */
  test('no innocent officer is ever named, across every pair and strategy', () => {
    const grid = world.keystore.get([...world.keystore.keys()][0])!.grid
    let checked = 0
    for (let i = 0; i < CLEARED.length; i++) {
      for (let j = i + 1; j < CLEARED.length; j++) {
        const pair = [CLEARED[i], CLEARED[j]]
        const inputs = [copies.get(pair[0])!, copies.get(pair[1])!]
        for (const seed of [3, 11, 29]) {
          const attacks: Bitmap[] = [
            collude(inputs, 'average', seed),
            collude(inputs, 'median', seed),
            colludeByTile(inputs, grid, seed),
            jpegLike(colludeByTile(inputs, grid, seed), 85),
          ]
          for (const leaked of attacks) {
            const named = namesIn(trace(leaked))
            for (const name of named) expect(pair).toContain(name)
            checked++
          }
        }
      }
    }
    expect(checked).toBe(72)
  }, 300_000)

  test('three colluders leave too little to read, and the answer is silence', () => {
    const v = trace(collude([copies.get('nair')!, copies.get('iyer')!, copies.get('varma')!], 'average'))
    // Averaging three copies erases every tile where any two disagree, which is
    // most of them. Refusing to answer is the correct result, not a failure.
    expect(['NO_WATERMARK', 'INCONCLUSIVE']).toContain(v.kind)
    expect(namesIn(v).every((n) => ['nair', 'iyer', 'varma'].includes(n))).toBe(true)
  })
})

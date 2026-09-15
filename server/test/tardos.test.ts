import { describe, expect, test } from 'bun:test'
import { sha512, utf8 } from '../src/bytes.ts'
import {
  DEFAULT_TARDOS,
  tardosAccuse,
  tardosBiases,
  tardosCodeword,
  tardosScore,
} from '../src/tardos.ts'

const TILES = 128
const key = (label: string) => sha512(utf8(label)).subarray(0, 32)

function world(seed: string, officers = 12, tiles = TILES) {
  const docKey = key(seed)
  const docId = `doc-${seed}`
  const biases = tardosBiases(docKey, docId, tiles, DEFAULT_TARDOS.cutoff)
  const issued = Array.from({ length: officers }, (_, i) => {
    const fp = `officer-${i}`
    return { name: fp, fp, codeword: tardosCodeword(docKey, docId, fp, biases) }
  })
  return { docKey, docId, biases, issued }
}

/**
 * The three ways a set of officers can combine their copies. `erase` is what
 * averaging really does here: the carrier cancels and the tile stops being
 * readable. `splice` is the textbook marking assumption, reachable in this system
 * by cutting tiles out of one copy and pasting them into another.
 */
function combine(
  guilty: { codeword: Uint8Array }[],
  biases: Float64Array,
  how: 'erase' | 'majority' | 'splice',
) {
  const tiles = biases.length
  const recovered = new Uint8Array(tiles)
  const mask = new Uint8Array(tiles)
  for (let i = 0; i < tiles; i++) {
    const bits = guilty.map((g) => g.codeword[i])
    if (bits.every((b) => b === bits[0])) {
      recovered[i] = bits[0]
      mask[i] = 1
      continue
    }
    if (how === 'erase') continue
    if (how === 'majority') {
      recovered[i] = bits.filter((b) => b === 1).length * 2 > bits.length ? 1 : 0
    } else {
      recovered[i] = biases[i] > 0.5 ? 1 : 0
    }
    mask[i] = 1
  }
  return { recovered, mask }
}

describe('tardos biases', () => {
  test('are deterministic in the document key and the document', () => {
    const a = tardosBiases(key('k'), 'doc-1', TILES, DEFAULT_TARDOS.cutoff)
    const b = tardosBiases(key('k'), 'doc-1', TILES, DEFAULT_TARDOS.cutoff)
    expect([...a]).toEqual([...b])

    const other = tardosBiases(key('k'), 'doc-2', TILES, DEFAULT_TARDOS.cutoff)
    expect([...other]).not.toEqual([...a])
  })

  test('stay inside the truncated support, which is what bounds a single tile', () => {
    const biases = tardosBiases(key('k'), 'doc', 4096, DEFAULT_TARDOS.cutoff)
    for (const p of biases) {
      expect(p).toBeGreaterThanOrEqual(DEFAULT_TARDOS.cutoff - 1e-9)
      expect(p).toBeLessThanOrEqual(1 - DEFAULT_TARDOS.cutoff + 1e-9)
    }
  })

  test('are spread across the support rather than piled at one value', () => {
    const biases = tardosBiases(key('k'), 'doc', 4096, DEFAULT_TARDOS.cutoff)
    const low = [...biases].filter((p) => p < 0.5).length
    expect(low).toBeGreaterThan(1500)
    expect(low).toBeLessThan(2600)
  })
})

describe('tardos codewords', () => {
  test('are a pure function of the officer, so a second open changes nothing', () => {
    const { docKey, docId, biases } = world('stable')
    const once = tardosCodeword(docKey, docId, 'nair', biases)
    const twice = tardosCodeword(docKey, docId, 'nair', biases)
    expect([...once]).toEqual([...twice])
  })

  test('differ between officers', () => {
    const { docKey, docId, biases } = world('differ')
    const a = tardosCodeword(docKey, docId, 'nair', biases)
    const b = tardosCodeword(docKey, docId, 'iyer', biases)
    let differing = 0
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++
    expect(differing).toBeGreaterThan(10)
  })

  test('follow the bias they were drawn against', () => {
    // Over many officers, the share holding a 1 at tile i tracks p_i.
    const { docKey, docId, biases } = world('bias', 0)
    const officers = Array.from({ length: 400 }, (_, i) => tardosCodeword(docKey, docId, `o-${i}`, biases))
    let worst = 0
    for (let i = 0; i < biases.length; i++) {
      const ones = officers.filter((c) => c[i] === 1).length / officers.length
      worst = Math.max(worst, Math.abs(ones - biases[i]))
    }
    expect(worst).toBeLessThan(0.12)
  })
})

describe('tardos accusation', () => {
  test('names the single officer who opened a copy', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const { biases, issued } = world(seed)
      const mask = new Uint8Array(biases.length).fill(1)
      const accused = tardosAccuse(issued[3].codeword, mask, issued, biases).filter((c) => c.accused)
      expect(accused.map((a) => a.fp)).toEqual(['officer-3'])
    }
  })

  test('names at least one of two colluders who averaged their copies', () => {
    let caught = 0
    for (let s = 0; s < 40; s++) {
      const { biases, issued } = world(`avg-${s}`)
      const guilty = [issued[0], issued[1]]
      const { recovered, mask } = combine(guilty, biases, 'erase')
      const accused = tardosAccuse(recovered, mask, issued, biases).filter((c) => c.accused)
      if (accused.some((a) => a.fp === 'officer-0' || a.fp === 'officer-1')) caught++
    }
    expect(caught).toBe(40)
  })

  /**
   * The property that has to hold whatever else does. A wrong name is the only
   * outcome this system cannot recover from, so it is asserted across every
   * combination strategy and every size of colluding set, including the ones
   * where the scheme is measured to go silent.
   */
  test('never names an innocent officer, under any attack', () => {
    for (const how of ['erase', 'majority', 'splice'] as const) {
      for (const size of [1, 2, 3, 4]) {
        for (let s = 0; s < 25; s++) {
          const { biases, issued } = world(`${how}-${size}-${s}`)
          const guilty = issued.slice(0, size)
          const guiltyFps = new Set(guilty.map((g) => g.fp))
          const { recovered, mask } = combine(guilty, biases, how)
          const accused = tardosAccuse(recovered, mask, issued, biases).filter((c) => c.accused)
          const framed = accused.filter((a) => !guiltyFps.has(a.fp))
          expect(framed.map((f) => `${how}/${size}/${s}: ${f.fp}`)).toEqual([])
        }
      }
    }
  })

  test('stays silent on an image that carries no mark at all', () => {
    const { biases, issued } = world('silent')
    const mask = new Uint8Array(biases.length).fill(1)
    // A codeword nobody was issued: an unrelated officer's word from another document.
    const stranger = tardosCodeword(key('elsewhere'), 'other-doc', 'nobody', biases)
    const accused = tardosAccuse(stranger, mask, issued, biases).filter((c) => c.accused)
    expect(accused).toEqual([])
  })

  test('drops erased tiles from the score rather than counting them against the owner', () => {
    const { biases, issued } = world('erasure')
    const full = new Uint8Array(biases.length).fill(1)
    const half = new Uint8Array(biases.length)
    for (let i = 0; i < biases.length; i += 2) half[i] = 1

    const whole = tardosScore(issued[0].codeword, full, issued[0].codeword, biases)
    const damaged = tardosScore(issued[0].codeword, half, issued[0].codeword, biases)

    expect(whole.counted).toBe(biases.length)
    expect(damaged.counted).toBe(biases.length / 2)
    // Normalisation by sqrt(counted) keeps the two scores on the same scale, so a
    // half-destroyed exhibit is not compared against a threshold set for an intact one.
    expect(Math.abs(damaged.score - whole.score) / whole.score).toBeLessThan(0.35)
  })

  test('scores an officer who did not contribute below the threshold', () => {
    const { biases, issued } = world('negative')
    const mask = new Uint8Array(biases.length).fill(1)
    const scored = tardosAccuse(issued[0].codeword, mask, issued, biases)
    const innocent = scored.filter((s) => s.fp !== 'officer-0')
    for (const row of innocent) expect(row.score).toBeLessThan(DEFAULT_TARDOS.threshold)
  })
})

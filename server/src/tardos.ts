import { be32, lenPrefixed, sha512, utf8 } from './bytes.ts'
import type { Codeword } from './codeword.ts'

/**
 * Tardos collusion-secure fingerprinting.
 *
 * The plain codeword in `codeword.ts` is an unbiased coin per tile. It works, and
 * the two-tier rule reads a colluding set off it, but it carries no guarantee: the
 * probability that it names an innocent officer is a property of the threshold
 * somebody picked rather than something the construction bounds.
 *
 * Tardos fixes the bias per tile instead, drawing it from an arcsine distribution
 * that is deliberately lopsided, so a tile is usually strongly biased towards one
 * value. Colluders comparing copies then agree on most tiles and cannot touch
 * them, and the few they can touch are exactly the ones the accusation score
 * weights most heavily. That is what buys a bound that does not depend on how many
 * of them there are.
 *
 * Two things here are not textbook, both forced by this system:
 *
 * The biases and the codewords are derived, not sampled. A codeword that varied
 * per session would let one officer open twice and difference the two copies,
 * which is the power of two colluders for free. So every random quantity comes out
 * of the document key by hashing, and an officer's codeword is a pure function of
 * who they are. The distribution is identical; only the source of entropy changes.
 *
 * The score runs over readable tiles only. Averaging two copies does not produce a
 * bit of the attacker's choosing here, it destroys the carrier and the tile stops
 * being readable at all. Scoring an erased tile would punish the true owner for
 * damage the leaker did, so erasures are dropped from the sum and from the
 * normalisation with them.
 */
export type TardosParams = {
  /**
   * Arcsine truncation. Keeps biases away from 0 and 1, which bounds the score a
   * single tile can contribute. Classically 1/(300c); at the code lengths in this
   * system a much larger cutoff does better, which `scripts/tardossweep.ts`
   * measures rather than assumes.
   */
  cutoff: number
  /** Accuse above this score. Also measured, not assumed. */
  threshold: number
}

/*
 * Measured, not chosen. `scripts/tardossweep.ts --focused`, 128 tiles, 12
 * officers, 2000 trials per cell, three attack models:
 *
 *   colluders   averaging    majority vote   tile splicing
 *   1           100%         100%            100%
 *   2           100%          98%             93%
 *   3            92%         100%              2%
 *
 * with zero innocent officers accused in any of the 18,000 trials. The failure
 * at three spliced copies is a silence, not a wrong name, which is the failure
 * this system is willing to have.
 */
export const DEFAULT_TARDOS: TardosParams = { cutoff: 0.45, threshold: 5 }

/** A uniform in [0,1) from eight bytes of hash, so biases are reproducible. */
function uniformFrom(bytes: Uint8Array, at: number): number {
  let value = 0
  for (let i = 0; i < 6; i++) value = value * 256 + bytes[at + i]
  return value / 2 ** 48
}

/**
 * Per-tile biases for one document. Shared by every recipient, which is what makes
 * the score comparable across them, and derived from the document key so nobody
 * outside the forensic service can predict which tiles carry the weight.
 */
export function tardosBiases(docKey: Uint8Array, docId: string, tiles: number, cutoff: number): Float64Array {
  const out = new Float64Array(tiles)
  // p = sin^2(r) with r uniform on the arcsine support, truncated at both ends.
  const lo = Math.asin(Math.sqrt(cutoff))
  const hi = Math.PI / 2 - lo
  let filled = 0
  let counter = 0
  while (filled < tiles) {
    const block = sha512(docKey, utf8('cnsa2/tardos-bias/v1'), lenPrefixed(docId), be32(counter))
    for (let at = 0; at + 6 <= block.length && filled < tiles; at += 6) {
      const r = lo + uniformFrom(block, at) * (hi - lo)
      out[filled++] = Math.sin(r) ** 2
    }
    counter++
  }
  return out
}

/**
 * One officer's codeword: tile i is 1 with probability `biases[i]`, decided by
 * hashing rather than sampling so the same officer always gets the same word.
 */
export function tardosCodeword(
  docKey: Uint8Array,
  docId: string,
  recipientFp: string,
  biases: Float64Array,
): Codeword {
  const out = new Uint8Array(biases.length)
  let filled = 0
  let counter = 0
  while (filled < biases.length) {
    const block = sha512(
      docKey,
      utf8('cnsa2/tardos-word/v1'),
      lenPrefixed(docId),
      lenPrefixed(recipientFp),
      be32(counter),
    )
    for (let at = 0; at + 6 <= block.length && filled < biases.length; at += 6) {
      out[filled] = uniformFrom(block, at) < biases[filled] ? 1 : 0
      filled++
    }
    counter++
  }
  return out
}

/**
 * The symmetric accusation score (Skoric, Katzenbeisser and Celik).
 *
 * A tile where the officer holds the rare value and the leak shows it too counts
 * heavily against them, because a colluder had to have contributed it. A tile
 * where they hold the rare value and the leak does not show it counts in their
 * favour just as heavily. The asymmetric original scores only the first case and
 * needs a longer code for the same confidence.
 *
 * Normalised by the square root of the number of tiles actually scored, so a leak
 * that destroyed half the image is not compared against a threshold calibrated for
 * an intact one.
 */
export function tardosScore(
  recovered: Codeword,
  mask: Uint8Array,
  codeword: Codeword,
  biases: Float64Array,
): { score: number; counted: number } {
  let sum = 0
  let counted = 0
  for (let i = 0; i < biases.length; i++) {
    if (!mask[i]) continue
    const p = biases[i]
    const rare = Math.sqrt((1 - p) / p)
    const common = Math.sqrt(p / (1 - p))
    const y = recovered[i]
    const x = codeword[i]
    if (y === 1) sum += x === 1 ? rare : -common
    else sum += x === 1 ? -rare : common
    counted++
  }
  if (counted === 0) return { score: 0, counted: 0 }
  return { score: sum / Math.sqrt(counted), counted }
}

export type TardosCandidate = {
  name: string
  fp: string
  score: number
  counted: number
  accused: boolean
}

/**
 * Score every issued copy and accuse the ones above the threshold. Tardos names a
 * set directly: it does not rank and take the top one, which is what lets it stay
 * silent when the evidence supports nobody.
 */
export function tardosAccuse(
  recovered: Codeword,
  mask: Uint8Array,
  issued: { name: string; fp: string; codeword: Codeword }[],
  biases: Float64Array,
  params: TardosParams = DEFAULT_TARDOS,
): TardosCandidate[] {
  return issued
    .map((r) => {
      const { score, counted } = tardosScore(recovered, mask, r.codeword, biases)
      return { name: r.name, fp: r.fp, score, counted, accused: score > params.threshold }
    })
    .sort((a, b) => b.score - a.score)
}

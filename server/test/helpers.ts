import { CONFIG } from '../src/config.ts'
import type { CardSession } from '../src/cards.ts'
import { officerMeta } from '../src/world.ts'
import { sha512, utf8 } from '../src/bytes.ts'
import type { DetectParams } from '../src/detect.ts'
import type { EmbedParams } from '../src/variants.ts'

export const SPEC = { bandLo: CONFIG.bandLo, bandHi: CONFIG.bandHi }

export const EMBED: EmbedParams = {
  alpha: CONFIG.alpha,
  base: CONFIG.alphaBase,
  slope: CONFIG.alphaSlope,
  floorMul: CONFIG.alphaFloorMul,
  capMul: CONFIG.alphaCapMul,
  activityRef: CONFIG.activityRef,
  activityWindow: CONFIG.activityWindow,
  spec: SPEC,
}

export const DETECT: DetectParams = {
  spec: SPEC,
  decoyCount: CONFIG.decoyCount,
  zThreshold: CONFIG.zThreshold,
  residualWindow: CONFIG.residualWindow,
}

/** Fixed so a failing test reproduces exactly rather than sometimes. */
export function testKey(label = 'sih26237-test-key'): Uint8Array {
  return sha512(utf8(label)).subarray(0, 32)
}

export function fixedCodeword(tiles: number, salt = 0): Uint8Array {
  const cw = new Uint8Array(tiles)
  for (let i = 0; i < tiles; i++) cw[i] = ((i * 7 + 3 + salt) % 11) < 5 ? 1 : 0
  return cw
}

export function countErrors(recovered: Uint8Array, expected: Uint8Array, mask?: Uint8Array): number {
  let errors = 0
  for (let i = 0; i < expected.length; i++) {
    if (mask && !mask[i]) continue
    if (recovered[i] !== expected[i]) errors++
  }
  return errors
}

/**
 * Run something with an officer's card unlocked. Tests go through the card
 * boundary for the same reason the server does: nothing outside `cards.ts` can
 * reach a secret key, so there is no shortcut to bypass in a test either.
 */
export function asOfficer<T>(
  world: { cards: { unlock<R>(name: string, pin: string, use: (card: CardSession) => R): R } },
  name: string,
  use: (card: CardSession) => T,
): T {
  return world.cards.unlock(name, officerMeta(name).pin, use)
}

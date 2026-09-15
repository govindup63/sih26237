import { be32, hex, lenPrefixed, sha512, utf8 } from './bytes.ts'

/** One byte per tile, 0 selects variant A and 1 selects variant B. */
export type Codeword = Uint8Array

/**
 * The codeword is a deterministic function of the document key, the document and
 * the officer. It deliberately does NOT depend on the session.
 *
 * If it did, an officer who opened the same document twice would receive two
 * different copies. Subtracting one from the other reveals twice the carrier on
 * every tile where the two codewords disagree, which is about half of them, and
 * averaging the two erases the mark there. One person would have the power of two
 * colluders. Making the codeword stable means a second open returns byte-identical
 * bytes and yields nothing.
 */
export function deriveCodeword(docKey: Uint8Array, docId: string, recipientFp: string, tiles: number): Codeword {
  const out = new Uint8Array(tiles)
  let filled = 0
  let counter = 0
  while (filled < tiles) {
    const block = sha512(
      docKey,
      utf8('cnsa2/codeword/v1'),
      lenPrefixed(docId),
      lenPrefixed(recipientFp),
      be32(counter),
    )
    for (let i = 0; i < block.length && filled < tiles; i++) {
      for (let bit = 0; bit < 8 && filled < tiles; bit++) {
        out[filled++] = (block[i] >> bit) & 1
      }
    }
    counter++
  }
  return out
}

/**
 * What the ledger stores. The cleartext codeword never goes in.
 *
 * A codeword in the ledger is a map from officer to mark. Colluders who can read
 * it can aim: three officers who know a fourth's codeword can set every tile where
 * they disagree to his bit and erase the tiles where they agree, which frames him
 * almost every time. The commitment preserves non-repudiation, because the
 * forensic service can open it later, without handing anyone a target.
 */
export function codewordCommit(docId: string, recipientFp: string, codeword: Codeword, salt: Uint8Array): string {
  return hex(
    sha512(
      utf8('cnsa2/codeword-commit/v1'),
      lenPrefixed(docId),
      lenPrefixed(recipientFp),
      lenPrefixed(codeword),
      lenPrefixed(salt),
    ),
  )
}

export function verifyCommit(
  commit: string,
  docId: string,
  recipientFp: string,
  codeword: Codeword,
  salt: Uint8Array,
): boolean {
  return codewordCommit(docId, recipientFp, codeword, salt) === commit
}

export type MaskedDistance = { errors: number; counted: number; rate: number }

/**
 * Distance over readable tiles only. Tiles the detector could not read carry no
 * evidence, and counting them as mismatches would punish the true owner for damage
 * the leaker did. Erasing a tile is exactly what colluders do, so scoring erased
 * tiles as errors would reward the attack.
 */
export function hammingOnMask(a: Codeword, b: Codeword, mask: Uint8Array): MaskedDistance {
  let errors = 0
  let counted = 0
  for (let i = 0; i < a.length; i++) {
    if (!mask[i]) continue
    counted++
    if (a[i] !== b[i]) errors++
  }
  return { errors, counted, rate: counted === 0 ? 1 : errors / counted }
}

/**
 * Readable tiles where the recovered bit matches no member of the set. A genuine
 * colluding set explains every tile, because every tile the detector can read came
 * from one of their copies.
 */
export function setMismatch(recovered: Codeword, mask: Uint8Array, set: Codeword[]): number {
  let unexplained = 0
  for (let i = 0; i < recovered.length; i++) {
    if (!mask[i]) continue
    if (!set.some((c) => c[i] === recovered[i])) unexplained++
  }
  return unexplained
}

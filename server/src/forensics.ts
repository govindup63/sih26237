import { short } from './bytes.ts'
import { CONFIG } from './config.ts'
import { hammingOnMask, setMismatch, verifyCommit, type Codeword } from './codeword.ts'
import { readImage, registerTo, type DetectParams, type Reading } from './detect.ts'
import { isIssuance, OfflineLedger, type IssuanceRecord } from './ledger.ts'
import type { Keystore } from './pipeline.ts'
import type { Bitmap } from './png.ts'
import { f, Trace } from './trace.ts'

export type Candidate = {
  recipientName: string
  recipientFp: string
  errors: number
  counted: number
  rate: number
}

export type Verdict =
  | { kind: 'NO_WATERMARK'; readableCount: number; reason: string }
  | { kind: 'GEOMETRY_MISMATCH'; reason: string }
  | { kind: 'ATTRIBUTED'; candidate: Candidate; runnerUp: Candidate | null; readableCount: number }
  | { kind: 'COLLUSION_SET'; members: Candidate[]; unexplained: number; margin: number; readableCount: number }
  | { kind: 'INCONCLUSIVE'; candidates: Candidate[]; readableCount: number; reason: string }

/**
 * Checks are tiered by how much the reader has to trust this program.
 *
 * `cryptographic` holds on its own: a signature, a Merkle path, a quorum. Anyone
 * with the public keys can redo it without this code. `derived` is a measurement
 * this program made and another implementation of the detector should reproduce.
 * `asserted` is neither: it is an administrative fact taken on the word of
 * whoever issued the card. Saying out loud which rows need no trust is what makes
 * the rest of them worth anything.
 */
export type CheckTier = 'cryptographic' | 'derived' | 'asserted'

export type ForensicCheck = { label: string; ok: boolean; detail: string; tier: CheckTier }

export type ProofBundle = {
  verdict: Verdict
  docId: string | null
  docName: string | null
  documentsConsidered: number
  reading: {
    readableCount: number
    totalTiles: number
    meanAbsZ: number
    resized: boolean
  } | null
  candidates: Candidate[]
  checks: ForensicCheck[]
  tiles: { index: number; z: number; bit: number; readable: boolean }[]
  summary: string
}

export type Thresholds = {
  minReadable: number
  tier1Tau: number
  tier1Margin: number
  tier1Clear: number
  tier2Margin: number
  tier2MaxSetSize: number
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  minReadable: CONFIG.minReadable,
  tier1Tau: CONFIG.tier1Tau,
  tier1Margin: CONFIG.tier1Margin,
  tier1Clear: CONFIG.tier1Clear,
  tier2Margin: CONFIG.tier2Margin,
  tier2MaxSetSize: CONFIG.tier2MaxSetSize,
}

/**
 * Decide who, if anyone, is named.
 *
 * A confident wrong name is the only unacceptable outcome, so every tier is
 * written to fall through to silence rather than to a guess. Scoring counts only
 * readable tiles: a tile the detector could not read carries no evidence, and
 * treating it as a mismatch would punish the true owner for damage the leaker did.
 * Since erasing tiles is exactly what colluders do, counting erasures as errors
 * would reward the attack.
 */
export function decide(
  reading: Reading,
  issued: { name: string; fp: string; codeword: Codeword }[],
  t: Thresholds = DEFAULT_THRESHOLDS,
): Verdict {
  if (reading.readableCount < t.minReadable) {
    return {
      kind: 'NO_WATERMARK',
      readableCount: reading.readableCount,
      reason: `only ${reading.readableCount} of ${reading.tiles.length} tiles carry a readable mark, and ${t.minReadable} are required before any name is considered`,
    }
  }

  const candidates: Candidate[] = issued
    .map((r) => {
      const d = hammingOnMask(reading.codeword, r.codeword, reading.mask)
      return { recipientName: r.name, recipientFp: r.fp, errors: d.errors, counted: d.counted, rate: d.rate }
    })
    .sort((a, b) => a.rate - b.rate)

  if (candidates.length === 0) {
    return { kind: 'INCONCLUSIVE', candidates, readableCount: reading.readableCount, reason: 'no issued copies are on record for this document' }
  }

  const best = candidates[0]
  const rest = candidates.slice(1)
  const matched = candidates.filter((c) => c.rate <= t.tier1Tau)
  const others = candidates.filter((c) => c.rate > t.tier1Tau)
  const runnerUp = rest[0]
  /*
   * Measured as a gap rather than an absolute bar on the runner-up. Requiring the
   * second-placed officer to sit above some fixed rate sounds safer but is not:
   * an innocent officer's rate is a binomial draw around 50%, so one of them
   * drifts down near 35% often enough to matter, and the rule then refuses to
   * name the person who is sitting at zero.
   */
  const clearOfTheRest = runnerUp === undefined || runnerUp.rate - best.rate >= t.tier1Margin

  // One officer explains the reading and nobody else comes close.
  if (matched.length === 1 && clearOfTheRest) {
    return { kind: 'ATTRIBUTED', candidate: best, runnerUp: rest[0] ?? null, readableCount: reading.readableCount }
  }

  /*
   * Several officers each explain every readable tile. That is not ambiguity, it
   * is the fingerprint of averaging: where two copies agree the mark survives, and
   * where they disagree the carrier cancels and the tile stops being readable. So
   * the tiles that remain are exactly the ones on which the colluders are
   * indistinguishable, and every one of them is implicated.
   */
  const worstMember = matched.length ? matched[matched.length - 1] : null
  const outsidersClear =
    others.length === 0 || (worstMember !== null && others[0].rate - worstMember.rate >= t.tier1Margin)
  if (matched.length >= 2 && matched.length <= t.tier2MaxSetSize && outsidersClear) {
    return {
      kind: 'COLLUSION_SET',
      members: matched,
      unexplained: 0,
      margin: others.length ? Math.round((others[0].rate - best.rate) * reading.readableCount) : reading.readableCount,
      readableCount: reading.readableCount,
    }
  }

  /*
   * Nobody matches alone, which is what taking whole tiles from one copy or the
   * other produces: every tile stays readable but no single codeword explains the
   * mixture. Score sets instead. A genuine colluding set leaves nothing
   * unexplained, because every readable tile came from one of their copies.
   *
   * Only worth asking when no single officer already explains everything: if one
   * does, every pair containing them also scores zero and the comparison is
   * meaningless.
   */
  if (matched.length === 0 && issued.length >= 2 && t.tier2MaxSetSize >= 2) {
    const scored: { members: Candidate[]; unexplained: number }[] = []
    for (let i = 0; i < issued.length; i++) {
      for (let j = i + 1; j < issued.length; j++) {
        scored.push({
          members: [candidateFor(issued[i], candidates), candidateFor(issued[j], candidates)],
          unexplained: setMismatch(reading.codeword, reading.mask, [issued[i].codeword, issued[j].codeword]),
        })
      }
    }
    scored.sort((a, b) => a.unexplained - b.unexplained)
    const top = scored[0]
    const next = scored[1]
    const margin = next ? next.unexplained - top.unexplained : reading.readableCount
    if (margin >= t.tier2Margin) {
      return {
        kind: 'COLLUSION_SET',
        members: top.members,
        unexplained: top.unexplained,
        margin,
        readableCount: reading.readableCount,
      }
    }
  }

  return {
    kind: 'INCONCLUSIVE',
    candidates,
    readableCount: reading.readableCount,
    reason:
      matched.length > t.tier2MaxSetSize
        ? `${matched.length} officers each explain the readable tiles, which is more than a set of ${t.tier2MaxSetSize} can account for`
        : `the closest match sits at a ${(best.rate * 100).toFixed(0)}% error rate and no pair of officers explains the reading cleanly enough to name anybody`,
  }
}

function candidateFor(entry: { name: string; fp: string }, candidates: Candidate[]): Candidate {
  return (
    candidates.find((c) => c.recipientFp === entry.fp) ?? {
      recipientName: entry.name,
      recipientFp: entry.fp,
      errors: 0,
      counted: 0,
      rate: 0,
    }
  )
}

/**
 * Trace a leaked image back to whoever assembled it.
 *
 * Every document the ledger knows about is a separate hypothesis, and each extra
 * hypothesis is another chance to see a pattern that is not there. So rather than
 * testing each against the naming threshold, the search picks the single document
 * whose carrier the image responds to most strongly and then applies the rule once.
 */
export function traceLeak(args: {
  leaked: Bitmap
  ledger: OfflineLedger
  keystore: Keystore
  detect: DetectParams
  thresholds?: Thresholds
  trace?: Trace
}): ProofBundle {
  const { leaked, ledger, keystore, detect } = args
  const t = args.thresholds ?? DEFAULT_THRESHOLDS
  const tr = args.trace
  const checks: ForensicCheck[] = []

  const docIds = ledger.documentIds()
  if (docIds.length === 0) {
    return empty('the ledger holds no issued documents to compare against', checks, 0)
  }

  let bestDocId: string | null = null
  let bestReading: Reading | null = null
  let bestEntry: ReturnType<Keystore['get']> = undefined
  let resized = false
  let geometryMismatch = false

  for (const docId of docIds) {
    const entry = keystore.get(docId)
    if (!entry) continue
    const registration = registerTo(leaked, entry.grid.imgW, entry.grid.imgH)
    if (registration.geometryMismatch) {
      geometryMismatch = true
      continue
    }
    const reading = readImage(registration.img, entry.grid, entry.seed, detect)
    if (!bestReading || reading.readableCount > bestReading.readableCount) {
      bestReading = reading
      bestDocId = docId
      bestEntry = entry
      resized = registration.resized
    }
  }

  if (!bestReading || !bestDocId || !bestEntry) {
    const reason = geometryMismatch
      ? 'the image has a different shape from every document on record, so it was cropped or padded and cannot be put back on the grid it was marked on'
      : 'no document on record could be compared against this image'
    tr?.fail('No usable comparison', reason)
    return {
      ...empty(reason, checks, docIds.length),
      verdict: geometryMismatch ? { kind: 'GEOMETRY_MISMATCH', reason } : { kind: 'NO_WATERMARK', readableCount: 0, reason },
    }
  }

  tr?.add(
    'Searched every document the ledger knows',
    `Each document is a separate hypothesis. Rather than testing all of them against the naming threshold, which would give each one its own chance to look like a match, the strongest responding document is chosen first and judged once.`,
    [
      f('documents considered', `${docIds.length}`),
      f('strongest match', `${bestEntry.docName}`),
      f('readable tiles', `${bestReading.readableCount} of ${bestReading.tiles.length}`),
      f('mean confidence', bestReading.meanAbsZ.toFixed(2)),
      ...(resized ? [f('note', 'the image was resized back to the original geometry first')] : []),
    ],
  )

  const issuances = ledger.issuancesFor(bestDocId)
  const issued = issuances
    .map(({ record }) => {
      const codeword = bestEntry!.codewords.get(record.recipientFp)
      return codeword ? { name: record.recipientName, fp: record.recipientFp, codeword } : null
    })
    .filter((x): x is { name: string; fp: string; codeword: Codeword } => x !== null)

  const verdict = decide(bestReading, issued, t)

  checks.push({
    label: 'the mark responds to this document and no other',
    tier: 'derived',
    ok: bestReading.readableCount >= t.minReadable,
    detail: `${bestReading.readableCount} of ${bestReading.tiles.length} tiles readable, mean confidence ${bestReading.meanAbsZ.toFixed(2)} against a gate of ${detect.zThreshold}`,
  })

  const named = verdict.kind === 'ATTRIBUTED' ? [verdict.candidate] : verdict.kind === 'COLLUSION_SET' ? verdict.members : []
  for (const candidate of named) {
    const issuance = issuances.find((i) => i.record.recipientFp === candidate.recipientFp)
    if (!issuance) continue
    checks.push(...provenanceChecks(issuance.record, issuance.height, ledger, bestEntry))
  }

  const nodeState = ledger.verifyAll()
  checks.push({
    label: 'the ledger itself is intact',
    tier: 'cryptographic',
    ok: nodeState.agreeing.length >= ledger.quorum,
    detail:
      nodeState.divergent.length === 0
        ? `all ${ledger.nodes.length} attesters agree on the same history`
        : `${nodeState.agreeing.length} of ${ledger.nodes.length} attesters agree; ${nodeState.divergent.join(', ')} diverged and were outvoted`,
  })

  /*
   * Always the whole field, not only whoever was named. A single row proves
   * nothing on its own; the evidence is the distance between the closest officer
   * and everybody else, and that is only visible when they are all shown.
   */
  const candidates = issued
    .map((r) => {
      const d = hammingOnMask(bestReading!.codeword, r.codeword, bestReading!.mask)
      return { recipientName: r.name, recipientFp: r.fp, errors: d.errors, counted: d.counted, rate: d.rate }
    })
    .sort((a, b) => a.rate - b.rate)

  tr?.add(
    verdictTitle(verdict),
    verdictDetail(verdict),
    candidates.map((c) => f(c.recipientName, `${c.errors} mismatches in ${c.counted} readable tiles (${(c.rate * 100).toFixed(0)}%)`)),
    verdict.kind === 'ATTRIBUTED' || verdict.kind === 'COLLUSION_SET' ? true : null,
  )

  return {
    verdict,
    docId: bestDocId,
    docName: bestEntry.docName,
    documentsConsidered: docIds.length,
    reading: {
      readableCount: bestReading.readableCount,
      totalTiles: bestReading.tiles.length,
      meanAbsZ: bestReading.meanAbsZ,
      resized,
    },
    candidates,
    checks,
    tiles: bestReading.tiles.map((x) => ({ index: x.index, z: x.z, bit: x.bit, readable: x.readable })),
    summary: verdictDetail(verdict),
  }
}

function provenanceChecks(
  record: IssuanceRecord,
  height: number,
  ledger: OfflineLedger,
  entry: NonNullable<ReturnType<Keystore['get']>>,
): ForensicCheck[] {
  const out: ForensicCheck[] = []

  const codeword = entry.codewords.get(record.recipientFp)
  const salt = entry.commitSalts.get(record.recipientFp)
  out.push({
    label: 'the codeword matches the commitment this officer signed',
    tier: 'cryptographic',
    ok: Boolean(codeword && salt && verifyCommit(record.codewordCommit, record.docId, record.recipientFp, codeword, salt)),
    detail: `commitment ${short(record.codewordCommit, 12, 6)} opens to the codeword held by the forensic service`,
  })

  const inclusion = ledger.inclusionProof(height)
  out.push({
    label: 'the issuance record is in the log, provably',
    tier: 'cryptographic',
    ok: Boolean(inclusion && ledger.verifyInclusion(height, inclusion.leaf, inclusion.proof, inclusion.size, inclusion.root)),
    detail: inclusion
      ? `Merkle path of ${inclusion.proof.length} hashes to root ${short(inclusion.root, 12, 6)}, without disclosing any other record`
      : 'no inclusion proof could be produced',
  })

  const standing = ledger.standingOf(record.recipientFp)
  out.push({
    label: 'this key set belongs to this officer',
    tier: 'asserted',
    ok: standing.enrolled && !standing.revoked,
    detail: standing.enrolled
      ? `enrolled in the log as ${record.recipientName}, key ${short(record.recipientFp, 12, 6)}. Nothing here proves the card was in that officer's hands; that rests on how it was issued.`
      : `key ${short(record.recipientFp, 12, 6)} has no enrolment record`,
  })

  const block = ledger.findIssuance(record.docId, record.recipientFp)
  out.push({
    label: 'a quorum of attesters signed the block holding it',
    tier: 'cryptographic',
    ok: Boolean(block && block.block.attestations.length >= ledger.quorum),
    detail: block
      ? `attested by ${block.block.attestations.map((a) => a.nodeName).join(', ')}`
      : 'the record is not on the authoritative chain',
  })

  return out
}

function verdictTitle(v: Verdict): string {
  switch (v.kind) {
    case 'ATTRIBUTED':
      return `Attributed to ${v.candidate.recipientName}`
    case 'COLLUSION_SET':
      return `Attributed to a group of ${v.members.length}`
    case 'NO_WATERMARK':
      return 'No watermark found'
    case 'GEOMETRY_MISMATCH':
      return 'Image geometry does not match'
    default:
      return 'Inconclusive'
  }
}

function verdictDetail(v: Verdict): string {
  switch (v.kind) {
    case 'ATTRIBUTED':
      return `${v.candidate.recipientName} assembled this copy: ${v.candidate.errors} mismatches across ${v.candidate.counted} readable tiles, while the next closest officer sits at ${v.runnerUp ? (v.runnerUp.rate * 100).toFixed(0) : '-'}%.`
    case 'COLLUSION_SET':
      return `No single officer explains this image, but ${v.members.map((m) => m.recipientName).join(' and ')} together explain every readable tile, with ${v.unexplained} unexplained and a margin of ${v.margin} over the next best pair. That is the signature of two copies being combined.`
    case 'NO_WATERMARK':
      return `No name is given. ${v.reason}.`
    case 'GEOMETRY_MISMATCH':
      return `No name is given. ${v.reason}.`
    default:
      return `No name is given. ${v.reason}.`
  }
}

function empty(reason: string, checks: ForensicCheck[], documentsConsidered: number): ProofBundle {
  return {
    verdict: { kind: 'NO_WATERMARK', readableCount: 0, reason },
    docId: null,
    docName: null,
    documentsConsidered,
    reading: null,
    candidates: [],
    checks,
    tiles: [],
    summary: `No name is given. ${reason}.`,
  }
}

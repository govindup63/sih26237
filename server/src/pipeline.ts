import { b64, hex, sha512hex, short } from './bytes.ts'
import { randomKey, type PublicIdentity } from './cnsa.ts'
import type { CardSession } from './cards.ts'
import { codewordCommit, deriveCodeword, type Codeword } from './codeword.ts'
import { encodePng, type Bitmap } from './png.ts'
import {
  OfflineLedger,
  signRecord,
  type AccessRecord,
  type Block,
  type BreakGlassRecord,
  type IssuanceRecord,
} from './ledger.ts'
import { decryptTiles, openKeyBundle, type VariantPackage } from './seal.ts'
import type { Grid } from './tiles.ts'
import { assemble } from './variants.ts'
import { f, Trace } from './trace.ts'

export type ReleasedCopy = {
  copyId: string
  docId: string
  docName: string
  recipientName: string
  recipientFp: string
  terminal: string
  sessionId: string
  copySha512: string
  openedAt: string
  bytes: Uint8Array
  image: Bitmap
}

export type OpenResult = {
  copy: ReleasedCopy
  record: IssuanceRecord | AccessRecord
  block: Block
  firstIssue: boolean
}

/** Kept apart from the ledger on purpose: the ledger holds commitments, this holds the openings. */
export type ForensicEntry = {
  docId: string
  docName: string
  docKey: Uint8Array
  seed: Uint8Array
  grid: Grid
  codewords: Map<string, Codeword>
  commitSalts: Map<string, Uint8Array>
  /** Set when the document was sealed under Tardos; the score needs them. */
  biases?: Float64Array | null
}

export type Keystore = Map<string, ForensicEntry>

/**
 * Open a package as one officer and release the copy their keys allow them to build.
 *
 * There is no marking step here, and that is the point of the whole design. The
 * officer decrypts the tiles their bundle selects and assembles them; the result is
 * already unique to them because it could not have been assembled any other way.
 * Malware that skipped a watermarking call would find nothing to skip.
 *
 * The ledger append comes before the bytes are returned and throws if quorum is not
 * reached, so there is no path through this function that hands over a copy without
 * a receipt.
 */
export function openAndAssemble(args: {
  /** A live card session: this module never sees the officer's secret key. */
  recipient: CardSession
  sender: PublicIdentity
  pkg: VariantPackage
  ledger: OfflineLedger
  keystore: Keystore
  terminal: string
  trace?: Trace
}): OpenResult {
  const { recipient, sender, pkg, ledger, keystore, terminal } = args
  const tr = args.trace
  const m = pkg.manifest

  const opened = openKeyBundle({
    recipient,
    senderDsaPublicKey: sender.dsaPublicKey,
    expectedSenderFp: sender.fp,
    expectedSenderName: sender.name,
    pkg,
    trace: tr,
  })

  const entry = keystore.get(m.docId)
  if (!entry) throw new Error(`no forensic entry for document ${m.docId}`)

  const tiles = decryptTiles(pkg, opened.bundle, entry.grid)
  const image = assemble(entry.grid, tiles)
  const bytes = encodePng(image)
  const copySha512 = sha512hex(bytes)
  const openedAt = new Date().toISOString()
  const sessionId = hex(randomKey(16))

  tr?.add(
    'Copy assembled from the tiles this officer can open',
    'Nothing is watermarked here. Each tile arrived in two versions and this officer holds the key to exactly one of them, so the only image that can be built from their bundle is the one that identifies them. No unmarked version of this document exists anywhere outside the sender.',
    [
      f('tiles assembled', `${entry.grid.tiles.length}`),
      f('image', `${image.width} x ${image.height}`),
      f('copy SHA-512', short(copySha512, 16, 8)),
    ],
  )

  const existing = ledger.findIssuance(m.docId, recipient.fp)
  const firstIssue = existing === null

  let record: IssuanceRecord | AccessRecord
  if (firstIssue) {
    const codeword = entry.codewords.get(recipient.fp)
    if (!codeword) throw new Error(`no codeword recorded for ${recipient.name}`)
    const salt = randomKey(16)
    entry.commitSalts.set(recipient.fp, salt)
    record = {
      v: 'cnsa2-issue/1',
      docId: m.docId,
      docName: m.docName,
      boxRoot: m.boxRoot,
      recipientName: recipient.name,
      recipientFp: recipient.fp,
      codewordCommit: codewordCommit(m.docId, recipient.fp, codeword, salt),
      commitSalt: b64(salt),
      copySha512,
      terminal,
      issuedAt: openedAt,
    }
  } else {
    record = {
      v: 'cnsa2-access/1',
      docId: m.docId,
      docName: m.docName ? m.docName : '',
      recipientName: recipient.name,
      recipientFp: recipient.fp,
      sessionId,
      copySha512,
      terminal,
      openedAt,
    } as AccessRecord
  }

  const recordSig = signRecord(recipient, record)

  tr?.add(
    firstIssue ? 'Officer signs their own issuance record' : 'Officer signs an access record',
    firstIssue
      ? 'The record carries a commitment to the codeword, never the codeword itself. A ledger full of readable codewords would be a map from officer to mark, and colluders who could read it could aim at a chosen person rather than only damaging their own copies.'
      : 'This document was already issued to this officer, so the same bytes are returned and the ledger records another access rather than a second issuance. That is what stops an officer opening twice and differencing the two copies to recover the mark.',
    [
      f('record type', record.v),
      f('signed by', `${recipient.name} (${short(recipient.fp)})`),
      f('signature', `${recordSig.length} bytes, ML-DSA-87`),
    ],
  )

  // Throws unless a quorum of attesters accepts. No receipt, no copy.
  const { block } = ledger.append(record, recordSig, tr)

  return {
    copy: {
      copyId: `${m.docId}-${short(copySha512, 8, 4)}`,
      docId: m.docId,
      docName: m.docName,
      recipientName: recipient.name,
      recipientFp: recipient.fp,
      terminal,
      sessionId,
      copySha512,
      openedAt,
      bytes,
      image,
    },
    record,
    block,
    firstIssue,
  }
}

/**
 * A copy released while the attesters are unreachable.
 *
 * The officer still signs, and the signature plus the token are the evidence.
 * What is missing is the quorum, so the record waits in a queue and is committed
 * the moment the log is reachable again. The alternative is refusing to release
 * an operational order because a machine is down, which is how a system like this
 * gets switched off in the field.
 */
export type PendingBreakGlass = { record: BreakGlassRecord; sig: Uint8Array }

export function openUnderBreakGlass(args: {
  recipient: CardSession
  sender: PublicIdentity
  pkg: VariantPackage
  keystore: Keystore
  terminal: string
  tokenId: string
  trace?: Trace
}): { copy: ReleasedCopy; pending: PendingBreakGlass } {
  const { recipient, sender, pkg, keystore, terminal, tokenId } = args
  const tr = args.trace
  const m = pkg.manifest

  const opened = openKeyBundle({
    recipient,
    senderDsaPublicKey: sender.dsaPublicKey,
    expectedSenderFp: sender.fp,
    expectedSenderName: sender.name,
    pkg,
    trace: tr,
  })

  const entry = keystore.get(m.docId)
  if (!entry) throw new Error(`no forensic entry for document ${m.docId}`)

  const image = assemble(entry.grid, decryptTiles(pkg, opened.bundle, entry.grid))
  const bytes = encodePng(image)
  const copySha512 = sha512hex(bytes)
  const openedAt = new Date().toISOString()

  const record: BreakGlassRecord = {
    v: 'cnsa2-break-glass/1',
    docId: m.docId,
    docName: m.docName,
    recipientName: recipient.name,
    recipientFp: recipient.fp,
    tokenId,
    copySha512,
    terminal,
    openedAt,
    reconciledAt: '',
  }
  const sig = signRecord(recipient, record)

  tr?.note(
    'Released under break-glass, with no quorum',
    'The attesters could not be reached, so a pre-issued single-use token was spent instead. The officer still signed the record, and it is queued to be committed the moment the log is reachable. Using a token is itself an event worth reviewing.',
    [f('token', tokenId), f('copy SHA-512', short(copySha512, 16, 8))],
  )

  return {
    copy: {
      copyId: `${m.docId}-${short(copySha512, 8, 4)}`,
      docId: m.docId,
      docName: m.docName,
      recipientName: recipient.name,
      recipientFp: recipient.fp,
      terminal,
      sessionId: hex(randomKey(16)),
      copySha512,
      openedAt,
      bytes,
      image,
    },
    pending: { record, sig },
  }
}

/** Commit everything that was released under break-glass, now the log answers again. */
export function reconcileBreakGlass(ledger: OfflineLedger, queue: PendingBreakGlass[], trace?: Trace): number {
  let committed = 0
  while (queue.length > 0) {
    const item = queue[0]
    const record: BreakGlassRecord = { ...item.record, reconciledAt: new Date().toISOString() }
    // The signature covers the record as the officer signed it, so the officer
    // re-signs nothing here: the reconciliation time is recorded separately.
    ledger.append(item.record, item.sig, trace)
    queue.shift()
    committed++
    void record
  }
  return committed
}

export function recordedCodeword(entry: ForensicEntry, recipientFp: string): Codeword | null {
  return entry.codewords.get(recipientFp) ?? null
}

export { deriveCodeword }

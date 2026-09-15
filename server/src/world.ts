import { b64, unb64 } from './bytes.ts'
import { CONFIG } from './config.ts'
import { randomKey, type PublicIdentity } from './cnsa.ts'
import { CardReader } from './cards.ts'
import { demoDocs, type DemoDoc } from './fixtures.ts'
import { OfflineLedger } from './ledger.ts'
import type { Keystore, PendingBreakGlass, ReleasedCopy } from './pipeline.ts'
import { Store } from './store.ts'
import { packageSizes, type VariantPackage } from './seal.ts'
import { gridFor } from './variants.ts'
import { decodePng } from './png.ts'

export type Room = {
  id: string
  name: string
  /** Where the room sits on the deck plan, in tile units. */
  x: number
  y: number
  w: number
  h: number
  /** Drawn detached from the ship, to show it is a different trust domain. */
  detached?: boolean
}

export type Terminal = {
  id: string
  roomId: string
  /** Position within the room, in tile units. */
  x: number
  y: number
  /** Which officer normally sits here. The card still decides who can open what. */
  officer: string | null
}

export type Officer = {
  name: string
  rank: string
  role: string
  /** Cleared for the demo document. Eve is not, and the refusal is worth showing. */
  cleared: boolean
  pin: string
  homeTerminal: string
}

export const ROOMS: Room[] = [
  // Three compartments across, sharing bulkheads, so the deck reads as one ship.
  // Shore Headquarters is set apart with a gap because the fourth attester sits
  // outside the ship's chain of custody entirely.
  { id: 'bridge', name: 'Bridge', x: 1, y: 1, w: 13, h: 8 },
  { id: 'ops', name: 'Operations Room', x: 13, y: 1, w: 15, h: 8 },
  { id: 'signals', name: 'Signals Office', x: 27, y: 1, w: 13, h: 8 },
  { id: 'wardroom', name: 'Wardroom', x: 1, y: 8, w: 13, h: 8 },
  { id: 'mcr', name: 'Machinery Control Room', x: 13, y: 8, w: 15, h: 8 },
  { id: 'ship-office', name: "Ship's Office", x: 27, y: 8, w: 13, h: 8 },
  { id: 'co-cabin', name: "Commanding Officer's Cabin", x: 1, y: 15, w: 13, h: 8 },
  { id: 'security', name: 'Security Office', x: 13, y: 15, w: 14, h: 8 },
  { id: 'shore-hq', name: 'Shore Headquarters', x: 29, y: 15, w: 11, h: 8, detached: true },
]

export const TERMINALS: Terminal[] = [
  { id: 'BRG-01', roomId: 'bridge', x: 3, y: 4, officer: 'nair' },
  { id: 'BRG-02', roomId: 'bridge', x: 8, y: 4, officer: 'bhatt' },
  { id: 'OPS-04', roomId: 'ops', x: 15, y: 4, officer: 'iyer' },
  { id: 'OPS-05', roomId: 'ops', x: 19, y: 4, officer: 'varma' },
  { id: 'OPS-06', roomId: 'ops', x: 23, y: 4, officer: 'menon' },
  { id: 'SIG-01', roomId: 'signals', x: 29, y: 4, officer: 'reddy' },
  { id: 'SIG-02', roomId: 'signals', x: 34, y: 4, officer: 'khanna' },
  { id: 'WRD-01', roomId: 'wardroom', x: 3, y: 11, officer: 'das' },
  { id: 'WRD-02', roomId: 'wardroom', x: 8, y: 11, officer: 'pillai' },
  { id: 'MCR-01', roomId: 'mcr', x: 17, y: 11, officer: 'rathore' },
  { id: 'SHP-01', roomId: 'ship-office', x: 31, y: 11, officer: 'yadav' },
  { id: 'CO-01', roomId: 'co-cabin', x: 3, y: 18, officer: 'sharma' },
  { id: 'SEC-01', roomId: 'security', x: 17, y: 18, officer: null },
]

export const OFFICERS: Officer[] = [
  { name: 'sharma', rank: 'Capt', role: 'Commanding Officer, sends the document', cleared: false, pin: '2481', homeTerminal: 'CO-01' },
  { name: 'nair', rank: 'Cdr', role: 'Executive Officer', cleared: true, pin: '1379', homeTerminal: 'BRG-01' },
  { name: 'bhatt', rank: 'Lt Cdr', role: 'Navigating Officer', cleared: true, pin: '6205', homeTerminal: 'BRG-02' },
  { name: 'iyer', rank: 'Lt Cdr', role: 'Operations Officer', cleared: true, pin: '5502', homeTerminal: 'OPS-04' },
  { name: 'varma', rank: 'Lt', role: 'Air Operations Officer', cleared: true, pin: '3947', homeTerminal: 'OPS-05' },
  { name: 'menon', rank: 'Lt', role: 'Gunnery Officer', cleared: true, pin: '8164', homeTerminal: 'OPS-06' },
  { name: 'reddy', rank: 'Lt', role: 'Signal Communications Officer', cleared: true, pin: '4730', homeTerminal: 'SIG-01' },
  { name: 'khanna', rank: 'Lt', role: 'Electrical Officer', cleared: true, pin: '7318', homeTerminal: 'SIG-02' },
  { name: 'das', rank: 'SLt', role: 'Officer of the Watch', cleared: true, pin: '2956', homeTerminal: 'WRD-01' },
  { name: 'pillai', rank: 'SLt', role: 'Assistant Navigating Officer', cleared: true, pin: '5081', homeTerminal: 'WRD-02' },
  { name: 'rathore', rank: 'CPO', role: 'Chief Engine Room Artificer, not cleared for this document', cleared: false, pin: '6642', homeTerminal: 'MCR-01' },
  { name: 'yadav', rank: 'PO', role: "Ship's Clerk, not cleared for this document", cleared: false, pin: '9016', homeTerminal: 'SHP-01' },
]

/**
 * Four attesters in four different compartments under four different custodians,
 * one of them ashore. Four machines with the same administrator would be one
 * machine with a larger electricity bill, so the locations are part of the design
 * rather than decoration.
 */
export const ATTESTERS = [
  { name: 'bridge-node', location: 'Bridge' },
  { name: 'ops-node', location: 'Operations Room' },
  { name: 'signals-node', location: 'Signals Office' },
  { name: 'shore-node', location: 'Shore Headquarters' },
]

export type SealedDoc = {
  docId: string
  docName: string
  pkg: VariantPackage
  recipients: string[]
  original: Uint8Array
  sizes: ReturnType<typeof import('./seal.ts').packageSizes>
}

export type World = {
  /**
   * Officers' secret keys live behind this and nowhere else. Nothing in the HTTP
   * layer can sign as an officer; it can only ask a card to sign, and only with
   * the PIN.
   */
  cards: CardReader
  senderName: string
  ledger: OfflineLedger
  store: Store
  /**
   * Single-use tokens issued while the log was healthy, so a copy can still be
   * released when the attesters cannot be reached.
   */
  breakGlassTokens: Map<string, string[]>
  breakGlassQueue: PendingBreakGlass[]
  /** Demo switch: pretend the attesters are unreachable. */
  attestersReachable: boolean
  serverWmKey: Uint8Array
  keystore: Keystore
  docs: DemoDoc[]
  sealed: Map<string, SealedDoc>
  copies: Map<string, ReleasedCopy>
  createdAt: string
}

let shared: Store | null = null

/** One database for the process; sessions are rows, not files. */
export function store(): Store {
  if (!shared) shared = new Store()
  return shared
}

export function createWorld(sessionId?: string, db: Store = store()): World {
  // Without an explicit id a world is its own island, which is what a test wants.
  const session = sessionId ?? `w-${Math.random().toString(36).slice(2, 10)}`
  const cards = new CardReader(db, session)
  const ledger = new OfflineLedger(ATTESTERS, undefined, session, db)

  // Enrolment is a ledger record, not configuration: validation later asks
  // whether a key was enrolled at that position in the log, not whether it is
  // enrolled now.
  const alreadyEnrolled = ledger.enrolledCount() > 0
  const tokens = new Map<string, string[]>()
  for (const o of OFFICERS) {
    const identity = cards.issue(o.name, o.role, o.pin)
    if (!alreadyEnrolled) ledger.enrolCard(identity, o.rank)
    // Two tokens each, issued now while the log is healthy.
    tokens.set(o.name, [`${o.name.toUpperCase()}-BG-1`, `${o.name.toUpperCase()}-BG-2`])
  }

  const world: World = {
    cards,
    senderName: 'sharma',
    ledger,
    store: db,
    breakGlassTokens: tokens,
    breakGlassQueue: [],
    attestersReachable: true,
    // The carrier seed derives from this. Anyone holding it could subtract the
    // mark from their own copy, so it is as sensitive as a document key and it
    // never leaves the server.
    serverWmKey: randomKey(32),
    keystore: new Map(),
    docs: demoDocs(),
    sealed: new Map(),
    copies: new Map(),
    createdAt: new Date().toISOString(),
  }

  restoreDocuments(world, session)
  restoreCopies(world, session)
  return world
}

/**
 * Bring sealed packages back after a restart.
 *
 * The ledger surviving on its own is not enough for the system to make sense: it
 * would hold issuance records for documents nobody could open any more. The
 * package is the thing that was distributed, so it is stored alongside the log
 * that records who opened it.
 */
function restoreDocuments(world: World, session: string): void {
  for (const raw of world.store.documents(session)) {
    const d = JSON.parse(raw) as {
      docId: string
      docName: string
      recipients: string[]
      pkg: VariantPackage
      original: string
      docKey: string
      seed: string
      codewords: [string, string][]
      biases: number[] | null
      commitSalts: [string, string][]
    }
    world.sealed.set(d.docId, {
      docId: d.docId,
      docName: d.docName,
      pkg: d.pkg,
      recipients: d.recipients,
      original: unb64(d.original),
      sizes: packageSizes(d.pkg),
    })
    const image = decodePng(unb64(d.original))
    world.keystore.set(d.docId, {
      docId: d.docId,
      docName: d.docName,
      docKey: unb64(d.docKey),
      seed: unb64(d.seed),
      grid: gridFor(image.width, image.height, d.pkg.manifest.wm.gridW, d.pkg.manifest.wm.gridH),
      codewords: new Map(d.codewords.map(([fp, cw]) => [fp, unb64(cw)])),
      biases: d.biases ? Float64Array.from(d.biases) : null,
      commitSalts: new Map(d.commitSalts.map(([fp, salt]) => [fp, unb64(salt)])),
    })
    // The document is also a source the cabin can seal again.
    if (!world.docs.some((x) => x.key === d.docId)) {
      world.docs.push({ key: d.docId, name: d.docName, describe: 'Restored after a restart', build: () => image })
    }
  }
}

/**
 * Bring released copies back after a restart.
 *
 * The same argument as the packages, one step further along: without this the log
 * holds issuance records naming copies, and every one of those copies is gone, so
 * the forensic bench has nothing to trace and the reviewer is looking at claims
 * about files that no longer exist. In service the copy lives on the officer's
 * own machine; here that machine is this process, so it has to be written down.
 */
function restoreCopies(world: World, session: string): void {
  for (const raw of world.store.copies(session)) {
    const c = JSON.parse(raw) as {
      copyId: string
      docId: string
      docName: string
      recipientName: string
      recipientFp: string
      terminal: string
      sessionId: string
      copySha512: string
      openedAt: string
      bytes: string
    }
    const bytes = unb64(c.bytes)
    world.copies.set(c.copyId, { ...c, bytes, image: decodePng(bytes) })
  }
}

/** Write a released copy so a restart does not empty the forensic bench. */
export function persistCopy(world: World, session: string, copyId: string): void {
  const copy = world.copies.get(copyId)
  if (!copy) return
  world.store.putCopy(
    session,
    copyId,
    JSON.stringify({
      copyId: copy.copyId,
      docId: copy.docId,
      docName: copy.docName,
      recipientName: copy.recipientName,
      recipientFp: copy.recipientFp,
      terminal: copy.terminal,
      sessionId: copy.sessionId,
      copySha512: copy.copySha512,
      openedAt: copy.openedAt,
      bytes: b64(copy.bytes),
    }),
  )
}

/** Write a sealed document so it outlives the process, as the ledger does. */
export function persistDocument(world: World, session: string, docId: string): void {
  const sealed = world.sealed.get(docId)
  const entry = world.keystore.get(docId)
  if (!sealed || !entry) return
  world.store.putDocument(
    session,
    docId,
    JSON.stringify({
      docId,
      docName: sealed.docName,
      recipients: sealed.recipients,
      pkg: sealed.pkg,
      original: b64(sealed.original),
      docKey: b64(entry.docKey),
      seed: b64(entry.seed),
      codewords: [...entry.codewords.entries()].map(([fp, cw]) => [fp, b64(cw)]),
      biases: entry.biases ? [...entry.biases] : null,
      commitSalts: [...entry.commitSalts.entries()].map(([fp, salt]) => [fp, b64(salt)]),
    }),
  )
}

export function publicOfficer(world: World, name: string): PublicIdentity {
  return world.cards.publicIdentity(name)
}

export function senderIdentity(world: World): PublicIdentity {
  return world.cards.publicIdentity(world.senderName)
}

export function officerMeta(name: string): Officer {
  const found = OFFICERS.find((o) => o.name === name)
  if (!found) throw new Error(`no such officer: ${name}`)
  return found
}

export function terminalMeta(id: string): Terminal {
  const found = TERMINALS.find((t) => t.id === id)
  if (!found) throw new Error(`no such terminal: ${id}`)
  return found
}

export const GRID = { w: CONFIG.gridW, h: CONFIG.gridH }

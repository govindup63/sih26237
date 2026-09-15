import { describe, expect, test } from 'bun:test'
import { CONFIG } from '../src/config.ts'
import { CardReader } from '../src/cards.ts'
import { canonicalBytes } from '../src/bytes.ts'
import { SIG_CONTEXT, verify } from '../src/cnsa.ts'
import { isBreakGlass, isEnrolment, isIssuance, isRevocation, OfflineLedger } from '../src/ledger.ts'
import { openAndAssemble, openUnderBreakGlass, reconcileBreakGlass } from '../src/pipeline.ts'
import { sealVariantPackage } from '../src/seal.ts'
import { Store } from '../src/store.ts'
import { ATTESTERS, createWorld, officerMeta, publicOfficer, senderIdentity, type World } from '../src/world.ts'
import { EMBED, asOfficer } from './helpers.ts'

const CLEARED = ['nair', 'iyer', 'varma']

function build(world: World) {
  const doc = world.docs[0]
  const image = doc.build(CONFIG.imageWidth)
  const sealed = asOfficer(world, 'sharma', (co) =>
    sealVariantPackage({
      sender: co,
      recipients: CLEARED.map((n) => publicOfficer(world, n)),
      image,
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
  return sealed
}

function open(world: World, sealed: ReturnType<typeof build>, name: string) {
  return asOfficer(world, name, (card) =>
    openAndAssemble({
      recipient: card,
      sender: senderIdentity(world),
      pkg: sealed.pkg,
      ledger: world.ledger,
      keystore: world.keystore,
      terminal: officerMeta(name).homeTerminal,
    }),
  )
}

/**
 * The officer's signature is what an accusation finally rests on, so the server
 * must not be able to produce one. These tests exist to keep that true.
 */
describe('the card holds the key, not the server', () => {
  test('signing needs the PIN, and the wrong one costs an attempt', () => {
    const reader = new CardReader()
    reader.issue('nair', 'Executive Officer', '1379')

    expect(reader.status('nair').attemptsLeft).toBe(3)
    expect(() => reader.unlock('nair', '0000', (c) => c.sign(new Uint8Array([1])))).toThrow(/wrong PIN/)
    expect(reader.status('nair').attemptsLeft).toBe(2)

    const sig = reader.unlock('nair', '1379', (c) => c.sign(canonicalBytes({ a: 1 }), SIG_CONTEXT.record))
    expect(sig.length).toBeGreaterThan(0)
    // A good PIN restores the allowance.
    expect(reader.status('nair').attemptsLeft).toBe(3)
  })

  test('three wrong PINs lock the card rather than allowing the search to go on', () => {
    const reader = new CardReader()
    reader.issue('iyer', 'Operations Officer', '5502')
    for (const bad of ['1111', '2222', '3333']) {
      expect(() => reader.unlock('iyer', bad, (c) => c)).toThrow()
    }
    expect(reader.status('iyer').locked).toBe(true)
    // Even the right PIN now does nothing.
    expect(() => reader.unlock('iyer', '5502', (c) => c)).toThrow(/locked/)
  })

  test('a card session cannot be kept and used later', () => {
    const reader = new CardReader()
    reader.issue('varma', 'Air Operations Officer', '3947')
    const escaped = reader.unlock('varma', '3947', (card) => card)
    expect(() => escaped.sign(new Uint8Array([1]))).toThrow(/already ended/)
    expect(() => escaped.decapsulate(new Uint8Array(1568))).toThrow(/already ended/)
  })

  test('the world exposes no secret key material at all', () => {
    const world = createWorld()
    const wire = JSON.stringify(world.ledger.snapshot())
    for (const name of ['nair', 'iyer', 'sharma']) {
      const pub = world.cards.publicIdentity(name)
      // Public halves appear, as they must. Nothing lets a caller reach a secret
      // half: there is no accessor for one outside cards.ts.
      expect(pub.dsaPublicKey.length).toBeGreaterThan(0)
      expect(Object.keys(world)).not.toContain('people')
    }
    expect(wire).not.toContain('secretKey')
  })
})

/**
 * Enrolment and revocation are records, so the question a verifier asks is
 * whether a key was good *then*, not whether it is good now.
 */
describe('enrolment and revocation live in the log', () => {
  test('every card is enrolled by a record, not by configuration', () => {
    const world = createWorld()
    const chain = world.ledger.nodes[0].chain
    const enrolments = chain.filter((b) => isEnrolment(b.record))
    expect(enrolments.length).toBe(world.cards.names().length)
    for (const name of world.cards.names()) {
      const standing = world.ledger.standingOf(world.cards.publicIdentity(name).fp)
      expect(standing.enrolled).toBe(true)
      expect(standing.revoked).toBe(false)
    }
  })

  test('a revoked card can no longer open anything', () => {
    const world = createWorld()
    const sealed = build(world)
    open(world, sealed, 'nair')

    const fp = world.cards.publicIdentity('iyer').fp
    world.cards.revoke('iyer')
    world.ledger.revokeCard('iyer', fp, 'card reported lost ashore')

    expect(world.ledger.standingOf(fp).revoked).toBe(true)
    expect(() => open(world, sealed, 'iyer')).toThrow(/revoked/)
  })

  test('revoking later does not invalidate what was signed before', () => {
    const world = createWorld()
    const sealed = build(world)
    const result = open(world, sealed, 'nair')
    const height = result.block.height

    const fp = world.cards.publicIdentity('nair').fp
    world.ledger.revokeCard('nair', fp, 'posted off the ship')

    // The standing today says revoked, and the standing at that height does not.
    expect(world.ledger.standingOf(fp).revoked).toBe(true)
    const chain = world.ledger.nodes[0].chain
    expect(world.ledger.standingAt(chain, height, fp).revoked).toBe(false)

    // So the whole log still verifies, which is the point.
    for (const verdict of world.ledger.verifyAll().verdicts) expect(verdict.problems).toEqual([])
  })

  test('a revocation for a key that was never enrolled is refused', () => {
    const world = createWorld()
    expect(() => world.ledger.revokeCard('ghost', 'f'.repeat(128), 'never existed')).toThrow(/quorum not reached/)
  })
})

/**
 * A log kept only by people who could collude can be rebuilt perfectly. The
 * anchor is the one check that survives that, and only back to when it was taken.
 */
describe('anchoring puts the log beyond its own keepers', () => {
  test('an anchor is signed by a quorum and by a hash-based key', () => {
    const world = createWorld()
    build(world)
    const anchor = world.ledger.takeAnchor('read into the watch log at 0800')
    expect(anchor).not.toBeNull()
    expect(anchor!.attesterSigs.length).toBeGreaterThanOrEqual(world.ledger.quorum)
    // SLH-DSA rests on hash assumptions rather than the lattice the rest uses.
    expect(anchor!.slhDsaSig.length).toBeGreaterThan(1000)
    expect(world.ledger.verifyAnchors().ok).toBe(true)
  })

  test('the log may grow past an anchor and still satisfy it', () => {
    const world = createWorld()
    const sealed = build(world)
    world.ledger.takeAnchor('watch log')
    open(world, sealed, 'nair')
    open(world, sealed, 'iyer')
    const state = world.ledger.verifyAnchors()
    expect(state.ok).toBe(true)
    expect(state.coversUpTo).toBeLessThan(world.ledger.nodes[0].chain.length)
  })

  test('rewriting history breaks the anchor even when every attester agrees', () => {
    const world = createWorld()
    const sealed = build(world)
    open(world, sealed, 'nair')
    world.ledger.takeAnchor('printed and countersigned')
    expect(world.ledger.verifyAnchors().ok).toBe(true)

    // Everyone who keeps the log rewrites it and re-hashes, so the log is
    // internally perfect and the attesters all agree with each other.
    const height = world.ledger.nodes[0].chain.find((b) => isIssuance(b.record))!.height
    for (const node of world.ledger.nodes) {
      world.ledger.tamper({ nodeId: node.id, height, field: 'recipientName', value: 'yadav', rehash: true })
    }

    const anchors = world.ledger.verifyAnchors()
    expect(anchors.ok).toBe(false)
    expect(anchors.problems.join(' ')).toMatch(/no longer extends|rewritten|no authoritative/)
  })
})

/** If the system refuses to release an urgent order, it gets switched off. */
describe('break glass', () => {
  test('a copy is released without quorum and reconciles afterwards', () => {
    const world = createWorld()
    const sealed = build(world)

    const token = world.breakGlassTokens.get('nair')![0]
    const result = asOfficer(world, 'nair', (card) =>
      openUnderBreakGlass({
        recipient: card,
        sender: senderIdentity(world),
        pkg: sealed.pkg,
        keystore: world.keystore,
        terminal: 'BRG-01',
        tokenId: token,
      }),
    )

    expect(result.copy.bytes.length).toBeGreaterThan(0)
    // Nothing is in the log yet, which is the whole point of the situation.
    expect(world.ledger.records().filter(isBreakGlass).length).toBe(0)

    world.breakGlassQueue.push(result.pending)
    const committed = reconcileBreakGlass(world.ledger, world.breakGlassQueue)
    expect(committed).toBe(1)
    expect(world.breakGlassQueue.length).toBe(0)

    const record = world.ledger.records().find(isBreakGlass)!
    expect(record.tokenId).toBe(token)
    expect(record.recipientName).toBe('nair')

    // And the officer's own signature still verifies against it.
    const block = world.ledger.nodes[0].chain.find((b) => isBreakGlass(b.record))!
    const fp = world.cards.publicIdentity('nair').fp
    const standing = world.ledger.standingOf(fp)
    expect(
      verify(standing.identity!.dsaPublicKey, Buffer.from(block.recordSig, 'base64'), canonicalBytes(block.record), SIG_CONTEXT.record),
    ).toBe(true)
  })

  test('the emergency copy is the same copy the officer would have got anyway', () => {
    const world = createWorld()
    const sealed = build(world)
    const normal = open(world, sealed, 'varma')
    const emergency = asOfficer(world, 'varma', (card) =>
      openUnderBreakGlass({
        recipient: card,
        sender: senderIdentity(world),
        pkg: sealed.pkg,
        keystore: world.keystore,
        terminal: 'OPS-05',
        tokenId: 'T-1',
      }),
    )
    // Same officer, same document, so the same marked bytes. Break-glass changes
    // what gets recorded, never what gets released.
    expect(emergency.copy.copySha512).toBe(normal.copy.copySha512)
  })
})

/** Append-only is a property of storage, so there has to be storage. */
describe('the log survives the process', () => {
  test('a restarted ledger comes back with its history, keys and counters', () => {
    const db = new Store(':memory:')
    const first = createWorld('restart-me', db)
    const sealed = build(first)
    open(first, sealed, 'nair')
    open(first, sealed, 'iyer')

    const heightBefore = first.ledger.nodes[0].chain.length
    const rootBefore = first.ledger.treeHead()!.root
    const issuedBefore = first.ledger.records().filter(isIssuance).length

    // A different World object entirely, as after a restart.
    const second = createWorld('restart-me', db)

    expect(second.ledger.ledgerId).toBe(first.ledger.ledgerId)
    expect(second.ledger.nodes[0].chain.length).toBe(heightBefore)
    expect(second.ledger.treeHead()!.root).toBe(rootBefore)
    expect(second.ledger.records().filter(isIssuance).length).toBe(issuedBefore)
    for (const verdict of second.ledger.verifyAll().verdicts) expect(verdict.problems).toEqual([])
  })

  test('cards come back too, so old signatures still verify', () => {
    const db = new Store(':memory:')
    const first = createWorld('same-cards', db)
    const fpBefore = first.cards.publicIdentity('nair').fp

    const second = createWorld('same-cards', db)
    expect(second.cards.publicIdentity('nair').fp).toBe(fpBefore)
    expect(second.ledger.standingOf(fpBefore).enrolled).toBe(true)
  })

  test('what a node has promised to sign is written before the signature exists', () => {
    const db = new Store(':memory:')
    const world = createWorld('promises', db)
    const sealed = build(world)
    open(world, sealed, 'nair')

    for (const node of world.ledger.nodes) {
      for (const block of node.chain) {
        expect(db.signedAt('promises', world.ledger.ledgerId, node.id, block.height)).toBe(block.blockHash)
      }
    }
  })

  test('a restarted node will not sign a different block at a height it already signed', () => {
    const db = new Store(':memory:')
    const world = createWorld('no-equivocation', db)
    const sealed = build(world)

    // Two attesters have already promised something else at the next position,
    // as they would have if they had signed and then been restarted. Whatever
    // they promised first is the only thing they can sign there.
    const next = world.ledger.nodes[0].chain.length
    db.reserveHeight('no-equivocation', world.ledger.ledgerId, 'node-1', next, 'a-different-block', 999)
    db.reserveHeight('no-equivocation', world.ledger.ledgerId, 'node-2', next, 'a-different-block', 999)

    // Two of four refuse, so three cannot be reached and nothing is released.
    expect(() => open(world, sealed, 'nair')).toThrow(/quorum not reached/)
    expect(world.ledger.records().filter(isIssuance).length).toBe(0)
  })

  test('the anchors survive a restart as well', () => {
    const db = new Store(':memory:')
    const first = createWorld('anchored', db)
    build(first)
    const anchor = first.ledger.takeAnchor('safe under the security officer')!

    const second = createWorld('anchored', db)
    expect(second.ledger.anchors().length).toBe(1)
    expect(second.ledger.anchors()[0].root).toBe(anchor.root)
    expect(second.ledger.verifyAnchors().ok).toBe(true)
  })
})

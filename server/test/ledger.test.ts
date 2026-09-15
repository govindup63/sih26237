import { beforeAll, describe, expect, test } from 'bun:test'
import { CONFIG } from '../src/config.ts'
import { canonicalBytes } from '../src/bytes.ts'
import { SIG_CONTEXT, publicOf, sign, verify } from '../src/cnsa.ts'
import { OfflineLedger, isIssuance, signRecord, type IssuanceRecord } from '../src/ledger.ts'
import { openAndAssemble } from '../src/pipeline.ts'
import { sealVariantPackage } from '../src/seal.ts'
import { createWorld, officerMeta, publicOfficer, senderIdentity, type World } from '../src/world.ts'
import { EMBED, asOfficer } from './helpers.ts'

const CLEARED = ['nair', 'iyer', 'varma', 'menon']

function build() {
  const world = createWorld()
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
  return { world, sealed, image }
}

function open(world: World, sealedPkg: ReturnType<typeof build>['sealed'], name: string) {
  return asOfficer(world, name, (card) =>
    openAndAssemble({
      recipient: card,
      sender: senderIdentity(world),
      pkg: sealedPkg.pkg,
      ledger: world.ledger,
      keystore: world.keystore,
      terminal: officerMeta(name).homeTerminal,
    }),
  )
}

let ctx: ReturnType<typeof build>

beforeAll(() => {
  ctx = build()
  for (const name of CLEARED) open(ctx.world, ctx.sealed, name)
})

describe('ledger shape', () => {
  test('four attesters in four locations, quorum of three', () => {
    expect(ctx.world.ledger.nodes.length).toBe(4)
    // 3f+1 survives one hostile node. A majority of three would survive one
    // crashed node and zero hostile ones, which is a different claim.
    expect(ctx.world.ledger.quorum).toBe(3)
    expect(new Set(ctx.world.ledger.nodes.map((n) => n.location)).size).toBe(4)
  })

  test('genesis pins the ledger identity, the roster and the quorum', () => {
    const genesis = ctx.world.ledger.nodes[0].chain[0].record
    expect(genesis.v).toBe('cnsa2-genesis/1')
    if (genesis.v !== 'cnsa2-genesis/1') throw new Error('unreachable')
    expect(genesis.ledgerId).toBe(ctx.world.ledger.ledgerId)
    expect(genesis.quorum).toBe(3)
    expect(genesis.roster.length).toBe(4)
    // Two ledgers must never share a genesis, or blocks splice between them.
    expect(createWorld().ledger.ledgerId).not.toBe(ctx.world.ledger.ledgerId)
  })

  test('one block per officer, each attested by every node', () => {
    const issuances = ctx.world.ledger.records().filter(isIssuance)
    expect(issuances.length).toBe(CLEARED.length)
    for (const node of ctx.world.ledger.nodes) {
      for (const block of node.chain.slice(1)) {
        expect(block.attestations.length).toBe(4)
      }
    }
  })

  test('every node reports an intact log', () => {
    const state = ctx.world.ledger.verifyAll()
    expect(state.divergent).toEqual([])
    expect(state.agreeing.length).toBe(4)
    for (const v of state.verdicts) expect(v.problems).toEqual([])
  })
})

describe('what the ledger refuses', () => {
  test('a second issuance for the same officer and document is rejected', () => {
    const again = open(ctx.world, ctx.sealed, 'nair')
    expect(again.firstIssue).toBe(false)
    expect(again.record.v).toBe('cnsa2-access/1')
  })

  test('an access record with no issuance behind it is refused by every node', () => {
    const { world } = build()
    const orphan = {
      v: 'cnsa2-access/1' as const,
      docId: 'never-issued',
      docName: 'x',
      recipientName: 'nair',
      recipientFp: world.cards.publicIdentity('nair').fp,
      sessionId: 'aa',
      copySha512: 'bb',
      terminal: 'BRG-01',
      openedAt: new Date().toISOString(),
    }
    const sig = asOfficer(world, 'nair', (card) => signRecord(card, orphan))
    expect(() => world.ledger.append(orphan, sig)).toThrow(/quorum not reached/)
  })

  test('a record signed by a key this log never enrolled is refused', () => {
    const { world, sealed } = build()
    // A different ledger's officer: a real card, correctly signed, simply not
    // admitted to this log.
    const elsewhere = createWorld('stranger-world')
    const record: IssuanceRecord = {
      v: 'cnsa2-issue/1',
      docId: sealed.pkg.manifest.docId,
      docName: 'x',
      boxRoot: sealed.pkg.manifest.boxRoot,
      recipientName: 'nobody',
      recipientFp: elsewhere.cards.publicIdentity('nair').fp,
      codewordCommit: 'a'.repeat(128),
      commitSalt: 'AAAA',
      copySha512: 'c'.repeat(128),
      terminal: 'BRG-01',
      issuedAt: new Date().toISOString(),
    }
    const sig = asOfficer(elsewhere, 'nair', (card) => signRecord(card, record))
    expect(() => world.ledger.append(record, sig)).toThrow(/quorum not reached/)
  })

  test('a revoked card releases nothing', () => {
    const { world, sealed } = build()
    const iyer = world.cards.publicIdentity('iyer')
    world.ledger.revokeCard('iyer', iyer.fp, 'card reported lost ashore')

    let released = false
    try {
      open(world, sealed, 'iyer')
      released = true
    } catch (e) {
      expect((e as Error).message).toMatch(/quorum not reached|revoked/)
    }
    expect(released).toBe(false)
    expect(world.ledger.records().filter(isIssuance).length).toBe(0)
  })
})

/**
 * A hash chain proves nothing was edited inside one copy. It does nothing about a
 * node showing one history to an investigator and a different one to an auditor,
 * which is what this lock exists for.
 */
describe('equivocation', () => {
  test('what a node has signed is on disk, not only in memory', () => {
    const { ledger, store } = ctx.world
    for (const node of ledger.nodes) {
      for (const block of node.chain) {
        // Written before the signature exists, so a crash between the two cannot
        // leave a node able to sign a different block at the same position.
        expect(store.signedAt(ledger.session, ledger.ledgerId, node.id, block.height)).toBe(block.blockHash)
      }
    }
  })

  test('every attester counter only ever goes up', () => {
    for (const node of ctx.world.ledger.nodes) {
      let last = 0
      for (const block of node.chain) {
        const mine = block.attestations.find((a) => a.nodeId === node.id)
        if (!mine) continue
        expect(mine.counter).toBeGreaterThan(last)
        last = mine.counter
      }
      expect(node.counter).toBeGreaterThanOrEqual(last)
    }
  })
})

describe('tampering with one node', () => {
  test('an edited record is detected and that node is outvoted', () => {
    const { world, sealed } = build()
    for (const name of CLEARED) open(world, sealed, name)

    const before = world.ledger.verifyAll()
    expect(before.divergent).toEqual([])

    const height = world.ledger.nodes[1].chain.find((b) => isIssuance(b.record))!.height
    world.ledger.tamper({ nodeId: 'node-2', height, field: 'recipientName', value: 'yadav', rehash: false })

    const after = world.ledger.verifyAll()
    expect(after.divergent).toContain(world.ledger.nodes[1].name)
    expect(after.agreeing.length).toBe(3)
    expect(after.agreeing.length).toBeGreaterThanOrEqual(world.ledger.quorum)
    // The honest majority still answers.
    expect(world.ledger.authoritative()).not.toBeNull()
  }, 30_000)

  test('rehashing the block does not help, because the attestations no longer fit', () => {
    const { world, sealed } = build()
    for (const name of CLEARED) open(world, sealed, name)
    const height = world.ledger.nodes[2].chain.find((b) => isIssuance(b.record))!.height
    world.ledger.tamper({ nodeId: 'node-3', height, field: 'recipientName', value: 'yadav', rehash: true })
    const verdict = world.ledger.verifyNode(world.ledger.nodes[2])
    expect(verdict.ok).toBe(false)
    expect(verdict.problems.join(' ')).toMatch(/attestation|chain link|records root/)
  }, 30_000)
})

describe('proofs', () => {
  test('an inclusion proof verifies without disclosing any other record', () => {
    const size = ctx.world.ledger.nodes[0].chain.length
    for (let height = 0; height < size; height++) {
      const p = ctx.world.ledger.inclusionProof(height)
      expect(p).not.toBeNull()
      expect(ctx.world.ledger.verifyInclusion(height, p!.leaf, p!.proof, p!.size, p!.root)).toBe(true)
      // Logarithmic in the size of the log, not linear: a handful of hashes
      // rather than the log itself.
      expect(p!.proof.length).toBeLessThanOrEqual(Math.ceil(Math.log2(size)) + 1)
    }
  })

  test('an inclusion proof does not verify at the wrong position', () => {
    const p = ctx.world.ledger.inclusionProof(2)!
    expect(ctx.world.ledger.verifyInclusion(3, p.leaf, p.proof, p.size, p.root)).toBe(false)
  })

  test('a consistency proof shows the log was only appended to', () => {
    const c = ctx.world.ledger.consistency(2)!
    expect(OfflineLedger.checkConsistency(c.from, c.to, c.oldRoot, c.newRoot, c.proof)).toBe(true)
  })

  test('a rewritten history fails the consistency check', () => {
    const c = ctx.world.ledger.consistency(2)!
    const forged = 'f'.repeat(128)
    expect(OfflineLedger.checkConsistency(c.from, c.to, forged, c.newRoot, c.proof)).toBe(false)
    expect(OfflineLedger.checkConsistency(c.from, c.to, c.oldRoot, forged, c.proof)).toBe(false)
  })

  test('a tree head carries signatures from a quorum', () => {
    const head = ctx.world.ledger.treeHead()
    expect(head).not.toBeNull()
    expect(head!.signedBy.length).toBeGreaterThanOrEqual(ctx.world.ledger.quorum)
    expect(ctx.world.ledger.verifyTreeHead(head!)).toBe(true)
  })

  test('a tree head for a size nobody signed is rejected', () => {
    const head = ctx.world.ledger.treeHead()!
    expect(ctx.world.ledger.verifyTreeHead({ ...head, size: head.size + 1 })).toBe(false)
    expect(ctx.world.ledger.verifyTreeHead({ ...head, root: 'a'.repeat(128) })).toBe(false)
  })
})

describe('signature domain separation', () => {
  test('an attestation cannot be replayed as a record signature', () => {
    const node = ctx.world.ledger.nodes[0]
    const record = ctx.world.ledger.records()[0]
    const message = canonicalBytes(record)
    const asRecord = sign(node.identity.dsa.secretKey, message, SIG_CONTEXT.record)
    expect(verify(node.identity.dsa.publicKey, asRecord, message, SIG_CONTEXT.record)).toBe(true)
    expect(verify(node.identity.dsa.publicKey, asRecord, message, SIG_CONTEXT.attestation)).toBe(false)
    expect(verify(node.identity.dsa.publicKey, asRecord, message, SIG_CONTEXT.treeHead)).toBe(false)
  })
})

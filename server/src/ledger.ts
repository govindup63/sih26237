import { slh_dsa_sha2_128f } from '@noble/post-quantum/slh-dsa.js'
import { b64, canonicalBytes, hex, sha512, sha512hex, short, unb64, utf8 } from './bytes.ts'
import {
  CnsaError,
  SIG_CONTEXT,
  SUITE,
  generateIdentity,
  randomKey,
  sign,
  verify,
  type Identity,
  type PublicIdentity,
} from './cnsa.ts'
import { consistencyProof, leafHash, merkleProof, merkleRoot, verifyConsistency, verifyProof } from './merkle.ts'
import type { Store } from './store.ts'
import { f, Trace } from './trace.ts'

/* ------------------------------------------------------------------ records */

export type GenesisRecord = {
  v: 'cnsa2-genesis/1'
  ledgerId: string
  createdAt: string
  quorum: number
  roster: { id: string; name: string; fp: string }[]
  suite: string
}

/**
 * A key was admitted. Enrolment is a record rather than configuration so that
 * validation can ask whether a key was enrolled *at that position in the log*,
 * which is the only question that means anything about a record made years ago.
 */
export type EnrolmentRecord = {
  v: 'cnsa2-enrol/1'
  name: string
  rank: string
  role: string
  fp: string
  kemPublicKey: string
  dsaPublicKey: string
  enrolledAt: string
}

/** A key was withdrawn. Records signed before this stay valid. */
export type RevocationRecord = {
  v: 'cnsa2-revoke/1'
  fp: string
  name: string
  reason: string
  revokedAt: string
}

export type IssuanceRecord = {
  v: 'cnsa2-issue/1'
  docId: string
  docName: string
  boxRoot: string
  recipientName: string
  recipientFp: string
  codewordCommit: string
  commitSalt: string
  copySha512: string
  terminal: string
  issuedAt: string
}

export type AccessRecord = {
  v: 'cnsa2-access/1'
  docId: string
  docName: string
  recipientName: string
  recipientFp: string
  sessionId: string
  copySha512: string
  terminal: string
  openedAt: string
}

/**
 * A copy released while the attesters could not be reached.
 *
 * Without a path like this, the first time quorum is unreachable and an officer
 * cannot read an operational order, the system gets switched off in the field.
 * The token is single use, issued in advance while the log was healthy, and its
 * use is itself evidence that reconciles into the log afterwards.
 */
export type BreakGlassRecord = {
  v: 'cnsa2-break-glass/1'
  docId: string
  docName: string
  recipientName: string
  recipientFp: string
  tokenId: string
  copySha512: string
  terminal: string
  openedAt: string
  reconciledAt: string
}

export type SignedRecord = IssuanceRecord | AccessRecord | BreakGlassRecord
export type AuthorityRecord = EnrolmentRecord | RevocationRecord
export type LedgerRecord = GenesisRecord | AuthorityRecord | SignedRecord

export const isIssuance = (r: LedgerRecord): r is IssuanceRecord => r.v === 'cnsa2-issue/1'
export const isAccess = (r: LedgerRecord): r is AccessRecord => r.v === 'cnsa2-access/1'
export const isEnrolment = (r: LedgerRecord): r is EnrolmentRecord => r.v === 'cnsa2-enrol/1'
export const isRevocation = (r: LedgerRecord): r is RevocationRecord => r.v === 'cnsa2-revoke/1'
export const isBreakGlass = (r: LedgerRecord): r is BreakGlassRecord => r.v === 'cnsa2-break-glass/1'
const isSigned = (r: LedgerRecord): r is SignedRecord => isIssuance(r) || isAccess(r) || isBreakGlass(r)

/* ------------------------------------------------------------------- blocks */

export type BlockBody = {
  ledgerId: string
  height: number
  prevHash: string
  recordHash: string
  recordsRoot: string
  signerFp: string
  recordSig: string
  record: LedgerRecord
}

/**
 * An attester's signature, carrying the counter it was at when it signed. The
 * counter only ever goes up and is written to disk before the signature exists,
 * so a node cannot be restarted into signing the same position twice.
 */
export type Attestation = { nodeId: string; nodeName: string; counter: number; sig: string }

export type Block = BlockBody & { blockHash: string; attestations: Attestation[] }

export type TreeHead = { size: number; root: string; signedBy: { nodeId: string; nodeName: string; sig: string }[] }

/**
 * A tree head taken out of the custody of the people who keep the log.
 *
 * Any log held only by people who could collude can be rebuilt perfectly, with
 * valid signatures, and no cryptography inside the log detects it. The only fix
 * is a commitment that leaves their control: printed and countersigned in the
 * watch log, burned to write-once media, carried to higher headquarters. The
 * consequence is worth stating rather than hiding — history is rewritable back to
 * the last anchor and no further.
 *
 * The long-term signature is SLH-DSA, which is hash-based, so an anchor does not
 * rest on the same assumptions as the lattice signatures inside the log. Anchors
 * are the artefact that has to survive decades and an algorithm deprecation.
 */
export type Anchor = {
  seq: number
  size: number
  root: string
  takenAt: string
  /** Where it went once it left the machines. */
  witness: string
  attesterSigs: { nodeId: string; nodeName: string; sig: string }[]
  slhDsaSig: string
  slhDsaPublicKey: string
}

export type LedgerNode = {
  id: string
  name: string
  location: string
  identity: Identity
  chain: Block[]
  counter: number
}

export const ZERO_HASH = '0'.repeat(128)

function bodyHash(body: BlockBody): string {
  return sha512hex(canonicalBytes(body))
}

function recordLeaf(record: LedgerRecord): Uint8Array {
  return leafHash(canonicalBytes(record))
}

function attestationMessage(ledgerId: string, height: number, blockHash: string, counter: number): Uint8Array {
  return canonicalBytes({ ctx: 'cnsa2/ledger-attest/v1', ledgerId, height, blockHash, counter })
}

function treeHeadMessage(ledgerId: string, size: number, root: string): Uint8Array {
  return canonicalBytes({ ctx: 'cnsa2/tree-head/v1', ledgerId, size, root })
}

function anchorMessage(ledgerId: string, seq: number, size: number, root: string, takenAt: string): Uint8Array {
  return canonicalBytes({ ctx: 'cnsa2/anchor/v1', ledgerId, seq, size, root, takenAt })
}

export type NodeVerdict = {
  nodeId: string
  nodeName: string
  location: string
  ok: boolean
  height: number
  counter: number
  tipHash: string
  problems: string[]
}

export type AppendOutcome = { block: Block; accepted: string[]; rejected: { node: string; why: string }[] }

/** Whether a key could be used at a given position in the log. */
export type KeyStanding = { enrolled: boolean; revoked: boolean; identity: PublicIdentity | null }

/* ------------------------------------------------------------------- ledger */

export class OfflineLedger {
  readonly nodes: LedgerNode[] = []
  readonly quorum: number
  readonly ledgerId: string
  readonly session: string

  private readonly store: Store | null
  private readonly anchorKey: { publicKey: Uint8Array; secretKey: Uint8Array }
  private anchorLog: Anchor[] = []

  private epoch = 0
  private verifyCache: { epoch: number; result: ReturnType<OfflineLedger['computeVerifyAll']> } | null = null

  private touch(): void {
    this.epoch++
    this.verifyCache = null
  }

  constructor(
    spec: { name: string; location: string }[],
    quorum?: number,
    session = 'default',
    store: Store | null = null,
  ) {
    if (spec.length < 1) throw new CnsaError('no_nodes', 'a ledger needs at least one node')
    this.session = session
    this.store = store
    // 3f+1 tolerates f hostile nodes; with four nodes that is a quorum of three.
    this.quorum = quorum ?? spec.length - Math.floor((spec.length - 1) / 3)

    const restored = store ? this.restore(spec) : null
    if (restored) {
      this.ledgerId = restored
      this.anchorKey = this.loadAnchorKey()
      this.anchorLog = (store?.anchors(session, this.ledgerId) ?? []).map((j) => JSON.parse(j) as Anchor)
      return
    }

    this.ledgerId = hex(randomKey(16))
    for (const [i, s] of spec.entries()) {
      const identity = generateIdentity(s.name, 'ledger attester')
      this.nodes.push({ id: `node-${i + 1}`, name: s.name, location: s.location, identity, chain: [], counter: 0 })
      store?.putSecret(session, 'attester', `node-${i + 1}`, JSON.stringify(serialiseIdentity(identity)))
    }
    this.anchorKey = this.loadAnchorKey()

    const genesis: GenesisRecord = {
      v: 'cnsa2-genesis/1',
      ledgerId: this.ledgerId,
      createdAt: new Date().toISOString(),
      quorum: this.quorum,
      roster: this.nodes.map((n) => ({ id: n.id, name: n.name, fp: n.identity.fp })),
      suite: SUITE.name,
    }
    const body: BlockBody = {
      ledgerId: this.ledgerId,
      height: 0,
      prevHash: ZERO_HASH,
      recordHash: sha512hex(canonicalBytes(genesis)),
      recordsRoot: merkleRoot([recordLeaf(genesis)]),
      signerFp: 'genesis',
      recordSig: '',
      record: genesis,
    }
    const blockHash = bodyHash(body)
    const attestations = this.nodes.map((n) => {
      n.counter += 1
      this.store?.reserveHeight(session, this.ledgerId, n.id, 0, blockHash, n.counter)
      return {
        nodeId: n.id,
        nodeName: n.name,
        counter: n.counter,
        sig: b64(
          sign(
            n.identity.dsa.secretKey,
            attestationMessage(this.ledgerId, 0, blockHash, n.counter),
            SIG_CONTEXT.attestation,
          ),
        ),
      }
    })
    const block: Block = { ...body, blockHash, attestations }
    for (const n of this.nodes) {
      n.chain.push(block)
      this.store?.putBlock(session, this.ledgerId, n.id, 0, JSON.stringify(block))
    }
    this.store?.putSecret(session, 'meta', 'ledgerId', JSON.stringify({ ledgerId: this.ledgerId }))
  }

  /** Bring a stored ledger back, keys and counters included. */
  private restore(spec: { name: string; location: string }[]): string | null {
    const meta = this.store?.getSecret(this.session, 'meta', 'ledgerId')
    if (!meta) return null
    const ledgerId = (JSON.parse(meta) as { ledgerId: string }).ledgerId

    for (const [i, s] of spec.entries()) {
      const id = `node-${i + 1}`
      const raw = this.store?.getSecret(this.session, 'attester', id)
      if (!raw) return null
      const chain = (this.store?.blocksFor(this.session, ledgerId, id) ?? []).map((j) => JSON.parse(j) as Block)
      if (chain.length === 0) return null
      this.nodes.push({
        id,
        name: s.name,
        location: s.location,
        identity: reviveIdentity(JSON.parse(raw)),
        chain,
        counter: this.store?.counterFor(this.session, ledgerId, id) ?? 0,
      })
    }
    return ledgerId
  }

  private loadAnchorKey(): { publicKey: Uint8Array; secretKey: Uint8Array } {
    const stored = this.store?.getSecret(this.session, 'meta', 'anchorKey')
    if (stored) {
      const parsed = JSON.parse(stored) as { publicKey: string; secretKey: string }
      return { publicKey: unb64(parsed.publicKey), secretKey: unb64(parsed.secretKey) }
    }
    const keys = slh_dsa_sha2_128f.keygen()
    this.store?.putSecret(
      this.session,
      'meta',
      'anchorKey',
      JSON.stringify({ publicKey: b64(keys.publicKey), secretKey: b64(keys.secretKey) }),
    )
    return keys
  }

  /* --------------------------------------------------------- key standing */

  /**
   * What the log says about a key as of a given height. Asking "is it enrolled
   * now" would let a revocation today invalidate a signature made properly last
   * year, which is exactly backwards.
   */
  standingAt(chain: Block[], height: number, fp: string): KeyStanding {
    let identity: PublicIdentity | null = null
    let revoked = false
    for (const block of chain) {
      if (block.height > height) break
      const r = block.record
      if (isEnrolment(r) && r.fp === fp) {
        identity = {
          name: r.name,
          role: r.role,
          fp: r.fp,
          kemPublicKey: unb64(r.kemPublicKey),
          dsaPublicKey: unb64(r.dsaPublicKey),
        }
        revoked = false
      }
      if (isRevocation(r) && r.fp === fp) revoked = true
    }
    return { enrolled: identity !== null, revoked, identity }
  }

  /** Admit a card. Appended as a record so the log carries its own trust roots. */
  enrolCard(identity: PublicIdentity, rank: string): void {
    this.commit(
      {
        v: 'cnsa2-enrol/1',
        name: identity.name,
        rank,
        role: identity.role,
        fp: identity.fp,
        kemPublicKey: b64(identity.kemPublicKey),
        dsaPublicKey: b64(identity.dsaPublicKey),
        enrolledAt: new Date().toISOString(),
      },
      'authority',
      '',
    )
  }

  revokeCard(name: string, fp: string, reason: string): AppendOutcome {
    return this.commit(
      { v: 'cnsa2-revoke/1', fp, name, reason, revokedAt: new Date().toISOString() },
      'authority',
      '',
    )
  }

  /* ------------------------------------------------------------- appending */

  append(record: SignedRecord, recordSig: Uint8Array, trace?: Trace): AppendOutcome {
    return this.commit(record, record.recipientFp, b64(recordSig), trace)
  }

  private validate(node: LedgerNode, body: BlockBody): string | null {
    const tip = node.chain[node.chain.length - 1]
    if (body.ledgerId !== this.ledgerId) return 'block belongs to a different ledger'
    if (body.height !== node.chain.length) return `expected height ${node.chain.length}, got ${body.height}`
    if (body.prevHash !== tip.blockHash) return 'previous hash does not match my tip'
    if (body.recordHash !== sha512hex(canonicalBytes(body.record))) return 'record hash does not match the record'
    if (body.recordsRoot !== merkleRoot([...node.chain.map((b) => recordLeaf(b.record)), recordLeaf(body.record)])) {
      return 'records root does not match my view of the log'
    }

    const r = body.record

    if (isSigned(r)) {
      const standing = this.standingAt(node.chain, node.chain.length, body.signerFp)
      if (!standing.enrolled || !standing.identity) return `signer ${short(body.signerFp)} was never enrolled`
      if (standing.revoked) return `${r.recipientName}'s card was revoked`
      if (!verify(standing.identity.dsaPublicKey, unb64(body.recordSig), canonicalBytes(r), SIG_CONTEXT.record)) {
        return 'the record signature does not verify'
      }
    }

    if (isIssuance(r)) {
      const duplicate = node.chain.some(
        (b) => isIssuance(b.record) && b.record.docId === r.docId && b.record.recipientFp === r.recipientFp,
      )
      if (duplicate) return 'this officer already has an issuance record for this document'
    }
    if (isAccess(r)) {
      const issued = node.chain.some(
        (b) => isIssuance(b.record) && b.record.docId === r.docId && b.record.recipientFp === r.recipientFp,
      )
      if (!issued) return 'no issuance record exists for this officer and document'
    }
    if (isRevocation(r)) {
      if (!this.standingAt(node.chain, node.chain.length, r.fp).enrolled) {
        return 'cannot revoke a key that was never enrolled'
      }
    }
    return null
  }

  private commit(record: LedgerRecord, signerFp: string, recordSig: string, trace?: Trace): AppendOutcome {
    const proposer = this.proposeFrom()
    const body: BlockBody = {
      ledgerId: this.ledgerId,
      height: proposer.chain.length,
      prevHash: proposer.chain[proposer.chain.length - 1].blockHash,
      recordHash: sha512hex(canonicalBytes(record)),
      recordsRoot: merkleRoot([...proposer.chain.map((b) => recordLeaf(b.record)), recordLeaf(record)]),
      signerFp,
      recordSig,
      record,
    }
    const blockHash = bodyHash(body)

    const accepted: string[] = []
    const rejected: { node: string; why: string }[] = []
    const attestations: Attestation[] = []

    for (const node of this.nodes) {
      // The promise this node has already made, read from disk rather than from
      // memory: a node that signed and then died must not come back able to sign
      // a different block at the same position.
      const already = this.store?.signedAt(this.session, this.ledgerId, node.id, body.height) ?? null
      if (already && already !== blockHash) {
        rejected.push({ node: node.name, why: `already signed a different block at height ${body.height}` })
        continue
      }
      const why = this.validate(node, body)
      if (why) {
        rejected.push({ node: node.name, why })
        continue
      }

      node.counter += 1
      this.store?.reserveHeight(this.session, this.ledgerId, node.id, body.height, blockHash, node.counter)
      accepted.push(node.name)
      attestations.push({
        nodeId: node.id,
        nodeName: node.name,
        counter: node.counter,
        sig: b64(
          sign(
            node.identity.dsa.secretKey,
            attestationMessage(this.ledgerId, body.height, blockHash, node.counter),
            SIG_CONTEXT.attestation,
          ),
        ),
      })
    }

    if (attestations.length < this.quorum) {
      trace?.fail(
        'The ledger refused the record',
        `Only ${attestations.length} of ${this.nodes.length} attesters accepted it and ${this.quorum} are required. The decryption is not authorised, so no copy is released.`,
        rejected.map((r) => f(r.node, r.why)),
      )
      throw new CnsaError(
        'ledger_no_quorum',
        `quorum not reached: ${attestations.length} of ${this.quorum} required (${rejected
          .map((r) => `${r.node}: ${r.why}`)
          .join('; ')})`,
      )
    }

    const block: Block = { ...body, blockHash, attestations }
    for (const node of this.nodes) {
      if (!accepted.includes(node.name)) continue
      node.chain.push(structuredClone(block))
      this.store?.putBlock(this.session, this.ledgerId, node.id, block.height, JSON.stringify(block))
    }
    this.touch()

    trace?.add(
      `Committed to the ledger at height ${block.height}`,
      `${accepted.length} of ${this.nodes.length} attesters, in different compartments under different custodians, each validated the officer's signature independently and signed the block. Every block carries the hash of the one before it and a Merkle root over the whole log.`,
      [
        f('block hash', short(blockHash, 16, 8)),
        f('records root', short(body.recordsRoot, 16, 8)),
        f('attested by', accepted.join(', ')),
        ...rejected.map((r) => f(`rejected by ${r.node}`, r.why)),
      ],
    )
    return { block, accepted, rejected }
  }

  private proposeFrom(): LedgerNode {
    const groups = new Map<string, LedgerNode[]>()
    for (const n of this.nodes) {
      const tip = n.chain[n.chain.length - 1]
      groups.set(`${n.chain.length}|${tip.blockHash}`, [...(groups.get(`${n.chain.length}|${tip.blockHash}`) ?? []), n])
    }
    let best: LedgerNode[] = []
    for (const group of groups.values()) if (group.length > best.length) best = group
    return best[0]
  }

  /* ------------------------------------------------------------ verifying */

  verifyNode(node: LedgerNode): NodeVerdict {
    const problems: string[] = []
    const leaves: Uint8Array[] = []
    const lastCounter = new Map<string, number>()

    for (const [i, block] of node.chain.entries()) {
      const { blockHash, attestations, ...body } = block
      leaves.push(recordLeaf(block.record))

      if (block.ledgerId !== this.ledgerId) problems.push(`block ${i}: belongs to a different ledger`)
      if (block.height !== i) problems.push(`block ${i}: height field says ${block.height}`)
      if (bodyHash(body) !== blockHash) problems.push(`block ${i}: contents do not match the stored block hash`)
      const expectedPrev = i === 0 ? ZERO_HASH : node.chain[i - 1].blockHash
      if (block.prevHash !== expectedPrev) problems.push(`block ${i}: chain link broken`)
      if (block.recordHash !== sha512hex(canonicalBytes(block.record))) {
        problems.push(`block ${i}: record hash does not match the record`)
      }
      if (block.recordsRoot !== merkleRoot(leaves)) problems.push(`block ${i}: records root does not match`)

      const good = attestations.filter((a) => {
        const n = this.nodes.find((x) => x.id === a.nodeId)
        if (!n) return false
        const previous = lastCounter.get(a.nodeId) ?? 0
        if (a.counter <= previous) {
          problems.push(`block ${i}: ${a.nodeName}'s counter went backwards`)
          return false
        }
        lastCounter.set(a.nodeId, a.counter)
        return verify(
          n.identity.dsa.publicKey,
          unb64(a.sig),
          attestationMessage(this.ledgerId, block.height, blockHash, a.counter),
          SIG_CONTEXT.attestation,
        )
      })
      if (good.length < this.quorum) {
        problems.push(`block ${i}: ${good.length} valid attestations, ${this.quorum} required`)
      }

      if (isSigned(block.record)) {
        const standing = this.standingAt(node.chain, block.height, block.signerFp)
        if (!standing.enrolled || !standing.identity) {
          problems.push(`block ${i}: signer was not enrolled at that point`)
        } else if (
          !verify(
            standing.identity.dsaPublicKey,
            unb64(block.recordSig),
            canonicalBytes(block.record),
            SIG_CONTEXT.record,
          )
        ) {
          problems.push(`block ${i}: the officer's signature does not verify`)
        }
      }
    }

    const tip = node.chain[node.chain.length - 1]
    return {
      nodeId: node.id,
      nodeName: node.name,
      location: node.location,
      ok: problems.length === 0,
      height: tip.height,
      counter: node.counter,
      tipHash: tip.blockHash,
      problems,
    }
  }

  verifyAll() {
    if (this.verifyCache && this.verifyCache.epoch === this.epoch) return this.verifyCache.result
    const result = this.computeVerifyAll()
    this.verifyCache = { epoch: this.epoch, result }
    return result
  }

  private computeVerifyAll() {
    const verdicts = this.nodes.map((n) => this.verifyNode(n))
    const tally = new Map<string, string[]>()
    for (const v of verdicts) {
      if (!v.ok) continue
      tally.set(v.tipHash, [...(tally.get(v.tipHash) ?? []), v.nodeName])
    }
    let majorityTip: string | null = null
    let agreeing: string[] = []
    for (const [hash, names] of tally) {
      if (names.length > agreeing.length) {
        majorityTip = hash
        agreeing = names
      }
    }
    const divergent = verdicts.filter((v) => !v.ok || v.tipHash !== majorityTip).map((v) => v.nodeName)
    return { verdicts, majorityTip, agreeing, divergent }
  }

  authoritative(): LedgerNode | null {
    const { majorityTip, agreeing } = this.verifyAll()
    if (!majorityTip || agreeing.length < this.quorum) return null
    return this.nodes.find((n) => n.name === agreeing[0]) ?? null
  }

  /* --------------------------------------------------------------- proofs */

  treeHead(): TreeHead | null {
    const node = this.authoritative()
    if (!node) return null
    const root = merkleRoot(node.chain.map((b) => recordLeaf(b.record)))
    const message = treeHeadMessage(this.ledgerId, node.chain.length, root)
    const tip = node.chain[node.chain.length - 1].blockHash
    const signedBy = this.nodes
      .filter((n) => n.chain.length === node.chain.length && n.chain[n.chain.length - 1].blockHash === tip)
      .map((n) => ({
        nodeId: n.id,
        nodeName: n.name,
        sig: b64(sign(n.identity.dsa.secretKey, message, SIG_CONTEXT.treeHead)),
      }))
    return { size: node.chain.length, root, signedBy }
  }

  verifyTreeHead(head: TreeHead): boolean {
    const message = treeHeadMessage(this.ledgerId, head.size, head.root)
    const good = head.signedBy.filter((s) => {
      const n = this.nodes.find((x) => x.id === s.nodeId)
      return n ? verify(n.identity.dsa.publicKey, unb64(s.sig), message, SIG_CONTEXT.treeHead) : false
    })
    return good.length >= this.quorum
  }

  inclusionProof(height: number): { leaf: string; proof: string[]; root: string; size: number } | null {
    const node = this.authoritative()
    if (!node || height < 0 || height >= node.chain.length) return null
    const leaves = node.chain.map((b) => recordLeaf(b.record))
    return {
      leaf: hex(leaves[height]),
      proof: merkleProof(leaves, height),
      root: merkleRoot(leaves),
      size: leaves.length,
    }
  }

  verifyInclusion(height: number, leaf: string, proof: string[], size: number, root: string): boolean {
    return verifyProof(Buffer.from(leaf, 'hex'), proof, height, size, root)
  }

  consistency(from: number): { from: number; to: number; proof: string[]; oldRoot: string; newRoot: string } | null {
    const node = this.authoritative()
    if (!node || from < 0 || from > node.chain.length) return null
    const leaves = node.chain.map((b) => recordLeaf(b.record))
    return {
      from,
      to: leaves.length,
      proof: consistencyProof(leaves, from),
      oldRoot: merkleRoot(leaves.slice(0, from)),
      newRoot: merkleRoot(leaves),
    }
  }

  static checkConsistency(from: number, to: number, oldRoot: string, newRoot: string, proof: string[]): boolean {
    return verifyConsistency(from, to, oldRoot, newRoot, proof)
  }

  /* -------------------------------------------------------------- anchors */

  /** Take the current tree head out of the attesters' custody. */
  takeAnchor(witness: string): Anchor | null {
    const head = this.treeHead()
    if (!head) return null
    const seq = this.anchorLog.length
    const takenAt = new Date().toISOString()
    const message = anchorMessage(this.ledgerId, seq, head.size, head.root, takenAt)

    const anchor: Anchor = {
      seq,
      size: head.size,
      root: head.root,
      takenAt,
      witness,
      attesterSigs: head.signedBy.map((s) => {
        const n = this.nodes.find((x) => x.id === s.nodeId)!
        return {
          nodeId: n.id,
          nodeName: n.name,
          sig: b64(sign(n.identity.dsa.secretKey, message, SIG_CONTEXT.treeHead)),
        }
      }),
      slhDsaSig: b64(slh_dsa_sha2_128f.sign(message, this.anchorKey.secretKey)),
      slhDsaPublicKey: b64(this.anchorKey.publicKey),
    }

    this.anchorLog.push(anchor)
    this.store?.putAnchor(this.session, this.ledgerId, seq, JSON.stringify(anchor))
    this.touch()
    return anchor
  }

  anchors(): Anchor[] {
    return this.anchorLog
  }

  /**
   * Check the log still extends every anchor ever taken. This is the only check
   * that survives everyone who keeps the log agreeing to lie, and it reaches back
   * only as far as the last anchor.
   */
  verifyAnchors(): { ok: boolean; checked: number; lastAnchor: Anchor | null; problems: string[]; coversUpTo: number } {
    const problems: string[] = []
    const node = this.authoritative()
    if (!node) return { ok: false, checked: 0, lastAnchor: null, problems: ['no authoritative chain'], coversUpTo: 0 }
    const leaves = node.chain.map((b) => recordLeaf(b.record))

    for (const anchor of this.anchorLog) {
      const message = anchorMessage(this.ledgerId, anchor.seq, anchor.size, anchor.root, anchor.takenAt)

      if (!slh_dsa_sha2_128f.verify(unb64(anchor.slhDsaSig), message, unb64(anchor.slhDsaPublicKey))) {
        problems.push(`anchor ${anchor.seq}: the hash-based signature does not verify`)
      }
      const good = anchor.attesterSigs.filter((s) => {
        const n = this.nodes.find((x) => x.id === s.nodeId)
        return n ? verify(n.identity.dsa.publicKey, unb64(s.sig), message, SIG_CONTEXT.treeHead) : false
      })
      if (good.length < this.quorum) problems.push(`anchor ${anchor.seq}: only ${good.length} attester signatures`)

      if (anchor.size > leaves.length) {
        problems.push(`anchor ${anchor.seq}: the log is shorter now than when it was anchored`)
        continue
      }
      const proof = consistencyProof(leaves, anchor.size)
      if (!verifyConsistency(anchor.size, leaves.length, anchor.root, merkleRoot(leaves), proof)) {
        problems.push(`anchor ${anchor.seq}: the log no longer extends this anchor, so history was rewritten`)
      }
    }

    const last = this.anchorLog[this.anchorLog.length - 1] ?? null
    return { ok: problems.length === 0, checked: this.anchorLog.length, lastAnchor: last, problems, coversUpTo: last?.size ?? 0 }
  }

  /* --------------------------------------------------------------- lookup */

  records(): SignedRecord[] {
    const node = this.authoritative() ?? this.nodes[0]
    return node.chain.map((b) => b.record).filter(isSigned)
  }

  issuancesFor(docId: string): { record: IssuanceRecord; height: number }[] {
    const node = this.authoritative() ?? this.nodes[0]
    return node.chain
      .filter((b) => isIssuance(b.record) && b.record.docId === docId)
      .map((b) => ({ record: b.record as IssuanceRecord, height: b.height }))
  }

  findIssuance(docId: string, recipientFp: string): { block: Block } | null {
    const node = this.authoritative()
    if (!node) return null
    const block = node.chain.find(
      (b) => isIssuance(b.record) && b.record.docId === docId && b.record.recipientFp === recipientFp,
    )
    return block ? { block } : null
  }

  documentIds(): string[] {
    const node = this.authoritative() ?? this.nodes[0]
    const ids = new Set<string>()
    for (const b of node.chain) if (isIssuance(b.record)) ids.add(b.record.docId)
    return [...ids]
  }

  enrolledCount(): number {
    const node = this.authoritative() ?? this.nodes[0]
    return node.chain.filter((b) => isEnrolment(b.record)).length
  }

  standingOf(fp: string): KeyStanding {
    const node = this.authoritative() ?? this.nodes[0]
    return this.standingAt(node.chain, node.chain.length, fp)
  }

  /** Demo only: edit one attester's stored history to show what detection looks like. */
  tamper(args: {
    nodeId: string
    height: number
    field: 'recipientName' | 'copySha512' | 'issuedAt'
    value: string
    rehash: boolean
  }) {
    const node = this.nodes.find((n) => n.id === args.nodeId)
    if (!node) throw new CnsaError('no_such_node', `no ledger node ${args.nodeId}`)
    const block = node.chain[args.height]
    if (!block || !isIssuance(block.record)) {
      throw new CnsaError('no_such_block', `${node.name} has no issuance record at height ${args.height}`)
    }
    const before = block.record[args.field]
    block.record[args.field] = args.value
    if (args.rehash) {
      block.recordHash = sha512hex(canonicalBytes(block.record))
      const { blockHash, attestations, ...body } = block
      block.blockHash = bodyHash(body)
    }
    this.store?.putBlock(this.session, this.ledgerId, node.id, block.height, JSON.stringify(block))
    this.touch()
    return { before, after: args.value }
  }

  snapshot() {
    const { verdicts, majorityTip, agreeing, divergent } = this.verifyAll()
    const head = this.treeHead()
    const anchorState = this.verifyAnchors()
    return {
      ledgerId: this.ledgerId,
      quorum: this.quorum,
      nodeCount: this.nodes.length,
      majorityTip,
      agreeing,
      divergent,
      treeHead: head,
      anchors: {
        count: anchorState.checked,
        ok: anchorState.ok,
        problems: anchorState.problems,
        coversUpTo: anchorState.coversUpTo,
        last: anchorState.lastAnchor
          ? {
              seq: anchorState.lastAnchor.seq,
              size: anchorState.lastAnchor.size,
              root: anchorState.lastAnchor.root,
              takenAt: anchorState.lastAnchor.takenAt,
              witness: anchorState.lastAnchor.witness,
              slhDsaBytes: unb64(anchorState.lastAnchor.slhDsaSig).length,
            }
          : null,
      },
      nodes: this.nodes.map((n) => {
        const verdict = verdicts.find((v) => v.nodeId === n.id)!
        return {
          id: n.id,
          name: n.name,
          location: n.location,
          ok: verdict.ok,
          problems: verdict.problems,
          height: verdict.height,
          counter: verdict.counter,
          tipHash: verdict.tipHash,
          onMajority: verdict.ok && verdict.tipHash === majorityTip,
          blocks: n.chain.map((b) => ({
            height: b.height,
            blockHash: b.blockHash,
            prevHash: b.prevHash,
            recordsRoot: b.recordsRoot,
            attestations: b.attestations.map((a) => a.nodeName),
            record: b.record,
          })),
        }
      }),
    }
  }
}

/** The officer signs their own record, on their card, with the record context. */
export function signRecord(
  card: { sign(message: Uint8Array, context?: Uint8Array): Uint8Array },
  record: SignedRecord,
): Uint8Array {
  return card.sign(canonicalBytes(record), SIG_CONTEXT.record)
}

function serialiseIdentity(identity: Identity) {
  return {
    name: identity.name,
    role: identity.role,
    fp: identity.fp,
    kem: { publicKey: b64(identity.kem.publicKey), secretKey: b64(identity.kem.secretKey) },
    dsa: { publicKey: b64(identity.dsa.publicKey), secretKey: b64(identity.dsa.secretKey) },
  }
}

function reviveIdentity(raw: ReturnType<typeof serialiseIdentity>): Identity {
  return {
    name: raw.name,
    role: raw.role,
    fp: raw.fp,
    kem: { publicKey: unb64(raw.kem.publicKey), secretKey: unb64(raw.kem.secretKey) },
    dsa: { publicKey: unb64(raw.dsa.publicKey), secretKey: unb64(raw.dsa.secretKey) },
  }
}

export { utf8, sha512 }

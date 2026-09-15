import { useState } from 'react'
import { api, type LedgerBlock, type WorldState } from '../api.ts'
import { QuorumStrip, QuorumTable } from './Quorum.tsx'
import { ProofLadder } from './ProofLadder.tsx'

function short(hash: string, head = 8, tail = 6): string {
  return hash.length <= head + tail + 2 ? hash : `${hash.slice(0, head)}…${hash.slice(-tail)}`
}

function ago(iso: string | undefined): string {
  if (!iso) return ''
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 10) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  return new Date(iso).toLocaleTimeString()
}

/**
 * A record in the log, said in English.
 *
 * The hashes are the evidence but they are not the point, and a wall of them is
 * how a log stops being read. So the sentence comes first and the machine values
 * sit behind a disclosure for anyone who wants to check them.
 */
function Entry({
  block,
  state,
  fresh,
  selected,
  onSelect,
}: {
  block: LedgerBlock
  state: WorldState
  fresh: boolean
  selected: string | null
  onSelect: (name: string | null) => void
}) {
  const record = block.record
  const officer = state.officers.find((o) => o.name === record.recipientName)
  const who = officer ? `${officer.rank} ${officer.name}` : record.recipientName
  const quorum = state.ledger.quorum
  const attested = block.attestations.length

  let line: React.ReactNode
  let when: string | undefined

  if (record.v === 'cnsa2-genesis/1') {
    line = (
      <>
        <b>Ledger opened.</b> {record.roster?.length ?? 0} attesters enrolled, {record.quorum} of them must agree before
        anything is recorded.
      </>
    )
  } else if (record.v === 'cnsa2-enrol/1') {
    when = record.enrolledAt
    line = (
      <>
        <b>
          {record.rank} {record.name}
        </b>{' '}
        was issued a card. Every signature that officer makes from here on is checked against this entry.
      </>
    )
  } else if (record.v === 'cnsa2-revoke/1') {
    when = record.revokedAt
    line = (
      <>
        <b>{record.name}</b>'s card was withdrawn: {record.reason}. Anything it signed before this entry still stands.
      </>
    )
  } else if (record.v === 'cnsa2-break-glass/1') {
    when = record.openedAt
    line = (
      <>
        <b>{who}</b> opened <b>{record.docName}</b> at {record.terminal} while the attesters were unreachable, using a
        single-use token. This entry is the reconciliation of that release.
      </>
    )
  } else if (record.v === 'cnsa2-issue/1') {
    when = record.issuedAt
    line = (
      <>
        <b>{who}</b> was issued <b>{record.docName}</b> at {record.terminal}.
      </>
    )
  } else {
    when = record.openedAt
    line = (
      <>
        <b>{who}</b> opened their copy again at {record.terminal}. Same file, so no new copy was made.
      </>
    )
  }

  const mine = Boolean(record.name ?? record.recipientName)
  const subject = record.recipientName ?? record.name ?? null
  const isSelected = Boolean(subject && subject === selected)

  return (
    <div
      className={`entry ${fresh ? 'fresh' : ''} ${isSelected ? 'sel' : ''}`}
      onClick={() => mine && onSelect(isSelected ? null : subject)}
    >
      <div className="main">
        <div className="line">{line}</div>
        <div className="meta">
          <span className={`agreed ${attested < state.ledger.nodeCount ? 'partial' : ''}`}>
            {attested} of {state.ledger.nodeCount} attesters agreed
            {attested >= quorum ? '' : ' (below quorum)'}
          </span>
          {when && <span>{'·'}</span>}
          {when && <span>{ago(when)}</span>}
        </div>
      </div>

      <details>
        <summary>show the cryptography</summary>
        <dl className="detail-grid">
          <dt>position</dt>
          <dd>#{block.height}</dd>
          <dt>signed by</dt>
          <dd>{block.attestations.join(', ')}</dd>
          {record.codewordCommit && (
            <>
              <dt>codeword</dt>
              <dd>{short(record.codewordCommit, 12, 8)} (a commitment, not the codeword)</dd>
            </>
          )}
          {record.copySha512 && (
            <>
              <dt>copy hash</dt>
              <dd>{short(record.copySha512, 12, 8)}</dd>
            </>
          )}
          <dt>block hash</dt>
          <dd>{short(block.blockHash, 12, 8)}</dd>
          <dt>links back to</dt>
          <dd>{short(block.prevHash, 12, 8)}</dd>
          <dt>log root</dt>
          <dd>{short(block.recordsRoot, 12, 8)}</dd>
        </dl>
        <div style={{ padding: '0 12px 12px' }}>
          <ProofLadder height={block.height} />
        </div>
      </details>
    </div>
  )
}

/**
 * Enrolments arrive twelve at a time and say the same thing twelve times, which
 * is how the log stopped being read: the reviewer's first sight of it was a dozen
 * identical sentences with the interesting record underneath. A run of them
 * collapses to one line and opens if anyone cares.
 */
type Group = { kind: 'run' | 'one'; blocks: LedgerBlock[] }

function groupRuns(blocks: LedgerBlock[]): Group[] {
  const out: Group[] = []
  for (const block of blocks) {
    const enrol = block.record.v === 'cnsa2-enrol/1'
    const last = out[out.length - 1]
    if (enrol && last?.kind === 'run') last.blocks.push(block)
    else out.push({ kind: enrol ? 'run' : 'one', blocks: [block] })
  }
  // A single enrolment is not a run; it reads better as itself.
  return out.map((g) => (g.kind === 'run' && g.blocks.length === 1 ? { kind: 'one' as const, blocks: g.blocks } : g))
}

export function LedgerSidebar({
  state,
  onNode,
  onState,
  selected,
  onSelect,
}: {
  state: WorldState
  onNode: (name: string) => void
  onState: (state: WorldState) => void
  selected: string | null
  onSelect: (name: string | null) => void
}) {
  const ledger = state.ledger
  const view = ledger.nodes.find((n) => n.onMajority) ?? ledger.nodes[0]
  const [proof, setProof] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const issuedCount = view.blocks.filter(
    (b) => b.record.v === 'cnsa2-issue/1' || b.record.v === 'cnsa2-break-glass/1',
  ).length
  const anchors = ledger.anchors ?? null

  async function showConsistency() {
    if (!ledger.treeHead || ledger.treeHead.size < 3) return
    const from = Math.max(1, ledger.treeHead.size - 2)
    setBusy(true)
    const result = await api.consistency(from)
    setBusy(false)
    setProof(
      result.ok && result.verified
        ? `The log at ${result.to} entries is the same log it was at ${result.from}, with entries only added to the end. Nothing was removed, reordered or rewritten. ${result.proof.length} hashes were enough to show it.`
        : 'Consistency could not be proved.',
    )
  }

  async function takeAnchor() {
    setBusy(true)
    const result = await api.anchor("the squadron's own records ashore")
    setBusy(false)
    onState(result.state)
    setProof(
      result.ok && result.anchor
        ? `The log at ${result.anchor.size} entries was signed by the attesters and again with a hash-based signature (SLH-DSA, ${result.anchor.slhDsaBytes} bytes, chosen because it rests on nothing but the hash function), and that pair of signatures has left this machine. Anyone holding it can now tell whether a later copy of the log is the same log. Rewriting history from here needs the people who hold the anchor to cooperate.`
        : 'No anchor could be taken.',
    )
  }

  async function toggleAttesters() {
    setBusy(true)
    const result = await api.setAttesters(!state.attestersReachable)
    setBusy(false)
    onState(result.state)
  }

  async function reconcile() {
    setBusy(true)
    const result = await api.reconcile()
    setBusy(false)
    onState(result.state)
    setProof(
      result.committed > 0
        ? `${result.committed} release${result.committed === 1 ? '' : 's'} made while the attesters were unreachable ${result.committed === 1 ? 'has' : 'have'} now been written into the log. Nothing was lost by going ahead without quorum; it was only recorded late, and the record says so.`
        : 'There was nothing waiting to be reconciled.',
    )
  }

  async function reset() {
    const result = await api.reset()
    onState(result.state)
    setProof(null)
  }

  return (
    <>
      <div className="ledger-head">
        <h2>The ledger</h2>
        <button className="ghost small" onClick={reset}>
          start over
        </button>
      </div>

      {/*
        * One summary line the reviewer always sees, and the machinery behind two
        * disclosures. Four bordered panels stacked above the log meant the log,
        * which is the thing worth reading, started below the fold.
        */}
      <div className="log-state">
        <QuorumStrip state={state} onNode={onNode} />
        {ledger.treeHead && (
          <div className="summary">
            <b>
              {issuedCount} {issuedCount === 1 ? 'copy' : 'copies'} issued
            </b>{' '}
            across {ledger.treeHead.size} entries
            {anchors && anchors.count > 0 && (
              <>
                {' · '}
                <span className={anchors.ok ? 'good' : 'bad'}>
                  {anchors.count} anchor{anchors.count === 1 ? '' : 's'} held outside
                </span>
              </>
            )}
          </div>
        )}
      </div>

      {ledger.divergent.length > 0 && (
        <div className="banner-warn">
          <b>{ledger.divergent.join(', ')}</b> no longer matches the others and has been outvoted. The remaining{' '}
          {ledger.agreeing.length} still meet quorum, so the log still answers.
        </div>
      )}

      <details className="drawer">
        <summary>the four attesters</summary>
        <p className="note">
          Four machines in four places under four custodians. {ledger.quorum} have to agree before anything is
          recorded, which is sized to survive one hostile operator rather than one that has merely crashed.
        </p>
        <QuorumTable state={state} onNode={onNode} />
        <button className="small" onClick={showConsistency} disabled={busy || (ledger.treeHead?.size ?? 0) < 3}>
          prove nothing was rewritten
        </button>
      </details>

      <details className="drawer">
        <summary>custody controls</summary>
        <div className="row">
          <button className="small" onClick={takeAnchor} disabled={busy || !ledger.treeHead}>
            take an anchor out of custody
          </button>
          <button className="small" onClick={toggleAttesters} disabled={busy}>
            {state.attestersReachable ? 'cut the attesters off' : 'bring the attesters back'}
          </button>
          {state.pendingBreakGlass.length > 0 && (
            <button className="small warn" onClick={reconcile} disabled={busy}>
              reconcile {state.pendingBreakGlass.length} release
              {state.pendingBreakGlass.length === 1 ? '' : 's'}
            </button>
          )}
        </div>
        {anchors && (
          <div className={`anchor-state ${anchors.ok ? '' : 'bad'}`}>
            {anchors.count === 0 ? (
              <>
                No anchor has been taken yet. Until one is, four machines that all agree can still be rewritten together
                by whoever holds all four.
              </>
            ) : anchors.ok ? (
              <>
                {anchors.count} anchor{anchors.count === 1 ? '' : 's'} held outside these machines, covering the first{' '}
                {anchors.coversUpTo} entries. The log still matches every one of them.
              </>
            ) : (
              <>The log no longer matches an anchor that left this machine: {anchors.problems[0]}</>
            )}
          </div>
        )}
      </details>

      <div className="loose">
        {!state.attestersReachable && (
          <div className="banner-warn">
            The attesters cannot be reached. Nothing can be recorded, so nothing can be opened the normal way. An
            officer holding a break-glass token can still read their copy, and that release reconciles into the log when
            the attesters come back.
          </div>
        )}
      </div>

      {proof && <div className="proof-out">{proof}</div>}

      <div className="entries">
        {groupRuns(view.blocks.slice().reverse().slice(0, showAll ? undefined : 8)).map((group, gi) =>
          group.kind === 'run' ? (
            <details key={`run-${group.blocks[0].height}`} className="entry-run">
              <summary>
                <b>{group.blocks.length} cards were issued</b>, one per officer
              </summary>
              <div className="inner">
                {group.blocks.map((block) => (
                  <Entry key={block.height} block={block} state={state} fresh={false} selected={selected} onSelect={onSelect} />
                ))}
              </div>
            </details>
          ) : (
            <Entry
              key={group.blocks[0].height}
              block={group.blocks[0]}
              state={state}
              fresh={gi === 0 && group.blocks[0].height > 0}
              selected={selected}
              onSelect={onSelect}
            />
          ),
        )}
        {view.blocks.length > 8 && (
          <button className="ghost small" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'show fewer' : `show all ${view.blocks.length} entries`}
          </button>
        )}
      </div>
    </>
  )
}

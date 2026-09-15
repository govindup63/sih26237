import { imageUrl, type Candidate, type ProofBundle, type WorldState } from '../api.ts'
import { CodewordGrid } from './CodewordGrid.tsx'

/**
 * The conclusion, and everything needed to disagree with it.
 *
 * Two rules govern this panel. The first is that the claim is about a *file*,
 * not about a person's conduct: this system can establish whose copy something
 * is, and it cannot establish who sent it anywhere. Forensic reporting practice
 * calls that the source-level and activity-level distinction, and running them
 * together is the fastest way to lose a knowledgeable room.
 *
 * The second is that the evidence is the whole field, not the winner. One row
 * proves nothing. The eight flat bars are the exhibit, so every officer stays on
 * the chart with a zero-based axis and a drawn threshold.
 */
export function Finding({
  proof,
  state,
  subject,
}: {
  proof: ProofBundle
  state: WorldState
  subject: string | null
}) {
  const v = proof.verdict
  const named =
    v.kind === 'ATTRIBUTED' ? [v.candidate] : v.kind === 'COLLUSION_SET' ? v.members : []
  const isNamed = named.length > 0

  const ranked = [...proof.candidates].sort((a, b) => a.rate - b.rate)
  const top = ranked[0]
  const runnerUp = ranked.find((c) => !named.some((n) => n.recipientFp === c.recipientFp) && c !== top) ?? ranked[1]
  const margin = top && runnerUp ? runnerUp.rate - top.rate : 0
  const threshold = Number(state.config.tier1Tau ?? 0.2)

  const rankOf = (name: string) => {
    const officer = state.officers.find((o) => o.name === name)
    return officer ? `${officer.rank} ${officer.name}` : name
  }

  return (
    <div className="finding">
      <div className={`headline ${isNamed ? 'named' : 'silent'}`}>
        <div className="k mono">{v.kind.replace(/_/g, ' ')}</div>
        <h3>{proposition(proof, rankOf)}</h3>
        <p className="what-not">
          This says whose copy the file is. It does not say who transmitted it, when, or why.
        </p>
      </div>

      {proof.reading && (
        <div className="decompose">
          <Row
            k="Tiles recovered"
            v={`${proof.reading.readableCount} of ${proof.reading.totalTiles}`}
            ok={proof.reading.readableCount >= Number(state.config.minReadable ?? 32)}
          />
          <Row k="Mean confidence" v={`${proof.reading.meanAbsZ.toFixed(1)} against a gate of ${state.config.zThreshold}`} />
          <Row k="Officers evaluated" v={`${proof.candidates.length} of ${proof.candidates.length}`} />
          {top && <Row k="Closest" v={`${top.recipientName}, ${top.errors} of ${top.counted} tiles wrong`} />}
          {runnerUp && (
            <Row
              k="Next closest"
              v={`${runnerUp.recipientName}, ${runnerUp.errors} of ${runnerUp.counted} wrong · margin ${(margin * 100).toFixed(0)} points`}
            />
          )}
          <Row k="Documents considered" v={String(proof.documentsConsidered)} />
          {proof.reading.resized && <Row k="Geometry" v="resized back to the sealed dimensions before reading" />}
        </div>
      )}

      {subject && (
        <div className="thumbs">
          <div className="thumb">
            <img src={imageUrl(`/api/copy/${encodeURIComponent(subject)}.png`)} alt="" />
            <div className="cap">the exhibit as the investigator received it</div>
          </div>
        </div>
      )}

      {ranked.length > 0 && (
        <div className="chart">
          <div className="note chart-cap">
            Every officer on the distribution list, none dropped. The bar is the share of readable tiles that disagree
            with that officer's key set, so a bar at the far left means the file behaves exactly like their copy and a
            bar near the middle means it behaves like a coin toss.
          </div>
          <div className="bars" style={{ ['--thr' as string]: `${threshold * 100}%` }}>
            <div className="thr-line" title={`accusation threshold ${(threshold * 100).toFixed(0)}%`}>
              <span className="mono">{(threshold * 100).toFixed(0)}% threshold</span>
            </div>
            {ranked.map((c) => (
              <div key={c.recipientFp} className={`barrow ${named.some((n) => n.recipientFp === c.recipientFp) ? 'hit' : ''}`}>
                <span className="nm">{c.recipientName}</span>
                <span className="track">
                  <i style={{ width: `${Math.max(0.6, c.rate * 100)}%` }} />
                </span>
                <span className="pct mono">
                  {c.errors}/{c.counted}
                </span>
              </div>
            ))}
          </div>
          <div className="axis mono">
            <span>0%</span>
            <span>50%</span>
            <span>100% of readable tiles disagree</span>
          </div>
        </div>
      )}

      <div>
        <div className="note" style={{ marginBottom: 7 }}>
          The mark as it was read back. Pale tiles were damaged past the point of reading and were left out of every
          count above rather than guessed at.
        </div>
        <CodewordGrid tiles={proof.tiles} gridW={Number(state.config.gridW ?? 16)} />
      </div>

      <Tiers proof={proof} />

      <div className="boundary">
        <div>
          <b>What this does not establish.</b> Whose copy the file is, not who moved it. The binding between a key set
          and a person comes from how the card was issued, which is an administrative record, not a proof.
        </div>
        <div>
          <b>What would change it.</b> A different sealed document, a card issued to the wrong person, or an exhibit
          damaged below {String(state.config.minReadable)} readable tiles, at which point this returns silence instead of
          a name.
        </div>
        <div>
          <b>How it fails.</b> Under heavy compression or a crop it reports NO_WATERMARK rather than guessing. Two
          officers averaging their copies are reported as a set, and neither is separated from the other.
        </div>
      </div>
    </div>
  )
}

function Row({ k, v, ok }: { k: string; v: string; ok?: boolean }) {
  return (
    <div className="drow">
      <span className="dk">{k}</span>
      <span className={`dv ${ok === false ? 'bad' : ''}`}>{v}</span>
    </div>
  )
}

const TIER_TITLE: Record<string, { title: string; blurb: string }> = {
  cryptographic: {
    title: 'Cryptographic',
    blurb: 'Holds without trusting this program. Anyone with the published public keys can redo these.',
  },
  derived: {
    title: 'Derived',
    blurb: 'Measurements this program made. Another implementation of the detector should reproduce them.',
  },
  asserted: {
    title: 'Asserted',
    blurb: 'Taken on the word of whoever issued the cards. No cryptography establishes these.',
  },
}

function Tiers({ proof }: { proof: ProofBundle }) {
  const order: string[] = ['cryptographic', 'derived', 'asserted']
  return (
    <div className="tiers">
      {order.map((tier) => {
        const rows = proof.checks.filter((c) => (c.tier ?? 'derived') === tier)
        if (rows.length === 0) return null
        return (
          <div key={tier} className={`tier ${tier}`}>
            <div className="th">
              <b>{TIER_TITLE[tier].title}</b>
              <span className="note">{TIER_TITLE[tier].blurb}</span>
            </div>
            <ul className="checks">
              {rows.map((check, i) => (
                <li key={i}>
                  <span className={`mark ${check.ok ? '' : 'bad'}`}>{check.ok ? '✓' : '×'}</span>
                  <div>
                    <div>{check.label}</div>
                    <div className="d">{check.detail}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </div>
  )
}

/**
 * The headline, written as a pair of propositions so the alternative is on screen
 * next to the conclusion instead of being left for the reader to supply.
 */
function proposition(proof: ProofBundle, rankOf: (name: string) => string): string {
  const v = proof.verdict
  const field = proof.candidates.length
  if (v.kind === 'ATTRIBUTED') {
    return `The exhibit is the copy issued to ${rankOf(v.candidate.recipientName)}, rather than a copy issued to any of the other ${field - 1} officers.`
  }
  if (v.kind === 'COLLUSION_SET') {
    const names = v.members.map((m) => rankOf(m.recipientName)).join(' and ')
    return `The exhibit was built from the copies issued to ${names}, rather than from any one officer's copy alone.`
  }
  if (v.kind === 'NO_WATERMARK') {
    return 'This image carries no mark from any document this service has sealed. No officer is named.'
  }
  if (v.kind === 'GEOMETRY_MISMATCH') {
    return 'The exhibit is not the shape any sealed document was issued in, so no reading was attempted.'
  }
  return `The evidence does not separate one officer from the rest of the ${field}. No name is given.`
}

export type { Candidate }

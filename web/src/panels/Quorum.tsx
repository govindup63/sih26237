import type { LedgerNodeView, WorldState } from '../api.ts'

/**
 * Four machines, and whether they are saying the same thing.
 *
 * A single "verified" badge is one assertion. Four separately named machines,
 * in four places, each printing its own root, is a different kind of claim, and
 * it survives disagreement: a node that diverges stays fully legible with its
 * own hash on show, because that node is not broken, it is honestly signing a
 * different history.
 *
 * State is carried by shape as well as colour (filled, hollow, crossed) and the
 * dissenting node gets a text tag, because roughly one man in twelve cannot tell
 * this red from this green.
 */
export function QuorumStrip({
  state,
  onNode,
  compact,
}: {
  state: WorldState
  onNode?: (name: string) => void
  compact?: boolean
}) {
  const nodes = state.ledger.nodes
  const agreeing = nodes.filter((n) => n.ok && n.onMajority)
  const quorum = state.ledger.quorum

  return (
    <div className={`quorum ${compact ? 'compact' : ''}`}>
      <div className="bricks">
        {nodes.map((node) => (
          <button
            key={node.id}
            className={`brick ${brickClass(node)}`}
            title={`${node.name} · ${node.location} · height ${node.height}`}
            onClick={() => onNode?.(node.name)}
          >
            {brickClass(node) === 'dissent' ? '×' : ''}
          </button>
        ))}
      </div>
      <div className="quorum-line">
        <b className="mono">
          {agreeing.length} of {nodes.length}
        </b>{' '}
        attesters agree{agreeing.length < nodes.length && <span className="dissent-tag mono">DISSENT</span>}
        <span className="note"> · quorum is {quorum}</span>
      </div>
    </div>
  )
}

export function QuorumTable({ state, onNode }: { state: WorldState; onNode?: (name: string) => void }) {
  const head = state.ledger.treeHead
  return (
    <table className="attesters">
      <thead>
        <tr>
          <th>Attester</th>
          <th>Where</th>
          <th>Entries</th>
          <th>Root</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {state.ledger.nodes.map((node) => {
          const cls = brickClass(node)
          return (
            <tr key={node.id} className={cls} onClick={() => onNode?.(node.name)}>
              <td className="nm">{node.name.replace('-node', '')}</td>
              <td className="loc">{node.location}</td>
              <td className="mono num">{node.height}</td>
              <td className="mono hash">{node.tipHash.slice(0, 12)}</td>
              <td>
                {cls === 'dissent' ? (
                  <span className="dissent-tag mono">DISSENT</span>
                ) : cls === 'agree' ? (
                  'agrees'
                ) : (
                  'pending'
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
      {head && (
        <tfoot>
          <tr>
            <td colSpan={2}>signed tree head</td>
            <td className="mono num">{head.size}</td>
            <td className="mono hash">{head.root.slice(0, 12)}</td>
            <td className="note">{head.signedBy.length} signatures</td>
          </tr>
        </tfoot>
      )}
    </table>
  )
}

function brickClass(node: LedgerNodeView): 'agree' | 'dissent' | 'pending' {
  if (!node.ok || !node.onMajority) return 'dissent'
  return node.height > 0 ? 'agree' : 'pending'
}

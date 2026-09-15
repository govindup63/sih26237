import { useState } from 'react'
import { api, type WorldState } from '../api.ts'
import { Modal } from '../panels/Modal.tsx'

/**
 * Let the reviewer be the attacker. Rewriting one attester's copy of the log is
 * the moment the design either holds or does not, and doing it by hand is far
 * more convincing than being told about it.
 */
export function NodeModal({
  attesterName,
  state,
  onClose,
  onState,
}: {
  attesterName: string
  state: WorldState
  onClose: () => void
  onState: (state: WorldState) => void
}) {
  const node = state.ledger.nodes.find((n) => n.name === attesterName)!
  const issuances = node.blocks.filter((b) => b.record.v === 'cnsa2-issue/1')
  const [height, setHeight] = useState(issuances[0]?.height ?? 1)
  const [value, setValue] = useState('eve')
  const [result, setResult] = useState<string | null>(null)

  async function tamper() {
    const response = await api.tamper(node.id, height, 'recipientName', value, false)
    if (response.ok && response.change) {
      setResult(`You changed "${response.change.before}" to "${response.change.after}" on ${node.name}.`)
      onState(response.state)
    } else {
      setResult(response.error ?? 'refused')
    }
  }

  const healthy = node.ok && node.onMajority

  return (
    <Modal title={node.name} where={node.location} onClose={onClose}>
      <div className="explain">
        This is one of the four machines that keep the log. Try rewriting a record in <strong>its copy only</strong>,
        then look at what the other three do about it. Quorum is {state.ledger.quorum} of {state.ledger.nodeCount},
        which is sized to survive one <em>hostile</em> operator, not merely one that has crashed.
      </div>

      {issuances.length === 0 ? (
        <p className="note">This attester holds no issued records yet. Open a document as an officer first.</p>
      ) : (
        <div className="row">
          <div className="field">
            <label>record</label>
            <select value={height} onChange={(event) => setHeight(Number(event.target.value))}>
              {issuances.map((b) => (
                <option key={b.height} value={b.height}>
                  #{b.height} — issued to {b.record.recipientName}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>say it went to</label>
            <input value={value} onChange={(event) => setValue(event.target.value)} size={10} />
          </div>
          <button className="danger" onClick={tamper}>
            rewrite it
          </button>
        </div>
      )}

      {result && (
        <div className={`verdict ${healthy ? 'silent' : 'silent'}`}>
          <div className="k">result</div>
          <h3>{healthy ? 'Still on the majority view' : 'Caught and outvoted'}</h3>
          <p>
            {result}{' '}
            {healthy
              ? 'The other attesters have not noticed a difference yet.'
              : `The other ${state.ledger.agreeing.length} attesters do not have that change, so this one no longer matches them. They still meet quorum, so the log still answers, and the investigation reads from them instead.`}
          </p>
        </div>
      )}

      {node.problems.length > 0 && (
        <div>
          <div className="note" style={{ marginBottom: 6 }}>What this machine now fails:</div>
          <ul className="checks">
            {node.problems.map((problem, i) => (
              <li key={i}>
                <span className="mark bad">{'×'}</span>
                <div>{problem}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="attesters">
        {state.ledger.nodes.map((n) => {
          const ok = n.ok && n.onMajority
          return (
            <div key={n.id} className={`attester ${ok ? 'ok' : 'bad'}`}>
              <span className="dot" />
              <div className="nm">{n.name.replace('-node', '')}</div>
              <div className="st">{ok ? 'agrees' : 'outvoted'}</div>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}

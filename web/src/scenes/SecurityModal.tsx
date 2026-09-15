import { useEffect, useRef, useState } from 'react'
import { api, postImage, type ProofBundle, type Step, type WorldState } from '../api.ts'
import { Modal } from '../panels/Modal.tsx'
import { Steps } from '../panels/Steps.tsx'
import { Finding } from '../panels/Finding.tsx'

const DAMAGE = [
  { id: 'jpeg', label: 'compress it (JPEG 80)', strength: 80, why: 'what happens when a file is shared' },
  { id: 'jpeg', label: 'compress it hard (JPEG 50)', strength: 50, why: 'past the measured limit' },
  { id: 'resize', label: 'shrink and re-enlarge', strength: 0.5, why: 'a screenshot of a screenshot' },
  { id: 'blur', label: 'blur it', strength: 1, why: '' },
  { id: 'noise', label: 'add noise', strength: 8, why: '' },
  { id: 'brightness', label: 'brighten it', strength: 1.3, why: 'absorbed entirely' },
  { id: 'crop', label: 'crop the edges', strength: 8, why: 'refused rather than guessed' },
]

export function SecurityModal({
  state,
  onClose,
  onState,
  onAccuse,
  onTraced,
  autoTrace,
}: {
  state: WorldState
  onClose: () => void
  onState: (state: WorldState) => void
  onAccuse: (names: string[], terminals: string[]) => void
  onTraced: () => void
  /** Handed in when another room sends an exhibit straight here to be read. */
  autoTrace?: string | null
}) {
  const [selected, setSelected] = useState<string[]>([])
  const [proof, setProof] = useState<ProofBundle | null>(null)
  const [steps, setSteps] = useState<Step[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [subject, setSubject] = useState<string | null>(null)

  function toggle(copyId: string) {
    setSelected(selected.includes(copyId) ? selected.filter((c) => c !== copyId) : [...selected, copyId])
  }

  function show(bundle: ProofBundle, trace: Step[], next: WorldState, traced: string | null) {
    onState(next)
    setProof(bundle)
    setSteps(trace)
    setSubject(traced)
    onTraced()
    const v = bundle.verdict
    const names =
      v.kind === 'ATTRIBUTED'
        ? [v.candidate.recipientName]
        : v.kind === 'COLLUSION_SET'
          ? v.members.map((m) => m.recipientName)
          : []
    onAccuse(
      names,
      names.map((n) => state.officers.find((o) => o.name === n)?.homeTerminal).filter((t): t is string => Boolean(t)),
    )
  }

  // The comparison bench ends on "read this back to a name", which lands here.
  const auto = useRef<string | null>(null)
  useEffect(() => {
    if (!autoTrace || auto.current === autoTrace) return
    auto.current = autoTrace
    run(autoTrace, autoTrace)
    // run is stable enough for this: it closes over setters only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTrace])

  async function run(copyId: string, busyLabel: string) {
    setBusy(busyLabel)
    const result = await api.trace(copyId)
    setBusy(null)
    if (result.ok) show(result.proof, result.steps, result.state, copyId)
  }

  async function damageThen(copyId: string, attack: string, strength: number, label: string) {
    setBusy(label)
    const attacked = await api.attack(copyId, attack, strength)
    if (!attacked.ok) return setBusy(null)
    const result = await api.trace(attacked.copyId)
    setBusy(null)
    if (result.ok) show(result.proof, result.steps, result.state, attacked.copyId)
  }

  async function combineThen(strategy: string, label: string) {
    setBusy(label)
    const mixed = await api.collude(selected, strategy)
    if (!mixed.ok) return setBusy(null)
    const result = await api.trace(mixed.copyId)
    setBusy(null)
    if (result.ok) show(result.proof, result.steps, result.state, mixed.copyId)
  }

  async function upload(file: File) {
    setBusy('upload')
    const result = await postImage<{ ok: boolean; proof: ProofBundle; steps: Step[]; state: WorldState }>(file)
    setBusy(null)
    if (result.ok) show(result.proof, result.steps, result.state, null)
  }

  const v = proof?.verdict

  return (
    <Modal title="Security Office" where="report a leak" onClose={onClose}>
      <div className="explain">
        An image has turned up where it should not have. Exhibits are labelled by hash and never by name, so the
        forensic step is not being handed its own answer. Trace one, or damage it first, or combine two the way two
        officers comparing copies could.
      </div>

      {state.copies.length === 0 ? (
        <p className="note">No copies exist yet. Open the document as an officer first.</p>
      ) : (
        <div className="exhibits">
          {state.copies.map((copy) => (
            <div
              key={copy.copyId}
              className={`exhibit ${selected.includes(copy.copyId) ? 'sel' : ''}`}
              onClick={() => toggle(copy.copyId)}
            >
              <span className="tick">{'✓'}</span>
              <span className="grow">{copy.label}</span>
              <span className="from">{copy.docName}</span>
              <button
                className="small"
                disabled={busy !== null}
                onClick={(event) => {
                  event.stopPropagation()
                  run(copy.copyId, copy.copyId)
                }}
              >
                {busy === copy.copyId ? 'tracing…' : 'trace this'}
              </button>
            </div>
          ))}
        </div>
      )}

      {selected.length === 1 && (
        <div>
          <div className="note" style={{ marginBottom: 7 }}>
            Damage it first, the way a leaked file really would be:
          </div>
          <div className="row">
            {DAMAGE.map((d) => (
              <button
                key={d.label}
                className="small"
                disabled={busy !== null}
                title={d.why}
                onClick={() => damageThen(selected[0], d.id, d.strength, d.label)}
              >
                {busy === d.label ? 'working…' : d.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {selected.length >= 2 && (
        <div>
          <div className="note" style={{ marginBottom: 7 }}>
            {selected.length} copies selected. Officers who compare their copies can see which parts differ:
          </div>
          <div className="row">
            <button className="small" disabled={busy !== null} onClick={() => combineThen('tile', 'tiles')}>
              {busy === 'tiles' ? 'working…' : 'swap whole regions between them'}
            </button>
            <button className="small" disabled={busy !== null} onClick={() => combineThen('average', 'avg')}>
              {busy === 'avg' ? 'working…' : 'average them together'}
            </button>
            <button className="small" disabled={busy !== null} onClick={() => combineThen('median', 'med')}>
              {busy === 'med' ? 'working…' : 'take the median'}
            </button>
          </div>
        </div>
      )}

      <div className="field">
        <label>or bring in any image</label>
        <input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      </div>

      {proof && v && (
        <>
          <Finding proof={proof} state={state} subject={subject} />
          <Steps steps={steps} label="show the forensic trace" />
        </>
      )}
    </Modal>
  )
}

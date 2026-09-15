import { useRef, useState } from 'react'
import { api, imageUrl, uploadImage, type Step, type WorldState } from '../api.ts'
import { Modal } from '../panels/Modal.tsx'
import { Steps } from '../panels/Steps.tsx'

type Quality = { psnrAB: number; ssimAB: number; maxDeviation: number; worstTilePsnrAB: number }
type Sizes = { total: number; expansionFactor: number; perSlot: number }
type Screen = { at: 'locked' } | { at: 'compose' } | { at: 'sent' }

/**
 * The Commanding Officer's machine. Same three-part shape as an officer's
 * terminal, because it is the same kind of thing: a locked workstation, an
 * application, and a result. What differs is the application, which here chooses
 * a document and addresses it.
 */
export function CabinModal({
  state,
  onClose,
  onState,
}: {
  state: WorldState
  onClose: () => void
  onState: (state: WorldState) => void
}) {
  const sender = state.officers.find((o) => o.name === 'sharma') ?? state.officers[0]
  const candidates = state.officers.filter((o) => o.name !== sender.name)
  const fileInput = useRef<HTMLInputElement>(null)

  const [pin, setPin] = useState('')
  const [screen, setScreen] = useState<Screen>({ at: 'locked' })
  const [lockError, setLockError] = useState<string | null>(null)

  const [docKey, setDocKey] = useState(state.docs[0]?.key ?? '')
  const [chosen, setChosen] = useState<string[]>(candidates.filter((o) => o.cleared).map((o) => o.name))
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [steps, setSteps] = useState<Step[]>([])
  const [quality, setQuality] = useState<Quality | null>(null)
  const [sizes, setSizes] = useState<Sizes | null>(null)
  const [docId, setDocId] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<number>(0)
  const [openedAll, setOpenedAll] = useState<string[] | null>(null)

  const doc = state.docs.find((d) => d.key === docKey)

  function unlock() {
    if (pin !== sender.demoPin) {
      setLockError('That PIN did not unlock the card.')
      return
    }
    setLockError(null)
    setScreen({ at: 'compose' })
  }

  async function pickFile(file: File) {
    setBusy('upload')
    setError(null)
    try {
      const result = await uploadImage(file)
      if (!result.ok || !result.key) {
        setError(result.error ?? 'that file could not be used')
      } else {
        if (result.state) onState(result.state)
        setDocKey(result.key)
      }
    } catch {
      setError('that file could not be read as an image')
    }
    setBusy(null)
  }

  async function seal() {
    setBusy('seal')
    setError(null)
    const result = await api.seal(docKey, chosen)
    setBusy(null)
    if (!result.ok) {
      setError(result.error ?? 'the document could not be sealed')
      return
    }
    onState(result.state)
    setSteps(result.steps)
    setQuality(result.quality)
    setSizes(result.sizes)
    setDocId(result.docId)
    setSentTo(chosen.length)
    setOpenedAll(null)
    setScreen({ at: 'sent' })
  }

  async function openEveryone() {
    if (!docId) return
    setBusy('all')
    const result = await api.openAll(docId)
    setBusy(null)
    if (!result.ok) return
    onState(result.state)
    setOpenedAll(result.opened)
  }

  return (
    <Modal
      title="Commanding Officer's Cabin"
      where={screen.at === 'locked' ? 'CO-01' : `${sender.rank} ${sender.name} signed in`}
      onClose={onClose}
    >
      <div className="explain">
        {screen.at === 'locked' ? (
          <>
            The Commanding Officer's own workstation. It locks like every other machine on the ship, and whatever is
            sent from it is signed with the card that is in it.
          </>
        ) : screen.at === 'compose' ? (
          <>
            The document is encrypted <strong>once</strong>, not once per officer. Every tile of the image is encrypted
            twice over as two versions that look the same, and each officer is given the key to only one version of
            each tile, so their copy is unique before they have even opened it.
          </>
        ) : (
          <>
            Sealed and signed. It is one package for everyone, and the recipient list inside it is signed, so nobody
            can be added or removed afterwards.
          </>
        )}
      </div>

      <div className="screen" data-terminal="CO-01  ·  Commanding Officer's Cabin">
        <div className="os">
          {/* ---------------- locked ---------------- */}
          {screen.at === 'locked' && (
            <>
              <div className="os-title">
                <div className="left">
                  <span className="glyph">▣</span> Secure Terminal — locked
                </div>
                <div className="os-controls">
                  <i />
                  <i />
                  <i className="x" onClick={onClose} />
                </div>
              </div>

              <div className="lock">
                <div className="avatar">{sender.name.slice(0, 2).toUpperCase()}</div>
                <div className="nm">
                  {sender.rank} {sender.name}
                </div>
                <div className="rl">{sender.role}</div>
                <div className="pinrow">
                  <input
                    value={pin}
                    onChange={(event) => setPin(event.target.value)}
                    onKeyDown={(event) => event.key === 'Enter' && unlock()}
                    placeholder="PIN"
                    inputMode="numeric"
                    autoFocus
                  />
                  <button className="go" onClick={unlock} disabled={pin.length === 0} title="sign in">
                    →
                  </button>
                </div>
                {lockError && <div className="bad">{lockError}</div>}
                <div className="hintline">
                  PIN for this card is <code>{sender.demoPin}</code>{' '}
                  <button className="ghost small" onClick={() => setPin(sender.demoPin)}>
                    fill it
                  </button>
                </div>
              </div>

              <div className="os-status">
                <span>CO-01</span>
                <span>card reader ready</span>
              </div>
            </>
          )}

          {/* ---------------- compose ---------------- */}
          {screen.at === 'compose' && (
            <>
              <div className="os-title">
                <div className="left">
                  <span className="glyph">▤</span> Document Distribution
                </div>
                <div className="os-controls">
                  <i />
                  <i />
                  <i className="x" onClick={onClose} />
                </div>
              </div>

              <div className="os-bar">
                <span className="os-crumbs">
                  Secure Store <span style={{ opacity: 0.5 }}>›</span> <b>New distribution</b>
                </span>
                <span style={{ flex: 1 }} />
                <button className="ghost small" onClick={() => setScreen({ at: 'locked' })}>
                  sign out
                </button>
              </div>

              <div className="os-body">
                <div className="compose">
                  <div className="pane">
                    <div className="pane-h">Document</div>
                    {state.docs.map((d) => (
                      <label key={d.key} className={`pick ${docKey === d.key ? 'sel' : ''}`}>
                        <input type="radio" name="doc" checked={docKey === d.key} onChange={() => setDocKey(d.key)} />
                        <span className="grow">
                          <span className="nm">{d.name}</span>
                          <span className="sub">{d.describe}</span>
                        </span>
                      </label>
                    ))}

                    <input
                      ref={fileInput}
                      type="file"
                      accept="image/*"
                      style={{ display: 'none' }}
                      onChange={(event) => event.target.files?.[0] && pickFile(event.target.files[0])}
                    />
                    <button className="small" onClick={() => fileInput.current?.click()} disabled={busy !== null}>
                      {busy === 'upload' ? 'reading…' : '+ choose an image from this machine'}
                    </button>
                    <div className="sub">
                      Anything the browser can open. It is scaled so the long edge is at most 512 pixels, and it never
                      leaves this demo.
                    </div>
                  </div>

                  <div className="pane">
                    <div className="pane-h">Distribution list</div>
                    <div className="picks">
                      {candidates.map((o) => (
                        <label key={o.name} className="check">
                          <input
                            type="checkbox"
                            checked={chosen.includes(o.name)}
                            onChange={(event) =>
                              setChosen(event.target.checked ? [...chosen, o.name] : chosen.filter((n) => n !== o.name))
                            }
                          />
                          <span>
                            {o.rank} {o.name}
                            {!o.cleared && <span className="faint"> · not cleared</span>}
                          </span>
                        </label>
                      ))}
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <button
                        className="ghost small"
                        onClick={() => setChosen(candidates.filter((o) => o.cleared).map((o) => o.name))}
                      >
                        all cleared
                      </button>
                      <button className="ghost small" onClick={() => setChosen([])}>
                        none
                      </button>
                    </div>
                  </div>
                </div>

                {error && <div className="bad" style={{ padding: '0 14px 12px' }}>{error}</div>}
              </div>

              <div className="os-status">
                <span>
                  {doc ? doc.name : 'no document selected'} · {chosen.length} recipient
                  {chosen.length === 1 ? '' : 's'}
                </span>
                <button
                  className="primary small"
                  onClick={seal}
                  disabled={busy !== null || chosen.length === 0 || !doc}
                >
                  {busy === 'seal' ? 'encrypting…' : 'Seal and distribute'}
                </button>
              </div>
            </>
          )}

          {/* ---------------- sent ---------------- */}
          {screen.at === 'sent' && quality && sizes && docId && (
            <>
              <div className="os-title">
                <div className="left">
                  <span className="glyph">▦</span> Distribution complete
                </div>
                <div className="os-controls">
                  <i />
                  <i />
                  <i className="x" onClick={onClose} />
                </div>
              </div>

              <div className="os-bar">
                <button className="ghost small" onClick={() => setScreen({ at: 'compose' })}>
                  ← Send another
                </button>
                <span className="os-crumbs">
                  Secure Store <span style={{ opacity: 0.5 }}>›</span> <b>{doc?.name}</b>
                </span>
              </div>

              <div className="os-body">
                <div className="viewer">
                  <div className="shots">
                    <div className="shot">
                      <img src={imageUrl(`/api/original/${docId}.png`)} alt="what was sealed" />
                      <div className="cap">what was sealed · addressed to {sentTo} officers</div>
                    </div>
                  </div>

                  <div className="stat-row">
                    <span className="chip">package {Math.round(sizes.total / 1024)} KB</span>
                    <span className="chip">{sizes.expansionFactor.toFixed(2)}× the raw pixels</span>
                    <span className="chip">{sizes.perSlot} B per extra officer</span>
                    <span className="chip">PSNR {quality.psnrAB.toFixed(1)} dB</span>
                    <span className="chip">SSIM {quality.ssimAB.toFixed(3)}</span>
                    <span className="chip">largest pixel change {quality.maxDeviation}/255</span>
                  </div>

                  <p className="prose">
                    The package is twice the size of the picture because every tile is in it twice. A thirtieth officer
                    costs {sizes.perSlot} bytes, not another copy of the document. The image figures compare the two
                    versions with <em>every</em> tile different, which is the worst case; two real officers differ on
                    about half their tiles.
                  </p>

                  <div className="row">
                    <button
                      className="primary small"
                      onClick={openEveryone}
                      disabled={busy !== null || openedAll !== null}
                    >
                      {busy === 'all'
                        ? 'working…'
                        : openedAll
                          ? 'all officers have opened it'
                          : 'open it as every officer (shortcut)'}
                    </button>
                    <span className="prose" style={{ flex: 1, minWidth: 220 }}>
                      {openedAll
                        ? `${openedAll.length} officers now hold a copy. Each went through the same path a single card reader would.`
                        : 'Or close this and open them one at a time on the deck plan.'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="os-status">
                <span>
                  sealed · {sentTo} recipient{sentTo === 1 ? '' : 's'}
                </span>
                <span>{doc?.name}</span>
              </div>
            </>
          )}
        </div>
      </div>

      {screen.at === 'sent' && <Steps steps={steps} label="what the system did, step by step" />}
    </Modal>
  )
}

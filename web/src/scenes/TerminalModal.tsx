import { useEffect, useState } from 'react'
import { api, imageUrl, type SealedView, type Step, type WorldState } from '../api.ts'
import { Modal } from '../panels/Modal.tsx'
import { Steps } from '../panels/Steps.tsx'

type Screen =
  | { at: 'locked' }
  | { at: 'files' }
  | { at: 'viewing'; docId: string; copyId: string; block: number | null; again: boolean; steps: Step[] }

function when(iso: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'a moment ago'
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * The workstation, drawn as the machine itself: a locked terminal, then a file
 * browser holding the documents addressed to whoever signed in, then one of them
 * open in a viewer.
 *
 * The file list deliberately shows no thumbnail before a document is opened. A
 * preview would be the content, and the content is exactly what may not exist
 * until the ledger has recorded who is about to see it.
 */
export function TerminalModal({
  terminalId,
  state,
  onClose,
  onState,
  onJump,
}: {
  terminalId: string
  state: WorldState
  onClose: () => void
  onState: (state: WorldState) => void
  onJump: (terminalId: string) => void
}) {
  const terminal = state.terminals.find((t) => t.id === terminalId)!
  const room = state.rooms.find((r) => r.id === terminal.roomId)
  const [officerName, setOfficerName] = useState(terminal.officer ?? state.officers[1].name)
  const [pin, setPin] = useState('')
  const [screen, setScreen] = useState<Screen>({ at: 'locked' })
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const officer = state.officers.find((o) => o.name === officerName)!

  const issued = new Set(
    state.ledger.nodes[0]?.blocks
      .filter((b) => b.record.v === 'cnsa2-issue/1' && b.record.recipientName === officerName)
      .map((b) => b.record.docId) ?? [],
  )

  const mine = state.sealed.filter((s) => s.recipients.includes(officerName))
  const notMine = state.sealed.length - mine.length

  const nextTerminal = state.terminals.find((t) => {
    if (t.id === terminalId || !t.officer) return false
    const opened = new Set(
      state.ledger.nodes[0]?.blocks
        .filter((b) => b.record.v === 'cnsa2-issue/1' && b.record.recipientName === t.officer)
        .map((b) => b.record.docId) ?? [],
    )
    return state.sealed.some((s) => s.recipients.includes(t.officer!) && !opened.has(s.docId))
  })

  function signOut() {
    setScreen({ at: 'locked' })
    setPin('')
    setSelected(null)
    setMessage(null)
  }

  /*
   * The PIN is checked here only to decide what to draw. The card itself is the
   * authority: `api.open` hands the PIN to the reader, and a wrong one costs an
   * attempt there whether or not this screen was fooled. Nothing on this page
   * can sign as an officer.
   */
  function unlock() {
    if (pin !== officer.demoPin) {
      setMessage('That PIN did not unlock the card.')
      return
    }
    setMessage(null)
    setScreen({ at: 'files' })
  }

  /*
   * The path taken when quorum cannot be reached. The token was issued in advance
   * while the log was healthy and it is good once; using it is itself evidence,
   * and it reconciles into the log when the attesters come back.
   */
  async function breakGlass(doc: SealedView) {
    setBusy(doc.docId)
    setMessage(null)
    const result = await api.breakGlass(doc.docId, officerName, terminalId, pin)
    setBusy(null)
    onState(result.state)
    if (result.ok && result.copyId) {
      setScreen({
        at: 'viewing',
        docId: doc.docId,
        copyId: result.copyId,
        block: null,
        again: false,
        steps: result.steps ?? [],
      })
    } else {
      setMessage(result.error?.message ?? 'refused')
    }
  }

  async function openDoc(doc: SealedView) {
    setBusy(doc.docId)
    setMessage(null)
    const result = await api.open(doc.docId, officerName, terminalId, pin)
    setBusy(null)
    onState(result.state)
    if (result.ok && result.copy) {
      setScreen({
        at: 'viewing',
        docId: doc.docId,
        copyId: result.copy.copyId,
        block: result.block?.height ?? null,
        again: result.firstIssue === false,
        steps: result.steps ?? [],
      })
    } else {
      setMessage(result.error?.message ?? 'refused')
    }
  }

  // Enter opens whatever is selected, the way a file browser behaves.
  useEffect(() => {
    if (screen.at !== 'files') return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !selected) return
      const doc = mine.find((d) => d.docId === selected)
      if (doc) void openDoc(doc)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const viewingDoc = screen.at === 'viewing' ? state.sealed.find((s) => s.docId === screen.docId) : undefined
  const initials = officer.name.slice(0, 2).toUpperCase()

  return (
    <Modal
      title={`Workstation ${terminalId}`}
      where={screen.at === 'locked' ? room?.name : `${officer.rank} ${officer.name} signed in`}
      onClose={onClose}
    >
      <div className="explain">
        {screen.at === 'locked' ? (
          <>
            This is the machine on the desk. The officer's keys live on their card and never leave it; the PIN is what
            makes the signature evidence that <strong>a person</strong> was here, not a terminal somebody left logged
            in.
          </>
        ) : screen.at === 'files' ? (
          <>
            These are the documents addressed to <strong>{officer.name}</strong>
            {notMine > 0 && (
              <>
                . {notMine} other{notMine === 1 ? '' : 's'} on this ship {notMine === 1 ? 'is' : 'are'} not on their
                distribution list and {notMine === 1 ? 'does' : 'do'} not appear here at all
              </>
            )}
            . There are no thumbnails: a preview would be the content, and the content does not exist for this officer
            until the ledger has recorded that they opened it.
            {!state.attestersReachable && (
              <>
                {' '}
                <strong>The attesters cannot be reached</strong>, so nothing can be recorded and a normal open will be
                refused. This officer holds {officer.breakGlassTokens} emergency token
                {officer.breakGlassTokens === 1 ? '' : 's'}, issued in advance while the log was healthy. Using one
                releases the copy now and writes the release into the log the moment the attesters come back.
              </>
            )}
          </>
        ) : (
          <>
            Nothing was watermarked when this opened. Every tile arrived twice and this officer holds the key to exactly
            one version of each, so the only picture their keys can assemble is the one that identifies them.
          </>
        )}
      </div>

      <div className="screen" data-terminal={`${terminalId}  ·  ${room?.name ?? ''}`}>
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
                <div className="avatar">{initials}</div>
                <div className="nm">
                  {officer.rank} {officer.name}
                </div>
                <div className="rl">{officer.role}</div>

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

                {message && <div className="bad">{message}</div>}

                {(officer.card.locked || officer.card.revoked || officer.standing.revoked) && (
                  <div className="bad">
                    {officer.standing.revoked || officer.card.revoked
                      ? 'This card has been withdrawn. The log records the revocation, so anything it signed before that entry still stands.'
                      : `This card locked itself after three wrong PINs.`}
                  </div>
                )}
                {!officer.card.locked && officer.card.attemptsLeft < 3 && (
                  <div className="bad">
                    {officer.card.attemptsLeft} attempt{officer.card.attemptsLeft === 1 ? '' : 's'} left before this
                    card locks itself.
                  </div>
                )}

                <div className="hintline">
                  PIN for this card is <code>{officer.demoPin}</code>{' '}
                  <button className="ghost small" onClick={() => setPin(officer.demoPin)}>
                    fill it
                  </button>
                </div>

                <div className="cardpick">
                  <span>card inserted:</span>
                  <select
                    value={officerName}
                    onChange={(event) => {
                      setOfficerName(event.target.value)
                      setPin('')
                      setMessage(null)
                    }}
                  >
                    {state.officers.map((o) => (
                      <option key={o.name} value={o.name}>
                        {o.rank} {o.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="os-status">
                <span>{terminalId}</span>
                <span>
                  {state.attestersReachable
                    ? 'card reader ready'
                    : 'card reader ready · attesters unreachable, nothing can be recorded'}
                </span>
              </div>
            </>
          )}

          {/* ---------------- file browser ---------------- */}
          {screen.at === 'files' && (
            <>
              <div className="os-title">
                <div className="left">
                  <span className="glyph">▤</span> Secure Document Store
                </div>
                <div className="os-controls">
                  <i />
                  <i />
                  <i className="x" onClick={onClose} />
                </div>
              </div>

              <div className="os-bar">
                <span className="os-crumbs">
                  Secure Store <span style={{ opacity: 0.5 }}>›</span> <b>{officer.rank} {officer.name}</b>{' '}
                  <span style={{ opacity: 0.5 }}>›</span> Documents
                </span>
                <span style={{ flex: 1 }} />
                <button className="ghost small" onClick={signOut}>
                  sign out
                </button>
              </div>

              <div className="os-body">
                {mine.length === 0 ? (
                  <div className="empty">
                    {state.sealed.length === 0
                      ? 'No documents have been distributed yet.'
                      : `Nothing here. ${state.sealed.length} document${
                          state.sealed.length === 1 ? ' is' : 's are'
                        } in circulation on this ship, none of them addressed to this officer.`}
                  </div>
                ) : (
                  <table className="files">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>From</th>
                        <th>Sent to</th>
                        <th>Status</th>
                        <th>Received</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mine.map((doc) => {
                        const got = issued.has(doc.docId)
                        return (
                          <tr
                            key={doc.docId}
                            className={`${selected === doc.docId ? 'sel' : ''} ${got ? 'opened' : ''}`}
                            onClick={() => setSelected(doc.docId)}
                            onDoubleClick={() => openDoc(doc)}
                          >
                            <td>
                              <span className="fn">
                                <span className={`doc-ic ${got ? '' : 'locked'}`}>{got ? '▦' : '🔒'}</span>
                                {doc.docName}
                              </span>
                            </td>
                            <td>Capt {doc.senderName}</td>
                            <td>{doc.recipients.length} officers</td>
                            <td>
                              <span className={`st ${got ? 'got' : 'new'}`}>{got ? 'Issued to you' : 'Sealed'}</span>
                            </td>
                            <td>{when(doc.createdAt)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>

              {message && (
                <div className="os-status" style={{ color: '#9e3a22' }}>
                  <span>{message}</span>
                </div>
              )}

              <div className="os-status">
                <span>
                  {mine.length} item{mine.length === 1 ? '' : 's'}
                  {selected ? ' · 1 selected' : ''}
                  {notMine > 0 ? ` · ${notMine} not listed (not cleared)` : ''}
                </span>
                <span className="row" style={{ gap: 8 }}>
                  <button
                    className="primary small"
                    disabled={!selected || busy !== null}
                    onClick={() => {
                      const doc = mine.find((d) => d.docId === selected)
                      if (doc) openDoc(doc)
                    }}
                  >
                    {busy ? 'opening…' : 'Open'}
                  </button>
                  {!state.attestersReachable && officer.breakGlassTokens > 0 && (
                    <button
                      className="small"
                      disabled={!selected || busy !== null}
                      title="a token issued in advance, good once, and its use is recorded when the attesters return"
                      onClick={() => {
                        const doc = mine.find((d) => d.docId === selected)
                        if (doc) breakGlass(doc)
                      }}
                    >
                      Break glass ({officer.breakGlassTokens} left)
                    </button>
                  )}
                </span>
              </div>
            </>
          )}

          {/* ---------------- viewer ---------------- */}
          {screen.at === 'viewing' && viewingDoc && (
            <>
              <div className="os-title">
                <div className="left">
                  <span className="glyph">▦</span> {viewingDoc.docName} — Secure Viewer
                </div>
                <div className="os-controls">
                  <i />
                  <i />
                  <i className="x" onClick={() => setScreen({ at: 'files' })} />
                </div>
              </div>

              <div className="os-bar">
                <button className="ghost small" onClick={() => setScreen({ at: 'files' })}>
                  ← Back
                </button>
                <span className="os-crumbs">
                  Secure Store <span style={{ opacity: 0.5 }}>›</span> {officer.name}{' '}
                  <span style={{ opacity: 0.5 }}>›</span> <b>{viewingDoc.docName}</b>
                </span>
              </div>

              <div className="os-body">
                <div className="viewer">
                  <div className="shots">
                    <div className="shot">
                      <img src={imageUrl(`/api/copy/${encodeURIComponent(screen.copyId)}.png`)} alt="this copy" />
                      <div className="cap">
                        {officer.rank} {officer.name}'s copy
                      </div>
                    </div>
                    <div className="shot">
                      <img src={imageUrl(`/api/original/${viewingDoc.docId}.png`)} alt="the original" />
                      <div className="cap">the original, for comparison</div>
                    </div>
                  </div>
                  <p className="prose">
                    {screen.again
                      ? 'This officer already had this document, so the same bytes came back and the ledger recorded another access rather than a second issue. That is what stops someone opening it twice and subtracting one copy from the other to find the mark.'
                      : 'No unmarked version of this file exists anywhere outside the sender. The copy on screen differs from every other officer’s in a way nobody can see and a detector can read back.'}
                  </p>
                </div>
              </div>

              <div className="os-status">
                <span>
                  {screen.again ? 'Opened again' : 'Issued'} · ledger entry #{screen.block} · {terminalId}
                </span>
                <span>512 × 512 · PNG</span>
              </div>
            </>
          )}
        </div>
      </div>

      {screen.at === 'files' && nextTerminal && (
        <div className="row">
          <button
            className="small"
            onClick={() => {
              signOut()
              onJump(nextTerminal.id)
            }}
          >
            go to {nextTerminal.id}
          </button>
          <span className="note">{nextTerminal.officer} has documents they have not opened yet</span>
        </div>
      )}

      {screen.at === 'viewing' && <Steps steps={screen.steps} label="what the system did, step by step" />}
    </Modal>
  )
}

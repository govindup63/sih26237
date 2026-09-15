import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type WorldState } from './api.ts'
import { DeckPlan, type Selection } from './scenes/DeckPlan.tsx'
import { TerminalModal } from './scenes/TerminalModal.tsx'
import { CabinModal } from './scenes/CabinModal.tsx'
import { SecurityModal } from './scenes/SecurityModal.tsx'
import { CompareModal } from './scenes/CompareModal.tsx'
import { NodeModal } from './scenes/NodeModal.tsx'
import { LedgerSidebar } from './panels/LedgerSidebar.tsx'
import { StepTracker, type Stage } from './panels/StepTracker.tsx'
import { QuorumStrip } from './panels/Quorum.tsx'
import { Roster } from './panels/Roster.tsx'

type Open =
  | { kind: 'terminal'; id: string }
  | { kind: 'node'; id: string }
  | { kind: 'cabin' }
  | { kind: 'security' }
  | { kind: 'compare' }
  | null

export function App() {
  const [state, setState] = useState<WorldState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<Open>(null)
  const [traced, setTraced] = useState(false)
  const [accusedNames, setAccusedNames] = useState<string[]>([])
  const [accusedTerminals, setAccusedTerminals] = useState<string[]>([])
  const [autoTrace, setAutoTrace] = useState<string | null>(null)
  /*
   * One selection, three subscribers: the deck plan, the roster and the ledger.
   * Letting any panel reach into another to highlight something is how these
   * views drift apart, so nothing here calls a sibling; they all read this.
   */
  const [selected, setSelected] = useState<string | null>(null)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    api
      .world()
      .then((result) => setState(result.state))
      .catch(() => setError('ssh -L 8090:127.0.0.1:8090 ubuntu@blankpoint.club'))
  }, [])

  /** Which officers already hold a copy. Read from the log, not from local state. */
  const holders = useMemo(() => {
    const names =
      state?.ledger.nodes[0]?.blocks
        .filter((b) => b.record.v === 'cnsa2-issue/1' || b.record.v === 'cnsa2-break-glass/1')
        .map((b) => b.record.recipientName)
        .filter((n): n is string => Boolean(n)) ?? []
    return new Set(names)
  }, [state])

  const accused = useMemo(
    () => new Set<string>([...accusedNames, ...accusedTerminals]),
    [accusedNames, accusedTerminals],
  )

  const selectedTerminal = useMemo(() => {
    if (!selected || !state) return null
    const officer = state.officers.find((o) => o.name === selected)
    return officer?.homeTerminal ?? selected
  }, [selected, state])

  const renderState = useMemo(() => {
    const active = new Set<string>()
    const hinted = new Set<string>()
    if (state) {
      for (const copy of state.copies) if (copy.terminal) active.add(copy.terminal)
      // Light the next thing worth clicking, so the map is never a puzzle.
      if (state.sealed.length === 0) hinted.add('CO-01')
      else if (state.copies.length === 0) {
        const first = state.terminals.find((t) => t.officer && state.sealed[0].recipients.includes(t.officer))
        if (first) hinted.add(first.id)
      } else if (!traced) hinted.add('SEC-01')
    }
    return {
      active,
      denied: new Set<string>(),
      hinted,
      accused,
      hovered: selectedTerminal,
    }
  }, [state, accused, traced, selectedTerminal])

  const go = useCallback(
    (stage: Stage) => {
      setState((current) => {
        if (!current) return current
        if (stage === 'seal') setOpen({ kind: 'cabin' })
        else if (stage === 'open') {
          const sealed = current.sealed[current.sealed.length - 1]
          const next = current.terminals.find(
            (t) =>
              t.officer &&
              sealed?.recipients.includes(t.officer) &&
              !current.copies.some((c) => c.terminal === t.id),
          )
          setOpen({ kind: 'terminal', id: next?.id ?? 'OPS-04' })
        } else if (stage === 'compare') setOpen({ kind: 'compare' })
        else setOpen({ kind: 'security' })
        return current
      })
    },
    [],
  )

  /*
   * A hands-free run. The failure that actually kills a demo is clicking the
   * wrong thing under pressure, so there is a path through the whole thing that
   * needs no clicks at all, and the space bar advances it manually.
   */
  const advance = useCallback(async () => {
    const current = await api.world()
    const w = current.state
    if (w.sealed.length === 0) {
      const sealed = await api.seal(w.docs[0].key, ['nair', 'iyer', 'varma', 'menon'])
      if (sealed.ok) setState(sealed.state)
      setOpen({ kind: 'cabin' })
      return
    }
    const doc = w.sealed[w.sealed.length - 1]
    const missing = doc.recipients.filter((r) => !holders.has(r))
    if (missing.length > 0) {
      const officer = w.officers.find((o) => o.name === missing[0])!
      const opened = await api.open(doc.docId, officer.name, officer.homeTerminal, officer.demoPin)
      if (opened.ok) setState(opened.state)
      setOpen({ kind: 'terminal', id: officer.homeTerminal })
      return
    }
    if (!traced) {
      setOpen({ kind: 'compare' })
      return
    }
    setOpen({ kind: 'security' })
  }, [holders, traced])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && /input|textarea|select/i.test(target.tagName)) return
      if (event.code === 'Space') {
        event.preventDefault()
        advance()
      }
      if (event.key === 'Escape') setOpen(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [advance])

  useEffect(() => {
    if (!running) return
    let cancelled = false
    const tick = async () => {
      if (cancelled) return
      await advance()
    }
    const id = setInterval(tick, 4200)
    tick()
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [running, advance])

  if (error) {
    return (
      <div style={{ padding: 40, maxWidth: 620 }}>
        <h1 style={{ fontSize: 17, marginBottom: 10 }}>SIH26237</h1>
        <p className="note">
          The page cannot reach the backend. It runs on a machine that is never exposed publicly, so this page talks to
          it over an SSH port forward. Open the tunnel and reload:
        </p>
        <pre
          style={{
            marginTop: 12,
            padding: '12px 14px',
            background: 'var(--sunken)',
            border: '1px solid var(--line)',
            borderRadius: 6,
            fontSize: 12.5,
            overflowX: 'auto',
          }}
        >
          {error}
        </pre>
      </div>
    )
  }

  if (!state) return <div style={{ padding: 40 }} className="note">loading…</div>

  return (
    <div className="app">
      <div className="stage">
        <div className="masthead">
          <h1>Traceable classified release</h1>
          <span className="sub">SIH26237 · Ministry of Defence</span>
          <span className="chip">{String(state.suite.kem)}</span>
          <span className="chip">{String(state.suite.sig).replace(' (SHA-512 prehash)', '')}</span>
          <span className="grow" />
          <span className="live">
            <QuorumStrip state={state} compact onNode={(name) => setOpen({ kind: 'node', id: name })} />
            <button className={`play ${running ? 'on' : ''}`} onClick={() => setRunning(!running)}>
              {running ? '❚❚ pause' : '▶ run the whole thing'}
            </button>
          </span>
        </div>
        <div className="disclaimer">
          One image is encrypted once and sent to several officers. Each can assemble only one version of it, and that
          version identifies them, so a leaked copy traces back to whoever opened it.
          <details>
            <summary>how this page relates to the real thing</summary>
            The officers, their cards, the workstations and the four ledger machines all run as separate actors on one
            computer so the mechanism can be watched. In service none of it touches a network. Press the space bar to
            take the next step at your own pace, or run the whole thing hands-free from the button above.
          </details>
        </div>

        <StepTracker state={state} traced={traced} onGo={go} />

        <Roster
          state={state}
          holders={holders}
          accused={accused}
          selected={selected}
          onSelect={setSelected}
          onOpen={(id) => setOpen({ kind: 'terminal', id })}
        />

        <DeckPlan
          state={state}
          render={renderState}
          onSelect={(selection: Selection) => {
            if (selection.kind === 'terminal') {
              const officer = state.officers.find((o) => o.homeTerminal === selection.id)
              setSelected(officer?.name ?? null)
              if (selection.id === 'CO-01') setOpen({ kind: 'cabin' })
              else if (selection.id === 'SEC-01') setOpen({ kind: 'security' })
              else setOpen({ kind: 'terminal', id: selection.id })
            } else if (selection.kind === 'node') {
              setOpen({ kind: 'node', id: selection.id })
            }
          }}
        />
      </div>

      <div className="sidebar">
        <LedgerSidebar
          state={state}
          selected={selected}
          onSelect={setSelected}
          onState={(next) => {
            setState(next)
            if (next.sealed.length === 0) {
              setTraced(false)
              setAccusedNames([])
              setAccusedTerminals([])
              setSelected(null)
              setAutoTrace(null)
            }
          }}
          onNode={(name) => setOpen({ kind: 'node', id: name })}
        />
      </div>

      {open?.kind === 'terminal' && (
        <TerminalModal
          terminalId={open.id}
          state={state}
          onState={setState}
          onClose={() => setOpen(null)}
          onJump={(id) => setOpen({ kind: 'terminal', id })}
        />
      )}
      {open?.kind === 'cabin' && <CabinModal state={state} onState={setState} onClose={() => setOpen(null)} />}
      {open?.kind === 'node' && (
        <NodeModal attesterName={open.id} state={state} onState={setState} onClose={() => setOpen(null)} />
      )}
      {open?.kind === 'compare' && (
        <CompareModal
          state={state}
          onClose={() => setOpen(null)}
          onTrace={(copyId) => {
            setAutoTrace(copyId)
            setOpen({ kind: 'security' })
          }}
        />
      )}
      {open?.kind === 'security' && (
        <SecurityModal
          state={state}
          onState={setState}
          onClose={() => setOpen(null)}
          autoTrace={autoTrace}
          onTraced={() => setTraced(true)}
          onAccuse={(names, terminals) => {
            setAccusedNames(names)
            setAccusedTerminals(terminals)
            setSelected(names[0] ?? null)
          }}
        />
      )}
    </div>
  )
}

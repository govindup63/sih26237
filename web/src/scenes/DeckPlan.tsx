import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TILE, buildScene, hitTest, rackPosition, render, type RenderState, type Scene } from '../pixel/renderer.ts'
import type { WorldState } from '../api.ts'

/**
 * The deck is drawn once at 1:1 and then scaled to whatever room the window has.
 * Fixing the zoom meant the plan was cut off on a narrower laptop, and half a
 * clipped room reads as a broken page rather than as something to scroll.
 */
function useFitScale(tilesWide: number) {
  const holder = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(2)
  useLayoutEffect(() => {
    const element = holder.current?.parentElement
    if (!element) return
    const measure = () => {
      const style = getComputedStyle(element)
      const available =
        element.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0')
      setScale(Math.max(1.1, Math.min(2.4, available / (tilesWide * TILE))))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [tilesWide])
  return { holder, scale }
}

export type Selection = { kind: 'terminal' | 'node' | 'room'; id: string }

/** What each place is for, in one line, so hovering explains the map. */
const ROOM_BLURB: Record<string, string> = {
  bridge: 'A workstation and one of the four machines that keep the ledger.',
  ops: 'Two workstations and a ledger machine, under a different officer from the bridge.',
  signals: 'A workstation and a ledger machine.',
  'ship-office': 'The clerk works here. She is not on the distribution list, and the system refuses her.',
  'co-cabin': 'Where a document is encrypted once and addressed to several officers.',
  security: 'Where a leaked image is brought in and, if the evidence supports it, given a name.',
  'shore-hq': 'The fourth ledger machine, ashore and outside the ship’s chain of custody.',
}

export function DeckPlan({
  state,
  render: renderState,
  onSelect,
}: {
  state: WorldState
  render: RenderState
  onSelect: (selection: Selection) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [hovered, setHovered] = useState<Selection | null>(null)
  const [pointer, setPointer] = useState<{ x: number; y: number }>({ x: 0, y: 0 })

  const scene: Scene = buildScene({
    rooms: state.rooms,
    terminals: state.terminals,
    officers: state.officers,
    attesters: state.attesters,
    nodes: state.ledger.nodes,
  })

  const { holder, scale: SCALE } = useFitScale(scene.width)

  useEffect(() => {
    const context = canvasRef.current?.getContext('2d')
    if (context) {
      render(context, scene, { ...renderState, hovered: hovered && hovered.kind !== 'room' ? hovered.id : null })
    }
  })

  const toScene = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * scene.width * TILE,
      y: ((event.clientY - rect.top) / rect.height) * scene.height * TILE,
      px: event.clientX - rect.left,
      py: event.clientY - rect.top,
    }
  }

  /** Which officers already hold a copy, so the map shows progress at a glance. */
  const holders = new Set(
    state.ledger.nodes[0]?.blocks
      .filter((b) => b.record.v === 'cnsa2-issue/1' || b.record.v === 'cnsa2-break-glass/1')
      .map((b) => b.record.recipientName)
      .filter((n): n is string => Boolean(n)) ?? [],
  )

  function tooltipFor(selection: Selection): { title: string; body: string; go: string } | null {
    if (selection.kind === 'terminal') {
      const terminal = state.terminals.find((t) => t.id === selection.id)
      if (!terminal) return null
      if (terminal.id === 'CO-01') {
        return { title: "Commanding Officer's desk", body: ROOM_BLURB['co-cabin'], go: 'click to seal a document' }
      }
      if (terminal.id === 'SEC-01') {
        return { title: 'Forensic bench', body: ROOM_BLURB.security, go: 'click to report a leak' }
      }
      const officer = state.officers.find((o) => o.name === terminal.officer)
      const has = officer ? holders.has(officer.name) : false
      return {
        title: `${terminal.id}${officer ? ` · ${officer.rank} ${officer.name}` : ''}`,
        body: officer
          ? `${officer.role}. ${has ? 'Already holds a copy of the sealed document.' : 'Has not opened the document yet.'}`
          : 'An unattended workstation.',
        go: officer ? `click to open it as ${officer.name} (PIN ${officer.demoPin})` : 'click to use it',
      }
    }
    if (selection.kind === 'node') {
      const node = state.ledger.nodes.find((n) => n.name === selection.id)
      if (!node) return null
      return {
        title: node.name,
        body: `One of the four machines keeping the ledger, in the ${node.location}. ${
          node.ok && node.onMajority ? 'It agrees with the others.' : 'It no longer matches the others and is outvoted.'
        }`,
        go: 'click to try rewriting its copy',
      }
    }
    const room = state.rooms.find((r) => r.id === selection.id)
    if (!room) return null
    return {
      title: room.detached ? `${room.name} · separate custody` : room.name,
      body: ROOM_BLURB[room.id] ?? '',
      go: '',
    }
  }

  const tip = hovered ? tooltipFor(hovered) : null

  return (
    <div
      className="deck"
      ref={holder}
      style={{ width: scene.width * TILE * SCALE, height: scene.height * TILE * SCALE }}
    >
      <canvas
        ref={canvasRef}
        width={scene.width * TILE}
        height={scene.height * TILE}
        style={{ width: scene.width * TILE * SCALE, height: scene.height * TILE * SCALE }}
        onMouseMove={(event) => {
          const { x, y, px, py } = toScene(event)
          const hit = hitTest(scene, x, y)
          setHovered(hit ? { kind: hit.kind, id: hit.id } : null)
          setPointer({ x: px, y: py })
        }}
        onMouseLeave={() => setHovered(null)}
        onClick={(event) => {
          const { x, y } = toScene(event)
          const hit = hitTest(scene, x, y)
          if (hit) onSelect({ kind: hit.kind, id: hit.id })
        }}
      />

      {state.rooms.map((room) => (
        <span
          key={room.id}
          className="label"
          style={{ left: (room.x + 1) * TILE * SCALE, top: (room.y + 0.12) * TILE * SCALE }}
        >
          {room.name}
        </span>
      ))}

      {state.terminals.map((terminal) => {
        const officer = state.officers.find((o) => o.homeTerminal === terminal.id)
        const accused = renderState.accused.has(terminal.id) || (officer ? renderState.accused.has(officer.name) : false)
        const has = officer ? holders.has(officer.name) : false
        return (
          <span key={terminal.id}>
            <span
              className={`tag ${accused ? 'accused' : has ? '' : 'off'}`}
              style={{ left: (terminal.x - 0.4) * TILE * SCALE, top: (terminal.y - 1.65) * TILE * SCALE }}
            >
              {terminal.id}
            </span>
            {officer && (
              <span
                className="who"
                style={{ left: (terminal.x + 0.6) * TILE * SCALE, top: (terminal.y + 2.35) * TILE * SCALE }}
              >
                {officer.rank} {officer.name}
              </span>
            )}
          </span>
        )
      })}

      {state.attesters.map((attester) => {
        const at = rackPosition(scene, attester.name)
        if (!at) return null
        const node = state.ledger.nodes.find((n) => n.name === attester.name)
        const bad = node ? !node.ok || !node.onMajority : false
        return (
          <span
            key={attester.name}
            className={`tag ${bad ? 'accused' : ''}`}
            style={{ left: (at.x - 0.7) * TILE * SCALE, top: (at.y - 0.95) * TILE * SCALE }}
          >
            {attester.name.replace('-node', '')}
          </span>
        )
      })}

      {tip && (
        <div
          className="tooltip"
          style={{
            left: Math.min(pointer.x + 16, scene.width * TILE * SCALE - 266),
            top: pointer.y + 16,
          }}
        >
          <div className="tt">{tip.title}</div>
          {tip.body && <div className="td">{tip.body}</div>}
          {tip.go && <div className="go">{tip.go}</div>}
        </div>
      )}
    </div>
  )
}

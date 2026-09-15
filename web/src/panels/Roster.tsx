import type { WorldState } from '../api.ts'

/**
 * The ship's company as one strip.
 *
 * An officer who has not opened their copy is drawn faded rather than given a
 * grey dot, because absence reads as absence without anything to learn. Solid
 * means they hold a copy. An outline means the forensic step has named them.
 *
 * Click selects, and the selection is shared with the deck plan and the ledger,
 * so any one of the three can drive the other two. Double-click opens the
 * workstation.
 */
export function Roster({
  state,
  holders,
  accused,
  selected,
  onSelect,
  onOpen,
}: {
  state: WorldState
  holders: Set<string>
  accused: Set<string>
  selected: string | null
  onSelect: (name: string | null) => void
  onOpen: (terminalId: string) => void
}) {
  return (
    <div className="roster">
      {state.officers.map((officer) => {
        const has = holders.has(officer.name)
        const named = accused.has(officer.name)
        const locked = officer.card?.locked || officer.card?.revoked || officer.standing?.revoked
        return (
          <button
            key={officer.name}
            className={[
              'crew',
              has ? 'has' : 'waiting',
              named ? 'named' : '',
              locked ? 'locked' : '',
              selected === officer.name ? 'sel' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            title={`${officer.rank} ${officer.name} · ${officer.role}`}
            onClick={() => onSelect(selected === officer.name ? null : officer.name)}
            onDoubleClick={() => onOpen(officer.homeTerminal)}
          >
            <span className="face" aria-hidden>
              {officer.name.slice(0, 2).toUpperCase()}
            </span>
            <span className="nm">{officer.name}</span>
            <span className="rk">{officer.rank}</span>
            {locked && <span className="pip mono">✕</span>}
          </button>
        )
      })}
    </div>
  )
}

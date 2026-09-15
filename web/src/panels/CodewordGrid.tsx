/**
 * The mark the detector actually read, one cell per tile. Two colours for the two
 * versions each tile could have been, and dark for tiles it could not read at all,
 * which is what erasing a mark leaves behind.
 */
export function CodewordGrid({
  tiles,
  gridW,
}: {
  tiles: { index: number; bit: number; readable: boolean }[]
  gridW: number
}) {
  if (tiles.length === 0) return null
  const dead = tiles.filter((t) => !t.readable).length
  return (
    <div className="col" style={{ gap: 7 }}>
      <div className="grid-tiles" style={{ gridTemplateColumns: `repeat(${gridW}, 1fr)`, maxWidth: gridW * 18 }}>
        {tiles.map((tile) => (
          <i key={tile.index} className={tile.readable ? (tile.bit ? 'b' : 'a') : 'dead'} title={`tile ${tile.index}`} />
        ))}
      </div>
      <div className="legend">
        <span>
          <i style={{ background: '#2f7fa8' }} /> version A
        </span>
        <span>
          <i style={{ background: '#b8862f' }} /> version B
        </span>
        <span>
          <i style={{ background: '#1a222a' }} /> unreadable ({dead})
        </span>
      </div>
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { api, compareUrl, imageUrl, type CompareStats, type CopyView, type WorldState } from '../api.ts'
import { Modal } from '../panels/Modal.tsx'

/**
 * The only screen where the reviewer's own eyes are the evidence.
 *
 * Everything else in this app is the machine asserting something. Here the
 * reviewer is asked to tell two officers' copies apart, fails, and only then is
 * handed an instrument that succeeds. Their failure is the argument, so the
 * instrument stays locked until they have actually tried.
 *
 * The amplification is a named number for the same reason a forensic tool labels
 * its enhancement: an unlabelled enhanced view looks cooked. At 1x the panel is
 * the difference as it really is, and the reviewer can drag back down to check.
 */
type Phase = 'challenge' | 'answered' | 'instrument'

const BLINK_MS = 320

export function CompareModal({
  state,
  onClose,
  onTrace,
}: {
  state: WorldState
  onClose: () => void
  onTrace: (copyId: string) => void
}) {
  /** Two copies of one document, opened by two different officers. */
  const pair = useMemo(() => pickPair(state.copies), [state.copies])

  const [phase, setPhase] = useState<Phase>('challenge')
  const [blink, setBlink] = useState(false)
  const [frame, setFrame] = useState(0)
  const [gain, setGain] = useState(1)
  const [guess, setGuess] = useState<number | null>(null)
  const [stats, setStats] = useState<CompareStats | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const started = useRef(Date.now())

  useEffect(() => {
    if (!blink) return
    const id = setInterval(() => setFrame((f) => 1 - f), BLINK_MS)
    return () => clearInterval(id)
  }, [blink])

  useEffect(() => {
    if (phase !== 'challenge') return
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started.current) / 1000)), 500)
    return () => clearInterval(id)
  }, [phase])

  useEffect(() => {
    if (!pair) return
    api.compare(pair.left.copyId, pair.right.copyId).then((s) => s.ok && setStats(s))
  }, [pair])

  if (!pair) {
    return (
      <Modal title="Comparison bench" where="two copies, side by side" onClose={onClose}>
        <div className="explain">
          This bench needs two copies of the same document, opened by two different officers. Seal a document and open
          it at two workstations first.
        </div>
      </Modal>
    )
  }

  /** Which panel holds which officer is hidden until the reviewer has answered. */
  const nameFor = (copy: CopyView) =>
    state.officers.find((o) => o.homeTerminal === copy.terminal)?.name ?? copy.terminal
  const rankFor = (copy: CopyView) => {
    const officer = state.officers.find((o) => o.homeTerminal === copy.terminal)
    return officer ? `${officer.rank} ${officer.name}` : copy.terminal
  }

  const answer = (choice: number) => {
    setGuess(choice)
    setPhase('answered')
  }

  const correct = guess === 1
  const shown = blink ? (frame === 0 ? pair.left : pair.right) : null

  return (
    <Modal title="Comparison bench" where="two copies, side by side" onClose={onClose}>
      {phase === 'challenge' && (
        <div className="challenge-head">
          <h3>Which of these belongs to which officer?</h3>
          <p>
            One of these two files was issued to <b>{rankFor(pair.left)}</b> and the other to{' '}
            <b>{rankFor(pair.right)}</b>. They came from one sealed document. Take as long as you like.
          </p>
        </div>
      )}

      <div className="compare-rig">
        {blink ? (
          <div className="blink-stage">
            <img src={imageUrl(`/api/copy/${encodeURIComponent(shown!.copyId)}.png`)} alt="" />
            <div className="cap">
              alternating between the two copies {Math.round(1000 / BLINK_MS)} times a second
              {phase !== 'challenge' && <span className="mono"> · now showing {frame === 0 ? 'copy 1' : 'copy 2'}</span>}
            </div>
          </div>
        ) : (
          <div className="compare-pair">
            {[pair.left, pair.right].map((copy, i) => (
              <figure key={copy.copyId}>
                <img src={imageUrl(`/api/copy/${encodeURIComponent(copy.copyId)}.png`)} alt="" />
                <figcaption>
                  <b>copy {i + 1}</b>
                  {phase === 'challenge' ? (
                    <span className="unknown"> issued to one of the two officers</span>
                  ) : (
                    <span className="revealed"> {rankFor(copy)}</span>
                  )}
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </div>

      <div className="compare-controls">
        <label className="toggle">
          <input type="checkbox" checked={blink} onChange={(e) => setBlink(e.target.checked)} />
          <span>Blink</span>
        </label>
        <span className="note">
          Alternating the two in one place is the most sensitive comparison a human eye can make. It is how Pluto was
          found.
        </span>
      </div>

      {phase === 'challenge' && (
        <div className="challenge-answer">
          <div className="timer mono">{elapsed}s</div>
          <button onClick={() => answer(1)}>copy 1 is {nameFor(pair.left)}</button>
          <button onClick={() => answer(2)}>copy 1 is {nameFor(pair.right)}</button>
          <button className="ghost" onClick={() => answer(0)}>
            I cannot tell them apart
          </button>
        </div>
      )}

      {phase !== 'challenge' && (
        <div className={`challenge-result ${guess === 0 ? '' : correct ? 'right' : 'wrong'}`}>
          <h3>
            {guess === 0
              ? 'Neither can anyone else.'
              : correct
                ? 'A correct guess, on a coin flip.'
                : 'Wrong, and that is the point.'}
          </h3>
          <p>
            The two files are not the same bytes and never were. {stats && (
              <>
                They differ in <b>{pct(stats.differingSamples / stats.totalSamples)}</b> of their colour samples, and the
                largest single change is <b>{stats.maxDeviation} of 255</b>. Measured against each other they sit at{' '}
                <span className="mono">{stats.psnr.toFixed(1)} dB</span> PSNR and{' '}
                <span className="mono">{stats.ssim.toFixed(3)}</span> SSIM.
              </>
            )}
          </p>
          <p className="note">
            Neither officer was ever handed an unmarked file to compare against. Their keys open one of two encrypted
            versions of every tile, so the difference you just failed to see is the only image either of them can build.
          </p>
          {phase === 'answered' && (
            <button className="primary" onClick={() => setPhase('instrument')}>
              show me the difference
            </button>
          )}
        </div>
      )}

      {phase === 'instrument' && (
        <>
          <div className="scope">
            <img src={compareUrl(pair.left.copyId, pair.right.copyId, gain)} alt="" />
            <div className="scope-controls">
              <label>
                Amplification <b className="mono">{gain}x</b>
              </label>
              <input
                type="range"
                min={1}
                max={128}
                value={gain}
                onChange={(e) => setGain(Number(e.target.value))}
              />
              <div className="ticks mono">
                <span>1x</span>
                <span>64x</span>
                <span>128x</span>
              </div>
            </div>
          </div>
          <p className="note">
            Each square is one tile. A flat grey tile is one where both officers' keys happened to open the same
            version, so there is nothing there to see. A noisy tile is one where they opened different versions, and
            the pattern in it is the carrier that tells the two versions apart. Which tiles are which is the mark.
          </p>
          <p className="note">
            This is a microscope, not a filter. Every pixel here is the signed difference between the two copies,
            multiplied by the number above and offset to mid-grey. Drag it back to 1x and the panel goes flat, because
            at 1x there is nothing an eye can hold on to.
            {stats && ` A difference this size first becomes visible somewhere around ${stats.visibleAtGain}x.`}
          </p>
          <div className="row">
            <button className="primary" onClick={() => onTrace(pair.left.copyId)}>
              now read copy 1 back to a name
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}

function pct(fraction: number): string {
  const p = fraction * 100
  return p >= 10 ? `${p.toFixed(0)}%` : p >= 1 ? `${p.toFixed(1)}%` : `${p.toFixed(2)}%`
}

/** The first document with two untouched copies from two different workstations. */
function pickPair(copies: CopyView[]): { left: CopyView; right: CopyView } | null {
  const clean = copies.filter((c) => !c.copyId.includes('--') && !c.copyId.startsWith('collusion'))
  const byDoc = new Map<string, CopyView[]>()
  for (const copy of clean) {
    const list = byDoc.get(copy.docId) ?? []
    list.push(copy)
    byDoc.set(copy.docId, list)
  }
  for (const list of byDoc.values()) {
    if (list.length >= 2) return { left: list[0], right: list[1] }
  }
  return null
}

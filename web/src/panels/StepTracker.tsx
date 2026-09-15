import type { WorldState } from '../api.ts'

export type Stage = 'seal' | 'open' | 'compare' | 'leak' | 'trace'

/**
 * A reviewer has a few minutes and no briefing.
 *
 * The steps are written as a chain rather than a list, each one a consequence or
 * a reversal of the one before it, because a list of four features is forgotten
 * by the end of the page and an argument is not. Clicking a step goes straight to
 * the room that performs it, so the deck plan is never a puzzle.
 */
export function StepTracker({
  state,
  traced,
  onGo,
}: {
  state: WorldState
  traced: boolean
  onGo: (stage: Stage) => void
}) {
  const sealed = state.sealed.length > 0
  /** Every officer-and-document pair that could be opened, across all documents. */
  const expected = state.sealed.reduce((n, doc) => n + doc.recipients.length, 0)
  const opened = state.ledger.nodes[0].blocks.filter(
    (b) => b.record.v === 'cnsa2-issue/1' || b.record.v === 'cnsa2-break-glass/1',
  ).length
  const docs = state.sealed.length
  const combined = state.copies.some((c) => c.copyId.startsWith('collusion') || c.copyId.includes('--'))

  const steps: { id: Stage; title: string; because: string; hint: string; done: boolean }[] = [
    {
      id: 'seal',
      title: 'Seal it once',
      because: 'One image goes to several officers, but if it leaks nobody knows which of them let it go.',
      hint: sealed ? `${docs} document${docs === 1 ? '' : 's'}, ${expected} copies addressed` : "in the CO's cabin",
      done: sealed,
    },
    {
      id: 'open',
      title: 'Open it as an officer',
      because: 'So give every officer a different copy, built by their own keys as it decrypts.',
      hint: !sealed ? 'after sealing' : opened === 0 ? 'click any workstation' : `${opened} of ${expected} copies opened`,
      done: opened > 0,
    },
    {
      id: 'compare',
      title: 'Try to tell two apart',
      because: 'But officers who compare copies must find nothing, so the difference has to be invisible.',
      hint: opened < 2 ? 'needs two copies' : 'the comparison bench',
      done: opened >= 2,
    },
    {
      id: 'leak',
      title: 'Damage or combine one',
      because: 'And a leaked file is never pristine, so the mark has to survive being mangled.',
      hint: combined ? 'done' : opened < 2 ? 'needs two copies' : 'optional, in the security office',
      done: combined,
    },
    {
      id: 'trace',
      title: 'Read it back to a name',
      because: 'Then the opening that produced it is already signed into a log nobody can quietly rewrite.',
      hint: traced ? 'done' : opened === 0 ? 'after a copy exists' : 'in the security office',
      done: traced,
    },
  ]

  const current = steps.find((s) => !s.done)?.id

  return (
    <div className="steps-bar">
      {steps.map((step, index) => (
        <button
          key={step.id}
          className={`step-card ${step.done ? 'done' : ''} ${step.id === current ? 'now' : ''}`}
          onClick={() => onGo(step.id)}
          title={step.because}
        >
          <span className="num">{step.done ? '✓' : index + 1}</span>
          <span>
            <span className="t">{step.title}</span>
            {step.id === current && <span className="because">{step.because}</span>}
            <span className="d">{step.hint}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

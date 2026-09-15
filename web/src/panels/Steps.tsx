import type { Step } from '../api.ts'

/**
 * The trace the server builds as it works. It is folded away by default: the
 * plain-language summary above answers the question most people have, and this
 * answers the question a judge has.
 */
export function Steps({ steps, label = 'show the cryptographic trace' }: { steps: Step[]; label?: string }) {
  if (steps.length === 0) return null
  return (
    <details className="trace">
      <summary>
        {label} ({steps.length} steps)
      </summary>
      <ol className="steps">
        {steps.map((step) => (
          <li key={step.n} className={step.ok === false ? 'bad' : step.ok === null ? 'note' : 'ok'}>
            <span className="n">{step.ok === false ? '×' : step.ok === null ? 'i' : step.n}</span>
            <div>
              <div className="title">{step.title}</div>
              <div className="detail">{step.detail}</div>
              {step.fields.length > 0 && (
                <dl className="fields">
                  {step.fields.map((field, i) => (
                    <div key={i} style={{ display: 'contents' }}>
                      <dt>{field.label}</dt>
                      <dd className={field.secret ? 'secret' : undefined}>{field.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          </li>
        ))}
      </ol>
    </details>
  )
}

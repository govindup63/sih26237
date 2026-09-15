import { useEffect, type ReactNode } from 'react'

export function Modal({
  title,
  where,
  onClose,
  children,
}: {
  title: string
  where?: string
  onClose: () => void
  children: ReactNode
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>{title}</h2>
          <div className="row" style={{ gap: 12 }}>
            {where && <span className="where">{where}</span>}
            <button className="ghost small" onClick={onClose}>
              close
            </button>
          </div>
        </header>
        <div className="body">{children}</div>
      </div>
    </div>
  )
}

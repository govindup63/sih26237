export type Field = {
  label: string
  value: string
  secret?: boolean
  note?: string
}

export type Step = {
  n: number
  title: string
  detail: string
  ok: boolean | null
  fields: Field[]
}

export function f(label: string, value: string | number, note?: string): Field {
  return note === undefined ? { label, value: String(value) } : { label, value: String(value), note }
}

export function secret(label: string, value: string, note?: string): Field {
  return { label, value, secret: true, ...(note === undefined ? {} : { note }) }
}

export class Trace {
  readonly steps: Step[] = []

  add(title: string, detail: string, fields: Field[] = [], ok: boolean | null = true): void {
    this.steps.push({ n: this.steps.length + 1, title, detail, ok, fields })
  }

  fail(title: string, detail: string, fields: Field[] = []): void {
    this.add(title, detail, fields, false)
  }

  note(title: string, detail: string, fields: Field[] = []): void {
    this.add(title, detail, fields, null)
  }
}

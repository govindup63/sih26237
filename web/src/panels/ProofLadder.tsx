import { useState } from 'react'
import { api } from '../api.ts'

/**
 * The inclusion proof, one hop at a time, recomputed in this browser.
 *
 * The server is not asked whether the proof is good. The page fetches the leaf
 * and the sibling hashes, does the SHA-512 itself, and prints its own result next
 * to the root the attesters signed. Nothing here says "valid": the two values sit
 * one above the other and the reader is the one who notices they match. That is
 * the whole point of a transparency log, and a green tick would throw it away.
 *
 * `0x01 ‖ left ‖ right` is shown rather than hidden because the domain separation
 * between a leaf and an internal node is what stops an internal node being
 * presented as a record.
 */
type Hop = { sibling: string; side: 'left' | 'right'; result: string }

export function ProofLadder({ height }: { height: number }) {
  const [state, setState] = useState<{
    leaf: string
    hops: Hop[]
    computed: string
    root: string
    size: number
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [shown, setShown] = useState(0)

  async function build() {
    setBusy(true)
    const proof = await api.inclusion(height)
    if (!proof.ok) return setBusy(false)
    const hops = await walk(proof.leaf, proof.proof, height, proof.size)
    setState({ leaf: proof.leaf, hops, computed: hops.at(-1)?.result ?? proof.leaf, root: proof.root, size: proof.size })
    setBusy(false)
    setShown(0)
    // Let the hops land one at a time. The time it takes is the argument.
    hops.forEach((_, i) => setTimeout(() => setShown(i + 1), 150 * (i + 1)))
  }

  if (!state) {
    return (
      <button className="small" onClick={build} disabled={busy}>
        {busy ? 'fetching the path…' : 'recompute the path to the root'}
      </button>
    )
  }

  return (
    <div className="ladder">
      <div className="lhead mono">
        entry #{height} of {state.size} · recomputed in this browser, not on the server
      </div>
      <div className="rung leaf">
        <span className="lbl">leaf</span>
        <span className="mono val">{cut(state.leaf)}</span>
      </div>
      {state.hops.slice(0, shown).map((hop, i) => (
        <div key={i} className="rung">
          <span className="lbl mono">
            SHA512(0x01 ‖ {hop.side === 'left' ? 'sibling ‖ running' : 'running ‖ sibling'})
          </span>
          <span className="mono sib">sibling {cut(hop.sibling)}</span>
          <span className="mono val">{cut(hop.result)}</span>
        </div>
      ))}
      {shown >= state.hops.length && (
        <div className="landing">
          <div>
            <span className="lbl">computed root</span>
            <span className="mono val">{cut(state.computed, 20)}</span>
          </div>
          <div>
            <span className="lbl">root the attesters signed</span>
            <span className="mono val">{cut(state.root, 20)}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function cut(hash: string, head = 16): string {
  return hash.length <= head + 8 ? hash : `${hash.slice(0, head)}…${hash.slice(-8)}`
}

const NODE = 0x01

/** The same walk the log's own verifier does, redone here with Web Crypto. */
async function walk(leafHex: string, proof: string[], index: number, count: number): Promise<Hop[]> {
  const hops: Hop[] = []
  let hash = unhex(leafHex)
  let at = index
  let width = count
  let step = 0
  while (width > 1) {
    const odd = width % 2 === 1
    const isLastOdd = odd && at === width - 1
    if (!isLastOdd) {
      const sibling = proof[step]
      if (sibling === undefined) break
      const sib = unhex(sibling)
      const side = at % 2 === 0 ? 'right' : 'left'
      const joined = side === 'right' ? concat(hash, sib) : concat(sib, hash)
      hash = new Uint8Array(await crypto.subtle.digest('SHA-512', concat(new Uint8Array([NODE]), joined)))
      hops.push({ sibling, side, result: hex(hash) })
      step++
    }
    at = Math.floor(at / 2)
    width = Math.ceil(width / 2)
  }
  return hops
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + p.length, 0)))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function unhex(value: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(value.length / 2))
  for (let i = 0; i < out.length; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16)
  return out
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

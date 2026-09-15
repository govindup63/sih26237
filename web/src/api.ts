/**
 * The API lives on the VM and is reached through an SSH tunnel, so from this
 * page it looks like localhost. Every request carries a session id so two
 * reviewers do not end up in each other's ledger.
 */
const BASE = import.meta.env.VITE_API ?? 'http://localhost:8090'

const SESSION_KEY = 'sih26237-session'

function session(): string {
  let id = localStorage.getItem(SESSION_KEY)
  if (!id) {
    id = `s-${Math.random().toString(36).slice(2, 10)}`
    localStorage.setItem(SESSION_KEY, id)
  }
  return id
}

export function resetSession(): void {
  localStorage.removeItem(SESSION_KEY)
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'x-sih-session': session(),
      ...(init?.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  if (!response.ok && response.status >= 500) {
    throw new Error(`${path} failed with ${response.status}`)
  }
  return (await response.json()) as T
}

export const get = <T,>(path: string) => call<T>(path)
export const post = <T,>(path: string, body?: unknown) =>
  call<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

export function imageUrl(path: string): string {
  return `${BASE}${path}?s=${encodeURIComponent(session())}`
}

/**
 * Decode a file the user picked, scale it so the long edge is at most 512 and the
 * short edge at least 128, and hand back raw pixels. Doing this here keeps every
 * image codec out of the server and bounds how much work a seal has to do.
 */
export async function uploadImage(file: File): Promise<{ ok: boolean; key?: string; error?: string; state?: WorldState }> {
  const bitmap = await createImageBitmap(file)
  const longest = Math.max(bitmap.width, bitmap.height)
  const scale = longest > 512 ? 512 / longest : 1
  let w = Math.max(1, Math.round(bitmap.width * scale))
  let h = Math.max(1, Math.round(bitmap.height * scale))
  if (Math.min(w, h) < 128) {
    const up = 128 / Math.min(w, h)
    w = Math.min(1024, Math.round(w * up))
    h = Math.min(1024, Math.round(h * up))
  }

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const context = canvas.getContext('2d')
  if (!context) return { ok: false, error: 'canvas is unavailable' }
  context.drawImage(bitmap, 0, 0, w, h)
  const data = context.getImageData(0, 0, w, h).data
  const rgb = new Uint8Array(w * h * 3)
  for (let i = 0, at = 0; i < data.length; i += 4) {
    rgb[at++] = data[i]
    rgb[at++] = data[i + 1]
    rgb[at++] = data[i + 2]
  }

  return call(`/api/upload?w=${w}&h=${h}&name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    body: rgb,
    headers: { 'Content-Type': 'application/octet-stream' },
  })
}

/** Post raw pixels the browser decoded, so the server needs no image codec. */
export async function postImage<T>(file: File): Promise<T> {
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('canvas is unavailable')
  context.drawImage(bitmap, 0, 0)
  const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data
  const rgb = new Uint8Array(bitmap.width * bitmap.height * 3)
  for (let i = 0, at = 0; i < data.length; i += 4) {
    rgb[at++] = data[i]
    rgb[at++] = data[i + 1]
    rgb[at++] = data[i + 2]
  }
  return call<T>(`/api/trace?w=${bitmap.width}&h=${bitmap.height}`, {
    method: 'POST',
    body: rgb,
    headers: { 'Content-Type': 'application/octet-stream' },
  })
}

export type Room = { id: string; name: string; x: number; y: number; w: number; h: number; detached?: boolean }
export type Terminal = { id: string; roomId: string; x: number; y: number; officer: string | null }
export type Officer = {
  name: string
  rank: string
  role: string
  cleared: boolean
  homeTerminal: string
  /** Shown in the UI: without it a reviewer cannot get past the first card reader. */
  demoPin: string
  fp: string
  card: { attemptsLeft: number; locked: boolean; revoked: boolean }
  standing: { enrolled: boolean; revoked: boolean; reason?: string }
  breakGlassTokens: number
}
export type Attester = { name: string; location: string }
export type AnchorView = {
  seq: number
  treeSize: number
  root: string
  takenAt: string
  witness: string
  quorum: { nodeName: string }[]
}
export type Doc = { key: string; name: string; describe: string }

export type LedgerRecord = {
  v: string
  name?: string
  rank?: string
  reason?: string
  tokenId?: string
  enrolledAt?: string
  revokedAt?: string
  docId?: string
  docName?: string
  recipientName?: string
  recipientFp?: string
  codewordCommit?: string
  copySha512?: string
  terminal?: string
  issuedAt?: string
  openedAt?: string
  sessionId?: string
  ledgerId?: string
  quorum?: number
  roster?: { id: string; name: string; fp: string }[]
}

export type LedgerBlock = {
  height: number
  blockHash: string
  prevHash: string
  recordsRoot: string
  attestations: string[]
  record: LedgerRecord
}

export type LedgerNodeView = {
  id: string
  name: string
  location: string
  ok: boolean
  problems: string[]
  height: number
  tipHash: string
  onMajority: boolean
  blocks: LedgerBlock[]
}

export type LedgerView = {
  ledgerId: string
  quorum: number
  nodeCount: number
  majorityTip: string | null
  agreeing: string[]
  divergent: string[]
  treeHead: { size: number; root: string; signedBy: { nodeName: string }[] } | null
  anchors: {
    count: number
    ok: boolean
    problems: string[]
    coversUpTo: number
    last: { seq: number; size: number; root: string; takenAt: string; witness: string; slhDsaBytes: number } | null
  }
  nodes: LedgerNodeView[]
}

export type CopyView = {
  copyId: string
  docId: string
  docName: string
  label: string
  terminal: string
  openedAt: string
  copySha512: string
}

export type SealedView = {
  docId: string
  docName: string
  recipients: string[]
  senderName: string
  createdAt: string
  boxRoot: string
  boxCount: number
  sizes: { total: number; expansionFactor: number; perSlot: number; boxes: number }
  wm: { tiles: number; gridW: number; gridH: number; alpha: number; seedCommit: string }
}

export type WorldState = {
  officers: Officer[]
  rooms: Room[]
  terminals: Terminal[]
  attesters: Attester[]
  docs: Doc[]
  sealed: SealedView[]
  copies: CopyView[]
  ledger: LedgerView
  attestersReachable: boolean
  pendingBreakGlass: {
    docName: string
    recipientName: string
    tokenId: string
    terminal: string
    openedAt: string
  }[]
  suite: Record<string, string>
  config: Record<string, number | string>
}

/** How far apart two officers' copies of the same picture actually are. */
export type CompareStats = {
  ok: boolean
  psnr: number
  ssim: number
  maxDeviation: number
  differingSamples: number
  totalSamples: number
  visibleAtGain: number
  error?: string
}

export type Field = { label: string; value: string; secret?: boolean; note?: string }
export type Step = { n: number; title: string; detail: string; ok: boolean | null; fields: Field[] }

export type Candidate = { recipientName: string; recipientFp: string; errors: number; counted: number; rate: number }

export type Verdict =
  | { kind: 'NO_WATERMARK'; readableCount: number; reason: string }
  | { kind: 'GEOMETRY_MISMATCH'; reason: string }
  | { kind: 'ATTRIBUTED'; candidate: Candidate; runnerUp: Candidate | null; readableCount: number }
  | { kind: 'COLLUSION_SET'; members: Candidate[]; unexplained: number; margin: number; readableCount: number }
  | { kind: 'INCONCLUSIVE'; candidates: Candidate[]; readableCount: number; reason: string }

export type ProofBundle = {
  verdict: Verdict
  docId: string | null
  docName: string | null
  documentsConsidered: number
  reading: { readableCount: number; totalTiles: number; meanAbsZ: number; resized: boolean } | null
  candidates: Candidate[]
  checks: { label: string; ok: boolean; detail: string; tier?: 'cryptographic' | 'derived' | 'asserted' }[]
  tiles: { index: number; z: number; bit: number; readable: boolean }[]
  summary: string
}

export const api = {
  world: () => get<{ ok: boolean; state: WorldState }>('/api/world'),
  reset: () => post<{ ok: boolean; state: WorldState }>('/api/reset'),
  seal: (docKey: string, recipients: string[]) =>
    post<{
      ok: boolean
      docId: string
      steps: Step[]
      sizes: SealedView['sizes']
      quality: { psnrAB: number; ssimAB: number; maxDeviation: number; worstTilePsnrAB: number }
      state: WorldState
      error?: string
    }>('/api/seal', { docKey, recipients }),
  open: (docId: string, officer: string, terminal: string, pin: string) =>
    post<{
      ok: boolean
      steps: Step[]
      copy?: { copyId: string; recipientName: string; terminal: string; copySha512: string; openedAt: string }
      record?: LedgerRecord
      firstIssue?: boolean
      block?: { height: number; blockHash: string; prevHash: string; recordsRoot: string; attestations: string[] }
      error?: { code: string; message: string }
      state: WorldState
    }>('/api/open', { docId, officer, terminal, pin }),
  openAll: (docId: string) =>
    post<{ ok: boolean; opened: string[]; state: WorldState }>('/api/open-all', { docId }),
  trace: (copyId: string) =>
    post<{ ok: boolean; proof: ProofBundle; steps: Step[]; state: WorldState }>(
      `/api/trace?copyId=${encodeURIComponent(copyId)}`,
    ),
  attack: (copyId: string, attack: string, strength?: number) =>
    post<{ ok: boolean; copyId: string; psnr: number | null; state: WorldState }>('/api/attack', {
      copyId,
      attack,
      strength,
    }),
  collude: (copyIds: string[], strategy: string) =>
    post<{ ok: boolean; copyId: string; state: WorldState; error?: string }>('/api/collude', { copyIds, strategy }),
  tamper: (nodeId: string, height: number, field: string, value: string, rehash: boolean) =>
    post<{ ok: boolean; change?: { before: string; after: string }; error?: string; state: WorldState }>(
      '/api/ledger/tamper',
      { nodeId, height, field, value, rehash },
    ),
  inclusion: (height: number) =>
    get<{ ok: boolean; height: number; leaf: string; proof: string[]; root: string; size: number; verified: boolean }>(
      `/api/ledger/proof/${height}`,
    ),
  consistency: (from: number) =>
    get<{ ok: boolean; from: number; to: number; proof: string[]; oldRoot: string; newRoot: string; verified: boolean }>(
      `/api/ledger/consistency?from=${from}`,
    ),
  health: () => get<{ ok: boolean; suite: Record<string, string>; config: Record<string, number> }>('/api/health'),
  compare: (a: string, b: string) =>
    get<CompareStats>(`/api/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`),
  anchor: (witness: string) =>
    post<{
      ok: boolean
      anchor?: { seq: number; size: number; root: string; takenAt: string; witness: string; slhDsaBytes: number }
      error?: string
      state: WorldState
    }>(
      '/api/anchor',
      { witness },
    ),
  anchors: () =>
    get<{
      ok: boolean
      anchors: AnchorView[]
      check: { ok: boolean; checked: number; coversUpTo: number; problems: string[] }
    }>('/api/anchors'),
  revoke: (name: string, reason: string, pin: string) =>
    post<{ ok: boolean; error?: string; state: WorldState }>('/api/revoke', { name, reason, pin }),
  setAttesters: (reachable: boolean) =>
    post<{ ok: boolean; state: WorldState }>('/api/attesters', { reachable }),
  // The server picks the officer's next unused token; there is nothing for the
  // caller to choose, and letting it choose would be a way to reuse one.
  breakGlass: (docId: string, officer: string, terminal: string, pin: string) =>
    post<{
      ok: boolean
      error?: { code: string; message: string }
      copyId?: string
      tokenId?: string
      tokensLeft?: number
      steps?: Step[]
      state: WorldState
    }>('/api/break-glass', { docId, officer, terminal, pin }),
  reconcile: () =>
    post<{ ok: boolean; committed: number; before: number; steps?: Step[]; state: WorldState }>('/api/reconcile'),
}

/** The amplified difference between two copies, at a gain the page states out loud. */
export function compareUrl(a: string, b: string, gain: number): string {
  return imageUrl(`/api/compare/${encodeURIComponent(a)}/${encodeURIComponent(b)}.png`) + `&gain=${gain}`
}

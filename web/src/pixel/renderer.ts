import { PALETTE, SPRITES, TILE, TILES } from './art.ts'
import type { Attester, LedgerNodeView, Officer, Room, Terminal } from '../api.ts'

export type Sprite = { canvas: HTMLCanvasElement; w: number; h: number }

function paint(rows: string[]): Sprite {
  const w = rows[0].length
  const h = rows.length
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const context = canvas.getContext('2d')!
  const image = context.createImageData(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const colour = PALETTE[rows[y][x]]
      const at = (y * w + x) * 4
      if (!colour || colour === 'transparent') continue
      image.data[at] = parseInt(colour.slice(1, 3), 16)
      image.data[at + 1] = parseInt(colour.slice(3, 5), 16)
      image.data[at + 2] = parseInt(colour.slice(5, 7), 16)
      image.data[at + 3] = 255
    }
  }
  context.putImageData(image, 0, 0)
  return { canvas, w, h }
}

let atlas: Record<string, Sprite> | null = null

function sprites(): Record<string, Sprite> {
  if (atlas) return atlas
  atlas = {}
  for (const [name, rows] of Object.entries(TILES)) atlas[name] = paint(rows)
  for (const [name, rows] of Object.entries(SPRITES)) atlas[name] = paint(rows)
  return atlas
}

export type Scene = {
  rooms: Room[]
  terminals: Terminal[]
  officers: Officer[]
  attesters: Attester[]
  nodes: LedgerNodeView[]
  width: number
  height: number
}

/** Which room each attester's rack stands in. */
const RACK_ROOM: Record<string, string> = {
  'bridge-node': 'bridge',
  'ops-node': 'ops',
  'signals-node': 'signals',
  'shore-node': 'shore-hq',
}

export function buildScene(args: {
  rooms: Room[]
  terminals: Terminal[]
  officers: Officer[]
  attesters: Attester[]
  nodes: LedgerNodeView[]
}): Scene {
  const width = Math.max(...args.rooms.map((r) => r.x + r.w)) + 1
  const height = Math.max(...args.rooms.map((r) => r.y + r.h)) + 1
  return { ...args, width, height }
}

export function rackPosition(scene: Scene, attesterName: string): { x: number; y: number } | null {
  const room = scene.rooms.find((r) => r.id === RACK_ROOM[attesterName])
  if (!room) return null
  return { x: room.x + room.w - 3, y: room.y + 2 }
}

export type RenderState = {
  /** Terminals lit because a document is open on them. */
  active: Set<string>
  /** Terminals that just refused somebody. */
  denied: Set<string>
  /** Drawn with a pulsing outline: the next thing to click. */
  hinted: Set<string>
  /** Highlighted as the result of a forensic trace. */
  accused: Set<string>
  hovered: string | null
}

export const EMPTY_STATE: RenderState = {
  active: new Set(),
  denied: new Set(),
  hinted: new Set(),
  accused: new Set(),
  hovered: null,
}

export type Hotspot = {
  kind: 'terminal' | 'node' | 'room'
  id: string
  x: number
  y: number
  w: number
  h: number
}

/** Everything clickable, in device pixels at 1:1. Scale before hit-testing. */
export function hotspots(scene: Scene): Hotspot[] {
  const out: Hotspot[] = []
  for (const room of scene.rooms) {
    out.push({ kind: 'room', id: room.id, x: room.x * TILE, y: room.y * TILE, w: room.w * TILE, h: room.h * TILE })
  }
  for (const attester of scene.attesters) {
    const at = rackPosition(scene, attester.name)
    if (at) out.push({ kind: 'node', id: attester.name, x: at.x * TILE, y: at.y * TILE, w: TILE, h: TILE })
  }
  for (const terminal of scene.terminals) {
    out.push({
      kind: 'terminal',
      id: terminal.id,
      x: terminal.x * TILE - 2,
      y: (terminal.y - 1) * TILE,
      w: TILE + 4,
      h: TILE * 2 + 4,
    })
  }
  // Terminals sit above racks, which sit above rooms, so the most specific hit wins.
  return out.reverse()
}

export function hitTest(scene: Scene, x: number, y: number): Hotspot | null {
  for (const spot of hotspots(scene)) {
    if (x >= spot.x && x < spot.x + spot.w && y >= spot.y && y < spot.y + spot.h) return spot
  }
  return null
}

function blit(context: CanvasRenderingContext2D, sprite: Sprite, x: number, y: number): void {
  context.drawImage(sprite.canvas, Math.round(x), Math.round(y))
}

function outline(context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, colour: string, dash = false): void {
  context.save()
  context.strokeStyle = colour
  context.lineWidth = 1
  if (dash) context.setLineDash([2, 2])
  context.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
  context.restore()
}

export function render(context: CanvasRenderingContext2D, scene: Scene, state: RenderState): void {
  const art = sprites()
  context.imageSmoothingEnabled = false
  context.fillStyle = '#f3efe6'
  context.fillRect(0, 0, scene.width * TILE, scene.height * TILE)

  for (const room of scene.rooms) {
    for (let ty = 0; ty < room.h; ty++) {
      for (let tx = 0; tx < room.w; tx++) {
        const edge = tx === 0 || ty === 0 || tx === room.w - 1 || ty === room.h - 1
        blit(context, art[edge ? 'wall' : 'floor'], (room.x + tx) * TILE, (room.y + ty) * TILE)
      }
    }
    // A doorway on the inboard wall, so rooms read as connected rather than sealed.
    if (!room.detached) {
      blit(context, art.door, (room.x + Math.floor(room.w / 2)) * TILE, (room.y + room.h - 1) * TILE)
    }
    blit(context, art.plant, (room.x + 1) * TILE, (room.y + room.h - 2) * TILE)
  }

  // The cabin seals documents; the security office traces leaks.
  const cabin = scene.rooms.find((r) => r.id === 'co-cabin')
  if (cabin) blit(context, art.table, (cabin.x + cabin.w - 5) * TILE, (cabin.y + 2) * TILE)
  const security = scene.rooms.find((r) => r.id === 'security')
  if (security) blit(context, art.bench, (security.x + security.w - 5) * TILE, (security.y + 2) * TILE)

  for (const attester of scene.attesters) {
    const at = rackPosition(scene, attester.name)
    if (!at) continue
    const node = scene.nodes.find((n) => n.name === attester.name)
    const healthy = node ? node.ok && node.onMajority : true
    blit(context, art[healthy ? 'rackOk' : 'rackBad'], at.x * TILE, at.y * TILE)
    if (!healthy) outline(context, at.x * TILE, at.y * TILE, TILE, TILE, '#a8391f')
    if (state.hovered === attester.name) outline(context, at.x * TILE, at.y * TILE, TILE, TILE, '#a76a09')
  }

  for (const terminal of scene.terminals) {
    const px = terminal.x * TILE
    const py = terminal.y * TILE
    blit(context, art.desk, px, py)
    const screen = state.denied.has(terminal.id)
      ? 'monitorDenied'
      : state.active.has(terminal.id)
        ? 'monitorOn'
        : 'monitorOff'
    blit(context, art[screen], px, py - TILE)
    blit(context, art.chair, px, py + TILE)

    const officer = scene.officers.find((o) => o.homeTerminal === terminal.id)
    if (officer) {
      const kind = terminal.id === 'CO-01' ? 'command' : officer.cleared ? 'officer' : 'rating'
      blit(context, art[kind], px + TILE + 2, py + TILE - 4)
      if (state.accused.has(officer.name)) {
        outline(context, px + TILE + 2, py + TILE - 4, TILE, 20, '#a8391f')
        outline(context, px + TILE, py + TILE - 6, TILE + 4, 24, '#a8391f', true)
      }
    }

    if (state.hovered === terminal.id) outline(context, px - 2, py - TILE, TILE + 4, TILE * 2 + 4, '#a76a09')
    if (state.hinted.has(terminal.id)) outline(context, px - 3, py - TILE - 1, TILE + 6, TILE * 2 + 6, '#c98a12', true)
    if (state.accused.has(terminal.id)) outline(context, px - 3, py - TILE - 1, TILE + 6, TILE * 2 + 6, '#a8391f')
  }
}

export { TILE }

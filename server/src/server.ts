import { CONFIG, configSummary } from './config.ts'
import { CnsaError, SUITE } from './cnsa.ts'
import { bytes, corsHeaders, json } from './http.ts'
import {
  addNoise,
  boxBlurImage,
  brightnessContrast,
  collude,
  colludeByTile,
  cropPad,
  jpegLike,
  posterize,
  resizeRoundTrip,
  type ColludeStrategy,
} from './attacks.ts'
import { traceLeak } from './forensics.ts'
import { amplifiedDifference, maxDeviation, psnr, ssim } from './metrics.ts'
import { decodePng, encodePng, isPng, type Bitmap } from './png.ts'
import { openAndAssemble, openUnderBreakGlass, reconcileBreakGlass } from './pipeline.ts'
import { boxProof, packageSizes, sealVariantPackage } from './seal.ts'
import { Trace } from './trace.ts'
import { assemble, buildVariants } from './variants.ts'
import { OfflineLedger } from './ledger.ts'
import {
  ATTESTERS,
  OFFICERS,
  ROOMS,
  TERMINALS,
  createWorld,
  officerMeta,
  publicOfficer,
  persistCopy,
  persistDocument,
  senderIdentity,
  type World,
} from './world.ts'

const SPEC = { bandLo: CONFIG.bandLo, bandHi: CONFIG.bandHi }

const EMBED = {
  alpha: CONFIG.alpha,
  base: CONFIG.alphaBase,
  slope: CONFIG.alphaSlope,
  floorMul: CONFIG.alphaFloorMul,
  capMul: CONFIG.alphaCapMul,
  activityRef: CONFIG.activityRef,
  activityWindow: CONFIG.activityWindow,
  spec: SPEC,
}

const DETECT = {
  spec: SPEC,
  decoyCount: CONFIG.decoyCount,
  zThreshold: CONFIG.zThreshold,
  residualWindow: CONFIG.residualWindow,
}

const STARTED_AT = new Date().toISOString()

/**
 * One world per session, so two reviewers clicking around at the same time do not
 * turn up in each other's ledger. A single shared demo is simpler right up until
 * two people open it at once and the log stops making sense.
 */
const worlds = new Map<string, World>()

function sessionId(request: Request): string {
  const header = request.headers.get('x-sih-session')
  if (header) return header
  // An <img> tag cannot set a header, so image URLs carry the session as a query
  // parameter instead. Without this they resolve against the wrong world.
  return new URL(request.url).searchParams.get('s') ?? 'default'
}

function worldFor(request: Request): World {
  const id = sessionId(request)
  let world = worlds.get(id)
  if (!world) {
    world = createWorld(id)
    worlds.set(id, world)
  }
  return world
}

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T
  } catch {
    return {} as T
  }
}

function worldState(world: World) {
  return {
    officers: OFFICERS.map((o) => ({
      name: o.name,
      rank: o.rank,
      role: o.role,
      cleared: o.cleared,
      homeTerminal: o.homeTerminal,
      // Surfaced deliberately. In service the PIN is known only to the officer;
      // in a demo, withholding it only strands the reviewer.
      demoPin: o.pin,
      fp: world.cards.publicIdentity(o.name).fp,
      card: world.cards.status(o.name),
      standing: world.ledger.standingOf(world.cards.publicIdentity(o.name).fp),
      breakGlassTokens: world.breakGlassTokens.get(o.name)?.length ?? 0,
    })),
    rooms: ROOMS,
    terminals: TERMINALS,
    attesters: ATTESTERS,
    docs: world.docs.map((d) => ({ key: d.key, name: d.name, describe: d.describe })),
    sealed: [...world.sealed.values()].map((s) => ({
      docId: s.docId,
      docName: s.docName,
      recipients: s.recipients,
      senderName: s.pkg.manifest.senderName,
      createdAt: s.pkg.manifest.createdAt,
      sizes: s.sizes,
      boxRoot: s.pkg.manifest.boxRoot,
      boxCount: s.pkg.manifest.boxCount,
      wm: s.pkg.manifest.wm,
    })),
    copies: [...world.copies.values()].map((c) => ({
      copyId: c.copyId,
      docId: c.docId,
      docName: c.docName,
      // The exhibit list must not carry the officer's name, or the forensic step
      // would be answering a question it had already been handed.
      label: `exhibit ${c.copyId.slice(-6)}`,
      terminal: c.terminal,
      openedAt: c.openedAt,
      copySha512: c.copySha512,
    })),
    ledger: world.ledger.snapshot(),
    attestersReachable: world.attestersReachable,
    pendingBreakGlass: world.breakGlassQueue.map((p) => ({
      docName: p.record.docName,
      recipientName: p.record.recipientName,
      tokenId: p.record.tokenId,
      terminal: p.record.terminal,
      openedAt: p.record.openedAt,
    })),
    suite: SUITE,
    config: configSummary(),
  }
}

function findCopy(world: World, copyId: string) {
  const copy = world.copies.get(copyId)
  if (!copy) throw new Error(`no copy ${copyId}`)
  return copy
}

function applyAttack(image: Bitmap, attack: string, strength?: number): Bitmap {
  switch (attack) {
    case 'noise':
      return addNoise(image, strength ?? 6)
    case 'jpeg':
      return jpegLike(image, strength ?? 80)
    case 'blur':
      return boxBlurImage(image, strength ?? 1)
    case 'resize':
      return resizeRoundTrip(image, strength ?? 0.5)
    case 'brightness':
      return brightnessContrast(image, strength ?? 1.2, 15)
    case 'posterize':
      return posterize(image, strength ?? 32)
    case 'crop':
      return cropPad(image, strength ?? 8)
    default:
      throw new Error(`unknown attack ${attack}`)
  }
}

type Handler = (request: Request, world: World) => Response | Promise<Response>

const routes: Record<string, Handler> = {
  'GET /api/health': (request) =>
    json(request, {
      ok: true,
      service: 'sih26237',
      startedAt: STARTED_AT,
      uptimeSeconds: Math.round(process.uptime()),
      sessions: worlds.size,
      suite: SUITE,
      config: configSummary(),
    }),

  'GET /api/world': (request, world) => json(request, { ok: true, state: worldState(world) }),

  'POST /api/reset': (request) => {
    const id = sessionId(request)
    // Starting over has to clear the stored log as well, or the world comes back
    // from disk with the history the reviewer just asked to be rid of.
    worlds.get(id)?.store.forget(id)
    worlds.delete(id)
    return json(request, { ok: true, state: worldState(worldFor(request)) })
  },

  /**
   * Take an image the Commanding Officer chose from their own machine and make it
   * available to seal. It joins the demo documents rather than being a special
   * case, so everything downstream treats it identically.
   *
   * The browser decodes and scales the file and posts raw pixels, which keeps
   * every image codec out of the server.
   */
  'POST /api/upload': async (request, world) => {
    const url = new URL(request.url)
    const width = Number(url.searchParams.get('w'))
    const height = Number(url.searchParams.get('h'))
    const name = (url.searchParams.get('name') ?? 'uploaded.png').slice(0, 80)
    const raw = new Uint8Array(await request.arrayBuffer())

    if (!width || !height || width < 128 || height < 128 || width > 1024 || height > 1024) {
      return json(request, { ok: false, error: 'the image must be between 128 and 1024 pixels on each side' }, 400)
    }
    if (raw.length !== width * height * 3) {
      return json(request, { ok: false, error: `expected ${width * height * 3} bytes of RGB, received ${raw.length}` }, 400)
    }
    if (width < CONFIG.gridW || height < CONFIG.gridH) {
      return json(request, { ok: false, error: 'the image is too small to tile' }, 400)
    }

    const image: Bitmap = { width, height, rgb: raw }
    const key = `upload-${Math.random().toString(36).slice(2, 10)}`
    world.docs.push({
      key,
      name,
      describe: `Uploaded from the cabin \u00b7 ${width} x ${height}`,
      build: () => image,
    })
    return json(request, { ok: true, key, name, width, height, state: worldState(world) })
  },

  'POST /api/seal': async (request, world) => {
    const { docKey, recipients, pin } = await body<{ docKey: string; recipients: string[]; pin: string }>(request)
    const doc = world.docs.find((d) => d.key === docKey)
    if (!doc) return json(request, { ok: false, error: `no document ${docKey}` }, 400)
    if (!recipients?.length) return json(request, { ok: false, error: 'pick at least one officer' }, 400)

    const image = doc.build(CONFIG.imageWidth)
    const trace = new Trace()
    let sealed
    try {
      sealed = world.cards.unlock(world.senderName, pin ?? '', (card) =>
        sealVariantPackage({
          sender: card,
          recipients: recipients.map((n) => publicOfficer(world, n)),
          image,
          docName: doc.name,
          serverWmKey: world.serverWmKey,
          gridW: CONFIG.gridW,
          gridH: CONFIG.gridH,
          embed: EMBED,
          trace,
        }),
      )
    } catch (error) {
      const e = error as CnsaError
      return json(request, { ok: false, error: e.message, code: e.code, state: worldState(world) }, 400)
    }

    const docId = sealed.pkg.manifest.docId
    world.keystore.set(docId, {
      docId,
      docName: doc.name,
      docKey: sealed.docKey,
      seed: sealed.seed,
      grid: sealed.grid,
      codewords: sealed.codewords,
      commitSalts: new Map(),
    })
    world.sealed.set(docId, {
      docId,
      docName: doc.name,
      pkg: sealed.pkg,
      recipients,
      original: encodePng(image),
      sizes: packageSizes(sealed.pkg),
    })

    persistDocument(world, sessionId(request), docId)

    // So the reviewer can see for themselves that the two variants are the same picture.
    const built = buildVariants(image, sealed.grid, sealed.seed, EMBED)
    const variantA = assemble(sealed.grid, built.pairs.map((p) => p.a))
    const variantB = assemble(sealed.grid, built.pairs.map((p) => p.b))

    return json(request, {
      ok: true,
      docId,
      manifest: sealed.pkg.manifest,
      steps: trace.steps,
      sizes: packageSizes(sealed.pkg),
      quality: {
        psnrAB: psnr(variantA, variantB),
        ssimAB: ssim(variantA, variantB),
        maxDeviation: maxDeviation(image, variantA),
        worstTilePsnrAB: Math.min(...built.quality.map((q) => q.psnrAB)),
      },
      state: worldState(world),
    })
  },

  'POST /api/open': async (request, world) => {
    const args = await body<{ docId: string; officer: string; terminal: string; pin: string }>(request)
    const sealed = world.sealed.get(args.docId)
    if (!sealed) return json(request, { ok: false, error: `no sealed document ${args.docId}` }, 400)

    const meta = OFFICERS.find((o) => o.name === args.officer)
    if (!meta) return json(request, { ok: false, error: `no officer ${args.officer}` }, 400)
    const terminal = args.terminal || officerMeta(args.officer).homeTerminal

    if (!world.attestersReachable) {
      return json(request, {
        ok: false,
        error: {
          code: 'attesters_unreachable',
          message:
            'the attesters cannot be reached, so nothing can be recorded and nothing will be released. An emergency token can be spent instead.',
        },
        state: worldState(world),
      })
    }

    const trace = new Trace()
    try {
      // The PIN is checked inside the card, not here. This handler never holds
      // the officer's key and could not sign as them if it wanted to.
      const result = world.cards.unlock(args.officer, args.pin ?? '', (card) =>
        openAndAssemble({
          recipient: card,
          sender: senderIdentity(world),
          pkg: sealed.pkg,
          ledger: world.ledger,
          keystore: world.keystore,
          terminal,
          trace,
        }),
      )
      world.copies.set(result.copy.copyId, result.copy)
      persistCopy(world, sessionId(request), result.copy.copyId)
      // The first open fills in a commit salt, so the stored copy has to follow.
      persistDocument(world, sessionId(request), args.docId)
      return json(request, {
        ok: true,
        steps: trace.steps,
        copy: {
          copyId: result.copy.copyId,
          docId: result.copy.docId,
          docName: result.copy.docName,
          recipientName: result.copy.recipientName,
          terminal: result.copy.terminal,
          copySha512: result.copy.copySha512,
          openedAt: result.copy.openedAt,
        },
        record: result.record,
        firstIssue: result.firstIssue,
        block: {
          height: result.block.height,
          blockHash: result.block.blockHash,
          prevHash: result.block.prevHash,
          recordsRoot: result.block.recordsRoot,
          attestations: result.block.attestations.map((a) => a.nodeName),
        },
        state: worldState(world),
      })
    } catch (error) {
      const e = error as Error & { code?: string }
      trace.fail('Refused', e.message)
      return json(request, {
        ok: false,
        steps: trace.steps,
        error: { code: e.code ?? 'error', message: e.message },
        state: worldState(world),
      })
    }
  },

  /**
   * Open the document as every officer on the list who has not opened it yet.
   *
   * Purely a convenience for the demo: with nine cleared officers, clicking
   * through each card reader is the slowest part of showing the system and the
   * least interesting. Each open runs the identical path a single one would.
   */
  'POST /api/open-all': async (request, world) => {
    const { docId } = await body<{ docId: string }>(request)
    const sealed = world.sealed.get(docId)
    if (!sealed) return json(request, { ok: false, error: `no sealed document ${docId}` }, 400)

    const opened: string[] = []
    for (const name of sealed.recipients) {
      const fp = world.cards.publicIdentity(name).fp
      if (world.ledger.findIssuance(docId, fp)) continue
      try {
        // Each officer's own card, unlocked with their own PIN. The shortcut
        // saves clicks, not checks.
        const result = world.cards.unlock(name, officerMeta(name).pin, (card) =>
          openAndAssemble({
            recipient: card,
            sender: senderIdentity(world),
            pkg: sealed.pkg,
            ledger: world.ledger,
            keystore: world.keystore,
            terminal: officerMeta(name).homeTerminal,
          }),
        )
        world.copies.set(result.copy.copyId, result.copy)
        persistCopy(world, sessionId(request), result.copy.copyId)
        opened.push(name)
      } catch {
        // An officer who cannot open it is the refusal path working, not a
        // failure of this endpoint.
      }
    }
    persistDocument(world, sessionId(request), docId)
    return json(request, { ok: true, opened, state: worldState(world) })
  },

  /**
   * Take the current tree head out of the attesters' custody and record where it
   * went. This is the only thing that survives every custodian agreeing to lie.
   */
  'POST /api/anchor': async (request, world) => {
    const { witness } = await body<{ witness: string }>(request)
    const anchor = world.ledger.takeAnchor(
      (witness ?? '').trim() || 'read into the watch log and countersigned by the officer of the watch',
    )
    if (!anchor) return json(request, { ok: false, error: 'no authoritative chain to anchor' }, 400)
    return json(request, {
      ok: true,
      anchor: {
        seq: anchor.seq,
        size: anchor.size,
        root: anchor.root,
        takenAt: anchor.takenAt,
        witness: anchor.witness,
        slhDsaBytes: anchor.slhDsaSig.length,
      },
      state: worldState(world),
    })
  },

  // How far apart two officers' copies actually are, so the claim under the
  // challenge screen is a measurement and not an adjective.
  'GET /api/compare': (request, world) => {
    const url = new URL(request.url)
    const a = world.copies.get(url.searchParams.get('a') ?? '')
    const b = world.copies.get(url.searchParams.get('b') ?? '')
    if (!a || !b) return json(request, { ok: false, error: 'no such copy' }, 404)
    if (a.image.width !== b.image.width || a.image.height !== b.image.height) {
      return json(request, { ok: false, error: 'the two copies are no longer the same size' }, 400)
    }
    let differing = 0
    for (let i = 0; i < a.image.rgb.length; i++) if (a.image.rgb[i] !== b.image.rgb[i]) differing++
    return json(request, {
      ok: true,
      psnr: psnr(a.image, b.image),
      ssim: ssim(a.image, b.image),
      maxDeviation: maxDeviation(a.image, b.image),
      differingSamples: differing,
      totalSamples: a.image.rgb.length,
      // The gain at which a one-level difference reaches mid-grey plus 64, which
      // is roughly where the eye starts to resolve it against a flat field.
      visibleAtGain: Math.max(1, Math.round(64 / Math.max(1, maxDeviation(a.image, b.image)))),
    })
  },

  'GET /api/anchors': (request, world) =>
    json(request, {
      ok: true,
      anchors: world.ledger.anchors().map((a) => ({
        seq: a.seq,
        size: a.size,
        root: a.root,
        takenAt: a.takenAt,
        witness: a.witness,
      })),
      verification: world.ledger.verifyAnchors(),
    }),

  'POST /api/revoke': async (request, world) => {
    const { officer: name, reason } = await body<{ officer: string; reason: string }>(request)
    try {
      const fp = world.cards.publicIdentity(name).fp
      world.cards.revoke(name)
      world.ledger.revokeCard(name, fp, (reason ?? '').trim() || 'card reported lost')
      return json(request, { ok: true, state: worldState(world) })
    } catch (error) {
      return json(request, { ok: false, error: (error as Error).message }, 400)
    }
  },

  /** Pretend the attesters cannot be reached, so break-glass can be shown. */
  'POST /api/attesters': async (request, world) => {
    const { reachable } = await body<{ reachable: boolean }>(request)
    world.attestersReachable = reachable !== false
    return json(request, { ok: true, state: worldState(world) })
  },

  'POST /api/break-glass': async (request, world) => {
    const args = await body<{ docId: string; officer: string; terminal: string; pin: string }>(request)
    const sealed = world.sealed.get(args.docId)
    if (!sealed) return json(request, { ok: false, error: `no sealed document ${args.docId}` }, 400)

    const tokens = world.breakGlassTokens.get(args.officer) ?? []
    if (tokens.length === 0) {
      return json(request, {
        ok: false,
        error: { code: 'no_tokens', message: 'this officer has no emergency tokens left' },
        state: worldState(world),
      })
    }

    const trace = new Trace()
    try {
      const tokenId = tokens[0]
      const result = world.cards.unlock(args.officer, args.pin ?? '', (card) =>
        openUnderBreakGlass({
          recipient: card,
          sender: senderIdentity(world),
          pkg: sealed.pkg,
          keystore: world.keystore,
          terminal: args.terminal || officerMeta(args.officer).homeTerminal,
          tokenId,
          trace,
        }),
      )
      tokens.shift()
      world.breakGlassTokens.set(args.officer, tokens)
      world.breakGlassQueue.push(result.pending)
      world.copies.set(result.copy.copyId, result.copy)
      persistCopy(world, sessionId(request), result.copy.copyId)
      return json(request, {
        ok: true,
        steps: trace.steps,
        copyId: result.copy.copyId,
        tokenId,
        tokensLeft: tokens.length,
        state: worldState(world),
      })
    } catch (error) {
      const e = error as CnsaError
      trace.fail('Refused', e.message)
      return json(request, {
        ok: false,
        steps: trace.steps,
        error: { code: e.code ?? 'error', message: e.message },
        state: worldState(world),
      })
    }
  },

  'POST /api/reconcile': (request, world) => {
    const trace = new Trace()
    const before = world.breakGlassQueue.length
    try {
      const committed = reconcileBreakGlass(world.ledger, world.breakGlassQueue, trace)
      return json(request, { ok: true, committed, before, steps: trace.steps, state: worldState(world) })
    } catch (error) {
      return json(request, { ok: false, error: (error as Error).message, state: worldState(world) }, 400)
    }
  },

  'GET /api/ledger': (request, world) => json(request, { ok: true, ledger: world.ledger.snapshot() }),

  'GET /api/ledger/consistency': (request, world) => {
    const from = Number(new URL(request.url).searchParams.get('from') ?? '0')
    const c = world.ledger.consistency(from)
    if (!c) return json(request, { ok: false, error: 'no authoritative chain' }, 400)
    return json(request, {
      ok: true,
      ...c,
      verified: OfflineLedger.checkConsistency(c.from, c.to, c.oldRoot, c.newRoot, c.proof),
    })
  },

  'POST /api/ledger/tamper': async (request, world) => {
    const args = await body<{
      nodeId: string
      height: number
      field: 'recipientName' | 'copySha512' | 'issuedAt'
      value: string
      rehash: boolean
    }>(request)
    try {
      const change = world.ledger.tamper(args)
      return json(request, { ok: true, change, state: worldState(world) })
    } catch (error) {
      return json(request, { ok: false, error: (error as Error).message, state: worldState(world) }, 400)
    }
  },

  'POST /api/attack': async (request, world) => {
    const { copyId, attack, strength } = await body<{ copyId: string; attack: string; strength?: number }>(request)
    try {
      const copy = findCopy(world, copyId)
      const attacked = applyAttack(copy.image, attack, strength)
      const id = `${copyId}--${attack}`
      world.copies.set(id, { ...copy, copyId: id, image: attacked, bytes: encodePng(attacked) })
      persistCopy(world, sessionId(request), id)
      return json(request, {
        ok: true,
        copyId: id,
        psnr: attacked.width === copy.image.width ? psnr(copy.image, attacked) : null,
        state: worldState(world),
      })
    } catch (error) {
      return json(request, { ok: false, error: (error as Error).message }, 400)
    }
  },

  'POST /api/collude': async (request, world) => {
    const { copyIds, strategy } = await body<{ copyIds: string[]; strategy: ColludeStrategy | 'tile' }>(request)
    if (!copyIds || copyIds.length < 2) return json(request, { ok: false, error: 'collusion needs two copies' }, 400)
    try {
      const inputs = copyIds.map((id) => findCopy(world, id))
      const grid = world.keystore.get(inputs[0].docId)?.grid
      const mixed =
        strategy === 'tile' && grid
          ? colludeByTile(inputs.map((c) => c.image), grid)
          : collude(inputs.map((c) => c.image), (strategy as ColludeStrategy) ?? 'average')
      const id = `collusion-${copyIds.map((c) => c.slice(-4)).join('-')}`
      world.copies.set(id, { ...inputs[0], copyId: id, image: mixed, bytes: encodePng(mixed) })
      persistCopy(world, sessionId(request), id)
      return json(request, { ok: true, copyId: id, state: worldState(world) })
    } catch (error) {
      return json(request, { ok: false, error: (error as Error).message }, 400)
    }
  },

  'POST /api/trace': async (request, world) => {
    const url = new URL(request.url)
    const copyId = url.searchParams.get('copyId')
    let leaked: Bitmap

    if (copyId) {
      try {
        leaked = findCopy(world, copyId).image
      } catch (error) {
        return json(request, { ok: false, error: (error as Error).message }, 400)
      }
    } else {
      const raw = new Uint8Array(await request.arrayBuffer())
      if (raw.length === 0) return json(request, { ok: false, error: 'no image supplied' }, 400)
      if (isPng(raw)) {
        leaked = decodePng(raw)
      } else {
        // The browser decodes whatever the reviewer uploads, JPEG or HEIC or
        // anything else it can open, and posts raw RGB. That keeps every image
        // codec out of the server.
        const w = Number(url.searchParams.get('w'))
        const h = Number(url.searchParams.get('h'))
        if (!w || !h || raw.length !== w * h * 3) {
          return json(request, { ok: false, error: 'raw uploads need ?w= and ?h= and exactly w*h*3 bytes' }, 400)
        }
        leaked = { width: w, height: h, rgb: raw }
      }
    }

    const trace = new Trace()
    const proof = traceLeak({ leaked, ledger: world.ledger, keystore: world.keystore, detect: DETECT, trace })
    return json(request, { ok: true, proof, steps: trace.steps, state: worldState(world) })
  },
}

/** Routes carrying a path parameter, matched after the exact table misses. */
function dynamicRoute(request: Request, world: World, path: string): Response | null {
  let match = path.match(/^\/api\/copy\/(.+)\.png$/)
  if (match) {
    const copy = world.copies.get(decodeURIComponent(match[1]))
    if (!copy) return json(request, { ok: false, error: 'no such copy' }, 404)
    return bytes(request, copy.bytes, 'image/png')
  }

  match = path.match(/^\/api\/original\/([^/]+)\.png$/)
  if (match) {
    const sealed = world.sealed.get(match[1])
    if (!sealed) return json(request, { ok: false, error: 'no such document' }, 404)
    return bytes(request, sealed.original, 'image/png')
  }

  match = path.match(/^\/api\/difference\/(.+)\.png$/)
  if (match) {
    const copy = world.copies.get(decodeURIComponent(match[1]))
    const sealed = copy ? world.sealed.get(copy.docId) : undefined
    if (!copy || !sealed) return json(request, { ok: false, error: 'no such copy' }, 404)
    const original = decodePng(sealed.original)
    if (original.width !== copy.image.width || original.height !== copy.image.height) {
      return json(request, { ok: false, error: 'the copy is no longer the original size' }, 400)
    }
    return bytes(request, encodePng(amplifiedDifference(original, copy.image)), 'image/png')
  }

  // The perception challenge. Two officers' copies are the same picture, and the
  // only honest way to show that is to let the reviewer turn the amplification
  // down to 1x and watch the difference disappear. So the gain is a parameter
  // the page names out loud rather than a fixed enhancement baked into a filter.
  match = path.match(/^\/api\/compare\/([^/]+)\/([^/]+)\.png$/)
  if (match) {
    const a = world.copies.get(decodeURIComponent(match[1]))
    const b = world.copies.get(decodeURIComponent(match[2]))
    if (!a || !b) return json(request, { ok: false, error: 'no such copy' }, 404)
    if (a.image.width !== b.image.width || a.image.height !== b.image.height) {
      return json(request, { ok: false, error: 'the two copies are no longer the same size' }, 400)
    }
    const raw = Number(new URL(request.url).searchParams.get('gain') ?? 1)
    const gain = Number.isFinite(raw) ? Math.min(255, Math.max(1, Math.round(raw))) : 1
    return bytes(request, encodePng(amplifiedDifference(a.image, b.image, gain)), 'image/png')
  }

  match = path.match(/^\/api\/ledger\/proof\/(\d+)$/)
  if (match) {
    const height = Number(match[1])
    const proof = world.ledger.inclusionProof(height)
    if (!proof) return json(request, { ok: false, error: 'no such height' }, 404)
    return json(request, {
      ok: true,
      height,
      ...proof,
      verified: world.ledger.verifyInclusion(height, proof.leaf, proof.proof, proof.size, proof.root),
    })
  }

  match = path.match(/^\/api\/box-proof\/([^/]+)\/(\d+)\/([AB])$/)
  if (match) {
    const sealed = world.sealed.get(match[1])
    if (!sealed) return json(request, { ok: false, error: 'no such document' }, 404)
    try {
      const { proof, leafIndex } = boxProof(sealed.pkg, Number(match[2]), match[3] as 'A' | 'B')
      return json(request, { ok: true, proof, leafIndex, root: sealed.pkg.manifest.boxRoot })
    } catch (error) {
      return json(request, { ok: false, error: (error as Error).message }, 404)
    }
  }

  return null
}

const server = Bun.serve({
  // Inside a container this must be 0.0.0.0 or Docker's port mapping cannot
  // reach it. Exposure is bounded by the host-side mapping, which is
  // 127.0.0.1:8090, so the API never lands on the VM's public interface.
  hostname: CONFIG.host,
  port: CONFIG.port,
  // Sealed packages run to about a megabyte and a half.
  maxRequestBodySize: 64 * 1024 * 1024,
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) })
    }
    const url = new URL(request.url)
    const world = worldFor(request)

    const handler = routes[`${request.method} ${url.pathname}`]
    if (handler) return handler(request, world)

    const dynamic = dynamicRoute(request, world, url.pathname)
    if (dynamic) return dynamic

    return json(request, { ok: false, error: 'not found', path: url.pathname }, 404)
  },
})

console.log(`sih26237 server listening on http://${server.hostname}:${server.port}`)

import { b64, unb64 } from './bytes.ts'
import { CnsaError, generateIdentity, kemDecapsulate, publicOf, sign, type Identity, type PublicIdentity } from './cnsa.ts'
import type { Store } from './store.ts'

/**
 * The card reader.
 *
 * Every officer's secret keys used to sit in the same object graph the HTTP layer
 * held, which meant the server could sign as anybody and the PIN was decoration.
 * Non-repudiation is the property the whole accusation rests on, so it cannot
 * rest on the request handler choosing to behave.
 *
 * Here the keys live behind this module and never leave it. A caller gets a
 * `CardSession` that can sign and decapsulate, and it only exists for the
 * duration of one unlocked operation. Nothing outside can reach the key material
 * to sign with it directly.
 *
 * This is a software stand-in for a hardware token, and the shape is deliberate:
 * `unlock` is the PKCS#11 C_Login boundary and `CardSession` is the set of
 * operations a real token would perform on-card. Swapping in an actual reader
 * replaces this file and nothing above it.
 */
export type CardSession = {
  fp: string
  name: string
  role: string
  kemPublicKey: Uint8Array
  dsaPublicKey: Uint8Array
  sign(message: Uint8Array, context?: Uint8Array): Uint8Array
  decapsulate(cipherText: Uint8Array): Uint8Array
}

export type CardStatus = {
  name: string
  fp: string
  role: string
  /** A card locks itself rather than allowing a PIN to be guessed. */
  attemptsLeft: number
  locked: boolean
  revoked: boolean
}

const MAX_ATTEMPTS = 3

type Card = {
  identity: Identity
  pin: string
  attemptsLeft: number
  revoked: boolean
}

export class CardReader {
  private readonly cards = new Map<string, Card>()
  private readonly byName = new Map<string, string>()

  constructor(
    private readonly store: Store | null = null,
    private readonly session = 'default',
  ) {}

  /**
   * Issue a card, or bring back the one already issued to this officer.
   *
   * Reissuing on restart would leave the log full of enrolments for keys that no
   * longer exist, so every signature ever made would stop verifying. A card
   * outlives the process, which is also true of the real thing.
   */
  issue(name: string, role: string, pin: string): PublicIdentity {
    const stored = this.store?.getSecret(this.session, 'card', name)
    if (stored) {
      const identity = reviveIdentity(JSON.parse(stored))
      this.cards.set(identity.fp, { identity, pin, attemptsLeft: MAX_ATTEMPTS, revoked: false })
      this.byName.set(name, identity.fp)
      return publicOf(identity)
    }
    const identity = generateIdentity(name, role)
    this.cards.set(identity.fp, { identity, pin, attemptsLeft: MAX_ATTEMPTS, revoked: false })
    this.byName.set(name, identity.fp)
    this.store?.putSecret(this.session, 'card', name, JSON.stringify(serialiseIdentity(identity)))
    return publicOf(identity)
  }

  fingerprintOf(name: string): string {
    const fp = this.byName.get(name)
    if (!fp) throw new CnsaError('no_such_card', `no card issued to ${name}`)
    return fp
  }

  publicIdentity(name: string): PublicIdentity {
    const card = this.cards.get(this.fingerprintOf(name))!
    return publicOf(card.identity)
  }

  status(name: string): CardStatus {
    const card = this.cards.get(this.fingerprintOf(name))!
    return {
      name: card.identity.name,
      fp: card.identity.fp,
      role: card.identity.role,
      attemptsLeft: card.attemptsLeft,
      locked: card.attemptsLeft <= 0,
      revoked: card.revoked,
    }
  }

  /** Marks the card unusable. The ledger records the revocation separately. */
  revoke(name: string): void {
    const card = this.cards.get(this.fingerprintOf(name))!
    card.revoked = true
  }

  reinstate(name: string): void {
    const card = this.cards.get(this.fingerprintOf(name))!
    card.revoked = false
    card.attemptsLeft = MAX_ATTEMPTS
  }

  /**
   * Unlock a card and run one operation with it.
   *
   * The session is torn down as soon as `use` returns, so a caller cannot keep a
   * handle and sign with it later. A wrong PIN costs an attempt, and a card that
   * runs out locks rather than allowing the search to continue.
   */
  unlock<T>(name: string, pin: string, use: (session: CardSession) => T): T {
    const fp = this.fingerprintOf(name)
    const card = this.cards.get(fp)!

    if (card.revoked) throw new CnsaError('card_revoked', `${name}'s card has been revoked`)
    if (card.attemptsLeft <= 0) {
      throw new CnsaError('card_locked', `${name}'s card is locked after ${MAX_ATTEMPTS} wrong PINs`)
    }
    if (pin !== card.pin) {
      card.attemptsLeft -= 1
      throw new CnsaError(
        'bad_pin',
        card.attemptsLeft > 0
          ? `wrong PIN, ${card.attemptsLeft} attempt${card.attemptsLeft === 1 ? '' : 's'} left before the card locks`
          : `wrong PIN, the card is now locked`,
      )
    }
    card.attemptsLeft = MAX_ATTEMPTS

    let live = true
    const session: CardSession = {
      fp,
      name: card.identity.name,
      role: card.identity.role,
      kemPublicKey: card.identity.kem.publicKey,
      dsaPublicKey: card.identity.dsa.publicKey,
      sign(message, context) {
        if (!live) throw new CnsaError('card_session_closed', 'the card session has already ended')
        return sign(card.identity.dsa.secretKey, message, context)
      },
      decapsulate(cipherText) {
        if (!live) throw new CnsaError('card_session_closed', 'the card session has already ended')
        return kemDecapsulate(cipherText, card.identity.kem.secretKey)
      },
    }

    try {
      return use(session)
    } finally {
      live = false
    }
  }

  names(): string[] {
    return [...this.byName.keys()]
  }
}

function serialiseIdentity(identity: Identity) {
  return {
    name: identity.name,
    role: identity.role,
    fp: identity.fp,
    kem: { publicKey: b64(identity.kem.publicKey), secretKey: b64(identity.kem.secretKey) },
    dsa: { publicKey: b64(identity.dsa.publicKey), secretKey: b64(identity.dsa.secretKey) },
  }
}

function reviveIdentity(raw: ReturnType<typeof serialiseIdentity>): Identity {
  return {
    name: raw.name,
    role: raw.role,
    fp: raw.fp,
    kem: { publicKey: unb64(raw.kem.publicKey), secretKey: unb64(raw.kem.secretKey) },
    dsa: { publicKey: unb64(raw.dsa.publicKey), secretKey: unb64(raw.dsa.secretKey) },
  }
}

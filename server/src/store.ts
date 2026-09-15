import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { CONFIG } from './config.ts'

/**
 * Durable storage for the ledger.
 *
 * "Append-only" is a property of storage, and until this existed there was no
 * storage: the whole log lived in one process and a restart erased it. That made
 * the central claim of the system untrue in the most boring way possible.
 *
 * Two things are kept here and they are kept for different reasons. Blocks are
 * the log itself. The signing watermark is the promise each attester has made
 * about what it has already put its name to, and it has to survive a crash
 * *separately* from the blocks, because the dangerous moment is exactly the one
 * where a node signed something and died before recording the block.
 */
export type StoredBlock = { ledgerId: string; height: number; nodeId: string; json: string }

export class Store {
  private readonly db: Database

  constructor(path = CONFIG.dbPath) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    // WAL keeps readers from blocking the append, and a full sync means a
    // committed write is on the disk, not in the operating system's cache.
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run('PRAGMA synchronous = FULL')
    this.db.run(`
      CREATE TABLE IF NOT EXISTS blocks (
        session   TEXT NOT NULL,
        ledger_id TEXT NOT NULL,
        node_id   TEXT NOT NULL,
        height    INTEGER NOT NULL,
        json      TEXT NOT NULL,
        PRIMARY KEY (session, ledger_id, node_id, height)
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS signed_at_height (
        session    TEXT NOT NULL,
        ledger_id  TEXT NOT NULL,
        node_id    TEXT NOT NULL,
        height     INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        counter    INTEGER NOT NULL,
        PRIMARY KEY (session, ledger_id, node_id, height)
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS anchors (
        session   TEXT NOT NULL,
        ledger_id TEXT NOT NULL,
        seq       INTEGER NOT NULL,
        json      TEXT NOT NULL,
        PRIMARY KEY (session, ledger_id, seq)
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS documents (
        session TEXT NOT NULL,
        doc_id  TEXT NOT NULL,
        json    TEXT NOT NULL,
        PRIMARY KEY (session, doc_id)
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS copies (
        session TEXT NOT NULL,
        copy_id TEXT NOT NULL,
        json    TEXT NOT NULL,
        PRIMARY KEY (session, copy_id)
      )
    `)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS keystore (
        session TEXT NOT NULL,
        kind    TEXT NOT NULL,
        id      TEXT NOT NULL,
        json    TEXT NOT NULL,
        PRIMARY KEY (session, kind, id)
      )
    `)
  }

  /**
   * Record that a node is about to sign at this height. Called BEFORE the
   * signature is produced: a node that signed and then crashed must never come
   * back able to sign a different block at the same height.
   */
  reserveHeight(session: string, ledgerId: string, nodeId: string, height: number, blockHash: string, counter: number): void {
    this.db
      .query(
        `INSERT INTO signed_at_height (session, ledger_id, node_id, height, block_hash, counter)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session, ledger_id, node_id, height) DO NOTHING`,
      )
      .run(session, ledgerId, nodeId, height, blockHash, counter)
  }

  signedAt(session: string, ledgerId: string, nodeId: string, height: number): string | null {
    const row = this.db
      .query<{ block_hash: string }, [string, string, string, number]>(
        'SELECT block_hash FROM signed_at_height WHERE session = ? AND ledger_id = ? AND node_id = ? AND height = ?',
      )
      .get(session, ledgerId, nodeId, height)
    return row?.block_hash ?? null
  }

  /** The highest counter this node has issued, so it never goes backwards. */
  counterFor(session: string, ledgerId: string, nodeId: string): number {
    const row = this.db
      .query<{ n: number | null }, [string, string, string]>(
        'SELECT MAX(counter) AS n FROM signed_at_height WHERE session = ? AND ledger_id = ? AND node_id = ?',
      )
      .get(session, ledgerId, nodeId)
    return row?.n ?? 0
  }

  putBlock(session: string, ledgerId: string, nodeId: string, height: number, json: string): void {
    this.db
      .query(
        `INSERT INTO blocks (session, ledger_id, node_id, height, json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session, ledger_id, node_id, height) DO UPDATE SET json = excluded.json`,
      )
      .run(session, ledgerId, nodeId, height, json)
  }

  blocksFor(session: string, ledgerId: string, nodeId: string): string[] {
    return this.db
      .query<{ json: string }, [string, string, string]>(
        'SELECT json FROM blocks WHERE session = ? AND ledger_id = ? AND node_id = ? ORDER BY height ASC',
      )
      .all(session, ledgerId, nodeId)
      .map((r) => r.json)
  }

  putAnchor(session: string, ledgerId: string, seq: number, json: string): void {
    this.db
      .query('INSERT INTO anchors (session, ledger_id, seq, json) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING')
      .run(session, ledgerId, seq, json)
  }

  anchors(session: string, ledgerId: string): string[] {
    return this.db
      .query<{ json: string }, [string, string]>(
        'SELECT json FROM anchors WHERE session = ? AND ledger_id = ? ORDER BY seq ASC',
      )
      .all(session, ledgerId)
      .map((r) => r.json)
  }

  putSecret(session: string, kind: string, id: string, json: string): void {
    this.db
      .query(
        `INSERT INTO keystore (session, kind, id, json) VALUES (?, ?, ?, ?)
         ON CONFLICT(session, kind, id) DO UPDATE SET json = excluded.json`,
      )
      .run(session, kind, id, json)
  }

  getSecret(session: string, kind: string, id: string): string | null {
    const row = this.db
      .query<{ json: string }, [string, string, string]>(
        'SELECT json FROM keystore WHERE session = ? AND kind = ? AND id = ?',
      )
      .get(session, kind, id)
    return row?.json ?? null
  }

  putDocument(session: string, docId: string, json: string): void {
    this.db
      .query(
        `INSERT INTO documents (session, doc_id, json) VALUES (?, ?, ?)
         ON CONFLICT(session, doc_id) DO UPDATE SET json = excluded.json`,
      )
      .run(session, docId, json)
  }

  documents(session: string): string[] {
    return this.db
      .query<{ json: string }, [string]>('SELECT json FROM documents WHERE session = ?')
      .all(session)
      .map((r) => r.json)
  }

  putCopy(session: string, copyId: string, json: string): void {
    this.db
      .query(
        `INSERT INTO copies (session, copy_id, json) VALUES (?, ?, ?)
         ON CONFLICT(session, copy_id) DO UPDATE SET json = excluded.json`,
      )
      .run(session, copyId, json)
  }

  copies(session: string): string[] {
    return this.db
      .query<{ json: string }, [string]>('SELECT json FROM copies WHERE session = ?')
      .all(session)
      .map((r) => r.json)
  }

  sessions(): string[] {
    return this.db
      .query<{ session: string }, []>('SELECT DISTINCT session FROM blocks')
      .all()
      .map((r) => r.session)
  }

  forget(session: string): void {
    for (const table of ['blocks', 'signed_at_height', 'anchors', 'keystore', 'documents', 'copies']) {
      this.db.query(`DELETE FROM ${table} WHERE session = ?`).run(session)
    }
  }

  close(): void {
    this.db.close()
  }
}

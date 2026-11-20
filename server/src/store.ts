import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as Y from 'yjs';
import { TEXT_KEY, type DocSummary, type Version } from '../../shared/types.js';

/** Merge the append-only update log into one row once it grows past this. */
export const COMPACT_AFTER = 200;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS documents (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Yjs updates are stored as an append-only log: cheap writes, and replaying them in any order
-- converges to the same document (that's the CRDT guarantee).
CREATE TABLE IF NOT EXISTS updates (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  data   BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS updates_doc ON updates (doc_id, seq);
CREATE TABLE IF NOT EXISTS versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  snapshot   BLOB NOT NULL,
  preview    TEXT NOT NULL,
  characters INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS versions_doc ON versions (doc_id, created_at DESC);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  createDoc(title: string, now = Date.now()): DocSummary {
    // Unguessable ids: knowing a link is what grants access, like an unlisted doc.
    const id = randomBytes(9).toString('base64url');
    this.db
      .prepare('INSERT INTO documents (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, title, now, now);
    return { id, title, createdAt: now, updatedAt: now };
  }

  getDoc(id: string): DocSummary | null {
    const row = this.db
      .prepare(
        'SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM documents WHERE id = ?',
      )
      .get(id) as DocSummary | undefined;
    return row ? { ...row } : null;
  }

  listDocs(): DocSummary[] {
    return (
      this.db
        .prepare(
          'SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM documents ORDER BY updated_at DESC LIMIT 100',
        )
        .all() as unknown as DocSummary[]
    ).map((d) => ({ ...d }));
  }

  renameDoc(id: string, title: string): boolean {
    return (
      Number(
        this.db.prepare('UPDATE documents SET title = ? WHERE id = ?').run(title, id).changes,
      ) === 1
    );
  }

  deleteDoc(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM documents WHERE id = ?').run(id).changes) === 1;
  }

  /** Rebuilds the document state by applying every stored update. */
  loadState(id: string): Uint8Array | null {
    const rows = this.db
      .prepare('SELECT data FROM updates WHERE doc_id = ? ORDER BY seq')
      .all(id) as {
      data: Uint8Array;
    }[];
    return rows.length ? Y.mergeUpdates(rows.map((r) => r.data)) : null;
  }

  appendUpdate(id: string, update: Uint8Array, now = Date.now()): void {
    this.tx(() => {
      this.db.prepare('INSERT INTO updates (doc_id, data) VALUES (?, ?)').run(id, update);
      this.db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?').run(now, id);
    });
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM updates WHERE doc_id = ?').get(id) as {
      n: number;
    };
    if (n > COMPACT_AFTER) this.compact(id);
  }

  /** Replaces the update log with a single merged update (same document, far fewer rows). */
  compact(id: string): void {
    this.tx(() => {
      const rows = this.db
        .prepare('SELECT seq, data FROM updates WHERE doc_id = ? ORDER BY seq')
        .all(id) as {
        seq: number;
        data: Uint8Array;
      }[];
      if (rows.length < 2) return;
      const merged = Y.mergeUpdates(rows.map((r) => r.data));
      const lastSeq = rows.at(-1)!.seq;
      this.db.prepare('DELETE FROM updates WHERE doc_id = ? AND seq <= ?').run(id, lastSeq);
      this.db.prepare('INSERT INTO updates (doc_id, data) VALUES (?, ?)').run(id, merged);
    });
  }

  updateCount(id: string): number {
    return (
      this.db.prepare('SELECT COUNT(*) AS n FROM updates WHERE doc_id = ?').get(id) as { n: number }
    ).n;
  }

  saveVersion(id: string, name: string, doc: Y.Doc, now = Date.now()): Version {
    const text = doc.getText(TEXT_KEY).toString();
    const preview = text.slice(0, 140);
    const { lastInsertRowid } = this.db
      .prepare(
        'INSERT INTO versions (doc_id, name, created_at, snapshot, preview, characters) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, name, now, Y.encodeStateAsUpdate(doc), preview, text.length);
    return { id: Number(lastInsertRowid), name, createdAt: now, preview, characters: text.length };
  }

  listVersions(id: string): Version[] {
    return (
      this.db
        .prepare(
          'SELECT id, name, created_at AS createdAt, preview, characters FROM versions WHERE doc_id = ? ORDER BY created_at DESC, id DESC',
        )
        .all(id) as unknown as Version[]
    ).map((v) => ({ ...v }));
  }

  versionText(docId: string, versionId: number): string | null {
    const row = this.db
      .prepare('SELECT snapshot FROM versions WHERE doc_id = ? AND id = ?')
      .get(docId, versionId) as { snapshot: Uint8Array } | undefined;
    if (!row) return null;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, row.snapshot);
    return doc.getText(TEXT_KEY).toString();
  }
}

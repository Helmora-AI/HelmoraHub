import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  CHAT_ACTIVE_SETTING_KEY,
  CHAT_MAX_CONTENT_CHARS,
  CHAT_MAX_MESSAGES_PER_SESSION,
  CHAT_MAX_SESSIONS,
  type AppendChatMessageInput,
  type CreateChatSessionInput,
  type ImportChatStoreInput,
  type ImportChatStoreResult,
  type ListChatMessagesOpts,
  type ListChatMessagesResult,
  type StoredChatMessage,
  type StoredChatMessageStatus,
  type StoredChatModelSelection,
  type StoredChatSession,
  type StoredChatSessionDetail,
  type UpdateChatSessionInput,
} from './chat-types.js';

type SessionRow = {
  id: string;
  title: string;
  model_selection: string;
  thinking: number;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  session_id: string;
  role: string;
  content: string;
  status: string | null;
  error_code: string | null;
  created_at: string;
  seq: number;
};

function defaultModelSelection(): StoredChatModelSelection {
  return { kind: 'auto' };
}

function parseModelSelection(raw: string): StoredChatModelSelection {
  try {
    const parsed = JSON.parse(raw) as StoredChatModelSelection;
    if (parsed?.kind === 'auto') return { kind: 'auto' };
    if (parsed?.kind === 'mode' && typeof parsed.mode === 'string' && parsed.mode) {
      return { kind: 'mode', mode: parsed.mode };
    }
    if (
      parsed?.kind === 'catalog' &&
      typeof parsed.catalogId === 'string' &&
      parsed.catalogId
    ) {
      return { kind: 'catalog', catalogId: parsed.catalogId };
    }
  } catch {
    // fall through
  }
  return defaultModelSelection();
}

function clampContent(content: string): string {
  if (content.length <= CHAT_MAX_CONTENT_CHARS) return content;
  return content.slice(0, CHAT_MAX_CONTENT_CHARS);
}

function mapMessage(row: MessageRow): StoredChatMessage {
  const status = row.status as StoredChatMessageStatus | null;
  return {
    id: row.id,
    role: row.role as StoredChatMessage['role'],
    content: row.content,
    status: status || undefined,
    errorCode: row.error_code || undefined,
    createdAt: row.created_at,
    seq: row.seq,
  };
}

function mapSession(row: SessionRow, messageCount: number): StoredChatSession {
  return {
    id: row.id,
    title: row.title,
    modelSelection: parseModelSelection(row.model_selection),
    thinking: Boolean(row.thinking),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount,
  };
}

export function ensureChatTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      model_selection TEXT NOT NULL,
      thinking INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
      content TEXT NOT NULL,
      status TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      seq INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS chat_sessions_updated_idx
      ON chat_sessions (updated_at DESC);

    CREATE INDEX IF NOT EXISTS chat_messages_session_seq_idx
      ON chat_messages (session_id, seq);
  `);
}

function messageCount(db: Database.Database, sessionId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = ?`)
    .get(sessionId) as { c: number };
  return Number(row?.c) || 0;
}

function getSessionRow(db: Database.Database, id: string): SessionRow | undefined {
  return db.prepare(`SELECT * FROM chat_sessions WHERE id = ?`).get(id) as
    | SessionRow
    | undefined;
}

function touchSession(db: Database.Database, id: string, updatedAt: string): void {
  db.prepare(`UPDATE chat_sessions SET updated_at = ? WHERE id = ?`).run(updatedAt, id);
}

function pruneOldestSessions(db: Database.Database, keepActiveId: string | null): number {
  const rows = db
    .prepare(`SELECT id FROM chat_sessions ORDER BY updated_at DESC`)
    .all() as Array<{ id: string }>;
  if (rows.length <= CHAT_MAX_SESSIONS) return 0;

  const keep = new Set<string>();
  if (keepActiveId) keep.add(keepActiveId);
  for (const row of rows) {
    if (keep.size >= CHAT_MAX_SESSIONS) break;
    keep.add(row.id);
  }

  let pruned = 0;
  const del = db.prepare(`DELETE FROM chat_sessions WHERE id = ?`);
  for (const row of rows) {
    if (keep.has(row.id)) continue;
    del.run(row.id);
    pruned += 1;
  }
  return pruned;
}

function maxSeq(db: Database.Database, sessionId: string): number {
  const row = db
    .prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM chat_messages WHERE session_id = ?`)
    .get(sessionId) as { m: number };
  return Number(row?.m) || 0;
}

function insertMessages(
  db: Database.Database,
  sessionId: string,
  messages: AppendChatMessageInput[],
  startSeq: number
): StoredChatMessage[] {
  const insert = db.prepare(
    `INSERT INTO chat_messages
      (id, session_id, role, content, status, error_code, created_at, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const out: StoredChatMessage[] = [];
  let seq = startSeq;
  for (const msg of messages) {
    seq += 1;
    const id = msg.id?.trim() || randomUUID();
    const createdAt = msg.createdAt || new Date().toISOString();
    const content = clampContent(msg.content ?? '');
    insert.run(
      id,
      sessionId,
      msg.role,
      content,
      msg.status ?? null,
      msg.errorCode ?? null,
      createdAt,
      seq
    );
    out.push({
      id,
      role: msg.role,
      content,
      status: msg.status,
      errorCode: msg.errorCode,
      createdAt,
      seq,
    });
  }
  return out;
}

function trimMessagesToCap(db: Database.Database, sessionId: string): void {
  const count = messageCount(db, sessionId);
  if (count <= CHAT_MAX_MESSAGES_PER_SESSION) return;
  const drop = count - CHAT_MAX_MESSAGES_PER_SESSION;
  db.prepare(
    `DELETE FROM chat_messages WHERE id IN (
       SELECT id FROM chat_messages WHERE session_id = ?
       ORDER BY seq ASC LIMIT ?
     )`
  ).run(sessionId, drop);
}

export function sqliteListChatSessions(db: Database.Database): StoredChatSession[] {
  const rows = db
    .prepare(`SELECT * FROM chat_sessions ORDER BY updated_at DESC`)
    .all() as SessionRow[];
  const countStmt = db.prepare(
    `SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = ?`
  );
  return rows.map((row) => {
    const c = countStmt.get(row.id) as { c: number };
    return mapSession(row, Number(c?.c) || 0);
  });
}

export function sqliteGetChatSession(
  db: Database.Database,
  id: string
): StoredChatSessionDetail | null {
  const row = getSessionRow(db, id);
  if (!row) return null;
  const msgs = db
    .prepare(
      `SELECT * FROM chat_messages WHERE session_id = ?
       ORDER BY seq ASC LIMIT ?`
    )
    .all(id, CHAT_MAX_MESSAGES_PER_SESSION) as MessageRow[];
  return {
    ...mapSession(row, msgs.length),
    messages: msgs.map(mapMessage),
  };
}

export function sqliteCreateChatSession(
  db: Database.Database,
  input: CreateChatSessionInput = {}
): StoredChatSessionDetail {
  const now = new Date().toISOString();
  const id = input.id?.trim() || randomUUID();
  const title = (input.title?.trim() || 'New chat').slice(0, 120);
  const modelSelection = input.modelSelection ?? defaultModelSelection();
  const thinking = Boolean(input.thinking);

  const existing = getSessionRow(db, id);
  if (existing) {
    return sqliteGetChatSession(db, id)!;
  }

  db.prepare(
    `INSERT INTO chat_sessions (id, title, model_selection, thinking, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, title, JSON.stringify(modelSelection), thinking ? 1 : 0, now, now);

  const active = sqliteGetActiveChatSessionId(db);
  pruneOldestSessions(db, active);

  return {
    id,
    title,
    modelSelection,
    thinking,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    messages: [],
  };
}

export function sqliteUpdateChatSession(
  db: Database.Database,
  id: string,
  patch: UpdateChatSessionInput
): StoredChatSession | null {
  const row = getSessionRow(db, id);
  if (!row) return null;

  const title =
    patch.title !== undefined ? patch.title.trim().slice(0, 120) || row.title : row.title;
  const modelSelection =
    patch.modelSelection !== undefined
      ? patch.modelSelection
      : parseModelSelection(row.model_selection);
  const thinking =
    patch.thinking !== undefined ? Boolean(patch.thinking) : Boolean(row.thinking);
  const updatedAt = new Date().toISOString();

  db.prepare(
    `UPDATE chat_sessions
     SET title = ?, model_selection = ?, thinking = ?, updated_at = ?
     WHERE id = ?`
  ).run(title, JSON.stringify(modelSelection), thinking ? 1 : 0, updatedAt, id);

  return mapSession(
    {
      ...row,
      title,
      model_selection: JSON.stringify(modelSelection),
      thinking: thinking ? 1 : 0,
      updated_at: updatedAt,
    },
    messageCount(db, id)
  );
}

export function sqliteDeleteChatSession(db: Database.Database, id: string): boolean {
  const result = db.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run(id);
  if (result.changes > 0) {
    const active = sqliteGetActiveChatSessionId(db);
    if (active === id) {
      sqliteSetActiveChatSessionId(db, null);
    }
  }
  return result.changes > 0;
}

export function sqliteListChatMessages(
  db: Database.Database,
  sessionId: string,
  opts?: ListChatMessagesOpts
): ListChatMessagesResult {
  if (!getSessionRow(db, sessionId)) {
    return { messages: [], hasMore: false };
  }
  const limit = Math.max(
    1,
    Math.min(opts?.limit ?? 100, CHAT_MAX_MESSAGES_PER_SESSION)
  );
  const beforeSeq = opts?.beforeSeq;

  const rows = (
    beforeSeq != null
      ? db
          .prepare(
            `SELECT * FROM chat_messages WHERE session_id = ? AND seq < ?
             ORDER BY seq DESC LIMIT ?`
          )
          .all(sessionId, beforeSeq, limit + 1)
      : db
          .prepare(
            `SELECT * FROM chat_messages WHERE session_id = ?
             ORDER BY seq DESC LIMIT ?`
          )
          .all(sessionId, limit + 1)
  ) as MessageRow[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  page.reverse();
  return { messages: page.map(mapMessage), hasMore };
}

export function sqliteAppendChatMessages(
  db: Database.Database,
  sessionId: string,
  messages: AppendChatMessageInput[]
): StoredChatMessage[] {
  if (!getSessionRow(db, sessionId)) {
    throw new Error(`Chat session not found: ${sessionId}`);
  }
  if (messages.length === 0) return [];

  const now = new Date().toISOString();
  const out = db.transaction(() => {
    const start = maxSeq(db, sessionId);
    const inserted = insertMessages(db, sessionId, messages, start);
    trimMessagesToCap(db, sessionId);
    touchSession(db, sessionId, now);
    return inserted;
  })();
  return out;
}

export function sqliteReplaceChatMessages(
  db: Database.Database,
  sessionId: string,
  messages: AppendChatMessageInput[]
): StoredChatMessage[] {
  if (!getSessionRow(db, sessionId)) {
    throw new Error(`Chat session not found: ${sessionId}`);
  }
  const now = new Date().toISOString();
  const capped = messages.slice(-CHAT_MAX_MESSAGES_PER_SESSION);
  return db.transaction(() => {
    db.prepare(`DELETE FROM chat_messages WHERE session_id = ?`).run(sessionId);
    const inserted = insertMessages(db, sessionId, capped, 0);
    touchSession(db, sessionId, now);
    return inserted;
  })();
}

export function sqliteGetActiveChatSessionId(db: Database.Database): string | null {
  const row = db
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(CHAT_ACTIVE_SETTING_KEY) as { value: string } | undefined;
  const id = row?.value?.trim();
  if (!id) return null;
  if (!getSessionRow(db, id)) return null;
  return id;
}

export function sqliteSetActiveChatSessionId(
  db: Database.Database,
  id: string | null
): void {
  if (id) {
    if (!getSessionRow(db, id)) {
      throw new Error(`Chat session not found: ${id}`);
    }
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(CHAT_ACTIVE_SETTING_KEY, id);
    return;
  }
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(CHAT_ACTIVE_SETTING_KEY);
}

export function sqliteImportChatStore(
  db: Database.Database,
  input: ImportChatStoreInput
): ImportChatStoreResult {
  const threads = (input.threads ?? []).slice(0, CHAT_MAX_SESSIONS);
  let importedMessages = 0;

  const result = db.transaction(() => {
    for (const thread of threads) {
      const id = thread.id?.trim() || randomUUID();
      const existing = getSessionRow(db, id);
      if (existing) {
        db.prepare(`DELETE FROM chat_sessions WHERE id = ?`).run(id);
      }
      const modelSelection = thread.modelSelection ?? defaultModelSelection();
      db.prepare(
        `INSERT INTO chat_sessions (id, title, model_selection, thinking, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        (thread.title || 'New chat').slice(0, 120),
        JSON.stringify(modelSelection),
        thread.thinking ? 1 : 0,
        thread.createdAt || new Date().toISOString(),
        thread.updatedAt || new Date().toISOString()
      );

      const msgs = (thread.messages ?? [])
        .slice(-CHAT_MAX_MESSAGES_PER_SESSION)
        .map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          status: m.status,
          errorCode: m.errorCode,
          createdAt: m.createdAt,
        }));
      const inserted = insertMessages(db, id, msgs, 0);
      importedMessages += inserted.length;
    }

    const pruned = pruneOldestSessions(db, input.activeThreadId);
    if (input.activeThreadId && getSessionRow(db, input.activeThreadId)) {
      sqliteSetActiveChatSessionId(db, input.activeThreadId);
    } else {
      const first = db
        .prepare(`SELECT id FROM chat_sessions ORDER BY updated_at DESC LIMIT 1`)
        .get() as { id: string } | undefined;
      sqliteSetActiveChatSessionId(db, first?.id ?? null);
    }

    return {
      importedSessions: threads.length,
      importedMessages,
      prunedSessions: pruned,
      activeThreadId: sqliteGetActiveChatSessionId(db),
    };
  })();

  return result;
}

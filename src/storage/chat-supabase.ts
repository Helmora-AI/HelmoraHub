import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatSupabaseControlError } from '../lib/supabase-schema.js';
import {
  CHAT_ACTIVE_SETTING_KEY,
  CHAT_MAX_CONTENT_CHARS,
  CHAT_MAX_MESSAGES_PER_SESSION,
  CHAT_MAX_SESSIONS,
  ChatSessionNotFoundError,
  normalizeChatToolActivities,
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

export const CHAT_TABLE = {
  sessions: 'helmora_chat_sessions',
  messages: 'helmora_chat_messages',
} as const;

type SessionRow = {
  id: string;
  title: string;
  model_selection: StoredChatModelSelection | string;
  thinking: boolean;
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
  tool_activities: unknown;
  created_at: string;
  seq: number;
};

function defaultModelSelection(): StoredChatModelSelection {
  return { kind: 'auto' };
}

function parseModelSelection(raw: unknown): StoredChatModelSelection {
  const parsed =
    typeof raw === 'string'
      ? (() => {
          try {
            return JSON.parse(raw) as StoredChatModelSelection;
          } catch {
            return null;
          }
        })()
      : (raw as StoredChatModelSelection | null);

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
    toolActivities: normalizeChatToolActivities(row.tool_activities),
    createdAt: row.created_at,
    seq: row.seq,
  };
}

function messageRpcPayload(messages: AppendChatMessageInput[]) {
  const now = new Date().toISOString();
  return messages.map((message) => ({
    id: message.id?.trim() || randomUUID(),
    role: message.role,
    content: clampContent(message.content ?? ''),
    status: message.status ?? null,
    errorCode: message.errorCode ?? null,
    toolActivities: normalizeChatToolActivities(message.toolActivities),
    createdAt: message.createdAt || now,
  }));
}

async function atomicMessageMutation(
  client: SupabaseClient,
  rpcName: 'append_chat_message_atomic' | 'replace_chat_messages_atomic',
  operation: string,
  sessionId: string,
  messages: AppendChatMessageInput[]
): Promise<StoredChatMessage[]> {
  const { data, error } = await client.rpc(rpcName, {
    p_session_id: sessionId,
    p_messages: messageRpcPayload(messages),
  });
  if (error) {
    if (error.message.toLowerCase().includes('chat_session_not_found')) {
      throw new ChatSessionNotFoundError(sessionId);
    }
    throw formatSupabaseControlError(operation, error.message);
  }
  if (!Array.isArray(data)) {
    throw formatSupabaseControlError(operation, 'invalid RPC response');
  }
  return (data as MessageRow[]).map(mapMessage);
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

async function countMessages(
  client: SupabaseClient,
  sessionId: string
): Promise<number> {
  const { count, error } = await client
    .from(CHAT_TABLE.messages)
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sessionId);
  if (error) throw formatSupabaseControlError('count chat messages', error.message);
  return count ?? 0;
}

async function getSessionRow(
  client: SupabaseClient,
  id: string
): Promise<SessionRow | null> {
  const { data, error } = await client
    .from(CHAT_TABLE.sessions)
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw formatSupabaseControlError('get chat session', error.message);
  return (data as SessionRow | null) ?? null;
}

async function pruneOldestSessions(
  client: SupabaseClient,
  keepActiveId: string | null
): Promise<number> {
  const { data, error } = await client
    .from(CHAT_TABLE.sessions)
    .select('id')
    .order('updated_at', { ascending: false });
  if (error) throw formatSupabaseControlError('list chat sessions for prune', error.message);
  const rows = (data ?? []) as Array<{ id: string }>;
  if (rows.length <= CHAT_MAX_SESSIONS) return 0;

  const keep = new Set<string>();
  if (keepActiveId) keep.add(keepActiveId);
  for (const row of rows) {
    if (keep.size >= CHAT_MAX_SESSIONS) break;
    keep.add(row.id);
  }

  const toDelete = rows.filter((r) => !keep.has(r.id)).map((r) => r.id);
  if (toDelete.length === 0) return 0;
  const { error: delErr } = await client
    .from(CHAT_TABLE.sessions)
    .delete()
    .in('id', toDelete);
  if (delErr) throw formatSupabaseControlError('prune chat sessions', delErr.message);
  return toDelete.length;
}

export async function supabaseListChatSessions(
  client: SupabaseClient
): Promise<StoredChatSession[]> {
  const { data, error } = await client
    .from(CHAT_TABLE.sessions)
    .select('*')
    .order('updated_at', { ascending: false });
  if (error) throw formatSupabaseControlError('list chat sessions', error.message);
  const rows = (data ?? []) as SessionRow[];
  const out: StoredChatSession[] = [];
  for (const row of rows) {
    out.push(mapSession(row, await countMessages(client, row.id)));
  }
  return out;
}

export async function supabaseGetChatSession(
  client: SupabaseClient,
  id: string
): Promise<StoredChatSessionDetail | null> {
  const row = await getSessionRow(client, id);
  if (!row) return null;
  const { data, error } = await client
    .from(CHAT_TABLE.messages)
    .select('*')
    .eq('session_id', id)
    .order('seq', { ascending: true })
    .limit(CHAT_MAX_MESSAGES_PER_SESSION);
  if (error) throw formatSupabaseControlError('get chat messages', error.message);
  const msgs = (data ?? []) as MessageRow[];
  return {
    ...mapSession(row, msgs.length),
    messages: msgs.map(mapMessage),
  };
}

export async function supabaseCreateChatSession(
  client: SupabaseClient,
  input: CreateChatSessionInput = {},
  getActiveId: () => Promise<string | null>
): Promise<StoredChatSessionDetail> {
  const now = new Date().toISOString();
  const id = input.id?.trim() || randomUUID();
  const existing = await getSessionRow(client, id);
  if (existing) {
    return (await supabaseGetChatSession(client, id))!;
  }

  const title = (input.title?.trim() || 'New chat').slice(0, 120);
  const modelSelection = input.modelSelection ?? defaultModelSelection();
  const thinking = Boolean(input.thinking);

  const { error } = await client.from(CHAT_TABLE.sessions).insert({
    id,
    title,
    model_selection: modelSelection,
    thinking,
    created_at: now,
    updated_at: now,
  });
  if (error) throw formatSupabaseControlError('create chat session', error.message);

  await pruneOldestSessions(client, await getActiveId());

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

export async function supabaseUpdateChatSession(
  client: SupabaseClient,
  id: string,
  patch: UpdateChatSessionInput
): Promise<StoredChatSession | null> {
  const row = await getSessionRow(client, id);
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

  const { error } = await client
    .from(CHAT_TABLE.sessions)
    .update({
      title,
      model_selection: modelSelection,
      thinking,
      updated_at: updatedAt,
    })
    .eq('id', id);
  if (error) throw formatSupabaseControlError('update chat session', error.message);

  return mapSession(
    {
      ...row,
      title,
      model_selection: modelSelection,
      thinking,
      updated_at: updatedAt,
    },
    await countMessages(client, id)
  );
}

export async function supabaseDeleteChatSession(
  client: SupabaseClient,
  id: string,
  clearActiveIfMatch: (id: string) => Promise<void>
): Promise<boolean> {
  const { data, error } = await client
    .from(CHAT_TABLE.sessions)
    .delete()
    .eq('id', id)
    .select('id');
  if (error) throw formatSupabaseControlError('delete chat session', error.message);
  const deleted = (data ?? []).length > 0;
  if (deleted) await clearActiveIfMatch(id);
  return deleted;
}

export async function supabaseListChatMessages(
  client: SupabaseClient,
  sessionId: string,
  opts?: ListChatMessagesOpts
): Promise<ListChatMessagesResult> {
  if (!(await getSessionRow(client, sessionId))) {
    return { messages: [], hasMore: false };
  }
  const limit = Math.max(
    1,
    Math.min(opts?.limit ?? 100, CHAT_MAX_MESSAGES_PER_SESSION)
  );
  let query = client
    .from(CHAT_TABLE.messages)
    .select('*')
    .eq('session_id', sessionId)
    .order('seq', { ascending: false })
    .limit(limit + 1);
  if (opts?.beforeSeq != null) {
    query = query.lt('seq', opts.beforeSeq);
  }
  const { data, error } = await query;
  if (error) throw formatSupabaseControlError('list chat messages', error.message);
  const rows = (data ?? []) as MessageRow[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  page.reverse();
  return { messages: page.map(mapMessage), hasMore };
}

export async function supabaseAppendChatMessages(
  client: SupabaseClient,
  sessionId: string,
  messages: AppendChatMessageInput[]
): Promise<StoredChatMessage[]> {
  return atomicMessageMutation(
    client,
    'append_chat_message_atomic',
    'append chat messages',
    sessionId,
    messages
  );
}

export async function supabaseReplaceChatMessages(
  client: SupabaseClient,
  sessionId: string,
  messages: AppendChatMessageInput[]
): Promise<StoredChatMessage[]> {
  const capped = messages.slice(-CHAT_MAX_MESSAGES_PER_SESSION);
  return atomicMessageMutation(
    client,
    'replace_chat_messages_atomic',
    'replace chat messages',
    sessionId,
    capped
  );
}

export { CHAT_ACTIVE_SETTING_KEY };

export async function supabaseImportChatStore(
  client: SupabaseClient,
  input: ImportChatStoreInput,
  setActive: (id: string | null) => Promise<void>,
  getActive: () => Promise<string | null>
): Promise<ImportChatStoreResult> {
  const threads = (input.threads ?? []).slice(0, CHAT_MAX_SESSIONS);
  let importedMessages = 0;

  for (const thread of threads) {
    const id = thread.id?.trim() || randomUUID();
    const modelSelection = thread.modelSelection ?? defaultModelSelection();
    const { error } = await client.from(CHAT_TABLE.sessions).upsert(
      {
        id,
        title: (thread.title || 'New chat').slice(0, 120),
        model_selection: modelSelection,
        thinking: Boolean(thread.thinking),
        created_at: thread.createdAt || new Date().toISOString(),
        updated_at: thread.updatedAt || new Date().toISOString(),
      },
      { onConflict: 'id' }
    );
    if (error) throw formatSupabaseControlError('import chat session', error.message);

    const msgs = (thread.messages ?? []).slice(-CHAT_MAX_MESSAGES_PER_SESSION);
    const inserted = await supabaseReplaceChatMessages(client, id, msgs);
    importedMessages += inserted.length;
  }

  const pruned = await pruneOldestSessions(client, input.activeThreadId);
  if (input.activeThreadId && (await getSessionRow(client, input.activeThreadId))) {
    await setActive(input.activeThreadId);
  } else {
    const { data } = await client
      .from(CHAT_TABLE.sessions)
      .select('id')
      .order('updated_at', { ascending: false })
      .limit(1);
    const first = (data?.[0] as { id: string } | undefined)?.id ?? null;
    await setActive(first);
  }

  return {
    importedSessions: threads.length,
    importedMessages,
    prunedSessions: pruned,
    activeThreadId: await getActive(),
  };
}

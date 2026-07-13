/** Playground chat persistence types (Hub SQL — SQLite and/or Supabase). */

export const CHAT_MAX_SESSIONS = 30;
export const CHAT_MAX_MESSAGES_PER_SESSION = 200;
/** Soft cap per message body (chars) to keep API/memory bounded. */
export const CHAT_MAX_CONTENT_CHARS = 200_000;
export const CHAT_ACTIVE_SETTING_KEY = 'playground_active_session_id';

export type StoredChatModelSelection =
  | { kind: 'auto' }
  | { kind: 'mode'; mode: string }
  | { kind: 'catalog'; catalogId: string };

export type StoredChatMessageStatus = 'streaming' | 'complete' | 'stopped' | 'error';

export type StoredChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  status?: StoredChatMessageStatus;
  errorCode?: string;
  createdAt: string;
  /** Monotonic order within a session (1-based). */
  seq: number;
};

export type StoredChatSession = {
  id: string;
  title: string;
  modelSelection: StoredChatModelSelection;
  thinking: boolean;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
};

export type StoredChatSessionDetail = StoredChatSession & {
  messages: StoredChatMessage[];
};

export type CreateChatSessionInput = {
  id?: string;
  title?: string;
  modelSelection?: StoredChatModelSelection;
  thinking?: boolean;
};

export type UpdateChatSessionInput = {
  title?: string;
  modelSelection?: StoredChatModelSelection;
  thinking?: boolean;
};

export type ListChatMessagesOpts = {
  /** Max messages to return (newest page). Default 100, max CHAT_MAX_MESSAGES_PER_SESSION. */
  limit?: number;
  /** Return messages with seq < beforeSeq (for older pages). */
  beforeSeq?: number;
};

export type ListChatMessagesResult = {
  messages: StoredChatMessage[];
  hasMore: boolean;
};

export type AppendChatMessageInput = {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  status?: StoredChatMessageStatus;
  errorCode?: string;
  createdAt?: string;
};

export type ImportChatThreadInput = {
  id: string;
  title: string;
  modelSelection: StoredChatModelSelection;
  thinking: boolean;
  messages: AppendChatMessageInput[];
  createdAt: string;
  updatedAt: string;
};

export type ImportChatStoreInput = {
  activeThreadId: string | null;
  threads: ImportChatThreadInput[];
};

export type ImportChatStoreResult = {
  importedSessions: number;
  importedMessages: number;
  prunedSessions: number;
  activeThreadId: string | null;
};

export interface ChatStoreMethods {
  listChatSessions(): Promise<StoredChatSession[]>;
  getChatSession(id: string): Promise<StoredChatSessionDetail | null>;
  createChatSession(input?: CreateChatSessionInput): Promise<StoredChatSessionDetail>;
  updateChatSession(
    id: string,
    patch: UpdateChatSessionInput
  ): Promise<StoredChatSession | null>;
  deleteChatSession(id: string): Promise<boolean>;
  listChatMessages(
    sessionId: string,
    opts?: ListChatMessagesOpts
  ): Promise<ListChatMessagesResult>;
  appendChatMessages(
    sessionId: string,
    messages: AppendChatMessageInput[]
  ): Promise<StoredChatMessage[]>;
  /** Replace all messages for a session (used by streaming finalize / import). */
  replaceChatMessages(
    sessionId: string,
    messages: AppendChatMessageInput[]
  ): Promise<StoredChatMessage[]>;
  getActiveChatSessionId(): Promise<string | null>;
  setActiveChatSessionId(id: string | null): Promise<void>;
  importChatStore(input: ImportChatStoreInput): Promise<ImportChatStoreResult>;
}

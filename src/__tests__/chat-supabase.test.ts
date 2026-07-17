import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  supabaseAppendChatMessages,
  supabaseImportChatStore,
  supabaseReplaceChatMessages,
} from '../storage/chat-supabase.js';
import { ChatSessionNotFoundError } from '../storage/chat-types.js';

function rpcClient(result: {
  data: unknown;
  error: { message: string } | null;
}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return result;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

const row = {
  id: 'message-1',
  session_id: 'session-1',
  role: 'user',
  content: 'hello',
  status: null,
  error_code: null,
  tool_activities: [{
    toolId: 'web_search',
    status: 'completed',
    sourceCount: 1,
    errorCode: null,
  }],
  created_at: '2026-07-16T00:00:00.000Z',
  seq: 1,
};

describe('Supabase atomic chat RPC adapter', () => {
  it('appends through the transaction-owning RPC without calculating max sequence', async () => {
    const { client, calls } = rpcClient({ data: [row], error: null });
    const messages = await supabaseAppendChatMessages(client, 'session-1', [{
      id: 'message-1',
      role: 'user',
      content: 'hello',
      toolActivities: row.tool_activities,
      createdAt: row.created_at,
    }]);
    expect(calls).toEqual([{
      name: 'append_chat_message_atomic',
      args: {
        p_session_id: 'session-1',
        p_messages: [{
          id: 'message-1',
          role: 'user',
          content: 'hello',
          status: null,
          errorCode: null,
          toolActivities: row.tool_activities,
          createdAt: row.created_at,
        }],
      },
    }]);
    expect(messages[0]).toMatchObject({
      id: 'message-1',
      seq: 1,
      toolActivities: row.tool_activities,
    });
  });

  it('replaces through one RPC and preserves an empty replacement', async () => {
    const { client, calls } = rpcClient({ data: [], error: null });
    await expect(supabaseReplaceChatMessages(client, 'session-1', []))
      .resolves.toEqual([]);
    expect(calls[0]).toEqual({
      name: 'replace_chat_messages_atomic',
      args: { p_session_id: 'session-1', p_messages: [] },
    });
  });

  it('normalizes the RPC missing-session sentinel', async () => {
    const { client } = rpcClient({
      data: null,
      error: { message: 'P0002: chat_session_not_found' },
    });
    await expect(supabaseAppendChatMessages(client, 'missing', [{
      role: 'user',
      content: 'hello',
    }])).rejects.toBeInstanceOf(ChatSessionNotFoundError);
  });

  it('imports with session upsert followed by one atomic replacement, including empty history', async () => {
    const calls: string[] = [];
    const client = {
      from: () => ({
        upsert: async () => {
          calls.push('session-upsert');
          return { error: null };
        },
        select: () => ({
          order: () => ({
            range: async () => ({ data: [], error: null }),
            limit: async () => ({ data: [], error: null }),
          }),
        }),
      }),
      rpc: async (name: string) => {
        calls.push(name);
        return { data: [], error: null };
      },
    } as unknown as SupabaseClient;

    const active: Array<string | null> = [];
    const result = await supabaseImportChatStore(
      client,
      {
        activeThreadId: null,
        threads: [{
          id: 'session-1',
          title: 'Imported',
          modelSelection: { kind: 'auto' },
          thinking: false,
          messages: [],
          createdAt: '2026-07-16T00:00:00.000Z',
          updatedAt: '2026-07-16T00:00:00.000Z',
        }],
      },
      async (id) => { active.push(id); },
      async () => active.at(-1) ?? null
    );

    expect(calls.slice(0, 2)).toEqual([
      'session-upsert',
      'replace_chat_messages_atomic',
    ]);
    expect(result).toMatchObject({ importedSessions: 1, importedMessages: 0 });
  });
});

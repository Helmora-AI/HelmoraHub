import type { Router } from 'express';
import { z } from 'zod';
import { getConfigStore } from '../storage/index.js';
import {
  CHAT_MAX_MESSAGES_PER_SESSION,
  CHAT_MAX_SESSIONS,
} from '../storage/chat-types.js';

const modelSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('auto') }),
  z.object({ kind: z.literal('mode'), mode: z.string().min(1).max(64) }),
  z.object({
    kind: z.literal('catalog'),
    catalogId: z.string().min(1).max(200),
  }),
]);

const messageSchema = z.object({
  id: z.string().min(1).max(80).optional(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().max(200_000),
  status: z.enum(['streaming', 'complete', 'stopped', 'error']).optional(),
  errorCode: z.string().max(120).optional(),
  createdAt: z.string().max(64).optional(),
});

const createSessionSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().max(120).optional(),
  modelSelection: modelSelectionSchema.optional(),
  thinking: z.boolean().optional(),
});

const patchSessionSchema = z
  .object({
    title: z.string().max(120).optional(),
    modelSelection: modelSelectionSchema.optional(),
    thinking: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Empty patch' });

const appendMessagesSchema = z.object({
  messages: z.array(messageSchema).min(1).max(CHAT_MAX_MESSAGES_PER_SESSION),
});

const replaceMessagesSchema = z.object({
  messages: z.array(messageSchema).max(CHAT_MAX_MESSAGES_PER_SESSION),
});

const importSchema = z.object({
  activeThreadId: z.string().nullable(),
  threads: z
    .array(
      z.object({
        id: z.string().min(1).max(80),
        title: z.string().max(120),
        modelSelection: modelSelectionSchema,
        thinking: z.boolean(),
        messages: z.array(messageSchema).max(CHAT_MAX_MESSAGES_PER_SESSION),
        createdAt: z.string().max(64),
        updatedAt: z.string().max(64),
      })
    )
    .max(CHAT_MAX_SESSIONS),
});

const activeSchema = z.object({
  sessionId: z.string().min(1).max(80).nullable(),
});

function notFound(res: import('express').Response, message: string) {
  return res.status(404).json({
    error: { message, type: 'not_found' },
  });
}

function badRequest(res: import('express').Response, message: string) {
  return res.status(400).json({
    error: { message, type: 'invalid_request' },
  });
}

/** Mount Playground chat history CRUD on the admin-session chat router. */
export function mountChatHistoryRoutes(router: Router): void {
  router.get('/sessions', async (_req, res, next) => {
    try {
      const sessions = await getConfigStore().listChatSessions();
      const activeSessionId = await getConfigStore().getActiveChatSessionId();
      res.json({ sessions, activeSessionId, maxSessions: CHAT_MAX_SESSIONS });
    } catch (err) {
      next(err);
    }
  });

  router.post('/sessions', async (req, res, next) => {
    try {
      const parsed = createSessionSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');
      }
      const session = await getConfigStore().createChatSession(parsed.data);
      await getConfigStore().setActiveChatSessionId(session.id);
      res.status(201).json({ session, activeSessionId: session.id });
    } catch (err) {
      next(err);
    }
  });

  router.get('/sessions/:id', async (req, res, next) => {
    try {
      const session = await getConfigStore().getChatSession(req.params.id);
      if (!session) return notFound(res, 'Session not found');
      res.json({ session });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/sessions/:id', async (req, res, next) => {
    try {
      const parsed = patchSessionSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');
      }
      const session = await getConfigStore().updateChatSession(
        req.params.id,
        parsed.data
      );
      if (!session) return notFound(res, 'Session not found');
      res.json({ session });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/sessions/:id', async (req, res, next) => {
    try {
      const ok = await getConfigStore().deleteChatSession(req.params.id);
      if (!ok) return notFound(res, 'Session not found');
      let activeSessionId = await getConfigStore().getActiveChatSessionId();
      if (!activeSessionId) {
        const sessions = await getConfigStore().listChatSessions();
        if (sessions[0]) {
          await getConfigStore().setActiveChatSessionId(sessions[0].id);
          activeSessionId = sessions[0].id;
        } else {
          const created = await getConfigStore().createChatSession();
          await getConfigStore().setActiveChatSessionId(created.id);
          activeSessionId = created.id;
        }
      }
      res.json({ ok: true, activeSessionId });
    } catch (err) {
      next(err);
    }
  });

  router.get('/sessions/:id/messages', async (req, res, next) => {
    try {
      const session = await getConfigStore().getChatSession(req.params.id);
      if (!session) return notFound(res, 'Session not found');
      const limitRaw = Number(req.query.limit);
      const beforeSeqRaw = Number(req.query.beforeSeq);
      const result = await getConfigStore().listChatMessages(req.params.id, {
        limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
        beforeSeq: Number.isFinite(beforeSeqRaw) ? beforeSeqRaw : undefined,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.post('/sessions/:id/messages', async (req, res, next) => {
    try {
      const parsed = appendMessagesSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');
      }
      const session = await getConfigStore().getChatSession(req.params.id);
      if (!session) return notFound(res, 'Session not found');
      const messages = await getConfigStore().appendChatMessages(
        req.params.id,
        parsed.data.messages
      );
      res.status(201).json({ messages });
    } catch (err) {
      next(err);
    }
  });

  router.put('/sessions/:id/messages', async (req, res, next) => {
    try {
      const parsed = replaceMessagesSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');
      }
      const session = await getConfigStore().getChatSession(req.params.id);
      if (!session) return notFound(res, 'Session not found');
      const messages = await getConfigStore().replaceChatMessages(
        req.params.id,
        parsed.data.messages
      );
      res.json({ messages });
    } catch (err) {
      next(err);
    }
  });

  router.get('/active-session', async (_req, res, next) => {
    try {
      const activeSessionId = await getConfigStore().getActiveChatSessionId();
      res.json({ activeSessionId });
    } catch (err) {
      next(err);
    }
  });

  router.put('/active-session', async (req, res, next) => {
    try {
      const parsed = activeSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');
      }
      await getConfigStore().setActiveChatSessionId(parsed.data.sessionId);
      res.json({ activeSessionId: parsed.data.sessionId });
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found')) {
        return notFound(res, err.message);
      }
      next(err);
    }
  });

  router.post('/import', async (req, res, next) => {
    try {
      const parsed = importSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid body');
      }
      const result = await getConfigStore().importChatStore(parsed.data);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });
}

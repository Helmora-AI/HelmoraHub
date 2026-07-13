import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requireAdminSession } from '../middleware/requireAdminSession.js';
import { resolveMode } from '../services/mode-router.js';
import { routeChat, routeChatStream } from '../services/tier-router.js';
import { listProviders } from '../db/index.js';
import { HUB_MODES, type HubMode } from '../types.js';
import { isMetaModel, type TokenUsage } from '../keys/types.js';
import { usdToMicros } from '../keys/types.js';
import {
  averageModelCosts,
  billingModelId,
  costForModel,
  usageModelLabel,
} from '../pricing/cost.js';
import { getConfigStore } from '../storage/index.js';
import { randomId } from '../lib/auth.js';
import {
  estimatePromptTokensWithVision,
} from '../lib/vision.js';
import { applyRtk, isRtkEnabledForMode } from '../rtk/apply.js';
import {
  guardInputMessages,
  guardOutputText,
} from '../guardrail/index.js';

export const chatRouter = Router();
chatRouter.use(requireAdminSession);

const HUB_CHAT_MAX_MESSAGES = 200;
const HUB_CHAT_MAX_TOKENS = 128_000;

const chatSchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.string(),
      })
    )
    .min(1)
    .max(HUB_CHAT_MAX_MESSAGES),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(HUB_CHAT_MAX_TOKENS).optional(),
  thinking: z.boolean().optional(),
  reasoning_effort: z.enum(['low', 'medium', 'high']).optional(),
});

function isChatModelRef(model: string): boolean {
  if (model === 'auto' || isMetaModel(model)) return true;
  if (model.startsWith('mode/')) {
    const mode = model.slice('mode/'.length);
    return (HUB_MODES as string[]).includes(mode);
  }
  if (model.startsWith('catalog/')) {
    return model.length > 'catalog/'.length;
  }
  return false;
}

type ResolvedChatModel = {
  requestedModel: string;
  upstreamModel: string;
  mode: HubMode;
  onlyProviderId: string | null;
  meta: boolean;
  thinkingRequested: boolean;
  thinkingApplied: boolean;
};

async function resolveChatModel(
  modelRef: string,
  thinking?: boolean
): Promise<
  | { ok: true; value: ResolvedChatModel }
  | { ok: false; status: number; type: string; message: string }
> {
  const thinkingRequested = Boolean(thinking);
  // Slice 1: no capability matrix — applied only when we actually pass thinking through.
  // Demo / openai-compat: pass through as extra body field when requested.
  const thinkingApplied = thinkingRequested;

  if (!isChatModelRef(modelRef)) {
    return {
      ok: false,
      status: 400,
      type: 'invalid_model_ref',
      message: 'model must be auto, mode/<hubMode>, or catalog/<catalogId>',
    };
  }

  if (modelRef === 'auto' || isMetaModel(modelRef)) {
    const mode = await resolveMode(null);
    return {
      ok: true,
      value: {
        requestedModel: modelRef,
        upstreamModel: 'auto',
        mode,
        onlyProviderId: null,
        meta: true,
        thinkingRequested,
        thinkingApplied,
      },
    };
  }

  if (modelRef.startsWith('mode/')) {
    const modeId = modelRef.slice('mode/'.length);
    const mode = await resolveMode(modeId);
    return {
      ok: true,
      value: {
        requestedModel: modelRef,
        upstreamModel: 'auto',
        mode,
        onlyProviderId: null,
        meta: true,
        thinkingRequested,
        thinkingApplied,
      },
    };
  }

  const catalogId = modelRef.slice('catalog/'.length);
  const store = getConfigStore();
  const row = await store.getHubModel(catalogId);
  if (!row) {
    return {
      ok: false,
      status: 400,
      type: 'catalog_model_not_found',
      message: 'Unknown catalog model id.',
    };
  }

  const provider = await store.getProvider(row.providerId);
  const routable = Boolean(
    row.enabled && provider?.enabled && provider.verifyStatus === 'ok'
  );
  if (!routable) {
    return {
      ok: false,
      status: 400,
      type: 'model_not_routable',
      message: 'The selected model is currently unavailable.',
    };
  }

  const mode = await resolveMode(null);
  return {
    ok: true,
    value: {
      requestedModel: modelRef,
      upstreamModel: row.modelId,
      mode,
      onlyProviderId: row.providerId,
      meta: false,
      thinkingRequested,
      thinkingApplied,
    },
  };
}

chatRouter.post('/completions', async (req, res, next) => {
  const requestId = randomId('req');
  let usageStatus: 'complete' | 'stopped' | 'error' = 'complete';
  let billed = false;

  const recordAdminUsage = async (args: {
    providerId: string;
    routedModel: string;
    usage: TokenUsage;
    estimated: boolean;
    meta: boolean;
    requestedModel: string;
  }) => {
    if (billed) return;
    billed = true;
    const providers = await listProviders();
    const provider = providers.find((p) => p.id === args.providerId);
    const underlying = [
      ...new Set(
        [
          args.routedModel !== 'auto' ? args.routedModel : null,
          provider?.defaultModel,
          args.requestedModel.startsWith('catalog/') ? args.requestedModel : null,
        ].filter(Boolean) as string[]
      ),
    ];
    const billedModel = billingModelId({
      requestedModel: args.requestedModel,
      routedModel: args.routedModel,
      defaultModel: provider?.defaultModel,
    });
    const costUsd = args.meta
      ? averageModelCosts(
          underlying.filter((m) => !m.startsWith('catalog/')).length > 0
            ? underlying.filter((m) => !m.startsWith('catalog/'))
            : [billedModel],
          args.usage
        )
      : costForModel(billedModel, args.usage, args.providerId);
    await getConfigStore().recordUsage({
      requestId,
      source: 'admin_chat',
      apiKeyId: null,
      status: usageStatus,
      model: usageModelLabel({
        requestedModel: args.requestedModel,
        routedModel: args.routedModel,
      }),
      underlyingModels: underlying,
      providerId: args.providerId,
      costMicrosUsd: usdToMicros(costUsd),
      promptTokens: args.usage.prompt_tokens ?? null,
      completionTokens: args.usage.completion_tokens ?? null,
      estimated: args.estimated,
    });
  };

  try {
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { message: parsed.error.message, type: 'invalid_request_error' },
      });
      return;
    }

    const body = parsed.data;
    const resolved = await resolveChatModel(body.model, body.thinking);
    if (!resolved.ok) {
      res.status(resolved.status).json({
        error: { message: resolved.message, type: resolved.type },
      });
      return;
    }

    const ctx = resolved.value;
    const messages = body.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const { messages: guardedMessages, report: inputGuard } =
      guardInputMessages(messages);
    if (inputGuard.blocked) {
      res.status(400).json({
        error: {
          message: inputGuard.blockMessage ?? 'Request blocked by guardrail.',
          type: 'guardrail_blocked',
        },
      });
      return;
    }

    const chatReq: Record<string, unknown> = {
      model: ctx.upstreamModel,
      messages: guardedMessages,
      stream: body.stream !== false,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
    };

    if (ctx.thinkingApplied) {
      chatReq.thinking = true;
      if (body.reasoning_effort) chatReq.reasoning_effort = body.reasoning_effort;
    }

    const rtkOn = isRtkEnabledForMode(ctx.mode);
    const { body: compressedReq } = applyRtk(chatReq, rtkOn);

    const opts = {
      mode: ctx.mode,
      onlyProviderId: ctx.onlyProviderId,
      sessionKey: null as string | null,
    };

    const wantStream = body.stream !== false;

    if (!wantStream) {
      const ac = new AbortController();
      const onClose = () => {
        if (!res.writableFinished) ac.abort();
      };
      res.on('close', onClose);
      let result: Awaited<ReturnType<typeof routeChat>>;
      try {
        result = await routeChat(compressedReq as never, {
          ...opts,
          signal: ac.signal,
        });
      } finally {
        res.off('close', onClose);
      }

      if (ac.signal.aborted) {
        usageStatus = 'stopped';
      } else if (!result.ok) {
        usageStatus = 'error';
      }

      const usage = extractUsage(result.body, guardedMessages);
      await recordAdminUsage({
        providerId: result.providerId,
        routedModel: result.model,
        usage,
        estimated: !(
          result.body &&
          typeof result.body === 'object' &&
          'usage' in result.body
        ),
        meta: ctx.meta,
        requestedModel: ctx.requestedModel,
      });

      if (!result.ok) {
        res.status(result.status >= 400 ? result.status : 502).json(result.body);
        return;
      }

      let outBody = result.body;
      if (outBody && typeof outBody === 'object') {
        const clone = structuredClone(outBody) as {
          choices?: Array<{ message?: { content?: unknown } }>;
          usage?: TokenUsage;
        };
        const content = clone.choices?.[0]?.message?.content;
        if (typeof content === 'string') {
          clone.choices![0]!.message!.content = guardOutputText(content).text;
        }
        if (!clone.usage) clone.usage = usage;
        outBody = clone;
      }
      res.status(200).json(outBody);
      return;
    }

    // ——— SSE ———
    const ac = new AbortController();
    const onClientGone = () => {
      if (!res.writableFinished) {
        usageStatus = 'stopped';
        ac.abort();
      }
    };
    res.on('close', onClientGone);

    const result = await routeChatStream(compressedReq as never, {
      ...opts,
      signal: ac.signal,
    });

    if (!result.ok) {
      res.off('close', onClientGone);
      usageStatus = 'error';
      const usage: TokenUsage = {
        prompt_tokens: estimatePromptTokensWithVision(guardedMessages),
        completion_tokens: 0,
      };
      await recordAdminUsage({
        providerId: result.providerId,
        routedModel: result.model,
        usage,
        estimated: true,
        meta: ctx.meta,
        requestedModel: ctx.requestedModel,
      });
      res.status(result.status >= 400 ? result.status : 502).json(result.body);
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    res.write(
      `event: metadata\ndata: ${JSON.stringify({
        requestId,
        thinkingRequested: ctx.thinkingRequested,
        thinkingApplied: ctx.thinkingApplied,
      })}\n\n`
    );

    try {
      for await (const chunk of result.stream.chunks) {
        if (ac.signal.aborted || res.writableEnded) break;
        const safe = redactStreamChunk(chunk);
        res.write(`data: ${JSON.stringify(safe)}\n\n`);
      }
      if (!res.writableEnded && !ac.signal.aborted) {
        res.write('data: [DONE]\n\n');
      }
    } catch (err) {
      if (!res.writableEnded && !ac.signal.aborted) {
        usageStatus = 'error';
        const message = err instanceof Error ? err.message : String(err);
        res.write(
          `event: error\ndata: ${JSON.stringify({
            error: { type: 'upstream_error', message },
          })}\n\n`
        );
      }
    } finally {
      res.off('close', onClientGone);
    }

    if (ac.signal.aborted) {
      usageStatus = 'stopped';
    }

    const assembled = result.stream.getAssembledContent();
    const streamUsage = result.stream.getUsage();
    const hasReal =
      streamUsage &&
      (streamUsage.prompt_tokens || streamUsage.completion_tokens);
    const usage: TokenUsage = hasReal
      ? streamUsage!
      : {
          prompt_tokens: estimatePromptTokensWithVision(guardedMessages),
          completion_tokens: Math.max(1, Math.ceil((assembled.length || 64) / 4)),
        };

    await recordAdminUsage({
      providerId: result.providerId,
      routedModel: result.model,
      usage,
      estimated: !hasReal,
      meta: ctx.meta,
      requestedModel: ctx.requestedModel,
    });

    if (!res.writableEnded) res.end();
  } catch (err) {
    next(err);
  }
});

function extractUsage(
  body: unknown,
  messages: Array<{ role: string; content?: unknown }>
): TokenUsage {
  if (body && typeof body === 'object' && 'usage' in body) {
    const u = (body as { usage?: TokenUsage }).usage;
    if (u) return u;
  }
  return {
    prompt_tokens: estimatePromptTokensWithVision(
      messages.map((m) => ({ role: m.role, content: m.content ?? '' }))
    ),
    completion_tokens: 1,
  };
}

function redactStreamChunk(chunk: unknown): unknown {
  if (!chunk || typeof chunk !== 'object') return chunk;
  const c = chunk as {
    choices?: Array<{ delta?: { content?: unknown } }>;
  };
  if (!Array.isArray(c.choices) || c.choices.length === 0) return chunk;
  let changed = false;
  const choices = c.choices.map((choice) => {
    if (typeof choice.delta?.content === 'string') {
      const { text } = guardOutputText(choice.delta.content);
      if (text !== choice.delta.content) {
        changed = true;
        return { ...choice, delta: { ...choice.delta, content: text } };
      }
    }
    return choice;
  });
  return changed ? { ...c, choices } : chunk;
}

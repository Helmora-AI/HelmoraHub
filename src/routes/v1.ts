import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { requireApiKey } from '../middleware/requireApiKey.js';
import { resolveMode } from '../services/mode-router.js';
import {
  routeChat,
  routeChatStream,
  routeMiniChat,
  routeMiniChatStream,
} from '../services/tier-router.js';
import { listProviders, listAgents } from '../db/index.js';
import { HUB_MODES, type HubMode, type ProviderToggle } from '../types.js';
import { isMetaModel, META_MODEL_ID, type TokenUsage } from '../keys/types.js';
import {
  averageModelCosts,
  billingModelId,
  costForModel,
  usageModelLabel,
} from '../pricing/cost.js';
import { getConfigStore } from '../storage/index.js';
import { randomId } from '../lib/auth.js';
import { usdToMicros } from '../keys/types.js';
import type { UsageEventStatus } from '../keys/types.js';
import {
  estimatePromptTokensWithVision,
  mergeImagesIntoMessages,
  requestHasImages,
} from '../lib/vision.js';
import { applyRtk, isRtkEnabledForMode, setRtkHeaders, type RtkStats } from '../rtk/apply.js';
import {
  guardInputMessages,
  guardOutputText,
  mergeReports,
  setGuardrailHeaders,
  type GuardrailReport,
} from '../guardrail/index.js';
import { routeEmbeddings } from '../services/embeddings.js';
import { resolveRouteIdentity } from '../services/identity-context.js';
import {
  resolveMiniRouteChain,
  resolveMiniRuntimeAttempts,
} from '../services/mini-route.js';
import { classifyMiniIntent } from '../services/mini-classifier.js';
import { getToolRuntimeConfig } from '../services/tool-config.js';
import {
  blockedToolDecisionMessage,
  buildToolRequestContext,
  hasUnsupportedClientTools,
  parseToolsHeader,
} from '../services/tool-request-policy.js';
import {
  executeChatToolRuntime,
  requireApiKeyToolRuntimeAccess,
  withToolPlanningContext,
  withToolSynthesisContext,
} from '../services/chat-tool-execution.js';
import { ToolRuntimeCoordinatorError } from '../services/tool-runtime-coordinator.js';
import { resolveToolOrchestratorAttempts } from '../services/tool-orchestrator-route.js';

export const v1Router = Router();

v1Router.use(requireApiKey);

const embeddingsSchema = z.object({
  model: z.string().optional(),
  input: z.union([z.string().min(1), z.array(z.string()).min(1)]),
  encoding_format: z.enum(['float', 'base64']).optional(),
  dimensions: z.number().int().positive().max(4096).optional(),
});

const chatSchema = z
  .object({
    model: z.string().optional(),
    messages: z
      .array(
        z.object({
          role: z.string(),
          content: z.unknown(),
        })
      )
      .min(1),
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    max_tokens: z.number().optional(),
    role: z.string().optional(),
    lane: z.string().optional(),
    conversation_id: z.string().optional(),
    session_id: z.string().optional(),
    /** Helper: merge into last user message as image_url parts */
    images: z.array(z.string().min(1)).max(16).optional(),
  })
  .passthrough();

v1Router.get('/models', async (_req, res, next) => {
  try {
    const providers = (await listProviders()).filter((p) => p.enabled);
    const agents = (await listAgents()).filter((a) => a.enabled);
    const data = [
      { id: META_MODEL_ID, object: 'model', created: 0, owned_by: 'helmora' },
      { id: 'auto', object: 'model', created: 0, owned_by: 'helmora' },
      ...HUB_MODES.map((mode) => ({
        id: `mode/${mode}`,
        object: 'model',
        created: 0,
        owned_by: 'helmora',
      })),
      ...providers
        .filter((p) => p.defaultModel)
        .map((p) => ({
          id: p.defaultModel as string,
          object: 'model',
          created: 0,
          owned_by: p.id,
        })),
      ...agents.map((a) => ({
        id: `agent/${a.id}`,
        object: 'model',
        created: 0,
        owned_by: a.nickname,
      })),
      {
        id: 'text-embedding-3-small',
        object: 'model',
        created: 0,
        owned_by: 'helmora',
      },
    ];
    res.json({ object: 'list', data });
  } catch (err) {
    next(err);
  }
});

v1Router.post('/embeddings', async (req, res, next) => {
  try {
    const parsed = embeddingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { message: parsed.error.message, type: 'invalid_request_error' },
      });
      return;
    }

    if (parsed.data.encoding_format === 'base64') {
      res.status(400).json({
        error: {
          message: 'encoding_format=base64 is not supported yet; use float',
          type: 'invalid_request_error',
        },
      });
      return;
    }

    const ac = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) ac.abort();
    };
    res.on('close', onClose);

    let result: Awaited<ReturnType<typeof routeEmbeddings>>;
    try {
      result = await routeEmbeddings(parsed.data, ac.signal);
    } finally {
      res.off('close', onClose);
    }

    const requestId = randomId('req');
    const store = getConfigStore();
    const apiKey = req.ctrlApiKey?.apiKey;
    const costUsd = costForModel(
      result.model,
      {
        prompt_tokens: result.usage.prompt_tokens,
        completion_tokens: 0,
      },
      result.providerId
    );

    if (apiKey) {
      await store.addApiKeySpend(apiKey.id, costUsd);
      await store.recordUsage({
        requestId,
        source: 'api',
        apiKeyId: apiKey.id,
        status: result.ok ? 'complete' : 'error',
        model: result.model,
        underlyingModels: [result.model],
        providerId: result.providerId,
        miniRole: null,
        miniSlot: null,
        miniCatalogId: null,
        costMicrosUsd: usdToMicros(costUsd),
        promptTokens: result.usage.prompt_tokens,
        completionTokens: 0,
        estimated: true,
      });
      const refreshed = await store.getApiKeyById(apiKey.id);
      if (refreshed) {
        res.setHeader('X-Ctrl-Key-Env', refreshed.keyEnv);
        res.setHeader('X-Ctrl-Cost', costUsd.toFixed(8));
        res.setHeader('X-Ctrl-Spent', refreshed.spentUsd.toFixed(8));
        if (refreshed.budgetUsd != null) {
          res.setHeader('X-Ctrl-Budget', String(refreshed.budgetUsd));
        }
      }
    }
    res.setHeader('X-Routed-Via', result.providerId);
    res.setHeader('X-Ctrl-Request-Id', requestId);

    if (!result.ok) {
      res.status(result.status >= 400 ? result.status : 502).json(
        result.body ?? {
          error: { message: result.error ?? 'embeddings_failed', type: 'upstream_error' },
        }
      );
      return;
    }

    res.status(200).json(result.body);
  } catch (err) {
    next(err);
  }
});

v1Router.post('/chat/completions', async (req, res, next) => {
  try {
    const requestId = randomId('req');
    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: { message: parsed.error.message, type: 'invalid_request_error' },
      });
      return;
    }

    if (hasUnsupportedClientTools(req.body)) {
      res.status(400).json({
        error: {
          message: 'Client-defined tools, tool_choice, and tool-role messages are not supported yet.',
          type: 'client_tools_unsupported',
        },
      });
      return;
    }

    const toolsHeader = parseToolsHeader(req.header('x-helmora-tools'));
    if (!toolsHeader.ok) {
      res.status(400).json({
        error: {
          message: 'Invalid X-Helmora-Tools header. Use off|auto|force, or omit.',
          type: 'invalid_tools_policy',
        },
      });
      return;
    }

    const body = parsed.data;
    const toolConfig = await getToolRuntimeConfig();
    const toolContext = buildToolRequestContext({
      config: toolConfig,
      model: body.model ?? 'auto',
      source: 'api',
      requestHeader: toolsHeader.value,
      messages: body.messages,
    });
    res.locals.helmoraTools = toolContext;
    if (toolContext.decision.kind === 'blocked') {
      res.status(409).json({
        error: {
          type: toolContext.decision.reason,
          message: blockedToolDecisionMessage(toolContext.decision.reason),
          requestId,
        },
      });
      return;
    }
    const toolOrchestrator = toolContext.decision.kind === 'execute'
      ? await Promise.all([
          getConfigStore().listHubModels({ limit: 500 }),
          getConfigStore().listProviders(),
        ]).then(([catalog, providers]) => (
          resolveToolOrchestratorAttempts(toolConfig, catalog.models, providers)
        ))
      : null;
    const headerMode =
      req.header('x-helmora-mode') ??
      req.header('x-ctrl-mode') ??
      req.header('x-ctrlhub-mode');
    const ctx = await buildContext(body, headerMode);
    if (ctx.mini && !ctx.mini.resolution.enabled) {
      res.status(503).json(miniFailureBody('mini_disabled', 'Helmora Mini is disabled.', ctx));
      return;
    }
    if (ctx.mini && !ctx.mini.resolution.configured) {
      res.status(503).json(miniFailureBody(
        'mini_role_unconfigured',
        `No model is configured for the ${ctx.mini.classification.role} role.`,
        ctx
      ));
      return;
    }
    if (ctx.mini && ctx.mini.resolution.attempts.length === 0) {
      res.status(503).json(miniFailureBody(
        'mini_role_unavailable',
        `No configured model is currently available for the ${ctx.mini.classification.role} role.`,
        ctx
      ));
      return;
    }

    const normalizedMessages = mergeImagesIntoMessages(
      body.messages.map((m) => ({
        role: m.role,
        content: m.content ?? '',
      })),
      body.images
    );

    const { messages: guardedMessages, report: inputGuard } =
      guardInputMessages(normalizedMessages);
    if (inputGuard.blocked) {
      setGuardrailHeaders(res, inputGuard, false);
      res.status(400).json({
        error: {
          message: inputGuard.blockMessage ?? 'Request blocked by guardrail.',
          type: 'guardrail_blocked',
        },
      });
      return;
    }

    const vision = requestHasImages(guardedMessages);

    const identityResolved = await resolveRouteIdentity({
      surface: 'api',
      headerRaw: req.header('x-helmora-identity'),
      requestedModelRef: ctx.requestedModel,
      meta: ctx.meta,
      displayName: ctx.meta ? 'Helmora Mini 1.0' : null,
      getSetting: (key) => getConfigStore().getSetting(key),
    });
    if (!identityResolved.ok) {
      res.status(400).json({
        error: {
          message: 'Invalid X-Helmora-Identity header. Use on|off|1|0|true|false, or omit.',
          type: 'invalid_identity_header',
        },
      });
      return;
    }

    const chatReq = {
      ...body,
      model: ctx.model,
      messages: guardedMessages,
    };
    delete (chatReq as { images?: unknown }).images;

    const rtkOn = isRtkEnabledForMode(ctx.mode);
    const planningReq = toolContext.decision.kind === 'execute'
      ? withToolPlanningContext(chatReq)
      : chatReq;
    const { body: compressedReq, stats: rtkStats } = applyRtk(planningReq, rtkOn);

    const opts = {
      mode: ctx.mode,
      role: ctx.role,
      lane: ctx.lane,
      sessionKey: ctx.sessionKey,
      preferredChain: ctx.preferredChain,
      modelByProvider: ctx.modelByProvider,
      identity: identityResolved.identity,
    };

    res.setHeader(
      'X-Helmora-Identity',
      identityResolved.identity.enabled ? 'on' : 'off'
    );

    type V1ToolRouteResult =
      | Awaited<ReturnType<typeof routeChat>>
      | Awaited<ReturnType<typeof routeMiniChat>>;
    let precomputedToolResult: V1ToolRouteResult | null = null;
    let toolUsageRecorded = false;
    let plannerCatalogId: string | null = null;
    let toolCostUsd = 0;
    if (toolContext.decision.kind !== 'skip') {
      const apiKeyId = req.ctrlApiKey?.apiKey.id;
      if (!apiKeyId) {
        throw new ToolRuntimeCoordinatorError(
          'invalid_api_key',
          'The API key is no longer active.',
          401,
        );
      }
      const requireFreshApiAccess = () => (
        requireApiKeyToolRuntimeAccess(getConfigStore(), apiKeyId)
      );
      const toolAbort = new AbortController();
      const onToolClientGone = () => {
        if (!res.writableFinished) toolAbort.abort();
      };
      res.on('close', onToolClientGone);
      try {
        const outcome = await executeChatToolRuntime({
          requestId,
          store: getConfigStore(),
          config: toolConfig,
          context: toolContext,
          answerCatalogId: ctx.mini?.resolution.attempts[0]?.catalogId
            ?? (ctx.requestedModel.startsWith('catalog/')
              ? ctx.requestedModel.slice('catalog/'.length)
              : null),
          plannerCatalogId: () => plannerCatalogId,
          signal: toolAbort.signal,
          reauthorize: async () => {
            await requireFreshApiAccess();
            return true;
          },
          modelRound: async ({ pinned, toolRound, signal }) => {
            await requireFreshApiAccess();
            if (toolOrchestrator?.configured) {
              if (toolOrchestrator.attempts.length === 0) {
                throw new ToolRuntimeCoordinatorError(
                  'tool_orchestrator_unavailable',
                  'No configured tool orchestrator is currently available.',
                  503,
                );
              }
              const attempts = pinned
                ? toolOrchestrator.attempts.filter((attempt) => (
                    attempt.provider.id === pinned.providerId && attempt.modelId === pinned.model
                  ))
                : toolOrchestrator.attempts;
              const result = await routeChat(
                { ...(compressedReq as Record<string, unknown>), toolRound } as never,
                {
                  ...opts,
                  onlyProviderId: pinned?.providerId ?? null,
                  preferredChain: attempts.map((attempt) => attempt.provider),
                  modelByProvider: Object.fromEntries(
                    attempts.map((attempt) => [attempt.provider.id, attempt.modelId]),
                  ),
                  signal,
                },
              );
              if (result.ok) {
                plannerCatalogId = attempts.find((attempt) => (
                  attempt.provider.id === result.providerId && attempt.modelId === result.model
                ))?.catalogId ?? null;
              }
              return result;
            }
            if (ctx.mini) {
              const attempts = pinned
                ? ctx.mini.resolution.attempts.filter((attempt) => (
                    attempt.provider.id === pinned.providerId && attempt.modelId === pinned.model
                  ))
                : ctx.mini.resolution.attempts;
              return routeMiniChat(
                { ...(compressedReq as Record<string, unknown>), toolRound } as never,
                attempts,
                { mode: ctx.mode, identity: identityResolved.identity, signal },
              );
            }
            return routeChat(
              { ...(compressedReq as Record<string, unknown>), toolRound } as never,
              {
                ...opts,
                onlyProviderId: pinned?.providerId ?? null,
                modelByProvider: pinned
                  ? { [pinned.providerId]: pinned.model }
                  : opts.modelByProvider,
                signal,
              },
            );
          },
          onModelRound: async ({ round, result: roundResult, proposedCalls }) => {
            const roundUsage = extractUsage(roundResult.body, guardedMessages);
            const selected = ctx.mini && 'selectedAttempt' in roundResult
              ? (roundResult as Awaited<ReturnType<typeof routeMiniChat>>).selectedAttempt
              : null;
            const roundPhase = toolOrchestrator?.configured || proposedCalls.length > 0
              ? 'tool_planner'
              : 'tool_synthesis';
            toolCostUsd += await applyBilling(req, res, {
              ...ctx,
              providerId: roundResult.providerId,
              routedModel: roundResult.model,
              attempts: roundResult.attempts.length,
              usage: roundUsage,
              headersSent: true,
              vision,
              rtkStats,
              guardReport: inputGuard,
              requestId: `${requestId}:${roundPhase}:${round}`,
              parentRequestId: requestId,
              usagePhase: roundPhase,
              toolRound: round,
              miniRole: ctx.mini?.classification.role ?? null,
              miniSlot: selected?.slot ?? null,
              miniCatalogId: selected?.catalogId ?? null,
            });
          },
        });
        if (!outcome) {
          throw new ToolRuntimeCoordinatorError('tool_runtime_unavailable', 'Tool runtime did not execute.');
        }
        let toolResult = outcome.result as V1ToolRouteResult;
        if (toolOrchestrator?.configured) {
          await requireFreshApiAccess();
          const synthesisRequest = withToolSynthesisContext(
            compressedReq as Record<string, unknown>,
            outcome.context,
          );
          toolResult = ctx.mini
            ? await routeMiniChat(synthesisRequest as never, ctx.mini.resolution.attempts, {
                mode: ctx.mode,
                identity: identityResolved.identity,
                signal: toolAbort.signal,
              })
            : await routeChat(synthesisRequest as never, { ...opts, signal: toolAbort.signal });
          const synthesisUsage = extractUsage(toolResult.body, synthesisRequest.messages);
          const synthesisSelected = ctx.mini && 'selectedAttempt' in toolResult
            ? (toolResult as Awaited<ReturnType<typeof routeMiniChat>>).selectedAttempt
            : null;
          toolCostUsd += await applyBilling(req, res, {
            ...ctx,
            providerId: toolResult.providerId,
            routedModel: toolResult.model,
            attempts: toolResult.attempts.length,
            usage: synthesisUsage,
            headersSent: true,
            vision,
            rtkStats,
            guardReport: inputGuard,
            requestId: `${requestId}:tool_synthesis:${outcome.rounds + 1}`,
            parentRequestId: requestId,
            usagePhase: 'tool_synthesis',
            toolRound: outcome.rounds + 1,
            miniRole: ctx.mini?.classification.role ?? null,
            miniSlot: synthesisSelected?.slot ?? null,
            miniCatalogId: synthesisSelected?.catalogId ?? null,
          });
        }
        precomputedToolResult = toolResult;
        toolUsageRecorded = true;
        res.setHeader('X-CtrL-Mode', ctx.mode);
        res.setHeader('X-Routed-Via', toolResult.providerId);
        res.setHeader('X-Fallback-Attempts', String(toolResult.attempts.length));
        if (ctx.meta) res.setHeader('X-Ctrl-Meta-Model', META_MODEL_ID);
        if (vision) res.setHeader('X-Ctrl-Vision', '1');
        setRtkHeaders(res, rtkStats, false);
        setGuardrailHeaders(res, inputGuard, false);
        const toolSelectedAttempt = ctx.mini && 'selectedAttempt' in toolResult
          ? (toolResult as Awaited<ReturnType<typeof routeMiniChat>>).selectedAttempt
          : null;
        if (toolSelectedAttempt) {
          res.setHeader('X-Helmora-Mini-Role', ctx.mini!.classification.role);
          res.setHeader('X-Helmora-Mini-Slot', toolSelectedAttempt.slot);
        }
        const apiKey = req.ctrlApiKey?.apiKey;
        if (apiKey) {
          const refreshed = await getConfigStore().getApiKeyById(apiKey.id);
          if (refreshed) {
            res.setHeader('X-Ctrl-Key-Env', refreshed.keyEnv);
            res.setHeader('X-Ctrl-Cost', toolCostUsd.toFixed(8));
            res.setHeader('X-Ctrl-Spent', refreshed.spentUsd.toFixed(8));
            if (refreshed.budgetUsd != null) {
              res.setHeader('X-Ctrl-Budget', String(refreshed.budgetUsd));
            }
          }
        }
        if (body.stream) {
          if (!toolResult.ok) {
            res.status(toolResult.status).json(toolResult.body);
            return;
          }
          const rawContent = (toolResult.body as {
            choices?: Array<{ message?: { content?: unknown } }>;
          })?.choices?.[0]?.message?.content;
          const content = typeof rawContent === 'string' ? guardOutputText(rawContent).text : '';
          res.status(200);
          res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          if (typeof res.flushHeaders === 'function') res.flushHeaders();
          res.write(': helmora tool runtime complete\n\n');
          if (content) {
            res.write(`data: ${JSON.stringify({
              choices: [{ index: 0, delta: { content }, finish_reason: null }],
            })}\n\n`);
          }
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
      } catch (error) {
        if (error instanceof ToolRuntimeCoordinatorError && !res.headersSent) {
          res.status(error.status).json({
            error: { type: error.code, message: error.message, requestId },
          });
          return;
        }
        throw error;
      } finally {
        res.off('close', onToolClientGone);
      }
    }

    if (body.stream) {
      await writeSse(
        req,
        res,
        compressedReq,
        opts,
        ctx,
        guardedMessages,
        vision,
        rtkStats,
        inputGuard
      );
      return;
    }

    const ac = new AbortController();
    const onClientGone = () => {
      if (!res.writableFinished) ac.abort();
    };
    res.on('close', onClientGone);
    let result:
      | Awaited<ReturnType<typeof routeChat>>
      | Awaited<ReturnType<typeof routeMiniChat>>;
    try {
      result = precomputedToolResult ?? (ctx.mini
        ? await routeMiniChat(compressedReq, ctx.mini.resolution.attempts, {
            mode: ctx.mode,
            identity: identityResolved.identity,
            signal: ac.signal,
          })
        : await routeChat(compressedReq, { ...opts, signal: ac.signal }));
    } finally {
      res.off('close', onClientGone);
    }
    const usage = extractUsage(result.body, guardedMessages);
    let guardReport = inputGuard;
    if (result.ok && result.body && typeof result.body === 'object') {
      const guardedBody = redactAssistantInBody(result.body);
      result.body = guardedBody.body;
      guardReport = mergeReports(inputGuard, guardedBody.report);
    }
    if (ctx.mini && result.ok && result.body && typeof result.body === 'object') {
      (result.body as { model?: string }).model = META_MODEL_ID;
    }
    const miniSelectedAttempt = ctx.mini
      ? (result as Awaited<ReturnType<typeof routeMiniChat>>).selectedAttempt
      : null;
    if (ctx.mini && miniSelectedAttempt) {
      res.setHeader('X-Helmora-Mini-Role', ctx.mini.classification.role);
      res.setHeader('X-Helmora-Mini-Slot', miniSelectedAttempt.slot);
    }

    if (!toolUsageRecorded) await applyBilling(req, res, {
      ...ctx,
      providerId: result.providerId,
      routedModel: result.model,
      attempts: result.attempts.length,
      usage,
      headersSent: false,
      vision,
      rtkStats,
      guardReport,
      miniRole: ctx.mini?.classification.role ?? null,
      miniSlot: miniSelectedAttempt?.slot ?? null,
      miniCatalogId: miniSelectedAttempt?.catalogId ?? null,
    });
    if (toolUsageRecorded) setGuardrailHeaders(res, guardReport, false);

    if (!result.ok) {
      res.status(result.status >= 400 ? result.status : 502).json(
        ctx.mini
          ? miniFailureBody(
              'mini_role_unavailable',
              result.error ?? 'No configured Mini model completed the request.',
              ctx,
              result.attempts.map((attempt) =>
                'slot' in attempt ? attempt.slot : null
              ).filter((slot): slot is 'primary' | 'fallback' => slot !== null)
            )
          : result.body
      );
      return;
    }

    if (result.body && typeof result.body === 'object' && !(result.body as { usage?: unknown }).usage) {
      (result.body as { usage: TokenUsage }).usage = usage;
    }
    res.status(200).json(result.body);
  } catch (err) {
    next(err);
  }
});

type ChatBody = z.infer<typeof chatSchema>;

function miniFailureBody(
  type: string,
  message: string,
  ctx: Awaited<ReturnType<typeof buildContext>>,
  attemptedSlots?: Array<'primary' | 'fallback'>
) {
  return {
    error: {
      type,
      message,
      mini: ctx.mini
        ? {
            role: ctx.mini.classification.role,
            attemptedSlots: attemptedSlots ?? [],
            requestId: randomId('req'),
          }
        : undefined,
    },
  };
}

function miniUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const text = (part as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function miniClassifierContext(messages: ChatBody['messages']) {
  const userTexts = messages
    .filter((message) => message.role === 'user')
    .map((message) => miniUserText(message.content))
    .filter(Boolean);
  return {
    latestUserText: userTexts.at(-1) ?? '',
    previousUserText: userTexts.at(-2),
  };
}

async function buildContext(body: ChatBody, headerMode: string | null | undefined) {
  let mode = await resolveMode(headerMode);
  if (body.model?.startsWith('mode/')) {
    mode = await resolveMode(body.model.slice('mode/'.length));
  }

  let role = typeof body.role === 'string' ? body.role : null;
  let lane = typeof body.lane === 'string' ? body.lane : null;
  let model = body.model;
  const requestedModel = body.model ?? 'auto';
  const meta = isMetaModel(requestedModel) || requestedModel === 'auto';
  const sessionKey =
    (typeof body.session_id === 'string' && body.session_id) ||
    (typeof body.conversation_id === 'string' && body.conversation_id) ||
    null;

  let preferredChain: ProviderToggle[] | null = null;
  let modelByProvider: Record<string, string> | null = null;
  let mini: {
    classification: ReturnType<typeof classifyMiniIntent>;
    resolution: Awaited<ReturnType<typeof resolveMiniRuntimeAttempts>>;
  } | null = null;

  if (meta && !body.model?.startsWith('mode/')) {
    mode = 'smart';
    const classification = classifyMiniIntent(miniClassifierContext(body.messages));
    mini = {
      classification,
      resolution: await resolveMiniRuntimeAttempts(classification.role),
    };
    model = 'auto';
  } else if (meta) {
    model = 'auto';
  }

  if (!mini && body.model?.startsWith('agent/')) {
    const agentId = body.model.slice('agent/'.length);
    const agent = (await listAgents()).find((a) => a.id === agentId);
    if (agent) {
      role = agent.id;
      lane = agent.id;
      mode = agent.mode;
      if (agent.model === 'auto') {
        model = 'auto';
        const mini = await resolveMiniRouteChain();
        preferredChain = mini.chain;
        modelByProvider = Object.keys(mini.modelByProvider).length
          ? mini.modelByProvider
          : null;
      } else {
        model = agent.model;
        preferredChain = null;
        modelByProvider = null;
      }
    }
  } else if (!mini) {
    const officeRole = role ?? lane;
    if (officeRole) {
      const agent = (await listAgents()).find((a) => a.id === officeRole && a.enabled);
      if (agent) {
        role = agent.id;
        lane = agent.id;
        mode = agent.mode;
        if (agent.model === 'auto') {
          if (!isMetaModel(model ?? 'auto') && model !== 'auto') {
            // Keep explicit upstream model from Office session when set.
          } else {
            const mini = await resolveMiniRouteChain();
            mode = mini.mode;
            preferredChain = mini.chain;
            modelByProvider = Object.keys(mini.modelByProvider).length
              ? mini.modelByProvider
              : null;
            model = 'auto';
          }
        } else {
          model = agent.model;
          preferredChain = null;
          modelByProvider = null;
        }
      }
    }
  }

  return {
    mode,
    role,
    lane,
    model,
    requestedModel,
    meta,
    sessionKey,
    preferredChain,
    modelByProvider,
    mini,
  };
}

async function writeSse(
  req: Request,
  res: Response,
  chatReq: Parameters<typeof routeChatStream>[0],
  opts: Parameters<typeof routeChatStream>[1],
  ctx: Awaited<ReturnType<typeof buildContext>>,
  messages: Array<{ role: string; content?: unknown }>,
  vision: boolean,
  rtkStats: RtkStats | null,
  inputGuard: GuardrailReport
): Promise<void> {
  const ac = new AbortController();
  const onClientGone = () => {
    if (!res.writableFinished) ac.abort();
  };
  res.on('close', onClientGone);

  const result = ctx.mini
    ? await routeMiniChatStream(chatReq, ctx.mini.resolution.attempts, {
        mode: ctx.mode,
        identity: opts.identity,
        signal: ac.signal,
      })
    : await routeChatStream(chatReq, { ...opts, signal: ac.signal });

  if (!result.ok) {
    res.off('close', onClientGone);
    setGuardrailHeaders(res, inputGuard, false);
    res.status(result.status >= 400 ? result.status : 502).json(
      ctx.mini
        ? miniFailureBody(
            'mini_role_unavailable',
            result.error ?? 'No configured Mini model completed the stream.',
            ctx,
            result.attempts.map((attempt) =>
              'slot' in attempt ? attempt.slot : null
            ).filter((slot): slot is 'primary' | 'fallback' => slot !== null)
          )
        : result.body
    );
    return;
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-CtrL-Mode', ctx.mode);
  res.setHeader('X-Routed-Via', result.providerId);
  res.setHeader('X-Fallback-Attempts', String(result.attempts.length));
  const miniSelectedAttempt = ctx.mini
    ? (result as Awaited<ReturnType<typeof routeMiniChatStream>>).selectedAttempt
    : null;
  if (ctx.mini && miniSelectedAttempt) {
    res.setHeader('X-Helmora-Mini-Role', ctx.mini.classification.role);
    res.setHeader('X-Helmora-Mini-Slot', miniSelectedAttempt.slot);
  }
  if (ctx.meta) res.setHeader('X-Ctrl-Meta-Model', META_MODEL_ID);
  if (vision) res.setHeader('X-Ctrl-Vision', '1');
  setRtkHeaders(res, rtkStats, false);
  // Stream: only input findings are visible in headers (flushed before body).
  setGuardrailHeaders(res, inputGuard, false);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  try {
    for await (const chunk of result.stream.chunks) {
      if (ac.signal.aborted || res.writableEnded) break;
      const safe = redactStreamChunk(chunk);
      const publicChunk = ctx.mini && safe && typeof safe === 'object'
        ? { ...safe, model: META_MODEL_ID }
        : safe;
      res.write(`data: ${JSON.stringify(publicChunk)}\n\n`);
    }
    if (!res.writableEnded && !ac.signal.aborted) res.write('data: [DONE]\n\n');
  } catch (err) {
    if (!res.writableEnded) {
      if (ac.signal.aborted) {
        // client gone — don't write error frames
      } else {
        const message = err instanceof Error ? err.message : String(err);
        res.write(`data: ${JSON.stringify({ error: { message, type: 'stream_error' } })}\n\n`);
        res.write('data: [DONE]\n\n');
      }
    }
  } finally {
    res.off('close', onClientGone);
  }

  if (ac.signal.aborted) {
    if (!res.writableEnded) res.end();
    return;
  }

  const assembled = result.stream.getAssembledContent();
  const streamUsage = result.stream.getUsage();
  const usage: TokenUsage =
    streamUsage && (streamUsage.prompt_tokens || streamUsage.completion_tokens)
      ? streamUsage
      : {
          prompt_tokens: estimatePromptTokensWithVision(
            messages.map((m) => ({ role: m.role, content: m.content ?? '' }))
          ),
          completion_tokens: Math.max(1, Math.ceil((assembled.length || 64) / 4)),
        };

  await applyBilling(req, res, {
    ...ctx,
    providerId: result.providerId,
    routedModel: result.model,
    attempts: result.attempts.length,
    usage,
    headersSent: true,
    vision,
    rtkStats,
    guardReport: inputGuard,
    miniRole: ctx.mini?.classification.role ?? null,
    miniSlot: miniSelectedAttempt?.slot ?? null,
    miniCatalogId: miniSelectedAttempt?.catalogId ?? null,
  });

  if (!res.writableEnded) res.end();
}

function redactAssistantInBody(body: unknown): {
  body: unknown;
  report: GuardrailReport;
} {
  if (!body || typeof body !== 'object') {
    return {
      body,
      report: { enabled: false, findings: [], blocked: false },
    };
  }
  const clone = structuredClone(body) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = clone.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    return {
      body: clone,
      report: { enabled: false, findings: [], blocked: false },
    };
  }
  const guarded = guardOutputText(content);
  if (clone.choices?.[0]?.message) {
    clone.choices[0].message.content = guarded.text;
  }
  return { body: clone, report: guarded.report };
}

function redactStreamChunk(chunk: unknown): unknown {
  if (!chunk || typeof chunk !== 'object') return chunk;
  const c = chunk as {
    choices?: Array<{
      delta?: { content?: unknown };
      message?: { content?: unknown };
    }>;
  };
  if (!Array.isArray(c.choices) || c.choices.length === 0) return chunk;
  let changed = false;
  const choices = c.choices.map((choice) => {
    let next = choice;
    if (typeof choice.delta?.content === 'string') {
      const { text } = guardOutputText(choice.delta.content);
      if (text !== choice.delta.content) {
        changed = true;
        next = {
          ...next,
          delta: { ...choice.delta, content: text },
        };
      }
    }
    if (typeof choice.message?.content === 'string') {
      const { text } = guardOutputText(choice.message.content);
      if (text !== choice.message.content) {
        changed = true;
        next = {
          ...next,
          message: { ...choice.message, content: text },
        };
      }
    }
    return next;
  });
  return changed ? { ...c, choices } : chunk;
}

async function applyBilling(
  req: Request,
  res: Response,
  args: {
    meta: boolean;
    requestedModel: string;
    mode: HubMode;
    providerId: string;
    routedModel: string;
    attempts: number;
    usage: TokenUsage;
    headersSent: boolean;
    vision?: boolean;
    rtkStats?: RtkStats | null;
    guardReport?: GuardrailReport | null;
    status?: UsageEventStatus;
    requestId?: string;
    parentRequestId?: string | null;
    toolRunId?: string | null;
    usagePhase?: import('../keys/types.js').UsageEvent['usagePhase'];
    toolRound?: number | null;
    estimated?: boolean;
    miniRole?: import('../keys/types.js').UsageEvent['miniRole'];
    miniSlot?: import('../keys/types.js').UsageEvent['miniSlot'];
    miniCatalogId?: string | null;
  }
): Promise<number> {
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

  const costMicrosUsd = usdToMicros(costUsd);
  const apiKey = req.ctrlApiKey?.apiKey;
  const requestId = args.requestId ?? randomId('req');
  const store = getConfigStore();

  if (apiKey) {
    await store.addApiKeySpend(apiKey.id, costUsd);
    await store.recordUsage({
      requestId,
      parentRequestId: args.parentRequestId ?? null,
      toolRunId: args.toolRunId ?? null,
      source: 'api',
      apiKeyId: apiKey.id,
      status: args.status ?? 'complete',
      model: usageModelLabel({
        requestedModel: args.requestedModel,
        routedModel: args.routedModel,
      }),
      underlyingModels: underlying,
      providerId: args.providerId,
      miniRole: args.miniRole ?? null,
      miniSlot: args.miniSlot ?? null,
      miniCatalogId: args.miniCatalogId ?? null,
      usagePhase: args.usagePhase ?? 'answer',
      toolRound: args.toolRound ?? null,
      costMicrosUsd,
      promptTokens: args.usage.prompt_tokens ?? null,
      completionTokens: args.usage.completion_tokens ?? null,
      estimated: Boolean(args.estimated),
    });
    if (!args.headersSent) {
      const refreshed = await store.getApiKeyById(apiKey.id);
      if (refreshed) {
        res.setHeader('X-Ctrl-Key-Env', refreshed.keyEnv);
        res.setHeader('X-Ctrl-Cost', costUsd.toFixed(8));
        res.setHeader('X-Ctrl-Spent', refreshed.spentUsd.toFixed(8));
        if (refreshed.budgetUsd != null) {
          res.setHeader('X-Ctrl-Budget', String(refreshed.budgetUsd));
        }
      }
    }
  }

  if (!args.headersSent) {
    res.setHeader('X-CtrL-Mode', args.mode);
    res.setHeader('X-Routed-Via', args.providerId);
    res.setHeader('X-Fallback-Attempts', String(args.attempts));
    if (args.meta) res.setHeader('X-Ctrl-Meta-Model', META_MODEL_ID);
    if (args.vision) res.setHeader('X-Ctrl-Vision', '1');
    setRtkHeaders(res, args.rtkStats ?? null, false);
    setGuardrailHeaders(res, args.guardReport ?? null, false);
  }
  return costUsd;
}

function extractUsage(
  body: unknown,
  messages: Array<{ role?: string; content?: unknown }>
): TokenUsage {
  const fromBody =
    body && typeof body === 'object' && 'usage' in body
      ? (body as { usage?: TokenUsage }).usage
      : undefined;
  if (fromBody && (fromBody.prompt_tokens || fromBody.completion_tokens)) return fromBody;

  let completionChars = 64;
  try {
    const choices = (body as { choices?: Array<{ message?: { content?: string } }> })?.choices;
    completionChars = String(choices?.[0]?.message?.content ?? '').length || 64;
  } catch {
    // ignore
  }
  return {
    prompt_tokens: estimatePromptTokensWithVision(
      messages.map((m) => ({ role: m.role ?? 'user', content: m.content ?? '' }))
    ),
    completion_tokens: Math.max(1, Math.ceil(completionChars / 4)),
  };
}

import { parseOpenAIChatToolCalls } from '../providers/adapters/openai-tools.js';
import {
  ProviderToolProtocolError,
  type ProviderToolRound,
} from '../providers/native-tools.js';
import type { NormalizedToolResult, RegisteredTool } from '../tools/types.js';
import {
  runToolLoop,
  type ProposedToolCall,
  ToolLoopError,
  type ToolLoopLimits,
} from './tool-loop.js';

export type ToolModelResult = {
  ok: boolean;
  status: number;
  providerId: string;
  model: string;
  body: unknown;
  error?: string;
};

export type PinnedToolRoute = { providerId: string; model: string };

export class ToolRuntimeCoordinatorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 503,
  ) {
    super(message);
    this.name = 'ToolRuntimeCoordinatorError';
  }
}

function normalizeToolRuntimeError(error: unknown): never {
  if (error instanceof ToolRuntimeCoordinatorError) throw error;
  if (error instanceof ProviderToolProtocolError) {
    throw new ToolRuntimeCoordinatorError(error.code, error.message, 502);
  }
  if (error instanceof ToolLoopError) {
    const status = error.code === 'tool_not_allowed'
      ? 409
      : error.code === 'tool_loop_timeout' || error.code === 'tool_connector_timeout'
        ? 504
        : 502;
    throw new ToolRuntimeCoordinatorError(error.code, error.message, status);
  }
  throw error;
}

export async function runToolRuntimeCoordinator<T extends ToolModelResult>(input: {
  eligibleTools: readonly RegisteredTool[];
  requireToolCall?: boolean;
  modelRound: (input: {
    round: number;
    pinned: PinnedToolRoute | null;
    toolRound: ProviderToolRound;
    signal: AbortSignal;
  }) => Promise<T>;
  execute: (input: {
    call: ProposedToolCall;
    tool: RegisteredTool;
    signal: AbortSignal;
  }) => Promise<NormalizedToolResult>;
  reauthorize?: (input: {
    call: ProposedToolCall;
    tool: RegisteredTool;
    signal: AbortSignal;
  }) => boolean | Promise<boolean>;
  onModelRound?: (input: {
    round: number;
    result: T;
    proposedCalls: readonly ProposedToolCall[];
  }) => void | Promise<void>;
  signal?: AbortSignal;
  limits?: Partial<ToolLoopLimits>;
  connectorTimeoutFor?: (tool: RegisteredTool) => number;
}) {
  if (input.eligibleTools.length === 0) {
    throw new ToolRuntimeCoordinatorError('no_eligible_tools', 'No eligible tools are available.');
  }
  let pinned: PinnedToolRoute | null = null;
  let pendingCalls: ProposedToolCall[] | undefined;
  let consumedResults = 0;

  const outcome = await (async () => {
    try {
      return await runToolLoop<T>({
        eligibleTools: input.eligibleTools,
        signal: input.signal,
        limits: input.limits,
        connectorTimeoutFor: input.connectorTimeoutFor,
        reauthorize: input.reauthorize,
        execute: input.execute,
        decide: async (state) => {
          const results = pendingCalls
            ? state.results.slice(consumedResults)
            : undefined;
          const toolRound: ProviderToolRound = {
            definitions: input.eligibleTools,
            required: Boolean(input.requireToolCall && state.totalCalls === 0),
            round: state.round,
            ...(pendingCalls ? { calls: pendingCalls, results } : {}),
          };
          const result = await input.modelRound({
            round: state.round,
            pinned,
            toolRound,
            signal: state.signal,
          });
          if (!result.ok) {
            throw new ToolRuntimeCoordinatorError(
              result.error || 'tool_model_round_failed',
              'The tool-planning model round failed.',
              result.status >= 400 ? result.status : 502,
            );
          }
          if (!pinned) {
            pinned = { providerId: result.providerId, model: result.model };
          } else if (result.providerId !== pinned.providerId || result.model !== pinned.model) {
            throw new ToolRuntimeCoordinatorError(
              'tool_route_changed',
              'The provider or model changed during a tool loop.',
              502,
            );
          }
          if (pendingCalls) consumedResults = state.results.length;
          const calls = parseOpenAIChatToolCalls(result.body, input.eligibleTools);
          await input.onModelRound?.({ round: state.round, result, proposedCalls: calls });
          if (calls.length === 0) return { kind: 'complete' as const, value: result };
          pendingCalls = calls;
          return { kind: 'calls' as const, calls };
        },
      });
    } catch (error) {
      normalizeToolRuntimeError(error);
    }
  })();

  if (input.requireToolCall && outcome.totalCalls === 0) {
    throw new ToolRuntimeCoordinatorError(
      'tool_not_used',
      'The model completed without invoking a required tool.',
      502,
    );
  }
  return { ...outcome, result: outcome.value, pinned: pinned! };
}

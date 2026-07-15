import { REGISTERED_TOOLS } from '../tools/registry.js';
import { ToolSchemaValidationError, validateToolArguments } from '../tools/schema-validation.js';
import {
  appendBoundedToolContext,
  boundModelToolResult,
  formatUntrustedToolResult,
  safeToolErrorResult,
  type ModelToolResult,
} from '../tools/untrusted-context.js';
import type {
  NormalizedToolResult,
  RegisteredTool,
  RegisteredToolId,
} from '../tools/types.js';

export const DEFAULT_TOOL_LOOP_LIMITS = Object.freeze({
  maxToolRounds: 4,
  maxCallsPerRound: 4,
  maxTotalCalls: 8,
  totalTimeoutMs: 30_000,
  connectorTimeoutMs: 10_000,
  maxResultBytes: 64 * 1_024,
  maxContextBytes: 128 * 1_024,
});

export type ToolLoopLimits = typeof DEFAULT_TOOL_LOOP_LIMITS;

export type ProposedToolCall = {
  id: string;
  toolId: RegisteredToolId;
  arguments: Record<string, unknown>;
};

export type ToolLoopDecision<T = unknown> =
  | { kind: 'complete'; value: T }
  | { kind: 'calls'; calls: ProposedToolCall[] };

export type ToolLoopState = {
  round: number;
  totalCalls: number;
  results: readonly ModelToolResult[];
  context: string;
  contextBytes: number;
  signal: AbortSignal;
};

export type ToolLoopOutcome<T> = Omit<ToolLoopState, 'signal' | 'round'> & {
  value: T;
  rounds: number;
};

export class ToolLoopError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = 'ToolLoopError';
  }
}

type Timer = ReturnType<typeof setTimeout>;

function scopedSignal(parent: AbortSignal | undefined, timeoutMs: number, timeoutCode: string): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(
    parent?.reason instanceof ToolLoopError
      ? parent.reason
      : new ToolLoopError('tool_aborted', 'Tool work was cancelled.'),
  );
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener('abort', abortFromParent, { once: true });
  const timer: Timer = setTimeout(() => {
    controller.abort(new ToolLoopError(timeoutCode, 'Tool work exceeded its time budget.'));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    },
  };
}

function abortReason(signal: AbortSignal): ToolLoopError {
  return signal.reason instanceof ToolLoopError
    ? signal.reason
    : new ToolLoopError('tool_aborted', 'Tool work was cancelled.');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
  return value;
}

function resolveLimits(overrides: Partial<ToolLoopLimits> | undefined): ToolLoopLimits {
  const merged = { ...DEFAULT_TOOL_LOOP_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(merged)) positiveInteger(value, name);
  return merged;
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = record(value);
  if (object) {
    return `{${Object.keys(object).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(object[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalTool(
  call: ProposedToolCall,
  eligibleIds: ReadonlySet<RegisteredToolId>,
): RegisteredTool {
  if (!eligibleIds.has(call.toolId)) {
    throw new ToolLoopError('tool_not_allowed', 'Tool is disabled or out of scope.');
  }
  const registered = REGISTERED_TOOLS.find((tool) => tool.id === call.toolId);
  if (!registered || registered.risk !== 'read') {
    throw new ToolLoopError('tool_not_allowed', 'Tool is not registered as read-only.');
  }
  return registered;
}

function prepareCall(
  rawCall: unknown,
  eligibleIds: ReadonlySet<RegisteredToolId>,
): { call: ProposedToolCall; tool: RegisteredTool; dedupeKey: string } {
  const value = record(rawCall);
  if (!value) throw new ToolLoopError('tool_invalid_call', 'Tool call must be an object.');
  if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 200) {
    throw new ToolLoopError('tool_invalid_call', 'Tool call id is invalid.');
  }
  if (value.toolId !== 'web_search' && value.toolId !== 'web_fetch') {
    throw new ToolLoopError('tool_not_allowed', 'Tool is not registered.');
  }
  const rawArguments = record(value.arguments);
  if (!rawArguments) {
    throw new ToolLoopError('tool_invalid_arguments', 'Tool arguments must be an object.', '$');
  }
  const raw: ProposedToolCall = {
    id: value.id,
    toolId: value.toolId,
    arguments: rawArguments,
  };
  const tool = canonicalTool(raw, eligibleIds);
  try {
    const args = validateToolArguments(tool.inputSchema, raw.arguments);
    const call = { ...raw, id: raw.id.trim(), arguments: args };
    return { call, tool, dedupeKey: `${tool.id}:${stableJson(args)}` };
  } catch (error) {
    if (error instanceof ToolSchemaValidationError) {
      throw new ToolLoopError('tool_invalid_arguments', error.message, error.path);
    }
    throw error;
  }
}

export async function runToolLoop<T>(input: {
  eligibleTools: readonly RegisteredTool[];
  decide: (state: ToolLoopState) => Promise<ToolLoopDecision<T>>;
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
  signal?: AbortSignal;
  limits?: Partial<ToolLoopLimits>;
  modelContextMaxBytes?: number;
}): Promise<ToolLoopOutcome<T>> {
  const limits = resolveLimits(input.limits);
  const contextLimit = input.modelContextMaxBytes === undefined
    ? limits.maxContextBytes
    : Math.min(limits.maxContextBytes, positiveInteger(input.modelContextMaxBytes, 'modelContextMaxBytes'));
  const lifecycle = scopedSignal(input.signal, limits.totalTimeoutMs, 'tool_loop_timeout');
  const eligibleIds = new Set(input.eligibleTools.map((tool) => tool.id));
  const seenCallIds = new Set<string>();
  const deduplicated = new Map<string, Omit<ModelToolResult, 'callId'>>();
  const results: ModelToolResult[] = [];
  let context = '';
  let contextBytes = 0;
  let rounds = 0;
  let totalCalls = 0;

  try {
    while (true) {
      throwIfAborted(lifecycle.signal);
      const rawDecision: unknown = await abortable(Promise.resolve(input.decide({
        round: rounds,
        totalCalls,
        results: structuredClone(results),
        context,
        contextBytes,
        signal: lifecycle.signal,
      })), lifecycle.signal);
      const decision = record(rawDecision);
      if (!decision) {
        throw new ToolLoopError('tool_invalid_decision', 'Tool decision must be an object.');
      }
      if (decision.kind === 'complete') {
        return { value: decision.value as T, rounds, totalCalls, results, context, contextBytes };
      }
      if (decision.kind !== 'calls' || !Array.isArray(decision.calls) || decision.calls.length === 0) {
        throw new ToolLoopError('tool_invalid_decision', 'Tool decision must contain at least one call.');
      }
      if (rounds >= limits.maxToolRounds) {
        throw new ToolLoopError('tool_rounds_exceeded', 'Maximum tool rounds exceeded.');
      }
      if (decision.calls.length > limits.maxCallsPerRound) {
        throw new ToolLoopError('tool_calls_per_round_exceeded', 'Maximum calls per round exceeded.');
      }
      if (totalCalls + decision.calls.length > limits.maxTotalCalls) {
        throw new ToolLoopError('tool_total_calls_exceeded', 'Maximum total tool calls exceeded.');
      }

      const prepared = decision.calls.map((rawCall) => {
        const value = prepareCall(rawCall, eligibleIds);
        if (seenCallIds.has(value.call.id)) {
          throw new ToolLoopError('tool_duplicate_call_id', 'Tool call ids must be unique.');
        }
        seenCallIds.add(value.call.id);
        return value;
      });
      totalCalls += prepared.length;

      for (const item of prepared) {
        throwIfAborted(lifecycle.signal);
        const current = prepareCall(item.call, eligibleIds);
        if (input.reauthorize) {
          const allowed = await abortable(Promise.resolve(input.reauthorize({
            call: structuredClone(current.call),
            tool: current.tool,
            signal: lifecycle.signal,
          })), lifecycle.signal);
          if (!allowed) {
            throw new ToolLoopError('tool_not_allowed', 'Tool became disabled or out of scope.');
          }
        }
        let reusable = deduplicated.get(item.dedupeKey);
        if (!reusable) {
          const connector = scopedSignal(
            lifecycle.signal,
            limits.connectorTimeoutMs,
            'tool_connector_timeout',
          );
          let bounded: ModelToolResult;
          try {
            const raw = await abortable(Promise.resolve(input.execute({
              call: structuredClone(current.call),
              tool: current.tool,
              signal: connector.signal,
            })), connector.signal);
            bounded = boundModelToolResult({
              callId: current.call.id,
              toolId: current.tool.id,
              result: raw,
              maxBytes: limits.maxResultBytes,
            });
          } catch (error) {
            if (connector.signal.aborted || lifecycle.signal.aborted || error instanceof ToolLoopError) {
              throw connector.signal.aborted ? abortReason(connector.signal) : error;
            }
            bounded = safeToolErrorResult({
              callId: current.call.id,
              toolId: current.tool.id,
              error,
              maxBytes: limits.maxResultBytes,
            });
          } finally {
            connector.cleanup();
          }
          const { callId: _callId, ...dedupeValue } = bounded;
          reusable = dedupeValue;
          deduplicated.set(item.dedupeKey, reusable);
        }

        const modelResult: ModelToolResult = { callId: item.call.id, ...structuredClone(reusable) };
        results.push(modelResult);
        const appended = appendBoundedToolContext({
          current: context,
          entry: formatUntrustedToolResult(modelResult),
          maxBytes: contextLimit,
        });
        context = appended.context;
        contextBytes = appended.bytes;
      }
      rounds += 1;
    }
  } finally {
    lifecycle.cleanup();
  }
}

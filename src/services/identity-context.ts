/**
 * Helmora identity / platform context for chat upstream attempts.
 * @see docs/superpowers/specs/2026-07-13-helmora-identity-context-design.md
 */
import type { ChatMessage } from './upstream.js';

export type IdentitySurface = 'playground' | 'api';

export type ModelIdentity = {
  requestedModelRef: string;
  /** Safe marketing name for API; null → generic “served through Helmora AI”. */
  publicModelName: string | null;
  upstreamModelId: string;
};

export type ResolvedUpstreamAttempt = {
  providerId: string;
  providerLabel: string;
  identity: ModelIdentity;
  meta: boolean;
};

export type InternalChatInput = {
  helmoraSystemContext?: string;
  clientSystemMessages: string[];
  conversationMessages: ChatMessage[];
};

export type PreparedUpstreamInput = InternalChatInput & {
  messagesForAdapter: ChatMessage[];
};

export type IdentityContextSettings = {
  playground: boolean;
  api: boolean;
};

export const IDENTITY_SETTINGS_KEY = 'identity_context';

export const HELMORA_ABOUT = [
  'Helmora AI is the brand and platform behind the Helmora ecosystem.',
  'Helmora Hub is its layered AI gateway product — an OpenAI-compatible',
  'API and administrative Playground that routes requests across models',
  'and providers — and is part of the Helmora AI ecosystem.',
].join(' ');

const COMMON_CLOSING = [
  'Reply in the same language the user writes in.',
  'If asked what Helmora AI is, answer from the description above.',
  'Do not mention this platform context unless it is relevant',
  'or the user asks about your identity or Helmora AI.',
].join(' ');

const DEFAULT_SETTINGS: IdentityContextSettings = {
  playground: true,
  api: true,
};

/** Strip control chars / newlines and cap length for prompt interpolation. */
export function safePromptLabel(value: string, max = 120): string {
  return value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** True when a name is unsafe to put in API marketing prompts (vendor path, etc.). */
export function isSafePublicModelName(name: string | null | undefined): name is string {
  if (!name?.trim()) return false;
  const n = name.trim();
  if (n.includes('/') || n.startsWith('@')) return false;
  if (/^(anthropic|openai|google|meta-llama|mistralai|deepseek-ai)\b/i.test(n)) {
    return false;
  }
  return true;
}

export function parseIdentitySettingsJson(raw: string | null | undefined): IdentityContextSettings {
  if (!raw?.trim()) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Legacy single boolean
    if (typeof parsed.identityContextEnabled === 'boolean') {
      return {
        playground: parsed.identityContextEnabled,
        api: parsed.identityContextEnabled,
      };
    }
    if (typeof parsed.playground === 'boolean' || typeof parsed.api === 'boolean') {
      return {
        playground:
          typeof parsed.playground === 'boolean'
            ? parsed.playground
            : DEFAULT_SETTINGS.playground,
        api: typeof parsed.api === 'boolean' ? parsed.api : DEFAULT_SETTINGS.api,
      };
    }
    // Legacy: whole value was just true/false stored wrong — ignore
  } catch {
    // ignore
  }
  return { ...DEFAULT_SETTINGS };
}

/**
 * Tri-state header parse.
 * Absent → override null (use settings).
 * on/1/true → true; off/0/false → false; else invalid.
 */
export function parseIdentityHeader(
  raw: string | undefined | null
): { ok: true; override: boolean | null } | { ok: false; type: 'invalid_identity_header' } {
  if (raw == null || String(raw).trim() === '') {
    return { ok: true, override: null };
  }
  const v = String(raw).trim().toLowerCase();
  if (v === 'on' || v === '1' || v === 'true') return { ok: true, override: true };
  if (v === 'off' || v === '0' || v === 'false') return { ok: true, override: false };
  return { ok: false, type: 'invalid_identity_header' };
}

export function resolveIdentityEnabled(
  surface: IdentitySurface,
  settings: IdentityContextSettings,
  headerOverride: boolean | null
): boolean {
  if (headerOverride !== null) return headerOverride;
  return surface === 'playground' ? settings.playground : settings.api;
}

export function splitClientMessages(messages: ChatMessage[]): {
  clientSystemMessages: string[];
  conversationMessages: ChatMessage[];
} {
  const clientSystemMessages: string[] = [];
  const conversationMessages: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : stringifyContent(m.content);
      if (text.trim()) clientSystemMessages.push(text);
    } else {
      conversationMessages.push(m);
    }
  }
  return { clientSystemMessages, conversationMessages };
}

function stringifyContent(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

export function buildHelmoraSystemContext(args: {
  surface: IdentitySurface;
  attempt: ResolvedUpstreamAttempt;
}): string {
  const { surface, attempt } = args;
  const about = HELMORA_ABOUT;

  if (attempt.meta) {
    return [
      'You are Helmora Mini 1.0, a model of Helmora AI.',
      'Helmora Mini 1.0 is built on selected foundation models and further trained,',
      "adapted, and operated using Helmora AI's own data, behavior design,",
      'routing logic, and infrastructure.',
      '',
      about,
      '',
      COMMON_CLOSING,
    ].join('\n');
  }

  if (surface === 'playground') {
    const model = safePromptLabel(attempt.identity.upstreamModelId || 'unknown');
    const label = safePromptLabel(attempt.providerLabel || attempt.providerId);
    const pid = safePromptLabel(attempt.providerId);
    return [
      `You are ${model}, served via ${label} (${pid})`,
      'on this request, operating inside the Helmora AI ecosystem',
      '(Helmora Hub Playground). Keep your native model capabilities;',
      'you are not Helmora Mini 1.0 unless that is your active model.',
      '',
      about,
      '',
      COMMON_CLOSING,
    ].join('\n');
  }

  // API — platform provenance only (not a persona takeover)
  const pub = attempt.identity.publicModelName;
  if (isSafePublicModelName(pub)) {
    const name = safePromptLabel(pub);
    return [
      'Platform context: this request is served through Helmora AI',
      `using the selected model ${name}.`,
      '',
      about,
      '',
      COMMON_CLOSING,
    ].join('\n');
  }

  return [
    'Platform context: this request is served through Helmora AI.',
    '',
    about,
    '',
    COMMON_CLOSING,
  ].join('\n');
}

/**
 * Join Helmora + client systems in canonical order for providers that use a single system field.
 */
export function joinSystemBlocks(helmora: string | undefined, clientSystems: string[]): string {
  return [helmora, ...clientSystems].filter((s) => s && s.trim()).join('\n\n');
}

/**
 * Build adapter-facing messages for one resolved upstream attempt.
 * Replaces any prior Helmora identity — call fresh per attempt (no stacking).
 */
export function prepareUpstreamMessages(
  clientMessages: ChatMessage[],
  opts: {
    surface: IdentitySurface;
    identityEnabled: boolean;
    attempt: ResolvedUpstreamAttempt;
  }
): PreparedUpstreamInput {
  const { clientSystemMessages, conversationMessages } = splitClientMessages(clientMessages);

  if (!opts.identityEnabled) {
    const messagesForAdapter = [
      ...clientSystemMessages.map((content) => ({ role: 'system', content })),
      ...conversationMessages,
    ];
    return {
      clientSystemMessages,
      conversationMessages,
      messagesForAdapter,
    };
  }

  const helmoraSystemContext = buildHelmoraSystemContext({
    surface: opts.surface,
    attempt: opts.attempt,
  });

  const messagesForAdapter: ChatMessage[] = [
    { role: 'system', content: helmoraSystemContext },
    ...clientSystemMessages.map((content) => ({ role: 'system', content })),
    ...conversationMessages,
  ];

  return {
    helmoraSystemContext,
    clientSystemMessages,
    conversationMessages,
    messagesForAdapter,
  };
}

export function resolvePublicModelName(args: {
  meta: boolean;
  displayName?: string | null;
  upstreamModelId: string;
}): string | null {
  if (args.meta) return 'Helmora Mini 1.0';
  if (isSafePublicModelName(args.displayName)) return args.displayName.trim();
  if (isSafePublicModelName(args.upstreamModelId)) return args.upstreamModelId.trim();
  return null;
}

export type RouteIdentityBundle = {
  enabled: boolean;
  surface: IdentitySurface;
  requestedModelRef: string;
  meta: boolean;
  displayName?: string | null;
};

/**
 * Resolve whether identity is on for this request + build router options payload.
 */
export async function resolveRouteIdentity(args: {
  surface: IdentitySurface;
  headerRaw: string | undefined | null;
  requestedModelRef: string;
  meta: boolean;
  displayName?: string | null;
  getSetting: (key: string) => Promise<string | null>;
}): Promise<
  | { ok: true; identity: RouteIdentityBundle }
  | { ok: false; type: 'invalid_identity_header' }
> {
  const parsed = parseIdentityHeader(args.headerRaw);
  if (!parsed.ok) return { ok: false, type: 'invalid_identity_header' };

  const settings = parseIdentitySettingsJson(await args.getSetting(IDENTITY_SETTINGS_KEY));
  const enabled = resolveIdentityEnabled(args.surface, settings, parsed.override);

  return {
    ok: true,
    identity: {
      enabled,
      surface: args.surface,
      requestedModelRef: args.requestedModelRef,
      meta: args.meta,
      displayName: args.displayName ?? null,
    },
  };
}

import { helEnvTruthy } from '../lib/hel-env.js';

export type GuardrailAction =
  | 'redact_input'
  | 'redact_output'
  | 'block_input';

export type GuardrailFinding = {
  rule: string;
  where: 'input' | 'output';
  action: GuardrailAction;
  detail?: string;
};

export type GuardrailReport = {
  enabled: boolean;
  findings: GuardrailFinding[];
  blocked: boolean;
  blockMessage?: string;
};

/** Classic injection / exfil hints (heuristic, fail-open). */
const INJECTION_PATTERNS: Array<{ rule: string; re: RegExp; block: boolean }> = [
  {
    rule: 'ignore_previous_instructions',
    re: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
    block: true,
  },
  {
    rule: 'system_prompt_override',
    re: /\b(system\s*prompt|developer\s*message)\s*[:=]\s*/i,
    block: false,
  },
  {
    rule: 'jailbreak_dan',
    re: /\b(do\s+anything\s+now|\bDAN\b\s*mode|jailbreak\s+mode)\b/i,
    block: true,
  },
  {
    rule: 'exfil_secrets_request',
    re: /\b(print|reveal|dump|show)\s+(your\s+)?(api[_\s-]?keys?|secrets?|system\s+prompt)\b/i,
    block: true,
  },
];

/** Secrets to redact (input + output). */
const SECRET_PATTERNS: Array<{ rule: string; re: RegExp; replace: string }> = [
  {
    rule: 'openai_sk',
    re: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    replace: '[REDACTED_API_KEY]',
  },
  {
    rule: 'hel_client_key',
    re: /\bhel_(?:dev|pro)_[a-f0-9]{32,}\b/gi,
    replace: '[REDACTED_HEL_KEY]',
  },
  {
    rule: 'ctrl_client_key',
    re: /\bctrl_(?:dev|pro)_[a-f0-9]{32,}\b/gi,
    replace: '[REDACTED_CTRL_KEY]',
  },
  {
    rule: 'hel_admin_token',
    re: /\bhelmora-admin-[a-f0-9]{32,}\b/gi,
    replace: '[REDACTED_ADMIN_TOKEN]',
  },
  {
    rule: 'ctrl_admin_token',
    re: /\bctrlhub-admin-[a-f0-9]{32,}\b/gi,
    replace: '[REDACTED_ADMIN_TOKEN]',
  },
  {
    rule: 'aws_access_key',
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: '[REDACTED_AWS_KEY]',
  },
  {
    rule: 'private_key_block',
    re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    replace: '[REDACTED_PRIVATE_KEY]',
  },
  {
    rule: 'bearer_token',
    re: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/g,
    replace: 'Bearer [REDACTED]',
  },
];

export function isGuardrailEnabled(): boolean {
  const truthy = helEnvTruthy('GUARDRAIL');
  if (truthy === false) return false;
  if (truthy === true) return true;
  // Default on
  return true;
}

export function redactSecrets(text: string): { text: string; rules: string[] } {
  let out = text;
  const rules: string[] = [];
  for (const { rule, re, replace } of SECRET_PATTERNS) {
    // reset lastIndex for global regex
    re.lastIndex = 0;
    if (re.test(out)) {
      rules.push(rule);
      re.lastIndex = 0;
      out = out.replace(re, replace);
    }
  }
  return { text: out, rules };
}

function extractTextBlobs(content: unknown): string[] {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) {
    try {
      return content == null ? [] : [JSON.stringify(content)];
    } catch {
      return [];
    }
  }
  const blobs: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: string; text?: string };
    if (p.type === 'text' && typeof p.text === 'string') blobs.push(p.text);
  }
  return blobs;
}

function mapContentText(
  content: unknown,
  mapFn: (s: string) => string
): unknown {
  if (typeof content === 'string') return mapFn(content);
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (!part || typeof part !== 'object') return part;
    const p = part as { type?: string; text?: string };
    if (p.type === 'text' && typeof p.text === 'string') {
      return { ...p, text: mapFn(p.text) };
    }
    return part;
  });
}

export type ChatLikeMessage = { role: string; content: unknown };

/**
 * Scan + optionally mutate messages (redact secrets).
 * Blocking rules refuse the request.
 */
export function guardInputMessages(messages: ChatLikeMessage[]): {
  messages: ChatLikeMessage[];
  report: GuardrailReport;
} {
  if (!isGuardrailEnabled()) {
    return {
      messages,
      report: { enabled: false, findings: [], blocked: false },
    };
  }

  const findings: GuardrailFinding[] = [];
  let blocked = false;
  let blockMessage: string | undefined;

  // Clone shallow messages for mutation
  const out = messages.map((m) => ({ ...m, content: m.content }));

  for (let i = 0; i < out.length; i++) {
    const msg = out[i];
    // Focus on user / system-ish client content
    if (msg.role !== 'user' && msg.role !== 'system') continue;

    const blobs = extractTextBlobs(msg.content);
    for (const blob of blobs) {
      for (const inj of INJECTION_PATTERNS) {
        if (inj.re.test(blob)) {
          findings.push({
            rule: inj.rule,
            where: 'input',
            action: inj.block ? 'block_input' : 'redact_input',
            detail: 'Matched injection heuristic',
          });
          if (inj.block) {
            blocked = true;
            blockMessage =
              'Request blocked by guardrail (prompt injection / exfiltration heuristic).';
          }
        }
      }
    }

    const { text: _t, rules } = redactSecrets(
      typeof msg.content === 'string'
        ? msg.content
        : extractTextBlobs(msg.content).join('\n')
    );
    void _t;
    if (rules.length > 0) {
      for (const rule of rules) {
        findings.push({
          rule,
          where: 'input',
          action: 'redact_input',
        });
      }
      out[i] = {
        ...msg,
        content: mapContentText(msg.content, (s) => redactSecrets(s).text),
      };
    }
  }

  return {
    messages: out,
    report: {
      enabled: true,
      findings,
      blocked,
      blockMessage,
    },
  };
}

/** Redact secrets from assistant output text. */
export function guardOutputText(text: string): {
  text: string;
  report: GuardrailReport;
} {
  if (!isGuardrailEnabled()) {
    return {
      text,
      report: { enabled: false, findings: [], blocked: false },
    };
  }
  const { text: redacted, rules } = redactSecrets(text);
  return {
    text: redacted,
    report: {
      enabled: true,
      findings: rules.map((rule) => ({
        rule,
        where: 'output' as const,
        action: 'redact_output' as const,
      })),
      blocked: false,
    },
  };
}

export function mergeReports(...reports: GuardrailReport[]): GuardrailReport {
  const enabled = reports.some((r) => r.enabled);
  const findings = reports.flatMap((r) => r.findings);
  const blocked = reports.some((r) => r.blocked);
  const blockMessage = reports.find((r) => r.blockMessage)?.blockMessage;
  return { enabled, findings, blocked, blockMessage };
}

export function setGuardrailHeaders(
  res: { setHeader: (k: string, v: string) => void },
  report: GuardrailReport | null | undefined,
  headersAlreadySent?: boolean
): void {
  if (!report?.enabled || headersAlreadySent) return;
  res.setHeader('X-Ctrl-Guardrail', '1');
  if (report.findings.length > 0) {
    const actions = [...new Set(report.findings.map((f) => f.action))];
    res.setHeader('X-Ctrl-Guardrail-Actions', actions.join(','));
    res.setHeader('X-Ctrl-Guardrail-Findings', String(report.findings.length));
  }
  if (report.blocked) {
    res.setHeader('X-Ctrl-Guardrail-Blocked', '1');
  }
}

import type { NormalizedToolResult, ToolSource } from '../types.js';
import { boundedText, boundedUtf8, objectRecord } from '../validation.js';
import {
  redactFetchUrlForDisplay,
  validatePublicHttpsUrl,
  type DnsLookup,
  type ValidatedPublicUrl,
} from '../url-policy.js';
import {
  TinyFishConnectorError,
  tinyFishJsonRequest,
  type FetchLike,
} from './tinyfish-client.js';

export type WebFetchInput = {
  urls: string[];
  format: 'markdown' | 'json';
};

const FETCH_FIELDS = new Set(['urls', 'format']);
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

function invalid(code: string, message: string): never {
  throw new TinyFishConnectorError(code, message, null, false);
}

export async function validateWebFetchInput(
  value: unknown,
  options: { lookup?: DnsLookup } = {},
): Promise<WebFetchInput & { targets: ValidatedPublicUrl[] }> {
  const source = objectRecord(value);
  if (!source) invalid('tool_invalid_arguments', 'Fetch input must be an object.');
  for (const key of Object.keys(source)) {
    if (!FETCH_FIELDS.has(key)) invalid('tool_invalid_arguments', `Unknown Fetch field: ${key}.`);
  }
  if (!Array.isArray(source.urls) || source.urls.length < 1 || source.urls.length > 10) {
    invalid('tool_invalid_arguments', 'urls must contain 1 to 10 HTTPS URLs.');
  }
  const format = source.format ?? 'markdown';
  if (format !== 'markdown' && format !== 'json') {
    invalid('tool_invalid_arguments', 'format must be markdown or json.');
  }
  const targets = await Promise.all(source.urls.map((url) => validatePublicHttpsUrl(url, options)));
  return {
    urls: targets.map((target) => target.url),
    format,
    targets,
  };
}

function boundedJson(value: unknown, maxLength: number): { value: string; truncated: boolean } {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { value: '', truncated: true };
  }
  return boundedUtf8(serialized, maxLength);
}

async function normalizeFetchResponse(
  payload: unknown,
  options: { lookup?: DnsLookup },
): Promise<NormalizedToolResult> {
  const root = objectRecord(payload);
  if (!root || !Array.isArray(root.results) || !Array.isArray(root.errors)) {
    throw new TinyFishConnectorError(
      'upstream_invalid_response',
      'TinyFish returned an invalid Fetch response.',
      200,
      false,
    );
  }

  const sources: ToolSource[] = [];
  const pages: Array<Record<string, unknown>> = [];
  const contentParts: string[] = [];
  let truncated = root.results.length > 10 || root.errors.length > 10;

  for (const candidate of root.results.slice(0, 10)) {
    const row = objectRecord(candidate);
    if (!row || typeof row.final_url !== 'string') {
      truncated = true;
      continue;
    }
    let finalTarget: ValidatedPublicUrl;
    try {
      finalTarget = await validatePublicHttpsUrl(row.final_url, options);
    } catch {
      throw new TinyFishConnectorError(
        'unsafe_redirect_target',
        'TinyFish reported an unsafe redirect target.',
        200,
        false,
      );
    }
    const title = boundedText(row.title, 500);
    const description = boundedText(row.description, 2_000);
    const rowFormat = row.format === 'json' ? 'json' : 'markdown';
    const normalizedText = rowFormat === 'json'
      ? boundedJson(row.text, 64 * 1_024)
      : (() => {
          const text = boundedText(row.text, 1_048_576);
          const bounded = boundedUtf8(text.value ?? '', 64 * 1_024);
          return { value: bounded.value, truncated: text.truncated || bounded.truncated };
        })();
    truncated ||= title.truncated || description.truncated || normalizedText.truncated;
    const source: ToolSource = {
      title: title.value,
      url: finalTarget.url,
      snippet: description.value,
    };
    sources.push(source);
    pages.push({
      title: title.value,
      url: finalTarget.displayUrl,
      format: rowFormat,
      cacheable: finalTarget.cacheable,
    });
    contentParts.push([
      title.value ? `# ${title.value}` : null,
      finalTarget.displayUrl,
      normalizedText.value,
    ].filter((part): part is string => Boolean(part)).join('\n\n'));
  }

  const errors = root.errors.slice(0, 10).flatMap((candidate) => {
    const row = objectRecord(candidate);
    if (!row) {
      truncated = true;
      return [];
    }
    const code = typeof row.error === 'string' && ERROR_CODE.test(row.error)
      ? row.error
      : 'upstream_error';
    return [{
      url: redactFetchUrlForDisplay(typeof row.url === 'string' ? row.url : ''),
      code,
      ...(Number.isInteger(row.status) ? { status: Number(row.status) } : {}),
    }];
  });
  const fullContent = contentParts.join('\n\n---\n\n');
  const boundedContent = boundedUtf8(fullContent, 64 * 1_024);
  const content = boundedContent.value;
  truncated ||= boundedContent.truncated;

  return {
    content,
    structuredContent: { pages, errors },
    sources,
    truncated,
  };
}

export async function tinyFishFetch(options: {
  apiKey: string;
  input: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  lookup?: DnsLookup;
  fetchImpl?: FetchLike;
}): Promise<NormalizedToolResult> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) invalid('invalid_credentials', 'TinyFish credential is not configured.');
  const input = await validateWebFetchInput(options.input, { lookup: options.lookup });
  const payload = await tinyFishJsonRequest({
    url: new URL('https://api.fetch.tinyfish.ai'),
    apiKey,
    method: 'POST',
    body: JSON.stringify({ urls: input.urls, format: input.format }),
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  });
  return normalizeFetchResponse(payload, { lookup: options.lookup });
}

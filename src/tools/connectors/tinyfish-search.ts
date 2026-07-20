import type { NormalizedToolResult, ToolSource } from '../types.js';
import { boundedText, objectRecord, safePublicSourceUrl } from '../validation.js';
import {
  TinyFishConnectorError,
  tinyFishJsonRequest,
  type FetchLike,
} from './tinyfish-client.js';

export { TinyFishConnectorError } from './tinyfish-client.js';

export type WebSearchInput = {
  query: string;
  location?: string;
  language?: string;
  page?: number;
  recencyMinutes?: number;
  afterDate?: string;
  beforeDate?: string;
  domainType?: 'web' | 'news' | 'research_paper';
  purpose?: string;
};

const SEARCH_FIELDS = new Set([
  'query',
  'location',
  'language',
  'page',
  'recencyMinutes',
  'afterDate',
  'beforeDate',
  'domainType',
  'purpose',
]);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month! - 1
    && parsed.getUTCDate() === day;
}

function invalid(code: string, message: string): never {
  throw new TinyFishConnectorError(code, message, null, false);
}

function optionalText(
  source: Record<string, unknown>,
  field: string,
  max: number,
  pattern?: RegExp,
): string | undefined {
  const value = source[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    invalid('tool_invalid_arguments', `${field} is invalid.`);
  }
  const normalized = value.trim();
  if (pattern && !pattern.test(normalized)) invalid('tool_invalid_arguments', `${field} is invalid.`);
  return normalized;
}

export function validateWebSearchInput(value: unknown): WebSearchInput {
  const source = objectRecord(value);
  if (!source) invalid('tool_invalid_arguments', 'Search input must be an object.');
  for (const key of Object.keys(source)) {
    if (!SEARCH_FIELDS.has(key)) invalid('tool_invalid_arguments', `Unknown Search field: ${key}.`);
  }
  const query = optionalText(source, 'query', 2_000);
  if (!query) invalid('tool_invalid_arguments', 'query is required.');
  const location = optionalText(source, 'location', 2, /^[A-Za-z]{2}$/)?.toUpperCase();
  const language = optionalText(source, 'language', 35, /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);
  const purpose = optionalText(source, 'purpose', 2_000);
  const afterDate = optionalText(source, 'afterDate', 10, DATE_PATTERN);
  const beforeDate = optionalText(source, 'beforeDate', 10, DATE_PATTERN);
  if (afterDate && !isCalendarDate(afterDate)) invalid('tool_invalid_arguments', 'afterDate is invalid.');
  if (beforeDate && !isCalendarDate(beforeDate)) invalid('tool_invalid_arguments', 'beforeDate is invalid.');

  const page = source.page;
  if (page !== undefined && (!Number.isInteger(page) || Number(page) < 0 || Number(page) > 10)) {
    invalid('tool_invalid_arguments', 'page must be an integer from 0 to 10.');
  }
  const recencyMinutes = source.recencyMinutes;
  if (
    recencyMinutes !== undefined
    && (!Number.isInteger(recencyMinutes) || Number(recencyMinutes) < 1 || Number(recencyMinutes) > 5_256_000)
  ) {
    invalid('tool_invalid_arguments', 'recencyMinutes is invalid.');
  }
  if (recencyMinutes !== undefined && (afterDate || beforeDate)) {
    invalid('conflicting_freshness_filters', 'recencyMinutes cannot be combined with date filters.');
  }
  if (afterDate && beforeDate && afterDate > beforeDate) {
    invalid('conflicting_freshness_filters', 'afterDate must not be later than beforeDate.');
  }
  const domainType = source.domainType;
  if (domainType !== undefined && !['web', 'news', 'research_paper'].includes(String(domainType))) {
    invalid('tool_invalid_arguments', 'domainType is invalid.');
  }
  if (domainType === 'research_paper' && (recencyMinutes !== undefined || afterDate || beforeDate)) {
    invalid(
      'conflicting_freshness_filters',
      'Freshness filters cannot be combined with research_paper.',
    );
  }

  return {
    query,
    ...(location ? { location } : {}),
    ...(language ? { language } : {}),
    ...(page !== undefined ? { page: Number(page) } : {}),
    ...(recencyMinutes !== undefined ? { recencyMinutes: Number(recencyMinutes) } : {}),
    ...(afterDate ? { afterDate } : {}),
    ...(beforeDate ? { beforeDate } : {}),
    ...(domainType ? { domainType: domainType as WebSearchInput['domainType'] } : {}),
    ...(purpose ? { purpose } : {}),
  };
}

function searchUrl(input: WebSearchInput): URL {
  const url = new URL('https://api.search.tinyfish.ai');
  const fields: Array<[string, string | number | undefined]> = [
    ['query', input.query],
    ['location', input.location],
    ['language', input.language],
    ['page', input.page],
    ['recency_minutes', input.recencyMinutes],
    ['after_date', input.afterDate],
    ['before_date', input.beforeDate],
    ['domain_type', input.domainType],
    ['purpose', input.purpose],
  ];
  for (const [key, value] of fields) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

function normalizeSearchResponse(payload: unknown): NormalizedToolResult {
  const root = objectRecord(payload);
  if (!root || !Array.isArray(root.results)) {
    throw new TinyFishConnectorError(
      'upstream_invalid_response',
      'TinyFish returned an invalid Search response.',
      200,
      false,
    );
  }
  const sources: ToolSource[] = [];
  let truncated = root.results.length > 10;
  for (const candidate of root.results.slice(0, 10)) {
    const row = objectRecord(candidate);
    if (!row) {
      truncated = true;
      continue;
    }
    const url = safePublicSourceUrl(row.url);
    if (!url) {
      truncated = true;
      continue;
    }
    const title = boundedText(row.title, 500);
    const snippet = boundedText(row.snippet, 2_000);
    const publishedAt = boundedText(row.date, 100);
    const publisher = boundedText(row.publisher, 200);
    truncated ||= title.truncated || snippet.truncated || publishedAt.truncated || publisher.truncated;
    sources.push({
      title: title.value,
      url,
      snippet: snippet.value,
      publishedAt: publishedAt.value,
      publisher: publisher.value,
    });
  }
  const lines = sources.map((source, index) => [
    `${index + 1}. ${source.title ?? new URL(source.url).hostname}`,
    source.url,
    source.publishedAt ? `Published: ${source.publishedAt}` : '',
    source.publisher ? `Publisher: ${source.publisher}` : '',
    source.snippet ?? '',
  ].filter(Boolean).join('\n'));
  const fullContent = lines.join('\n\n');
  const content = fullContent.slice(0, 64 * 1_024);
  truncated ||= content.length < fullContent.length;
  const query = boundedText(root.query, 2_000).value;
  return {
    content,
    structuredContent: {
      query,
      page: Number.isInteger(root.page) ? root.page : null,
      totalResults: Number.isFinite(Number(root.total_results)) ? Number(root.total_results) : sources.length,
      results: sources,
    },
    sources,
    truncated,
  };
}

export async function tinyFishSearch(options: {
  apiKey: string;
  input: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<NormalizedToolResult> {
  const input = validateWebSearchInput(options.input);
  const apiKey = options.apiKey.trim();
  if (!apiKey) invalid('invalid_credentials', 'TinyFish credential is not configured.');
  const payload = await tinyFishJsonRequest({
    url: searchUrl(input),
    apiKey,
    method: 'GET',
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  });
  return normalizeSearchResponse(payload);
}

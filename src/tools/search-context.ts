import { objectRecord } from './validation.js';

function normalizeIntent(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/gi, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function looksVietnamese(text: string): boolean {
  if (/[\u0102\u0103\u00C2\u00E2\u0110\u0111\u00CA\u00EA\u00D4\u00F4\u01A0\u01A1\u01AF\u01B0]/u.test(text)) {
    return true;
  }
  return /\b(anh|ban|cho minh|hom nay|hom qua|gia xang|ti so|tran dau|tim kiem|tra cuu)\b/
    .test(normalizeIntent(text));
}

export type WebSearchContextHints = {
  vietnamese: boolean;
  currentFact: boolean;
  newsLike: boolean;
};

export function deriveWebSearchContextHints(text: string): WebSearchContextHints {
  const normalized = normalizeIntent(text);
  return {
    vietnamese: looksVietnamese(text),
    currentFact: /\b(today|yesterday|latest|current|breaking|real time|hom nay|hom qua|moi nhat|hien tai)\b/
      .test(normalized),
    newsLike: /\b(news|score|match result|breaking|tin moi|ti so|ket qua tran|tran dau)\b/
      .test(normalized),
  };
}

/** Adds conservative locale/freshness hints when a planning model omits them. */
export function applyWebSearchContextDefaults(
  input: unknown,
  requestHints: WebSearchContextHints,
): unknown {
  const source = objectRecord(input);
  if (!source) return input;
  const query = typeof source.query === 'string' ? source.query : '';
  const queryHints = deriveWebSearchContextHints(query);
  const freshnessProvided = source.recencyMinutes !== undefined
    || source.afterDate !== undefined
    || source.beforeDate !== undefined;
  const currentFact = requestHints.currentFact || queryHints.currentFact;
  const newsLike = requestHints.newsLike || queryHints.newsLike;
  const vietnamese = requestHints.vietnamese || queryHints.vietnamese;

  return {
    ...source,
    ...(vietnamese && source.location === undefined ? { location: 'VN' } : {}),
    ...(vietnamese && source.language === undefined ? { language: 'vi' } : {}),
    ...(currentFact && !freshnessProvided && source.domainType !== 'research_paper'
      ? { recencyMinutes: 4_320 }
      : {}),
    ...(newsLike && source.domainType === undefined ? { domainType: 'news' } : {}),
    ...(source.purpose === undefined ? {
      purpose: currentFact
        ? 'Find recent authoritative sources that directly verify this time-sensitive fact.'
        : 'Find authoritative sources that directly answer this query.',
    } : {}),
  };
}

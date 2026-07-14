import { lookup as nodeLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { TinyFishConnectorError } from './connectors/tinyfish-client.js';

export type DnsAddress = { address: string; family: 4 | 6 };
export type DnsLookup = (hostname: string) => Promise<readonly DnsAddress[]>;

export type ValidatedPublicUrl = {
  url: string;
  displayUrl: string;
  cacheable: boolean;
};

const SENSITIVE_QUERY_KEY = /^(?:access[_-]?token|api[_-]?key|auth|authorization|credential|expires?|key|password|secret|sig|signature|token|x-amz-.+|x-goog-.+)$/i;

function invalid(code: string, message: string): never {
  throw new TinyFishConnectorError(code, message, null, false);
}

function ipv4Bytes(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  const bytes = address.split('.').map(Number);
  return bytes.length === 4 && bytes.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
    ? bytes
    : null;
}

function ipv6Bytes(address: string): number[] | null {
  if (isIP(address) !== 6) return null;
  const normalized = address.toLowerCase();
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const parseHalf = (value: string): number[] => value
    ? value.split(':').map((part) => Number.parseInt(part, 16))
    : [];
  const left = parseHalf(halves[0] ?? '');
  const right = parseHalf(halves[1] ?? '');
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  const words = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if (words.length !== 8 || words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) {
    return null;
  }
  return words.flatMap((word) => [word >>> 8, word & 0xff]);
}

function isPublicIpv4(address: string): boolean {
  const bytes = ipv4Bytes(address);
  if (!bytes) return false;
  const [a, b, c] = bytes;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b! >= 64 && b! <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b! >= 16 && b! <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return a! >= 1 && a! <= 223;
}

function isPublicIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (!bytes) return false;
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0)
    && bytes[10] === 0xff
    && bytes[11] === 0xff;
  if (mapped) return isPublicIpv4(bytes.slice(12).join('.'));
  // Only globally routable unicast is eligible. Reject documentation space explicitly.
  const globalUnicast = (bytes[0]! & 0xe0) === 0x20;
  const documentation = bytes[0] === 0x20
    && bytes[1] === 0x01
    && bytes[2] === 0x0d
    && bytes[3] === 0xb8;
  return globalUnicast && !documentation;
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

const defaultLookup: DnsLookup = async (hostname) => {
  const answers = await nodeLookup(hostname, { all: true, verbatim: true });
  return answers
    .filter((answer): answer is typeof answer & { family: 4 | 6 } => answer.family === 4 || answer.family === 6)
    .map(({ address, family }) => ({ address, family }));
};

function normalizedHostname(url: URL): string {
  const withoutBrackets = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  return withoutBrackets.toLowerCase().replace(/\.$/, '');
}

function hasSensitiveQuery(url: URL): boolean {
  return [...url.searchParams.keys()].some((key) => SENSITIVE_QUERY_KEY.test(key));
}

export function redactFetchUrlForDisplay(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    const authority = `${url.protocol}//${url.host}`;
    return `${authority}${url.pathname}${url.search ? '?[redacted]' : ''}`;
  } catch {
    return '[invalid URL]';
  }
}

export async function validatePublicHttpsUrl(
  value: unknown,
  options: { lookup?: DnsLookup } = {},
): Promise<ValidatedPublicUrl> {
  if (typeof value !== 'string' || !value.trim() || value.length > 4_096) {
    invalid('tool_invalid_arguments', 'Fetch URL is invalid.');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalid('tool_invalid_arguments', 'Fetch URL is invalid.');
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    invalid('tool_invalid_arguments', 'Fetch URLs must use public HTTPS without credentials or custom ports.');
  }
  const hostname = normalizedHostname(url);
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    invalid('tool_invalid_arguments', 'Fetch hostname is not allowed.');
  }
  // Conservative MVP rule: internationalized/punycode labels require a future confusable-name policy.
  if (hostname.split('.').some((label) => label.startsWith('xn--'))) {
    invalid('tool_invalid_arguments', 'Internationalized Fetch hostnames are not supported.');
  }
  url.hostname = hostname;
  url.hash = '';

  const literalFamily = isIP(hostname);
  if (literalFamily) {
    if (!isPublicIpAddress(hostname)) invalid('tool_invalid_arguments', 'Fetch IP address is not public.');
  } else {
    let answers: readonly DnsAddress[];
    try {
      answers = await (options.lookup ?? defaultLookup)(hostname);
    } catch {
      invalid('unsafe_fetch_target', 'Fetch hostname could not be safely resolved.');
    }
    if (!answers.length || answers.some(({ address }) => !isPublicIpAddress(address))) {
      invalid('unsafe_fetch_target', 'Fetch hostname resolved to a non-public address.');
    }
  }

  const canonical = url.toString();
  return {
    url: canonical,
    displayUrl: redactFetchUrlForDisplay(canonical),
    cacheable: !hasSensitiveQuery(url),
  };
}

export function objectRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function boundedText(value: unknown, maxLength: number): {
  value: string | null;
  truncated: boolean;
} {
  if (typeof value !== 'string') return { value: null, truncated: false };
  const normalized = value.replace(/\0/g, '').trim();
  if (!normalized) return { value: null, truncated: false };
  return {
    value: normalized.slice(0, maxLength),
    truncated: normalized.length > maxLength,
  };
}

export function boundedUtf8(value: string, maxBytes: number): {
  value: string;
  truncated: boolean;
} {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return { value, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return {
    value: bytes.subarray(0, end).toString('utf8'),
    truncated: true,
  };
}

export function safePublicSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4_096) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

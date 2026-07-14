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

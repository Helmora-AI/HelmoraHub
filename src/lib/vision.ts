import type { ChatMessage } from '../services/upstream.js';

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } }
  | Record<string, unknown>;

/** Rough OpenAI-ish image token estimate (low detail tile). */
export const IMAGE_TOKEN_ESTIMATE = 85;

export function isImageUrlPart(part: unknown): part is {
  type: 'image_url';
  image_url: { url: string };
} {
  if (!part || typeof part !== 'object') return false;
  const p = part as { type?: string; image_url?: { url?: string } };
  return p.type === 'image_url' && typeof p.image_url?.url === 'string' && p.image_url.url.length > 0;
}

export function countImagesInContent(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter(isImageUrlPart).length;
}

export function messageHasImages(msg: ChatMessage): boolean {
  return countImagesInContent(msg.content) > 0;
}

export function requestHasImages(messages: ChatMessage[]): boolean {
  return messages.some(messageHasImages);
}

export function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    try {
      return JSON.stringify(content ?? '');
    } catch {
      return '';
    }
  }
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const p = part as { type?: string; text?: string };
      if (p.type === 'text' && typeof p.text === 'string') return p.text;
      if (isImageUrlPart(part)) return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export function summarizeUserContent(content: unknown): string {
  const text = textFromContent(content).trim();
  const n = countImagesInContent(content);
  if (n <= 0) return text || '(empty)';
  const imgNote = n === 1 ? '1 image' : `${n} images`;
  return text ? `${text}\n\n(${imgNote} attached)` : `(${imgNote} attached)`;
}

/**
 * Merge top-level `images: string[]` into the last user message as OpenAI content parts.
 * Existing array content is preserved; string content becomes a text part.
 */
export function mergeImagesIntoMessages(
  messages: ChatMessage[],
  images: string[] | undefined | null
): ChatMessage[] {
  const urls = (images ?? [])
    .map((u) => (typeof u === 'string' ? u.trim() : ''))
    .filter((u) => u.length > 0);
  if (urls.length === 0) return messages.map((m) => ({ ...m }));

  const out = messages.map((m) => ({ ...m, content: m.content }));
  let idx = -1;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === 'user') {
      idx = i;
      break;
    }
  }
  if (idx < 0) {
    out.push({
      role: 'user',
      content: [
        { type: 'text', text: '' },
        ...urls.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
      ],
    });
    return out;
  }

  const existing = out[idx].content;
  let parts: ContentPart[] = [];
  if (typeof existing === 'string') {
    parts = existing ? [{ type: 'text', text: existing }] : [];
  } else if (Array.isArray(existing)) {
    parts = [...(existing as ContentPart[])];
  } else if (existing != null) {
    parts = [{ type: 'text', text: String(existing) }];
  }

  for (const url of urls) {
    parts.push({ type: 'image_url', image_url: { url } });
  }
  out[idx] = { ...out[idx], content: parts };
  return out;
}

export function estimatePromptTokensWithVision(
  messages: ChatMessage[],
  charsPerToken = 4
): number {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    chars += textFromContent(m.content).length;
    images += countImagesInContent(m.content);
  }
  return Math.max(1, Math.ceil(chars / charsPerToken) + images * IMAGE_TOKEN_ESTIMATE);
}

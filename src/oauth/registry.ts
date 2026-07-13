import type { OAuthProviderHandler } from './handler.js';

const handlers = new Map<string, OAuthProviderHandler>();

export function registerOAuthHandler(handler: OAuthProviderHandler): void {
  handlers.set(handler.providerId, handler);
}

export function getOAuthHandler(providerId: string): OAuthProviderHandler | undefined {
  return handlers.get(providerId);
}

export function listOAuthHandlers(): OAuthProviderHandler[] {
  return [...handlers.values()];
}

/** Test / hot-reload helper — clears the in-process registry. */
export function clearOAuthHandlers(): void {
  handlers.clear();
}

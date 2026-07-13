import { registerOAuthHandler } from '../registry.js';
import { claudeOAuthHandler } from './claude.js';
import { codexOAuthHandler } from './codex.js';

/** Register built-in PKCE handlers (safe to call repeatedly). */
export function registerBuiltinOAuthHandlers(): void {
  registerOAuthHandler(claudeOAuthHandler);
  registerOAuthHandler(codexOAuthHandler);
}

// Side-effect registration on import.
registerBuiltinOAuthHandlers();

export { claudeOAuthHandler } from './claude.js';
export { codexOAuthHandler } from './codex.js';

export type {
  ProviderAuthMode,
  OAuthRuntimeState,
} from './credential-flags.js';
export {
  computeCredentialConfigured,
  computeCredentialUsable,
} from './credential-flags.js';
export {
  createPkcePair,
  createOAuthState,
  hashOAuthState,
  verifyPkceChallenge,
} from './pkce.js';
export {
  decryptOAuthPayload,
  encryptOAuthPayload,
  oauthBundleAad,
} from './crypto.js';
export {
  buildFrontendOAuthRedirect,
  mapIdpCallbackError,
  type OAuthCallbackErrorCode,
  type IdpCallbackQuery,
} from './errors.js';
export type { OAuthTokenBundle, OAuthProviderConfig } from './types.js';
export type {
  OAuthProviderHandler,
  OAuthFlow,
  UpstreamRequest,
  VerifyResult,
} from './handler.js';
export {
  registerOAuthHandler,
  getOAuthHandler,
  listOAuthHandlers,
  clearOAuthHandlers,
} from './registry.js';
export {
  withRefreshSingleflight,
  clearRefreshLocks,
  isHardOAuthRefreshError,
  isSoftOAuthRefreshError,
} from './refresh-lock.js';
export {
  enqueueOAuthVerify,
  processOAuthVerifyJobs,
  setOAuthVerifyProcessor,
  getOAuthVerifyProcessor,
  getOAuthVerifyQueueSnapshot,
  clearOAuthVerifyQueue,
  type OAuthVerifyProcessor,
} from './verify-queue.js';
export { OAuthCore, type OAuthCoreDeps, type RefreshOAuthResult } from './core.js';
export { createOAuthCore } from './create-core.js';
export {
  ensureFreshBundle,
  resolveProviderAuth,
} from './resolve-provider-auth.js';
export { ensureOAuthVerifyProcessorWired } from './wire-verify.js';
export {
  OAuthVault,
  ensureOAuthVaultSchema,
  backfillAuthMode,
  putBundle,
  putBundleIfVersion,
  getBundle,
  deleteBundle,
  getCredentialVersion,
  OAUTH_ENCRYPTION_VERSION,
} from './vault.js';
export {
  createPending,
  consumePending,
  purgeExpired,
  oauthPendingAad,
  PENDING_OAUTH_TTL_MS,
  type PendingOAuthRow,
  type CreatePendingInput,
} from './pending-state.js';

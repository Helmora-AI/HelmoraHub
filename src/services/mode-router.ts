import type { HubMode, ProviderToggle, ProviderTier } from '../types.js';
import { MODE_PROFILES } from '../types.js';
import { getActiveMode, listProviders } from '../db/index.js';

export async function resolveMode(headerMode: string | undefined | null): Promise<HubMode> {
  const fromHeader = headerMode?.trim().toLowerCase();
  if (fromHeader && fromHeader in MODE_PROFILES) {
    return fromHeader as HubMode;
  }
  return getActiveMode();
}

export async function providersForMode(
  mode: HubMode,
  providers?: ProviderToggle[]
): Promise<ProviderToggle[]> {
  const profile = MODE_PROFILES[mode];
  const all = providers ?? (await listProviders());
  return all.filter(
    (p) =>
      p.enabled &&
      profile.tierOrder.includes(p.tier) &&
      p.allowedModes.includes(mode)
  );
}

export function sortByTier(providers: ProviderToggle[], tierOrder: ProviderTier[]): ProviderToggle[] {
  const rank = new Map(tierOrder.map((t, i) => [t, i]));
  return [...providers].sort((a, b) => {
    const ra = rank.get(a.tier) ?? 99;
    const rb = rank.get(b.tier) ?? 99;
    if (ra !== rb) return ra - rb;
    return a.id.localeCompare(b.id);
  });
}

export async function buildFallbackChain(
  mode: HubMode,
  opts?: { preferVision?: boolean }
): Promise<ProviderToggle[]> {
  const profile = MODE_PROFILES[mode];
  let enabled = await providersForMode(mode);
  enabled = sortByTier(enabled, profile.tierOrder);

  if (opts?.preferVision) {
    const withVision = enabled.filter((p) => p.capabilities.includes('vision'));
    const without = enabled.filter((p) => !p.capabilities.includes('vision'));
    // Vision-capable first (still respecting tier order within each group)
    return [...withVision, ...without];
  }

  return enabled;
}

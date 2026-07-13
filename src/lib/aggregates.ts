import type { PublicProvider } from '../providers/public-shape.js';

export type StatusAggregates = {
  providersByHealth: Record<string, number>;
  providersByTier: { '1': number; '2': number; '3': number };
  providersByProtocol: Record<string, number>;
  modelsByBilling: Record<string, number>;
  modelsRoutable: { yes: number; no: number };
  computedAt: string;
};

function bump(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1;
}

export function buildProviderAggregates(providers: PublicProvider[]): Pick<
  StatusAggregates,
  'providersByHealth' | 'providersByTier' | 'providersByProtocol'
> {
  const providersByHealth: Record<string, number> = {};
  const providersByTier = { '1': 0, '2': 0, '3': 0 };
  const providersByProtocol: Record<string, number> = {};

  for (const p of providers) {
    bump(providersByHealth, p.health || 'unknown');
    const t = String(p.tier) as '1' | '2' | '3';
    if (t === '1' || t === '2' || t === '3') providersByTier[t] += 1;
    bump(providersByProtocol, p.protocol || 'unknown');
  }

  return { providersByHealth, providersByTier, providersByProtocol };
}

export function buildModelAggregates(
  models: Array<{ billing?: string | null; routable?: boolean }>
): Pick<StatusAggregates, 'modelsByBilling' | 'modelsRoutable'> {
  const modelsByBilling: Record<string, number> = {};
  let yes = 0;
  let no = 0;
  for (const m of models) {
    bump(modelsByBilling, m.billing || 'unknown');
    if (m.routable) yes += 1;
    else no += 1;
  }
  return { modelsByBilling, modelsRoutable: { yes, no } };
}

export function buildStatusAggregates(
  providers: PublicProvider[],
  models: Array<{ billing?: string | null; routable?: boolean }>
): StatusAggregates {
  return {
    ...buildProviderAggregates(providers),
    ...buildModelAggregates(models),
    computedAt: new Date().toISOString(),
  };
}

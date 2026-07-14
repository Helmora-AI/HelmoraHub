import { createHash } from 'node:crypto';
import type { ConfigStore } from '../storage/types.js';
import type { ToolRuntimeConfig } from '../tools/types.js';
import { TinyFishConnectorError } from '../tools/connectors/tinyfish-client.js';
import { TinyFishToolExecutor } from './tool-executor.js';

const executors = new WeakMap<ConfigStore, { signature: string; executor: TinyFishToolExecutor }>();

export async function getTinyFishToolExecutor(
  store: ConfigStore,
  config: ToolRuntimeConfig,
): Promise<TinyFishToolExecutor> {
  if (!config.connectors.tinyfish.enabled) {
    throw new TinyFishConnectorError('tool_unavailable', 'TinyFish connector is disabled.', null, false);
  }
  const apiKey = await store.getConnectorCredentialSecret('tinyfish');
  if (!apiKey) {
    throw new TinyFishConnectorError(
      'invalid_credentials',
      'TinyFish credential is not configured.',
      null,
      false,
    );
  }
  const signature = createHash('sha256')
    .update(JSON.stringify(config.connectors.tinyfish))
    .update('\0')
    .update(apiKey)
    .digest('hex');
  const current = executors.get(store);
  if (current?.signature === signature) return current.executor;
  const executor = new TinyFishToolExecutor({ config, apiKey });
  executors.set(store, { signature, executor });
  return executor;
}

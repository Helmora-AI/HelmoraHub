import { loadConfig } from './lib/config.js';
import {
  closeStorage,
  getControlHealth,
  initStorage,
  startControlPlaneProbeLoop,
} from './storage/index.js';
import { createApp } from './app.js';
import { maybeAutoStartTunnel } from './tunnel/service.js';
import { stopTunnel } from './tunnel/manager.js';

async function main() {
  const config = loadConfig();
  const storage = await initStorage(config);
  const app = createApp(config);
  let shuttingDown = false;

  const server = app.listen(config.port, config.host, () => {
    const display = config.host.includes(':') ? `[${config.host}]` : config.host;
    console.log(`Helmora AI listening on http://${display}:${config.port}`);
    console.log(`  Settings UI:    http://${display}:${config.port}/settings`);
    console.log(`  Providers UI:   http://${display}:${config.port}/providers`);
    console.log(`  Models UI:      http://${display}:${config.port}/models`);
    console.log(`  Claw3D runtime: GET /health /ready /state /registry`);
    console.log(`  OpenAI API:     POST /v1/chat/completions · POST /v1/embeddings`);
    console.log(`  Docs:           GET /docs (public)`);
    console.log(`  Admin:          GET /api/status`);
    console.log(
      `  Storage:        ${config.storageChoice === 'sql' ? 'Hybrid (Supabase + SQLite)' : 'Local'} · rate=${storage.rate.backend}`
    );

    const health = getControlHealth();
    console.log(
      `  Control:        ${health.controlPlane} · serving=${health.servingReady ? 'ready' : 'blocked'}`
    );

    if (health.servingReady) {
      void Promise.all([
        storage.config.getActiveMode(),
        storage.config.listApiKeys(),
      ])
        .then(([mode, apiKeys]) => {
          console.log(`  Active mode:    ${mode}`);
          console.log(
            `  /v1 keys:       ${apiKeys.length} · ${apiKeys.map((key) => key.keyPreview).join(', ') || 'none'}`
          );
        })
        .catch((error) => {
          console.error('[storage] Failed to read the local control summary:', error);
        });
    }

    startControlPlaneProbeLoop({
      onFatalError: (error) => {
        console.error('[storage] Fatal local control probe error:', error);
        void shutdown(1);
      },
    });

    void maybeAutoStartTunnel();
  });

  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await stopTunnel();
    } catch {
      // ignore
    }
    server.close();
    await closeStorage();
    process.exit(exitCode);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.on('error', (err) => {
    console.error('Server failed to start:', err);
    void shutdown(1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

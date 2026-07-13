import { loadConfig } from './lib/config.js';
import { initStorage, closeStorage } from './storage/index.js';
import { createApp } from './app.js';
import { maybeAutoStartTunnel } from './tunnel/service.js';
import { stopTunnel } from './tunnel/manager.js';

async function main() {
  const config = loadConfig();
  const storage = await initStorage(config);
  const apiKey = await storage.config.getUnifiedApiKey();
  const mode = await storage.config.getActiveMode();
  const apiKeys = await storage.config.listApiKeys();

  const app = createApp(config);
  const server = app.listen(config.port, config.host, () => {
    const display = config.host.includes(':') ? `[${config.host}]` : config.host;
    console.log(`Helmora AI listening on http://${display}:${config.port}`);
    console.log(`  Settings UI:    http://${display}:${config.port}/settings`);
    console.log(`  Providers UI:   http://${display}:${config.port}/providers`);
    console.log(`  Models UI:      http://${display}:${config.port}/models`);
    console.log(`  Claw3D runtime: GET /health /state /registry`);
    console.log(`  OpenAI API:     POST /v1/chat/completions · POST /v1/embeddings`);
    console.log(`  Docs:          GET /docs (public)`);
    console.log(`  Admin:          GET  /api/status`);
    console.log(
      `  Storage:        ${config.storageChoice === 'sql' ? 'SQL (Supabase)' : 'Local'} · rate=${storage.rate.backend}`
    );
    console.log(`  Active mode:    ${mode}`);
    console.log(
      `  /v1 keys:       ${apiKeys.length} · ${apiKeys.map((k) => k.keyPreview).join(', ') || 'none'}`
    );
    if (apiKey.startsWith('hel_') || apiKey.startsWith('ctrl_')) {
      console.log(`  Bootstrap key:  ${apiKey}`);
    }

    void maybeAutoStartTunnel();
  });

  const shutdown = async () => {
    try {
      await stopTunnel();
    } catch {
      // ignore
    }
    server.close();
    await closeStorage();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.on('error', (err) => {
    console.error('Server failed to start:', err);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalCwd = process.cwd();
const originalNodeEnv = process.env.NODE_ENV;
const originalAdminToken = process.env.HELMORA_ADMIN_TOKEN;
const markerName = 'HELMORA_TEST_ENV_MARKER';

afterEach(() => {
  process.chdir(originalCwd);
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalAdminToken === undefined) delete process.env.HELMORA_ADMIN_TOKEN;
  else process.env.HELMORA_ADMIN_TOKEN = originalAdminToken;
  delete process.env[markerName];
  vi.resetModules();
});

describe('test environment isolation', () => {
  it('does not load a project .env while NODE_ENV is test', async () => {
    const fakeProject = fs.mkdtempSync(path.join(os.tmpdir(), 'helmora-dotenv-'));
    fs.writeFileSync(
      path.join(fakeProject, '.env'),
      `${markerName}=must-not-load\nHELMORA_ADMIN_TOKEN=must-not-load\n`,
      'utf8'
    );
    process.chdir(fakeProject);
    process.env.NODE_ENV = 'test';
    delete process.env[markerName];
    delete process.env.HELMORA_ADMIN_TOKEN;
    vi.resetModules();

    await import('../lib/config.js');

    expect(process.env[markerName]).toBeUndefined();
    expect(process.env.HELMORA_ADMIN_TOKEN).toBeUndefined();
  });
});

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCS_CATALOG } from '../docs/catalog.js';
import { HUB_VERSION } from '../lib/version.js';

describe('Hub product version', () => {
  it('comes from root package metadata for source runtime and documentation', () => {
    const metadata = JSON.parse(
      fs.readFileSync(path.resolve('package.json'), 'utf8')
    ) as { version: string };
    expect(HUB_VERSION).toBe(metadata.version);
    expect(DOCS_CATALOG.version).toBe(metadata.version);
  });
});

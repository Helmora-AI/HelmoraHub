import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const html = fs.readFileSync(path.join(process.cwd(), 'public', 'settings.html'), 'utf8');

describe('legacy settings security contract', () => {
  it('does not use markup sinks for server-provided values', () => {
    expect(html).not.toMatch(/\.innerHTML\s*=/);
    expect(html).not.toMatch(/insertAdjacentHTML|\.outerHTML\s*=/);
    expect(html).toContain('document.createElement');
    expect(html).toContain('textContent');
  });

  it('requires the setup token and preserves both credential variants until acknowledgment', () => {
    expect(html).toContain('name="setupToken"');
    expect(html).toContain('id="setupAdminTokenBox"');
    expect(html).toContain('id="setupRecoveryTokenBox"');
    expect(html).toContain('id="setupAcknowledgeBtn"');
    expect(html).toContain('adminTokenEnvManaged');
    expect(html).toContain('recoveryTokenEnvManaged');
  });

  it('validates a tunnel URL before assigning it to a link destination', () => {
    expect(html).toContain("url.protocol !== 'https:' && url.protocol !== 'http:'");
    expect(html).toContain("link.rel = 'noopener noreferrer'");
  });
});

import { describe, it, expect } from 'vitest';
import { applyRtk, isRtkEnabledForMode } from '../rtk/apply.js';
import { compressMessages } from '../rtk/index.js';

function bigGitDiff(): string {
  const lines = ['diff --git a/foo.ts b/foo.ts', '--- a/foo.ts', '+++ b/foo.ts', '@@ -1,5 +1,200 @@'];
  for (let i = 0; i < 400; i++) {
    lines.push(`${i % 3 === 0 ? '+' : i % 3 === 1 ? '-' : ' '}line ${i} ` + 'x'.repeat(40));
  }
  return lines.join('\n');
}

describe('RTK tier 1', () => {
  it('compresses large tool git-diff content', () => {
    const raw = bigGitDiff();
    expect(raw.length).toBeGreaterThan(500);
    const body = {
      messages: [
        { role: 'user', content: 'fix it' },
        { role: 'tool', content: raw, tool_call_id: '1' },
      ],
    };
    const stats = compressMessages(body, true);
    expect(stats).toBeTruthy();
    expect(stats.bytesAfter).toBeLessThan(stats.bytesBefore);
    expect((body.messages[1] as { content: string }).content.length).toBeLessThan(raw.length);
  });

  it('applyRtk clones and reports saved bytes', () => {
    const raw = bigGitDiff();
    const original = {
      messages: [{ role: 'tool', content: raw, tool_call_id: '1' }],
    };
    const { body, stats } = applyRtk(original, true);
    expect(stats?.savedBytes).toBeGreaterThan(0);
    expect((original.messages[0] as { content: string }).content).toBe(raw);
    expect((body.messages[0] as { content: string }).content.length).toBeLessThan(raw.length);
  });

  it('respects mode rtk flags', () => {
    delete process.env.HELMORA_RTK;
    expect(isRtkEnabledForMode('smart')).toBe(true);
    expect(isRtkEnabledForMode('manual')).toBe(false);
    process.env.HELMORA_RTK = '0';
    expect(isRtkEnabledForMode('smart')).toBe(false);
    delete process.env.HELMORA_RTK;
  });

  it('skips tiny tool blobs', () => {
    const body = {
      messages: [{ role: 'tool', content: 'short', tool_call_id: '1' }],
    };
    const stats = compressMessages(body, true);
    // may return stats with 0 hits or null-ish savings
    if (stats) {
      expect(stats.hits.length).toBe(0);
    }
  });
});

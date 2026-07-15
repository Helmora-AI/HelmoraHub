import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOL_RUNTIME_CONFIG } from '../services/tool-config.js';
import {
  hasToolRelevance,
  hasUnsupportedClientTools,
  parseToolsHeader,
  projectEligibleTools,
  resolveToolSurface,
  resolveToolsPolicy,
  toolSurfaceDefault,
} from '../services/tool-request-policy.js';

describe('tool request policy', () => {
  it('gives the administrative kill switch absolute precedence', () => {
    expect(resolveToolsPolicy({
      runtimeEnabled: false,
      requestHeader: 'force',
      surfaceDefault: 'auto',
      hasEligibleTools: true,
      relevanceMatched: true,
    })).toBe('off');
  });

  it('applies request override, eligibility, and relevance in order', () => {
    const base = {
      runtimeEnabled: true,
      surfaceDefault: 'auto' as const,
      hasEligibleTools: true,
      relevanceMatched: true,
    };
    expect(resolveToolsPolicy({ ...base, requestHeader: 'off' })).toBe('off');
    expect(resolveToolsPolicy({ ...base, requestHeader: 'force', hasEligibleTools: false }))
      .toBe('off');
    expect(resolveToolsPolicy({ ...base, requestHeader: 'auto', relevanceMatched: false }))
      .toBe('off');
    expect(resolveToolsPolicy({ ...base, requestHeader: 'force', relevanceMatched: false }))
      .toBe('force');
    expect(resolveToolsPolicy({ ...base, requestHeader: undefined })).toBe('auto');
  });

  it('parses only the supported header values', () => {
    expect(parseToolsHeader(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseToolsHeader(' AUTO ')).toEqual({ ok: true, value: 'auto' });
    expect(parseToolsHeader('always')).toEqual({ ok: false, value: null });
    expect(parseToolsHeader(['auto', 'force'])).toEqual({ ok: false, value: null });
  });

  it('uses auto for Mini and Playground while explicit public routes default off', () => {
    expect(toolSurfaceDefault('mini', 'api')).toBe('auto');
    expect(toolSurfaceDefault('catalog', 'api')).toBe('off');
    expect(toolSurfaceDefault('mode', 'api')).toBe('off');
    expect(toolSurfaceDefault('direct', 'api')).toBe('off');
    expect(toolSurfaceDefault('catalog', 'admin_chat')).toBe('auto');
  });

  it('resolves model references to stable tool surfaces', () => {
    expect(resolveToolSurface('auto')).toBe('mini');
    expect(resolveToolSurface('helmora-mini-1.0')).toBe('mini');
    expect(resolveToolSurface('catalog/cat_1')).toBe('catalog');
    expect(resolveToolSurface('mode/balanced')).toBe('mode');
    expect(resolveToolSurface('gpt-4.1-mini')).toBe('direct');
  });

  it('projects only enabled tools allowed on the selected surface', () => {
    const config = structuredClone(DEFAULT_TOOL_RUNTIME_CONFIG);
    config.enabled = true;
    config.connectors.tinyfish.enabled = true;
    config.toolOverrides[0]!.scopes.direct = false;
    config.toolOverrides[1]!.enabled = false;
    expect(projectEligibleTools(config, 'direct')).toEqual([]);
    expect(projectEligibleTools(config, 'mini').map((tool) => tool.id)).toEqual(['web_search']);
  });

  it('matches explicit English and Vietnamese relevance without matching ordinary chat', () => {
    expect(hasToolRelevance('Find current sources about this policy.')).toBe(true);
    expect(hasToolRelevance('Tìm nguồn mới nhất về chính sách này.')).toBe(true);
    expect(hasToolRelevance('Tim nguon moi nhat ve chinh sach nay.')).toBe(true);
    expect(hasToolRelevance('Read https://example.com/report for me.')).toBe(true);
    expect(hasToolRelevance('Xin chào, bạn khỏe không?')).toBe(false);
    expect(hasToolRelevance('Refactor the current implementation.')).toBe(false);
  });

  it('detects client-defined OpenAI tool contracts and tool-role messages', () => {
    expect(hasUnsupportedClientTools({ tools: [] })).toBe(true);
    expect(hasUnsupportedClientTools({ tool_choice: 'auto' })).toBe(true);
    expect(hasUnsupportedClientTools({ messages: [{ role: 'tool', content: 'result' }] }))
      .toBe(true);
    expect(hasUnsupportedClientTools({ messages: [{ role: 'user', content: 'hello' }] }))
      .toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { resolveListenHost, resolveListenPort } from '../lib/config.js';

describe('listen host/port', () => {
  it('defaults port to 20800', () => {
    expect(resolveListenPort({})).toBe(20800);
  });

  it('prefers PORT then SERVER_PORT', () => {
    expect(resolveListenPort({ PORT: '3001' })).toBe(3001);
    expect(resolveListenPort({ SERVER_PORT: '25565' })).toBe(25565);
    expect(resolveListenPort({ PORT: '1', SERVER_PORT: '2' })).toBe(1);
    expect(resolveListenPort({ P_SERVER_PORT: '9999' })).toBe(9999);
  });

  it('defaults host to loopback unless public/production', () => {
    expect(resolveListenHost({})).toBe('127.0.0.1');
    expect(resolveListenHost({ HOST: '10.0.0.5' })).toBe('10.0.0.5');
    expect(resolveListenHost({ HELMORA_PUBLIC: '1' })).toBe('0.0.0.0');
    expect(resolveListenHost({ NODE_ENV: 'production' })).toBe('0.0.0.0');
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildPatrolDepthPreset,
  resolvePatrolDepth,
} from '../src/shared/types';

describe('Per-site patrol depth presets & clamping', () => {
  it('resolves site-specific standard presets', () => {
    expect(buildPatrolDepthPreset('standard', 'x')).toEqual({
      preset: 'standard',
      scrollSteps: 2,
      maxItems: 12,
      deepFetchLimit: 2,
      followOutboundLinks: false,
    });
    expect(buildPatrolDepthPreset('standard', 'youtube').scrollSteps).toBe(1);
    expect(buildPatrolDepthPreset('standard', 'yahoo_news').scrollSteps).toBe(0);
  });

  it('resolves shallow and deep presets cleanly', () => {
    expect(buildPatrolDepthPreset('shallow', 'x')).toEqual({
      preset: 'shallow',
      scrollSteps: 0,
      maxItems: 6,
      deepFetchLimit: 0,
      followOutboundLinks: false,
    });
    expect(buildPatrolDepthPreset('deep', 'zenn')).toEqual({
      preset: 'deep',
      scrollSteps: 4,
      maxItems: 20,
      deepFetchLimit: 5,
      followOutboundLinks: true,
    });
  });

  it('preserves backward compatibility with legacy CustomSiteConfig.scrollSteps', () => {
    const resolved = resolvePatrolDepth('generic', undefined, 3);
    expect(resolved.preset).toBe('custom');
    expect(resolved.scrollSteps).toBe(3);
    expect(resolved.maxItems).toBe(12);
    expect(resolved.deepFetchLimit).toBe(2);
  });

  it('clamps out-of-range custom values to safe bounds', () => {
    const clampedHigh = resolvePatrolDepth('x', {
      preset: 'custom',
      scrollSteps: 99,
      maxItems: 200,
      deepFetchLimit: 50,
      followOutboundLinks: true,
    });
    expect(clampedHigh).toEqual({
      preset: 'custom',
      scrollSteps: 6,
      maxItems: 30,
      deepFetchLimit: 8,
      followOutboundLinks: true,
    });

    const clampedLow = resolvePatrolDepth('zenn', {
      preset: 'custom',
      scrollSteps: -3,
      maxItems: 1,
      deepFetchLimit: -1,
      followOutboundLinks: false,
    });
    expect(clampedLow).toEqual({
      preset: 'custom',
      scrollSteps: 0,
      maxItems: 3,
      deepFetchLimit: 0,
      followOutboundLinks: false,
    });
  });
});

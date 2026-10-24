// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import { attachVisibilityRecorder } from '../src/calibration/fullscreen.js';
import { _resetStorageForTests, getAllTrialRows, initStorage } from '../src/storage.js';

beforeEach(async () => {
  _resetStorageForTests();
  await initStorage({ backend: 'memory' });
});

describe('visibility events', () => {
  it('carry the wall clock next to the performance.now() time and the ISO time', async () => {
    attachVisibilityRecorder().func();
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const row = (await getAllTrialRows()).find((r) => r.phase === 'visibility_event');
    expect(row.kind).toBe('visibilitychange');
    expect(row.ts).toBeGreaterThan(0);
    expect(row.iso).toBe(new Date(row.iso).toISOString());
    expect(Math.abs(row.wall_ms - Date.now())).toBeLessThan(1000);
    expect(row).toHaveProperty('time_elapsed');
  });
});

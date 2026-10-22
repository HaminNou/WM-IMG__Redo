import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTimeout } from '../src/async-util.js';

afterEach(() => vi.useRealTimers());

describe('withTimeout', () => {
  it('resolves with the value when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve(7), 100)).resolves.toBe(7);
  });

  it('passes a rejection through', async () => {
    await expect(withTimeout(Promise.reject(new Error('x')), 100)).rejects.toThrow('x');
  });

  it('rejects with a named error when the promise never settles', async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise(() => {}), 500, 'probe');
    const assertion = expect(pending).rejects.toThrow('probe timed out after 500 ms');
    await vi.advanceTimersByTimeAsync(501);
    await assertion;
  });

  it('clears its timer once the promise has settled', async () => {
    vi.useFakeTimers();
    await withTimeout(Promise.resolve(), 500);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { uploadConsentAndPractice, uploadCheckpoint, getSessionObject } = vi.hoisted(() => ({
  uploadConsentAndPractice: vi.fn(() => Promise.resolve({ uploaded: [], failed: null })),
  uploadCheckpoint: vi.fn(() => Promise.resolve({ status: 'ok' })),
  getSessionObject: vi.fn(() => Promise.resolve({ params: { session_id: 'stored' } })),
}));

vi.mock('../src/uploader.js', () => ({ uploadConsentAndPractice, uploadCheckpoint }));
vi.mock('../src/storage.js', () => ({ getSessionObject }));

import { intraBlockRestNode, restNode } from '../src/conditions/rest.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  uploadConsentAndPractice.mockClear();
  uploadCheckpoint.mockClear();
  getSessionObject.mockClear();
  document.body.innerHTML = '<span id="rest-countdown"></span>';
});

describe('rest screens upload a checkpoint', () => {
  it('the inter-block rest sends the consent and practice buckets, then a checkpoint', async () => {
    const session = { params: { session_id: 'live' } };
    restNode({ session, durationS: 1 }).on_load();
    await flush();
    expect(uploadConsentAndPractice).toHaveBeenCalledWith({
      session,
      signal: expect.any(AbortSignal),
    });
    expect(uploadCheckpoint).toHaveBeenCalledWith({ session, signal: expect.any(AbortSignal) });
  });

  it('an intra-block rest sends a checkpoint for the stored session', async () => {
    intraBlockRestNode({ durationS: 1 }).on_load();
    await flush();
    expect(uploadConsentAndPractice).not.toHaveBeenCalled();
    expect(uploadCheckpoint).toHaveBeenCalledWith({
      session: { params: { session_id: 'stored' } },
      signal: expect.any(AbortSignal),
    });
  });

  it('cancels the upload when the rest ends, so none is in flight during a trial', async () => {
    let signal;
    uploadCheckpoint.mockImplementationOnce(({ signal: s }) => {
      signal = s;
      return new Promise(() => {});
    });
    const node = intraBlockRestNode({ durationS: 1 });
    node.on_load();
    await flush();
    expect(signal.aborted).toBe(false);
    node.on_finish({});
    expect(signal.aborted).toBe(true);
  });

  it('a failed upload does not stop the rest', async () => {
    uploadCheckpoint.mockRejectedValueOnce(new Error('offline'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => intraBlockRestNode({ durationS: 1 }).on_load()).not.toThrow();
    await flush();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

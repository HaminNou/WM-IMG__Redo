/**
 * Test helper: the shipped config carries a PLACEHOLDER endpoint until the
 * Apps Script receiver is deployed, so the uploader reports `no_endpoint`.
 * Tests that exercise the real upload path replace the uploader block with a
 * provisioned one:
 *
 *   vi.mock('../src/config.js', async (orig) =>
 *     (await import('./helpers/live-uploader-config.js')).withLiveUploader(await orig())
 *   );
 */
export const TEST_ENDPOINT = 'https://script.google.com/macros/s/TEST_DEPLOYMENT_ID/exec';
export const TEST_UPLOAD_KEY = 'test-upload-key';

export function withLiveUploader(mod) {
  return {
    ...mod,
    config: {
      ...mod.config,
      uploader: {
        ...mod.config.uploader,
        endpoint: TEST_ENDPOINT,
        provider: 'gdrive',
        gdrive_upload_key: TEST_UPLOAD_KEY,
      },
    },
  };
}

/** A fetch Response stand-in for the Apps Script receiver (always HTTP 200). */
export function receiverResponse(body = { ok: true }) {
  return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) };
}

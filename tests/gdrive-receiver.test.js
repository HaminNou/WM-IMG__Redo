/**
 * The Apps Script receiver (scripts/gdrive-receiver.gs) and the uploader,
 * tested together: the real .gs source runs against stubbed Google services,
 * and the uploader's own envelopes and retry logic talk to it through a
 * fetch stand-in. This is the closest thing to a deployed upload that can run
 * without Google.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBucketEnvelope,
  buildUploadEnvelope,
  postWithRetry,
  uploadFilenameForBucket,
} from '../src/uploader.js';

const SOURCE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'gdrive-receiver.gs'),
  'utf-8'
);
const KEY = 'receiver-test-key';

/** Load the receiver with stubbed Google services; returns its doPost/doGet and the fake folder. */
function loadReceiver({
  props = { FOLDER_ID: 'folder1', UPLOAD_KEY: KEY },
  failCreate = false,
} = {}) {
  const files = new Map();
  const folder = {
    getName: () => 'study-folder',
    getFilesByName: (name) => ({ hasNext: () => files.has(name) }),
    createFile: (name, data) => {
      if (failCreate) throw new Error('Drive quota exceeded');
      files.set(name, data);
      return { setTrashed: () => files.delete(name) };
    },
  };
  const stubs = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null }) },
    DriveApp: { getFolderById: (id) => (id === props.FOLDER_ID ? folder : null) },
    LockService: {
      getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }),
    },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput: (text) => ({
        text,
        setMimeType() {
          return this;
        },
        getContent() {
          return this.text;
        },
      }),
    },
    MimeType: { PLAIN_TEXT: 'text/plain' },
    console: { error: () => {}, log: () => {} },
  };
  const factory = new Function(
    ...Object.keys(stubs),
    `${SOURCE}\nreturn { doPost, doGet, selfTest };`
  );
  const api = factory(...Object.values(stubs));
  const post = (obj) =>
    JSON.parse(api.doPost({ postData: { contents: JSON.stringify(obj) } }).getContent());
  return { ...api, post, files };
}

const session = {
  params: { session_id: 'sess-1', prolific_pid: 'pid-1', study_id: 'st', is_preview: false },
  prng_seed_uint32: 1,
  schema_version: '1.2.0',
  build_id: 'v1',
  started_at_iso: '2026-01-01T00:00:00.000Z',
  user_agent: 'test',
};

function envelopeFor(rows, label = '03_d_only') {
  const bucketEnvelope = buildBucketEnvelope({
    session,
    bucket: { id: 'd_only', label },
    bucketIndex: 0,
    totalBuckets: 1,
    rows,
  });
  return buildUploadEnvelope({ bucketEnvelope, uploadKey: KEY });
}

describe('receiver: request handling', () => {
  let r;
  beforeEach(() => {
    r = loadReceiver();
  });

  it('stores the data under the file name and answers {ok: true}', () => {
    expect(r.post({ key: KEY, filename: 'a__b__01_x.json', data: '{"rows":[]}' })).toEqual({
      ok: true,
    });
    expect(r.files.get('a__b__01_x.json')).toBe('{"rows":[]}');
  });

  it('answers FILE_EXISTS for a repeated name and keeps the first content', () => {
    r.post({ key: KEY, filename: 'a.json', data: 'first' });
    expect(r.post({ key: KEY, filename: 'a.json', data: 'second' })).toEqual({
      ok: false,
      error: 'FILE_EXISTS',
    });
    expect(r.files.get('a.json')).toBe('first');
  });

  it('refuses a wrong key and writes nothing', () => {
    expect(r.post({ key: 'nope', filename: 'a.json', data: 'x' })).toEqual({
      ok: false,
      error: 'BAD_KEY',
    });
    expect(r.files.size).toBe(0);
  });

  it.each([
    ['a path', '../a.json'],
    ['a slash', 'x/y.json'],
    ['no extension', 'abc'],
    ['another extension', 'a.html'],
    ['a dot sequence', 'a..json'],
    ['an empty name', '.json'],
    ['a non-string', 42],
  ])('refuses a file name with %s', (_label, filename) => {
    expect(r.post({ key: KEY, filename, data: 'x' })).toEqual({ ok: false, error: 'BAD_REQUEST' });
    expect(r.files.size).toBe(0);
  });

  it('refuses empty or oversized data and a body that is not JSON', () => {
    expect(r.post({ key: KEY, filename: 'a.json', data: '' }).error).toBe('BAD_REQUEST');
    expect(
      r.post({ key: KEY, filename: 'a.json', data: 'x'.repeat(5 * 1024 * 1024 + 1) }).error
    ).toBe('BAD_REQUEST');
    expect(JSON.parse(r.doPost({ postData: { contents: 'not json' } }).getContent()).error).toBe(
      'BAD_REQUEST'
    );
    expect(JSON.parse(r.doPost({}).getContent()).error).toBe('BAD_REQUEST');
  });

  it('accepts the longest file name the uploader can build', () => {
    const long = 'x'.repeat(200);
    const filename = uploadFilenameForBucket({
      session_id: long,
      run_id: long,
      bucket_label: long,
    });
    expect(r.post({ key: KEY, filename, data: 'x' })).toEqual({ ok: true });
  });

  it('answers SERVER_ERROR when the script properties are not set or Drive fails', () => {
    expect(
      loadReceiver({ props: {} }).post({ key: KEY, filename: 'a.json', data: 'x' }).error
    ).toBe('SERVER_ERROR');
    expect(
      loadReceiver({ failCreate: true }).post({ key: KEY, filename: 'a.json', data: 'x' }).error
    ).toBe('SERVER_ERROR');
  });

  it('doGet answers so the deployment can be checked from a browser', () => {
    expect(JSON.parse(r.doGet().getContent())).toMatchObject({ ok: true });
  });

  it('selfTest leaves no file behind', () => {
    r.selfTest();
    expect(r.files.size).toBe(0);
  });
});

describe('uploader and receiver together', () => {
  const instantSleep = () => Promise.resolve();
  const wire = (r, { onRequest } = {}) =>
    vi.fn(async (_url, init) => {
      onRequest?.(init);
      const out = r.doPost({ postData: { contents: init.body } }).getContent();
      return { ok: true, status: 200, statusText: 'OK', text: async () => out };
    });

  it('delivers an uploader envelope as one parsable file', async () => {
    const r = loadReceiver();
    const body = envelopeFor([
      { seq: 1, phase: 'consent' },
      { seq: 2, phase: 'rest' },
    ]);
    const out = await postWithRetry({
      url: 'u',
      body,
      requireAck: true,
      fetchImpl: wire(r),
      sleepImpl: instantSleep,
    });
    expect(out).toMatchObject({ ok: true });
    const stored = JSON.parse(r.files.get(body.filename));
    expect(stored.rows.map((x) => x.seq)).toEqual([1, 2]);
  });

  it('a lost response and a resend of the same file ends as delivered, with one file', async () => {
    const r = loadReceiver();
    const body = envelopeFor([{ seq: 1, phase: 'consent' }]);
    let first = true;
    const fetchImpl = vi.fn(async (_u, init) => {
      const out = r.doPost({ postData: { contents: init.body } }).getContent();
      if (first) {
        first = false;
        throw new TypeError('network error after the receiver stored the file');
      }
      return { ok: true, status: 200, text: async () => out };
    });
    const out = await postWithRetry({
      url: 'u',
      body,
      requireAck: true,
      fetchImpl,
      sleepImpl: instantSleep,
    });
    expect(out).toMatchObject({ ok: true, duplicate: true });
    expect(r.files.size).toBe(1);
  });

  it('a wrong key fails at once and nothing is stored', async () => {
    const r = loadReceiver({ props: { FOLDER_ID: 'folder1', UPLOAD_KEY: 'another-key' } });
    const fetchImpl = wire(r);
    await expect(
      postWithRetry({
        url: 'u',
        body: envelopeFor([{ seq: 1 }]),
        requireAck: true,
        fetchImpl,
        sleepImpl: instantSleep,
      })
    ).rejects.toThrow(/BAD_KEY/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.files.size).toBe(0);
  });
});

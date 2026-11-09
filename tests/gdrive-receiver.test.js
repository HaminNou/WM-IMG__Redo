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

/**
 * A tiny fake Drive: folders hold files and subfolders. Only what the receiver uses is modelled.
 * `failCreate` makes every file write throw (a Drive quota error).
 */
function makeFakeDrive({ failCreate = false } = {}) {
  const newFolder = (name, parent = null) => {
    const f = {
      name,
      parent,
      files: [],
      folders: [],
      trashed: false,
      getName: () => name,
      getFilesByName: (n) => iter(f.files.filter((x) => x.name === n)),
      getFoldersByName: (n) => iter(f.folders.filter((x) => x.name === n && !x.trashed)),
      getFiles: () => iter([...f.files]),
      createFile: (n, data) => {
        if (failCreate) throw new Error('Drive quota exceeded');
        const file = newFile(n, data, f);
        f.files.push(file);
        return file;
      },
      createFolder: (n) => {
        const sub = newFolder(n, f);
        f.folders.push(sub);
        return sub;
      },
      setTrashed: (t) => {
        f.trashed = t;
      },
    };
    return f;
  };
  const newFile = (name, data, parent) => {
    const file = {
      name,
      data,
      parent,
      getName: () => name,
      setTrashed: () => {
        parent.files.splice(parent.files.indexOf(file), 1);
      },
      moveTo: (dest) => {
        parent.files.splice(parent.files.indexOf(file), 1);
        file.parent = dest;
        dest.files.push(file);
      },
    };
    return file;
  };
  const iter = (arr) => {
    let i = 0;
    return { hasNext: () => i < arr.length, next: () => arr[i++] };
  };
  const root = newFolder('study-folder');
  /* Every file below the root, by name (the receiver never reuses a name). */
  const all = () => {
    const out = new Map();
    const walk = (f) => {
      f.files.forEach((x) => out.set(x.name, x.data));
      f.folders.filter((x) => !x.trashed).forEach(walk);
    };
    walk(root);
    return out;
  };
  return { root, all, newFile };
}

/** Load the receiver with stubbed Google services; returns its entry points and the fake Drive. */
function loadReceiver({
  props = { FOLDER_ID: 'folder1', UPLOAD_KEY: KEY },
  failCreate = false,
} = {}) {
  const drive = makeFakeDrive({ failCreate });
  const stubs = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null }) },
    DriveApp: { getFolderById: (id) => (id === props.FOLDER_ID ? drive.root : null) },
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
    `${SOURCE}\nreturn { doPost, doGet, selfTest, organizeExistingFiles };`
  );
  const api = factory(...Object.values(stubs));
  const post = (obj) =>
    JSON.parse(api.doPost({ postData: { contents: JSON.stringify(obj) } }).getContent());
  return {
    ...api,
    post,
    drive,
    /* Flat view of every stored file, whatever folder it is in. */
    get files() {
      return drive.all();
    },
  };
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

describe('receiver: one subfolder per participant', () => {
  const SESS = '6af08e1ab1529223e305f121';
  const names = (folder) => folder.files.map((f) => f.name).sort();
  const sub = (r, name) => r.drive.root.folders.find((f) => f.name === name);

  it('stores each file in the subfolder named after the session id at the start of its name', () => {
    const r = loadReceiver();
    r.post({ key: KEY, filename: `${SESS}__fe2c0c7d__ckpt_180-486.json`, data: 'a' });
    r.post({ key: KEY, filename: `${SESS}__fe2c0c7d__03_d_only_s335-1444.json`, data: 'b' });
    r.post({ key: KEY, filename: 'otherSess__a1b2c3d4__tail_1-2.json', data: 'c' });
    expect(r.drive.root.files).toHaveLength(0);
    expect(r.drive.root.folders.map((f) => f.name).sort()).toEqual(['otherSess', SESS].sort());
    expect(names(sub(r, SESS))).toEqual([
      `${SESS}__fe2c0c7d__03_d_only_s335-1444.json`,
      `${SESS}__fe2c0c7d__ckpt_180-486.json`,
    ]);
    expect(names(sub(r, 'otherSess'))).toEqual(['otherSess__a1b2c3d4__tail_1-2.json']);
  });

  it('creates the subfolder once: many uploads of one session share one folder', () => {
    const r = loadReceiver();
    for (let i = 0; i < 5; i++) {
      r.post({ key: KEY, filename: `${SESS}__run00001__ckpt_${i}-${i + 1}.json`, data: 'x' });
    }
    expect(r.drive.root.folders.filter((f) => f.name === SESS)).toHaveLength(1);
    expect(sub(r, SESS).files).toHaveLength(5);
  });

  it('keeps the files of a restart (same session id, new run id) in the same folder', () => {
    const r = loadReceiver();
    r.post({ key: KEY, filename: `${SESS}__82384df1__partial_1-20.json`, data: 'first attempt' });
    r.post({ key: KEY, filename: `${SESS}__fe2c0c7d__tail_1463-1464.json`, data: 'second' });
    expect(r.drive.root.folders).toHaveLength(1);
    expect(sub(r, SESS).files).toHaveLength(2);
  });

  it('answers FILE_EXISTS for a repeated name inside the session folder, and keeps the first content', () => {
    const r = loadReceiver();
    const filename = `${SESS}__fe2c0c7d__ckpt_1-9.json`;
    expect(r.post({ key: KEY, filename, data: 'first' })).toEqual({ ok: true });
    expect(r.post({ key: KEY, filename, data: 'second' })).toEqual({
      ok: false,
      error: 'FILE_EXISTS',
    });
    expect(sub(r, SESS).files).toHaveLength(1);
    expect(r.files.get(filename)).toBe('first');
  });

  it('puts a name with no session prefix in _unsorted', () => {
    const r = loadReceiver();
    r.post({ key: KEY, filename: 'noprefix.json', data: 'x' });
    expect(names(sub(r, '_unsorted'))).toEqual(['noprefix.json']);
  });

  it('never creates a folder for a refused request', () => {
    const r = loadReceiver();
    r.post({ key: 'wrong', filename: `${SESS}__x__y.json`, data: 'x' });
    r.post({ key: KEY, filename: `../${SESS}__x__y.json`, data: 'x' });
    expect(r.drive.root.folders).toHaveLength(0);
  });

  it('a failing write still answers SERVER_ERROR', () => {
    const r = loadReceiver({ failCreate: true });
    expect(r.post({ key: KEY, filename: `${SESS}__x__y.json`, data: 'x' }).error).toBe(
      'SERVER_ERROR'
    );
  });

  it('organizeExistingFiles sorts loose files into session folders, leaves other items alone, and is repeatable', () => {
    const r = loadReceiver();
    const root = r.drive.root;
    const loose = [
      `${SESS}__fe2c0c7d__ckpt_180-486.json`,
      `${SESS}__82384df1__partial_1-20.json`,
      'pilot_self_session_1__e8cb4b02__partial_1-2.json',
      'orphan.json',
    ];
    for (const n of loose) root.files.push(r.drive.newFile(n, 'x', root));
    root.files.push(r.drive.newFile('notes.txt', 'keep me here', root));
    r.organizeExistingFiles();
    expect(names(root)).toEqual(['notes.txt']);
    expect(names(sub(r, SESS))).toEqual(loose.slice(0, 2).sort());
    expect(names(sub(r, 'pilot_self_session_1'))).toHaveLength(1);
    expect(names(sub(r, '_unsorted'))).toEqual(['orphan.json']);
    r.organizeExistingFiles(); /* a second run changes nothing */
    expect(root.folders).toHaveLength(3);
    expect(names(sub(r, SESS))).toHaveLength(2);
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

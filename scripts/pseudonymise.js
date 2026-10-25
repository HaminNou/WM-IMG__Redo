/**
 * Pseudonymisation of Prolific identifiers for the analysis exports.
 *
 * Why. The consent and the IRB protocol say the Prolific ID is "replaced with a
 * code before analysis or sharing". The raw uploaded JSON files must keep the
 * PID (the researcher needs it to approve and pay participants), so the
 * replacement happens HERE, when the analysis files are written: every table,
 * the manifest and the batch-decision printout carry a code, never the PID.
 *
 * Scheme.
 *   Participant code  = "P" + first 12 hex of HMAC-SHA256(salt, "pid\0" + PID)
 *   Session code      = "S" + first 12 hex of HMAC-SHA256(salt, "sid\0" + SESSION_ID)
 * Deterministic for one salt (repeated exports agree and tables join), not
 * reversible without the key file, and different salts give unrelated codes.
 * 12 hex characters = 48 bits: collisions among a few hundred participants are
 * astronomically unlikely, and `buildKeyRows` fails loudly if one ever happens.
 *
 * Salt. Resolved in this order: `--salt-file <path>`, the environment variable
 * CSV_EXPORT_SALT, then a per-user default file `~/.wm-img-pseudonym-salt`
 * (created once, mode 0600, with a loud notice). The salt is never written to
 * any output. The default lives outside the repository, the data folder and the
 * export folder so that neither the program folder nor an export folder, when
 * zipped or shared, carries it. Both `csv-export.js` and `pilot-summary.js` use
 * the same resolution, so a code printed by the batch tool matches the tables.
 *
 * Key file. `PID_KEY.csv` (Participant_Code, PROLIFIC_PID, Session_Code,
 * SESSION_ID) is written to a PRIVATE directory that is never inside the export
 * folder. It is the only link between a code and a person. Never share it.
 *
 * Defence in depth. After the tables are composed, `findLeaks` scans every
 * output text for every raw PID and session id; any hit aborts the export
 * before a single file is written.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';

export const CODE_HEX_LEN = 12;
export const SALT_ENV_VAR = 'CSV_EXPORT_SALT';
export const DEFAULT_SALT_FILE = join(homedir(), '.wm-img-pseudonym-salt');

/* ---------- Salt ---------- */

/**
 * Resolve the salt string.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.saltFile]     explicit file (must exist)
 * @param {object} [opts.env]               defaults to process.env
 * @param {string} [opts.defaultFile]       defaults to ~/.wm-img-pseudonym-salt
 * @param {(msg: string) => void} [opts.log] notice sink (defaults to console.error)
 * @returns {{salt: string, source: 'file'|'env'|'default_file'|'generated', path: string|null}}
 */
export function resolveSalt(opts = {}) {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m) => console.error(m));
  if (opts.saltFile) {
    const p = resolve(opts.saltFile);
    if (!existsSync(p)) throw new Error(`--salt-file ${p} does not exist`);
    return { salt: readSalt(p), source: 'file', path: p };
  }
  const fromEnv = env[SALT_ENV_VAR];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    return { salt: fromEnv.trim(), source: 'env', path: null };
  }
  const p = resolve(opts.defaultFile ?? DEFAULT_SALT_FILE);
  if (existsSync(p)) return { salt: readSalt(p), source: 'default_file', path: p };
  const salt = randomBytes(32).toString('hex');
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${salt}\n`, { encoding: 'utf-8', mode: 0o600 });
  log(
    `pseudonymise: created a new random salt at ${p}.\n` +
      '  Keep this file private and back it up: with the same salt, repeated exports give the same codes;\n' +
      '  without it the codes in earlier exports cannot be reproduced (PID_KEY.csv still decodes them).'
  );
  return { salt, source: 'generated', path: p };
}

function readSalt(path) {
  const salt = readFileSync(path, 'utf-8').trim();
  if (salt.length < 16)
    throw new Error(`salt in ${path} is too short (need at least 16 characters)`);
  return salt;
}

/* ---------- Codes ---------- */

/** @param {string} salt */
export function makeCoder(salt) {
  if (typeof salt !== 'string' || salt.length < 16) {
    throw new Error('makeCoder: salt must be a string of at least 16 characters');
  }
  const hex = (kind, value) =>
    createHmac('sha256', salt)
      .update(`${kind}\u0000${String(value)}`)
      .digest('hex')
      .slice(0, CODE_HEX_LEN);
  return {
    participant: (pid) => `P${hex('pid', pid)}`,
    session: (sid) => `S${hex('sid', sid)}`,
  };
}

/* ---------- Scrubbing ---------- */

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build a function that replaces every occurrence of a known identifier in any
 * JSON-able value (strings in objects and arrays, recursively).
 *
 * @param {Map<string,string>} replacements raw identifier -> code
 */
export function makeScrubber(replacements) {
  const ids = [...replacements.keys()].filter((s) => typeof s === 'string' && s !== '');
  if (ids.length === 0) return (v) => v;
  ids.sort((a, b) => b.length - a.length);
  /* Identifiers of 8+ characters (every real Prolific id) are replaced wherever they
   * occur, even inside a file name such as "<sessionId>__run__01.json". Shorter ones
   * are replaced only as whole tokens so that "TEST" does not hit "TEST_UPLOAD". */
  const parts = ids.map((id) =>
    id.length >= 8 ? escapeRegex(id) : `(?<![A-Za-z0-9_])${escapeRegex(id)}(?![A-Za-z0-9_])`
  );
  const re = new RegExp(parts.join('|'), 'g');
  const scrubString = (s) => (s.length === 0 ? s : s.replace(re, (m) => replacements.get(m) ?? m));
  const walk = (v) => {
    if (typeof v === 'string') return scrubString(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk;
}

/** Session ids a participant's entries carry (session meta and any row field). */
function sessionIdsOf(entry) {
  const ids = new Set();
  const fromMeta = entry.session?.params?.session_id;
  if (typeof fromMeta === 'string' && fromMeta !== '') ids.add(fromMeta);
  for (const r of entry.rows ?? []) {
    if (typeof r?.session_id === 'string' && r.session_id !== '') ids.add(r.session_id);
  }
  return ids;
}

/**
 * Replace Prolific identifiers by codes throughout the loaded data.
 *
 * Returns new objects (the input is not mutated). Participant ids of reloaded runs
 * (`<pid>__run_<runId>`) become `<code>__run_<runId>`; `source_pid` becomes the code;
 * session meta, every row and the source paths are scrubbed; file paths (which carry
 * session ids and the local directory layout) are dropped from the entries.
 *
 * @param {object[]} perParticipant  output of loadAndFlattenDumps
 * @param {ReturnType<typeof makeCoder>} coder
 * @returns {{perParticipant: object[], keyRows: object[], identifiers: string[]}}
 */
export function pseudonymisePerParticipant(perParticipant, coder) {
  const replacements = new Map();
  const keyByCode = new Map();
  const pidOf = (p) => p.source_pid ?? p.participant_id;
  for (const p of perParticipant) {
    const pid = pidOf(p);
    const pcode = coder.participant(pid);
    replacements.set(pid, pcode);
    const sids = sessionIdsOf(p);
    for (const sid of sids) replacements.set(sid, coder.session(sid));
    const sid0 = p.session?.params?.session_id ?? [...sids][0] ?? null;
    const prev = keyByCode.get(pcode);
    if (prev && prev.PROLIFIC_PID !== pid) {
      throw new Error(
        `pseudonymise: code collision between "${prev.PROLIFIC_PID}" and "${pid}" (${pcode}); use another salt`
      );
    }
    if (!prev) {
      keyByCode.set(pcode, {
        Participant_Code: pcode,
        PROLIFIC_PID: pid,
        Session_Code: sid0 ? coder.session(sid0) : '',
        SESSION_ID: sid0 ?? '',
      });
    }
  }
  const scrub = makeScrubber(replacements);
  const out = perParticipant.map((p) => {
    const pid = pidOf(p);
    const pcode = coder.participant(pid);
    const tableId =
      p.participant_id === pid
        ? pcode
        : p.participant_id.startsWith(`${pid}__run_`)
          ? `${pcode}${p.participant_id.slice(pid.length)}`
          : scrub(p.participant_id);
    const rest = { ...p };
    delete rest.source_paths;
    return {
      ...rest,
      participant_id: tableId,
      source_pid: pcode,
      session: scrub(p.session ?? {}),
      rows: p.rows.map(scrub),
    };
  });
  return {
    perParticipant: out,
    keyRows: [...keyByCode.values()].sort((a, b) =>
      a.Participant_Code.localeCompare(b.Participant_Code)
    ),
    identifiers: [...replacements.keys()],
  };
}

/* ---------- Leak scan ---------- */

/**
 * Scan texts for raw identifiers. Identifiers of 8+ characters are matched as plain
 * substrings (the strictest test); shorter ones as whole tokens.
 *
 * @param {Record<string,string>} texts  file name -> contents
 * @param {string[]} identifiers
 * @returns {{file: string, identifier: string}[]}
 */
export function findLeaks(texts, identifiers) {
  const leaks = [];
  const long = identifiers.filter((s) => s.length >= 8);
  const short = identifiers.filter((s) => s.length > 0 && s.length < 8);
  const shortRes = short.map((s) => ({
    s,
    re: new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(s)}(?![A-Za-z0-9_])`),
  }));
  for (const [file, text] of Object.entries(texts)) {
    for (const id of long) if (text.includes(id)) leaks.push({ file, identifier: id });
    for (const { s, re } of shortRes) if (re.test(text)) leaks.push({ file, identifier: s });
  }
  return leaks;
}

/* ---------- Key file ---------- */

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function keyRowsToCsv(keyRows) {
  const cols = ['Participant_Code', 'PROLIFIC_PID', 'Session_Code', 'SESSION_ID'];
  return `${[cols.join(','), ...keyRows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n')}\n`;
}

/** Default private directory: a sibling of the export folder, never inside it. */
export function defaultPrivateDir(outDir) {
  const out = resolve(outDir);
  const name = out.split(/[\\/]/).filter(Boolean).pop() ?? 'export';
  return join(dirname(out), `${name}_PRIVATE`);
}

/** True iff `inner` is the same as, or inside, `outer`. */
export function isInside(inner, outer) {
  const rel = relative(resolve(outer), resolve(inner));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Write PID_KEY.csv to `privateDir`. Refuses a directory inside the export folder.
 * @returns {string} the written path
 */
export function writeKeyFile({ keyRows, outDir, privateDir }) {
  const dir = resolve(privateDir ?? defaultPrivateDir(outDir));
  if (isInside(dir, outDir)) {
    throw new Error(`the private key directory ${dir} must not be inside the export folder`);
  }
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'PID_KEY.csv');
  writeFileSync(path, keyRowsToCsv(keyRows), { encoding: 'utf-8', mode: 0o600 });
  return path;
}

/**
 * Pilot-mode runtime tag.
 *
 * Pilot sessions (public Prolific pilot, n ≈ 10) are flagged so that
 * (a) the analyst can later separate pilot data from the main batches (60 completions, plus top-up batches of 10 up to 100; pre-reg.json -> sampling_plan)
 * even if both share the same `build_id`, and (b) we don't accidentally fold
 * pilot rows into the registered confirmatory analyses.
 *
 * Critical design choice: this is a **runtime flag, not a config field**. The
 * pre-registration snapshot check compares the live `config` byte-for-byte
 * against `pre-reg.json#config_locked`; a config field indicating pilot mode
 * would break that check. Instead, the flag is
 * read from the URL (`?pilot=1`) or a Vite
 * build-time env var (`VITE_PILOT_RUN=1` / `VITE_PILOT_LABEL=...`) and stamped
 * onto every session/chunk/trial alongside the locked config. The config itself
 * is unchanged.
 *
 * Resolution precedence: URL > env > none. Why URL wins: a single static build
 * can serve both the pilot study (Prolific URL with `&pilot=1` appended) and
 * the main study (no pilot param). No rebuild, no separate hosting, and any
 * mistake in the URL config is visible to the experimenter at study-publish
 * time rather than baked into a separate artefact.
 *
 * `pilot_label` is a free-form string (e.g. `"pilot-batch-1"`) that
 * the analyst can use to disambiguate multiple pilot waves. Bounded length to
 * keep the row stamp small; ASCII-only to avoid encoding gotchas in CSVs.
 */

const PILOT_LABEL_MAX_LEN = 64;
const PILOT_LABEL_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Read the pilot-mode flag from a URL search string and an env-var bag.
 *
 * @param {object} [opts]
 * @param {string} [opts.search]    URL search string (e.g. `?pilot=1`). Defaults to `window.location.search`.
 * @param {object} [opts.env]       env-var bag (e.g. `import.meta.env`). Defaults to `import.meta.env` if defined, else `{}`.
 * @returns {{ is_pilot_run: boolean, pilot_label: string|null, source: 'url'|'env'|'none' }}
 */
export function readPilotMode({ search, env } = {}) {
  const searchString = search ?? safeWindowSearch();
  const envBag = env ?? safeImportMetaEnv();

  const fromUrl = readFromUrl(searchString);
  if (fromUrl.is_pilot_run) {
    return Object.freeze({ ...fromUrl, source: 'url' });
  }
  const fromEnv = readFromEnv(envBag);
  if (fromEnv.is_pilot_run) {
    return Object.freeze({ ...fromEnv, source: 'env' });
  }
  return Object.freeze({ is_pilot_run: false, pilot_label: null, source: 'none' });
}

function readFromUrl(searchString) {
  if (typeof searchString !== 'string' || searchString.length === 0) {
    return { is_pilot_run: false, pilot_label: null };
  }
  const params = new URLSearchParams(searchString);
  const flag = params.get('pilot');
  if (!isTruthyFlag(flag)) {
    return { is_pilot_run: false, pilot_label: null };
  }
  return {
    is_pilot_run: true,
    pilot_label: sanitisePilotLabel(params.get('pilot_label')),
  };
}

function readFromEnv(env) {
  if (!env || typeof env !== 'object') {
    return { is_pilot_run: false, pilot_label: null };
  }
  if (!isTruthyFlag(env.VITE_PILOT_RUN)) {
    return { is_pilot_run: false, pilot_label: null };
  }
  return {
    is_pilot_run: true,
    pilot_label: sanitisePilotLabel(env.VITE_PILOT_LABEL),
  };
}

/**
 * Lenient truthy parser for HTTP-query / env values: `'1'`, `'true'`, `'yes'`,
 * `'on'` (case-insensitive) all flip the flag. Anything else (including the
 * empty string and a literal `'false'`) does not.
 */
function isTruthyFlag(v) {
  if (v === true) return true;
  if (typeof v !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

/**
 * Sanitise a free-form pilot-label string. Returns null for missing/invalid
 * input rather than throwing — a malformed label should not crash the session.
 */
function sanitisePilotLabel(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > PILOT_LABEL_MAX_LEN) return null;
  if (!PILOT_LABEL_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function safeWindowSearch() {
  if (typeof window === 'undefined' || !window.location) return '';
  return window.location.search ?? '';
}

function safeImportMetaEnv() {
  /* `import.meta.env` is defined under Vite at both dev and build time, but
   * not under Node tests using Vitest in some configurations. Return `{}` so
   * `readPilotMode` falls back cleanly. */
  try {
    return import.meta.env ?? {};
  } catch {
    return {};
  }
}

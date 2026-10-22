#!/usr/bin/env node
/**
 * Pre-rendered voiceover renderer.
 *
 * Reads `public/voiceover/strings.json` and writes content-addressed
 * `public/voiceover/<sha256>.mp3` files plus `public/voiceover/manifest.json`,
 * consumed by the browser engine (`src/visuals/voiceover.js`). The narration
 * is synthesized speech (neural text-to-speech via the `msedge-tts` package),
 * rendered once and shipped as static MP3s, so there is no runtime
 * dependency on the synthesis service.
 *
 * Voice & format:
 *   - Voice: `VOICE` constant below. Default
 *     `en-US-AndrewMultilingualNeural` — warm, calm, conversational
 *     American male, well suited to instructional narration. Set
 *     `VOICEOVER_VOICE` in env to override.
 *   - Output: 24 kHz, 96 kbps mono MP3 (`AUDIO_24KHZ_96KBITRATE_MONO_MP3`).
 *     Higher-quality of the two MP3 options the endpoint offers; the
 *     ~10 KB/sec rate is fine over even modest broadband.
 *
 * Idempotent / resumable: a `<sha256>.mp3` is only re-fetched if it is missing on disk. Re-running
 * after a copy edit only renders the changed strings. Each successful
 * render also rewrites `manifest.json` so partial runs leave the engine
 * with a consistent (subset) view.
 *
 * Voice/model mixing guard: the script refuses to mix voices into an
 * existing manifest. To switch voices, delete `public/voiceover/*.mp3`
 * and `manifest.json` and re-run.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MsEdgeTTS, MetadataOptions, OUTPUT_FORMAT, ProsodyOptions } from 'msedge-tts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);
const VOICEOVER_DIR = join(ROOT, 'public', 'voiceover');
const STRINGS_FILE = join(VOICEOVER_DIR, 'strings.json');
const MANIFEST_FILE = join(VOICEOVER_DIR, 'manifest.json');

const TTS_MODEL = 'edge-tts';
const TTS_VOICE = process.env.VOICEOVER_VOICE || 'en-US-AndrewMultilingualNeural';
const TTS_FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3;
const TTS_FORMAT_TAG = 'mp3-24khz-96kbps-mono';
/* Speaking-rate prosody. Default neural cadence is brisk for an
 * instructional context where the participant is reading along and
 * mentally rehearsing each step. `-15%` slows by roughly one beat per
 * sentence — calmer, easier to follow, still natural. Override via
 * `VOICEOVER_RATE` env (any SSML-legal value: relative percentage like
 * `-20%`, named enum like `slow`, or a decimal multiplier like `0.85`). */
const TTS_RATE = process.env.VOICEOVER_RATE || '-15%';

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function readStringsList() {
  if (!existsSync(STRINGS_FILE)) {
    console.error(
      `[render-voiceover-edge] No strings file at ${STRINGS_FILE}. Run \`npm run harvest-voiceover\` first.`
    );
    process.exit(1);
  }
  const raw = await readFile(STRINGS_FILE, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[render-voiceover-edge] strings.json is not valid JSON: ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(parsed)) {
    console.error('[render-voiceover-edge] strings.json must be an array.');
    process.exit(1);
  }
  const out = [];
  const seen = new Set();
  for (const entry of parsed) {
    const text = typeof entry === 'string' ? entry : entry?.text;
    if (typeof text !== 'string' || !text.trim()) continue;
    const hash = sha256Hex(text);
    if (seen.has(hash)) continue;
    seen.add(hash);
    out.push({ text, source: entry?.source ?? null, hash });
  }
  return out;
}

async function readExistingManifest() {
  const empty = () => ({
    version: 1,
    voice: TTS_VOICE,
    model: TTS_MODEL,
    rate: TTS_RATE,
    entries: {},
  });
  if (!existsSync(MANIFEST_FILE)) return empty();
  const raw = await readFile(MANIFEST_FILE, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.entries) {
      return empty();
    }
    return parsed;
  } catch {
    return empty();
  }
}

async function writeManifest(manifest) {
  const sortedEntries = Object.fromEntries(
    Object.entries(manifest.entries).sort(([a], [b]) => a.localeCompare(b))
  );
  const out = {
    version: manifest.version ?? 1,
    voice: manifest.voice ?? TTS_VOICE,
    model: manifest.model ?? TTS_MODEL,
    rate: manifest.rate ?? TTS_RATE,
    rendered_at: new Date().toISOString(),
    entries: sortedEntries,
  };
  await writeFile(MANIFEST_FILE, JSON.stringify(out, null, 2) + '\n', 'utf8');
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Synthesise one narration string via Edge TTS and write the MP3 to disk.
 *
 * `msedge-tts` exposes `toStream(text)` which opens a WebSocket to the
 * Edge endpoint and returns a Node Readable that emits binary MP3 chunks.
 * We collect chunks until `audioStream` ends, then write them in one
 * atomic file write so a Ctrl-C mid-stream cannot leave a truncated MP3
 * on disk that the engine would then try to play.
 *
 * We also enable `wordBoundaryEnabled` so the endpoint emits a parallel
 * `metadataStream` of WordBoundary events. Each event carries an `Offset`
 * (in 100-ns ticks from the start of audio) and the spoken `Text` for
 * that word. We collect these alongside audio and return them so the
 * caller can store them in the manifest — the browser engine uses them
 * to drive the gray→white reveal in lock-step with the actual spoken
 * pace, instead of approximating with linear `currentTime / duration`.
 *
 * We construct a fresh `MsEdgeTTS` instance per call. The endpoint
 * closes the socket after each turn, so reusing instances brings no
 * speed-up and risks state bleed between calls.
 */
async function renderOne(text, hash) {
  const tts = new MsEdgeTTS();
  const metadataOpts = new MetadataOptions();
  metadataOpts.wordBoundaryEnabled = true;
  await tts.setMetadata(TTS_VOICE, TTS_FORMAT, metadataOpts);
  /* ProsodyOptions wraps the synthesis request in SSML <prosody>. The
   * `rate` field accepts the same string we lock into the manifest, so
   * the rendered audio and the rate-mixing guard stay consistent. */
  const prosody = new ProsodyOptions();
  prosody.rate = TTS_RATE;
  const { audioStream, metadataStream } = tts.toStream(text, prosody);
  const chunks = [];
  const wordBoundaries = [];
  /* The metadata stream emits JSON chunks of shape
   * `{ Metadata: [{ Type: "WordBoundary", Data: { Offset, Duration, text: { Text } } }] }`.
   * `Offset` and `Duration` are in 100-ns ticks (HNS units), where
   * 10,000 ticks = 1 ms. We convert to milliseconds at write time so
   * the manifest is human-inspectable and the browser code doesn't
   * have to know about HNS. */
  if (metadataStream) {
    metadataStream.on('data', (chunk) => {
      try {
        const parsed = JSON.parse(chunk.toString());
        const items = Array.isArray(parsed?.Metadata) ? parsed.Metadata : [];
        for (const item of items) {
          if (item?.Type !== 'WordBoundary') continue;
          const data = item?.Data;
          if (!data) continue;
          const wordText = data?.text?.Text;
          if (typeof wordText !== 'string') continue;
          const offsetTicks = Number(data?.Offset);
          const durationTicks = Number(data?.Duration);
          if (!Number.isFinite(offsetTicks)) continue;
          wordBoundaries.push({
            text: wordText,
            offset_ms: Math.round(offsetTicks / 10_000),
            duration_ms: Number.isFinite(durationTicks) ? Math.round(durationTicks / 10_000) : 0,
          });
        }
      } catch {
        /* A malformed metadata chunk should not abort the whole render —
         * worst case we lose word-level timestamps for this entry and
         * the browser falls back to linear interpolation. */
      }
    });
  }
  await new Promise((resolve, reject) => {
    audioStream.on('data', (chunk) => chunks.push(chunk));
    audioStream.on('end', resolve);
    audioStream.on('close', resolve);
    audioStream.on('error', reject);
  });
  const buf = Buffer.concat(chunks);
  if (buf.length === 0) {
    throw new Error(
      'Edge TTS returned 0 bytes — likely an empty / invalid input or a transient endpoint error.'
    );
  }
  const file = `${hash}.mp3`;
  await writeFile(join(VOICEOVER_DIR, file), buf);
  return { file, bytes: buf.length, wordBoundaries };
}

function previewOf(text, max = 80) {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…';
}

async function main() {
  await mkdir(VOICEOVER_DIR, { recursive: true });

  const strings = await readStringsList();
  if (strings.length === 0) {
    console.error('[render-voiceover-edge] No narration strings to render.');
    process.exit(0);
  }

  const manifest = await readExistingManifest();
  /* Voice/model mixing guard
   * The participant would hear inconsistent voices across slides if we
   * silently merged renders from different backends; refuse explicitly
   * and force a fresh re-render. */
  if (manifest.voice && manifest.voice !== TTS_VOICE) {
    console.error(
      `[render-voiceover-edge] Existing manifest was rendered with voice "${manifest.voice}" but this run is "${TTS_VOICE}". Refusing to mix voices. Delete public/voiceover/*.mp3 + manifest.json to re-render from scratch.`
    );
    process.exit(1);
  }
  if (manifest.model && manifest.model !== TTS_MODEL) {
    console.error(
      `[render-voiceover-edge] Existing manifest was rendered with model "${manifest.model}" but this run is "${TTS_MODEL}". Refusing to mix. Delete public/voiceover/*.mp3 + manifest.json to re-render from scratch.`
    );
    process.exit(1);
  }
  if (manifest.rate && manifest.rate !== TTS_RATE) {
    console.error(
      `[render-voiceover-edge] Existing manifest was rendered with rate "${manifest.rate}" but this run is "${TTS_RATE}". Refusing to mix. Delete public/voiceover/*.mp3 + manifest.json to re-render from scratch.`
    );
    process.exit(1);
  }
  /* If the manifest was missing or empty, lock the voice/model/rate now
   * so subsequent runs without an env override stay consistent. */
  manifest.voice = TTS_VOICE;
  manifest.model = TTS_MODEL;
  manifest.rate = TTS_RATE;

  let rendered = 0;
  let skipped = 0;
  let failed = 0;
  const totalChars = strings.reduce((s, e) => s + e.text.length, 0);
  console.log(
    `[render-voiceover-edge] ${strings.length} strings (${totalChars} chars). Voice=${TTS_VOICE} Rate=${TTS_RATE} Format=${TTS_FORMAT_TAG}.`
  );

  for (let i = 0; i < strings.length; i++) {
    const { text, hash } = strings[i];
    const prefix = `[${(i + 1).toString().padStart(strings.length.toString().length)}/${strings.length}]`;
    const file = `${hash}.mp3`;
    const path = join(VOICEOVER_DIR, file);
    const existing = manifest.entries[hash];
    /* Cache hit only if BOTH the MP3 is on disk AND word boundaries
     * were captured for this entry; entries without a `word_boundaries`
     * array are re-fetched so the browser can drive the lock-step
     * gray→white reveal. */
    if (
      existing &&
      existing.file === file &&
      Array.isArray(existing.word_boundaries) &&
      existing.word_boundaries.length > 0 &&
      (await fileExists(path))
    ) {
      skipped += 1;
      console.log(`${prefix} cached  ${hash.slice(0, 12)} "${previewOf(text, 60)}"`);
      continue;
    }
    try {
      const { bytes, wordBoundaries } = await renderOne(text, hash);
      manifest.entries[hash] = {
        file,
        bytes,
        chars: text.length,
        text_preview: previewOf(text, 120),
        word_boundaries: wordBoundaries,
      };
      await writeManifest(manifest);
      rendered += 1;
      console.log(
        `${prefix} render  ${hash.slice(0, 12)} ${(bytes / 1024).toFixed(1)} KB  ${wordBoundaries.length} words  "${previewOf(text, 50)}"`
      );
    } catch (err) {
      failed += 1;
      console.error(`${prefix} FAILED  ${hash.slice(0, 12)}: ${err.message}`);
    }
  }

  await writeManifest(manifest);

  console.log(
    `[render-voiceover-edge] Done. Rendered ${rendered}, cached ${skipped}, failed ${failed}.`
  );
  if (failed > 0) process.exit(2);
}

main().catch((err) => {
  console.error('[render-voiceover-edge] Unhandled error:', err);
  process.exit(1);
});

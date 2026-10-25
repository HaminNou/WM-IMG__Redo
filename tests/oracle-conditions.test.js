// @vitest-environment jsdom
/**
 * Independent ORACLE for the five conditions (final-check audit F2/F7).
 *
 * Runs real main-task trials of all five conditions through jsPsych on a fake
 * clock with a randomised simulated participant (random, late, extra and
 * skipped key presses), and re-derives everything from the DOM, the audio
 * calls and the recorded rows, never from the modules under test:
 *   - the screen position of every stimulus, inverse-rotated by the rotor
 *     angle read from the same SVG, gives the cell actually shown;
 *   - the expected on/off-pattern of a star comes from the SHOWN cell and a
 *     hand-written pattern (tests/helpers/oracle-geometry.js), not from grid.js;
 *   - expected target/foil for a probe comes from what was SHOWN or HEARD
 *     during encoding;
 *   - expected correctness comes from the key the simulated participant pressed
 *     (RIGHT = Yes / On-pattern), RT from the fake-clock press time vs onset;
 *   - one visible stimulus at a time, one bull's-eye dot, page shade, ink
 *     constancy, feedback colour, '?' policy, rotor angle per phase, arrow-cue
 *     angle equals the recorded angle.
 *
 * Default run: ORACLE_SEEDS seeds per condition (default 8) and
 * ORACLE_SEQ_SEEDS back-to-back runs (default 1). A heavy run:
 *   ORACLE_SEEDS=60 ORACLE_SEQ_SEEDS=6 npx vitest run tests/oracle-conditions.test.js
 *
 * It was written to catch the class of bug that invalidated the first
 * Experiment 2 (probe dots drawn on an unrotated grid while the encoded dots
 * were on the rotated one) and the 14 mutants listed in the audit that the
 * older suite did not catch: flipped key mapping, inverted judges, negated
 * recorded labels, arrow-cue sign, swapped feedback colours, wrong tone cell,
 * wrong recorded probe, visible dummy squares, a frame that loses its shade.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initJsPsych } from 'jspsych';

const AUDIO_CALLS = [];
vi.mock('../src/audio/context.js', () => ({
  getAudioContext: () => ({ currentTime: performance.now() / 1000, state: 'running' }),
  audioContextInfo: () => ({
    sample_rate_hz: 48000,
    state: 'running',
    base_latency_ms: 10,
    output_latency_ms: 20,
  }),
  ensureRunning: async () => {},
  unlockAudio: async () => {},
}));
vi.mock('../src/audio/dsp.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    playSineTone: vi.fn((freq, opts = {}) => {
      AUDIO_CALLS.push({ freq, when: opts.when ?? null, perf: performance.now() });
      return Promise.resolve();
    }),
  };
});

import { setSessionPRNG } from '../src/prng.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { generateMainBlockPair } from '../src/scheduler/main-blocks.js';
import { _resetStorageForTests, initStorage } from '../src/storage.js';
import {
  BANK_ON_CELLS,
  FREQS,
  GREEN,
  MID,
  OFF_CELLS,
  ON_CELLS,
  RED,
  band,
  lcg,
  rotorAngle,
  stimInfo,
  trialAngle,
} from './helpers/oracle-geometry.js';

const FAKE = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'Date',
  'performance',
  'requestAnimationFrame',
  'cancelAnimationFrame',
];
const STEP = 8;

async function runOne(nodes, seed) {
  AUDIO_CALLS.length = 0;
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-trial-bg');
  const jsPsych = initJsPsych({});
  window.jsPsych = jsPsych;
  let done = false;
  const runP = jsPsych.run(nodes).then(() => {
    done = true;
  });
  const press = (key) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const release = (key) =>
    window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
  const rnd = lcg(seed);

  const seen = new Map(); /* element -> rec */
  const presses = []; /* {t, key, kind, target element rec} */
  const timeline = []; /* {t, phase} */
  const stepLog = [];
  let lastCur = null;
  const toneO = [];

  for (let t = 0; t < 900000 && !done; t += STEP) {
    await vi.advanceTimersByTimeAsync(STEP);
    const now = performance.now();
    const cur = jsPsych.getCurrentTrial?.();
    const phase = cur?.data?.phase ?? '';
    if (cur !== lastCur) {
      timeline.push({ t: now, phase });
      lastCur = cur;
    }
    if (document.querySelector('.trial-start-hint')) {
      press('ArrowLeft');
      press('ArrowRight');
      release('ArrowLeft');
      release('ArrowRight');
    }
    /* page shade */
    const bg = document.documentElement.dataset.trialBg ?? null;
    /* frame state */
    const svgs = [...document.querySelectorAll('svg')].filter((s) =>
      s.querySelector('.grid-rotor')
    );
    const svg = svgs[svgs.length - 1] ?? null;
    if (svg) {
      const vis = [...svg.querySelectorAll('.grid-stimuli > *')].filter(
        (e) => e.getAttribute('data-visible') !== 'false'
      );
      const dots = [...svg.querySelectorAll('circle')].filter(
        (c) =>
          (c.classList.contains('grid-bullseye-dot') ||
            c.classList.contains('pattern-reference-dot')) &&
          c.getAttribute('visibility') !== 'hidden'
      );
      const qm = svg.querySelector('.grid-fixation-qmark');
      stepLog.push({
        uid: cur?.data?.trial_uid ?? null,
        t: now,
        phase,
        bg,
        nVis: vis.length,
        nFixDots: dots.length,
        qmark: qm.getAttribute('visibility') === 'visible',
        qstroke: qm.getAttribute('stroke'),
        arrow:
          (document.querySelector('img.rotation-arrow-cue')?.getAttribute('style') ?? '').match(
            /rotate\((-?[\d.]+)deg\)/
          )?.[1] ?? null,
        ring: !!svg.querySelector('.grid-bullseye-ring'),
        ringStroke: svg.querySelector('.grid-bullseye-ring')?.getAttribute('stroke'),
        dotFill: dots[0]?.getAttribute('fill'),
        pat: svg.querySelector('.grid-pattern rect')?.getAttribute('fill') ?? null,
        angle: rotorAngle(svg),
        patternVisible: svg.querySelector('.grid-pattern').getAttribute('visibility') === 'visible',
      });
      for (const el of svg.querySelectorAll('.grid-stimuli > *')) {
        if (el.classList.contains('pattern-reference-dot')) continue;
        let rec = seen.get(el);
        if (!rec) {
          rec = {
            el,
            uid: cur?.data?.trial_uid ?? null,
            first: now,
            last: now,
            phase,
            ...stimInfo(el),
            fills: new Set(),
            svgAngleAtFirst: rotorAngle(svg),
          };
          rec.visible = el.getAttribute('data-visible') !== 'false';
          seen.set(el, rec);
        }
        rec.last = now;
        rec.fills.add(el.getAttribute('fill'));
        /* simulated participant: stars and dot probes */
        if (
          rec.visible &&
          (rec.tag === 'polygon' || (rec.tag === 'circle' && rec.phase.endsWith('_probe'))) &&
          !rec.plannedDone
        ) {
          if (!rec.plan) {
            const r = rnd();
            rec.plan = {
              skip: r < 0.1 || (r > 0.88 && r < 0.96),
              latePress: r > 0.88 && r < 0.96,
              rt: 250 + Math.floor(rnd() * 2550),
              key: rnd() < 0.5 ? 'ArrowRight' : 'ArrowLeft',
              extra: rnd() < 0.15,
              late: rnd() < 0.08,
            };
          }
          if (!rec.plan.skip && !rec.pressed && now - rec.first >= rec.plan.rt) {
            rec.pressed = true;
            rec.pressT = now;
            rec.pressKey = rec.plan.key;
            rec.fillBefore = el.getAttribute('fill');
            press(rec.plan.key);
            rec.fillAfterSync = el.getAttribute('fill');
            presses.push({ t: now, key: rec.plan.key, rec });
          } else if (rec.pressed && rec.plan.extra && !rec.extraDone && now - rec.pressT >= 150) {
            rec.extraDone = true;
            press(rec.plan.key === 'ArrowRight' ? 'ArrowLeft' : 'ArrowRight');
          }
        }
      }
    }
    for (const rec of seen.values()) {
      if (
        rec.plan?.latePress &&
        !rec.latePressed &&
        now - rec.first >= 3080 &&
        now - rec.first < 3400
      ) {
        rec.latePressed = true;
        press(rnd() < 0.5 ? 'ArrowRight' : 'ArrowLeft');
      }
    }
    /* tone-probe participant: press based on phase */
    if (phase.endsWith('_probe') && /_(t_only|i_t)_/.test('_' + phase)) {
      if (!cur.__oracle) {
        const r = rnd();
        cur.__oracle = {
          start: now,
          skip: r < 0.1 || (r > 0.88 && r < 0.96),
          latePress: r > 0.88 && r < 0.96,
          rt: 250 + Math.floor(rnd() * 2550),
          key: rnd() < 0.5 ? 'ArrowRight' : 'ArrowLeft',
          extra: rnd() < 0.15,
        };
      }
      const o = cur.__oracle;
      if (!toneO.includes(o)) toneO.push(o);
      if (!o.skip && !o.pressed && now - o.start >= o.rt) {
        o.pressed = true;
        o.pressT = now;
        o.fillAfterSyncBefore = document
          .querySelector('.grid-fixation-qmark')
          ?.getAttribute('stroke');
        press(o.key);
        o.qAfterSync = document.querySelector('.grid-fixation-qmark')?.getAttribute('stroke');
      } else if (o.pressed && o.extra && !o.extraDone && now - o.pressT >= 150) {
        o.extraDone = true;
        press(o.key === 'ArrowRight' ? 'ArrowLeft' : 'ArrowRight');
      }
    }
    for (const o of toneO) {
      if (o.latePress && !o.latePressed && now - o.start >= 3120 && now - o.start < 3400) {
        o.latePressed = true;
        press('ArrowRight');
      }
    }
  }
  await runP;
  const rows = jsPsych.data.get().values();
  return { rows, seen, presses, timeline, stepLog, toneO, audio: AUDIO_CALLS.slice() };
}

beforeEach(async () => {
  _resetStorageForTests();
  await initStorage({ backend: 'memory' });
  vi.useFakeTimers({ toFake: FAKE });
});
afterEach(() => {
  vi.useRealTimers();
});

function trialsByUid(pair) {
  const m = new Map();
  for (const blk of [pair.mainA, pair.mainB]) {
    for (const n of blk.nodes) {
      const uid = n.data?.trial_uid;
      if (!uid) continue;
      if (!m.has(uid)) m.set(uid, []);
      m.get(uid).push(n);
    }
  }
  return m;
}

const SEEDS = Number(process.env.ORACLE_SEEDS ?? 8);
const SEQ_SEEDS = Number(process.env.ORACLE_SEQ_SEEDS ?? 1);
const CONDS = ['d_only', 't_only', 'i_only', 'i_d', 'i_t'];
const STATS = {
  n: 0,
  strata: new Set(),
  byCond: {},
  ink: { white: new Set(), gray: new Set() },
  pat: { white: new Set(), gray: new Set() },
};

describe.each(CONDS)('oracle %s', (cond) => {
  it(`invariants over ${SEEDS} seeds`, async () => {
    const failures = [];
    const fail = (seed, uid, msg) => failures.push(`seed ${seed} ${uid}: ${msg}`);
    for (let seed = 0; seed < SEEDS; seed++) {
      setSessionPRNG(`oracle-${seed}`);
      resetSequencePools();
      const pair = generateMainBlockPair();
      const map = trialsByUid(pair);
      const uids = [...map.keys()].filter((u) => u.endsWith(`-${cond}`));
      const uid = uids[(seed * 7 + CONDS.indexOf(cond)) % uids.length];
      const nodes = map.get(uid);
      const params = [...pair.mainA.trialParams, ...pair.mainB.trialParams].find(
        (p) => p.trial_meta.trial_uid === uid
      );
      const shade = params.background_shade;
      const out = await runOne(nodes, seed);
      const { rows, seen, timeline, stepLog, audio } = out;
      const phase = (r) => r.phase ?? '';
      const encRow = rows.find((r) => phase(r).endsWith('_encoding'));
      const starRows = rows.filter((r) => phase(r).endsWith('_star'));
      const probeRows = rows.filter((r) => phase(r).endsWith('_probe'));
      const hasStars = ['i_only', 'i_d', 'i_t'].includes(cond);
      const hasProbes = cond !== 'i_only';
      const dotCond = cond === 'd_only' || cond === 'i_d';
      const toneCond = cond === 't_only' || cond === 'i_t';
      const recs = [...seen.values()];
      STATS.n++;
      if (typeof params.rotation_deg === 'number') STATS.strata.add(band(params.rotation_deg));
      if (typeof params.display_rotation_deg === 'number')
        STATS.strata.add(band(params.display_rotation_deg));

      STATS.byCond[cond] = STATS.byCond[cond] || {
        stars: 0,
        starsResp: 0,
        probes: 0,
        probesResp: 0,
        probesCorrect: 0,
        starsCorrect: 0,
        targets: 0,
      };
      {
        const c = STATS.byCond[cond];
        c.stars += starRows.length;
        c.starsResp += starRows.filter((r) => r.responded).length;
        c.starsCorrect += starRows.filter((r) => r.star_correct).length;
        c.probes += probeRows.length;
        c.probesResp += probeRows.filter((r) => r.responded).length;
        c.probesCorrect += probeRows.filter((r) => r.probe_correct).length;
        c.targets += probeRows.filter((r) => r.is_target).length;
      }
      if (starRows.length !== (hasStars ? 3 : 0)) fail(seed, uid, `star rows ${starRows.length}`);
      if (probeRows.length !== (hasProbes ? 3 : 0))
        fail(seed, uid, `probe rows ${probeRows.length}`);

      /* ---- page shade + fixation continuity, every step of the trial ---- */
      for (const s of stepLog) {
        if (s.phase === '') continue;
        if (s.bg !== shade) {
          fail(seed, uid, `page shade ${s.bg} != trial shade ${shade} in ${s.phase} at ${s.t}`);
          break;
        }
      }
      for (const s of stepLog) {
        if (s.phase === '') continue;
        if (s.nFixDots !== 1) {
          fail(seed, uid, `${s.nFixDots} visible fixation dots in ${s.phase}`);
          break;
        }
        if (!s.ring) {
          fail(seed, uid, `no ring in ${s.phase}`);
          break;
        }
        if (s.nVis > 1) {
          fail(seed, uid, `${s.nVis} simultaneous visible stimuli in ${s.phase}`);
          break;
        }
      }
      /* Ink: the ring and the base dot colour are one constant per trial (they
       * depend on the page shade only, never on the phase), the dot only ever
       * turns green/red for feedback, and the pattern fill is constant. The
       * palette per shade is compared across all seeds in the coverage block. */
      {
        const live = stepLog.filter((s) => s.phase);
        const baseRing = live[0]?.ringStroke;
        const baseDot = live[0]?.dotFill;
        const basePat = live.find((s) => s.pat)?.pat ?? null;
        for (const s of live) {
          if (s.ringStroke !== baseRing) {
            fail(seed, uid, `ring ink ${s.ringStroke} != ${baseRing} in ${s.phase}`);
            break;
          }
          if (![baseDot, GREEN, RED].includes(s.dotFill)) {
            fail(seed, uid, `centre dot ink ${s.dotFill} in ${s.phase} (base ${baseDot})`);
            break;
          }
          if (s.pat && s.pat !== basePat) {
            fail(seed, uid, `pattern fill ${s.pat} != ${basePat} in ${s.phase}`);
            break;
          }
        }
        STATS.ink[shade]?.add(`${baseRing}|${baseDot}`);
        if (basePat) STATS.pat[shade]?.add(basePat);
      }
      for (const s of stepLog) {
        if (/_arrow_cue$/.test(s.phase)) {
          if (s.arrow === null || Number(s.arrow) !== params.rotation_deg) {
            fail(seed, uid, `arrow cue rotation ${s.arrow} != ${params.rotation_deg}`);
            break;
          }
        } else if (s.arrow !== null) {
          fail(seed, uid, `arrow visible in ${s.phase}`);
          break;
        }
      }
      /* ?-glyph policy */
      for (const s of stepLog) {
        const ph = s.phase;
        const wantQ = /_(retention|probe)$/.test(ph) || (/_iti$/.test(ph) && cond !== 'i_only');
        if (ph && s.qmark !== wantQ && !(s.qmark === false && /_probe$/.test(ph))) {
          fail(seed, uid, `qmark ${s.qmark} in ${ph}`);
          break;
        }
      }
      /* frame rotation per phase */
      const ANGLE = trialAngle(cond, params);
      /* Allowed rotor angles per phase: the retention and probe frames carry the
       * trial angle (the fix for the first run's bug); the pattern screen and
       * the arrow cue are upright; the encoding frame animates (checked
       * separately); the gate, imagination and ITI frames are either upright or
       * already at the trial angle. */
      const allowedRot = (ph) => {
        if (/_(retention|probe)$/.test(ph)) return [ANGLE];
        if (/_encoding$/.test(ph)) return null;
        if (ph === 'pattern_phase' || /_arrow_cue$/.test(ph)) return [0];
        return [0, ANGLE];
      };
      for (const s of stepLog) {
        const ok = allowedRot(s.phase);
        if (ok && s.phase && !ok.includes(s.angle)) {
          fail(seed, uid, `rotor angle ${s.angle} not in [${ok}] in ${s.phase}`);
          break;
        }
      }
      /* pattern visible only in the pattern phase */
      for (const s of stepLog) {
        if (s.patternVisible && s.phase !== 'pattern_phase') {
          fail(seed, uid, `pattern visible in ${s.phase}`);
          break;
        }
      }

      /* ---- encoding ---- */
      const encAngle = ANGLE;
      const encRecs = recs.filter((r) => r.phase.endsWith('_encoding'));
      const encDots = encRecs.filter((r) => r.tag === 'circle').sort((a, b) => a.first - b.first);
      const encStars = encRecs.filter((r) => r.tag === 'polygon').sort((a, b) => a.first - b.first);
      const encDummies = encRecs.filter((r) => r.tag === 'rect').sort((a, b) => a.first - b.first);
      if (dotCond && encDots.length !== 3) fail(seed, uid, `enc dots ${encDots.length}`);
      if (!dotCond && encDots.length !== 0)
        fail(seed, uid, `enc dots in non-dot condition ${encDots.length}`);
      if (hasStars && encStars.length !== 3) fail(seed, uid, `enc stars ${encStars.length}`);
      if (!hasStars && encStars.length !== 0) fail(seed, uid, `stars in non-star cond`);
      for (const d of encDummies) {
        if (d.el.getAttribute('stroke') !== 'none' || d.el.getAttribute('data-visible') !== 'false')
          fail(seed, uid, 'dummy square is visible');
      }
      for (const d of encDots) {
        if (d.fill !== '#000000') fail(seed, uid, `dot fill ${d.fill}`);
        if (d.angle !== encAngle) fail(seed, uid, `enc dot angle ${d.angle} != ${encAngle}`);
        if (d.cell === null || d.cell === 12)
          fail(seed, uid, `enc dot not on a cell centre / centre cell: ${d.x},${d.y}`);
        if (d.last - d.first < 900 || d.last - d.first > 1100)
          fail(seed, uid, `dot dur ${d.last - d.first}`);
      }
      for (const d of encDots) {
        const idx = encDots.indexOf(d);
        const item = params.memory_items
          .slice()
          .sort((a, b) => a.slot_index_in_seq - b.slot_index_in_seq)[idx];
        if (item.cell !== d.cell)
          fail(seed, uid, `dot ${idx}: scheduled cell ${item.cell} drawn at cell ${d.cell}`);
      }
      const slotPos = encRow?.slot_positions_mm ?? [];
      for (const d of encDots) {
        const sp = slotPos.find((p) => p.kind === 'dot' && p.cell === d.cell);
        if (!sp || Math.abs(sp.x_mm - (d.x - MID)) > 1e-2 || Math.abs(sp.y_mm - (d.y - MID)) > 1e-2)
          fail(seed, uid, `slot_positions_mm disagree with drawn dot (cell ${d.cell})`);
      }
      /* encoding onset order vs slot: dot k begins within 35 ms of slot onset */
      if (encRow && dotCond) {
        const mSlots = [...params.sequence]
          .map((k, i) => (k === 'M' ? i : -1))
          .filter((i) => i >= 0);
        mSlots.forEach((slot, k) => {
          const rec = encDots[k];
          if (rec && Math.abs(rec.first - encRow.slot_onsets_ts_ms[slot]) > 20)
            fail(
              seed,
              uid,
              `dot ${k} first seen ${rec.first} vs slot onset ${encRow.slot_onsets_ts_ms[slot]}`
            );
        });
      }

      /* ---- encoding tones ---- */
      const encAudio = audio.filter((a) => {
        const p = timeline.filter((x) => x.t <= a.perf + 1e-6).pop();
        return p && p.phase.endsWith('_encoding');
      });
      if (toneCond && encAudio.length !== 3) fail(seed, uid, `encoding tones ${encAudio.length}`);
      if (!toneCond && audio.length !== 0)
        fail(seed, uid, `audio calls in non-tone condition ${audio.length}`);
      const heardFreqs = encAudio.map((a) => a.freq);
      if (toneCond && encRow) {
        const mSlots = [...params.sequence]
          .map((k, i) => (k === 'M' ? i : -1))
          .filter((i) => i >= 0);
        const ev = encRow.slot_tone_events;
        ev.forEach((e, k) => {
          if (Math.abs(FREQS[e.tone_index] - heardFreqs[k]) > 1e-6)
            fail(seed, uid, `tone event ${k} tone_index freq mismatch`);
          if (e.slot !== mSlots[k]) fail(seed, uid, `tone event slot ${e.slot} != ${mSlots[k]}`);
          /* tone <-> cell parity: on cells -> even index */
          const lab = e.tone_index % 2 === 0 ? 'on' : 'off';
          const item = params.memory_items.find((m) => m.slot_index_in_seq === e.slot);
          if (item.pattern_label !== lab)
            fail(seed, uid, `tone label ${lab} vs item ${item.pattern_label}`);
          const expectCell = (lab === 'on' ? BANK_ON_CELLS : OFF_CELLS)[
            Math.floor(e.tone_index / 2)
          ];
          if (expectCell !== item.cell)
            fail(
              seed,
              uid,
              `tone idx ${e.tone_index} expected cell ${expectCell}, item cell ${item.cell}`
            );
        });
        if (new Set(heardFreqs.map((f) => f.toFixed(3))).size !== 3)
          fail(seed, uid, 'duplicate encoding tones');
      }

      /* ---- stars ---- */
      const starRowsBySlot = new Map(starRows.map((r) => [r.slot_index_in_seq, r]));
      const sSlots = [...params.sequence].map((k, i) => (k === 'S' ? i : -1)).filter((i) => i >= 0);
      encStars.forEach((rec, k) => {
        const row = starRowsBySlot.get(sSlots[k]);
        if (!row) return fail(seed, uid, `no star row for slot ${sSlots[k]}`);
        if (rec.fill !== '#000000') fail(seed, uid, `star initial fill ${rec.fill}`);
        if (rec.angle !== params.rotation_deg)
          fail(seed, uid, `star angle ${rec.angle} != ${params.rotation_deg}`);
        if (rec.cell === null || rec.cell === 12)
          return fail(seed, uid, `star off grid ${rec.x},${rec.y}`);
        const expOn = ON_CELLS.has(rec.cell);
        if (row.probed_cell !== rec.cell)
          fail(seed, uid, `star row cell ${row.probed_cell} != drawn ${rec.cell}`);
        if (row.is_on_pattern !== expOn)
          fail(
            seed,
            uid,
            `star is_on_pattern ${row.is_on_pattern} != oracle ${expOn} (cell ${rec.cell})`
          );
        if ((row.pattern_label === 'on') !== expOn)
          fail(seed, uid, `star pattern_label ${row.pattern_label}`);
        if (
          Math.abs(row.star_x_mm - (rec.x - MID)) > 2e-3 ||
          Math.abs(row.star_y_mm - (rec.y - MID)) > 2e-3
        )
          fail(
            seed,
            uid,
            `star_x/y_mm ${row.star_x_mm},${row.star_y_mm} vs drawn ${rec.x - MID},${rec.y - MID}`
          );
        if (row.star_frame_rotation_deg !== rec.angle)
          fail(seed, uid, `star_frame_rotation ${row.star_frame_rotation_deg}`);
        const pressed = !!rec.pressed && rec.pressT - rec.first < 3000;
        if (row.responded !== pressed)
          fail(
            seed,
            uid,
            `star responded ${row.responded} vs oracle ${pressed} (rt ${rec.plan?.rt})`
          );
        if (pressed) {
          const wantKey = rec.pressKey.toLowerCase();
          if (row.response_key !== wantKey)
            fail(seed, uid, `star response_key ${row.response_key}`);
          const said = rec.pressKey === 'ArrowRight';
          if (row.said_on !== said) fail(seed, uid, `said_on ${row.said_on}`);
          const corr = said === expOn;
          if (row.star_correct !== corr)
            fail(seed, uid, `star_correct ${row.star_correct} vs oracle ${corr}`);
          const want = corr ? GREEN : RED;
          if (!rec.fills.has(want) || rec.fills.has(corr ? RED : GREEN))
            fail(seed, uid, `star feedback colours ${[...rec.fills]} vs ${want}`);
          const rt = rec.pressT - rec.first;
          if (Math.abs(row.response_rt_ms - rt) > 40)
            fail(seed, uid, `star rt ${row.response_rt_ms} vs oracle ${rt}`);
        } else if (row.star_correct !== false)
          fail(seed, uid, 'star_correct true without response');
        const dur = rec.last - rec.first;
        if (dur < 2900 || dur > 3100) fail(seed, uid, `star on-screen ${dur}`);
        if (Math.abs(row.star_onset_ts_ms - rec.first) > 20)
          fail(seed, uid, `star_onset_ts ${row.star_onset_ts_ms} vs seen ${rec.first}`);
      });
      /* star/dot cells disjoint */
      const dotCells = new Set(encDots.map((d) => d.cell));
      for (const s of encStars)
        if (dotCells.has(s.cell)) fail(seed, uid, `star on a dot cell ${s.cell}`);

      /* ---- probes ---- */
      if (hasProbes) {
        const probeNodes = timeline.filter((x) => x.phase.endsWith('_probe'));
        const probeRecs = recs
          .filter((r) => r.phase.endsWith('_probe') && r.tag === 'circle')
          .sort((a, b) => a.first - b.first);
        if (dotCond && probeRecs.length !== 3) fail(seed, uid, `probe dots ${probeRecs.length}`);
        const encodedCellsDot = new Set(encDots.map((d) => d.cell));
        const probeAudio = audio.filter((a) => {
          const p = timeline.filter((x) => x.t <= a.perf + 1e-6).pop();
          return p && p.phase.endsWith('_probe');
        });
        if (toneCond && probeAudio.length !== 3)
          fail(seed, uid, `probe tones ${probeAudio.length}`);
        const sortedRows = probeRows.slice().sort((a, b) => a.probe_position - b.probe_position);
        const seenProbeCells = new Set();
        const types = new Set();
        sortedRows.forEach((row, k) => {
          if (row.probe_position !== k)
            fail(seed, uid, `probe_position ${row.probe_position} at ${k}`);
          let obsCell;
          let expYes;
          let pressed;
          let pressKey;
          let rtOracle;
          let feedbackOK = true;
          let onset;
          if (dotCond) {
            const rec = probeRecs[k];
            obsCell = rec.cell;
            if (rec.angle !== ANGLE) fail(seed, uid, `probe dot angle ${rec.angle} != ${ANGLE}`);
            expYes = encodedCellsDot.has(obsCell);
            pressed = !!rec.pressed && rec.pressT - rec.first < 3000;
            pressKey = rec.pressKey;
            rtOracle = rec.pressT - rec.first;
            onset = rec.first;
            if (
              Math.abs(row.probe_x_mm - (rec.x - MID)) > 2e-3 ||
              Math.abs(row.probe_y_mm - (rec.y - MID)) > 2e-3
            )
              fail(
                seed,
                uid,
                `probe_x/y ${row.probe_x_mm},${row.probe_y_mm} vs drawn ${rec.x - MID},${rec.y - MID}`
              );
            if (row.probe_frame_rotation_deg !== rec.angle)
              fail(
                seed,
                uid,
                `probe_frame_rotation ${row.probe_frame_rotation_deg} vs ${rec.angle}`
              );
            const dur = rec.last - rec.first;
            if (rec.fill !== '#000000') fail(seed, uid, `probe dot initial fill ${rec.fill}`);
            if (dur < 2900 || dur > 3100) fail(seed, uid, `probe dot visible ${dur}`);
            if (pressed) {
              const want = (pressKey === 'ArrowRight') === expYes ? GREEN : RED;
              if (!rec.fills.has(want) || rec.fills.size !== 2) feedbackOK = false;
            }
          } else {
            const a = probeAudio[k];
            const fi = FREQS.findIndex((f) => Math.abs(f - a.freq) < 1e-6);
            if (fi < 0) fail(seed, uid, `probe freq ${a.freq} not in bank`);
            obsCell = (fi % 2 === 0 ? BANK_ON_CELLS : OFF_CELLS)[Math.floor(fi / 2)];
            expYes = heardFreqs.some((f) => Math.abs(f - a.freq) < 1e-6);
            const encIdxs = heardFreqs.map((f) => FREQS.findIndex((g) => Math.abs(g - f) < 1e-6));
            if (!expYes && encIdxs.some((e) => Math.abs(e - fi) < 3))
              fail(seed, uid, `foil tone rank gap < 3 (probe ${fi}, enc ${encIdxs})`);
            if (k === 0)
              for (let i = 0; i < 3; i++)
                for (let j = i + 1; j < 3; j++)
                  if (Math.abs(encIdxs[i] - encIdxs[j]) < 3)
                    fail(seed, uid, `encoded tones too close ${encIdxs}`);
            const nodeStart = probeNodes[k].t;
            onset = nodeStart;
            const o = out.toneO[k];
            pressed = !!o && !!o.pressed && o.pressT - row.probe_onset_ts_ms < 3000;
            pressKey = o?.key;
            rtOracle = o ? o.pressT - row.probe_onset_ts_ms : null;
            if (pressed) {
              const want =
                (pressKey === 'ArrowRight') === expYes ? 'rgb(11, 201, 38)' : 'rgb(255, 24, 24)';
              const wantHex = (pressKey === 'ArrowRight') === expYes ? GREEN : RED;
              if (o.qAfterSync !== want && o.qAfterSync !== wantHex)
                fail(seed, uid, `tone feedback stroke ${o.qAfterSync} vs ${wantHex}`);
            }
            if (row.probe_frame_rotation_deg !== ANGLE)
              fail(
                seed,
                uid,
                `tone probe frame rotation ${row.probe_frame_rotation_deg} != ${ANGLE}`
              );
            if (
              row.probed_tone_freq_hz !== undefined &&
              Math.abs(row.probed_tone_freq_hz - a.freq) > 1e-6
            )
              fail(seed, uid, `probed_tone_freq_hz ${row.probed_tone_freq_hz} vs heard ${a.freq}`);
            if (row.probed_tone_index !== fi)
              fail(seed, uid, `probed_tone_index ${row.probed_tone_index} vs heard ${fi}`);
            if (Math.abs(a.perf - row.probe_onset_ts_ms) > 40)
              fail(seed, uid, `tone call ${a.perf} vs probe onset ${row.probe_onset_ts_ms}`);
          }
          if (obsCell === null || obsCell === 12) fail(seed, uid, `probe cell ${obsCell}`);
          if (seenProbeCells.has(obsCell))
            fail(seed, uid, `probe cell ${obsCell} repeated within trial`);
          seenProbeCells.add(obsCell);
          if (row.probed_cell !== obsCell)
            fail(seed, uid, `probe row cell ${row.probed_cell} != shown/heard ${obsCell}`);
          if (row.is_target !== expYes)
            fail(seed, uid, `is_target ${row.is_target} != oracle ${expYes} (cell ${obsCell})`);
          const lab = ON_CELLS.has(obsCell) ? 'on' : 'off';
          if (row.probe_pattern_label !== lab)
            fail(seed, uid, `probe_pattern_label ${row.probe_pattern_label} != ${lab}`);
          const type = `${expYes ? 'T' : 'F'}_${lab}`;
          if (row.probe_type !== type)
            fail(seed, uid, `probe_type ${row.probe_type} != oracle ${type}`);
          types.add(type);
          /* the probed item's encoding position must match when target */
          if (expYes) {
            const encIdx = dotCond
              ? encDots.findIndex((d) => d.cell === obsCell)
              : heardFreqs.findIndex(
                  (f) =>
                    Math.abs(
                      f -
                        FREQS[
                          (lab === 'on' ? BANK_ON_CELLS : OFF_CELLS).indexOf(obsCell) * 2 +
                            (lab === 'on' ? 0 : 1)
                        ]
                    ) < 1e-6
                );
            if (row.encoding_position !== encIdx)
              fail(seed, uid, `encoding_position ${row.encoding_position} vs oracle ${encIdx}`);
          }
          /* responses */
          {
            if (row.responded !== pressed)
              fail(seed, uid, `probe responded ${row.responded} vs oracle ${pressed}`);
            if (pressed) {
              const said = pressKey === 'ArrowRight';
              if (row.said_yes !== said) fail(seed, uid, `said_yes ${row.said_yes}`);
              if (row.probe_correct !== (said === expYes))
                fail(seed, uid, `probe_correct ${row.probe_correct} vs ${said === expYes}`);
              if (row.response !== pressKey.toLowerCase())
                fail(seed, uid, `response key ${row.response}`);
              if (Math.abs(row.rt - rtOracle) > 40)
                fail(seed, uid, `probe rt ${row.rt} vs oracle ${rtOracle}`);
              if (dotCond && Math.abs(row.probe_onset_ts_ms - onset) > 20)
                fail(seed, uid, `probe_onset_ts ${row.probe_onset_ts_ms} vs seen ${onset}`);
              if (dotCond && !feedbackOK) fail(seed, uid, 'probe feedback colour wrong');
            } else if (row.probe_correct !== false)
              fail(seed, uid, 'probe_correct true without response');
          }
        });
        STATS.types = STATS.types || new Map();
        STATS.types.set(
          [...types].sort().join(','),
          (STATS.types.get([...types].sort().join(',')) || 0) + 1
        );
        /* foil must not be a star or dummy cell shown in the trial */
        for (const c of seenProbeCells) {
          if (!dotCells.has(c) && encStars.some((s) => s.cell === c))
            fail(seed, uid, `foil probe on star cell ${c}`);
        }
      }
    }
    if (failures.length) console.log(failures.slice(0, 40).join('\n'));
    expect(failures).toEqual([]);
  }, 1800000);
});

describe('coverage and palette', () => {
  it('records which angle bands, conditions and probe types the run exercised', () => {
    expect(STATS.n).toBeGreaterThan(0);
    expect(Object.keys(STATS.byCond).sort()).toEqual([...CONDS].sort());
  });

  it('the frame palette is a function of the page shade only: one ring/dot ink and one pattern fill per shade', () => {
    expect(STATS.ink.white.size).toBeLessThanOrEqual(1);
    expect(STATS.ink.gray.size).toBeLessThanOrEqual(1);
    expect(STATS.ink.white.size + STATS.ink.gray.size).toBeGreaterThan(0);
    /* the gray pattern overlay changes with the page shade, and is one colour per shade */
    expect(STATS.pat.white.size).toBeLessThanOrEqual(1);
    expect(STATS.pat.gray.size).toBeLessThanOrEqual(1);
    if (STATS.pat.white.size && STATS.pat.gray.size) {
      expect([...STATS.pat.white][0]).not.toBe([...STATS.pat.gray][0]);
    }
  });
});

describe('consecutive trials (state leakage)', () => {
  it.each(Array.from({ length: SEQ_SEEDS }, (_, i) => i))(
    'first 14 trials of Main A run back-to-back, seed %i',
    async (seed) => {
      setSessionPRNG(`oracle-seq-${seed}`);
      resetSequencePools();
      const pair = generateMainBlockPair();
      const uids = pair.mainA.trialParams.slice(0, 14).map((p) => p.trial_meta.trial_uid);
      const nodes = pair.mainA.nodes.filter((n) => uids.includes(n.data?.trial_uid));
      const out = await runOne(nodes, seed + 100);
      const failures = [];
      const fail = (m) => failures.push(m);
      for (const p of pair.mainA.trialParams.slice(0, 14)) {
        const uid = p.trial_meta.trial_uid;
        const cond = p.trial_type;
        const mine = out.stepLog.filter((s) => s.uid === uid);
        if (!mine.length) {
          fail(`${uid}: never ran`);
          continue;
        }
        for (const s of mine) {
          if (s.bg !== p.background_shade) {
            fail(`${uid}: shade ${s.bg} in ${s.phase}`);
            break;
          }
        }
        for (const s of mine) {
          if (s.nFixDots !== 1 || s.nVis > 1) {
            fail(`${uid}: fix/vis ${s.nFixDots}/${s.nVis} in ${s.phase}`);
            break;
          }
        }
        const recs = [...out.seen.values()].filter((r) => r.uid === uid);
        const dots = recs
          .filter((r) => r.tag === 'circle' && r.phase.endsWith('_encoding'))
          .sort((a, b) => a.first - b.first);
        const items = (p.memory_items ?? [])
          .slice()
          .sort((a, b) => a.slot_index_in_seq - b.slot_index_in_seq);
        if (cond === 'd_only' || cond === 'i_d') {
          if (dots.length !== 3 || dots.some((d, i) => d.cell !== items[i].cell))
            fail(`${uid}: enc dots ${dots.map((d) => d.cell)} vs ${items.map((i) => i.cell)}`);
        }
        const stars = recs.filter((r) => r.tag === 'polygon').sort((a, b) => a.first - b.first);
        const pst = (p.stars ?? [])
          .slice()
          .sort((a, b) => a.slot_index_in_seq - b.slot_index_in_seq);
        if (pst.length && (stars.length !== 3 || stars.some((d, i) => d.cell !== pst[i].cell)))
          fail(`${uid}: stars ${stars.map((d) => d.cell)} vs ${pst.map((i) => i.cell)}`);
        if (cond !== 'i_only') {
          const pr = recs
            .filter((r) => r.tag === 'circle' && r.phase.endsWith('_probe'))
            .sort((a, b) => a.first - b.first);
          if (
            (cond === 'd_only' || cond === 'i_d') &&
            (pr.length !== 3 || pr.some((d, i) => d.cell !== p.probes[i].cell))
          )
            fail(`${uid}: probe dots ${pr.map((d) => d.cell)} vs ${p.probes.map((x) => x.cell)}`);
        }
        const rows = out.rows.filter((r) => r.trial_uid === uid);
        const nProbe = rows.filter((r) => (r.phase ?? '').endsWith('_probe')).length;
        const nStar = rows.filter((r) => (r.phase ?? '').endsWith('_star')).length;
        if (nProbe !== (cond === 'i_only' ? 0 : 3) || nStar !== (pst.length ? 3 : 0))
          fail(`${uid}: rows probes ${nProbe} stars ${nStar}`);
        for (const r of rows.filter((r) => (r.phase ?? '').endsWith('_probe'))) {
          const pp = p.probes[r.probe_position];
          if (r.probed_cell !== pp.cell || r.is_target !== pp.is_target)
            fail(`${uid}: probe row mismatch`);
          if (r.responded) {
            const said = r.response === 'arrowright';
            if (r.probe_correct !== (said === pp.is_target)) fail(`${uid}: probe_correct`);
          }
        }
      }
      if (failures.length) console.log(failures.slice(0, 30).join('\n'));
      expect(failures).toEqual([]);
      expect(vi.getTimerCount()).toBeLessThan(8);
    },
    600000
  );
});

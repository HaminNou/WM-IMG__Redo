// @vitest-environment jsdom
/**
 * Fields that identify the build and the wording, anchor the clocks and
 * describe the stimulus geometry.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { BUILD_COMMIT, BUILD_TIME } from '../src/build-info.js';
import { clockAnchor, rowClock } from '../src/clock.js';
import { computeContentHashes, getContentHashes } from '../src/content-hashes.js';
import { buildSessionInfo } from '../src/session-info.js';
import { sessionInfoNode } from '../src/session-info-node.js';
import { stampFinishedTrial } from '../src/trial-finish.js';
import { setPracticeIteration, getPracticeIteration } from '../src/scheduler/trial-meta.js';
import { slotPositionsMm } from '../src/conditions/trial-record.js';
import { patternPhaseNode } from '../src/conditions/pattern-phase.js';
import { itiNode } from '../src/conditions/shared.js';
import { bucketForRow } from '../src/uploader.js';
import { screenPositionMm } from '../src/grid.js';
import { getToneBank } from '../src/audio/tones.js';
import { config } from '../src/config.js';
import { consentBodyHtml } from '../src/calibration/consent-text.js';
import { instructionDeckTexts } from '../src/instructions/index.js';

const session = {
  params: { session_id: 's', prolific_pid: 'p', study_id: 'st', is_preview: false },
  seed_string: 'p|st|s',
  prng_seed_uint32: 7,
  schema_version: '1.2.0',
  build_id: 'v1',
  started_at_iso: '2000-01-01T00:00:00Z',
};

afterEach(() => {
  delete window.jsPsych;
  setPracticeIteration(null);
});

describe('build identity', () => {
  it('is "dev" when the code runs unbuilt', () => {
    expect(BUILD_COMMIT).toBe('dev');
    expect(BUILD_TIME).toBe('dev');
  });

  it('is written to session_info next to the human label', () => {
    const info = buildSessionInfo(session, null);
    expect(info.build_id).toBe('v1');
    expect(info.build_commit).toBe(BUILD_COMMIT);
    expect(info.build_time).toBe(BUILD_TIME);
  });
});

describe('content hashes', () => {
  it('are SHA-256 hex strings of the consent text, every deck and both questionnaires', async () => {
    const h = await computeContentHashes();
    expect(getContentHashes()).toBe(h);
    const hex = /^[0-9a-f]{64}$/;
    expect(h.consent_text_sha256).toMatch(hex);
    expect(h.strategy_items_sha256).toMatch(hex);
    expect(h.music_items_sha256).toMatch(hex);
    expect(Object.keys(h.instruction_deck_sha256)).toEqual(
      expect.arrayContaining(['overview', 'd_only', 't_only', 'i_only', 'i_d', 'i_t'])
    );
    for (const v of Object.values(h.instruction_deck_sha256)) expect(v).toMatch(hex);
  });

  it('are computed from the strings that are shown, and are stable', async () => {
    const { createHash } = await import('node:crypto');
    const sha = (t) => createHash('sha256').update(t).digest('hex');
    const a = await computeContentHashes();
    const b = await computeContentHashes();
    expect(b).toEqual(a);
    expect(a.consent_text_sha256).toBe(sha(consentBodyHtml()));
    const decks = instructionDeckTexts();
    for (const [name, text] of Object.entries(decks)) {
      expect(a.instruction_deck_sha256[name]).toBe(sha(text));
    }
  });

  it('change when the wording changes', async () => {
    const a = await computeContentHashes();
    const other = consentBodyHtml('a different payment statement');
    expect(other).not.toBe(consentBodyHtml());
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(other).digest('hex')).not.toBe(a.consent_text_sha256);
  });

  it('are written to session_info', async () => {
    const h = await computeContentHashes();
    const info = buildSessionInfo(session, null, { content_hashes: h });
    expect(info.consent_text_sha256).toBe(h.consent_text_sha256);
    expect(info.instruction_deck_sha256).toEqual(h.instruction_deck_sha256);
    expect(info.strategy_items_sha256).toBe(h.strategy_items_sha256);
    expect(info.music_items_sha256).toBe(h.music_items_sha256);
  });
});

describe('clocks', () => {
  it('clockAnchor pairs performance.now(), the time origin and the wall clock', () => {
    const c = clockAnchor();
    expect(c.time_origin_ms).toBe(performance.timeOrigin);
    expect(c.iso).toBe(new Date(c.date_now_ms).toISOString());
    expect(Math.abs(c.time_origin_ms + c.perf_now_ms - c.date_now_ms)).toBeLessThan(50);
    expect(c.jspsych_start_ms).toBeNull();
  });

  it('clockAnchor includes the start of the jsPsych timeline when there is one', () => {
    const start = new Date(1_700_000_000_000);
    window.jsPsych = { getStartTime: () => start };
    expect(clockAnchor().jspsych_start_ms).toBe(1_700_000_000_000);
  });

  it('rowClock gives wall time and jsPsych elapsed time', () => {
    window.jsPsych = { getTotalTime: () => 4321 };
    const c = rowClock();
    expect(c.time_elapsed).toBe(4321);
    expect(Math.abs(c.wall_ms - Date.now())).toBeLessThan(1000);
  });

  it('session_info carries the anchor taken when the node runs', () => {
    const node = sessionInfoNode(session);
    const data = node.data();
    expect(data.phase).toBe('session_info');
    expect(data.clock_anchor.time_origin_ms).toBe(performance.timeOrigin);
    expect(Number.isFinite(data.clock_anchor.date_now_ms)).toBe(true);
    expect(data).toHaveProperty('audio_context');
  });

  it('every finished trial row gets the wall clock', () => {
    const data = { phase: 'x' };
    stampFinishedTrial(data);
    expect(Math.abs(data.wall_ms - Date.now())).toBeLessThan(1000);
    expect(data.user_gain).toBe(1);
  });
});

describe('practice pass on practice rows', () => {
  it('is stamped on practice trial rows only', () => {
    setPracticeIteration(2);
    const practice = { block_label: 'practice' };
    const main = { block_label: 'main_a' };
    stampFinishedTrial(practice);
    stampFinishedTrial(main);
    expect(practice.practice_iteration).toBe(2);
    expect(main).not.toHaveProperty('practice_iteration');
    setPracticeIteration(null);
    expect(getPracticeIteration()).toBeNull();
  });
});

describe('tone parameters', () => {
  it('are in session_info so the stimulus can be rebuilt from the data', () => {
    const info = buildSessionInfo(session, null);
    const t = info.tone_params;
    expect(t.peak_amplitude).toBe(0.25);
    expect(t.duration_ms).toBe(config.tones.duration_ms);
    expect(t.cosine_ramp_ms).toBe(config.tones.cosine_ramp_ms);
    expect(t.bank).toHaveLength(24);
    getToneBank().forEach((tone, i) => {
      expect(t.bank[i].index).toBe(tone.index);
      expect(t.bank[i].freq_hz).toBe(tone.freq_hz);
      expect(t.bank[i].paired_cell).toBe(tone.paired_cell);
      expect(t.bank[i].gain_compensation_db).toBeCloseTo(tone.gain_compensation_db, 3);
    });
  });

  it('audio_context is written to session_info', () => {
    const ctx = {
      sample_rate_hz: 48000,
      state: 'running',
      base_latency_ms: 5,
      output_latency_ms: 20,
    };
    expect(buildSessionInfo(session, null, { audio_context: ctx }).audio_context).toEqual(ctx);
  });
});

describe('slotPositionsMm', () => {
  const params = {
    sequence: ['M', 'S', 'M', 'S', 'M', 'S'],
    memory_items: [
      { slot_index_in_seq: 0, cell: 6 },
      { slot_index_in_seq: 2, cell: 8 },
      { slot_index_in_seq: 4, cell: 16 },
    ],
    stars: [],
    dummies: [
      { slot_index_in_seq: 1, cell: 0 },
      { slot_index_in_seq: 3, cell: 4 },
      { slot_index_in_seq: 5, cell: 20 },
    ],
  };

  it('gives dots and dummies the rotated position', () => {
    const out = slotPositionsMm(params, { rotationDeg: 30, m_kind: 'dot', s_kind: 'dummy' });
    expect(out.map((s) => s.kind)).toEqual(['dot', 'dummy', 'dot', 'dummy', 'dot', 'dummy']);
    const p = screenPositionMm(8, 30);
    expect(out[2].x_mm).toBeCloseTo(p.x_mm, 2);
    expect(out[2].y_mm).toBeCloseTo(p.y_mm, 2);
    expect(out[1].cell).toBe(0);
  });

  it('gives a tone the upright position of its paired cell', () => {
    const out = slotPositionsMm(params, { rotationDeg: 30, m_kind: 'tone', s_kind: 'dummy' });
    expect(out[0].kind).toBe('tone');
    expect(out[0].x_mm).toBeCloseTo(screenPositionMm(6, 0).x_mm, 2);
    expect(out[0].y_mm).toBeCloseTo(screenPositionMm(6, 0).y_mm, 2);
  });

  it('marks the star slots', () => {
    const withStars = {
      ...params,
      memory_items: [],
      stars: [
        { slot_index_in_seq: 1, cell: 2 },
        { slot_index_in_seq: 3, cell: 9 },
        { slot_index_in_seq: 5, cell: 14 },
      ],
      dummies: [
        { slot_index_in_seq: 0, cell: 1 },
        { slot_index_in_seq: 2, cell: 3 },
        { slot_index_in_seq: 4, cell: 5 },
      ],
    };
    const out = slotPositionsMm(withStars, { rotationDeg: -40, m_kind: 'dummy', s_kind: 'star' });
    expect(out.map((s) => s.kind)).toEqual(['dummy', 'star', 'dummy', 'star', 'dummy', 'star']);
    expect(out[3].cell).toBe(9);
  });
});

describe('pattern phase and ITI rows', () => {
  it('the pattern phase stamps its onset on its row', () => {
    const data = {};
    window.jsPsych = { getCurrentTrial: () => ({ data }) };
    document.body.innerHTML = '';
    const node = patternPhaseNode({ block_label: 'main_a', trial_index_in_block: 9 });
    document.body.innerHTML = node.stimulus;
    node.on_load();
    expect(Number.isFinite(data.pattern_onset_ts_ms)).toBe(true);
    expect(node.data.trial_index_in_block).toBe(9);
  });

  it.each(['d_only', 't_only', 'i_only', 'i_d', 'i_t'])(
    '%s_iti rows go to the bucket of their condition in the main task',
    (cond) => {
      const node = itiNode({ phase: `${cond}_iti` });
      expect(node.data.phase).toBe(`${cond}_iti`);
      const bucket = bucketForRow({ phase: `${cond}_iti`, block_label: 'main_a' });
      expect(bucket.id).toBe(cond);
      expect(bucketForRow({ phase: `${cond}_iti`, block_label: 'practice' }).id).toBe('practice');
    }
  );

  it('an ITI row has the frame rotation of its frame', () => {
    expect(itiNode({ phase: 'd_only_iti' }).data.frame_rotation_deg).toBe(0);
  });
});

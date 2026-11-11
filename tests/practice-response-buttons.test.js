// @vitest-environment jsdom
/**
 * Practice-only response aids, run through the real jsPsych timeline on a fake clock:
 *  - the two response buttons under the circle exist exactly while a probe / star
 *    response window is open, in practice trials only, with the labels of the demos and
 *    the pressed key highlighted;
 *  - they change no recorded value;
 *  - the zoom notice follows the first practice trial of D-only / T-only / I-only only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initJsPsych } from 'jspsych';

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
vi.mock('../src/audio/tones.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, playToneByCell: vi.fn(() => Promise.resolve()) };
});

import { setSessionPRNG } from '../src/prng.js';
import { resetSequencePools } from '../src/scheduler/within-trial.js';
import { singleTypePractice } from '../src/scheduler/practice.js';
import { dOnlyTrial } from '../src/conditions/d_only.js';
import { tOnlyTrial } from '../src/conditions/t_only.js';
import { iOnlyTrial } from '../src/conditions/i_only.js';
import { iDTrial } from '../src/conditions/i_d.js';
import { iTTrial } from '../src/conditions/i_t.js';
import { _resetStorageForTests, initStorage } from '../src/storage.js';
import {
  PROBE_RESPONSE_MS,
  KEY_YES,
  KEY_NO,
  KEY_ON,
  KEY_OFF,
  isPracticeTrial,
} from '../src/conditions/shared.js';
import {
  PROBE_BUTTON_LABELS,
  STAR_BUTTON_LABELS,
  PRACTICE_BUTTONS_NOTICE_PHASE,
  PRACTICE_BUTTONS_NOTICE_TEXT,
  practiceButtonsNoticeNode,
  practiceProbeButtons,
  practiceStarButtons,
} from '../src/conditions/practice-buttons.js';
import {
  ARROW_KEY_SIDE,
  createTrialResponseButtons,
  responseButtonStackHtml,
  RESPONSE_BUTTON_CSS,
} from '../src/visuals/response-buttons.js';
import { computePracticeAccuracy } from '../src/scheduler/practice.js';
import {
  installHiddenNav,
  getHiddenNavTrialStartHook,
  __resetHiddenNavForTests,
} from '../src/hidden-nav.js';

const TASKS = {
  d_only: { compose: dOnlyTrial, kind: 'probe', labels: ['No', 'Yes'], notice: true },
  t_only: { compose: tOnlyTrial, kind: 'probe', labels: ['No', 'Yes'], notice: true },
  i_only: {
    compose: iOnlyTrial,
    kind: 'star',
    labels: ['Not on-pattern', 'On-pattern'],
    notice: true,
  },
  i_d: { compose: iDTrial, kind: 'both', notice: false },
  i_t: { compose: iTTrial, kind: 'both', notice: false },
};
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
const STEP_MS = 10;

const withMeta = (params, meta) => ({
  ...params,
  trial_meta: { ...params.trial_meta, ...meta },
});
const practiceParams = (task, position) => {
  setSessionPRNG(`practice-buttons-${task}`);
  resetSequencePools();
  return singleTypePractice({ trialType: task, trialsPerType: 2 }).trialParams[position];
};

const press = (key) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
/* jsPsych's own keyboard listener is on the body (the app has no display_element); an event
 * dispatched there also bubbles to window, where the nodes' own listeners are. */
const pressEverywhere = (key) => {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  );
  document.body.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
};
const release = (key) =>
  window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));

/**
 * Run one trial. The simulated participant answers every probe with ArrowLeft after 600 ms
 * and every star with ArrowRight after 700 ms. At each step it records the state of the
 * buttons next to the state of the window.
 */
async function runTrial(task, params) {
  document.body.innerHTML = '';
  const jsPsych = initJsPsych({});
  window.jsPsych = jsPsych;
  const timeline = TASKS[task].compose(params);
  timeline.forEach((n) => {
    n.data = { ...(n.data ?? {}), block_label: 'practice' };
  });
  let done = false;
  const runP = jsPsych.run(timeline).then(() => {
    done = true;
  });

  const steps = [];
  const probeSeen = new Map();
  const notice = { seen: false, arrowAdvanced: null, sawButtons: 0, text: null };
  let noticeSince = null;
  for (let t = 0; t < 120000 && !done; t += STEP_MS) {
    await vi.advanceTimersByTimeAsync(STEP_MS);
    const now = performance.now();
    const trial = jsPsych.getCurrentTrial?.();
    const phase = trial?.data?.phase ?? '';
    if (document.querySelector('.trial-start-hint')) {
      press('ArrowLeft');
      press('ArrowRight');
      release('ArrowLeft');
      release('ArrowRight');
    }
    const btns = document.querySelector('.trial-response-buttons');
    const pressed = btns
      ? [...btns.querySelectorAll('.demo-btn-stack.is-pressed')].map((s) => s.dataset.side)
      : [];
    const star = document.querySelector('polygon.star');
    let sinceProbe = null;
    if (phase.endsWith('_probe')) {
      if (!probeSeen.has(trial)) probeSeen.set(trial, { t: now, done: false });
      const p = probeSeen.get(trial);
      sinceProbe = now - p.t;
      if (!p.done && sinceProbe >= 600) {
        p.done = true;
        press('ArrowLeft');
      }
    }
    if (star) {
      if (!star.__seen) star.__seen = { t: now, done: false };
      if (!star.__seen.done && now - star.__seen.t >= 700) {
        star.__seen.done = true;
        press('ArrowRight');
      }
    }
    if (phase === PRACTICE_BUTTONS_NOTICE_PHASE) {
      if (noticeSince === null) {
        noticeSince = now;
        notice.seen = true;
        notice.text = document.querySelector('.practice-buttons-notice')?.textContent ?? null;
        notice.fixedButtons = document.querySelectorAll(
          '.trial-response-buttons:not(.trial-response-buttons--inflow)'
        ).length;
      }
      if (document.querySelector('.practice-buttons-notice .trial-response-buttons')) {
        notice.sawButtons += 1;
      }
      if (now - noticeSince < 400) {
        pressEverywhere('ArrowLeft');
        pressEverywhere('ArrowRight');
        pressEverywhere('Enter');
      } else if (notice.arrowAdvanced === null) {
        notice.arrowAdvanced =
          (jsPsych.getCurrentTrial?.()?.data?.phase ?? '') !== PRACTICE_BUTTONS_NOTICE_PHASE;
        if (!notice.arrowAdvanced) pressEverywhere(' ');
      }
    }
    steps.push({
      phase,
      now,
      sinceProbe,
      buttons: !!btns,
      labels: btns ? [...btns.querySelectorAll('.demo-btn-label')].map((l) => l.textContent) : [],
      pressed,
      starVisible: !!star,
    });
  }
  if (!done) throw new Error(`trial did not finish; last phase ${steps.at(-1)?.phase}`);
  await runP;
  return { rows: jsPsych.data.get().values(), steps, notice, jsPsych };
}

beforeEach(async () => {
  _resetStorageForTests();
  await initStorage({ backend: 'memory' });
  vi.useFakeTimers({ toFake: FAKE });
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const phaseOf = (r) => r.phase ?? '';
const strip = (row) =>
  Object.fromEntries(
    Object.entries(row).filter(
      ([k]) =>
        !/(_ts_ms|_lag_ms|^time|^rt$|clock|wall|elapsed|_at_)/.test(k) &&
        k !== 'trial_index' &&
        k !== 'is_practice'
    )
  );

describe('mapping and labels come from the key constants', () => {
  it('Right = Yes / On-pattern and Left = No / Not on-pattern', () => {
    expect(ARROW_KEY_SIDE[KEY_YES]).toBe('right');
    expect(ARROW_KEY_SIDE[KEY_NO]).toBe('left');
    expect(ARROW_KEY_SIDE[KEY_ON]).toBe('right');
    expect(ARROW_KEY_SIDE[KEY_OFF]).toBe('left');
    expect(PROBE_BUTTON_LABELS).toEqual({ left: 'No', right: 'Yes' });
    expect(STAR_BUTTON_LABELS).toEqual({ left: 'Not on-pattern', right: 'On-pattern' });
  });

  it('only practice trials get a label pair', () => {
    const p = { trial_meta: { is_practice: true } };
    const m = { trial_meta: { is_practice: false } };
    expect(practiceProbeButtons(p)).toBe(PROBE_BUTTON_LABELS);
    expect(practiceStarButtons(p)).toBe(STAR_BUTTON_LABELS);
    expect(practiceProbeButtons(m)).toBeNull();
    expect(practiceStarButtons(m)).toBeNull();
    expect(practiceProbeButtons({})).toBeNull();
    expect(isPracticeTrial({})).toBe(false);
  });
});

describe('the button pair (module)', () => {
  it('is fixed below the circle, inert, hidden from assistive tech and not focusable', () => {
    const anchor = document.createElement('div');
    document.body.appendChild(anchor);
    anchor.getBoundingClientRect = () => ({ bottom: 500, top: 100 });
    const b = createTrialResponseButtons({ labels: PROBE_BUTTON_LABELS, anchorEl: anchor });
    expect(document.querySelector('.trial-response-buttons')).toBeNull();
    b.show();
    const el = document.querySelector('.trial-response-buttons');
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelectorAll('button, a, input, [tabindex]').length).toBe(0);
    expect(parseFloat(el.style.top)).toBeGreaterThan(500);
    const css = document.getElementById('response-buttons-style').textContent;
    expect(css).toMatch(/\.trial-response-buttons \{[^}]*position: fixed/);
    expect(css).toMatch(/\.trial-response-buttons \{[^}]*pointer-events: none/);
    expect(css).toMatch(/\.demo-btn \{[^}]*pointer-events: none/);
    /* Each label has its arrow cap under it. */
    const stacks = [...el.querySelectorAll('.demo-btn-stack')];
    expect(stacks.map((s) => s.querySelector('.demo-btn-label').textContent)).toEqual([
      'No',
      'Yes',
    ]);
    expect(stacks.map((s) => s.querySelector('.demo-btn-key').textContent)).toEqual(['←', '→']);
    /* A click does nothing and the page keeps its focus. */
    const before = document.activeElement;
    stacks[0].click();
    expect(document.activeElement).toBe(before);
    b.press('ArrowRight');
    expect(stacks.map((s) => s.classList.contains('is-pressed'))).toEqual([false, true]);
    b.show();
    expect(stacks.some((s) => s.classList.contains('is-pressed'))).toBe(false);
    b.hide();
    expect(document.querySelector('.trial-response-buttons')).toBeNull();
  });

  it('uses the same markup and stylesheet text as the demonstrations', () => {
    const html = responseButtonStackHtml({ side: 'left', label: 'No' });
    expect(html).toContain('class="demo-btn"');
    expect(html).toContain('class="demo-btn-key"');
    expect(html).toContain('<button type="button"');
    expect(RESPONSE_BUTTON_CSS).toContain('.demo-btn-stack');
  });
});

describe.each(Object.keys(TASKS))(
  '%s: buttons only inside response windows, practice only',
  (task) => {
    it('practice: buttons exist exactly while a window is open, with the right labels and the pressed key', async () => {
      const { steps } = await runTrial(
        task,
        withMeta(practiceParams(task, 1), { block_position: 1 })
      );
      const spec = TASKS[task];
      const shown = steps.filter((s) => s.buttons);
      expect(shown.length).toBeGreaterThan(10);
      for (const s of steps) {
        /* Star windows: buttons == star on screen (same animation frame, same call). */
        if (s.phase.endsWith('_encoding')) expect(s.buttons).toBe(s.starVisible);
        /* Probe windows: after the first frame, until the 3000 ms window closes. */
        if (s.phase.endsWith('_probe')) {
          if (s.sinceProbe > 80 && s.sinceProbe < PROBE_RESPONSE_MS - 80)
            expect(s.buttons).toBe(true);
          if (s.sinceProbe > PROBE_RESPONSE_MS + 60) expect(s.buttons).toBe(false);
        }
        /* Nowhere else. */
        if (!/_(encoding|probe)$/.test(s.phase)) expect(s.buttons).toBe(false);
      }
      const probeShown = shown.filter((s) => s.phase.endsWith('_probe'));
      const starShown = shown.filter((s) => s.phase.endsWith('_encoding'));
      if (spec.kind !== 'star') {
        expect(probeShown.length).toBeGreaterThan(0);
        for (const s of probeShown) expect(s.labels).toEqual(['No', 'Yes']);
        /* Left was pressed at 600 ms: the left button is highlighted from then on, never before. */
        for (const s of probeShown) {
          if (s.sinceProbe < 560) expect(s.pressed).toEqual([]);
          if (s.sinceProbe > 700) expect(s.pressed).toEqual(['left']);
        }
      } else {
        expect(probeShown.length).toBe(0);
      }
      if (spec.kind !== 'probe') {
        expect(starShown.length).toBeGreaterThan(0);
        for (const s of starShown) expect(s.labels).toEqual(['Not on-pattern', 'On-pattern']);
        expect(starShown.some((s) => s.pressed.join() === 'right')).toBe(true);
        expect(starShown.every((s) => s.pressed.length <= 1)).toBe(true);
      } else {
        expect(starShown.length).toBe(0);
      }
      /* Nothing is left behind after the trial. */
      expect(document.querySelectorAll('.trial-response-buttons').length).toBe(0);
    }, 240000);

    it('main trials never show them, and the probe / star rows are identical with and without the aid', async () => {
      const base = practiceParams(task, 1);
      const aid = await runTrial(task, withMeta(base, { is_practice: true, block_position: 1 }));
      vi.useRealTimers();
      vi.useFakeTimers({ toFake: FAKE });
      const none = await runTrial(task, withMeta(base, { is_practice: false, block_position: 1 }));
      expect(none.steps.some((s) => s.buttons)).toBe(false);
      expect(aid.steps.some((s) => s.buttons)).toBe(true);
      const recorded = (rows) =>
        rows.filter((r) => /_(probe|star)$/.test(phaseOf(r))).map((r) => strip(r));
      expect(recorded(aid.rows).length).toBeGreaterThan(0);
      expect(recorded(aid.rows)).toEqual(recorded(none.rows));
      expect(phaseOf(aid.rows.at(-1))).toBe(`${task}_iti`);
      expect(aid.rows.map(phaseOf)).toEqual(none.rows.map(phaseOf));
      expect(aid.rows.map(phaseOf)).not.toContain(PRACTICE_BUTTONS_NOTICE_PHASE);
    }, 120000);
  }
);

describe.each(['d_only', 't_only', 'i_only'])(
  '%s: zoom notice after the first practice trial',
  (task) => {
    it('appears once, after the last window, before the ITI', async () => {
      const first = await runTrial(task, practiceParams(task, 0));
      const phases = first.rows.map(phaseOf);
      expect(phases.filter((p) => p === PRACTICE_BUTTONS_NOTICE_PHASE)).toHaveLength(1);
      const at = phases.indexOf(PRACTICE_BUTTONS_NOTICE_PHASE);
      expect(phases[at + 1]).toBe(`${task}_iti`);
      const lastWindow = Math.max(
        phases.lastIndexOf(`${task}_probe`),
        phases.lastIndexOf(`${task}_encoding`)
      );
      expect(lastWindow).toBe(at - 1);
      const row = first.rows[at];
      expect(row.notice_task).toBe(task);
      /* Shown with the task's labels, the message and the hint; arrow keys did nothing; Space advanced. */
      expect(first.notice.sawButtons).toBeGreaterThan(0);
      expect(first.notice.fixedButtons).toBe(0);
      expect(first.notice.text).toContain(PRACTICE_BUTTONS_NOTICE_TEXT);
      expect(first.notice.text).toContain('Press Space to continue.');
      expect(first.notice.text).toContain(TASKS[task].labels[0]);
      expect(first.notice.text).toContain(TASKS[task].labels[1]);
      expect(first.notice.arrowAdvanced).toBe(false);
      /* It adds nothing to the practice score. */
      const withoutNotice = first.rows.filter((r) => phaseOf(r) !== PRACTICE_BUTTONS_NOTICE_PHASE);
      expect(computePracticeAccuracy(first.rows)).toEqual(computePracticeAccuracy(withoutNotice));
      expect(computePracticeAccuracy([row])).toEqual({ correct: 0, total: 0, accuracy: 0 });
    }, 240000);
  }
);

describe('which trials get the notice (composed timelines)', () => {
  const phasesOf = (task, params) => TASKS[task].compose(params).map((n) => n.data.phase);
  it.each(Object.keys(TASKS))('%s', (task) => {
    const first = phasesOf(task, practiceParams(task, 0));
    const second = phasesOf(task, practiceParams(task, 1));
    const mainLike = phasesOf(
      task,
      withMeta(practiceParams(task, 0), { is_practice: false, block_position: 0 })
    );
    if (TASKS[task].notice) {
      const at = first.indexOf(PRACTICE_BUTTONS_NOTICE_PHASE);
      expect(at).toBeGreaterThan(0);
      expect(first[at + 1]).toBe(`${task}_iti`);
      /* Only that one node is added. */
      expect(first.filter((p) => p !== PRACTICE_BUTTONS_NOTICE_PHASE)).toEqual(second);
    } else {
      expect(first).not.toContain(PRACTICE_BUTTONS_NOTICE_PHASE);
    }
    expect(second).not.toContain(PRACTICE_BUTTONS_NOTICE_PHASE);
    expect(mainLike).not.toContain(PRACTICE_BUTTONS_NOTICE_PHASE);
  });

  it('the notice node is not registered with the hidden navigation (the skip neutralises it)', () => {
    const node = TASKS.d_only
      .compose(practiceParams('d_only', 0))
      .find((n) => n.data.phase === PRACTICE_BUTTONS_NOTICE_PHASE);
    expect(node._hidden_nav_checkpoint).toBeUndefined();
    expect(node.data.hidden_nav_step).toBeUndefined();
  });
});

describe('the notice node', () => {
  const params = { trial_meta: { is_practice: true, block_position: 0 }, trial_index_in_block: 0 };
  const mount = () => {
    const node = practiceButtonsNoticeNode(params, 'd_only', PROBE_BUTTON_LABELS);
    document.body.innerHTML = node.stimulus;
    node.on_load();
    return node;
  };

  it('is null for every trial that is not the first practice trial', () => {
    expect(
      practiceButtonsNoticeNode(
        { trial_meta: { is_practice: true, block_position: 1 } },
        'd_only',
        PROBE_BUTTON_LABELS
      )
    ).toBeNull();
    expect(
      practiceButtonsNoticeNode(
        { trial_meta: { is_practice: false, block_position: 0 } },
        'd_only',
        PROBE_BUTTON_LABELS
      )
    ).toBeNull();
    expect(practiceButtonsNoticeNode({}, 'd_only', PROBE_BUTTON_LABELS)).toBeNull();
  });

  it('has its own phase, takes Space only, and is not a hidden-nav checkpoint', () => {
    const node = practiceButtonsNoticeNode(params, 'i_only', STAR_BUTTON_LABELS);
    expect(node.choices).toEqual([' ']);
    expect(node.data.phase).toBe('practice_buttons_notice');
    expect(node.data.notice_task).toBe('i_only');
    expect(node._hidden_nav_checkpoint).toBeUndefined();
    expect(node.trial_duration).toBeUndefined();
  });

  it('zooms the buttons in with the Web Animations API unless reduced motion is requested', () => {
    const calls = [];
    const original = HTMLElement.prototype.animate;
    HTMLElement.prototype.animate = function (...args) {
      calls.push([this, ...args]);
      return {};
    };
    try {
      window.matchMedia = () => ({ matches: false });
      mount();
      expect(calls.length).toBe(1);
      expect(calls[0][0].querySelector('.trial-response-buttons')).not.toBeNull();
      expect(JSON.stringify(calls[0][1])).toContain('scale(');
      expect(calls[0][1][0].transform).toBe('scale(0.25)');
      calls.length = 0;
      window.matchMedia = () => ({ matches: true });
      mount();
      expect(calls.length).toBe(0);
      expect(
        document.querySelector('.practice-buttons-notice .trial-response-buttons')
      ).not.toBeNull();
    } finally {
      HTMLElement.prototype.animate = original;
      delete window.matchMedia;
    }
  });

  it('shows the buttons without animation when element.animate is missing', () => {
    const original = HTMLElement.prototype.animate;
    delete HTMLElement.prototype.animate;
    try {
      expect(() => mount()).not.toThrow();
      expect(document.querySelectorAll('.demo-btn-label').length).toBe(2);
    } finally {
      if (original) HTMLElement.prototype.animate = original;
    }
  });
});

describe('developer skip (U) and the notice', () => {
  it('after U the notice is neutralised (zero duration, no keys), and the skip still reaches the end of practice', () => {
    __resetHiddenNavForTests();
    const trialNode = { data: { phase: 'd_only_probe' } };
    const jsp = {
      timeline: {
        getLatestNode: () => ({
          description: trialNode,
          parent: { description: { timeline: [trialNode] } },
          getDataParameter: () => trialNode.data,
        }),
      },
      finishTrial: vi.fn(),
    };
    installHiddenNav(jsp);
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'u', bubbles: true, cancelable: true })
    );
    expect(jsp.finishTrial).toHaveBeenCalledTimes(1);
    const notice = practiceButtonsNoticeNode(
      { trial_meta: { is_practice: true, block_position: 0 } },
      'd_only',
      PROBE_BUTTON_LABELS
    );
    const live = { ...notice };
    getHiddenNavTrialStartHook()(live);
    expect(live.trial_duration).toBe(0);
    expect(live.choices).toBe('NO_KEYS');
    __resetHiddenNavForTests();
  });
});

describe('the pressed practice button is only bold, never coloured', () => {
  it('the injected stylesheet changes nothing but font-weight for .is-pressed', async () => {
    const { ensureResponseButtonStyles } = await import('../src/visuals/response-buttons.js');
    document.head.innerHTML = '';
    ensureResponseButtonStyles();
    const css = document.getElementById('response-buttons-style').textContent;
    const rules = [...css.matchAll(/([^{}]*\.is-pressed[^{}]*)\{([^}]*)\}/g)].map((m) => m[2]);
    expect(rules.length).toBeGreaterThan(0);
    for (const body of rules) {
      const props = body
        .split(';')
        .map((d) => d.split(':')[0].trim())
        .filter(Boolean);
      expect(props).toEqual(['font-weight']);
      expect(body).toMatch(/font-weight:\s*900/);
    }
    expect(css).not.toMatch(/is-pressed[^{}]*\{[^}]*(background|border|color|transform|shadow)/);
  });
});

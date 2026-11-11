// @vitest-environment jsdom
/**
 * Secret grid reveal: G G timing, key filters, overlay geometry/placement, persistence across
 * nodes, teardown, data rows, and that nothing is installed in production.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  installReveal,
  uninstallReveal,
  isRevealOn,
  isRevealInstalled,
  resetReveal,
  REVEAL_WINDOW_MS,
} from '../src/debug/reveal.js';
import { createGridFrame, setRotation } from '../src/visuals/frame.js';
import { addDot } from '../src/visuals/dot.js';
import { timedResponseWindowNode } from '../src/conditions/shared.js';
import { trace, _setTraceEnabled } from '../src/debug/trace.js';
import { config } from '../src/config.js';

let t;
let rows;
let logSpy;

const key = (k, init = {}, target = window) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};
const gg = (gap = 100, k = 'g') => {
  key(k);
  t += gap;
  key(k);
};
function mountFrame(opts = {}) {
  const frame = createGridFrame({ rotation_deg: 0, background_shade: 'gray', ...opts });
  document.body.appendChild(frame.wrapper);
  return frame;
}
const overlayOf = (frame) => frame.rotor.querySelector('.debug-reveal');

beforeEach(() => {
  t = 10000;
  rows = [];
  document.body.innerHTML = '';
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  window.jsPsych = {
    getCurrentTrial: () => ({ data: { trial_uid: 'main_a-001-i_d', phase: 'i_d_encoding' } }),
  };
  installReveal({ enabled: true, emitRow: (r) => rows.push(r), now: () => t });
});
afterEach(() => {
  uninstallReveal();
  vi.restoreAllMocks();
  delete window.jsPsych;
});

describe('double-press timing and key filters', () => {
  it('toggles on a second press inside the window and off again on the next pair', () => {
    mountFrame();
    gg(REVEAL_WINDOW_MS);
    expect(isRevealOn()).toBe(true);
    t += 5000;
    gg(200, 'G');
    expect(isRevealOn()).toBe(false);
    expect(rows.map((r) => r.debug_reveal_on)).toEqual([true, false]);
  });
  it('a second press after the window is just a new first press', () => {
    mountFrame();
    gg(REVEAL_WINDOW_MS + 1);
    expect(isRevealOn()).toBe(false);
    key('g'); /* pairs with the previous press which is now only 0 ms old */
    expect(isRevealOn()).toBe(true);
  });
  it('a third quick press does not toggle again', () => {
    mountFrame();
    gg(100);
    t += 100;
    key('g');
    expect(isRevealOn()).toBe(true);
    expect(rows).toHaveLength(1);
  });
  it('key repeats are ignored', () => {
    mountFrame();
    key('g');
    t += 50;
    key('g', { repeat: true });
    expect(isRevealOn()).toBe(false);
  });
  it('ctrl / meta / alt combinations and other keys are ignored', () => {
    mountFrame();
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      key('g', mod);
      t += 50;
      key('g', mod);
    }
    key('h');
    t += 50;
    key('h');
    expect(isRevealOn()).toBe(false);
  });
  it('presses in an input or textarea are ignored', () => {
    mountFrame();
    for (const tag of ['input', 'textarea']) {
      const el = document.createElement(tag);
      document.body.appendChild(el);
      el.focus();
      key('g', {}, el);
      t += 50;
      key('g', {}, el);
    }
    expect(isRevealOn()).toBe(false);
  });
  it('never prevents or stops the event (responses are not interfered with)', () => {
    mountFrame();
    const seen = [];
    window.addEventListener('keydown', (e) => seen.push(e.defaultPrevented), { capture: false });
    const e1 = key('g');
    t += 50;
    const e2 = key('g');
    expect(e1.defaultPrevented || e2.defaultPrevented).toBe(false);
    expect(seen).toEqual([false, false]); /* still delivered to later listeners */
  });
});

describe('overlay', () => {
  it('is mounted inside the rotating element, with 25 cells, ids, centre marked, pattern filled', () => {
    const frame = mountFrame({ rotation_deg: 37 });
    gg();
    const ov = overlayOf(frame);
    expect(ov).not.toBeNull();
    expect(ov.parentNode).toBe(frame.rotor);
    expect(ov.getAttribute('pointer-events')).toBe('none');
    const rects = [...ov.querySelectorAll('rect[data-debug-cell]')];
    expect(rects.map((r) => Number(r.dataset.debugCell))).toEqual([...Array(25).keys()]);
    const filled = rects
      .filter((r) => r.dataset.onPattern === '1')
      .map((r) => Number(r.dataset.debugCell));
    expect(filled.sort((a, b) => a - b)).toEqual(
      [...config.pattern.gray_pattern_cells].sort((a, b) => a - b)
    );
    expect(ov.querySelector('text[data-debug-label="12"]').textContent).toBe('12 C');
    expect(ov.querySelector('text[data-debug-label="7"]').textContent).toBe('7');
    expect(frame.wrapper.querySelector('.debug-reveal-readout').textContent).toContain('+37°');
    expect(frame.wrapper.querySelector('.debug-reveal-readout').style.pointerEvents).toBe('none');
  });
  it('is drawn under the stimuli layer, so a dot is never covered', () => {
    const frame = mountFrame();
    gg();
    const order = [...frame.svg.children];
    expect(order.indexOf(frame.rotor)).toBeLessThan(order.indexOf(frame.stimuliLayer));
    expect(frame.rotor.lastElementChild).toBe(overlayOf(frame));
  });
  it('overlay cell centres coincide with where the dots are drawn (all cells, several angles)', () => {
    for (const angle of [0, 37, -90, 145, -163]) {
      const frame = mountFrame({ rotation_deg: angle });
      gg();
      const cs = config.grid.cell_size_mm;
      const mid = (config.grid.cells_per_side * cs) / 2;
      const rad = (angle * Math.PI) / 180;
      for (let cell = 0; cell < 25; cell++) {
        const rect = overlayOf(frame).querySelector(`rect[data-debug-cell="${cell}"]`);
        const cx = Number(rect.getAttribute('x')) + cs / 2 - mid;
        const cy = Number(rect.getAttribute('y')) + cs / 2 - mid;
        const sx = mid + cx * Math.cos(rad) - cy * Math.sin(rad);
        const sy = mid + cx * Math.sin(rad) + cy * Math.cos(rad);
        const dot = addDot(frame, cell);
        const c = dot.querySelector
          ? dot.matches('circle')
            ? dot
            : dot.querySelector('circle')
          : dot;
        expect(Math.abs(Number(c.getAttribute('cx')) - sx)).toBeLessThan(1e-9);
        expect(Math.abs(Number(c.getAttribute('cy')) - sy)).toBeLessThan(1e-9);
      }
      resetReveal();
      document.body.innerHTML = '';
    }
  });
  it('labels stay upright and follow setRotation', () => {
    const frame = mountFrame({ rotation_deg: 30 });
    gg();
    const label = overlayOf(frame).querySelector('text[data-debug-label="3"]');
    expect(label.style.transform).toBe('rotate(-30deg)');
    frame.rotor.style.transition = 'transform 500ms ease-in-out';
    setRotation(frame, 80);
    expect(label.style.transform).toBe('rotate(-80deg)');
    expect(label.style.transition).toContain('500ms');
    expect(frame.wrapper.querySelector('.debug-reveal-readout').textContent).toContain('+80°');
    expect(frame.rotor.getAttribute('transform')).toContain('rotate(80');
  });
  it('causes no layout change: wrapper styling is untouched', () => {
    const frame = mountFrame();
    const before = frame.wrapper.getAttribute('style');
    gg();
    expect(frame.wrapper.getAttribute('style')).toBe(before);
    expect(frame.wrapper.querySelector('.debug-reveal-readout').style.position).toBe('absolute');
  });
  it('survives node changes within a trial: re-attached to the next frame, off again on toggle', () => {
    const f1 = mountFrame();
    gg();
    f1.wrapper.remove();
    const f2 = mountFrame({ rotation_deg: 50 });
    expect(overlayOf(f2)).not.toBeNull();
    t += 2000;
    gg();
    expect(overlayOf(f2)).toBeNull();
    expect(f2.wrapper.querySelector('.debug-reveal-readout')).toBeNull();
    expect(isRevealOn()).toBe(false);
  });
  it('is switched off by a frame of another trial and by trace.trialEnd', () => {
    const f1 = mountFrame();
    gg();
    window.jsPsych = {
      getCurrentTrial: () => ({ data: { trial_uid: 'main_a-002-d_only', phase: 'x' } }),
    };
    const f2 = mountFrame();
    expect(isRevealOn()).toBe(false);
    expect(overlayOf(f1)).toBeNull();
    expect(overlayOf(f2)).toBeNull();
    gg();
    expect(isRevealOn()).toBe(true);
    _setTraceEnabled(true);
    trace.trialEnd();
    _setTraceEnabled(false);
    expect(isRevealOn()).toBe(false);
    expect(overlayOf(f2)).toBeNull();
  });
  it('removed together with the frame at teardown', () => {
    const frame = mountFrame();
    gg();
    frame.wrapper.remove();
    expect(document.querySelector('.debug-reveal')).toBeNull();
  });
  it('pressed with no grid on screen: console note only, no row, no state', () => {
    gg();
    expect(isRevealOn()).toBe(false);
    expect(rows).toHaveLength(0);
    expect(logSpy.mock.calls.some((c) => String(c[0]).includes('no grid on screen'))).toBe(true);
  });
});

describe('console line with the trace on', () => {
  afterEach(() => _setTraceEnabled(false));
  it('is a styled timed marker at the level of the open sub-group, and opens no group', () => {
    _setTraceEnabled(true);
    const groups = vi.spyOn(console, 'group').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
    trace.trialStart({ trial_type: 'i_d' });
    trace.encodingPlan([]);
    const before = groups.mock.calls.length;
    mountFrame();
    logSpy.mockClear();
    gg();
    expect(groups.mock.calls.length).toBe(before);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const [f, ...css] = logSpy.mock.calls[0];
    expect(String(f).replace(/%c/g, '')).toMatch(
      /^\s*[+-]\d+\.\d\d s\s+── reveal ON {2}trial main_a-001-i_d/
    );
    expect(css.every((c) => typeof c === 'string')).toBe(true);
    expect(String(f)).not.toContain('[debug]');
    trace.trialEnd();
  });
});

describe('data rows', () => {
  it('writes exactly one debug_reveal row per toggle with the documented fields', () => {
    mountFrame();
    gg();
    t += 1000;
    gg();
    expect(rows).toEqual([
      {
        phase: 'debug_reveal',
        debug_reveal_on: true,
        trial_uid: 'main_a-001-i_d',
        debug_node_phase: 'i_d_encoding',
        ts: 10100,
      },
      {
        phase: 'debug_reveal',
        debug_reveal_on: false,
        trial_uid: 'main_a-001-i_d',
        debug_node_phase: 'i_d_encoding',
        ts: 11200,
      },
    ]);
  });
  it('prints a console line per toggle', () => {
    mountFrame();
    gg();
    expect(logSpy.mock.calls.filter((c) => String(c[0]).includes('reveal ON'))).toHaveLength(1);
  });
  it('a throwing row writer does not break the toggle', () => {
    uninstallReveal();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    installReveal({
      enabled: true,
      emitRow: () => {
        throw new Error('x');
      },
      now: () => t,
    });
    mountFrame();
    expect(() => gg()).not.toThrow();
    expect(isRevealOn()).toBe(true);
  });
});

describe('the g key is not a response', () => {
  it('timedResponseWindowNode ignores g presses (no early/late/extra counted, no response)', async () => {
    uninstallReveal();
    document.body.innerHTML = '<div id="m"></div>';
    window.jsPsych = { getCurrentTrial: () => ({ data: {} }) };
    const node = timedResponseWindowNode({
      mount_id: 'm',
      phase: 'p',
      onset_ms: 3000,
      allowed_keys: ['ArrowLeft', 'ArrowRight'],
    });
    const data = {};
    node.on_load();
    for (let i = 0; i < 4; i++) {
      key('g');
      key('G');
    }
    node.on_finish(data);
    expect(data.response).toBeNull();
    expect([data.early_keypresses, data.late_keypresses, data.extra_keypresses]).toEqual([0, 0, 0]);
  });
});

describe('production default', () => {
  it('with no debug flag, the debug code installs no keydown listener and nothing else', () => {
    uninstallReveal();
    const add = vi.spyOn(window, 'addEventListener');
    const addDoc = vi.spyOn(document, 'addEventListener');
    expect(installReveal({ emitRow: () => {} })).toBe(false);
    expect(isRevealInstalled()).toBe(false);
    const frame = mountFrame();
    gg();
    expect(add.mock.calls.filter((c) => c[0] === 'keydown')).toHaveLength(0);
    expect(addDoc).not.toHaveBeenCalled();
    expect(overlayOf(frame)).toBeNull();
    expect(isRevealOn()).toBe(false);
  });
});

// @vitest-environment jsdom
/**
 * The consent form, the Prolific listing (markdown + the plain-text copy kept next to the
 * program) and the configuration must say the same thing, and must not claim anything the
 * program cannot back up:
 *
 *   (a) no participant-facing "pre-registered" claim, and no "used with headphones" Prolific
 *       filter (Prolific has no such filter; the approved text says speakers are acceptable);
 *   (b) pay, duration, the screen-out payment, the filter list and the completion codes agree
 *       across consent, listing, config and pre-reg;
 *   (c) the set of device and timing fields the program records equals the documented list, and
 *       every field belongs to a class that the consent names.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/screen-out.js', () => ({
  screenOutExit: vi.fn((opts) => ({ timeline: [], conditional_function: opts.condition, opts })),
}));

import { config, PROLIFIC_PRESCREEN_SUMMARY } from '../src/config.js';
import { consentBodyHtml } from '../src/calibration/consent-text.js';
import {
  DEVICE_SNAPSHOT_FIELDS,
  TIMING_PROBE_FIELDS,
  readDisplaySnapshot,
  timingProbeNode,
} from '../src/calibration/device-probe.js';

const here = (rel) => new URL(rel, import.meta.url);
const read = (rel) => readFileSync(here(rel), 'utf8');

const consent = consentBodyHtml();
const consentText = consent.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ');
const md = read('../prolific-study-description.md');
/* The plain-text listing lives next to the program, OUTSIDE this repository, so a clean
 * clone does not have it. Its checks are skipped (with a warning) when it is absent and
 * still run, and fail on any inconsistency, wherever the file is present. */
const TXT_URL = here('../../Prolific study description.txt');
const txt = existsSync(fileURLToPath(TXT_URL)) ? readFileSync(TXT_URL, 'utf8') : null;
if (txt === null) {
  console.warn(
    'consent-prolific-consistency: ../Prolific study description.txt not found; its checks are skipped'
  );
}
/** Only the documents that exist. */
const present = (texts) => texts.filter((t) => t !== null);
const presentNamed = (pairs) => pairs.filter(([, t]) => t !== null);
const preReg = JSON.parse(read('../pre-reg/pre-reg.json'));
const indexSrc = read('../src/instructions/index.js');
const schema = JSON.parse(read('../schemas/trial.schema.json'));

/* The listing has two parts, split by explicit marker lines: the block that is pasted into
 * Prolific (readable by participants before they start, so it must hold no completion code and
 * no researcher instruction) and the researcher-only part after it. */
const PASTE_START = '<!-- PASTE-BLOCK-START -->';
const PASTE_END = '<!-- PASTE-BLOCK-END -->';
const pasteBlock = (text) => {
  const a = text.indexOf(PASTE_START);
  const b = text.indexOf(PASTE_END);
  if (a < 0 || b < a) return null;
  return text.slice(a + PASTE_START.length, b);
};
const researcherPart = (text) => text.slice(text.indexOf(PASTE_END) + PASTE_END.length);
const mdParticipant = pasteBlock(md) ?? '';
const txtParticipant = txt === null ? null : (pasteBlock(txt) ?? '');

describe('(a) no claim the program cannot back up', () => {
  it('participant-facing text does not say the exclusion rules are pre-registered', () => {
    for (const [name, text] of presentNamed([
      ['consent', consentText],
      ['listing (md)', mdParticipant],
      ['listing (txt)', txt],
    ])) {
      expect(text, name).not.toMatch(/pre-?registered|preregistered/i);
    }
    /* the practice-failure screen */
    expect(indexSrc).not.toMatch(/Our pre-registered protocol/);
    expect(indexSrc).toContain('Our protocol requires participants to demonstrate');
  });

  it('"used with headphones" is not presented as a Prolific filter anywhere', () => {
    for (const item of PROLIFIC_PRESCREEN_SUMMARY) expect(item).not.toMatch(/headphone/i);
    for (const item of preReg.sampling_plan.filters.prolific_prescreeners)
      expect(item).not.toMatch(/headphone/i);
    for (const text of present([consentText, mdParticipant, txt])) {
      expect(text).not.toMatch(/used with headphones/i);
      expect(text).not.toMatch(/strongly recommended/i);
      expect(text).toMatch(
        /speakers (are|is) acceptable|speakers, or headphones|speakers acceptable/i
      );
    }
  });

  it('describes no headphone check and no pitch check anywhere (both removed)', () => {
    for (const [name, text] of presentNamed([
      ['consent', consentText],
      ['listing (md)', mdParticipant],
      ['listing (txt)', txtParticipant],
    ])) {
      expect(text, name).not.toMatch(/headphone check/i);
      expect(text, name).not.toMatch(/pitch[- ]?(check|discrimination)/i);
      expect(text, name).not.toMatch(/eight pairs of tones|higher or lower/i);
    }
  });
});

describe('(b) consent, listing, config and pre-registration agree', () => {
  const comp = preReg.sampling_plan.compensation;

  it('lists exactly the config filters in the listing, its copy and the pre-registration; the consent does not restate them', () => {
    expect(PROLIFIC_PRESCREEN_SUMMARY).toEqual([
      'Age: 18 to 40 years',
      'First language: English',
      'Country of birth: United States',
      'Prolific approval rate: 85% or higher',
      'Hearing: no hearing loss or hearing difficulties',
      'Vision: normal or corrected-to-normal vision',
      'Cognitive health: never diagnosed with mild cognitive impairment or dementia',
    ]);
    /* the old 95% figure and the allowlist/invitation plan must not survive anywhere */
    for (const [name, text] of presentNamed([
      ['consent', consentText],
      ['listing (md)', mdParticipant],
      ['listing (txt)', txt],
      ['pre-reg', JSON.stringify(preReg)],
    ])) {
      expect(text, name).not.toMatch(/approval rate[^.]{0,40}95/i);
    }
    for (const [name, text] of presentNamed([
      ['consent', consentText],
      ['listing (md)', md],
      ['listing (txt)', txt],
      ['pre-reg filters', JSON.stringify(preReg.sampling_plan.filters)],
    ])) {
      expect(text, name).not.toMatch(/allowlist|invitation list|Invitation:/i);
    }
    expect(preReg.sampling_plan.filters.prolific_prescreeners).toEqual([
      ...PROLIFIC_PRESCREEN_SUMMARY,
    ]);
    for (const item of PROLIFIC_PRESCREEN_SUMMARY) {
      expect(mdParticipant, `md: ${item}`).toContain(item);
      if (txt !== null) expect(txt, `txt: ${item}`).toContain(item);
      expect(consentText, `consent must not restate: ${item}`).not.toContain(item);
    }
    /* the consent points to the Prolific page instead */
    expect(consentText).toMatch(/criteria are listed on the study.s Prolific page/);
    /* the md list is the list: the same number of bullets as config items */
    const bullets = mdParticipant
      .split('**Who can take part (Prolific screeners).**')[1]
      .split('Eligibility is determined')[0]
      .split('\n')
      .filter((l) => l.startsWith('- '));
    expect(bullets).toHaveLength(PROLIFIC_PRESCREEN_SUMMARY.length);
    expect(bullets).toHaveLength(7);
  });

  it('records the confirmed question wording and selected answer of the three health filters', () => {
    const researcher = md.slice(md.indexOf('# RESEARCHER ONLY'));
    expect(researcher).toMatch(/Health filters \(confirmed/);
    expect(researcher).toContain('Do you have any hearing loss or hearing difficulties?');
    expect(researcher).toContain('Do you have normal or corrected-to-normal vision?');
    expect(researcher).toContain(
      'Have you ever been diagnosed with mild cognitive impairment or dementia?'
    );
    expect(researcher).toMatch(
      /Selected answer: No\..*\n[\s\S]*Selected answer: Yes\.[\s\S]*Selected answer: No\./
    );
    if (txt !== null) expect(txt).toContain('Health filters (confirmed');
  });

  it('does not present the device requirement as a Prolific filter (Prolific says device options do not filter)', () => {
    expect(PROLIFIC_PRESCREEN_SUMMARY.some((i) => /^device/i.test(i))).toBe(false);
    expect(preReg.sampling_plan.filters.prolific_prescreeners.some((i) => /^device/i.test(i))).toBe(
      false
    );
    expect(mdParticipant).not.toMatch(/^- Device:/m);
    if (txtParticipant !== null) expect(txtParticipant).not.toMatch(/^- Device:/m);
    expect(mdParticipant).toMatch(
      /Prolific shows this requirement on the study page, and the first step of the study checks it/
    );
  });

  it('states the same pay, hourly rate and duration', () => {
    const pay = comp.pay_amount; /* "$26" */
    expect(pay).toBe('$26');
    const minutes = comp.estimated_session_minutes;
    expect(minutes).toBe(110);
    for (const [name, text] of presentNamed([
      ['consent', consentText],
      ['listing (md)', mdParticipant],
      ['listing (txt)', txt],
    ])) {
      expect(text, name).toContain(`${pay}`);
      expect(text, name).toMatch(new RegExp(`${minutes} minutes`));
      expect(text, name).toMatch(/about \$14 per hour/);
      expect(text, name).toMatch(/approximately \$12\.00 per hour/);
      expect(text, name).not.toMatch(/\$13\.00/);
    }
    /* $26 for 110 minutes really is about $14 an hour, and above Prolific's $12 */
    const perHour = (Number(pay.replace('$', '')) / minutes) * 60;
    expect(perHour).toBeGreaterThan(14);
    expect(perHour).toBeLessThan(14.5);
  });

  it('states one fixed screen-out payment, the same in config, pre-reg, consent and listings', () => {
    const text = config.prolific.payment_policy_text;
    expect(text).toMatch(/\$0\.14/);
    expect(preReg.config_locked.prolific.payment_policy_text).toBe(text);
    expect(comp.payment_for_screened_out_time).toContain('$0.14');
    expect(consentText).toContain(text);
    for (const t of present([mdParticipant, txt])) {
      expect(t).toMatch(/fixed screen-out payment of \$0\.14/);
    }
    for (const t of present([
      consentText,
      mdParticipant,
      txt,
      JSON.stringify(preReg.sampling_plan),
    ])) {
      expect(t).not.toMatch(/in proportion to time|pro rata/i);
    }
    /* "no bonus payments" and a screen-out payment cannot contradict each other */
    if (txt !== null) expect(txt).toMatch(/no bonus payments/i);
  });

  it('keeps the completion codes in the researcher-only part, never in the pasted block', () => {
    const normal = new URL(config.prolific.completion_url).searchParams.get('cc');
    const screenOut = config.prolific.screen_out_completion_code;
    expect(normal).toBeTruthy();
    expect(screenOut).toBeTruthy();
    expect(normal).not.toBe(screenOut);
    /* the codes ARE the payment: nobody who can read the listing may be able to claim them */
    for (const [name, text] of presentNamed([
      ['md paste block', mdParticipant],
      ['txt paste block', txtParticipant],
      ['consent', consentText],
    ])) {
      expect(text, name).not.toContain(normal);
      expect(text, name).not.toContain(screenOut);
      expect(text, name).not.toMatch(/\bcc=/);
    }
    /* ...and the researcher section names exactly the config codes and the checklist wording */
    for (const t of present([md, txt])) {
      const rs = researcherPart(t);
      expect(rs).toContain(normal);
      expect(rs).toContain(screenOut);
      expect(rs).toContain(config.prolific.completion_url);
      expect(rs).toContain(`(currently ${screenOut})`);
    }
  });

  it('the pasted block is delimited by marker lines and holds no researcher instruction', () => {
    for (const [name, text] of presentNamed([
      ['md', md],
      ['txt', txt],
    ])) {
      expect(text.split(PASTE_START), `${name}: one start marker`).toHaveLength(2);
      expect(text.split(PASTE_END), `${name}: one end marker`).toHaveLength(2);
      expect(text.indexOf(PASTE_START)).toBeLessThan(text.indexOf(PASTE_END));
      const block = pasteBlock(text);
      expect(block, name).toContain('## Full description');
      expect(block, name).not.toMatch(/RESEARCHER ONLY|researcher-only|checklist|Edit this list/i);
      expect(block, name).not.toMatch(/src\/config\.js|PROLIFIC_PRESCREEN_SUMMARY|pre-reg\.json|`/);
      expect(researcherPart(text), name).toMatch(/^# RESEARCHER ONLY/m);
    }
  });

  it('the plain-text copy beside the program is a verbatim copy of the master', () => {
    if (txt === null) return; /* absent in a clean clone: warned above */
    expect(txtParticipant).toBe(mdParticipant);
    expect(researcherPart(txt)).toBe(researcherPart(md));
    expect(txt).toBe(md);
  });

  it('states the practice criterion that the build uses, in both listings', () => {
    const pct = `${Math.round(config.practice.accuracy_criterion * 100)}%`;
    for (const t of present([mdParticipant, txt])) {
      expect(t).toContain(`at least ${pct} correct`);
      expect(t).not.toMatch(/7 of 8/);
    }
  });

  it('has no unfilled placeholder in any participant-facing document', () => {
    for (const t of present([consent, md, txt])) expect(t).not.toMatch(/\[[A-Z][A-Z0-9_ ]*\]/);
  });

  it('the consent says what happens to the Prolific ID: private files, a random code for analysis and sharing', () => {
    const flat = consentText.replace(/\s+/g, ' ');
    expect(flat).toMatch(/stored under that ID in private research files/);
    expect(flat).toMatch(/replaced by a random code in the files used for analysis and sharing/);
    expect(flat).not.toMatch(/stored and analyzed under that ID/);
    for (const t of present([mdParticipant, txtParticipant])) {
      expect(t.replace(/\s+/g, ' ')).toMatch(
        /ID is replaced by a random code in the files used for analysis and sharing/
      );
    }
  });

  it('the consent keeps the data-kept-after-stopping and storage statements', () => {
    expect(consentText).toMatch(/Data that your browser has already sent before you stop are kept/);
    expect(consentText).toMatch(/encrypted connection/);
    if (txt !== null) {
      expect(txt).toMatch(/Data that your browser has already sent before you stop are kept/);
      expect(txt).toMatch(/encrypted connection/);
    }
  });
});

describe('(c) the device fields recorded equal the documented list', () => {
  /* Every recorded field belongs to a class named in the consent. */
  const CLASSES = {
    'the browser and operating system': ['user_agent', 'platform', 'ua_mobile'],
    'screen and window size': [
      'dpr',
      'screen_w',
      'screen_h',
      'avail_w',
      'avail_h',
      'color_depth',
      'inner_w',
      'inner_h',
      'outer_w',
      'outer_h',
      'orientation',
      'zoom_proxy_outer_inner',
      'visual_viewport_scale',
    ],
    'whether the page is hidden, zoomed, or leaves fullscreen': [
      'is_fullscreen',
      'page_hidden_during_probe',
    ],
    'display refresh rate and timer accuracy': [
      'snap_iso',
      'frame_n',
      'frame_median_ms',
      'frame_mean_ms',
      'frame_sd_ms',
      'frame_p95_ms',
      'frame_max_ms',
      'frame_dropped_frac',
      'refresh_hz_est',
      'clock_resolution_ms',
      'timeout_overshoot_median_ms',
      'timeout_overshoot_p95_ms',
      'timeout_overshoot_max_ms',
      'cross_origin_isolated',
    ],
  };
  const REMOVED = [
    'hardware_concurrency',
    'device_memory_gb',
    'forced_colors',
    'prefers_dark',
    'prefers_reduced_motion',
    'display_gamut_p3',
    'battery_api',
    'battery_charging',
    'battery_level',
  ];

  it('the consent names every class of field that is recorded', () => {
    for (const phrase of Object.keys(CLASSES)) {
      expect(consentText.replace(/\s+/g, ' ')).toContain(phrase);
    }
  });

  it('every recorded field belongs to exactly one named class, and no class lists a field that is not recorded', () => {
    const recorded = [...DEVICE_SNAPSHOT_FIELDS, ...TIMING_PROBE_FIELDS].sort();
    const documented = Object.values(CLASSES).flat().sort();
    expect(documented).toEqual(recorded);
    expect(new Set(recorded).size).toBe(recorded.length);
  });

  it('readDisplaySnapshot returns exactly the documented snapshot fields', () => {
    expect(Object.keys(readDisplaySnapshot()).sort()).toEqual([...DEVICE_SNAPSHOT_FIELDS].sort());
  });

  it('the fields that are not needed and not named in the consent are gone from code and schema', () => {
    const snapshot = readDisplaySnapshot();
    const props = Object.keys(schema.properties ?? schema.$defs?.row?.properties ?? {});
    for (const f of REMOVED) {
      expect(snapshot, f).not.toHaveProperty(f);
      expect(props, `schema: ${f}`).not.toContain(f);
    }
    const probeSrc = read('../src/calibration/device-probe.js');
    for (const f of [
      'getBattery',
      'hardwareConcurrency',
      'deviceMemory',
      'prefers-',
      'color-gamut',
    ]) {
      expect(probeSrc, f).not.toContain(f);
    }
  });

  it('every documented field is described in the trial schema', () => {
    const props = Object.keys(schema.properties ?? schema.$defs?.row?.properties ?? {});
    expect(props.length).toBeGreaterThan(50);
    for (const f of [...DEVICE_SNAPSHOT_FIELDS, ...TIMING_PROBE_FIELDS]) {
      expect(props, `schema: ${f}`).toContain(f);
    }
  });

  it('the real timing probe records exactly the documented keys (and nothing else)', async () => {
    const finishTrial = vi.fn();
    globalThis.window.jsPsych = { finishTrial };
    const raf = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
    window.requestAnimationFrame = globalThis.requestAnimationFrame;
    try {
      const node = timingProbeNode();
      await node.timeline[0].timeline[0].on_load();
    } finally {
      globalThis.requestAnimationFrame = raf;
    }
    expect(finishTrial).toHaveBeenCalledTimes(1);
    const data = finishTrial.mock.calls[0][0];
    const expected = new Set([
      ...DEVICE_SNAPSHOT_FIELDS,
      ...TIMING_PROBE_FIELDS,
      'timing_ok',
      'timing_fail_reasons',
      'thresholds',
      'probe_attempt',
    ]);
    expect(new Set(Object.keys(data))).toEqual(expected);
  }, 20000);
});

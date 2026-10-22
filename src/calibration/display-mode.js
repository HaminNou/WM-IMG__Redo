/**
 * Display-mode check slide — runs before the credit-card screen calibration
 * so the participant locks the experiment to light mode BEFORE the
 * pixel-per-millimetre measurement happens on the corrected surface.
 *
 * Background. The page-level `color-scheme: light only` declaration in
 * index.html disables Chrome / Edge automatic dark-mode forcing for the
 * experiment surface and covers the great majority of participants.
 * A small minority (kiosk profiles, OS-level colour filters, Windows
 * High Contrast Mode, embedded mobile webviews) still repaint the
 * background darker than designed. Clicking "Force light mode" engages
 * a sticky `html.display-colour-locked` class with `!important`
 * background fills (see index.html). One-way switch — once engaged, it
 * stays on for the session.
 *
 * Continue gate. The Continue button is rendered disabled
 * and only becomes interactive once the participant has engaged the
 * lock (either by clicking "Force light mode" on this slide, or by
 * re-entering the slide via hidden-nav with the lock already engaged
 * from a previous visit). This makes lock-engagement an explicit
 * gesture for every participant rather than an opt-in the participant
 * can blow through without reading. The data row therefore agrees with
 * the lock state on every export.
 *
 * The participant's choice is stamped into `display_colour_locked` on
 * both this row and the subsequent screen-calibration row (the lock
 * state is read fresh each time, so the values agree). The CSV exporter
 * sources its `Display_Colour_Locked` column from the calibration row.
 */
import htmlButtonResponse from '@jspsych/plugin-html-button-response';
import { registerHiddenNavStep, trackHiddenNavNode } from '../hidden-nav.js';
import { lockDisplayColours, isDisplayColourLocked } from '../visuals/display-colour-lock.js';

const DISPLAY_MODE_CHECK_STEP_ID = 'display_mode_check';

const HTML = `
  <h2>Display check</h2>
  <div data-voiceover-target style="max-width: 38rem; margin: 0 auto 1.25rem;">
    <p>
      To make sure the experiment looks the same on every participant's
      screen, please <strong>lock the display to light mode</strong> by
      clicking the button below. The lock stays engaged for the rest of
      the session.
    </p>
    <p style="font-size: 0.95rem; color: rgba(0, 0, 0, 0.7);">
      The panel around this text should look like a uniform
      <strong>light gray</strong>. If it looks darkened or hard to read,
      locking light mode will restore it.
    </p>
  </div>
  <div id="display-mode-check-footer" style="margin: 1.5rem auto 0; max-width: 38rem; text-align: center;">
    <button id="display-colour-lock-btn" type="button"
            style="font-size: 0.95rem; padding: 0.55rem 1.1rem; cursor: pointer;">
      Force light mode
    </button>
    <div id="display-colour-lock-status" role="status" aria-live="polite"
         style="visibility: hidden; margin-top: 0.5rem; color: #0a7c4d; font-weight: 600; font-size: 0.95rem;">
      ✓ Display set to light mode
    </div>
  </div>
  <p id="display-mode-gate-hint" role="status" aria-live="polite"
     style="margin: 1.25rem auto 0; max-width: 38rem; text-align: center;
            font-size: 0.95rem; color: rgba(0, 0, 0, 0.65);">
    Click <strong>Force light mode</strong> above to enable
    <strong>Continue</strong>.
  </p>
`;

export function displayModeCheckTrial() {
  const node = {
    type: htmlButtonResponse,
    stimulus: HTML,
    choices: ['Continue'],
    /* The Continue button is rendered disabled (mirroring the consent
     * slide's pattern) so the participant cannot bypass the lock by
     * skipping the gesture. `on_load` flips it to enabled once the lock
     * is engaged (either by an in-slide click or by re-entry after a
     * previous engagement). */
    button_html: (choice, idx) =>
      `<button class="jspsych-btn" data-idx="${idx}" disabled aria-disabled="true" style="opacity: 0.55; cursor: not-allowed;">${choice}</button>`,
    on_load: () => {
      const lockBtn = document.getElementById('display-colour-lock-btn');
      const lockStatus = document.getElementById('display-colour-lock-status');
      const gateHint = document.getElementById('display-mode-gate-hint');
      const continueBtn = document.querySelector('button.jspsych-btn[data-idx="0"]');

      const openGate = () => {
        if (continueBtn) {
          continueBtn.disabled = false;
          continueBtn.setAttribute('aria-disabled', 'false');
          continueBtn.style.opacity = '';
          continueBtn.style.cursor = '';
        }
        if (gateHint) gateHint.style.display = 'none';
      };

      const reflectLockedState = () => {
        if (lockBtn) {
          lockBtn.disabled = true;
          lockBtn.setAttribute('aria-disabled', 'true');
          lockBtn.style.opacity = '0.55';
          lockBtn.style.cursor = 'default';
          lockBtn.textContent = 'Light mode forced';
        }
        if (lockStatus) lockStatus.style.visibility = 'visible';
        openGate();
        /* Shift keyboard focus to Continue so the participant can press
         * Enter / Space immediately without re-grabbing the pointer. */
        if (continueBtn && typeof continueBtn.focus === 'function') {
          continueBtn.focus();
        }
      };

      if (isDisplayColourLocked()) {
        /* Defence-in-depth: if the participant landed back on this slide
         * via hidden-nav after engaging the lock on an earlier visit,
         * reflect that state on re-render rather than showing an idle
         * button and a disabled Continue. */
        reflectLockedState();
      } else if (lockBtn) {
        lockBtn.addEventListener('click', () => {
          lockDisplayColours();
          reflectLockedState();
        });
      }
    },
    on_finish: (data) => {
      data.display_colour_locked = isDisplayColourLocked();
    },
    data: { phase: 'display_mode_check' },
  };
  registerHiddenNavStep(DISPLAY_MODE_CHECK_STEP_ID, displayModeCheckTrial);
  return trackHiddenNavNode(node, DISPLAY_MODE_CHECK_STEP_ID);
}

// @vitest-environment jsdom
/**
 * Regression: "Cannot read properties of null (reading 'className')" after Space on the
 * practice-buttons notice.
 *
 * Cause: the experimenter's hidden-nav skip (U) ended the current node with
 * `jsPsych.finishTrial` and left that plugin's keyboard listener registered. The next Space
 * (ending the notice) was also delivered to that dead listener, whose display element was
 * already replaced, so htmlKeyboardResponse's after_response threw. The real engine and the
 * real notice node run here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { initJsPsych } from 'jspsych';
import htmlKeyboardResponse from '@jspsych/plugin-html-keyboard-response';

import { practiceButtonsNoticeNode } from '../src/conditions/practice-buttons.js';
import { installHiddenNav, __resetHiddenNavForTests } from '../src/hidden-nav.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const press = (key) => {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  );
  document.body.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
};
const params = { trial_meta: { is_practice: true, block_position: 0 }, trial_index_in_block: 0 };

let errors;
const onError = (e) => {
  errors.push(e.error?.message ?? e.message);
  e.preventDefault();
};
afterEach(() => {
  window.removeEventListener('error', onError);
  __resetHiddenNavForTests();
});

describe('hidden-nav skip leaves no live keyboard listener', () => {
  for (const skipKey of ['u']) {
    it(`Space on the notice after a ${skipKey.toUpperCase()} skip raises no error`, async () => {
      errors = [];
      window.addEventListener('error', onError);
      document.body.innerHTML = '';
      const jsPsych = initJsPsych();
      installHiddenNav(jsPsych);
      const notice = practiceButtonsNoticeNode(params, 'd_only', { left: 'No', right: 'Yes' });
      const timeline = [
        { type: htmlKeyboardResponse, stimulus: 'a', choices: [' '], data: { phase: 'screen_a' } },
        { type: htmlKeyboardResponse, stimulus: 'b', choices: [' '], data: { phase: 'screen_b' } },
        notice,
        { type: htmlKeyboardResponse, stimulus: 'after', choices: 'NO_KEYS', trial_duration: 2000 },
      ];
      jsPsych.run(timeline);
      await sleep(30);
      expect(jsPsych.pluginAPI.listeners.size).toBe(1);
      press(' '); // screen_a ends normally
      await sleep(30);
      expect(jsPsych.getCurrentTrial().data.phase).toBe('screen_b');
      press(skipKey); // experimenter skip ends screen_b through finishTrial
      await sleep(30);
      expect(jsPsych.getCurrentTrial().data.phase).toBe('practice_buttons_notice');
      expect(jsPsych.pluginAPI.listeners.size).toBe(1);
      press(' ');
      await sleep(30);
      expect(errors).toEqual([]);
      expect(jsPsych.getCurrentTrial().stimulus).toBe('after');
    });
  }
});

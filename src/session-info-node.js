/**
 * jsPsych node that writes the `session_info` row (see session-info.js).
 * It takes no time: no stimulus, no keys, zero duration.
 */
import htmlKeyboardResponse from '@jspsych/plugin-html-keyboard-response';

import { buildSessionInfo } from './session-info.js';
import { clockAnchor } from './clock.js';
import { getContentHashes } from './content-hashes.js';
import { audioContextInfo } from './audio/context.js';

export function sessionInfoNode(session) {
  return {
    type: htmlKeyboardResponse,
    stimulus: '',
    choices: 'NO_KEYS',
    trial_duration: 0,
    data: () => {
      const rows =
        window.jsPsych?.data?.get?.().filter({ phase: 'screen_calibration_outcome' }).values() ??
        [];
      const calibration = rows.length ? (rows[rows.length - 1].value ?? null) : null;
      return buildSessionInfo(session, calibration, {
        screen_width_px: window.screen?.width,
        screen_height_px: window.screen?.height,
        inner_width_px: window.innerWidth,
        inner_height_px: window.innerHeight,
        device_pixel_ratio: window.devicePixelRatio,
        clock_anchor: clockAnchor(),
        audio_context: audioContextInfo(),
        content_hashes: getContentHashes(),
      });
    },
  };
}

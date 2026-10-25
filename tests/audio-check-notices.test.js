// @vitest-environment jsdom
/**
 * Hearing-protection reminder on the audio check screens (ethics review E14):
 * every screen that asks the participant to keep or raise the volume also
 * tells them they can lower it or stop. The screens are silent (no narration
 * target), so no recording depends on this text.
 */
import { describe, expect, it } from 'vitest';
import { headphoneCheckBlock, pitchCheckChain } from '../src/calibration/audio-check.js';

const REMINDER = 'If any sound is uncomfortable, lower the volume or stop at any time.';
const text = (html) => html.replace(/\s+/g, ' ');

describe('audio check screens carry the hearing-protection reminder', () => {
  it('headphone-check intro', () => {
    const intro = headphoneCheckBlock().timeline[0];
    expect(intro.data.phase).toBe('headphone_check_intro');
    expect(text(intro.stimulus)).toContain(REMINDER);
  });

  it('pitch-check retry hint (the screen that asks to raise the volume)', () => {
    const chain = pitchCheckChain();
    const retry = chain.timeline[0].timeline[0].timeline[0];
    expect(retry.data.phase).toBe('pitch_check_retry_hint');
    expect(text(retry.stimulus)).toContain('Raise your computer volume');
    expect(text(retry.stimulus)).toContain(REMINDER);
  });

  it('neither screen is narrated, so no voiceover string depends on the wording', () => {
    const intro = headphoneCheckBlock().timeline[0];
    const retry = pitchCheckChain().timeline[0].timeline[0].timeline[0];
    expect(intro.stimulus).not.toContain('data-voiceover-target');
    expect(retry.stimulus).not.toContain('data-voiceover-target');
  });
});

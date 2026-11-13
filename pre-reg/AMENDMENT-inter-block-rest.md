# Amendment note: rest of up to 10 minutes between the two blocks

Date: 2026-11-13. Status: made before confirmatory data collection. This is a change to `config_locked` (`blocks.inter_block_rest_max_s`, new, 600), so it is recorded as an amendment. An earlier version of this note (120 seconds, skippable with Space) was replaced the same day and was never used for data collection.

## What changed

- Before 2026-11-13 the rest between Block 1 and Block 2 was 30 seconds, forced, with no early end. The rationale was a uniform inter-block delay: all participants wait the same time, so differences in break length cannot contribute to the Block 1 versus Block 2 contrast.
- Now the rest between the blocks lasts at most 600 seconds, 10 minutes (`blocks.inter_block_rest_max_s`, a maximum). The participant may end it early by pressing the Left and Right arrow keys together (both keys down within 300 ms, the same rule as the "press both arrow keys to start the next trial" gate). Arrow presses are ignored during the first 2 seconds so that a key carried over from the previous screen cannot end the rest. Space no longer ends it. When the rest ends early, the Block 2 intro appears and waits for Space, as before.
- If the 10 minutes pass without both arrow keys being pressed, the session ends: the participant sees "You did not return to the experiment within 10 minutes, so the session has ended. You will now be sent back to Prolific.", the rows collected so far are uploaded, the exit row carries `exit_reason = inter_block_rest_timeout`, and the participant is redirected to Prolific with the existing screen-out completion code (`config.prolific.screen_out_completion_code`). The rule is registered in `pre-reg.json` under `collection_time_screen_outs` (`inter_block_rest_timeout`, `threshold_s = 600`, source `src/conditions/rest.js`). Such a session is not completed and is not counted.
- The rest screen states the three facts at its start (a break of up to 10 minutes; press the Left and Right arrow keys together when ready; if not back within 10 minutes the participant is sent back to Prolific) with an m:ss countdown. In the last 60 seconds the countdown turns bold red and a line says "Press both arrow keys now to continue, or you will be sent back to Prolific."
- The instruction slide shown after the practice (`main_a_intro`) states the same three facts in its sentence about the rests (the number is derived from the config value). Its narration was re-recorded with the same voice, rate and format.
- The intra-block rests are unchanged: 30 seconds (`blocks.rest_duration_s`), forced, no early end, after trials 20 and 40 in Block 1 and 15, 30 and 45 in Block 2.

## Consequence for the data

The actual inter-block delay now varies by participant. It is recorded on the `rest` row with `block_label = inter_block`: `rest_planned_s` (600), `rest_actual_ms` (time from the start of the screen to its end), `rest_skipped` (true if the participant ended it early with both arrow keys) and `rest_timed_out` (true if the full time ran out; then the exit row follows). The older fields `rest_started_ts_ms` and `rest_ended_ts_ms` are still written. Rest rows of the intra-block rests carry the same fields with `rest_skipped = false` and `rest_timed_out = false`.

## Consequences for the study procedure (flag for the researcher)

- Session length: a participant who takes the whole rest needs up to about 10 minutes more than with the 30-second rest (less if the rest is ended early). The estimate of about 110 minutes in the consent form and the Prolific listing is NOT changed by this edit; whether it should be is the researcher's decision. The consent form and the listing were not edited.
- Completion code: a participant who times out is sent to Prolific with the existing screen-out completion code, so on Prolific this is recorded and paid like the other screen-outs (the fixed screen-out reward). Which code a timed-out participant should get is the researcher's decision; a dedicated code can be created in Prolific and configured later.
- The consent form and the listing do not mention this exit. The rest rule is stated to the participant on the instruction slide and at the start of the rest.

## What did not change

No hypothesis, test, threshold, exclusion rule, trial count, trial order or counterbalancing rule changed.

## For the researcher: wording for the OSF amendment / transparent changes note

> Amendment (2026-11-13, before confirmatory data collection). The rest between the two blocks of the main task was changed from a forced 30-second rest (rationale: a uniform inter-block delay) to a rest of up to 10 minutes. Participants may end it early by pressing the Left and Right arrow keys together (after the first 2 seconds); if they have not returned to the experiment within 10 minutes the session ends and they are sent back to Prolific with the screen-out completion code. The actual inter-block rest duration therefore varies across participants; it is recorded for each participant (planned maximum, actual duration in milliseconds, whether the rest was ended early, and whether it timed out). The 30-second intra-block rests are unchanged. No hypothesis, statistical test, threshold or exclusion rule was changed. The session length grows by up to about 10 minutes for a participant who takes the whole rest; the estimated session length stated to participants (110 minutes) was not changed.

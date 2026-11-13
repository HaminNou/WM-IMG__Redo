# Amendment note: 120-second, skippable rest between the two blocks

Date: 2026-11-13. Status: made before confirmatory data collection. This is a change to `config_locked` (`blocks.inter_block_rest_duration_s`, new, 120), so it is recorded as an amendment.

## What changed

- Before 2026-11-13 the rest between Block 1 and Block 2 was 30 seconds, forced, with no skip option. The rationale was a uniform inter-block delay: all participants wait the same time, so differences in break length cannot contribute to the Block 1 versus Block 2 contrast.
- Now the rest between the blocks is 120 seconds (`blocks.inter_block_rest_duration_s`) and the participant may skip it by pressing Space (Space is ignored during the first 2 seconds so that a key press carried over from the previous screen cannot skip it). The screen shows an m:ss countdown and the hint "You can skip the rest by pressing Space when you are ready." When the timer ends or the rest is skipped, the Block 2 intro appears and waits for Space, as before.
- The intra-block rests are unchanged: 30 seconds (`blocks.rest_duration_s`), forced, no skip, after trials 20 and 40 in Block 1 and 15, 30 and 45 in Block 2.
- The instruction slide shown after the practice now says there is a 2-minute rest between the two blocks which the participant can skip (the number is derived from the config value). Its narration was re-recorded with the same voice, rate and format.

## Consequence for the data

The actual inter-block delay now varies by participant. It is recorded on the `rest` row with `block_label = inter_block`: `rest_planned_s` (120), `rest_actual_ms` (time from the start of the screen to its end) and `rest_skipped` (true if the participant ended it early). The older fields `rest_started_ts_ms` and `rest_ended_ts_ms` are still written. Rest rows of the intra-block rests carry the same three fields with `rest_skipped = false`.

## What did not change

No hypothesis, test, threshold, exclusion rule, trial count, trial order or counterbalancing rule changed. The session-length estimate grows by at most 90 seconds (120 s instead of 30 s for a participant who waits the whole rest; less if the rest is skipped), which does not change the stated estimate of about 110 minutes in a meaningful way.

## For the researcher: wording for the OSF amendment / transparent changes note

> Amendment (2026-11-13, before confirmatory data collection). The rest between the two blocks of the main task was changed from a forced 30-second rest without a skip option (rationale: a uniform inter-block delay) to a 120-second rest that participants may skip by pressing Space after the first 2 seconds. The actual inter-block rest duration therefore varies across participants; it is recorded for each participant (planned duration, actual duration in milliseconds, and whether the rest was skipped). The 30-second intra-block rests are unchanged. No hypothesis, statistical test, threshold or exclusion rule was changed, and the estimated session length increases by at most 90 seconds.

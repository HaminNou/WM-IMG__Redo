# Experimenter debug tools

Two tools for the experimenter, both OFF unless switched on by the URL:

1. a console trace of every trial (angles, cells, ON/OFF tags, targets and foils, keys, truth values, feedback);
2. a secret key (press **G** twice) that shows the hidden grid and pattern inside the circle;
3. a secret stage-skip key (press **N** twice) that jumps forward one stage of the session (see "Stage skip: N N").

**Never use them with real participants.** They show the answers. Code is in `src/debug/`
(`debug-mode.js`, `trace.js`, `reveal.js`, `skip.js`).

## How to switch them on

**The deployed site has them OFF.** The normal production build (`npm run build`, what is deployed for
participants) is built without `VITE_ENABLE_DEBUG`, so no URL can turn the trace or the reveal on there. To use them:

- locally: `npm run dev` (a dev server allows debug), then open `http://localhost:5173/?debug=1`;
- or build the debug version: `npm run build:debug` (sets `VITE_ENABLE_DEBUG=1`) and serve `dist/` yourself
  (for example `npx vite preview`) or deploy it to a separate test location, never to the participants' link;
- the exact code of the version deployed on 2026-11-11 WITH the debug tools active is kept as the git tag
  `debug-enabled-v1` (`git checkout debug-enabled-v1`).

In a build that allows debug, add `debug=1` to the URL. It counts only on an experimenter session, that is when one of these holds:

- the URL also has `pilot=1`;
- it is a Vite dev build (`npm run dev`);
- the page is served from `localhost`, `127.0.0.1` or `[::1]`.

| URL                                                                       | Debug                             |
| ------------------------------------------------------------------------- | --------------------------------- |
| `https://host/?PROLIFIC_PID=..&STUDY_ID=..&SESSION_ID=..&debug=1`         | OFF (not an experimenter session) |
| `https://host/?PROLIFIC_PID=..&STUDY_ID=..&SESSION_ID=..&pilot=1&debug=1` | ON                                |
| `http://localhost:5173/?debug=1`                                          | ON                                |
| `http://localhost:5173/`                                                  | OFF                               |

Only the URL is read (never storage, cookies or Prolific parameters), once, at page load. Reload to change it.
When it is off there is no console output, no key listener, no overlay and no extra work.
Pilot link example (for the experimenter's own test run): `...&pilot=1&pilot_label=my-check&debug=1`.

## Console legend

Opening the console (F12) shows a banner with the legend, the URL flags, build and seed, then one group per trial.

```
TRIAL 17/120  [Stars + Dots]  main_a #17  pool 5  shade=gray  rotation=+37° (clockwise)  reminder=yes
   +0.00 s  ⚙ GATE
   +0.40 s  ⚙ ARROW CUE  arrow=+37°  rotation=+37° (clockwise)  duration=1000 ms
   +1.50 s  ⚙ IMAGINATION  duration=3000 ms
   +4.50 s  ⚙ ROTATION TURN  rotation=+37° (clockwise)  duration=500 ms
  ┌ ENCODING
  │ (table: slot, pos, kind, cell, row/col, ON/OFF, tone, planned onset, tested as)
  │  +1.00 s  slot 2  ● DOT  cell 7 (r1,c2)  ON
  │  +3.00 s  slot 3  ★ STAR  cell 18 (r3,c3)  OFF  window OPEN
  │  +3.52 s     ⤷ key ArrowLeft → says NOT-on · truth OFF → ✔ CORRECT · rt 523 ms
  │  +4.00 s     ⤷ feedback GREEN
  └
  ┌ RECALL
  │  +0.50 s  TEST 2/3  T_off  ● DOT  cell 18 (r3,c3)  OFF  TARGET (memory item 1)
  │  +1.53 s     ⤷ key ArrowRight → YES · correct answer NO → ✘ INCORRECT · rt 1034 ms · feedback RED
  │ (table: test, probe, tag, role T/F, correct answer, key, response, ✔/✘, rt, feedback)
  └
  SUMMARY  memory 2/3  ·  stars 3/3  ·  no-response 0  ·  anticipatory (<250 ms) 0  ·  early/late/extra keys 0/0/0
```

- Symbols: ● dot, ♪ tone, ★ star, ▢ hidden placeholder, ✔ correct, ✘ incorrect, **ON** / **OFF** = cell is on / off the pattern, **T** target, **F** foil.
- Times: inside ENCODING seconds since encoding started (the plan table's onsets are on the same clock); everywhere else seconds since the trial started.
- The task badge is coloured as the trial-type tag shown to participants.
- Yellow warnings (`console.warn`): missing response, early / late / extra keys, tone errors, aborted trial, hidden page.
- Rests, block boundaries and practice notices appear as short `── text ──` lines between trials.
- The values printed are the ones the trial code already computed for the data rows and the feedback; the trace never scores anything itself.

## Session plan print (start of the session)

With debug on, the console shows the **whole plan of the session** right after the banner and before consent: the
plan is generated from the seed at load, and the print reads those very trial objects (`src/debug/plan-print.js`, with
`plan-model.js` and `plan-store.js`). Practice trials are generated inside `singleTypePractice`, which hands its
`trialParams` to the plan store, so the printed practice plan is the one that runs. Nothing is recomputed or changed.

1. **HEADER**: seed (`PID|STUDY|SESSION`), build, number of trials per block and task, the legend. Generation time and
   attempts are not recorded by the generator, so they are not printed.
2. **BALANCINGS**: one collapsed group per task, with Main A, Main B and the 24-trial pool: per serial slot (M / S, memory items
   and ON, probed T_on / T_off, stars and ON), per ordinal and test position (memory ON, probe type x test #, encoding ordinal x
   test #, star ON), histograms of targets / memory ON / stars ON per trial (pinned 2,4,4,2 or 1,5,5,1 per half, 3,9,9,3 per pool),
   shade counts and their crossing with the labels, rotation strata with their angles. Each scope ends with the line
   `validator PASS` or the exact violations of `blockInvariantViolations` / `poolInvariantViolations`; the plan-level check
   (`planInvariantViolations`) and the session task order (digits 1-5 = Task 1-5, longest same-task run <= 2, reminder trials,
   rests) follow. The last line is **ALL EXACT BALANCES PASS**, or a list of failures in red (`console.error`).
3. **TRIALS**: Practice, Main A and Main B, each with an overview table (one row per trial in presentation order) and one collapsed
   group per trial, e.g. `TRIAL 17/120  Stars + Tones  main_a #17  rot -30° (ccw)  shade=white  seq SSMSMM`, holding an ENCODING table
   (slot, kind, item, cell 0-24, row/col, ON/OFF, tone index 0-23 and Hz, planned onset ms, tested as) and a RECALL table
   (test #, probe type, TARGET/FOIL, cell, ON/OFF, tone, which memory item it refers to or is paired with, correct answer).
   Counts and ordinals are 1-based, cell and tone ids 0-based. Symbols: ● dot, ♪ tone, ★ star, ▢ hidden placeholder.

`window.__WM_PLAN__` holds `{seed, build, practice, mainA, mainB, summaries}` (the same trial objects; `summaries` has the
balance counts, validator results, sequences and one display record per trial). `window.__WM_PLAN_DOWNLOAD__()` saves it as
`wm-plan_<seed>.json`. Both exist only in debug mode.

**The deployed build must be built with `npm run build:debug` for these tools** (the normal `npm run build` has none of them).

## Secret grid reveal: G G

Inside a trial press **G** twice within 450 ms (key repeat, Ctrl/Cmd/Alt combinations and typing in a text field are ignored).
An overlay appears inside the circle: the 25 cells with their data ids 0-24 (centre cell `12 C` is dashed), the on-pattern cells filled,
and a small readout of the trial's rotation angle. It sits in the rotating element, so it turns with the grid and holds the trial's angle;
it never covers dots or stars and takes no clicks. It stays on across the steps of the trial (gate, cue, imagination, encoding, probes, ITI)
and switches itself off at the end of the trial. **G G** again hides it. Outside a trial only a console note is printed.
The G key is never counted as a response (the response handlers only accept their own keys).

## Stage skip: N N

Press **N** twice within 450 ms (key repeat, Ctrl/Cmd/Alt combinations and typing in a text field are ignored; no `devnav=1` needed,
the `U` / `R` keys stay dev-server only) to skip forward ONE stage. Where you are decides what happens:

| You are in                                                              | N N goes to                                                                                                                                                        |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| instructions, demos, task intro slides, practice-readiness              | the next practice trial gate (Task 1's the first time); every deck, demo and slide before it is skipped. Practice then runs normally                               |
| any practice trial, practice feedback, practice notice, attention check | the Block 1 intro (`main_a_intro`); rest of practice, its feedback and attention checks are skipped, the accuracy criterion / retry / disqualification is bypassed |
| Main A: intro, tag reminder, trial, rest, resume gate                   | the Block 2 intro (`main_b_intro`)                                                                                                                                 |
| Main B: intro, trial, rest, resume gate                                 | the end-of-task screen (`end_of_task_intro`): questionnaires and the end can be tested                                                                             |
| consent, demographics, calibration, volume, tone check, timing probe    | nothing: the console prints `calibration cannot be skipped` (they measure the screen and sound that the geometry needs)                                            |
| end-of-task screen and after                                            | nothing (a console note)                                                                                                                                           |

How it works (`src/debug/skip.js`): the key finishes the screen you are on (like `U`), silences audio, closes the trace group
(`TRIAL ABORTED: experimenter stage skip`), prints a `SKIP from -> to` line and writes one `debug_skip` row. Every following
screen is then ended at once (it still runs its own cleanup, so no key listener, timer, audio or background is left behind)
until the target screen, which runs normally. Trial numbers (`N/120`) are fixed in the plan, so if Main A is skipped Block 2 still
starts at 61/120; the counter shows the last number reached until the next trial. The display guard is still stopped on the way
to the end-of-task screen. The N key is not an allowed key of any response handler, so it is never counted as a response or an
extra key, and it does not interfere with `G G`, `U` or `R`. The skipped nodes' rows (neutralised, no responses) stay in the data
of this debug session, which is excluded from analysis anyway.

## What is written to the data

- `debug_mode` (boolean) on the `session_info` row, the upload envelope and the end-of-run session stamp, next to `is_pilot_run`.
  True means the tools were active in that session; exclude such sessions from analysis.
- One row per reveal toggle: `phase: 'debug_reveal'`, `debug_reveal_on` (true/false), `trial_uid`, `debug_node_phase`
  (the node that was running), `ts` (performance.now, ms), plus the usual clock fields.
  Exclude any trial that has a `debug_reveal` row with `debug_reveal_on: true`.
- One row per stage skip: `phase: 'debug_skip'`, `from_stage` (`instructions`, `practice`, `main_a`, `main_b`), `to_stage`
  (`practice_gate`, `main_a_intro`, `main_b_intro`, `end_of_task_intro`), `trial_uid` (of the trial that was running, or null),
  `debug_node_phase` (the node that was running), `ts`. The interrupted node's own row carries `debug_skipped: true`.
  Exporters treat `debug_skip` as a session event (no task), like `debug_reveal`.

The deployed site must be built with `npm run build:debug` for any of these tools (including N N) to exist; the normal
`npm run build` has no listener and no hook.

The trace leaves every recorded value identical (stimuli, keys, scores, feedback, row contents; checked by
`tests/debug-data-identical.test.js`). It does not promise identical timing: console calls can cost a frame on the
experimenter's own run, which is one more reason never to use it with participants.

## Exporter columns and the exclusion reason

The analysis tools carry the flags, so debug sessions and trials can be found and dropped:

| Tool / file                                                                                        | Column                                                                                                    |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `raw-to-csv.js` (every row)                                                                        | `debug_mode` (after `is_pilot_run`); `debug_reveal` rows have `session_stage = session_event` and no task |
| `trials-to-csv.js` / `analysis-csv.js`                                                             | `debug_mode` (after `is_pilot_run`), `debug_reveal_seen` (after `trial_guard_excluded`)                   |
| `csv-export.js` tidy tables (`trials`, `stars`, `probes`, `encoding_events`)                       | `debug_reveal_seen`                                                                                       |
| `csv-export.js` wide files, `EVENTS`, `CALIBRATION_SUMMARY`, `PARTICIPANT_SUMMARY`, `DEMOGRAPHICS` | `Debug_Mode` (0/1); wide files also `Debug_Reveal_Seen` (0/1)                                             |
| `EXPORT_MANIFEST.json`                                                                             | `debug_mode_flags`                                                                                        |

- `debug_reveal_seen` is true if a `debug_reveal` row with `debug_reveal_on: true` belongs to the trial (matched by `trial_uid`;
  a toggle without a uid belongs to the trial window it falls in). It is separate from `trial_guard_excluded`, which stays about display guards.
- Participant level (`scripts/participant-rules.js`, used by `pilot-summary.js` and `csv-export.js`): a run with any row
  `debug_mode: true` or a reveal-on row gets the exclusion reason **`debug_session`** (listed in `Exclusion_Reasons`, so the run is not
  `retained`). The session is also classed `Sample_Class = debug`: never counted in the sampling plan, not even in a pilot batch, and
  `pilot-summary` reports `DEBUG_SESSIONS_NOT_COUNTED`. `debug_session` is a tooling rule, not one of the three pre-registered rules.

## Before the main batch

The deployed (production) build is compiled with debug OFF (see "How to switch them on"), so a participant who adds
`&pilot=1&debug=1` to the URL gets nothing. Keep it that way: deploy only with `npm run build`, never `npm run build:debug`.
If a debug build ever reaches participants by mistake, the data flags above make such sessions detectable
(`debug_mode`, `Sample_Class = debug`, reason `debug_session`): check `PARTICIPANT_SUMMARY.csv` before analysing.

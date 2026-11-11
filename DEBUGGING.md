# Experimenter debug tools

Two tools for the experimenter, both OFF unless switched on by the URL:

1. a console trace of every trial (angles, cells, ON/OFF tags, targets and foils, keys, truth values, feedback);
2. a secret key (press **G** twice) that shows the hidden grid and pattern inside the circle.

**Never use them with real participants.** They show the answers. Code is in `src/debug/`
(`debug-mode.js`, `trace.js`, `reveal.js`).

## How to switch them on

Add `debug=1` to the URL. It counts only on an experimenter session, that is when one of these holds:

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
  │  +0.50 s  TEST 2/3  T_off  ● DOT  cell 18 (r3,c3)  OFF  TARGET (encoded at position 1)
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

## Secret grid reveal: G G

Inside a trial press **G** twice within 450 ms (key repeat, Ctrl/Cmd/Alt combinations and typing in a text field are ignored).
An overlay appears inside the circle: the 25 cells with their data ids 0-24 (centre cell `12 C` is dashed), the on-pattern cells filled,
and a small readout of the trial's rotation angle. It sits in the rotating element, so it turns with the grid and holds the trial's angle;
it never covers dots or stars and takes no clicks. It stays on across the steps of the trial (gate, cue, imagination, encoding, probes, ITI)
and switches itself off at the end of the trial. **G G** again hides it. Outside a trial only a console note is printed.
The G key is never counted as a response (the response handlers only accept their own keys).

## What is written to the data

- `debug_mode` (boolean) on the `session_info` row, the upload envelope and the end-of-run session stamp, next to `is_pilot_run`.
  True means the tools were active in that session; exclude such sessions from analysis.
- One row per reveal toggle: `phase: 'debug_reveal'`, `debug_reveal_on` (true/false), `trial_uid`, `debug_node_phase`
  (the node that was running), `ts` (performance.now, ms), plus the usual clock fields.
  Exclude any trial that has a `debug_reveal` row with `debug_reveal_on: true`.

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

Make sure the reveal and the trace are switched off for the main batch: nothing in the page stops a participant who adds
`&pilot=1&debug=1` to the URL. The researcher accepted this risk for now. The data flags above make such a session detectable
(`debug_mode`, `Sample_Class = debug`, reason `debug_session`), so check `PARTICIPANT_SUMMARY.csv` before analysing.

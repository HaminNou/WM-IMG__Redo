# Prolific study description and screening disclosure

Paste the sections below into the matching fields on the Prolific study page. Replace every item in square brackets before publishing.

## Study title

The Impact of Visual Imagery on Spatial Working Memory Recall (online)

## Short description (shown in the study listing)

A computer-based memory task: you will remember positions on a grid, imagine simple patterns, and respond to short tones using the keyboard. Desktop or laptop computer required; headphones strongly recommended. About 110 minutes. Pay: $26 ($14 per hour).

## Full description

**What you will do.** You will complete one session of about 110 minutes in your web browser. You will calibrate your screen with a credit card, set your sound level, remember and compare dot positions on a grid and short pure tones, imagine simple geometric patterns, and answer brief questionnaires. Responses are made with the keyboard. The session includes flashing visual items and short tones that vary in pitch and loudness. Please do not take part if these could cause you discomfort.

**Who can take part (Prolific screeners).** This study is available only to participants who meet all of the following Prolific screening criteria:

- Age: 18 to 40 years
- Vision: normal or corrected-to-normal vision (glasses or contacts)
- Hearing: normal hearing
- Language: fluent in English
- Device: a desktop or laptop computer, used with headphones

Edit this list so that it matches the filters set on the study exactly, and matches `PROLIFIC_PRESCREEN_SUMMARY` in `src/config.js`.

Eligibility is determined only by these Prolific filters. The study does not test your age, hearing, or vision, and it does not ask about your health or medical conditions or for your date of birth. Your age and sex come from the information Prolific already holds.

**Checks that happen during the study.** The following checks are task-capability checks, not eligibility screening. They confirm that the task can be run accurately on your equipment, and most of them can end the session. They are described again in the consent form.

1. Device check (at the very start, before the consent form): the study runs only on a desktop or laptop computer. If a phone or tablet is detected, the session ends.
2. Screen-size calibration: you match an on-screen rectangle to a credit card, with up to three attempts. If a usable setting cannot be obtained, the session ends.
3. Sound check: you adjust the volume until a series of short tones is clearly and comfortably audible. If the tones cannot be made audible, the session ends.
4. Headphone check: a brief listening check, recorded only. It never ends the session, but headphones are strongly recommended.
5. Pitch-discrimination check: eight pairs of tones, saying whether the second tone was higher or lower. At least 7 of 8 correct are required; one retry is allowed after raising the volume. If you score below 7 of 8 on the second attempt, the session ends.
6. Timing check: for a few seconds the page measures your display refresh rate and timer accuracy. If the computer is too slow or unsteady, you can run the check once more; if it fails again, the session ends.
7. Practice-accuracy criterion: you must reach at least 70% correct on the practice trials, with one repeat allowed, before the main task begins. If you do not, the session ends.
8. Display lock: after calibration the page must stay at the same zoom and in fullscreen. If either changes, the task pauses until you restore it, and the affected trials are excluded from analysis. If you cannot restore it, a button lets you end the session.
9. Attention checks: three brief typed instruction checks occur during the session. They do not end the session, but if you miss more than one, your data may be excluded from the analyses.

**If a check is not passed.** For every check except 4 and 9, the session ends, you are shown a message and sent back to Prolific with the screen-out completion code CED70N6J. Your submission is then recorded on Prolific. Payment for the time spent before the session ended: $0.14 if the session ends at the device or sound check; later exits are paid in proportion to time.

**Declining or leaving.** Participation is voluntary. You can decline consent at the start, or stop at any time by selecting "Stop without completing" on Prolific, which returns your submission, without penalty.

**Payment.** $26 for completing the full session, paid by Prolific after you submit the completion code CQ6EH8Q1. Partial payment: $0.14 if the session ends at the device or sound check; later exits are paid in proportion to time.

**Data and privacy.** This study is pseudonymous: your responses are stored under your Prolific Participant ID only. We do not collect your name, email address, or IP address. IRB project #2101803, University of Missouri. Contact: Hamid Nourbakhshi, hnth5@missouri.edu.

## Prolific study-page settings checklist

- Screeners: set the filters listed above and no others that would exclude participants silently.
- Device: restrict to desktop in the device settings.
- Completion codes: add a normal completion code (CQ6EH8Q1) and a screen-out code (CED70N6J, action: "Screen out / no further action" as appropriate). Set the screen-out code in `config.prolific.screen_out_completion_code`.
- Estimated time: 110 minutes. Reward: $26.

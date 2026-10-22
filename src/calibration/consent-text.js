/**
 * Consent form text.
 *
 * The consent text follows the IRB-2101803 consent form, worded for online
 * administration through Prolific. Eligibility is stated as the Prolific
 * prescreeners (`PROLIFIC_PRESCREEN_SUMMARY`), and every in-study check that
 * can end a session is disclosed together with its consequence.
 *
 * Kept free of jsPsych imports so that `scripts/preflight.js` can read the
 * participant-facing text in Node.
 */
import { PROLIFIC_PRESCREEN_SUMMARY, config } from '../config.js';

const PRESCREEN_LIST_HTML = PROLIFIC_PRESCREEN_SUMMARY.map((item) => `<li>${item}</li>`).join('');

const PRACTICE_CRITERION_PCT = Math.round(config.practice.accuracy_criterion * 100);

/**
 * Consent form markup.
 *
 * @param {string} [paymentPolicyText]  payment statement for time spent before
 *                                      a check ends the session
 */
export function consentBodyHtml(paymentPolicyText = config.prolific.payment_policy_text) {
  return `
  <div style="text-align:left; max-width: 64ch; margin: 0 auto; font-size: 0.95rem; line-height: 1.55;">
    <h2 style="text-align:center; margin: 0 0 0.5rem;">Consent Form</h2>
    <div style="max-height: 60vh; overflow-y: auto; padding: 0.75rem 1rem; border: 1px solid rgba(0,0,0,0.35); border-radius: 6px; background: rgba(255,255,255,0.45);">
      <p><strong>UNIVERSITY OF MISSOURI: IRB PROJECT #2101803</strong></p>
      <p><strong>PRINCIPAL INVESTIGATOR: Dr. NELSON COWAN</strong></p>
      <p>We invite you to participate in a research study occurring under the project titled, &ldquo;The Impact of Visual Imagery on Spatial Working Memory Recall.&rdquo; This study is being conducted online and is delivered through your web browser via the Prolific research platform. Please read this form in its entirety and address any questions you may have to the Lead Researcher (contact information below) prior to indicating your consent and before participating.</p>

      <h3>What you should know before participating:</h3>
      <ul>
        <li>This is a remote, online study session that runs entirely in your web browser. No researcher will be present during your session.</li>
        <li>The purpose of the study is to explore the capacity, functioning, and limitations of working memory processes when dealing with spatial representations and imagery.</li>
        <li>This study is pseudonymous: you are identified only by your Prolific Participant ID, a randomly assigned alphanumeric code issued by Prolific. Your responses are stored and analyzed under that ID. We do not collect your name, email address, IP address, or any other directly identifying information, and we do not receive your name or email address from Prolific.</li>
        <li>We ask a short questionnaire about handedness, education, English fluency, and whether you are wearing glasses or contacts. These answers describe the sample and are not used to decide whether you may take part. We do not ask about your health, hearing, vision, or medical conditions, and we do not collect your date of birth. Your age and sex are taken from the information Prolific holds about you. You may select &ldquo;Prefer Not to Say&rdquo; where available.</li>
        <li>You will be presented with visual information (e.g., simple shapes such as dots on a grid, geometric patterns, an asterisk star marker, and a question-mark probe) and auditory information (short pure tones). You will indicate your responses using a keyboard press. Please be aware that visual items can flash or appear and disappear quickly, and that auditory items are short pure tones that may be high or low in pitch.</li>
        <li>The study takes approximately 110 minutes to complete.</li>
        <li>You will be compensated at or above Prolific&rsquo;s recommended fair-pay rate, currently approximately $12.00 per hour, for a single session of approximately 110 minutes. The exact amount is indicated on the Prolific study listing. Payment is processed by the Prolific platform upon submission of your completion code; the University of Missouri does not collect or process any payment information. After responding to the survey, you will receive information about the payment you are eligible for based on your agreement with Prolific. If the compensation you received does not align with your expectations for this study, please contact the PI at hnth5@missouri.edu.</li>
        <li>Participation is voluntary, meaning you can choose to discontinue participation at any time. If you choose to discontinue before completion, please select &ldquo;Stop without completing&rdquo; on Prolific, which returns your submission.</li>
      </ul>
      <p>All the data and the information you provide will be kept confidential and only the researchers will have access.</p>
      <ul>
        <li>If you need additional information, please contact the Lead Researcher (Hamid Nourbakhshi at hnth5@missouri.edu).</li>
        <li>If you decide to take part in this study, you may save, download, or print this consent form for future reference and further review.</li>
      </ul>

      <h3>TITLE OF THIS STUDY</h3>
      <p>&bull; The Impact of Visual Imagery on Spatial Working Memory Recall: An Online Follow-up Study.</p>
      <p>&bull; The aim of this study is to investigate the functioning and limitations of working memory processes when dealing with spatial representations and imagery, replicating and extending findings obtained in earlier laboratory-based work.</p>

      <h3>WHO IS CONDUCTING THIS RESEARCH?</h3>
      <p>&bull; The Working Memory Lab, University of Missouri, Department of Psychological Sciences, under the direction of Dr. Nelson Cowan, Principal Investigator and Director, via departmental funding.</p>

      <h3>WHO WILL BE PARTICIPATING IN THIS STUDY?</h3>
      <p>&bull; Eligibility is determined by Prolific&rsquo;s screening filters, which are applied before you see this study. This study is shown only to participants who meet all of the following Prolific criteria:</p>
      <ul>${PRESCREEN_LIST_HTML}</ul>
      <p>&bull; Eligibility is determined only by the Prolific screening filters above; the study does not test your age, hearing, or vision. The checks listed in the next section are task-capability checks (whether the task can be run accurately on your equipment), not eligibility screening, but they can end the session. If any of the criteria above does not apply to you, please do not continue.</p>
      <p>&bull; In addition, for your safety and comfort, please do not take part if you cannot attend to short auditory tones that may be soft or loud, high or low, irregular or repetitive, or to brief visual items that flash or appear and disappear quickly, without experiencing adverse side effects.</p>

      <h3>CHECKS DURING THE STUDY AND WHAT HAPPENS IF YOU DO NOT PASS</h3>
      <p>The following checks are part of the session. They are not additional eligibility screening; they confirm that the task can be completed accurately on your equipment. The device check happens at the very start, before this form appears. The others happen after you consent, in the order listed.</p>
      <ul>
        <li><strong>Device check (very start):</strong> the study runs only on a desktop or laptop computer. If a phone or tablet is detected, the session ends before this form.</li>
        <li><strong>Screen-size calibration:</strong> you match an on-screen rectangle to a credit card, twice per attempt, with up to three attempts. If a usable setting cannot be obtained (for example, the size is outside the plausible range for a computer screen), the session ends.</li>
        <li><strong>Sound check:</strong> you adjust the volume until a series of short tones is clearly and comfortably audible. If the tones cannot be made audible, the session ends.</li>
        <li><strong>Headphone check:</strong> a brief listening check of whether you are using headphones. It is recorded only and never ends the session, but headphones are strongly recommended.</li>
        <li><strong>Pitch-discrimination check:</strong> eight pairs of tones; you say whether the second tone was higher or lower than the first. You need at least 7 of 8 correct. If you do not, you may try once more after raising the volume; if you again score below 7 of 8, the session ends. A second block at a lower volume is recorded only.</li>
        <li><strong>Timing check:</strong> for a few seconds the page measures your display refresh rate and timer accuracy. If the computer is too slow or unsteady for the task (for example, a refresh rate below about 49 Hz), you are asked to close other programs and the check is run once more; if it fails again, the session ends.</li>
        <li><strong>Practice-accuracy criterion:</strong> you must reach at least ${PRACTICE_CRITERION_PCT}% correct on the practice trials, with one repeat of the practice allowed, before the main task begins. If you do not, the session ends.</li>
        <li><strong>Display lock:</strong> after calibration the page must stay at the same zoom and in fullscreen. If either changes, the task pauses until you restore it, and trials affected are excluded from analysis. If you cannot restore it, a button lets you end the session.</li>
        <li><strong>Attention checks:</strong> three brief typed instruction checks occur during the session. These do not end the session, but if you miss more than one, your data may be excluded from the analyses.</li>
      </ul>
      <p>If the session ends because of any of the checks above other than the attention checks, you will be shown a message and sent back to Prolific with a screen-out completion code, so that your submission is recorded. Payment for the time you spent before the session ended: ${paymentPolicyText}. If you decline consent, you can withdraw by selecting &ldquo;Stop without completing&rdquo; on Prolific.</p>

      <h3>IF YOU DECIDE TO PARTICIPATE, WHAT WILL YOU BE ASKED TO DO?</h3>
      <ul>
        <li>Complete a single online study session of approximately 110 minutes in your web browser.</li>
        <li>Calibrate your screen size using a credit card so that the visual stimuli are rendered at a fixed physical size on your monitor.</li>
        <li>Set your audio volume so that a brief reference tone is comfortably audible. Headphones are strongly recommended.</li>
        <li>Silence or turn off any other devices that could distract you during the session, and complete the session in a quiet environment, free of interruptions, in order to minimize anything that could potentially affect your focus and attention on the task.</li>
        <li>Remember and compare visual information (dots on a grid; mental images of simple geometric patterns) and auditory information (short pure tones) that may consist of any of the following: brief sounds, pure tones, simple shapes, geometric patterns, or grid markers, and indicate your memory of the recently presented items by pressing a key.</li>
        <li>Complete a brief demographics questionnaire (it does not ask about your health or for your date of birth). At the end of the session, you will complete a short strategy questionnaire (19 statements rated on a 5-point agreement scale) asking how you approached each part of the task &mdash; there are no right or wrong answers; we are interested in capturing your approach.</li>
        <li>Complete three brief typed instruction checks during the session. If you miss more than one, your data may be excluded from the analyses under the pre-registered exclusion rules.</li>
      </ul>

      <h3>WHAT YOU NEED TO KNOW REGARDING PARTICIPATION:</h3>
      <ul>
        <li>Although you may be invited to return for one or more future sessions, depending on the study, participating in THIS session will not obligate you to return for additional sessions.</li>
        <li>No researcher will be present during your session; the entire session is administered by your web browser. You may contact the research team using the contact information below at any point during or after participation.</li>
        <li>You understand that your participation is voluntary, meaning you have the right to refuse or discontinue participation at any time without penalty or loss of benefit to which you are otherwise entitled.</li>
        <li>You understand that your responses will be stored under your Prolific Participant ID only; we do not collect your name or other personal details.</li>
        <li>You understand that the data resulting from your participation may be shared with other investigators and integrated with results obtained from similar projects in the future without asking for your consent again. The shared data will not contain your name or any other directly identifying information; it will only be used, shared, and saved under a pseudonymous identifier.</li>
        <li>This study does not involve audio or video recording.</li>
        <li>Compensation for your participation is processed by the Prolific platform at or above Prolific&rsquo;s recommended fair-pay rate, currently approximately $12.00 per hour. The University of Missouri does not collect or process payment information. After responding to the survey, you will receive information about the payment you are eligible for based on your agreement with Prolific. If the compensation you received does not align with your expectations for this study, please contact the PI at hnth5@missouri.edu.</li>
        <li>If you choose to discontinue participation before completion, please select &ldquo;Stop without completing&rdquo; on Prolific, which returns your submission. Compensation in the case of partial participation will follow the standard Prolific policy for returned submissions.</li>
        <li>If your participation is canceled or terminated by the researcher: The session ends if you do not pass one of the checks described above (other than the attention checks), and your data may be excluded if you miss more than one attention check. Payment in these cases is described under &ldquo;Checks during the study&rdquo; above: ${paymentPolicyText}.</li>
      </ul>

      <h3>WHAT ARE THE BENEFITS OF THIS STUDY TO YOU AND TO THE PUBLIC IN GENERAL?</h3>
      <ul>
        <li>You will become familiar with the kinds of procedures used to investigate human cognition. You may derive personal satisfaction from contributing to research on human memory and mental imagery, and you may learn useful and effective memory strategies and techniques that can be applied in other settings.</li>
        <li>Although the collected data is not used to examine individual memory differences, your data, when combined with the data of other participants, can help us understand how people learn, remember, retain, retrieve, and integrate visual and auditory information with mental imagery, and may inform applied settings such as education, clinical practice, and the design of cognitive tools.</li>
      </ul>

      <h3>WHO DO YOU CONTACT IF YOU HAVE QUESTIONS OR CONCERNS NOW, DURING OR AFTER?</h3>
      <ul>
        <li>Lead Researcher: Hamid Nourbakhshi, via email at hnth5@missouri.edu.</li>
        <li>If you have any questions about your rights as a research participant, please contact the University of Missouri Institutional Review Board (IRB) at 573-882-3181 or muresearchirb@missouri.edu. The IRB is a group of people who review research studies to make sure the rights and welfare of participants are protected.</li>
      </ul>

      <h3>STATEMENT OF CONSENT:</h3>
      <p>By clicking &ldquo;I consent &mdash; begin&rdquo; below, you acknowledge your intent to participate in this online research study; that you have been provided with the opportunity and the means to ask questions and obtain information prior to participating; and that you are aware of your right to decline participation by closing this browser tab and selecting &ldquo;Stop without completing&rdquo; on Prolific at any time without penalty.</p>
    </div>
    <p style="margin-top: 1rem; text-align:center; font-size: 0.9rem; color: rgba(0,0,0,0.6);">
      Please scroll to read the entire consent form before continuing.
    </p>
    <div style="margin: 1rem auto 0.25rem; text-align:center;">
      <label style="display:inline-flex; align-items:center; gap:0.5rem; cursor:pointer; font-size:0.95rem;">
        <input type="checkbox" id="consent-checkbox" style="width:1.1rem; height:1.1rem; cursor:pointer;" />
        <span>I have read and understood the information above.</span>
      </label>
    </div>
  </div>
`;
}

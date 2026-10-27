/**
 * Demographics form.
 *
 * The fields collected here describe the analyzed sample: handedness and
 * highest level of education, both closed choices. No health or medical
 * information is asked, there is no free-text box, and nothing here identifies
 * a person: no name, email address, date of birth, age, address or phone
 * number (Prolific's researcher terms forbid collecting direct identifiers).
 * Age, sex, and primary language come from Prolific's demographic export.
 * Eligibility (age, first language, country of birth, hearing, vision,
 * cognitive health, approval rate) is decided only by Prolific's screening
 * filters, which are applied before the study is shown; nothing in this form
 * screens or excludes a participant.
 *
 * The post-experiment strategy questionnaire is administered at the very
 * end of the session (after all main blocks) so that asking participants
 * how they approached the task cannot prime a particular strategy during
 * the task itself. The Prolific Participant ID is the canonical anonymous
 * identifier and is captured upstream by `prolific.js`; we do not generate
 * a separate user number here.
 */
import surveyHtmlForm from '@jspsych/plugin-survey-html-form';
import { registerHiddenNavStep, trackHiddenNavNode } from '../hidden-nav.js';

const FIELD_STYLE = `
  <style>
    .demog-form {
      text-align: left; max-width: 34rem; margin: 0 auto;
      font-size: 0.95rem; line-height: 1.5;
    }
    .demog-section {
      border-top: 1px solid rgba(0,0,0,0.15);
      padding-top: 1rem; margin-top: 1.25rem;
    }
    .demog-section-title {
      font-size: 0.8rem; font-weight: 400; letter-spacing: 0.04em;
      text-transform: uppercase; color: rgba(0,0,0,0.65);
      margin: 0 0 0.75rem;
    }
    .demog-form .field {
      margin: 0 0 1.1rem;
    }
    .demog-form .field-label {
      display: block; margin-bottom: 0.3rem; font-weight: 400;
    }
    .demog-form .req {
      color: #b3261e; margin-left: 0.15rem; font-weight: 400;
    }
    .demog-form select {
      display: block; width: 100%; box-sizing: border-box;
      padding: 0.45rem 0.6rem;
      border: 1px solid rgba(0,0,0,0.35); border-radius: 4px;
      background: rgba(255,255,255,0.55); color: inherit; font: inherit;
    }
    .demog-form select { max-width: 24rem; }
  </style>
`;

export function demographicsTrial() {
  const stepId = 'demographics';
  const node = {
    type: surveyHtmlForm,
    preamble: `
      <h2>Demographics</h2>
      <p style="max-width: 36rem; margin: 0.25rem auto 1rem; font-size: 0.95rem; color: rgba(0,0,0,0.65);">
        This information is used only to describe the sample. Items marked with
        <span style="color:#b3261e;">&bull;</span> are required.
      </p>
    `,
    html: `
      ${FIELD_STYLE}
      <div class="demog-form">

        <!-- ── General ── -->
        <div class="demog-section" style="border-top: none; margin-top: 0; padding-top: 0;">
          <p class="demog-section-title">General</p>

          <div class="field">
            <label class="field-label" for="d-handedness">Handedness<span class="req">&bull;</span></label>
            <select id="d-handedness" name="handedness" required>
              <option value="">– select –</option>
              <option value="right">Right</option>
              <option value="left">Left</option>
              <option value="ambidextrous">Ambidextrous</option>
              <option value="prefer_not">Prefer not to say</option>
            </select>
          </div>

          <div class="field">
            <label class="field-label" for="d-education">Highest level of education<span class="req">&bull;</span></label>
            <select id="d-education" name="education" required>
              <option value="">– select –</option>
              <option value="high_school">High school</option>
              <option value="ged">GED</option>
              <option value="some_college">Some college</option>
              <option value="associate">Associate's degree</option>
              <option value="bachelor">Bachelor's degree</option>
              <option value="master">Master's degree</option>
              <option value="doctoral">Doctoral degree</option>
              <option value="other">Other</option>
              <option value="prefer_not">Prefer not to say</option>
            </select>
          </div>
        </div>

      </div>
    `,
    button_label: 'Continue',
    data: { phase: 'demographics' },
  };
  registerHiddenNavStep(stepId, demographicsTrial);
  return trackHiddenNavNode(node, stepId);
}

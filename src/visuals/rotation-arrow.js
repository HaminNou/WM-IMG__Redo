/**
 * Rotation-cue arrow renderer — a chevron PNG asset
 * (`public/assets/rotation-arrow.png`). The asset is a 256×256 RGBA PNG
 * showing an upward-pointing chevron in mid-gray; CSS `transform:
 * rotate(angleDeg)` is applied at render time to indicate the trial's
 * rotation direction.
 *
 * The **specific rotation angle is not displayed in text** — the rotated
 * arrow is the cue. Showing the angle would over-specify the cue and
 * bias attention to a small fixed set of angles. The angle is
 * sampled uniformly from the inclusive range `[-90, +90]`, and the
 * participant is meant to rely on the arrow alone.
 *
 * The output is an HTML string suitable for direct injection into a
 * jsPsych `htmlKeyboardResponse` stimulus. No DOM/window dependencies.
 *
 * Default render size: 96 px square outer box (CSS px). Set via
 * `config.imagery.rotation_arrow_size_px` if you need to override.
 */
import { config } from '../config.js';

/* Resolved against Vite's `base` (set in vite.config.js). At build time
 * this expands to `./assets/...`, which the browser then resolves against
 * the document URL — so the asset loads correctly whether the build is
 * served from the site root or from a subpath like
 * `/<user>/<project>/`. */
const ARROW_ASSET_URL = `${import.meta.env.BASE_URL}assets/rotation-arrow.png`;

/**
 * Build the markup for one rotation-cue arrow.
 *
 * @param {number} angleDeg     Rotation in degrees (positive = clockwise).
 * @param {object} [opts]
 * @param {number} [opts.size]  Outer box edge in CSS px. Defaults to
 *                              `config.imagery.rotation_arrow_size_px` (96).
 * @param {'white'|'gray'|null} [opts.background_shade]
 *                              Trial background shade. When set, the PNG is
 *                              rendered as solid BLACK via `filter:
 *                              brightness(0) saturate(100%)` so the arrow
 *                              reads as a stimulus on the white/gray page.
 *                              When omitted/null, the source PNG (mid-gray)
 *                              is shown unmodified.
 * @returns {string}            HTML string with one self-contained <img>.
 */
export function rotationArrowImg(angleDeg, { size, background_shade = null } = {}) {
  const px = size ?? config.imagery.rotation_arrow_size_px ?? 96;
  /* The PNG's natural orientation is "up" (12-o'clock). A positive
   * angleDeg is treated as a clockwise rotation around the cue's centre
   * (CSS rotate semantics). */
  /* When a `background_shade` is set, the gray PNG is first inked to solid
   * black (`brightness(0) saturate(100%)`), then four stacked white
   * `drop-shadow` filters trace a ~1.5 px white halo around the chevron
   * silhouette in the four cardinal directions. The halo guarantees the
   * arrow remains legible regardless of the participant's OS colour
   * scheme — on a dark-mode display where Chrome darkens the gray trial
   * background, an inked-black arrow would otherwise sit nearly invisible
   * against the darkened backdrop. The halo is small enough to be
   * imperceptible in light mode but rescues legibility in dark mode.
   * Stacking drop-shadows in all four directions is the standard CSS
   * idiom for emulating a uniform outline on a raster asset. */
  const tintFilter = background_shade
    ? ' filter: brightness(0) saturate(100%) drop-shadow(1px 0 0 #fff) drop-shadow(-1px 0 0 #fff) drop-shadow(0 1px 0 #fff) drop-shadow(0 -1px 0 #fff);'
    : '';
  return [
    `<img`,
    `  src="${ARROW_ASSET_URL}"`,
    `  alt="rotation cue"`,
    `  width="${px}"`,
    `  height="${px}"`,
    `  style="display:block; transform: rotate(${angleDeg}deg); transform-origin: 50% 50%;${tintFilter}"`,
    `/>`,
  ].join(' ');
}

/**
 * Build the full rotation-cue stimulus block — the rotated arrow image
 * centred in a fixed-height container so the layout stays stable across
 * trials. No degree-text label, per the design constraint above.
 *
 * @param {number} angleDeg
 * @param {object} [opts]
 * @param {'white'|'gray'|null} [opts.background_shade]
 *                              Forwards to `rotationArrowImg` so the arrow
 *                              renders inked-black on trial
 *                              backgrounds.
 * @returns {string}  HTML ready to assign to a jsPsych `stimulus`.
 */
export function rotationCueStimulus(angleDeg, { background_shade = null } = {}) {
  return `
      <div style="display: grid; place-items: center; height: 12rem;">
        ${rotationArrowImg(angleDeg, { background_shade })}
      </div>
    `;
}

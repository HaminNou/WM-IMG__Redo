/**
 * Pure helpers that put the planned trial and the rendered stimulus
 * positions on the data rows. No DOM access.
 *
 * Positions are in millimetres in the fixed grid frame: origin at the
 * fixation point, x to the right, y down, after the grid has been rotated by
 * the angle the stimulus was drawn at. The upright-grid position of a cell
 * is `cell_x_mm` / `cell_y_mm` in the exported tables.
 */
import { screenPositionMm, cellGeometry } from '../grid.js';

const r3 = (x) => Math.round(x * 1000) / 1000;

/**
 * Snapshot of the full plan for one trial, stamped on the encoding row:
 * memory items, stars, placeholders (dummies, never visible) and the three
 * recognition probes with their encoding-position labels.
 */
export function encodingRecord(params) {
  return {
    condition: params.trial_type,
    rotation_deg: typeof params.rotation_deg === 'number' ? params.rotation_deg : null,
    display_rotation_deg:
      typeof params.display_rotation_deg === 'number' ? params.display_rotation_deg : null,
    sequence: params.sequence.join(''),
    memory_items: (params.memory_items ?? []).map((m) => ({
      slot: m.slot_index_in_seq,
      encoding_position: m.encoding_position,
      cell: m.cell,
      pattern_label: m.pattern_label,
    })),
    stars: (params.stars ?? []).map((s) => ({
      slot: s.slot_index_in_seq,
      probe_position: s.probe_position,
      cell: s.cell,
      pattern_label: s.pattern_label,
    })),
    dummies: (params.dummies ?? []).map((d) => ({ slot: d.slot_index_in_seq, cell: d.cell })),
    probes: (params.probes ?? []).map((p) => ({
      probe_position: p.probe_position,
      encoding_position: p.encoding_position ?? null,
      type: p.type,
      cell: p.cell,
      is_target: p.is_target,
      pattern_label: p.pattern_label,
    })),
  };
}

/** Where a recognition probe was drawn: the frame it was drawn in decides. */
export function probeRenderFields(probe, frame) {
  const rotation = frame?.rotation_deg ?? 0;
  const pos = screenPositionMm(probe.cell, rotation);
  return {
    probe_frame_rotation_deg: rotation,
    probe_x_mm: r3(pos.x_mm),
    probe_y_mm: r3(pos.y_mm),
    probe_radius_mm: r3(cellGeometry(probe.cell).radius_mm),
  };
}

/** Where a star was drawn: stars are drawn in the grid rotated by the trial angle. */
export function starRenderFields(star, rotationDeg) {
  const rotation = typeof rotationDeg === 'number' ? rotationDeg : 0;
  const pos = screenPositionMm(star.cell, rotation);
  return {
    star_frame_rotation_deg: rotation,
    star_x_mm: r3(pos.x_mm),
    star_y_mm: r3(pos.y_mm),
    star_radius_mm: r3(cellGeometry(star.cell).radius_mm),
  };
}

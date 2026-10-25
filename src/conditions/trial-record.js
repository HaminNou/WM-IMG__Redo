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

/**
 * Rotation of the grid frame for every node that follows encoding
 * (retention and the three recognition probes). One rule for all conditions:
 * the angle the trial's encoding frame was drawn at stays on the frame.
 *
 *   I+D, I+T  trial angle (`rotation_deg`); a dot probe is therefore drawn on
 *             the rotated cell it was encoded on, and a tone probe records the
 *             same frame angle although it has no screen position
 *   D-only    its display angle (`display_rotation_deg`)
 *   T-only    upright (0)
 *
 * I-only has no retention or probes. Imagery frames are never left upright
 * while the encoding frame was rotated.
 */
export function postEncodingRotationDeg(params) {
  if (typeof params?.rotation_deg === 'number') return params.rotation_deg;
  if (typeof params?.display_rotation_deg === 'number') return params.display_rotation_deg;
  return 0;
}

/** Rotation of the frame a recognition probe was drawn in (dot and tone probes alike). */
export function probeFrameFields(frame) {
  return { probe_frame_rotation_deg: frame?.rotation_deg ?? 0 };
}

/** Where a recognition probe was drawn: the frame it was drawn in decides. */
export function probeRenderFields(probe, frame) {
  const rotation = frame?.rotation_deg ?? 0;
  const pos = screenPositionMm(probe.cell, rotation);
  return {
    ...probeFrameFields(frame),
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

/**
 * Screen position of what each slot of the encoding sequence shows, in the
 * frame the stimulus is drawn in (`rotationDeg`). A dummy is an invisible
 * placeholder; a tone has no visual position, so its entry holds the
 * upright-grid position of the cell it is paired with.
 *
 * @param {object} params     trial parameters from the scheduler
 * @param {object} opts
 * @param {number} opts.rotationDeg   rotation of the grid while the slots run
 * @param {'dot'|'tone'|'dummy'} opts.m_kind   what an M-slot shows
 * @param {'star'|'dummy'} opts.s_kind         what an S-slot shows
 * @returns {{slot: number, kind: string, cell: number|null, x_mm: number|null, y_mm: number|null}[]}
 */
export function slotPositionsMm(params, { rotationDeg, m_kind, s_kind }) {
  const bySlot = (list) => new Map((list ?? []).map((e) => [e.slot_index_in_seq, e]));
  const memory = bySlot(params.memory_items);
  const stars = bySlot(params.stars);
  const dummies = bySlot(params.dummies);
  return params.sequence.map((slotKind, slot) => {
    let kind = 'dummy';
    let entry = dummies.get(slot) ?? memory.get(slot) ?? stars.get(slot);
    let rotation = rotationDeg;
    if (slotKind === 'M' && memory.has(slot)) {
      entry = memory.get(slot);
      kind = m_kind === 'dot' || m_kind === 'tone' ? m_kind : 'dummy';
      if (kind === 'tone') rotation = 0;
    } else if (slotKind === 'S' && stars.has(slot) && s_kind === 'star') {
      entry = stars.get(slot);
      kind = 'star';
    }
    if (!entry || !Number.isInteger(entry.cell)) {
      return { slot, kind, cell: null, x_mm: null, y_mm: null };
    }
    const pos = screenPositionMm(entry.cell, rotation);
    return { slot, kind, cell: entry.cell, x_mm: r3(pos.x_mm), y_mm: r3(pos.y_mm) };
  });
}

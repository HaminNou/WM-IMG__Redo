import { describe, expect, it } from 'vitest';
import { config, PROLIFIC_PRESCREEN_SUMMARY } from '../src/config.js';

function everyObject(value, path, visit) {
  if (value && typeof value === 'object') {
    visit(value, path);
    for (const key of Object.keys(value)) everyObject(value[key], `${path}.${key}`, visit);
  }
}

describe('config', () => {
  it('is frozen at every depth', () => {
    const unfrozen = [];
    everyObject(config, 'config', (obj, path) => {
      if (!Object.isFrozen(obj)) unfrozen.push(path);
    });
    expect(unfrozen).toEqual([]);
  });

  it('cannot be changed by assignment, including nested values and arrays', () => {
    'use strict';
    expect(() => {
      config.uploader.endpoint = 'x';
    }).toThrow(TypeError);
    expect(() => {
      config.pattern.gray_pattern_cells.push(99);
    }).toThrow(TypeError);
    expect(() => {
      config.prolific.payment_policy_text = 'x';
    }).toThrow(TypeError);
  });

  it('freezes the prescreener summary', () => {
    expect(Object.isFrozen(PROLIFIC_PRESCREEN_SUMMARY)).toBe(true);
  });

  it('holds the payment text for screened-out time as one constant', () => {
    expect(typeof config.prolific.payment_policy_text).toBe('string');
    expect(config.prolific.payment_policy_text.length).toBeGreaterThan(0);
  });

  it('uses the neutral build id', () => {
    expect(config.build_id).toBe('v1');
  });
});

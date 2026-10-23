// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import { emitAuxDataRow } from '../src/conditions/shared.js';
import { _resetStorageForTests, getAllTrialRows, initStorage } from '../src/storage.js';

beforeEach(async () => {
  _resetStorageForTests();
  await initStorage({ backend: 'memory' });
});

describe('emitAuxDataRow', () => {
  it('mirrors auxiliary rows into jsPsych memory and persistent storage', async () => {
    const memoryRows = [];
    window.jsPsych = {
      data: {
        get: () => ({
          push: (row) => memoryRows.push(row),
        }),
      },
    };

    emitAuxDataRow({
      phase: 'i_d_star',
      trial_index_in_block: 3,
      responded: true,
      star_correct: false,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(memoryRows).toEqual([
      {
        phase: 'i_d_star',
        trial_index_in_block: 3,
        responded: true,
        star_correct: false,
      },
    ]);

    expect(await getAllTrialRows()).toEqual([
      {
        seq: 1,
        run_id: expect.stringMatching(/^.{8}$/),
        phase: 'i_d_star',
        trial_index_in_block: 3,
        responded: true,
        star_correct: false,
      },
    ]);
  });
});

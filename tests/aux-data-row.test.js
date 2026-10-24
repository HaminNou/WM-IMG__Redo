// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import { emitAuxDataRow } from '../src/conditions/shared.js';
import { setPracticeIteration } from '../src/scheduler/trial-meta.js';
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
        wall_ms: expect.any(Number),
        time_elapsed: null,
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
        wall_ms: expect.any(Number),
        time_elapsed: null,
        phase: 'i_d_star',
        trial_index_in_block: 3,
        responded: true,
        star_correct: false,
      },
    ]);
  });

  it('stamps the wall clock and the elapsed time of the experiment', () => {
    const memoryRows = [];
    window.jsPsych = {
      getTotalTime: () => 1234,
      data: { get: () => ({ push: (row) => memoryRows.push(row) }) },
    };
    emitAuxDataRow({ phase: 'i_t_star' });
    expect(memoryRows[0].time_elapsed).toBe(1234);
    expect(Math.abs(memoryRows[0].wall_ms - Date.now())).toBeLessThan(1000);
  });

  it('stamps the practice pass on practice rows only', () => {
    const memoryRows = [];
    window.jsPsych = { data: { get: () => ({ push: (row) => memoryRows.push(row) }) } };
    setPracticeIteration(2);
    emitAuxDataRow({ phase: 'i_t_star', block_label: 'practice' });
    emitAuxDataRow({ phase: 'i_t_star', block_label: 'main_a' });
    setPracticeIteration(null);
    expect(memoryRows[0].practice_iteration).toBe(2);
    expect(memoryRows[1]).not.toHaveProperty('practice_iteration');
  });
});

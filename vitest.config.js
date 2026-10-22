import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /* DOM-aware modules (visuals/*) are not exercised at the unit-test layer
     * yet — they need a real browser to be meaningful. Pure-math modules
     * (grid.js, audio/tones.js) run in node without jsdom. */
    environment: 'node',
    include: ['tests/**/*.test.js'],
    reporters: ['default'],
  },
});

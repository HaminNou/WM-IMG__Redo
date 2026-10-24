/**
 * Commit and time of the build, injected by Vite (see vite.config.js). Both
 * are 'dev' when the code runs unbuilt (tests, tooling) or git was not
 * available at build time.
 */
/* global __BUILD_COMMIT__, __BUILD_TIME__ */
export const BUILD_COMMIT = typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'dev';
export const BUILD_TIME = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : 'dev';

#!/usr/bin/env node
/**
 * Writes schemas/tidy-tables.schema.json from the column definitions in
 * scripts/tidy-tables.js. Run after changing the columns:
 *   node scripts/make-tidy-schema.js
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTidySchema } from './tidy-tables.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '..', 'schemas', 'tidy-tables.schema.json');
writeFileSync(out, JSON.stringify(buildTidySchema(), null, 2) + '\n', 'utf-8');
console.log(`wrote ${out}`);

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const outputUrl = new URL('../contracts/s2-lite/v1/activation-cutover-golden-v1.json', import.meta.url);
const fixture = JSON.parse(await readFile(outputUrl, 'utf8'));
assert.equal(fixture.schema, 'watchtracker-s2-lite-activation-cutover-golden-v1');
assert.deepEqual(
  fixture.recoveryScenarios.map(value => value.name),
  [
    'not-ready-decision',
    'empty-store-verified-evidence',
    'stale-false-verified-evidence',
    'evidence-before-latch-crash',
    'missing-roundtrip',
    'null-roundtrip',
    'value-roundtrip',
    'null-null-recovery',
    'null-f1-recovery',
    'f1-f1-recovery',
    'f1-f2-recovery',
  ],
);
console.log(`verified ${fixture.scenarios.length} activation/cutover scenarios and ${fixture.recoveryScenarios.length} hand-authored recovery scenarios`);

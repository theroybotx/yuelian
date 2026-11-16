import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const command = 'node --experimental-vm-modules --experimental-transform-types --import ./tests/isolation.mjs --test tests/assistant.test.ts tests/plan-amendment.test.ts tests/generation.test.mjs tests/model-provider.test.mjs tests/model-route.test.mjs';
const wiringCommand = 'node --test tests/provider-wiring.test.mjs';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const workflow = readFileSync(new URL('../.github/workflows/vercel.yml', import.meta.url), 'utf8');

// Deliberately constrain the safety-critical step to a plain unconditional run.
// This is a configuration contract, not evidence that GitHub executed the tests.
function validate(scripts, yaml) {
  assert.equal(scripts['test:provider'], command, 'complete isolated five-file provider entry required');
  assert.equal(scripts['test:provider:wiring'], wiringCommand, 'wiring regression entry required');
  const checks = yaml.split('\n  checks:\n')[1]?.split('\n  database_checks:')[0];
  assert.ok(checks, 'checks job required');
  assert.doesNotMatch(checks, /secrets\.|continue-on-error:/, 'provider checks must remain secretless and fail closed');
  assert.doesNotMatch(checks.split('    steps:')[0], /\n\s+if:/, 'checks job must be unconditional');
  assert.ok(checks.includes('      - name: Isolated provider regression\n        run: |\n          npm run test:provider\n          npm run test:provider:wiring\n'), 'checks must call both entries without masking failures');
}

test('provider and secretless CI wiring are complete', () => validate(pkg.scripts, workflow));
test('missing provider entry is rejected', () => {
  const scripts = {...pkg.scripts}; delete scripts['test:provider'];
  assert.throws(() => validate(scripts, workflow));
});
for (const file of ['tests/model-provider.test.mjs', 'tests/model-route.test.mjs']) {
  test(`omitting ${file} is rejected`, () => {
    assert.throws(() => validate({...pkg.scripts, 'test:provider': command.replace(` ${file}`, '')}, workflow));
  });
}
test('missing isolation preload is rejected', () => {
  assert.throws(() => validate({...pkg.scripts, 'test:provider': command.replace(' --import ./tests/isolation.mjs', '')}, workflow));
});
for (const entry of ['test:provider', 'test:provider:wiring']) {
  test(`CI omission of ${entry} is rejected`, () => {
    assert.throws(() => validate(pkg.scripts, workflow.replace(`          npm run ${entry}\n`, '')));
  });
}
test('masked provider failure is rejected', () => {
  assert.throws(() => validate(pkg.scripts, workflow.replace('npm run test:provider\n', 'npm run test:provider || true\n')));
});

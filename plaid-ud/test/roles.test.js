// The JS peer of plaid-client-py's tests/test_roles.py for `isUdProject`.
//
// The predicate lives in plaid-client-js because two apps ask it: this one of
// its own projects, and plaid-igt's admin area of everyone's. Both clients
// carry it and both are tested, because the day they disagree is the day the
// two apps disagree about what a project is. plaid-client-js has no suite of
// its own, so its half runs here, where the client is already a dependency.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUdProject, ROLES } from '@larc-iu/plaid-client';

const project = (role, spanConfig) => ({
  textLayers: [
    { tokenLayers: [{ config: { plaid: { role } }, spanLayers: [{ config: spanConfig }] }] },
  ],
});

test('isUdProject reads the structure UD alone writes', () => {
  // The ROLE alone does not answer it: plaid-igt tags a morpheme layer and can
  // carry syntactic-word too. The `ud` namespace on the span layers does.
  assert.equal(isUdProject(project(ROLES.SYNTACTIC_WORD, { ud: { upos: true } })), true);
  assert.equal(isUdProject(project(ROLES.SYNTACTIC_WORD, { igt: { gloss: true } })), false);
  // Right namespace, wrong layer: annotations hang off syntactic-word in UD.
  assert.equal(isUdProject(project(ROLES.MORPHEME, { ud: { upos: true } })), false);
  // A `ud` key that is not a namespace object says nothing.
  assert.equal(isUdProject(project(ROLES.SYNTACTIC_WORD, { ud: 'yes' })), false);
  assert.equal(isUdProject(project(ROLES.SYNTACTIC_WORD, {})), false);
  assert.equal(isUdProject({ textLayers: [] }), false);
  assert.equal(isUdProject({}), false);
  assert.equal(isUdProject(undefined), false);
});

test('a project this app builds is recognised by it', async () => {
  // The predicate and the builder must not drift: this is the shape
  // createUdProject produces, read back the way an admin listing returns it.
  const { SPAN_LAYER_SPECS } = await import('../src/domain/udProjectSetup.js');
  const spanLayers = SPAN_LAYER_SPECS.map(([name, key]) => ({
    name,
    config: { ud: { [key]: true } },
  }));
  assert.equal(
    isUdProject({
      textLayers: [
        {
          tokenLayers: [
            { config: { plaid: { role: ROLES.SENTENCE } } },
            { config: { plaid: { role: ROLES.WORD } } },
            { config: { plaid: { role: ROLES.SYNTACTIC_WORD } }, spanLayers },
          ],
        },
      ],
    }),
    true,
  );
});

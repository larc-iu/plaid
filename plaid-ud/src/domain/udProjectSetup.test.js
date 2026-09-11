// What this builder writes has to stay recognisable to the predicate that
// reads it: if createUdProject starts writing a shape isUdProject does not
// read, plaid-igt's admin quietly stops labelling this app's projects and
// nothing else complains.
//
// The predicate's own cases live with it, in plaid-ui. This one is here
// because it needs THIS app's builder, which the shared package must not reach
// into. It runs under vitest rather than `node --test` because the shared
// package's own imports resolve through vite's aliases.
import { describe, expect, it } from 'vitest';
import { ROLES } from '@larc-iu/plaid-client';
import { isUdProject } from '@ui/domain/udProject';
import { SPAN_LAYER_SPECS } from './udProjectSetup.js';

describe('createUdProject and isUdProject', () => {
  it('builds a project the predicate recognises', () => {
    const spanLayers = SPAN_LAYER_SPECS.map(([name, key]) => ({
      name,
      config: { ud: { [key]: true } },
    }));
    expect(
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
    ).toBe(true);
  });
});

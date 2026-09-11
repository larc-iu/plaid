import { describe, expect, it } from 'vitest';
import { ROLES } from '@larc-iu/plaid-client';
import { isUdProject } from './udProject.js';

const project = (role, spanConfig) => ({
  textLayers: [
    { tokenLayers: [{ config: { plaid: { role } }, spanLayers: [{ config: spanConfig }] }] },
  ],
});

describe('isUdProject', () => {
  it('reads the structure UD alone writes', () => {
    expect(isUdProject(project(ROLES.SYNTACTIC_WORD, { ud: { upos: true } }))).toBe(true);
  });

  it('is not answered by the role, which igt carries too', () => {
    expect(isUdProject(project(ROLES.SYNTACTIC_WORD, { igt: { gloss: true } }))).toBe(false);
  });

  it('wants the ud namespace on the syntactic-word layer, not another one', () => {
    expect(isUdProject(project(ROLES.MORPHEME, { ud: { upos: true } }))).toBe(false);
  });

  it('says nothing on a ud key that is not a namespace object', () => {
    expect(isUdProject(project(ROLES.SYNTACTIC_WORD, { ud: 'yes' }))).toBe(false);
  });

  it('tolerates a project with nothing in it', () => {
    expect(isUdProject(project(ROLES.SYNTACTIC_WORD, {}))).toBe(false);
    expect(isUdProject({ textLayers: [] })).toBe(false);
    expect(isUdProject({})).toBe(false);
    expect(isUdProject(undefined)).toBe(false);
  });
});

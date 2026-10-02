import { describe, it, expect } from 'vitest';
import { constraintFindings, relationRules, wantedConstraints } from './umrConstraints.js';

const info = (relationConstraints) => ({
  sentenceTokenLayer: { id: 'sent' },
  relationLayer: {
    id: 'rel',
    name: 'UMR relations',
    ...(relationConstraints ? { constraints: relationConstraints } : {}),
  },
  documentGraphLayer: { id: 'docgraph', name: 'UMR document graph' },
});

describe('wantedConstraints', () => {
  it('asks the sentence graph, and only it, to stay inside the sentence layer', () => {
    expect(wantedConstraints(info())).toEqual([
      {
        kind: 'relation',
        layerId: 'rel',
        namespace: 'umr',
        constraints: [{ type: 'same-ancestor', tokenLayer: 'sent' }],
        stored: null,
      },
    ]);
  });

  it('carries what the layer holds under umr, not what another app declared', () => {
    const held = relationRules('sent');
    const [entry] = wantedConstraints(info({ umr: held, ud: [{ type: 'acyclic' }] }));
    expect(entry.stored).toEqual(held);
    expect(entry.stored).toEqual(entry.constraints);
  });

  it('wants nothing while a layer it names is missing', () => {
    expect(wantedConstraints({ ...info(), relationLayer: null })).toEqual([]);
    expect(wantedConstraints({ ...info(), sentenceTokenLayer: null })).toEqual([]);
    expect(wantedConstraints(null)).toEqual([]);
  });

  it('declares at setup what the open wants', () => {
    expect(relationRules('sent')).toEqual(wantedConstraints(info())[0].constraints);
  });
});

describe('constraintFindings', () => {
  const pending = (violationCount) => ({
    layerId: 'rel',
    kind: 'relation',
    namespace: 'umr',
    constraints: ['same-ancestor'],
    violationCount,
  });

  it('is empty when every rule is in force', () => {
    expect(constraintFindings([], info())).toEqual([]);
    expect(constraintFindings(undefined, info())).toEqual([]);
  });

  // R2-DEBT-APPS-10: worded as every app words it (plaid-ui's rulesNotInForce).
  it('turns a rule left out into one warning naming the layer and the count', () => {
    const [finding, ...rest] = constraintFindings([pending(2)], info());
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({ severity: 'warning', code: 'layer-rules-not-in-force' });
    expect(finding.message).toBe(
      'The same-ancestor rules of "UMR relations" are not in force: 2 stored relations break them.',
    );
    expect(finding.context).toEqual(pending(2));
  });

  it('says one relation in the singular', () => {
    expect(constraintFindings([pending(1)], info())[0].message).toContain(
      '1 stored relation breaks them.',
    );
  });
});

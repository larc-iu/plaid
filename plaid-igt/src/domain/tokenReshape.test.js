import { describe, it, expect } from 'vitest';
import { writerPolicy } from '@larc-iu/plaid-client';
import {
  newHalfMetadata,
  provenanceOf,
  survivingProvenance,
  survivorPatch,
} from './tokenReshape.js';

const verifier = writerPolicy(null);
const contributor = writerPolicy('u1');
const machine = { prov: 'inferred', provSource: 'service:tok' };
const confirmed = { ...machine, provConfirmed: true };

describe('provenanceOf', () => {
  it('takes the provenance keys and leaves everything else', () => {
    expect(provenanceOf({ ...machine, form: 'ab', 'orthog:IPA': 'ab' })).toEqual(machine);
    expect(provenanceOf({ form: 'ab' })).toEqual({});
    expect(provenanceOf(null)).toEqual({});
  });
});

describe('survivingProvenance', () => {
  it('prefers the input that still needs review', () => {
    expect(survivingProvenance([{}, confirmed, machine])).toEqual(machine);
  });
  it('falls back to any provenance at all, so machine origin is not absorbed', () => {
    expect(survivingProvenance([{}, confirmed])).toEqual(confirmed);
  });
  it("is empty when every input is a person's own", () => {
    expect(survivingProvenance([{}, { form: 'a' }])).toEqual({});
  });
});

describe('survivorPatch', () => {
  it("confirms a verifier's reshape of machine material, touching nothing else", () => {
    // The orthography is the user's, and stays: they can edit it down, and we
    // could not write the new value for them anyway.
    expect(survivorPatch({ ...machine, 'orthog:IPA': 'ab' }, {}, verifier.editStamp)).toEqual({
      provConfirmed: true,
    });
  });

  it("marks a contributor's reshape contributed instead", () => {
    const patch = survivorPatch(machine, {}, contributor.editStamp);
    expect(patch).toMatchObject({
      prov: 'contributed',
      provSource: 'user:u1',
      provConfirmed: null,
    });
  });

  it('takes on provenance inherited from a merged-away token', () => {
    expect(survivorPatch({}, machine, verifier.editStamp)).toEqual({
      ...machine,
      provConfirmed: true,
    });
  });

  it('is null for a hand-made token, so nothing is written', () => {
    expect(survivorPatch({}, {}, verifier.editStamp)).toBeNull();
    expect(survivorPatch({ form: 'ab' }, {}, verifier.editStamp)).toBeNull();
  });

  it('writes nothing again for material already confirmed', () => {
    expect(survivorPatch(confirmed, {}, verifier.editStamp)).toBeNull();
  });
});

describe('newHalfMetadata', () => {
  it('gives the new half the origin and the confirmation, and nothing else', () => {
    // No form and no orthography: they describe text this half does not cover.
    expect(
      newHalfMetadata({ ...machine, form: 'abc', 'orthog:IPA': 'abc' }, verifier.editStamp),
    ).toEqual({ ...machine, provConfirmed: true });
  });

  it("is null when the original was a person's, so the half is born bare", () => {
    expect(newHalfMetadata({ form: 'abc', 'orthog:IPA': 'abc' }, verifier.editStamp)).toBeNull();
  });

  it("carries a contributor's stamp when a contributor splits", () => {
    expect(newHalfMetadata(machine, contributor.editStamp)).toMatchObject({
      prov: 'contributed',
      provSource: 'user:u1',
    });
  });
});

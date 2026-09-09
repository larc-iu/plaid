import { describe, it, expect } from 'vitest';
import { writerPolicy } from '@larc-iu/plaid-client';
import {
  clearOrthographies,
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

describe('clearOrthographies', () => {
  it('nulls every orthography key, which is how a patch deletes', () => {
    expect(clearOrthographies({ 'orthog:IPA': 'ab', 'orthog:X': '', form: 'ab' })).toEqual({
      'orthog:IPA': null,
      'orthog:X': null,
    });
    expect(clearOrthographies({ form: 'ab' })).toEqual({});
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
  it("confirms a verifier's reshape of machine material and drops the orthographies", () => {
    expect(survivorPatch({ ...machine, 'orthog:IPA': 'ab' }, {}, verifier.editStamp)).toEqual({
      provConfirmed: true,
      'orthog:IPA': null,
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

  it('is null for a hand-made token with nothing to clear, so nothing is written', () => {
    expect(survivorPatch({}, {}, verifier.editStamp)).toBeNull();
    expect(survivorPatch({ form: 'ab' }, {}, verifier.editStamp)).toBeNull();
  });

  it('writes nothing again for material already confirmed', () => {
    expect(survivorPatch(confirmed, {}, verifier.editStamp)).toBeNull();
  });
});

describe('newHalfMetadata', () => {
  it('gives the new half the origin and the confirmation, and nothing else', () => {
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

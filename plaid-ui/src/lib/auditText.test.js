import { describe, it, expect } from 'vitest';
import { readableDescription } from './auditText.js';

// The audit log is immutable, so these descriptions are already stored with the
// id in them and the tidy-up has to happen at read time.
describe('readableDescription', () => {
  it('drops a trailing row id, whatever preposition introduces it', () => {
    expect(
      readableDescription(
        'Set editor config ud/dependency on layer 01a0971f-5cfd-703b-8865-7a91a69a411f',
      ),
    ).toBe('Set editor config ud/dependency');
    expect(
      readableDescription(
        'Create relation layer "Dependency Relations" in span layer 01a0971f-5c9f-7c48-853e-5ea994260810',
      ),
    ).toBe('Create relation layer "Dependency Relations"');
    expect(
      readableDescription(
        'Unset editor config igt/import on layer 01a0971f-5cfd-703b-8865-7a91a69a411f',
      ),
    ).toBe('Unset editor config igt/import');
  });

  it('leaves a description that names something a reader can see', () => {
    expect(readableDescription('Confirm word analysis')).toBe('Confirm word analysis');
    expect(readableDescription('Create and link vocab item')).toBe('Create and link vocab item');
    expect(readableDescription('Reconcile layers on open')).toBe('Reconcile layers on open');
    // A form that merely looks id-ish is not a UUID and stays.
    expect(readableDescription('Respell to 01a0971f')).toBe('Respell to 01a0971f');
  });

  it('passes anything that is not a string straight through', () => {
    expect(readableDescription(undefined)).toBe(undefined);
    expect(readableDescription(null)).toBe(null);
  });
});

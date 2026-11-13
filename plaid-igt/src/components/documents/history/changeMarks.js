import { PROV_STATES } from '@larc-iu/plaid-client';
import { countOf } from '@ui/lib/plural.js';
import { PROV_WORDS } from '@/domain/historyChanges.js';

// The marks a value wears in History's view of what an entry changed: the
// provenance marks every app draws (plaid-ui's index.css, the Analyze grid's
// legend), on the old value and the new alike, so whose a value was reads as
// it reads in the grid. A person's value is plain.
const PROV_CLASS = {
  [PROV_STATES.MACHINE]: 'plaid-prov--machine',
  [PROV_STATES.CONTRIBUTED]: 'plaid-prov--contributed',
  [PROV_STATES.VERIFIED]:
    'underline decoration-[var(--plaid-machine-soft)] decoration-solid underline-offset-[3px]',
};
export const provClass = (prov) => PROV_CLASS[prov] ?? '';

/** What a value's tooltip says of whose it was or is. */
export const provTitle = (prov) => (prov ? PROV_WORDS[prov] : undefined);

/** "12 changes, 3 replaced a person’s value". */
export const countLine = (changes, replaced) =>
  `${countOf(changes, 'change')}, ${replaced.toLocaleString()} replaced a person’s value`;

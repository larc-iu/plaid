// What a marked value's tooltip says of the producer's confidence, shared by
// both apps so a value reads the same in each. Null for anything but an
// unreviewed machine value with a probability (machineProb). Rounded down, so
// a value marked as below a 50% threshold never says "50%".
import { machineProb } from '../../../plaid-client-js/src/provenance.js';

export const confidenceNote = (metadata) => {
  const p = machineProb(metadata);
  // The nudge keeps 0.58 at 58%, which 0.58 * 100 = 57.99… would floor to 57.
  return p == null ? null : `${Math.floor(p * 100 + 1e-9)}% confident`;
};

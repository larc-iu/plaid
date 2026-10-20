// What a marked value's tooltip says of the producer's confidence, shared by
// both apps so a value reads the same in each. Null for anything but an
// unreviewed machine value with a probability (machineProb).
import { machineProb } from '../../../plaid-client-js/src/provenance.js';

export const confidenceNote = (metadata) => {
  const p = machineProb(metadata);
  return p == null ? null : `${Math.round(p * 100)}% confident`;
};

import { stampInferred } from '@larc-iu/plaid-client';
import { pendingId } from '../../../plaid-ui/src/domain/pendingIds.js';

// The lemma a new word starts with is a copy of its form, made by a rule and
// by no person, so a parser may replace it (provenance write contract rule 1).
const LEMMA_FROM_FORM = stampInferred('rule:lemma-from-form');

// What a new UD word carries, whichever write makes it: the word over `at`
// (its token's extent, with its place among the token's words when given),
// and, when the project has a Lemma layer, its lemma copied from `form`.
// Both under ids minted by `mint`, pending ids by default. Tokenize, a token's
// words typed, a token made from a selection, the first write on a word with
// no UD word yet and the set-up of a project another app made all make their
// words here.
export const newUdWord = ({ begin, end, precedence }, form, lemmaLayer, mint = pendingId) => {
  const word = { id: mint(), begin, end, ...(precedence != null ? { precedence } : {}) };
  const lemma = lemmaLayer?.id
    ? { id: mint(), tokens: [word.id], value: form, metadata: LEMMA_FROM_FORM }
    : null;
  return { word, lemma };
};

import { stampInferred } from '@larc-iu/plaid-client';
import { pendingId } from '../../../plaid-ui/src/domain/pendingIds.js';
import pkg from '../../package.json' with { type: 'json' };
import RULE from './lemmaRuleVersion.json' with { type: 'json' };

// The lemma a new word starts with is a copy of its form, made by a rule and
// by no person, so a parser may replace it (provenance write contract rule 1).
// Its provDetail names the rule and the version of the code that wrote it, as
// igt's built-in rules do (builtinVersion.js there): `<package version>+<8
// hex>`, the hex the start of a SHA-256 over one `sha256sum` line per file
// lemmaRuleVersion.json lists, which is this file.
// test/lemmaRuleVersion.test.js fails when this file changes and the hash
// there is not brought up to date.
export const LEMMA_FROM_FORM = stampInferred('rule:lemma-from-form', {
  detail: { model: RULE.model, version: `${pkg.version}+${RULE.hash}` },
});

// The lemma the rule gives the word `wordId` whose form is `form`, under an id
// minted by `mint`.
export const lemmaFromForm = (wordId, form, mint = pendingId) => ({
  id: mint(),
  tokens: [wordId],
  value: form,
  metadata: LEMMA_FROM_FORM,
});

// What a new UD word carries, whichever write makes it: the word over `at`
// (its token's extent, with its place among the token's words when given),
// and, when the project has a Lemma layer, its lemma copied from `form`.
// Both under ids minted by `mint`, pending ids by default. Tokenize, a token's
// words typed, a token made from a selection, the first write on a word with
// no UD word yet and the set-up of a project another app made all make their
// words here.
export const newUdWord = ({ begin, end, precedence }, form, lemmaLayer, mint = pendingId) => {
  const word = { id: mint(), begin, end, ...(precedence != null ? { precedence } : {}) };
  const lemma = lemmaLayer?.id ? lemmaFromForm(word.id, form, mint) : null;
  return { word, lemma };
};

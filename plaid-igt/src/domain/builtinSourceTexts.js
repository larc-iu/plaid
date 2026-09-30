// The text of every file a built-in rule's version hashes, by its path in the
// repository (builtinSources.json names which files each rule's are), as the
// bundle holds it. A module of its own, loaded the first time a rule stamps,
// so the page does not carry this text until a rule runs.

import s0 from '../../../plaid-client-js/src/provenance.js?raw';
import s24 from '../../../plaid-client-js/src/ids.js?raw';
import s1 from './affixMarkers.js?raw';
import s2 from './analysisMemory.js?raw';
import s3 from './autoLink.js?raw';
import s4 from './autoPass.js?raw';
import s6 from './fieldNames.js?raw';
import s7 from './igtConfig.js?raw';
import s9 from './mutations/analysisCopy.js?raw';
import s10 from './mutations/vocab.js?raw';
import s11 from './mwe.js?raw';
import s12 from './precedent.js?raw';
import s13 from './tagsets.js?raw';
import s14 from './virtualMorpheme.js?raw';
import s15 from './vocabDictionary.js?raw';
import s16 from './vocabFields.js?raw';
import s17 from './vocabLookup.js?raw';
import s18 from './zeroMorph.js?raw';
import s19 from '@ui/domain/collation.js?raw';
import s20 from '@ui/domain/morphemes.js?raw';
import s21 from '@ui/domain/pendingIds.js?raw';
import s23 from '@ui/domain/setupGuard.js?raw';
import s25 from '@ui/domain/glossCase.js?raw';

export const SOURCE_TEXTS = {
  'plaid-client-js/src/ids.js': s24,
  'plaid-client-js/src/provenance.js': s0,
  'plaid-igt/src/domain/affixMarkers.js': s1,
  'plaid-igt/src/domain/analysisMemory.js': s2,
  'plaid-igt/src/domain/autoLink.js': s3,
  'plaid-igt/src/domain/autoPass.js': s4,
  'plaid-igt/src/domain/fieldNames.js': s6,
  'plaid-igt/src/domain/igtConfig.js': s7,
  'plaid-igt/src/domain/mutations/analysisCopy.js': s9,
  'plaid-igt/src/domain/mutations/vocab.js': s10,
  'plaid-igt/src/domain/mwe.js': s11,
  'plaid-igt/src/domain/precedent.js': s12,
  'plaid-igt/src/domain/tagsets.js': s13,
  'plaid-igt/src/domain/virtualMorpheme.js': s14,
  'plaid-igt/src/domain/vocabDictionary.js': s15,
  'plaid-igt/src/domain/vocabFields.js': s16,
  'plaid-igt/src/domain/vocabLookup.js': s17,
  'plaid-igt/src/domain/zeroMorph.js': s18,
  'plaid-ui/src/domain/collation.js': s19,
  'plaid-ui/src/domain/glossCase.js': s25,
  'plaid-ui/src/domain/morphemes.js': s20,
  'plaid-ui/src/domain/pendingIds.js': s21,
  'plaid-ui/src/domain/setupGuard.js': s23,
};

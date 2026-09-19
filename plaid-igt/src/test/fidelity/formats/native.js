// The native "Plaid IGT JSON" archive (docs/native-format.md), checked as a round trip: a
// project is exported with the default options (media included), the archive is imported into
// a new project, and the two are compared. "Carried" means the feature comes back as it was,
// apart from the import's own bookkeeping listed under `stamps`. The contract promises a
// lossless archive of the IGT slice of a project, so everything in that slice is declared
// carried, including data only another importer writes. Other apps' layers and config on the
// baseline text layer ride along as opaque Plaid data (`otherConfig`, `otherLayers`), so they
// are carried too. What the archive leaves out on purpose is the review list, and comments and
// promoted examples pointing at things that no longer exist. Comments are re-posted by the
// importer, which is a known transformation, not a loss.

// How every imported comment differs from the one it was exported from.
const REPOSTED = [
  'The comment is posted anew by the importing user, so its author is the importer and edited is false.',
  'Its body opens with the note "> Imported from an archive. Originally posted by AUTHOR on YYYY-MM-DD." and a blank line,',
  'where AUTHOR is "Name <id>", or the bare id when there is no display name.',
  'A note of that shape already at the top of the body is replaced rather than stacked,',
  'and no note is added when it would take the body past 10000 characters.',
  'stripAttribution in src/import/native/commentAttribution.js recovers the original body.',
].join(' ');

const carried = { carried: true };
const reposted = { carried: 'changed', how: REPOSTED };

export default {
  id: 'native',
  name: 'Plaid IGT JSON archive',
  check: 'roundTrip',
  stamps: {
    // Setup marks the project initialized, and an import in flight is recorded under `import`
    // until it finishes.
    projectConfig: ['initialized', 'import'],
    // src/import/resume.js: the archive's document id, and the done marker written last.
    documentMetadata: ['importSource', 'importDone'],
    tokenMetadata: [],
    // The archive item id, stamped on every entry the importer creates.
    itemMetadata: ['nativeImportId'],
  },
  features: {
    // Project configuration
    'project.documentMetadataFields': carried,
    'project.documentMetadataTagset': carried,
    'project.tagset': carried,
    'project.tagsetModeSuggest': carried,
    'project.tagsetModeClosed': carried,
    'project.tagsetModeMixed': carried,
    'project.tagsetDelimiters': carried,
    'project.tagsetValueDescription': carried,
    'project.tagsetOrdered': carried,
    'project.languageObject': carried,
    'project.languageMeta': carried,
    'project.languageCoordinates': carried,
    'project.speakers': carried,
    'project.serviceDefaults': carried,
    'project.autoAnalysis': carried,
    'project.compose': carried,
    'project.exportPresets': carried,
    'project.reviewedMembers': {
      carried: false,
      kind: 'ruled',
      why: 'names users, so it goes with permissions and is not archived',
      ruling: 'docs/native-format.md, Provenance',
    },
    // Every namespace but igt and plaid, verbatim (otherConfig).
    'project.foreignConfig': carried,

    // Layers
    'layers.orthography': carried,
    'layers.ignoredTokensPunctuation': carried,
    'layers.ignoredTokensLetterLike': carried,
    'layers.ignoredTokensBlacklist': carried,
    'layers.fieldSentence': carried,
    'layers.fieldWord': carried,
    'layers.fieldMorpheme': carried,
    'layers.fieldSameNameTwoScopes': carried,
    // Setup creates the fields in schema order, which is the source's order_idx order.
    'layers.fieldOrder': carried,
    'layers.fieldLang': carried,
    'layers.fieldTagset': carried,
    // Other apps' layers, their config verbatim (otherLayers in project.json).
    'layers.foreignTokenLayer': carried,
    'layers.unscopedSpanLayer': carried,
    'layers.relationLayer': carried,
    'layers.fieldEmpty': carried,

    // Vocabularies: their schema
    'vocab.linked': {
      carried: 'changed',
      how: 'Comes back as it was, except that a vocabulary whose settings list no fields at all comes back listing the two built-in ones, gloss as { inline: true } and morphType as { inline: false }, and no tagsets. The archive writes the fields an entry shows (normalizeVocabFields), and those two are shown whether listed or not, so nothing on screen changes.',
    },
    'vocab.second': carried,
    'vocab.customField': carried,
    'vocab.fieldNotInline': carried,
    'vocab.fieldTagset': carried,
    'vocab.fieldLang': carried,
    'vocab.fieldMultilingual': carried,
    'vocab.fieldItemRef': carried,
    'vocab.fieldItemRefMany': carried,
    'vocab.fieldEntryScope': carried,
    'vocab.customTagset': carried,
    'vocab.foreignConfig': carried,
    // The importer finds each vocabulary's target by name, so the second of two same-named
    // vocabularies is written into the first. Suspected bug.
    'vocab.duplicateName': {
      carried: false,
      kind: 'ruled',
      why: 'The import refuses an archive holding two vocabularies with one name, since it finds each one’s place in the new project by name.',
      ruling:
        'user, 2026-09-17: two vocabularies with one name are a user error, and the import is blocked',
    },
    'vocab.fieldAliasName': carried,

    // Vocabularies: entries
    'item.gloss': carried,
    'item.pos': carried,
    'item.morphType': carried,
    'item.definition': carried,
    'item.status': carried,
    'item.lexemeForm': carried,
    'item.customFieldValue': carried,
    'item.multilingualValue': carried,
    'item.itemRefValue': carried,
    'item.itemRefManyValue': carried,
    'item.sense': carried,
    'item.subsense': carried,
    'item.senseOrder': carried,
    'item.homonyms': carried,
    'item.homographNumber': carried,
    'item.exampleCorpus': carried,
    'item.exampleText': carried,
    'item.flexIdentity': carried,
    'item.provenance': carried,
    'item.zeroMorph': carried,
    'item.unlinked': carried,
    'item.extraMetadata': carried,
    'item.markupChars': carried,
    'item.surroundingWhitespace': carried,
    'item.offTagset': carried,
    'item.formNormalization': carried,
    'item.containerHeadword': carried,
    'item.exampleStale': {
      carried: false,
      kind: 'ruled',
      why: 'an example whose document or token is not in the archive has nothing to point at in the new project, so the last import pass drops it and counts it in a warning',
      ruling:
        'docs/native-format.md, vocabularies/*.json (a reference whose target is not in the archive is dropped) and Re-import contract step 4',
    },

    // Documents
    'document.metadataConfigured': carried,
    'document.metadataUnconfigured': carried,
    'document.textDirection': carried,
    'document.speechDetection': carried,
    'document.media': carried,
    'document.noText': carried,
    'document.untokenized': carried,
    'document.duplicateName': carried,
    'document.nameSpecialChars': carried,
    'document.metadataLang': carried,
    'document.partlyAligned': carried,
    'document.differentFilledFields': carried,

    // What the text is made of
    'text.astral': carried,
    'text.combining': carried,
    'text.rtlScript': carried,
    'text.multiline': carried,
    'text.blankLine': carried,
    'text.markupChars': carried,
    'text.zeroMorph': carried,

    // Tokens
    'token.sentence': carried,
    'token.word': carried,
    'token.ignoredWord': carried,
    'token.untokenizedText': carried,
    'token.orthographyValue': carried,
    'token.orthographyUnconfigured': carried,
    'token.wordExtraMetadata': carried,
    'token.segmentedWord': carried,
    'token.singleStoredMorpheme': carried,
    'token.unanalyzedWord': carried,
    'token.morphemeForm': carried,
    'token.morphemeFormEmpty': carried,
    'token.morphemeFormAbsent': carried,
    'token.morphemeZero': carried,
    'token.morphTypeOnMorpheme': carried,
    'token.orphanMorpheme': carried,
    'token.provenance': carried,
    'token.wordsInOneRun': carried,
    'token.wordEdgePunctuation': carried,
    'token.sentenceExtraMetadata': carried,
    'token.morphemeProvenance': carried,
    'token.procliticBeforeMorpheme': carried,
    'alignment.provenance': carried,
    'alignment.severalInSentence': carried,
    'alignment.straddlesSentences': carried,
    'alignment.mixedSpeakersInSentence': carried,
    'alignment.textAcrossLineBreak': carried,
    'alignment.times': carried,
    'alignment.speaker': carried,
    'alignment.extraMetadata': carried,
    'alignment.notSentenceExtent': carried,
    'alignment.overlappingTimes': carried,

    // Annotations
    'span.sentenceValue': carried,
    'span.wordValue': carried,
    'span.morphemeValue': carried,
    // A multi-token span that shares a token with an earlier span in the same field comes back
    // without that token. Suspected bug.
    'span.multiToken': carried,
    'span.duplicate': carried,
    // Written to extraSpans at export and skipped at import (no layer to resolve). Suspected bug.
    'span.onForeignLayer': carried,
    'span.onAlignment': carried,
    'span.provHuman': carried,
    'span.provMachine': carried,
    'span.provContributed': carried,
    'span.provVerified': carried,
    'span.provSource': carried,
    'span.provProb': carried,
    'span.provDetail': carried,
    'span.extraMetadata': carried,
    'span.offTagset': carried,
    'span.delimitedValue': carried,
    'span.markupChars': carried,
    'span.multilineValue': carried,
    'span.emptyValue': carried,
    // The later span is written only at the tokens where it is the first in its field, and
    // import rebuilds it from those. Suspected bug, see span.multiToken.
    'span.overlapSameField': carried,
    'span.reachesOrphanToken': carried,
    'span.valueWhitespace': carried,

    // Vocabulary links
    'link.word': carried,
    'link.morpheme': carried,
    'link.mwe': carried,
    'link.mweDiscontinuous': carried,
    'link.mweAcrossSentences': carried,
    'link.onSentence': carried,
    'link.duplicateOnToken': carried,
    'link.toSense': carried,
    'link.secondVocabulary': carried,
    'link.provHuman': carried,
    'link.provMachine': carried,
    'link.provContributed': carried,
    'link.provVerified': carried,
    'link.provSource': carried,
    'link.provProb': carried,
    'link.provDetail': carried,
    'link.onSegment': carried,
    'link.onOrphanToken': carried,
    // The morpheme node carries the token's own morphType, never the entry's.
    'link.entryMorphType': carried,

    // Relations
    'relation.value': carried,

    // Comments
    'comment.document': reposted,
    'comment.text': reposted,
    'comment.sentence': reposted,
    'comment.word': reposted,
    'comment.morpheme': reposted,
    'comment.segment': reposted,
    'comment.annotation': reposted,
    'comment.entry': reposted,
    'comment.relation': reposted,
    'comment.orphaned': {
      carried: false,
      kind: 'ruled',
      why: 'a comment whose anchor has been deleted is dropped at export, since an import has nothing to post it on and the server refuses a missing anchor',
      ruling: 'docs/native-format.md, Comments',
    },
    'comment.edited': {
      carried: false,
      kind: 'ruled',
      why: 'an import posts every comment anew and the server stamps both timestamps from the clock, so no imported comment reads as edited, and the attribution note records only the first posting date',
      ruling: 'docs/native-format.md, Attribution does not survive re-import',
    },
    'comment.anchorLabel': carried,
    'comment.secondAuthor': {
      carried: 'changed',
      how: `Every imported comment has the importing user as its author, so comments by different people share one author. The original author survives only as AUTHOR in the attribution note, which formatAuthor in src/import/native/commentAttribution.js writes and a comparison can read back out of the body. ${REPOSTED}`,
    },
    'comment.markdown': {
      carried: 'changed',
      how: `The body keeps its own lines and gains the attribution note and a blank line above them, so a one-line comment also comes back over several lines. ${REPOSTED}`,
    },

    // Guidelines
    'guideline.present': carried,
    'guideline.pinned': carried,
    'guideline.emptyBody': carried,
    'guideline.duplicateTitle': carried,
  },
};

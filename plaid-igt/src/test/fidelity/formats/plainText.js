// The plain-text document export (src/export/plainTextDoc.js), checked as an export only. The
// preset is judged with everything on: every orthography and field selected, the word line
// printed both as written and segmented, sentences numbered, the document header included, and
// speakers left on. "Carried" means the information appears in the written text. The export is
// one aligned interlinear block per sentence, so most of what a project holds has no place in
// it. A project zip can add the vocabularies as TSV files, and the vocabTsv list answers for
// those, so here every vocabulary feature is outside the format.

const inherent = (why) => ({ carried: false, kind: 'inherent', why });
const foreign = (why) => ({ carried: false, kind: 'foreign', why });
const ruled = (why, ruling) => ({ carried: false, kind: 'ruled', why, ruling });
const undecided = (why) => ({ carried: false, kind: 'undecided', why });

const PROJECT_CONFIG = inherent(
  'The file is one document, its header and its sentences. Project configuration is not written.',
);
const VOCABULARY = inherent(
  'The file is the text of one document. A project zip can add each vocabulary as a TSV file beside it, and the vocabTsv list answers for that.',
);
const PROVENANCE = inherent(
  'Values are written without any mark of who or what made them. Plain text has no place for provenance.',
);
const COMMENTS = ruled(
  'Comments go into no interchange format, only the native archive.',
  'plaid_comments.md, ruled out 2026-08-31 in commit 87cb70e3. A non-native preset says so in ExportPresetEditor.jsx: "Comments left on a document (the Comments tab) are not exported." runExport.js loads comments for the native archive only.',
);
const GUIDELINES = ruled(
  'Guidelines go into the native archive only.',
  'runExport.js: "The project\'s annotation manual, on the same terms as comments: the native archive only." plaid_guidelines.md, 2026-09-15.',
);
const ORPHANS = ruled(
  'A morpheme whose extent matches no word has no word column to print under, and the derived view never places it.',
  'plaid_data_integrity_validators.md: every orphan morpheme is deleted when the editor opens the document (the delete-all-orphans policy).',
);
const ENTRY_TIER = undecided(
  "No line names the entry a word or morpheme is linked to, and nothing marks a multi-word expression. A plain-text interlinear could print such a line, as .flextext carries each morph's entry, and nothing says it should not.",
);

export default {
  id: 'plainText',
  name: 'Plain text',
  check: 'export',
  stamps: { projectConfig: [], documentMetadata: [], tokenMetadata: [], itemMetadata: [] },
  features: {
    // Project configuration
    'project.documentMetadataFields': {
      carried: 'changed',
      how: 'A switched-on field shows only as the label before its value in the document header ("Genre: story"), in a document that holds a non-empty value for it.',
    },
    'project.documentMetadataTagset': PROJECT_CONFIG,
    'project.tagset': PROJECT_CONFIG,
    'project.tagsetModeSuggest': PROJECT_CONFIG,
    'project.tagsetModeClosed': PROJECT_CONFIG,
    'project.tagsetModeMixed': PROJECT_CONFIG,
    'project.tagsetDelimiters': PROJECT_CONFIG,
    'project.tagsetValueDescription': PROJECT_CONFIG,
    'project.tagsetOrdered': PROJECT_CONFIG,
    'project.languageObject': PROJECT_CONFIG,
    'project.languageMeta': PROJECT_CONFIG,
    'project.languageCoordinates': PROJECT_CONFIG,
    'project.speakers': PROJECT_CONFIG,
    'project.serviceDefaults': PROJECT_CONFIG,
    'project.autoAnalysis': PROJECT_CONFIG,
    'project.compose': PROJECT_CONFIG,
    'project.exportPresets': inherent(
      'The preset decides what the file holds, but the preset itself is not written into it.',
    ),
    'project.reviewedMembers': PROJECT_CONFIG,
    'project.foreignConfig': foreign("Another app's project configuration."),

    // Layers
    'layers.orthography': {
      carried: 'changed',
      how: "An orthography shows as an unlabeled line of cells under the word lines, in the project's order, and only in a sentence where some word has a value in it.",
    },
    'layers.ignoredTokensPunctuation': inherent(
      'The rule is not written. Its effect shows only as a punctuation word printed with no morphemes.',
    ),
    'layers.ignoredTokensLetterLike': PROJECT_CONFIG,
    'layers.ignoredTokensBlacklist': PROJECT_CONFIG,
    'layers.fieldSentence': {
      carried: 'changed',
      how: 'A sentence field shows as the label of its free line ("Translation: ..."), in a sentence where its value is not empty.',
    },
    'layers.fieldWord': {
      carried: 'changed',
      how: 'A word field shows as an unlabeled line of cells aligned under the words, after the morpheme field lines, and is left out of a sentence where no word has a value in it.',
    },
    'layers.fieldMorpheme': {
      carried: 'changed',
      how: "A morpheme field shows as an unlabeled line aligned under the words, each cell the word's morpheme values joined with - and =, after the orthography lines, and is left out of a sentence where no morpheme has a value in it.",
    },
    'layers.fieldSameNameTwoScopes': {
      carried: 'changed',
      how: 'Both fields print, each on its own unlabeled line, the morpheme field before the word field. Nothing on the page names either.',
    },
    'layers.fieldOrder': {
      carried: true,
      where:
        "the lines of one scope follow the project's field order, since intersectSelection keeps the order of the discovered inventory rather than the preset's",
    },
    'layers.fieldLang': PROJECT_CONFIG,
    'layers.fieldTagset': PROJECT_CONFIG,
    'layers.foreignTokenLayer': foreign(
      'A token layer another app uses. The export reads the IGT roles only.',
    ),
    'layers.unscopedSpanLayer': foreign(
      'A span layer with no IGT scope. The export offers scoped fields only.',
    ),
    'layers.relationLayer': foreign('Relations belong to plaid-ud.'),
    'layers.fieldEmpty': ruled(
      'A field with no values prints no line anywhere, so nothing shows that it exists.',
      'plainTextDoc.js formatSentencePlain drops a tier with no values in a sentence "so it doesn\'t render as a run of blank lines" (commit 976390fb), pinned by plainTextDoc.test.js "drops tiers with no values in this sentence".',
    ),

    // Vocabularies: their schema
    'vocab.linked': VOCABULARY,
    'vocab.second': VOCABULARY,
    'vocab.customField': VOCABULARY,
    'vocab.fieldNotInline': VOCABULARY,
    'vocab.fieldTagset': VOCABULARY,
    'vocab.fieldLang': VOCABULARY,
    'vocab.fieldMultilingual': VOCABULARY,
    'vocab.fieldItemRef': VOCABULARY,
    'vocab.fieldItemRefMany': VOCABULARY,
    'vocab.fieldEntryScope': VOCABULARY,
    'vocab.customTagset': VOCABULARY,
    'vocab.foreignConfig': foreign("plaid-dict's publication record on a vocabulary."),
    'vocab.duplicateName': VOCABULARY,
    'vocab.fieldAliasName': VOCABULARY,

    // Vocabularies: entries
    'item.gloss': VOCABULARY,
    'item.pos': VOCABULARY,
    'item.morphType': VOCABULARY,
    'item.definition': VOCABULARY,
    'item.status': VOCABULARY,
    'item.lexemeForm': VOCABULARY,
    'item.customFieldValue': VOCABULARY,
    'item.multilingualValue': VOCABULARY,
    'item.itemRefValue': VOCABULARY,
    'item.itemRefManyValue': VOCABULARY,
    'item.sense': VOCABULARY,
    'item.subsense': VOCABULARY,
    'item.senseOrder': VOCABULARY,
    'item.homonyms': VOCABULARY,
    'item.homographNumber': VOCABULARY,
    'item.exampleCorpus': VOCABULARY,
    'item.exampleText': VOCABULARY,
    'item.flexIdentity': VOCABULARY,
    'item.provenance': VOCABULARY,
    'item.zeroMorph': VOCABULARY,
    'item.unlinked': VOCABULARY,
    'item.extraMetadata': VOCABULARY,
    'item.markupChars': VOCABULARY,
    'item.surroundingWhitespace': VOCABULARY,
    'item.offTagset': VOCABULARY,
    'item.formNormalization': VOCABULARY,
    'item.containerHeadword': VOCABULARY,
    'item.exampleStale': VOCABULARY,

    // Documents
    'document.metadataConfigured': {
      carried: true,
      where: 'the document header, one "Name: value" line per switched-on field with a value',
    },
    'document.metadataUnconfigured': ruled(
      'The header prints the switched-on fields only.',
      'plainTextDoc.js documents the header of serializeDocumentPlain as "configured metadata already filtered into igtDoc.document.metadata", and IgtDocument.js says document.metadata carries only the configured fields, not the marks importers and the Media tab leave.',
    ),
    'document.textDirection': inherent(
      'Plain text has no place for a reading direction. The characters are written as they are and a reader lays them out.',
    ),
    'document.speechDetection': inherent(
      'Speech-detection cuts are working state for the Media tab, not text.',
    ),
    'document.media': inherent('A text file holds no recording.'),
    'document.noText': {
      carried: true,
      where: 'a file holding the header alone',
    },
    // SUSPECTED BUG: the sentences print "(n)" and nothing else, since the cells come from
    // sentence.tokens and never from the untokenized text (plainTextDoc.js sentenceTierLines).
    'document.untokenized': {
      carried: true,
      where: "each sentence's text on its word line, as one cell",
    },
    'document.duplicateName': {
      carried: true,
      where:
        'each file\'s header holds the name as it is. In a zip the second file is named "name (2).txt".',
    },
    'document.nameSpecialChars': {
      carried: true,
      where:
        'the header holds the name as it is. The file name has those characters replaced by spaces.',
    },
    'document.metadataLang': {
      carried: true,
      where:
        'the document header, under the field\'s full name ("Title (en): ..."), for a switched-on field',
    },
    'document.partlyAligned': undecided(
      'Which sentences are time-aligned shows only as a speaker prefix, and only where the segment has a speaker. Printing times, the question under alignment.times, would show it.',
    ),
    // SUSPECTED BUG: word and morpheme lines are unlabeled, and a line with no values in a
    // sentence is dropped, so where one document (or sentence) fills fewer fields than another,
    // a line's position no longer says which field it is.
    'document.differentFilledFields': {
      carried: true,
      where: 'each file prints lines for the fields that hold values in each sentence',
    },

    // What the text is made of
    'text.astral': {
      carried: true,
      where: 'written as is. Cells are padded by code points, so the character counts as one.',
    },
    'text.combining': {
      carried: true,
      where:
        'written as is. Cells are padded by code points, so a combining mark counts as a column of width and the cells after it sit one space short.',
    },
    'text.rtlScript': {
      carried: true,
      where: 'written as is, in logical order',
    },
    'text.multiline': inherent(
      "The file is laid out one block per sentence. The baseline's own line breaks are not written.",
    ),
    'text.blankLine': inherent(
      'The file is laid out one block per sentence. A blank line in the baseline is not written.',
    ),
    // SUSPECTED BUG for the characters the tokenizer leaves outside words (a comma, quotes):
    // they are dropped, as in token.untokenizedText.
    'text.markupChars': {
      carried: true,
      where: 'written as is on the word lines, with no escaping',
    },
    'text.zeroMorph': {
      carried: true,
      where: 'written as is on the word lines',
    },

    // Tokens
    'token.sentence': {
      carried: true,
      where: 'one block per sentence, numbered (1), (2) and so on',
    },
    'token.word': {
      carried: true,
      where: 'one column per word on the word lines',
    },
    'token.ignoredWord': {
      carried: true,
      where: 'a column of its own on the word lines, empty on the morpheme field lines',
    },
    // SUSPECTED BUG: plainTextDoc.js builds its columns from sentence.tokens, so text between
    // words is dropped. The Copy as IGT formats walk sentence.pieces and give such text a
    // column of its own (igtExport.js columnCells, commit 27ee7c90), and .flextext writes it as
    // a punct word.
    'token.untokenizedText': {
      carried: true,
      where: 'a column of its own on the word lines, empty on the field lines',
    },
    'token.orthographyValue': {
      carried: true,
      where: "the cell under the word on that orthography's line",
    },
    'token.orthographyUnconfigured': ruled(
      'Only the orthographies the word layer configures are offered and printed.',
      'runExport.js serializeDoc: "Drop tier names that no longer exist in the project configuration" (intersectSelection in exportLayers.js). derive.js collectOrthographies reads the configured names only.',
    ),
    'token.wordExtraMetadata': inherent(
      'Metadata the app does not define is not an annotation tier.',
    ),
    'token.segmentedWord': {
      carried: true,
      where: 'the segmented word line, the morpheme forms joined with - and =',
    },
    'token.singleStoredMorpheme': {
      carried: true,
      where: "the morpheme's form on the segmented word line",
    },
    'token.unanalyzedWord': {
      carried: 'changed',
      how: 'The segmented word line prints the word itself, the same as for a word analyzed as one morpheme with that form. Its morpheme field cells are empty.',
    },
    'token.morphemeForm': {
      carried: true,
      where: 'the segmented word line',
    },
    'token.morphemeFormEmpty': {
      carried: 'changed',
      how: 'The morpheme prints as nothing between its joints ("vuelt-=a"). A word whose every morpheme form is empty prints an empty cell.',
    },
    'token.morphemeFormAbsent': {
      carried: 'changed',
      how: "The morpheme prints the word's own text as its form, as the editor shows it, so it reads the same as a form equal to the word.",
    },
    'token.morphemeZero': {
      carried: true,
      where: '∅ written as is on the segmented word line',
    },
    'token.morphTypeOnMorpheme': {
      carried: 'changed',
      how: "A morph type shows only through the joint beside the morpheme: = when either neighbour is a clitic, - otherwise. A linked entry's morph type is used in place of the morpheme's own. Stems, prefixes, suffixes and the rest read alike.",
    },
    'token.orphanMorpheme': ORPHANS,
    'token.provenance': PROVENANCE,
    'token.wordsInOneRun': {
      carried: 'changed',
      how: 'The two words print as separate columns, the same as words a space divides, so the file does not show that they were written as one run.',
    },
    'token.wordEdgePunctuation': {
      carried: true,
      where: "the word's own text, punctuation included, on the word lines",
    },
    'token.sentenceExtraMetadata': inherent('Sentence metadata is not an annotation tier.'),
    'token.morphemeProvenance': PROVENANCE,
    'token.procliticBeforeMorpheme': {
      carried: true,
      where: 'the segmented word line, the proclitic joined to the morpheme after it with =',
    },

    // Time alignment
    'alignment.provenance': PROVENANCE,
    'alignment.severalInSentence': undecided(
      'A sentence holding several segments gets no speaker prefix, even when every one of them has the same speaker, because only a segment that matches or contains the sentence gives one (flextext.js coveringAlignment). The rule there is never to print a wrong speaker, which one shared speaker would not be.',
    ),
    'alignment.straddlesSentences': inherent(
      'The file is laid out by sentence. A segment crossing a boundary matches neither sentence, so it gives neither a speaker (flextext.js: partial overlaps are skipped, alignment is never invented).',
    ),
    'alignment.mixedSpeakersInSentence': ruled(
      'A sentence whose segments differ in speaker gets no speaker prefix.',
      'flextext.js phraseSpeakerFor: "a phrase that straddles a speaker change just gets no speaker rather than a wrong one". plainTextDoc.js uses it so a sentence gets a speaker prefix in exactly the cases it gets a FLEx phrase speaker.',
    ),
    'alignment.textAcrossLineBreak': inherent(
      "The file is laid out by sentence and word. The segment's line breaks and runs of spaces are not written.",
    ),
    'alignment.times': undecided(
      "A segment's speaker is written as a transcript-style prefix on the sentence it covers, but its times are not. A plain-text transcript could print them beside the speaker, and nothing says it should not.",
    ),
    'alignment.speaker': {
      carried: 'changed',
      how: 'A sentence that one segment matches (an exact extent, else the only segment containing it) gets that segment\'s speaker after its number: "(3) Ada". A segment covering part of a sentence, or two segments over one sentence, gives no speaker (phraseSpeakerFor in flextext.js).',
    },
    'alignment.extraMetadata': inherent('Segment metadata other than the speaker is not written.'),
    'alignment.notSentenceExtent': inherent(
      'The file is laid out by sentence. A segment has no lines of its own, only a speaker on the sentence it covers.',
    ),
    'alignment.overlappingTimes': inherent(
      'The file is laid out by sentence. A segment has no lines of its own, so an overlap between two has nowhere to show.',
    ),

    // Annotations (spans)
    'span.sentenceValue': {
      carried: true,
      where:
        'a free line after the aligned lines, "Translation: value", when the value is not empty',
    },
    'span.wordValue': {
      carried: true,
      where: "the cell under the word on that field's line",
    },
    'span.morphemeValue': {
      carried: true,
      where:
        "the cell under the word on that field's line, joined with the other morphemes' values",
    },
    'span.multiToken': {
      carried: 'changed',
      how: 'The value is printed under every token the annotation covers, once per token, as if each had its own.',
    },
    'span.duplicate': ruled(
      'The derived view shows the first annotation in a field on a token, so a second one on the same token is not printed.',
      'plaid_data_integrity_validators.md and igtReconcile.js planLayerSpanDedup: two annotations in one field on one token are a state the editor heals on open, joining the values with " | " into the first.',
    ),
    'span.onForeignLayer': foreign("An annotation in another app's span layer."),
    'span.onAlignment': inherent(
      'The file is laid out by sentence, and an annotation on a segment has no sentence line to sit on.',
    ),
    'span.provHuman': PROVENANCE,
    'span.provMachine': PROVENANCE,
    'span.provContributed': PROVENANCE,
    'span.provVerified': PROVENANCE,
    'span.provSource': PROVENANCE,
    'span.provProb': PROVENANCE,
    'span.provDetail': PROVENANCE,
    'span.extraMetadata': inherent("Only an annotation's value is written."),
    'span.offTagset': {
      carried: true,
      where: 'written as is, like any other value',
    },
    'span.delimitedValue': {
      carried: true,
      where: 'written as is, delimiters included',
    },
    'span.markupChars': {
      carried: true,
      where:
        'written as is, with no escaping. A tab inside a cell is printed raw and counts as one column of width.',
    },
    'span.multilineValue': {
      carried: true,
      where:
        'written as is. A newline in a sentence field continues its free line on an unlabeled line, and one in a word or morpheme cell breaks the columns of that line.',
    },
    'span.emptyValue': inherent(
      'An empty value prints as an empty cell, and an empty sentence field is left out, the same as no annotation.',
    ),
    'span.overlapSameField': inherent(
      'A cell holds one value per token per field. On the tokens two annotations share, the first one is printed and the other is not.',
    ),
    'span.reachesOrphanToken': ORPHANS,
    'span.valueWhitespace': inherent(
      'Space at the edge of a cell cannot be told from the padding that aligns the columns, and line ends are trimmed.',
    ),

    // Vocabulary links
    'link.word': ENTRY_TIER,
    'link.morpheme': ENTRY_TIER,
    'link.mwe': ENTRY_TIER,
    'link.mweDiscontinuous': ENTRY_TIER,
    'link.mweAcrossSentences': ENTRY_TIER,
    'link.onSentence': ENTRY_TIER,
    'link.duplicateOnToken': ENTRY_TIER,
    'link.toSense': ENTRY_TIER,
    'link.secondVocabulary': ENTRY_TIER,
    'link.provHuman': PROVENANCE,
    'link.provMachine': PROVENANCE,
    'link.provContributed': PROVENANCE,
    'link.provVerified': PROVENANCE,
    'link.provSource': PROVENANCE,
    'link.provProb': PROVENANCE,
    'link.provDetail': PROVENANCE,
    'link.onSegment': inherent(
      'A segment has no lines of its own in a file laid out by sentence, so nothing could name the entry linked to it.',
    ),
    'link.onOrphanToken': ORPHANS,
    // SUSPECTED BUG: runExport.js loads the vocabularies for plain text only when it writes the
    // TSVs into a zip. A single document, or a zip without them, gets the document GET's bare
    // embedded items, so the joints fall back to the morpheme's own morph type.
    'link.entryMorphType': {
      carried: 'changed',
      how: "The entry's morph type shows only through the joint beside the morpheme: = when it is a clitic, - otherwise, whatever the morpheme's own type says.",
    },

    // Relations (plaid-ud)
    'relation.value': foreign('Relations belong to plaid-ud.'),

    // Comments
    'comment.document': COMMENTS,
    'comment.text': COMMENTS,
    'comment.sentence': COMMENTS,
    'comment.word': COMMENTS,
    'comment.morpheme': COMMENTS,
    'comment.segment': COMMENTS,
    'comment.annotation': COMMENTS,
    'comment.entry': COMMENTS,
    'comment.relation': foreign('A comment on a plaid-ud relation.'),
    'comment.orphaned': COMMENTS,
    'comment.edited': COMMENTS,
    'comment.anchorLabel': COMMENTS,
    'comment.secondAuthor': COMMENTS,
    'comment.markdown': COMMENTS,

    // Guidelines
    'guideline.present': GUIDELINES,
    'guideline.pinned': GUIDELINES,
    'guideline.emptyBody': GUIDELINES,
    'guideline.duplicateTitle': GUIDELINES,
  },
};

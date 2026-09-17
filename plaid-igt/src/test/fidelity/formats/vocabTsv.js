// The vocabulary TSV (src/export/vocabTsv.js), checked as a round trip through Bulk Add. Two
// writers produce it: a project zip (runExport.js, raw field names as the header, no Uses
// column) and the Entries screen (VocabularyItems.jsx, field labels as the header and a Uses
// column). Bulk Add is meant to read either back: vocabBulk.js ignores the Uses column "so our
// own export round-trips", and its test says the same. The check exports a vocabulary, bulk adds
// the file into an empty vocabulary that already declares the same fields, answering Add for
// every row that disagrees with an entry an earlier row made or could belong to several, and
// compares the entries. The target has to declare the fields because Bulk Add maps columns onto
// existing fields and never creates one. "Carried" means an entry and its value come back
// identical. Only a vocabulary's entries are in the file, so everything else is outside it.

const inherent = (why) => ({ carried: false, kind: 'inherent', why });
const foreign = (why) => ({ carried: false, kind: 'foreign', why });
const ruled = (why, ruling) => ({ carried: false, kind: 'ruled', why, ruling });
const undecided = (why) => ({ carried: false, kind: 'undecided', why });

const carried = { carried: true };

const NOT_A_VOCABULARY = inherent(
  "A vocabulary TSV holds one vocabulary's entries, a row each. Project, layer and document data have no place in it.",
);
const FIELD_CONFIG = inherent(
  'A column header names a field and nothing else about it. Bulk Add sets no field configuration.',
);
const NOT_A_FIELD = inherent(
  "The columns are the form, the number and the vocabulary's declared fields. A key no field declares has no column, and Bulk Add writes declared fields only.",
);
const NUMBER_COLUMN = undecided(
  "The Number column writes each entry's dotted number (\"a 1.2\"), which names its headword and its place, but Bulk Add ignores that column and creates every row as a headword of its own. A sense whose values differ from its headword's comes back as a second headword spelled the same, and one under a headword with no values of its own fills that headword's blanks instead.",
);

export default {
  id: 'vocabTsv',
  name: 'Vocabulary TSV',
  check: 'roundTrip',
  // Bulk Add writes the row's values and nothing else.
  stamps: { projectConfig: [], documentMetadata: [], tokenMetadata: [], itemMetadata: [] },
  features: {
    // Project configuration
    'project.documentMetadataFields': NOT_A_VOCABULARY,
    'project.documentMetadataTagset': NOT_A_VOCABULARY,
    'project.tagset': NOT_A_VOCABULARY,
    'project.tagsetModeSuggest': NOT_A_VOCABULARY,
    'project.tagsetModeClosed': NOT_A_VOCABULARY,
    'project.tagsetModeMixed': NOT_A_VOCABULARY,
    'project.tagsetDelimiters': NOT_A_VOCABULARY,
    'project.tagsetValueDescription': NOT_A_VOCABULARY,
    'project.tagsetOrdered': NOT_A_VOCABULARY,
    'project.languageObject': NOT_A_VOCABULARY,
    'project.languageMeta': NOT_A_VOCABULARY,
    'project.languageCoordinates': NOT_A_VOCABULARY,
    'project.speakers': NOT_A_VOCABULARY,
    'project.serviceDefaults': NOT_A_VOCABULARY,
    'project.autoAnalysis': NOT_A_VOCABULARY,
    'project.compose': NOT_A_VOCABULARY,
    'project.exportPresets': NOT_A_VOCABULARY,
    'project.reviewedMembers': NOT_A_VOCABULARY,
    'project.foreignConfig': foreign("Another app's project configuration."),

    // Layers
    'layers.orthography': NOT_A_VOCABULARY,
    'layers.ignoredTokensPunctuation': NOT_A_VOCABULARY,
    'layers.ignoredTokensLetterLike': NOT_A_VOCABULARY,
    'layers.ignoredTokensBlacklist': NOT_A_VOCABULARY,
    'layers.fieldSentence': NOT_A_VOCABULARY,
    'layers.fieldWord': NOT_A_VOCABULARY,
    'layers.fieldMorpheme': NOT_A_VOCABULARY,
    'layers.fieldSameNameTwoScopes': NOT_A_VOCABULARY,
    'layers.fieldOrder': NOT_A_VOCABULARY,
    'layers.fieldLang': NOT_A_VOCABULARY,
    'layers.fieldTagset': NOT_A_VOCABULARY,
    'layers.foreignTokenLayer': foreign('A token layer another app uses.'),
    'layers.unscopedSpanLayer': foreign('A span layer another app made.'),
    'layers.relationLayer': foreign('Relations belong to plaid-ud.'),
    'layers.fieldEmpty': NOT_A_VOCABULARY,

    // Vocabularies: their schema
    'vocab.linked': inherent(
      'The vocabulary itself and its link to a project are outside the file. Bulk Add writes into a vocabulary that already exists.',
    ),
    'vocab.second': inherent(
      'A project zip writes one TSV per vocabulary, named after it, but no file names a project, and Bulk Add reads one file into one vocabulary that already exists.',
    ),
    'vocab.customField': ruled(
      'The header names the field, but Bulk Add maps columns onto the fields the vocabulary already declares and never creates one.',
      'BulkAddDialog.jsx, the column legend for a column left out: "To keep one of these, add a field to this vocabulary in its Settings first."',
    ),
    'vocab.fieldNotInline': FIELD_CONFIG,
    'vocab.fieldTagset': FIELD_CONFIG,
    'vocab.fieldLang': inherent(
      'The Entries screen writes a field\'s language into its header ("Gloss (en)") and the project zip does not. Either way a header is a label, and Bulk Add sets no field configuration.',
    ),
    'vocab.fieldMultilingual': ruled(
      'The header names the field ("gloss (fr)"), but Bulk Add maps columns onto the fields the vocabulary already declares and never creates one.',
      'BulkAddDialog.jsx, the column legend for a column left out: "To keep one of these, add a field to this vocabulary in its Settings first."',
    ),
    'vocab.fieldItemRef': FIELD_CONFIG,
    'vocab.fieldItemRefMany': FIELD_CONFIG,
    'vocab.fieldEntryScope': FIELD_CONFIG,
    'vocab.customTagset': inherent('A TSV holds entries, not the lists that govern their fields.'),
    'vocab.foreignConfig': foreign("plaid-dict's publication record on a vocabulary."),
    'vocab.duplicateName': inherent(
      'A vocabulary\'s name is only in the file name, which a project zip makes unique ("Lexicon (2).tsv"), and Bulk Add reads one file into a vocabulary that already exists.',
    ),
    // The target declares the field (see the header). What this key exercises is the column:
    // Bulk Add should map it onto its own field. SUSPECTED BUGS: a name that is another
    // field's alias ("Translation", "Type") is claimed by that core field and left out, and a
    // field named "Number" is given the export's Number column, the dotted entry number.
    'vocab.fieldAliasName': carried,

    // Vocabularies: entries
    'item.gloss': carried,
    'item.pos': carried,
    // Bulk Add matches a morph type against the FLEx inventory without regard to case or
    // spacing and stores the inventory's spelling, which is what the app writes anyway.
    'item.morphType': carried,
    'item.definition': carried,
    // The target declares the Status field and its closed tagset, whose values Bulk Add accepts.
    'item.status': carried,
    // SUSPECTED BUG: the header "lexemeForm" (zip) and "Lexeme Form" (Entries screen) both
    // normalize to "lexemeform", which vocabBulk.js lists as a spelling of the FORM column. The
    // column is guessed to be a second form and left out, so the values never import.
    'item.lexemeForm': carried,
    // SUSPECTED BUGS: the Entries screen's header for a field with a language ("Source (en)")
    // matches no field, and a custom field named like a core field's alias ("Translation",
    // "Type") is claimed by that core field and left out.
    'item.customFieldValue': carried,
    'item.multilingualValue': carried,
    'item.itemRefValue': ruled(
      'The export names each referenced entry ("a 1.2"), but Bulk Add offers no column for an Entry field.',
      'docs/igt-guide.adoc, Headwords and senses: "Bulk Add and Replace leave Entry fields alone, since those hold references and not text." BulkAddDialog.jsx filters Entry fields out of the columns it offers.',
    ),
    'item.itemRefManyValue': ruled(
      'The export names each referenced entry, several joined by a semicolon and a space, but Bulk Add offers no column for an Entry field.',
      'docs/igt-guide.adoc, Headwords and senses: "Bulk Add and Replace leave Entry fields alone, since those hold references and not text." BulkAddDialog.jsx filters Entry fields out of the columns it offers.',
    ),
    'item.sense': NUMBER_COLUMN,
    'item.subsense': NUMBER_COLUMN,
    'item.senseOrder': NUMBER_COLUMN,
    'item.homonyms': {
      carried: 'changed',
      how: 'Headwords spelled alike come back as separate entries, in the order of the rows, when their values differ in some field and the row that disagrees is answered Add. Two whose values are all equal come back as one, because Bulk Add decides sameness by the values (plaid_igt_vocab_bulk_import.md) and does not read the Number column that tells them apart.',
    },
    'item.homographNumber': undecided(
      'The stored number is not written. The Number column shows the order of entries spelled alike, but Bulk Add ignores it. The Entries screen writes rows in that order and the project zip in creation order, and Bulk Add creates in row order, so only the first keeps a reordered homograph order, and neither keeps the stored key.',
    ),
    'item.exampleCorpus': inherent(
      'A promoted example is a reference to a token in a document. It is not a field, and a spreadsheet cell cannot hold a reference Bulk Add could resolve.',
    ),
    'item.exampleText': NOT_A_FIELD,
    'item.flexIdentity': NOT_A_FIELD,
    'item.provenance': NOT_A_FIELD,
    'item.zeroMorph': carried,
    'item.unlinked': carried,
    'item.extraMetadata': NOT_A_FIELD,
    // SUSPECTED BUG for the leading quote: the export writes it bare and Bulk Add reads a cell
    // that starts with " as a quoted cell, so the quotes are lost, and an unbalanced one swallows
    // the cells and rows after it.
    'item.markupChars': {
      carried: 'changed',
      how: 'A tab or line break, or a run of them, becomes one space (vocabTsv.js tsvCell: cells cannot contain them). A leading double quote comes back as it was.',
    },
    'item.surroundingWhitespace': {
      carried: 'changed',
      how: 'Leading and trailing whitespace is trimmed from the form and from every value (vocabBulk.js rowsToEntries, and createFrom: "Stored as typed (trimmed only)").',
    },
    'item.offTagset': ruled(
      'The export writes the value, and Bulk Add rejects a value the closed tagset governing its field refuses, counting the row instead of storing it.',
      'docs/igt-guide.adoc, Entry fields: "A closed tagset becomes a dropdown on the entry form and refuses a value outside the list in Bulk Add."',
    ),
    'item.formNormalization': {
      carried: 'changed',
      how: 'Bulk Add compares forms after NFC normalization, so the second entry is matched to the first. It comes back with its own spelling, as typed, when some value differs and the row is answered Add, and not at all when every value is equal (plaid_igt_vocab_bulk_import.md: forms compare NFC-normalized and are stored as typed).',
    },
    'item.containerHeadword': undecided(
      "The headword's row has no values, so the first sense's row agrees with it and fills its blanks, and Bulk Add offers no Add answer for a row that only fills blanks. The headword comes back holding that sense's values, and each later sense comes back as a headword of its own. The Number column that says the rows are a headword and its senses is ignored.",
    ),
    'item.exampleStale': inherent(
      'A promoted example, stale or not, is a reference to a token in a document and has no column.',
    ),

    // Documents
    'document.metadataConfigured': NOT_A_VOCABULARY,
    'document.metadataUnconfigured': NOT_A_VOCABULARY,
    'document.textDirection': NOT_A_VOCABULARY,
    'document.speechDetection': NOT_A_VOCABULARY,
    'document.media': NOT_A_VOCABULARY,
    'document.noText': NOT_A_VOCABULARY,
    'document.untokenized': NOT_A_VOCABULARY,
    'document.duplicateName': NOT_A_VOCABULARY,
    'document.nameSpecialChars': NOT_A_VOCABULARY,
    'document.metadataLang': NOT_A_VOCABULARY,
    'document.partlyAligned': NOT_A_VOCABULARY,
    'document.differentFilledFields': NOT_A_VOCABULARY,

    // What the text is made of
    'text.astral': NOT_A_VOCABULARY,
    'text.combining': NOT_A_VOCABULARY,
    'text.rtlScript': NOT_A_VOCABULARY,
    'text.multiline': NOT_A_VOCABULARY,
    'text.blankLine': NOT_A_VOCABULARY,
    'text.markupChars': NOT_A_VOCABULARY,
    'text.zeroMorph': NOT_A_VOCABULARY,

    // Tokens
    'token.sentence': NOT_A_VOCABULARY,
    'token.word': NOT_A_VOCABULARY,
    'token.ignoredWord': NOT_A_VOCABULARY,
    'token.untokenizedText': NOT_A_VOCABULARY,
    'token.orthographyValue': NOT_A_VOCABULARY,
    'token.orthographyUnconfigured': NOT_A_VOCABULARY,
    'token.wordExtraMetadata': NOT_A_VOCABULARY,
    'token.segmentedWord': NOT_A_VOCABULARY,
    'token.singleStoredMorpheme': NOT_A_VOCABULARY,
    'token.unanalyzedWord': NOT_A_VOCABULARY,
    'token.morphemeForm': NOT_A_VOCABULARY,
    'token.morphemeFormEmpty': NOT_A_VOCABULARY,
    'token.morphemeFormAbsent': NOT_A_VOCABULARY,
    'token.morphemeZero': NOT_A_VOCABULARY,
    'token.morphTypeOnMorpheme': NOT_A_VOCABULARY,
    'token.orphanMorpheme': NOT_A_VOCABULARY,
    'token.provenance': NOT_A_VOCABULARY,
    'token.wordsInOneRun': NOT_A_VOCABULARY,
    'token.wordEdgePunctuation': NOT_A_VOCABULARY,
    'token.sentenceExtraMetadata': NOT_A_VOCABULARY,
    'token.morphemeProvenance': NOT_A_VOCABULARY,
    'token.procliticBeforeMorpheme': NOT_A_VOCABULARY,
    'alignment.provenance': NOT_A_VOCABULARY,
    'alignment.severalInSentence': NOT_A_VOCABULARY,
    'alignment.straddlesSentences': NOT_A_VOCABULARY,
    'alignment.mixedSpeakersInSentence': NOT_A_VOCABULARY,
    'alignment.textAcrossLineBreak': NOT_A_VOCABULARY,
    'alignment.times': NOT_A_VOCABULARY,
    'alignment.speaker': NOT_A_VOCABULARY,
    'alignment.extraMetadata': NOT_A_VOCABULARY,
    'alignment.notSentenceExtent': NOT_A_VOCABULARY,
    'alignment.overlappingTimes': NOT_A_VOCABULARY,

    // Annotations (spans)
    'span.sentenceValue': NOT_A_VOCABULARY,
    'span.wordValue': NOT_A_VOCABULARY,
    'span.morphemeValue': NOT_A_VOCABULARY,
    'span.multiToken': NOT_A_VOCABULARY,
    'span.duplicate': NOT_A_VOCABULARY,
    'span.onForeignLayer': foreign("An annotation in another app's span layer."),
    'span.onAlignment': NOT_A_VOCABULARY,
    'span.provHuman': NOT_A_VOCABULARY,
    'span.provMachine': NOT_A_VOCABULARY,
    'span.provContributed': NOT_A_VOCABULARY,
    'span.provVerified': NOT_A_VOCABULARY,
    'span.provSource': NOT_A_VOCABULARY,
    'span.provProb': NOT_A_VOCABULARY,
    'span.provDetail': NOT_A_VOCABULARY,
    'span.extraMetadata': NOT_A_VOCABULARY,
    'span.offTagset': NOT_A_VOCABULARY,
    'span.delimitedValue': NOT_A_VOCABULARY,
    'span.markupChars': NOT_A_VOCABULARY,
    'span.multilineValue': NOT_A_VOCABULARY,
    'span.emptyValue': NOT_A_VOCABULARY,
    'span.overlapSameField': NOT_A_VOCABULARY,
    'span.reachesOrphanToken': NOT_A_VOCABULARY,
    'span.valueWhitespace': NOT_A_VOCABULARY,

    // Vocabulary links. The Entries screen's Uses column counts them, and Bulk Add ignores it.
    'link.word': NOT_A_VOCABULARY,
    'link.morpheme': NOT_A_VOCABULARY,
    'link.mwe': NOT_A_VOCABULARY,
    'link.mweDiscontinuous': NOT_A_VOCABULARY,
    'link.mweAcrossSentences': NOT_A_VOCABULARY,
    'link.onSentence': NOT_A_VOCABULARY,
    'link.duplicateOnToken': NOT_A_VOCABULARY,
    'link.toSense': NOT_A_VOCABULARY,
    'link.secondVocabulary': NOT_A_VOCABULARY,
    'link.provHuman': NOT_A_VOCABULARY,
    'link.provMachine': NOT_A_VOCABULARY,
    'link.provContributed': NOT_A_VOCABULARY,
    'link.provVerified': NOT_A_VOCABULARY,
    'link.provSource': NOT_A_VOCABULARY,
    'link.provProb': NOT_A_VOCABULARY,
    'link.provDetail': NOT_A_VOCABULARY,
    'link.onSegment': NOT_A_VOCABULARY,
    'link.onOrphanToken': NOT_A_VOCABULARY,
    'link.entryMorphType': NOT_A_VOCABULARY,

    // Relations (plaid-ud)
    'relation.value': foreign('Relations belong to plaid-ud.'),

    // Comments
    'comment.document': NOT_A_VOCABULARY,
    'comment.text': NOT_A_VOCABULARY,
    'comment.sentence': NOT_A_VOCABULARY,
    'comment.word': NOT_A_VOCABULARY,
    'comment.morpheme': NOT_A_VOCABULARY,
    'comment.segment': NOT_A_VOCABULARY,
    'comment.annotation': NOT_A_VOCABULARY,
    'comment.entry': ruled(
      'Comments go into no interchange format, only the native archive.',
      'plaid_comments.md, ruled out 2026-08-31 in commit 87cb70e3. runExport.js loads comments, entry comments included, for the native archive only.',
    ),
    'comment.relation': foreign('A comment on a plaid-ud relation.'),
    'comment.orphaned': NOT_A_VOCABULARY,
    'comment.edited': NOT_A_VOCABULARY,
    'comment.anchorLabel': NOT_A_VOCABULARY,
    'comment.secondAuthor': NOT_A_VOCABULARY,
    'comment.markdown': NOT_A_VOCABULARY,

    // Guidelines
    'guideline.present': NOT_A_VOCABULARY,
    'guideline.pinned': NOT_A_VOCABULARY,
    'guideline.emptyBody': NOT_A_VOCABULARY,
    'guideline.duplicateTitle': NOT_A_VOCABULARY,
  },
};

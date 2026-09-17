// CLDF, checked as a round trip: a project is exported as a CLDF TextCorpus with a preset that
// selects every field and orthography and turns every option on (speakers, dictionary, media),
// the zip is read back through the CLDF import with the options it derives on its own, and the new
// project is compared with the old one. "Carried" means the feature comes back as it was, apart
// from the import's bookkeeping under `stamps`. CLDF stores no character offsets, so the import
// rebuilds the text from each example's Primary_Text and places words by position against its
// whitespace, and it reads the fields bound to CLDF terms back under its own names (Gloss,
// Translation, Note). The 'changed' entries say exactly how.

const COMMENTS_RULED = {
  carried: false,
  kind: 'ruled',
  why: 'Comments go into no interchange format. The Comment column CLDF has is already bound to a sentence annotation field.',
  ruling: 'plaid_comments.md, 2026-08-31, commit 87cb70e3',
};

const GUIDELINES_RULED = {
  carried: false,
  kind: 'ruled',
  why: 'Guidelines ride the native archive only.',
  ruling: 'plaid_guidelines.md, 2026-09-15',
};

const LINKS_RULED = {
  carried: false,
  kind: 'ruled',
  why: 'Vocabulary links are not written, and the import makes none. The preset panel lists this loss.',
  ruling:
    'plaid_alpha_triage_closed.md (vocabulary links and provenance are not to be carried as custom columns), INHERENT_LOSSES in src/export/cldf.js',
};

const PROVENANCE_RULED = {
  carried: false,
  kind: 'ruled',
  why: 'Provenance marks are not written, so machine-made, contributed and confirmed material comes back looking hand-made. The preset panel lists this loss.',
  ruling:
    'plaid_alpha_triage_closed.md (vocabulary links and provenance are not to be carried as custom columns), INHERENT_LOSSES in src/export/cldf.js',
};

const TAGSET = {
  carried: false,
  kind: 'inherent',
  why: 'Project tagsets have no place in a CLDF dataset, and the import writes none.',
};

const PLAID_SETTING = {
  carried: false,
  kind: 'inherent',
  why: 'A Plaid application setting. CLDF has no place for it, and the import writes none.',
};

const NO_SEGMENTS = {
  carried: false,
  kind: 'inherent',
  why: 'CLDF has no time-aligned segments. The ExampleTable has no time columns, so the import makes no time-alignment tokens.',
};

const FOREIGN_LAYER = {
  carried: false,
  kind: 'foreign',
  why: 'Another app’s layer. The export reads only the IGT layers, and CLDF has no place for this one.',
};

const LANGUAGE_SHAPE =
  '{ name: "", glottocode: "", iso639P3: "", latitude: null, longitude: null }';

const carried = { carried: true };

export default {
  id: 'cldf',
  name: 'CLDF TextCorpus',
  check: 'roundTrip',
  stamps: {
    // Project setup marks the project initialized, and the import record under `import` stays
    // until the run reports finishing.
    projectConfig: ['initialized', 'import'],
    // src/import/resume.js: the CLDF contribution id, and the done marker written last.
    documentMetadata: ['importSource', 'importDone'],
    tokenMetadata: [],
    // src/import/cldf/importEngine.js: the CLDF entry id (or entry/sense id) on every item.
    itemMetadata: ['cldfEntry'],
  },
  features: {
    // Project configuration
    'project.documentMetadataFields': {
      carried: 'changed',
      how: 'Rebuilt from the documents that come back: one { name } entry for every metadata name holding a non-empty value in at least one of them, in the order the import first meets them. Within a document Description, Contributor and Citation come first, then the other ContributionTable columns in column order. A field no document fills does not come back, and no entry keeps a tagset.',
    },
    'project.documentMetadataTagset': {
      carried: false,
      kind: 'inherent',
      why: 'The ContributionTable holds values only. The import switches fields on without a tagset.',
    },
    'project.tagset': TAGSET,
    'project.tagsetModeSuggest': TAGSET,
    'project.tagsetModeClosed': TAGSET,
    'project.tagsetModeMixed': TAGSET,
    'project.tagsetDelimiters': TAGSET,
    'project.tagsetValueDescription': TAGSET,
    'project.tagsetOrdered': TAGSET,
    'project.languageObject': {
      carried: 'changed',
      how: `Written to the LanguageTable and read back from the row the examples name. Name, Glottocode and ISO 639-3 code come back. The writing-system tag is not written, and the import writes the language with no tag key. A language with no name goes out as "Unidentified object language" and comes back with name "". A project that named no object language comes back with languages.object set to ${LANGUAGE_SHAPE}.`,
    },
    'project.languageMeta': {
      carried: 'changed',
      how: `Written as its own LanguageTable row, or as the object language's row when the two are the same language, and read back from the examples' Meta_Language_ID. Name, Glottocode and ISO 639-3 code come back, the writing-system tag does not, and a meta language with only a tag is not written. Whenever the import sets languages at all, a meta language the project did not name comes back as ${LANGUAGE_SHAPE}.`,
    },
    'project.languageCoordinates': carried,
    'project.speakers': {
      carried: false,
      kind: 'inherent',
      why: 'The list of known speaker labels has no place in CLDF, and the import writes none.',
    },
    'project.serviceDefaults': PLAID_SETTING,
    'project.autoAnalysis': PLAID_SETTING,
    'project.compose': PLAID_SETTING,
    'project.exportPresets': PLAID_SETTING,
    'project.reviewedMembers': {
      carried: false,
      kind: 'inherent',
      why: 'It names users of this server. CLDF has no place for it.',
    },
    'project.foreignConfig': {
      carried: false,
      kind: 'foreign',
      why: 'Another app’s project config. CLDF has no place for it.',
    },

    // Layers
    'layers.orthography': {
      carried: 'changed',
      how: 'Comes back as a { name } entry, in the same order, for each orthography at least one exported word has a value in. An orthography no word fills is not written and does not come back.',
    },
    'layers.ignoredTokensPunctuation': {
      carried: 'changed',
      how: "The import writes the default rule the setup wizard and the FLEx import write, {type: 'unicodePunctuation', whitelist: []}, whatever rule the exported project had. Letter-like characters and a blacklist are lost (see the next two keys).",
      ruling:
        'user, 2026-09-17: the CLDF and ELAN imports give a new project the same default ignored-tokens rule as the setup wizard',
    },
    'layers.ignoredTokensLetterLike': {
      carried: false,
      kind: 'inherent',
      why: 'Ignored-token settings have no place in CLDF. The import writes the default rule, which has no letter-like characters.',
    },
    'layers.ignoredTokensBlacklist': {
      carried: false,
      kind: 'inherent',
      why: 'Ignored-token settings have no place in CLDF. The import writes the default punctuation rule in place of a blacklist.',
    },
    'layers.fieldSentence': {
      carried: 'changed',
      how: 'A sentence field comes back only when at least one sentence has a non-empty value in it. The field bound to Translated_Text comes back named Translation and the one bound to Comment named Note, whatever they were called. Every other sentence field comes back under its own name, except that one wanting a name a bound field already took keeps its column name instead (Sentence_Translation). Its config comes back as { scope }, plus lang as layers.fieldLang says.',
    },
    'layers.fieldWord': {
      carried: 'changed',
      how: 'A word field comes back only when at least one word has a non-empty value in it, under its own name, with config { scope }, plus lang as layers.fieldLang says.',
    },
    'layers.fieldMorpheme': {
      carried: 'changed',
      how: 'A morpheme field comes back only when at least one morpheme has a non-empty value in it. The field bound to Gloss comes back named Gloss whatever it was called, and every other one under its own name. Its config comes back as { scope }, plus lang as layers.fieldLang says.',
    },
    'layers.fieldSameNameTwoScopes': {
      carried: 'changed',
      how: 'Comes back when both fields come back, by the rules under layers.fieldWord and layers.fieldMorpheme.',
    },
    // Ruled by the user, 2026-09-17: imports keep field order. The export writes the columns of
    // unbound fields in project order, but the import creates fields in the order it first meets a
    // value, with the bound Translation, Note and Gloss ahead of the rest, so this is a bug today.
    'layers.fieldOrder': carried,
    'layers.fieldLang': {
      carried: false,
      kind: 'undecided',
      why: 'No column records the writing system of its field. The import sets lang to the meta language’s ISO 639-3 code on every field named Gloss, Translation or Note, and on no other field.',
    },
    'layers.fieldTagset': {
      carried: false,
      kind: 'inherent',
      why: 'A field’s tagset has no place in CLDF, and the import creates fields without one.',
    },
    'layers.foreignTokenLayer': FOREIGN_LAYER,
    'layers.unscopedSpanLayer': FOREIGN_LAYER,
    'layers.relationLayer': {
      carried: false,
      kind: 'foreign',
      why: 'plaid-ud’s dependencies. Relations have no CLDF equivalent at any level of the ontology.',
    },
    'layers.fieldEmpty': {
      carried: false,
      kind: 'ruled',
      why: 'The export leaves out a column that is empty in every row, and the import creates a field only for a value it meets, so a field with no values does not come back.',
      ruling:
        'buildTable in src/export/cldf.js, commit 8cd17ba2 (2026-08-31): an enabled but unused tier should not leave a dead column behind',
    },

    // Vocabularies: their schema
    'vocab.linked': {
      carried: 'changed',
      how: 'A vocabulary comes back, linked and under the same name, only when it has at least one headword. Its config starts from what project setup gives a new vocabulary: the core fields, the Status field and the Status tagset.',
    },
    'vocab.second': {
      carried: 'changed',
      how: 'Each vocabulary with at least one headword comes back under its own name, read from the Vocabulary column, as vocab.linked says.',
    },
    'vocab.customField': {
      carried: 'changed',
      how: 'Comes back declared as { inline: false } only when at least one exported headword or sense holds a value in it. A reference field comes back as a text field, as vocab.fieldItemRef says.',
    },
    'vocab.fieldNotInline': {
      carried: false,
      kind: 'inherent',
      why: 'Display settings have no place in CLDF. The import declares each field it adds as inline only when it is named gloss or pos, and the fields project setup seeds keep their defaults.',
    },
    'vocab.fieldTagset': {
      carried: false,
      kind: 'inherent',
      why: 'A field’s tagset has no place in CLDF. Only the Status field project setup seeds comes back with one.',
    },
    'vocab.fieldLang': {
      carried: false,
      kind: 'undecided',
      why: 'No lexicon column records its writing system, and the import declares fields without lang.',
    },
    'vocab.fieldMultilingual': {
      carried: 'changed',
      how: 'Comes back under the same name, such as "gloss (ru)", by the rule under vocab.customField.',
    },
    'vocab.fieldItemRef': {
      carried: false,
      kind: 'undecided',
      why: 'The export writes the entry a reference points at as its label, and the import stores that label in a plain text field of the same name, so the field comes back without type item.',
    },
    'vocab.fieldItemRefMany': {
      carried: false,
      kind: 'undecided',
      why: 'The export writes the entries a reference list points at as their labels in one cell, and the import stores that cell in a plain text field of the same name, so the field comes back without type item or many.',
    },
    'vocab.fieldEntryScope': {
      carried: false,
      kind: 'undecided',
      why: 'The export writes every field on the entry row for a headword and on the sense row for a sense, whatever its scope, and the import declares fields without one. Which of the EntryTable and the SenseTable a field is written to could say it.',
    },
    'vocab.customTagset': {
      carried: false,
      kind: 'inherent',
      why: 'Vocabulary tagsets have no place in CLDF. The import writes none, and only the Status tagset project setup seeds comes back.',
    },
    'vocab.foreignConfig': {
      carried: false,
      kind: 'foreign',
      why: 'Another app’s vocabulary config. CLDF has no place for it.',
    },
    'vocab.duplicateName': {
      carried: false,
      kind: 'ruled',
      why: 'The export refuses a project with two vocabularies of one name, since the Vocabulary column names a vocabulary by its name alone and the import could not tell them apart.',
      ruling:
        'user, 2026-09-17: two vocabularies with one name are a user error, and the import is blocked',
    },
    'vocab.fieldAliasName': {
      carried: 'changed',
      how: 'Comes back under the same name by the rule under vocab.customField. The CLDF import reads lexicon columns by their Entry_ and Sense_ prefixes, not by the bulk import’s header aliases.',
    },

    // Vocabularies: entries
    'item.gloss': carried,
    'item.pos': carried,
    'item.morphType': carried,
    'item.definition': carried,
    'item.status': carried,
    'item.lexemeForm': carried,
    'item.customFieldValue': carried,
    'item.multilingualValue': carried,
    'item.itemRefValue': {
      carried: 'changed',
      how: 'Comes back as text in a field of the same name: the label of the entry it pointed at, which is its form followed by a space and its dotted number when it has one ("casa 1", "banco 1.2"), or its bare form when it has none.',
    },
    'item.itemRefManyValue': {
      carried: 'changed',
      how: 'Comes back as one text value in a field of the same name: the labels of the entries it pointed at, each as item.itemRefValue describes, joined by a semicolon and a space.',
    },
    'item.sense': {
      carried: 'changed',
      how: 'CLDF has one level of senses. Every sense and subsense of a headword is written as a sense row of that headword, depth first in sense order, and a headword with a gloss or definition of its own writes that as its first sense row. A sense with neither a gloss nor a definition is not written and does not come back. On import a headword with two or more sense rows gets one new sense item per row, in row order, each taking the headword’s form and the row’s gloss, definition, part of speech and fields, while the headword keeps its part of speech and entry fields and gives up its own gloss and definition to its first sense. A headword with exactly one sense row comes back as a single item with no senses, holding that row’s values beneath its own.',
    },
    'item.subsense': {
      carried: 'changed',
      how: 'Comes back as a sense of its headword, flattened as item.sense describes.',
    },
    'item.senseOrder': {
      carried: 'changed',
      how: 'Rewritten. Every sense item made for a headword with two or more sense rows gets senseOrder 1, 2, 3 and on in row order, and no other item gets one.',
    },
    'item.homonyms': carried,
    'item.homographNumber': carried,
    'item.exampleCorpus': {
      carried: false,
      kind: 'inherent',
      why: 'A sense row names the example rows its promoted examples became (Example_IDs), but an example row is a whole sentence and a promoted example points at one token, so the import has nothing to point it at and reads nothing back.',
    },
    'item.exampleText': {
      carried: false,
      kind: 'undecided',
      why: 'An example stored as text and translation is not written. The export writes only examples that point into a document.',
    },
    'item.flexIdentity': {
      carried: false,
      kind: 'undecided',
      why: 'FLEx entry and sense guids are not written. A custom entry or sense column could hold them.',
    },
    'item.provenance': PROVENANCE_RULED,
    'item.zeroMorph': carried,
    'item.unlinked': carried,
    'item.extraMetadata': {
      carried: false,
      kind: 'ruled',
      why: 'The export writes only the fields the vocabulary declares, so entry metadata no field declares is not written.',
      ruling: 'user, 2026-09-17: metadata no field declares is exported by the native archive only',
    },
    'item.markupChars': carried,
    'item.surroundingWhitespace': carried,
    'item.offTagset': carried,
    'item.formNormalization': carried,
    'item.containerHeadword': {
      carried: 'changed',
      how: 'Comes back as a headword with no gloss or definition of its own over one sense item per written sense row when two or more of its senses are written. When only one is, it comes back merged with that sense as a single item, as item.sense describes.',
    },
    'item.exampleStale': {
      carried: false,
      kind: 'inherent',
      why: 'A promoted example whose token is gone names no example row, so the export leaves it out, and the import reads no promoted examples back (item.exampleCorpus).',
    },

    // Documents
    'document.metadataConfigured': {
      carried: 'changed',
      how: 'Comes back under the same name, as a string. An empty-string value is not written, so its key is absent after import.',
    },
    'document.metadataUnconfigured': {
      carried: false,
      kind: 'ruled',
      why: 'The export reads document metadata from the derived document, which holds switched-on fields only, so a value under a name no field is switched on for is not written.',
      ruling: 'user, 2026-09-17: metadata no field declares is exported by the native archive only',
    },
    'document.textDirection': {
      carried: false,
      kind: 'undecided',
      why: 'The reserved plaid namespace is removed before document metadata is written (userMetadata), so a set direction is not written. A ContributionTable column could hold it.',
    },
    'document.speechDetection': {
      carried: false,
      kind: 'ruled',
      why: 'Detected speech cuts are proposals, not data, and reach no export.',
      ruling: 'plaid_igt_speech_detection.md, 2026-09-08',
    },
    'document.media': carried,
    'document.noText': {
      carried: false,
      kind: 'undecided',
      why: 'The export writes the document’s ContributionTable row and its MediaTable row, but the import builds documents from example rows only, so a document with no sentences does not come back, and its metadata and recording go with it.',
    },
    'document.untokenized': carried,
    'document.duplicateName': carried,
    'document.nameSpecialChars': carried,
    'document.metadataLang': carried,
    'document.partlyAligned': NO_SEGMENTS,
    'document.differentFilledFields': carried,

    // What the text is made of
    'text.astral': carried,
    'text.combining': carried,
    'text.rtlScript': carried,
    'text.multiline': {
      carried: 'changed',
      how: 'The baseline is rebuilt from the sentences: each sentence’s text with leading and trailing whitespace trimmed, joined by one newline. Whatever whitespace ran between two sentences, a blank line included, becomes that one newline. A line break inside a sentence is kept, and a sentence that was only whitespace does not come back.',
    },
    'text.blankLine': {
      carried: false,
      kind: 'inherent',
      why: 'Primary_Text holds one sentence, and the whitespace between two sentences belongs to neither. A blank line between sentences comes back as a single newline, as text.multiline describes.',
    },
    'text.markupChars': carried,
    'text.zeroMorph': carried,

    // Tokens
    'token.sentence': {
      carried: 'changed',
      how: 'Each sentence comes back over its trimmed text plus the one newline after it, and the last one runs to the end of the text, so offsets shift wherever the baseline changes as text.multiline describes.',
    },
    'token.word': {
      carried: 'changed',
      how: 'Each word comes back, in order, over the whitespace-delimited run of its sentence it corresponds to, less the punctuation at the edges of that run that the word itself did not cover. A word that was such a run keeps its characters, with offsets shifted as token.sentence describes. A word alone in its run that covered only part of it comes back widened to the whole run less that edge punctuation. Several words in one run each come back over their own characters (token.wordsInOneRun).',
    },
    'token.ignoredWord': {
      carried: 'changed',
      how: 'A word the imported project skips comes back unanalyzed, with no morpheme, as it was. That project has the default rule (layers.ignoredTokensPunctuation), so this holds for a word made only of punctuation. A word only the exported project skipped, by a blacklist or a letter-like character, comes back analyzed as token.unanalyzedWord describes. It is placed like any other word, as token.word describes.',
      ruling:
        'user, 2026-09-17: a word made only of punctuation comes back from CLDF unanalyzed, as it was, rather than as one morpheme or split at its hyphens',
    },
    'token.untokenizedText': {
      carried: 'changed',
      how: 'Punctuation at the edge of a whitespace run, and a whole run no word covers, stay outside every word. Untokenized text inside a run that a word also covers joins that word, as token.word describes.',
    },
    'token.orthographyValue': carried,
    'token.orthographyUnconfigured': {
      carried: false,
      kind: 'ruled',
      why: 'The export writes only the orthographies the word layer configures.',
      ruling: 'user, 2026-09-17: metadata no field declares is exported by the native archive only',
    },
    'token.wordExtraMetadata': {
      carried: false,
      kind: 'ruled',
      why: 'Word metadata other than orthography values is not written.',
      ruling: 'user, 2026-09-17: metadata no field declares is exported by the native archive only',
    },
    'token.segmentedWord': carried,
    'token.singleStoredMorpheme': carried,
    'token.unanalyzedWord': {
      carried: false,
      kind: 'inherent',
      why: 'Analyzed_Word cannot tell an unanalyzed word from one analyzed as a single morpheme, so it comes back with one stored morpheme whose form is the word’s text. A word whose text holds - or = comes back split into morphemes at them. A word the imported project skips as punctuation comes back unanalyzed instead (token.ignoredWord). The preset panel lists this loss (INHERENT_LOSSES).',
    },
    'token.morphemeForm': carried,
    'token.morphemeFormEmpty': {
      carried: 'changed',
      how: 'In a word where another morpheme has a non-empty form, an empty form comes back as "". In a word where every morpheme’s form is empty, the word comes back with one morpheme whose form is the word’s text.',
    },
    'token.morphemeFormAbsent': {
      carried: 'changed',
      how: 'Comes back with metadata.form set to the text of its word.',
    },
    'token.morphemeZero': carried,
    'token.morphTypeOnMorpheme': {
      carried: 'changed',
      how: 'Only the joint survives. A morpheme comes back with morphType "enclitic" when it or the morpheme before it in its word had a clitic type (clitic, enclitic or proclitic, read from the linked entry when there is one, else from the token), and with no morphType otherwise. The first morpheme of a word never has one. The preset panel lists this loss (INHERENT_LOSSES).',
    },
    'token.orphanMorpheme': {
      carried: false,
      kind: 'inherent',
      why: 'CLDF writes morphemes only as pieces of an analyzed word, so a morpheme whose extent matches no word is not written.',
    },
    'token.provenance': PROVENANCE_RULED,
    'token.wordsInOneRun': carried,
    'token.wordEdgePunctuation': carried,
    'token.sentenceExtraMetadata': {
      carried: false,
      kind: 'ruled',
      why: 'Sentence metadata other than provenance is not written.',
      ruling: 'user, 2026-09-17: metadata no field declares is exported by the native archive only',
    },
    'token.morphemeProvenance': PROVENANCE_RULED,
    'token.procliticBeforeMorpheme': {
      carried: 'changed',
      how: 'The proclitic comes back with no morphType and the morpheme after it with morphType "enclitic", by the rule under token.morphTypeOnMorpheme.',
    },
    'alignment.provenance': NO_SEGMENTS,
    'alignment.severalInSentence': NO_SEGMENTS,
    'alignment.straddlesSentences': NO_SEGMENTS,
    'alignment.mixedSpeakersInSentence': NO_SEGMENTS,
    'alignment.textAcrossLineBreak': NO_SEGMENTS,
    'alignment.times': NO_SEGMENTS,
    'alignment.speaker': {
      carried: false,
      kind: 'inherent',
      why: 'The export writes the speaker of the segment covering each sentence to a Speaker column for readers, but the import skips that column (SKIP_COLUMNS in src/import/cldf/buildDocuments.js), since CLDF carries no times to rebuild a segment from.',
    },
    'alignment.extraMetadata': NO_SEGMENTS,
    'alignment.notSentenceExtent': NO_SEGMENTS,
    'alignment.overlappingTimes': NO_SEGMENTS,

    // Annotations (spans)
    'span.sentenceValue': {
      carried: 'changed',
      how: 'Comes back on the same sentence. A value in a field carried as a custom column, which is every sentence field but the ones bound to Translated_Text and Comment, comes back trimmed of leading and trailing whitespace.',
    },
    'span.wordValue': carried,
    'span.morphemeValue': carried,
    'span.multiToken': {
      carried: 'changed',
      how: 'Comes back as one single-token annotation in the same field on each token it covered, all with the same value.',
    },
    'span.duplicate': {
      carried: false,
      kind: 'inherent',
      why: 'A cell holds one value per token per field. The export writes the first annotation on a token, in server order, and not the others.',
    },
    'span.onForeignLayer': {
      carried: false,
      kind: 'foreign',
      why: 'An annotation in another app’s layer. The export reads only IGT-scoped fields.',
    },
    'span.onAlignment': {
      carried: false,
      kind: 'inherent',
      why: 'CLDF has no time-aligned segments, so an annotation on one is not written.',
    },
    'span.provHuman': carried,
    'span.provMachine': PROVENANCE_RULED,
    'span.provContributed': PROVENANCE_RULED,
    'span.provVerified': PROVENANCE_RULED,
    'span.provSource': PROVENANCE_RULED,
    'span.provProb': PROVENANCE_RULED,
    'span.provDetail': PROVENANCE_RULED,
    'span.extraMetadata': {
      carried: false,
      kind: 'ruled',
      why: 'Annotation metadata other than provenance is not written. A cell holds the value alone.',
      ruling: 'user, 2026-09-17: metadata no field declares is exported by the native archive only',
    },
    'span.offTagset': carried,
    'span.delimitedValue': carried,
    'span.markupChars': {
      carried: 'changed',
      how: 'A tab in a word or morpheme value comes back as a single space, since tabs separate the items of an aligned cell. The other characters, and a tab inside a sentence value, come back unchanged.',
    },
    'span.multilineValue': {
      carried: 'changed',
      how: 'In a word or morpheme value every run of line breaks and tabs comes back as a single space. A sentence value keeps its line breaks.',
    },
    'span.emptyValue': {
      carried: false,
      kind: 'inherent',
      why: 'An empty cell, and an empty item of an aligned cell, read as no value, so an annotation whose value is the empty string does not come back.',
    },
    'span.overlapSameField': {
      carried: false,
      kind: 'inherent',
      why: 'A cell holds one value per token per field. Each token either annotation covered comes back with one single-token annotation, holding the value of the first annotation on it in the order the server lists them.',
    },
    'span.reachesOrphanToken': {
      carried: false,
      kind: 'inherent',
      why: 'The morpheme that matches no word is not written (token.orphanMorpheme), so only the tokens that match a word come back, each with a single-token annotation as span.multiToken describes.',
    },
    'span.valueWhitespace': {
      carried: 'changed',
      how: 'Leading and trailing spaces come back as they were, except that a value in a sentence field carried as a custom column comes back trimmed (span.sentenceValue), and a tab or line break at the edge of a word or morpheme value comes back as a space (span.markupChars).',
    },

    // Vocabulary links
    'link.word': LINKS_RULED,
    'link.morpheme': LINKS_RULED,
    'link.mwe': LINKS_RULED,
    'link.mweDiscontinuous': LINKS_RULED,
    'link.mweAcrossSentences': LINKS_RULED,
    'link.onSentence': LINKS_RULED,
    'link.duplicateOnToken': LINKS_RULED,
    'link.toSense': LINKS_RULED,
    'link.secondVocabulary': LINKS_RULED,
    'link.provHuman': LINKS_RULED,
    'link.provMachine': LINKS_RULED,
    'link.provContributed': LINKS_RULED,
    'link.provVerified': LINKS_RULED,
    'link.provSource': LINKS_RULED,
    'link.provProb': LINKS_RULED,
    'link.provDetail': LINKS_RULED,
    'link.onSegment': LINKS_RULED,
    'link.onOrphanToken': LINKS_RULED,
    'link.entryMorphType': {
      ...LINKS_RULED,
      why: 'Vocabulary links are not written, and the import makes none. The entry’s type reaches the file only as the joint in Analyzed_Word, as token.morphTypeOnMorpheme describes.',
    },

    // Relations (plaid-ud)
    'relation.value': {
      carried: false,
      kind: 'foreign',
      why: 'plaid-ud’s dependencies. Relations have no CLDF equivalent at any level of the ontology.',
    },

    // Comments
    'comment.document': COMMENTS_RULED,
    'comment.text': COMMENTS_RULED,
    'comment.sentence': COMMENTS_RULED,
    'comment.word': COMMENTS_RULED,
    'comment.morpheme': COMMENTS_RULED,
    'comment.segment': COMMENTS_RULED,
    'comment.annotation': COMMENTS_RULED,
    'comment.entry': COMMENTS_RULED,
    'comment.relation': {
      carried: false,
      kind: 'foreign',
      why: 'A comment on another app’s relation. Comments go into no interchange format, and relations have no CLDF equivalent.',
    },
    'comment.orphaned': COMMENTS_RULED,
    'comment.edited': COMMENTS_RULED,
    'comment.anchorLabel': COMMENTS_RULED,
    'comment.secondAuthor': COMMENTS_RULED,
    'comment.markdown': COMMENTS_RULED,

    // Guidelines
    'guideline.present': GUIDELINES_RULED,
    'guideline.pinned': GUIDELINES_RULED,
    'guideline.emptyBody': GUIDELINES_RULED,
    'guideline.duplicateTitle': GUIDELINES_RULED,
  },
};

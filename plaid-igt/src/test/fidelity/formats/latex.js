// The LaTeX book (src/export/latexBook.js), checked as an export only. The preset is judged with
// everything on: every orthography and field selected and the document metadata included.
// "Carried" means the information appears in the compiled book. The export is one numbered
// ExPex example per sentence and one chapter per document, so most of what a project holds has
// no place in it. The fidelity validator (e2e/fidelity/validators.mjs) compiles the bundle with
// LuaLaTeX when one is installed.

const inherent = (why) => ({ carried: false, kind: 'inherent', why });
const foreign = (why) => ({ carried: false, kind: 'foreign', why });
const ruled = (why, ruling) => ({ carried: false, kind: 'ruled', why, ruling });
const undecided = (why) => ({ carried: false, kind: 'undecided', why });

const PROJECT_CONFIG = inherent(
  'The book is the texts. Project configuration is not written, except the project name as its title.',
);
const VOCABULARY = inherent(
  'The book is the texts. A vocabulary has no chapter, and the export reads none.',
);
const PROVENANCE = inherent(
  'Values are printed without any mark of who or what made them. A printed book has no place for provenance.',
);
const COMMENTS = ruled(
  'Comments go into no interchange format, only the native archive.',
  'plaid_comments.md, ruled out 2026-08-31 in commit 87cb70e3. A non-native preset says so in ExportPresetEditor.jsx: "Comments left on a document (the Comments tab) are not exported." runExport.js loads comments for the native archive only.',
);
const GUIDELINES = ruled(
  'Guidelines go into the native archive only.',
  'runExport.js: "The project\'s annotation manual, on the same terms as comments: the native archive only." plaid_guidelines.md, 2026-09-15.',
);
const ENTRY_TIER = undecided(
  'No line names the entry a word or morpheme is linked to, and nothing marks a multi-word expression. The Analyze tab shows both, and an example line could too.',
);

export default {
  id: 'latex',
  name: 'LaTeX book',
  check: 'export',
  stamps: { projectConfig: [], documentMetadata: [], tokenMetadata: [], itemMetadata: [] },
  features: {
    // Project configuration
    'project.documentMetadataFields': {
      carried: 'changed',
      how: 'A switched-on field shows only as the name before its value in the metadata list under the chapter heading, in a document that holds a non-empty value for it.',
    },
    'project.documentMetadataTagset': PROJECT_CONFIG,
    'project.tagset': PROJECT_CONFIG,
    'project.tagsetModeSuggest': PROJECT_CONFIG,
    'project.tagsetModeClosed': PROJECT_CONFIG,
    'project.tagsetModeMixed': PROJECT_CONFIG,
    'project.tagsetDelimiters': PROJECT_CONFIG,
    'project.tagsetValueDescription': {
      carried: 'changed',
      how: 'A description of a value the texts use in small caps is its meaning in the abbreviations chapter. A value no text uses is not listed.',
    },
    'project.tagsetOrdered': PROJECT_CONFIG,
    'project.languageObject': PROJECT_CONFIG,
    'project.languageMeta': PROJECT_CONFIG,
    'project.languageCoordinates': PROJECT_CONFIG,
    'project.speakers': PROJECT_CONFIG,
    'project.serviceDefaults': PROJECT_CONFIG,
    'project.autoAnalysis': PROJECT_CONFIG,
    'project.compose': PROJECT_CONFIG,
    'project.exportPresets': inherent(
      'The preset decides what the book holds, but the preset itself is not written into it.',
    ),
    'project.reviewedMembers': PROJECT_CONFIG,
    'project.plaidSettings': PROJECT_CONFIG,
    'project.researchOptIn': PROJECT_CONFIG,
    'project.foreignConfig': foreign("Another app's project configuration."),

    // Layers
    'layers.orthography': {
      carried: 'changed',
      how: "An orthography is an unlabeled line of the example, where the preset's order puts it (after the words by default), and only in a sentence where some word has a value in it.",
    },
    'layers.ignoredTokensPunctuation': inherent(
      'The rule is not written. Its effect shows only as a punctuation word printed with no morphemes.',
    ),
    'layers.ignoredTokensLetterLike': PROJECT_CONFIG,
    'layers.ignoredTokensBlacklist': PROJECT_CONFIG,
    'layers.fieldSentence': {
      carried: 'changed',
      how: 'The first sentence field with a value in a sentence, in the preset\'s order, is its free translation, in quotes and unlabeled. Every other one follows under its name ("Note: ...").',
    },
    'layers.fieldWord': {
      carried: 'changed',
      how: "A word field is an unlabeled line of the example, where the preset's order puts it (by default after the orthographies and before the morphemes, as the Analyze tab orders them), and is left out of a sentence where no word has a value in it.",
    },
    'layers.fieldMorpheme': {
      carried: 'changed',
      how: "A morpheme field is an unlabeled line of the example, where the preset's order puts it (after the morphemes by default), each cell the word's morpheme values joined with - and =, and is left out of a sentence where no morpheme has a value in it.",
    },
    'layers.fieldSameNameTwoScopes': {
      carried: 'changed',
      how: "Both fields print, each on its own unlabeled line where the preset's order puts it (by default the word field before the morphemes and the morpheme field after them). Nothing on the page names either.",
    },
    'layers.fieldOrder': {
      carried: 'changed',
      how: "The lines follow the preset's own order, which starts as the project's field order and can be changed. A field the preset does not name goes right after the line the project's order puts before it (latexLayout).",
    },
    'layers.fieldLang': PROJECT_CONFIG,
    'layers.fieldTagset': PROJECT_CONFIG,
    'layers.splitOnSpace': foreign('plaid-ud’s editing rule on the word layer.'),
    'layers.foreignTokenLayer': foreign(
      'A token layer another app uses. The export reads the IGT roles only.',
    ),
    'layers.unscopedSpanLayer': foreign(
      'A span layer with no IGT scope. The export offers scoped fields only.',
    ),
    'layers.relationLayer': foreign('Relations belong to plaid-ud.'),
    'layers.fieldEmpty': ruled(
      'A field with no values prints no line anywhere, so nothing shows that it exists.',
      'latexBook.js glossLines leaves out a line with nothing in it in the sentence, pinned by latexBook.test.js "leaves out a line with nothing in it". The plain-text export does the same (plainTextDoc.js formatSentencePlain).',
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
      where: 'a list under the chapter heading, one entry per switched-on field with a value',
    },
    'document.metadataUnconfigured': ruled(
      'The list prints the switched-on fields only.',
      'latexBook.js formatChapter reads igtDoc.document.metadata, which IgtDocument.js says carries only the configured fields, as plainTextDoc.js does for its header.',
    ),
    'document.textDirection': {
      carried: 'changed',
      how: "A right-to-left document's examples run right to left (the PlaidRightToLeft environment), and a value whose letters read the other way is set in its own direction. The setting itself is not written, only its effect.",
    },
    'document.speechDetection': inherent(
      'Speech-detection cuts are working state for the Media tab, not text.',
    ),
    'document.media': inherent('A printed book holds no recording.'),
    'document.noText': {
      carried: true,
      where: 'a chapter holding its heading and metadata alone',
    },
    'document.untokenized': {
      carried: true,
      where: "each sentence's text on the word line, one column per whitespace-separated run",
    },
    'document.duplicateName': {
      carried: true,
      where:
        'each chapter heading holds the name as it is. The files are numbered by their place in the book, so the two never collide.',
    },
    'document.nameSpecialChars': {
      carried: true,
      where:
        'the chapter heading holds the name as it is, escaped for LaTeX. The file name keeps its ASCII letters and digits only.',
    },
    'document.metadataLang': {
      carried: true,
      where:
        'the metadata list, under the field\'s full name ("Title (en)"), for a switched-on field',
    },
    'document.partlyAligned': undecided(
      'Which sentences are time-aligned shows only as a speaker above the example, and only where the segment has a speaker. Printing times, the question under alignment.times, would show it.',
    ),
    'document.differentFilledFields': {
      carried: true,
      where: 'each example prints lines for the fields that hold values in that sentence',
    },

    // What the text is made of
    'text.astral': {
      carried: true,
      where:
        'written as is. The book compiles with LuaLaTeX, which reads UTF-8, and a script the main font lacks gets its Noto font.',
    },
    'text.combining': {
      carried: true,
      where:
        'written as is. Columns are aligned by the typeset width, so a combining mark takes no column of its own.',
    },
    'text.rtlScript': {
      carried: true,
      where: 'written in logical order and set right to left, with a Noto font for the script',
    },
    'text.multiline': inherent(
      "The book is laid out one example per sentence. The baseline's own line breaks are not written.",
    ),
    'text.blankLine': inherent(
      'The book is laid out one example per sentence. A blank line in the baseline is not written.',
    ),
    'text.markupChars': {
      carried: true,
      where:
        'on the word lines, each LaTeX special character escaped so it prints as itself (domain/tex.js)',
    },
    'text.zeroMorph': {
      carried: true,
      where: 'written as is on the word lines',
    },

    // Tokens
    'token.sentence': {
      carried: true,
      where: 'one example per sentence, numbered (1), (2) and so on from the start of each chapter',
    },
    'token.word': {
      carried: true,
      where: 'one column per word in the example',
    },
    'token.ignoredWord': {
      carried: true,
      where: 'a column of its own on the word line, empty on the other lines',
    },
    'token.untokenizedText': {
      carried: true,
      where: 'a column per whitespace-separated run on the word line, empty on the other lines',
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
      where: 'the morpheme line, the morpheme forms joined with - and =',
    },
    'token.singleStoredMorpheme': {
      carried: 'changed',
      how: "The morpheme's form is on the morpheme line. When every word of the sentence is one morpheme with the word's own text, that line would repeat the words, and is left out.",
    },
    'token.unanalyzedWord': {
      carried: 'changed',
      how: 'The morpheme line prints the word itself, the same as for a word analyzed as one morpheme with that form, and is left out of a sentence where that is true of every word. Its morpheme field cells are empty.',
    },
    'token.morphemeForm': {
      carried: true,
      where: 'the morpheme line',
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
      where: '∅ written as is on the morpheme line',
    },
    'token.morphTypeOnMorpheme': {
      carried: 'changed',
      how: "A morph type shows only through the joint beside the morpheme: = when either neighbour is a clitic, - otherwise. A linked entry's morph type is used in place of the morpheme's own. Stems, prefixes, suffixes and the rest read alike.",
    },
    'token.provenance': PROVENANCE,
    'token.wordsInOneRun': {
      carried: 'changed',
      how: 'The two words print as separate columns, the same as words a space divides, so the book does not show that they were written as one run.',
    },
    'token.wordEdgePunctuation': {
      carried: true,
      where: "the word's own text, punctuation included, on the word line",
    },
    'token.sentenceExtraMetadata': inherent('Sentence metadata is not an annotation tier.'),
    'token.morphemeProvenance': PROVENANCE,
    'token.procliticBeforeMorpheme': {
      carried: true,
      where: 'the morpheme line, the proclitic joined to the morpheme after it with =',
    },

    // Time alignment
    'alignment.provenance': PROVENANCE,
    'alignment.severalInSentence': undecided(
      'A sentence holding several segments gets no speaker, even when every one of them has the same speaker, because only a segment that matches or contains the sentence gives one (flextext.js coveringAlignment).',
    ),
    'alignment.straddlesSentences': inherent(
      'The book is laid out by sentence. A segment crossing a boundary matches neither sentence, so it gives neither a speaker.',
    ),
    'alignment.mixedSpeakersInSentence': ruled(
      'A sentence whose segments differ in speaker gets no speaker.',
      'flextext.js phraseSpeakerFor: "a phrase that straddles a speaker change just gets no speaker rather than a wrong one". latexBook.js uses it as plainTextDoc.js does.',
    ),
    'alignment.textAcrossLineBreak': inherent(
      "The book is laid out by sentence and word. The segment's line breaks and runs of spaces are not written.",
    ),
    'alignment.times': undecided(
      "A segment's speaker is printed above the example it covers, but its times are not. The book could print them beside the speaker, and nothing says it should not.",
    ),
    'alignment.speaker': {
      carried: 'changed',
      how: "A sentence that one segment matches (an exact extent, else the only segment containing it) gets that segment's speaker above its lines, in small caps. A segment covering part of a sentence, or two segments over one sentence, gives no speaker (phraseSpeakerFor in flextext.js).",
    },
    'alignment.extraMetadata': inherent('Segment metadata other than the speaker is not written.'),
    'alignment.notSentenceExtent': inherent(
      'The book is laid out by sentence. A segment has no lines of its own, only a speaker on the sentence it covers.',
    ),
    'alignment.overlappingTimes': inherent(
      'The book is laid out by sentence. A segment has no lines of its own, so an overlap between two has nowhere to show.',
    ),

    // Annotations (spans)
    'span.sentenceValue': {
      carried: true,
      where:
        'the free translation of the example, or a line under it named after the field, when the value is not empty',
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
    'span.onForeignLayer': foreign("An annotation in another app's span layer."),
    'span.onAlignment': inherent(
      'The book is laid out by sentence, and an annotation on a segment has no sentence line to sit on.',
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
      where: 'printed as is, like any other value, in small caps where it is written in capitals',
    },
    'span.delimitedValue': {
      carried: true,
      where: 'printed as is, delimiters included, each capitalized part in small caps',
    },
    'span.markupChars': {
      carried: true,
      where:
        'each LaTeX special character escaped so it prints as itself (domain/tex.js). A cell holding // is braced so ExPex does not end the line there.',
    },
    'span.multilineValue': {
      carried: 'changed',
      how: 'A line break inside a value is printed as a space, since a cell and a free line are each one line of text.',
    },
    'span.emptyValue': inherent(
      'An empty value prints as an empty cell, and an empty sentence field is left out, the same as no annotation.',
    ),
    'span.valueWhitespace': inherent(
      'Space at the edge of a value is not printed, and a run of spaces inside one prints as one.',
    ),

    // Vocabulary links
    'link.word': ENTRY_TIER,
    'link.morpheme': ENTRY_TIER,
    'link.mwe': ENTRY_TIER,
    'link.mweDiscontinuous': ENTRY_TIER,
    'link.mweAcrossSentences': ENTRY_TIER,
    'link.onSentence': ENTRY_TIER,
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
      'A segment has no lines of its own in a book laid out by sentence, so nothing could name the entry linked to it.',
    ),
    'link.entryMorphType': {
      carried: 'changed',
      how: "The entry's morph type shows only through the joint beside the morpheme: = when it is a clitic, - otherwise. The export reads no vocabulary, so the joint follows the morph type the document GET's embedded link carries, else the morpheme's own.",
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

// The LaTeX book (src/export/latexBook.js), checked as an export only. The preset is judged with
// everything on: every orthography and field selected, the document metadata included, and the
// vocabulary chapter with every vocabulary and every entry field ticked (Status and Morph Type
// start off and are ticked here), listing the entries the texts use, which is the default.
// "Carried" means the information appears in the compiled book. The export is one numbered
// ExPex example per sentence and one chapter per document, then one vocabulary chapter per
// vocabulary, so most of what a project holds has no place in it. A linked word or morpheme in
// the examples is an invisible PDF link to its entry in the chapter. The fidelity validator
// (e2e/fidelity/validators.mjs) compiles the bundle with LuaLaTeX when one is installed.

const inherent = (why) => ({ carried: false, kind: 'inherent', why });
const foreign = (why) => ({ carried: false, kind: 'foreign', why });
const ruled = (why, ruling) => ({ carried: false, kind: 'ruled', why, ruling });
const undecided = (why) => ({ carried: false, kind: 'undecided', why });

const PROJECT_CONFIG = inherent(
  'The book is the texts. Project configuration is not written, except the project name as its title.',
);
const VOCAB_CONFIG = inherent(
  'The vocabulary chapter prints entries and their values. How a vocabulary is set up is not written.',
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
const UNDECLARED = ruled(
  'Entry metadata no field declares is not printed.',
  'user, 2026-09-17: metadata no field declares is exported by no format except the native archive (plaid_fidelity_campaign.md).',
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
    'project.languageObject': {
      carried: 'changed',
      how: "Not written. The language's tag (else its ISO 639-3 code) sets the order of the entries in the vocabulary chapter, and a tag the collator cannot read gives the root order.",
    },
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
    'layers.tokenizeNewTextOff': PROJECT_CONFIG,
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
    'vocab.linked': {
      carried: 'changed',
      how: 'A chapter at the end of the book, after the texts, headed "Vocabulary", listing the entries the texts link to (a headword with all its senses when any of them is linked), or every entry when the preset\'s Entries is All. The chapter can be switched off, and a vocabulary with nothing to list is left out.',
    },
    'vocab.second': {
      carried: 'changed',
      how: 'Each vocabulary is a chapter of its own, headed by the vocabulary\'s name. A vocabulary with nothing to list is left out, and when only one is left its chapter is headed "Vocabulary".',
    },
    'vocab.customField': {
      carried: 'changed',
      how: 'A value prints after the gloss under the field\'s name ("Register: colloquial."), in the vocabulary\'s field order. The field itself is not written.',
    },
    'vocab.fieldNotInline': inherent(
      'A display setting. Every chosen field prints the same way in the chapter.',
    ),
    'vocab.fieldTagset': inherent(
      'The tagset is not written. A value of the field prints as is, like any other.',
    ),
    'vocab.fieldLang': {
      carried: 'changed',
      how: 'The writing system shows only as the suffix on the field\'s name ("Source (en): ..."). A value whose letters read right to left is set in its own direction.',
    },
    'vocab.fieldMultilingual': {
      carried: 'changed',
      how: 'The field prints as a field of its own under its name with the suffix ("Gloss (fr): chien."), in the vocabulary\'s field order, not beside the field it translates.',
    },
    'vocab.fieldItemRef': {
      carried: 'changed',
      how: "The value prints under the field's name as the target entry's form with its number (kai₁). It is text, not a link, and the target is not listed for it.",
    },
    'vocab.fieldItemRefMany': {
      carried: 'changed',
      how: "The targets print under the field's name as their forms with their numbers, joined with commas. They are text, not links.",
    },
    'vocab.fieldEntryScope': {
      carried: 'changed',
      how: 'The field prints on the headword, and on a sense only when the sense holds a value in it. The scope itself is not written.',
    },
    'vocab.customTagset': VOCAB_CONFIG,
    'vocab.foreignConfig': foreign("plaid-dict's publication record on a vocabulary."),
    'vocab.duplicateName': {
      carried: 'changed',
      how: 'Each vocabulary with entries to list is a chapter of its own, and both chapters carry the same heading, so nothing on the page tells them apart.',
    },
    'vocab.fieldAliasName': {
      carried: true,
      where: 'the vocabulary chapter, the value under the field\'s own name ("Number: sg.")',
    },

    // Vocabularies: entries
    'item.gloss': {
      carried: true,
      where:
        'the vocabulary chapter, in quotes right after the form, its capitalized parts in small caps by the rule the glosses of the texts follow',
    },
    'item.pos': {
      carried: true,
      where: 'the vocabulary chapter, under "POS"',
    },
    'item.morphType': {
      carried: 'changed',
      how: 'Off by default. When the preset ticks Morph Type, it prints under "Morph Type" by its name on screen, and a stem or root prints nothing. Whether the entry is an affix also decides how its gloss is set in small caps, and its morph type sets the joints of the morpheme line in the texts (link.entryMorphType).',
    },
    'item.definition': {
      carried: true,
      where: 'the vocabulary chapter, under "Definition"',
    },
    'item.status': {
      carried: true,
      where:
        'the vocabulary chapter, under "Status", when the preset ticks it. It starts off, as a status says how far editing has got rather than anything about the word.',
    },
    'item.lexemeForm': {
      carried: true,
      where: 'the vocabulary chapter, under "Lexeme Form"',
    },
    'item.customFieldValue': {
      carried: true,
      where: "the vocabulary chapter, under the field's name",
    },
    'item.multilingualValue': {
      carried: true,
      where: 'the vocabulary chapter, under the field\'s name with its suffix ("Gloss (fr)")',
    },
    'item.itemRefValue': {
      carried: 'changed',
      how: 'The target prints as its form with its number, as text. Which entry it is shows only through that name, and the target is listed only when the texts use it (or under All).',
    },
    'item.itemRefManyValue': {
      carried: 'changed',
      how: 'The targets print as their forms with their numbers, joined with commas, as text.',
    },
    'item.sense': {
      carried: 'changed',
      how: 'A sense prints under its headword by its whole number (1.1), with its own form only when it is spelled unlike the headword, then its fields and examples.',
    },
    'item.subsense': {
      carried: 'changed',
      how: 'A sense of a sense prints after its parent, in the same run, by its whole number (1.2.1). Its depth shows only in the number.',
    },
    'item.senseOrder': {
      carried: 'changed',
      how: 'The senses print in their order, and the order shows only in their numbers. The stored order value is not written.',
    },
    'item.homonyms': {
      carried: 'changed',
      how: 'Each headword spelled the same prints with its number as a subscript (perro₁), in the order of their numbers, and a link from the texts goes to the right one.',
    },
    'item.homographNumber': {
      carried: 'changed',
      how: 'The stored number orders the headwords spelled the same, and each prints with its place in that order as a subscript, the number the app shows, which can differ from the stored one (a headword stored as 2 beside one with no number prints as 1, the other as 2). A headword alone prints no number, or 1 when it has senses.',
    },
    'item.exampleCorpus': {
      carried: 'changed',
      how: 'A promoted example prints as the number of its example in the book, chapter and example in parentheses after the fields of the entry ("(4.1)"), a link to it in the PDF. One whose sentence, word or morpheme is not in the book is left out.',
    },
    'item.exampleText': undecided(
      "An example stored as text and translation (a FLEx import's) is not printed: the chapter lists only examples the book holds. It could print the text and its translation.",
    ),
    'item.flexIdentity': inherent("FLEx's own guids name nothing a reader of the book can use."),
    'item.provenance': PROVENANCE,
    'item.zeroMorph': {
      carried: true,
      where: 'the vocabulary chapter, ∅ as the headword form',
    },
    'item.unlinked': {
      carried: 'changed',
      how: "Listed only when the preset's Entries is All. By default the chapter lists the entries the texts link to, so an entry no text uses is left out.",
    },
    'item.extraMetadata': UNDECLARED,
    'item.markupChars': {
      carried: 'changed',
      how: 'A tab or line break prints as a space, a leading double quote prints as is, and each LaTeX special character is escaped so it prints as itself (domain/tex.js texLine and texEscape).',
    },
    'item.surroundingWhitespace': inherent(
      'Space at the edge of a form or value is not printed, and a run of spaces inside one prints as one.',
    ),
    'item.offTagset': {
      carried: true,
      where: 'the vocabulary chapter, printed as is, like any other value',
    },
    'item.formNormalization': {
      carried: 'changed',
      how: 'Both headwords are listed, each as stored, and they print alike. They get no homograph numbers, since the app numbers only forms with the same code points, so nothing on the page tells them apart.',
    },
    'item.containerHeadword': {
      carried: true,
      where: 'the vocabulary chapter, the headword with no values of its own, then its senses',
    },
    'item.exampleStale': inherent(
      'A promoted example whose token is gone has no example in the book to point at, so it is left out.',
    ),

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
    'link.word': {
      carried: 'changed',
      how: "The word on the word line is a PDF link to its entry in the vocabulary chapter. Nothing marks the link on the page, and it is there only when the chapter is on and lists the entry's vocabulary.",
    },
    'link.morpheme': {
      carried: 'changed',
      how: "The morpheme on the morpheme line is a PDF link to its entry in the vocabulary chapter, whatever its spelling. Nothing marks the link on the page. In a sentence whose morpheme line is left out, a word that is its one morpheme links to that morpheme's entry from the word line. Only when the chapter is on and lists the entry's vocabulary.",
    },
    'link.mwe': {
      carried: 'changed',
      how: "Each word of the expression links in the PDF to the expression's entry, unless the word has a listed entry of its own. Nothing on the page marks the expression or the links.",
    },
    'link.mweDiscontinuous': {
      carried: 'changed',
      how: "The expression's own words link to its entry, the word between them does not. Nothing on the page marks the expression or the links.",
    },
    'link.mweAcrossSentences': inherent(
      'The entry is listed in the vocabulary chapter, but no word links to it. The book is laid out by sentence, and like the Analyze tab it places an expression only in a sentence that holds two of its words.',
    ),
    'link.onSentence': undecided(
      'The entry is listed in the vocabulary chapter as used, but nothing in the example links to it or names it. The example number could link to it.',
    ),
    'link.toSense': {
      carried: 'changed',
      how: 'The word or morpheme links in the PDF to the sense, which the vocabulary chapter lists under its headword by its number (1.1). Nothing marks the link on the page.',
    },
    'link.secondVocabulary': {
      carried: 'changed',
      how: "Each link goes to its entry in its own vocabulary's chapter. Nothing on the page says which vocabulary a word or morpheme is linked into.",
    },
    'link.provHuman': PROVENANCE,
    'link.provMachine': PROVENANCE,
    'link.provContributed': PROVENANCE,
    'link.provVerified': PROVENANCE,
    'link.provSource': PROVENANCE,
    'link.provProb': PROVENANCE,
    'link.provDetail': PROVENANCE,
    'link.onSegment': inherent(
      'The entry is listed in the vocabulary chapter as used, but a segment has no lines of its own in a book laid out by sentence, so nothing links to it.',
    ),
    'link.entryMorphType': {
      carried: 'changed',
      how: "The entry's morph type shows in the texts only through the joint beside the morpheme: = when it is a clitic, - otherwise. The joint follows the morph type the document GET's embedded link carries, else the morpheme's own. The vocabulary chapter prints it only when the preset ticks Morph Type (item.morphType).",
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

// ELAN (.eaf), checked as a round trip: every document of a project is exported with a preset
// that selects every orthography and field and turns every option on (morphemes, affix markers,
// one tier set per speaker, media), the .eaf files are imported as a new project with the tier
// roles the importer suggests and each recording chosen beside the .eaf that names it, and the
// new project is compared with the old one. "Carried" means the feature comes back as it was,
// apart from the import's bookkeeping under `stamps`. An .eaf holds no running text, so the import
// rebuilds the baseline from the sentence annotations (token.sentence says how) and every offset
// is compared against that rebuilt text. The 'changed' entries say exactly how.

const carried = { carried: true };

const NO_LEXICON = {
  carried: false,
  kind: 'inherent',
  why: 'An .eaf holds no lexicon, and the ELAN import links no vocabulary to the project it makes.',
};

const NO_LINK = {
  carried: false,
  kind: 'inherent',
  why: 'An .eaf holds no lexicon for a link to point at, so no link is written or made.',
};

const PROJECT_SETTING = {
  carried: false,
  kind: 'inherent',
  why: 'A project setting. An .eaf describes one document and has no place for it.',
};

const NO_ANNOTATION_METADATA = {
  carried: false,
  kind: 'inherent',
  why: 'An EAF annotation holds a value (and, when alignable, two time slots) and nothing else, so metadata on it has no place.',
};

const PROV_LOST = {
  carried: false,
  kind: 'inherent',
  why: 'An EAF annotation holds no metadata, so the provenance marks are not written and the value comes back as a human one.',
};

const TOKEN_PROV_LOST = {
  carried: false,
  kind: 'inherent',
  why: 'An EAF annotation holds no metadata, so provenance on a token is not written and the token comes back unmarked.',
};

// Tagsets go out as EAF CONTROLLED_VOCABULARY elements where the shape is one. Evidence: the EAF
// 2.8 schema (a CV is CV_ID plus a sequence of CV_ENTRY_ML, each with CVE_VALUE text, a required
// LANG_REF and an optional DESCRIPTION, and a LINGUISTIC_TYPE names at most one CV through
// CONTROLLED_VOCABULARY_REF, while ANNOTATION_VALUE stays a free string with an optional CVE_REF)
// and the ELAN 6.3 manual. In 2.6.1 a CV is the predefined values an annotation is chosen from,
// each with a description, in an order the user moves entries up and down in. In 2.9.3 an entry
// is committed as the whole annotation value. In 2.6.8 the constraint is bypassed by Shift and
// double click. In 1.9.2.11 an annotation whose value is no longer in its CV keeps its value.
const TAGSET_RULING =
  'user, 2026-09-17: a tagset goes out as an ELAN controlled vocabulary where it can reasonably be seen as one, and not where that takes a lot of coercion';

const COMMENTS_RULED = {
  carried: false,
  kind: 'ruled',
  why: 'Comments go into no interchange format. An ELAN copy would need a tier of its own, present only in commented documents, which the batch import would refuse as a different tier structure.',
  ruling: 'plaid_comments.md, 2026-08-31, commit 87cb70e3',
};

const GUIDELINES_RULED = {
  carried: false,
  kind: 'ruled',
  why: 'Guidelines ride the native archive only.',
  ruling: 'plaid_guidelines.md, 2026-09-15, commit 677a4efc',
};

// The one normalization every annotation value, orthography value and document property goes
// through on the way back in (readEaf.js PROPERTY, buildDocuments.js fieldValueOn).
const TRIMMED_VALUE = {
  carried: 'changed',
  how: 'The value comes back trimmed of leading and trailing whitespace, and a value that is empty once trimmed does not come back.',
};

export default {
  id: 'elan',
  name: 'ELAN',
  check: 'roundTrip',
  stamps: {
    // Project setup marks the project initialized, and the import record under `import` stays
    // until the run reports finishing.
    projectConfig: ['initialized', 'import'],
    // src/import/resume.js: the .eaf file name and the done marker written last. `Media file`
    // is the recording's file name as the .eaf's MEDIA_DESCRIPTOR gives it
    // (buildDocuments.js), written on every document whose .eaf names a recording.
    documentMetadata: ['importSource', 'importDone', 'Media file'],
    tokenMetadata: [],
    itemMetadata: [],
  },
  features: {
    // Project configuration
    'project.documentMetadataFields': {
      carried: 'changed',
      how: 'The list is rebuilt from the HEADER properties of the files: a field comes back only when at least one document has a non-empty value in it, as {name} alone, in the order the names first appear across the files. A field named documentName, lastUsedAnnotationId or URN does not come back. When any document has a recording, a field named `Media file` is added (see stamps).',
    },
    'project.documentMetadataTagset': {
      carried: false,
      kind: 'inherent',
      why: 'A HEADER PROPERTY is a bare name and value with no vocabulary behind it, and the import writes each field as {name} alone.',
    },
    'project.tagset': {
      carried: 'changed',
      how: 'Every tagset in closed mode with no delimiters is written as a CONTROLLED_VOCABULARY whose CV_ID is the tagset’s name, with one CV_ENTRY_ML per value in stored order and the value’s description as that entry’s DESCRIPTION, whether a field, only document metadata, or nothing uses it. It comes back as a tagset of the same name in closed mode, with its values in the same order as {value} or {value, description}, no delimiters and no ordered flag. A value’s color and any other key it carries are not written. A tagset in suggest or mixed mode, or with delimiters, is not written, as those keys say.',
    },
    'project.tagsetModeSuggest': {
      carried: false,
      kind: 'ruled',
      why: 'EAF has no mode, and ELAN treats a CV as the list an annotation is chosen from (manual 6.3, 2.6.1 and 2.9.3), bypassed only by Shift and double click (2.6.8). A suggest tagset written as a CV would come back closed and start refusing values the project accepts, so it is not written.',
      ruling: TAGSET_RULING,
    },
    'project.tagsetModeClosed': carried,
    'project.tagsetModeMixed': {
      carried: false,
      kind: 'ruled',
      why: 'Mixed mode accepts any part with a lowercase letter besides the listed values, which a CV cannot express. Written as a CV it would come back closed and refuse every stem, so it is not written.',
      ruling: TAGSET_RULING,
    },
    'project.tagsetDelimiters': {
      carried: false,
      kind: 'ruled',
      why: 'An ELAN CV entry is committed as the whole annotation value (manual 6.3, 2.9.3). A tagset with delimiters lists parts, so a value like 3-PL.PRS is several entries at once, which ELAN can neither offer nor check. A tagset with delimiters is not written.',
      ruling: TAGSET_RULING,
    },
    'project.tagsetValueDescription': carried,
    'project.tagsetOrdered': {
      carried: false,
      kind: 'inherent',
      why: 'CV entries keep their written order (CV_ENTRY_ML is a sequence, and ELAN lets a user move entries, manual 6.3, 2.6.1), so the values come back in order, as project.tagset says. EAF has no flag saying whether that order is meant to be shown as it stands.',
    },
    'project.languageObject': {
      carried: false,
      kind: 'undecided',
      why: 'EAF 2.8 declares languages (LANGUAGE, with LANG_REF on a tier), which could name the language of the sentence tier. The export declares none, and the import reads the language documented only from a FieldWorks-shaped name on the sentence tier (Transcription-txt-oni), which the export never writes.',
    },
    'project.languageMeta': {
      carried: false,
      kind: 'undecided',
      why: 'EAF 2.8 LANGUAGE and LANG_REF could name the language of the translation and gloss tiers. The export declares none, and the import reads the meta language only from a FieldWorks-shaped field tier name (Translation-gls-nl), which the export never writes.',
    },
    'project.languageCoordinates': {
      carried: false,
      kind: 'inherent',
      why: 'An EAF LANGUAGE has an identifier, a definition and a label, and nowhere to record a latitude and longitude.',
    },
    'project.speakers': {
      carried: false,
      kind: 'undecided',
      why: 'The speakers named on segments travel as tier PARTICIPANTs and come back on the segments (alignment.speaker), but the import does not write the project’s speaker list, so the list is empty afterwards.',
    },
    'project.serviceDefaults': PROJECT_SETTING,
    'project.autoAnalysis': PROJECT_SETTING,
    'project.compose': PROJECT_SETTING,
    'project.exportPresets': PROJECT_SETTING,
    'project.reviewedMembers': {
      carried: false,
      kind: 'inherent',
      why: 'Names project members, which an .eaf has no place for.',
    },
    'project.foreignConfig': {
      carried: false,
      kind: 'foreign',
      why: 'Another app’s project config. The export reads only the IGT layers.',
    },

    // Layers
    'layers.orthography': carried,
    'layers.ignoredTokensPunctuation': {
      carried: 'changed',
      how: "The import writes the default rule the setup wizard and the FLEx import write, {type: 'unicodePunctuation', whitelist: []}, whatever rule the exported project had. Letter-like characters and a blacklist are lost (see the next two keys). Today the import writes no rule at all, which is the bug.",
      ruling:
        'user, 2026-09-17: the CLDF and ELAN imports give a new project the same default ignored-tokens rule as the setup wizard',
    },
    'layers.ignoredTokensLetterLike': {
      carried: false,
      kind: 'inherent',
      why: 'A setting on the word layer. An .eaf has no place for it, and the import writes no ignored-tokens rule.',
    },
    'layers.ignoredTokensBlacklist': {
      carried: false,
      kind: 'inherent',
      why: 'A setting on the word layer. An .eaf has no place for it, and the import writes no ignored-tokens rule.',
    },
    'layers.fieldSentence': carried,
    'layers.fieldWord': carried,
    'layers.fieldMorpheme': carried,
    'layers.fieldSameNameTwoScopes': carried,
    'layers.fieldOrder': carried,
    'layers.fieldLang': carried,
    'layers.fieldTagset': {
      carried: 'changed',
      how: 'A field governed by a tagset that is written (closed, no delimiters, see project.tagset) is written with a LINGUISTIC_TYPE whose CONTROLLED_VOCABULARY_REF names that tagset, and comes back governed by it. A field governed by any other tagset comes back with no tagset.',
    },
    'layers.foreignTokenLayer': {
      carried: false,
      kind: 'foreign',
      why: 'A token layer with a role plaid-igt does not use is not part of the exported tier tree.',
    },
    'layers.unscopedSpanLayer': {
      carried: false,
      kind: 'foreign',
      why: 'A span layer with no IGT scope is not discovered by the export (exportLayers.js).',
    },
    'layers.relationLayer': {
      carried: false,
      kind: 'foreign',
      why: 'plaid-ud’s relation layers have no tier in the export.',
    },
    'layers.fieldEmpty': carried,

    // Vocabularies: their schema
    'vocab.linked': NO_LEXICON,
    'vocab.second': NO_LEXICON,
    'vocab.customField': NO_LEXICON,
    'vocab.fieldNotInline': NO_LEXICON,
    'vocab.fieldTagset': NO_LEXICON,
    'vocab.fieldLang': NO_LEXICON,
    'vocab.fieldMultilingual': NO_LEXICON,
    'vocab.fieldItemRef': NO_LEXICON,
    'vocab.fieldItemRefMany': NO_LEXICON,
    'vocab.fieldEntryScope': NO_LEXICON,
    'vocab.customTagset': NO_LEXICON,
    'vocab.foreignConfig': {
      carried: false,
      kind: 'foreign',
      why: 'Vocabulary config another app keeps. An .eaf holds no lexicon in any case.',
    },
    'vocab.duplicateName': NO_LEXICON,
    'vocab.fieldAliasName': NO_LEXICON,

    // Vocabularies: entries
    'item.gloss': NO_LEXICON,
    'item.pos': NO_LEXICON,
    'item.morphType': NO_LEXICON,
    'item.definition': NO_LEXICON,
    'item.status': NO_LEXICON,
    'item.lexemeForm': NO_LEXICON,
    'item.customFieldValue': NO_LEXICON,
    'item.multilingualValue': NO_LEXICON,
    'item.itemRefValue': NO_LEXICON,
    'item.itemRefManyValue': NO_LEXICON,
    'item.sense': NO_LEXICON,
    'item.subsense': NO_LEXICON,
    'item.senseOrder': NO_LEXICON,
    'item.homonyms': NO_LEXICON,
    'item.homographNumber': NO_LEXICON,
    'item.exampleCorpus': NO_LEXICON,
    'item.exampleText': NO_LEXICON,
    'item.flexIdentity': NO_LEXICON,
    'item.provenance': NO_LEXICON,
    'item.zeroMorph': NO_LEXICON,
    'item.unlinked': NO_LEXICON,
    'item.extraMetadata': NO_LEXICON,
    'item.markupChars': NO_LEXICON,
    'item.surroundingWhitespace': NO_LEXICON,
    'item.offTagset': NO_LEXICON,
    'item.formNormalization': NO_LEXICON,
    'item.containerHeadword': NO_LEXICON,
    'item.exampleStale': NO_LEXICON,

    // Documents
    'document.metadataConfigured': {
      carried: 'changed',
      how: 'Each value comes back trimmed of leading and trailing whitespace, and a key whose value is the empty string does not come back. A field named lastUsedAnnotationId or URN does not come back. A field named documentName does not come back either, and its value becomes the document’s name.',
    },
    'document.metadataUnconfigured': {
      carried: false,
      kind: 'ruled',
      why: 'Only the document metadata the project has switched on is written as HEADER properties.',
      ruling:
        'user, 2026-09-17: metadata no field declares is exported by no format except the native archive',
    },
    'document.textDirection': {
      carried: false,
      kind: 'ruled',
      why: 'The reserved plaid object in document metadata is kept by the native archive only.',
      ruling:
        'plaid_rtl_support.md: exporters that walk metadata leave the plaid object out, and the native archive keeps metadata whole on purpose',
    },
    'document.speechDetection': {
      carried: false,
      kind: 'ruled',
      why: 'Kept speech-detection cuts are proposals, not segments, and reach no export.',
      ruling: 'plaid_igt_speech_detection.md, amended 2026-09-09: nothing reaches an export',
    },
    'document.media': carried,
    'document.noText': carried,
    'document.untokenized': carried,
    'document.duplicateName': {
      carried: 'changed',
      how: 'Every document whose name another document in the import shares is renamed `<name> (n)`, with n counting from 1 in the order the .eaf files are read (buildDocuments.js).',
    },
    'document.nameSpecialChars': carried,
    'document.metadataLang': {
      carried: 'changed',
      how: 'A value under a switched-on field comes back under the same name, tag included, trimmed as document.metadataConfigured describes. One under a name no field is switched on for stays behind, as document.metadataUnconfigured says.',
    },
    'document.partlyAligned': carried,
    'document.differentFilledFields': carried,

    // What the text is made of
    'text.astral': carried,
    'text.combining': carried,
    'text.rtlScript': carried,
    'text.multiline': {
      carried: 'changed',
      how: 'A line break inside a sentence becomes a space, and exactly one newline separates consecutive sentences, as token.sentence describes.',
    },
    'text.blankLine': {
      carried: false,
      kind: 'inherent',
      why: 'An .eaf holds each sentence’s value and no running text between sentences, and the import joins sentences with one newline, so an empty line has nothing to come back from.',
    },
    'text.markupChars': {
      carried: 'changed',
      how: 'The characters < & " and , come back unchanged. A tab becomes a space under the whitespace rule token.sentence describes.',
    },
    'text.zeroMorph': carried,

    // Tokens
    'token.sentence': {
      carried: 'changed',
      how: 'The baseline is rebuilt from the sentences in document order. Each sentence’s text is trimmed and every run of whitespace inside it (spaces, tabs, line breaks) becomes one space. A sentence left empty is dropped together with its annotations. The texts are joined with a single newline, each sentence token covers its text and the newline after it, and the last one runs to the end of the body. Every other token’s offsets are re-derived against this body.',
    },
    'token.word': {
      carried: 'changed',
      how: 'The same words come back in the same order, each over the same text, with offsets re-derived against the rebuilt baseline as token.sentence describes.',
    },
    'token.ignoredWord': carried,
    'token.untokenizedText': {
      carried: 'changed',
      how: 'The text comes back inside its sentence, outside every word, under the whitespace rule token.sentence describes.',
    },
    'token.orthographyValue': {
      carried: 'changed',
      how: 'The value comes back under orthog:<name>, trimmed of leading and trailing whitespace.',
    },
    'token.orthographyUnconfigured': {
      carried: false,
      kind: 'ruled',
      why: 'The export writes a tier only for an orthography the word layer lists, so a value under any other name stays behind.',
      ruling:
        'user, 2026-09-17: metadata no field declares is exported by no format except the native archive',
    },
    'token.wordExtraMetadata': NO_ANNOTATION_METADATA,
    'token.segmentedWord': carried,
    'token.singleStoredMorpheme': carried,
    'token.unanalyzedWord': {
      carried: 'changed',
      how: 'The export writes the word’s derived morpheme as a Morph annotation on purpose (plaid_igt_virtual_morpheme.md), so the word comes back with one stored morpheme, precedence 1, whose metadata is {form} alone: the word’s text, trimmed, with a leading - or = removed (and morphType enclitic added when that was =). It carries no annotation.',
    },
    'token.morphemeForm': {
      carried: 'changed',
      how: 'The form comes back trimmed of leading and trailing whitespace. The first morpheme of a word loses a leading - or =, which the import reads as an affix marker.',
    },
    'token.morphemeFormEmpty': carried,
    'token.morphemeFormAbsent': {
      carried: 'changed',
      how: 'The morpheme comes back with metadata.form set to its word’s text, which is what it showed.',
    },
    'token.morphemeZero': carried,
    'token.morphTypeOnMorpheme': {
      carried: false,
      kind: 'undecided',
      why: 'Only the joint is written: with affix markers on, a morpheme written after = comes back with morphType enclitic, and no other morph type comes back. EAF could hold morph types on a tier of their own under Morph.',
    },
    'token.orphanMorpheme': {
      carried: false,
      kind: 'inherent',
      why: 'A Morph annotation subdivides a Word annotation, so a morpheme whose extent matches no word has no parent to be written under.',
    },
    'token.provenance': TOKEN_PROV_LOST,
    'token.wordsInOneRun': carried,
    'token.wordEdgePunctuation': carried,
    'token.sentenceExtraMetadata': NO_ANNOTATION_METADATA,
    'token.morphemeProvenance': TOKEN_PROV_LOST,
    'token.procliticBeforeMorpheme': {
      carried: false,
      kind: 'undecided',
      why: 'The proclitic’s morph type is not written, as token.morphTypeOnMorpheme says. Only the = joint after it is written.',
    },
    'alignment.provenance': TOKEN_PROV_LOST,
    'alignment.severalInSentence': carried,
    'alignment.straddlesSentences': {
      carried: false,
      kind: 'ruled',
      why: 'A segment crossing a sentence boundary belongs to no sentence, so it is not written and the sentences it touched come back unaligned rather than borrowing its time.',
      ruling:
        'commit 55334458 and the src/export/elan.js header: an alignment straddling a sentence boundary is dropped and its sentences stay unaligned',
    },
    'alignment.mixedSpeakersInSentence': {
      carried: false,
      kind: 'undecided',
      why: 'A sentence’s tiers are filed under one speaker, so its segments come back with that one speaker as alignment.speaker describes: a segment with none gains the other’s name, and segments naming two speakers all come back with none. EAF could file each segment’s tier under its own PARTICIPANT beneath the sentence tier.',
    },
    'alignment.textAcrossLineBreak': {
      carried: 'changed',
      how: 'The segment comes back over the same stretch of text, which the rebuilt baseline normalizes as token.sentence describes (a line break or a run of spaces becomes one space).',
    },
    'alignment.times': {
      carried: 'changed',
      how: 'timeBegin and timeEnd come back rounded to whole milliseconds (Math.round(t * 1000) / 1000). A segment is written only when it lies wholly inside one sentence and has a finite timeEnd no earlier than its timeBegin. A segment straddling a sentence boundary is dropped and those sentences come back unaligned (commit 55334458). A sentence whose time span overlaps an earlier sentence filed under the same speaker is written without a time, and its segments are dropped with it.',
    },
    'alignment.speaker': {
      carried: 'changed',
      how: 'A speaker travels as the PARTICIPANT of a sentence’s tier set, so each segment comes back with its sentence’s speaker, trimmed: the one non-blank speaker named by the segments inside the sentence. A segment with no speaker in a sentence where another segment names one gains that name, and the segments of a sentence that name two different speakers all come back with none.',
    },
    'alignment.extraMetadata': NO_ANNOTATION_METADATA,
    'alignment.notSentenceExtent': {
      carried: 'changed',
      how: 'A segment’s extent is re-derived against the rebuilt baseline as token.sentence describes. A sentence there covers the newline after its text and a segment does not, so a segment that covered its whole sentence no longer coincides with it, unless that sentence is the last in the document.',
    },
    'alignment.overlappingTimes': carried,

    // Annotations (spans)
    'span.sentenceValue': TRIMMED_VALUE,
    'span.wordValue': TRIMMED_VALUE,
    'span.morphemeValue': TRIMMED_VALUE,
    'span.multiToken': {
      carried: false,
      kind: 'inherent',
      why: 'A Symbolic_Association annotation has exactly one parent. A span over several tokens is written once on each token it is the first annotation of that field on, and comes back as that many single-token annotations.',
    },
    'span.duplicate': {
      carried: false,
      kind: 'inherent',
      why: 'A Symbolic_Association tier holds one annotation per parent, so only the first annotation of a field on a token is written.',
    },
    'span.onForeignLayer': {
      carried: false,
      kind: 'foreign',
      why: 'A span layer with no IGT scope is not discovered by the export.',
    },
    'span.onAlignment': {
      carried: false,
      kind: 'undecided',
      why: 'The export writes no tier for an annotation on a time-aligned segment. EAF could hold one as a Symbolic_Association tier under Segment.',
    },
    'span.provHuman': carried,
    'span.provMachine': PROV_LOST,
    'span.provContributed': PROV_LOST,
    'span.provVerified': PROV_LOST,
    'span.provSource': NO_ANNOTATION_METADATA,
    'span.provProb': NO_ANNOTATION_METADATA,
    'span.provDetail': NO_ANNOTATION_METADATA,
    'span.extraMetadata': NO_ANNOTATION_METADATA,
    'span.offTagset': {
      carried: 'changed',
      how: 'In a field governed by a tagset that is written (see project.tagset), the value comes back unchanged and still outside the list: ANNOTATION_VALUE is a free string whose CVE_REF is optional, and ELAN keeps such a value (manual 6.3, 1.9.2.11 and 2.6.8). Under a tagset that is not written, the value comes back and the tagset does not, as project.tagsetModeSuggest and project.tagsetModeMixed say.',
    },
    'span.delimitedValue': {
      carried: false,
      kind: 'ruled',
      why: 'The value comes back verbatim, but a tagset with delimiters is not written (project.tagsetDelimiters), so nothing splits it into tags.',
      ruling: TAGSET_RULING,
    },
    'span.markupChars': carried,
    'span.multilineValue': carried,
    'span.emptyValue': {
      carried: false,
      kind: 'ruled',
      why: 'An empty value is neither written nor read. Clearing an annotation deletes it, so an empty-string span is not something the app means to keep.',
      ruling:
        'plaid_igt_alpha_2026_08_rulings.md: clearing an annotation cell deletes the span, never store an empty value',
    },
    'span.overlapSameField': {
      carried: false,
      kind: 'inherent',
      why: 'A Symbolic_Association tier holds one annotation per parent, so each token is written with only the first annotation of that field covering it, and what was written comes back as single-token annotations.',
    },
    'span.reachesOrphanToken': {
      carried: false,
      kind: 'inherent',
      why: 'A morpheme matching no word has no parent to be written under (token.orphanMorpheme), and an annotation over several tokens comes back split per token (span.multiToken).',
    },
    'span.valueWhitespace': TRIMMED_VALUE,

    // Vocabulary links
    'link.word': NO_LINK,
    'link.morpheme': NO_LINK,
    'link.mwe': NO_LINK,
    'link.mweDiscontinuous': NO_LINK,
    'link.mweAcrossSentences': NO_LINK,
    'link.onSentence': NO_LINK,
    'link.duplicateOnToken': NO_LINK,
    'link.toSense': NO_LINK,
    'link.secondVocabulary': NO_LINK,
    'link.provHuman': NO_LINK,
    'link.provMachine': NO_LINK,
    'link.provContributed': NO_LINK,
    'link.provVerified': NO_LINK,
    'link.provSource': NO_LINK,
    'link.provProb': NO_LINK,
    'link.provDetail': NO_LINK,
    'link.onSegment': NO_LINK,
    'link.onOrphanToken': NO_LINK,
    'link.entryMorphType': NO_LINK,

    // Relations (plaid-ud)
    'relation.value': {
      carried: false,
      kind: 'foreign',
      why: 'plaid-ud’s relations have no tier in the export.',
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
      why: 'A comment on a plaid-ud relation, which has no tier in the export. Comments go into no interchange format in any case.',
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

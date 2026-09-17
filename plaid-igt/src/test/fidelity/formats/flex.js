// The FLEx export target writes one .flextext for the texts and one .lift (with its
// .lift-ranges) for the lexicon. It is judged here as run with a preset that maps every
// field and keeps the lexicon and citation forms on. The export runs one way: FLEx reads
// these files, and Plaid's own FLEx importer reads a .fwbackup instead. So "carried" means
// the files hold the information where FLEx reads it back from, which a later check
// confirms by parsing them and validating against FlexInterlinear.xsd and the LIFT schema.

const COMMENTS_RULED = {
  carried: false,
  kind: 'ruled',
  why: 'Comments stay in Plaid and go into no interchange format. The note and comment slots FLEx has are already bound to annotation fields and document metadata.',
  ruling:
    'plaid_comments.md, 2026-08-31, reaffirmed in eline_alpha_feedback_2026_09_09.md, 2026-09-10',
};

const GUIDELINES_RULED = {
  carried: false,
  kind: 'ruled',
  why: 'Guidelines ride the native archive only.',
  ruling: 'plaid_guidelines.md, 2026-09-15',
};

const NO_LIST_MODE = {
  carried: false,
  kind: 'inherent',
  why: 'A LIFT range has no open, closed or mixed mode, and a .flextext declares no value lists.',
};

const PLAID_SETTING = {
  carried: false,
  kind: 'inherent',
  why: 'A Plaid application setting. Neither file has a place for it.',
};

export default {
  id: 'flex',
  name: 'FLEx (.flextext and LIFT)',
  check: 'export',
  stamps: { projectConfig: [], documentMetadata: [], tokenMetadata: [], itemMetadata: [] },
  features: {
    // Project configuration
    'project.documentMetadataFields': {
      carried: false,
      kind: 'inherent',
      why: 'FLEx has a fixed set of text information fields, and neither file declares a list of them. The values are document.metadataConfigured.',
    },
    'project.documentMetadataTagset': {
      carried: false,
      kind: 'inherent',
      why: 'A .flextext text item names no value list.',
    },
    'project.tagset': {
      carried: false,
      kind: 'undecided',
      why: 'A .lift-ranges file can hold a value list, but the export writes only the grammatical-info range, built from the categories entries use, and the .flextext declares no lists.',
    },
    'project.tagsetModeSuggest': NO_LIST_MODE,
    'project.tagsetModeClosed': NO_LIST_MODE,
    'project.tagsetModeMixed': NO_LIST_MODE,
    'project.tagsetDelimiters': {
      carried: false,
      kind: 'inherent',
      why: 'Neither format splits a value into several tags.',
    },
    'project.tagsetValueDescription': {
      carried: false,
      kind: 'undecided',
      why: 'A LIFT range element can hold a <description>, but no tagset is written (see project.tagset).',
    },
    'project.tagsetOrdered': {
      carried: false,
      kind: 'inherent',
      why: 'FLEx orders a possibility list itself, and a .flextext declares no lists.',
    },
    'project.languageObject': {
      carried: 'changed',
      how: 'Only the writing-system tag travels. The preset takes it when made (the tag, else the ISO code, else a tag made from the name) and writes it as the lang of every vernacular <item type="txt">, <item type="punct"> and LIFT form, and as <languages><language vernacular="true">. The name, Glottocode and ISO code are not written.',
    },
    'project.languageMeta': {
      carried: 'changed',
      how: 'Only the writing-system tag travels. The preset takes it when made and writes it as the lang of every gloss, translation, LIFT gloss and definition that records no language of its own, and as a <languages><language>. The name, Glottocode and ISO code are not written.',
    },
    'project.languageCoordinates': {
      carried: false,
      kind: 'inherent',
      why: 'Neither format has a place for a location.',
    },
    'project.speakers': {
      carried: false,
      kind: 'inherent',
      why: 'Neither format keeps a list of speakers. A speaker in use rides on its phrase (alignment.speaker).',
    },
    'project.serviceDefaults': PLAID_SETTING,
    'project.autoAnalysis': PLAID_SETTING,
    'project.compose': {
      carried: false,
      kind: 'inherent',
      why: 'Plaid input settings. FLEx keeps keyboards on its writing systems, and neither file carries them.',
    },
    'project.exportPresets': {
      carried: false,
      kind: 'inherent',
      why: 'The preset shapes the files and is not written into them.',
    },
    'project.reviewedMembers': {
      carried: false,
      kind: 'inherent',
      why: 'Names Plaid users. Neither format has a place for whose work is reviewed.',
    },
    'project.foreignConfig': {
      carried: false,
      kind: 'foreign',
      why: 'Project config another app keeps.',
    },

    // Layers
    'layers.orthography': {
      carried: 'changed',
      how: 'An orthography becomes an extra vernacular writing system: a <languages><language vernacular="true"> and a second <word><item type="txt"> in the tag the preset gives it (by default made from the orthography name). The orthography name is not written.',
    },
    'layers.ignoredTokensPunctuation': {
      carried: false,
      kind: 'inherent',
      why: 'A .flextext declares no tokenization rule. FLEx decides punctuation from its writing-system definitions. What the rule decides for each token is token.ignoredWord.',
    },
    'layers.ignoredTokensLetterLike': {
      carried: false,
      kind: 'inherent',
      why: 'A .flextext declares no word-forming characters. FLEx keeps those on its writing systems, which the export does not write.',
    },
    'layers.ignoredTokensBlacklist': {
      carried: false,
      kind: 'inherent',
      why: 'A .flextext declares no tokenization rule.',
    },
    'layers.fieldSentence': {
      carried: 'changed',
      how: 'Each sentence field goes out as the phrase <item type="gls">, <item type="lit"> or <item type="note"> the preset maps it to (by default lit for a name with "literal", gls for one with "translation" or "gloss", note otherwise). The field name is not written, only the item type and its writing system.',
    },
    'layers.fieldWord': {
      carried: 'changed',
      how: 'Each word field goes out as the <word><item type="gls"> or <item type="pos"> the preset maps it to. The field name is not written, only the item type and its writing system.',
    },
    'layers.fieldMorpheme': {
      carried: 'changed',
      how: 'Each morpheme field goes out as the <morph><item type="gls"> or <item type="msa"> the preset maps it to. The field name is not written, only the item type and its writing system.',
    },
    'layers.fieldSameNameTwoScopes': {
      carried: true,
      where:
        'flextext <word><item type="gls"> and <morph><item type="gls">, told apart by the element that holds them',
    },
    'layers.fieldOrder': {
      carried: false,
      kind: 'inherent',
      why: 'FLEx orders interlinear lines by its own view configuration and does not read the order of <item> elements as one.',
    },
    'layers.fieldLang': {
      carried: true,
      where:
        "flextext lang attribute on each of the field's <item> elements, declared in <languages><language lang>",
    },
    'layers.fieldTagset': {
      carried: false,
      kind: 'inherent',
      why: 'A .flextext item names no value list.',
    },
    'layers.foreignTokenLayer': {
      carried: false,
      kind: 'foreign',
      why: 'A token layer plaid-ud keeps.',
    },
    'layers.unscopedSpanLayer': {
      carried: false,
      kind: 'foreign',
      why: 'A span layer another app keeps.',
    },
    'layers.relationLayer': {
      carried: false,
      kind: 'foreign',
      why: 'plaid-ud dependencies.',
    },
    'layers.fieldEmpty': {
      carried: false,
      kind: 'inherent',
      why: 'A .flextext declares no fields, only values, so a field nobody filled writes no item. At most its writing system appears in <languages>.',
    },

    // Vocabularies: their schema
    'vocab.linked': {
      carried: 'changed',
      how: 'Its entries are written to the one .lift file. The vocabulary name is not written.',
    },
    'vocab.second': {
      carried: 'changed',
      how: 'Its entries go into the same .lift file as the first vocabulary, and nothing records which vocabulary an entry came from. FLEx has one lexicon per project.',
    },
    'vocab.customField': {
      carried: true,
      where:
        'lift <sense><field type="<name>"> declared in <header><fields><field tag="<name>">, or the <note> or <field> FLEx itself uses for a name that is one of its built-ins (Source, Comment, ScientificName and the like)',
    },
    'vocab.fieldNotInline': {
      carried: false,
      kind: 'inherent',
      why: 'A display setting. LIFT has no place for where a field is shown.',
    },
    'vocab.fieldTagset': {
      carried: false,
      kind: 'undecided',
      why: 'The header <field tag> declaration names no value list, and no vocabulary tagset is written as a range.',
    },
    'vocab.fieldLang': {
      carried: true,
      where: "lift lang attribute of the field's <gloss>, <definition><form> or <field><form>",
    },
    'vocab.fieldMultilingual': {
      carried: true,
      where:
        'lift one <gloss lang>, <definition><form lang> or <field type="<base name>"><form lang> per writing system',
    },
    'vocab.fieldItemRef': {
      carried: true,
      where:
        'lift <relation type="<field name>" ref>, listed in the lexical-relation range of .lift-ranges',
    },
    'vocab.fieldItemRefMany': {
      carried: true,
      where:
        'lift one <relation type="<field name>" ref> per target, listed in the lexical-relation range of .lift-ranges',
    },
    'vocab.fieldEntryScope': {
      carried: true,
      where:
        'lift the <entry> element rather than a <sense>: <entry><relation> for a reference field, <entry><field> for a text field',
    },
    'vocab.customTagset': {
      carried: false,
      kind: 'undecided',
      why: 'A .lift-ranges file can hold a value list, but only the grammatical-info and lexical-relation ranges are written.',
    },
    'vocab.foreignConfig': {
      carried: false,
      kind: 'foreign',
      why: 'plaid-dict keeps its publication record there.',
    },
    'vocab.duplicateName': {
      carried: 'changed',
      how: 'Both vocabularies write their entries into the one .lift file, and neither name is written, so nothing shows that two shared a name.',
    },
    'vocab.fieldAliasName': {
      carried: true,
      where:
        'lift <sense><field type="<name>"> under the field\'s own name (Translation, Type, Number), declared in <header><fields>',
    },

    // Vocabularies: entries
    'item.gloss': { carried: true, where: 'lift <sense><gloss lang>' },
    'item.pos': {
      carried: true,
      where:
        'lift <sense><grammatical-info value>, listed in the grammatical-info range of .lift-ranges',
    },
    'item.morphType': { carried: true, where: 'lift <entry><trait name="morph-type" value>' },
    'item.definition': { carried: true, where: 'lift <sense><definition><form lang>' },
    'item.status': {
      carried: true,
      where: 'lift <sense><field type="status">, declared in <header><fields>',
    },
    'item.lexemeForm': {
      carried: true,
      where:
        'lift <entry><lexical-unit>, with the entry form in <entry><citation> when the two differ',
    },
    'item.customFieldValue': {
      carried: true,
      where:
        'lift <sense><field type="<name>"><form lang>, or the <note> or <field> FLEx uses for one of its built-in names',
    },
    'item.multilingualValue': {
      carried: true,
      where:
        'lift <gloss lang>, <definition><form lang> or <field><form lang>, in the writing system the field records',
    },
    'item.itemRefValue': {
      carried: true,
      where:
        'lift <relation type="<field name>" ref="<target entry or sense id>">, on the <entry> for a headword-only field and on the <sense> otherwise',
    },
    'item.itemRefManyValue': {
      carried: true,
      where: 'lift one <relation type="<field name>" ref> per target',
    },
    'item.sense': { carried: true, where: "lift <sense> inside its headword's <entry>" },
    'item.subsense': { carried: true, where: 'lift <subsense> inside its parent <sense>' },
    'item.senseOrder': {
      carried: true,
      where: 'lift document order of the <sense> and <subsense> elements',
    },
    'item.homonyms': {
      carried: true,
      where: 'lift two <entry> elements with the same <lexical-unit>, in server order',
    },
    'item.homographNumber': {
      carried: true,
      where:
        'lift <entry order>, and flextext <morph><item type="hn"> on every morph linked to the entry',
    },
    'item.exampleCorpus': {
      carried: 'changed',
      how: "The reference becomes text: <sense><example> holds the sentence's baseline in <form> and its translation in <translation><form>. Which document and token it pointed at is not written, and a reference that no longer resolves is left out with a warning.",
    },
    'item.exampleText': {
      carried: true,
      where: 'lift <sense><example><form> and <sense><example><translation><form>',
    },
    'item.flexIdentity': {
      carried: true,
      where: 'lift <entry guid> for flexEntry and <sense id> for flexSense',
    },
    'item.provenance': {
      carried: false,
      kind: 'undecided',
      why: 'FLEx has no provenance on entries, and LIFT could hold it as a <trait> or an <annotation>. The code writes the prov keys as custom <field>s named prov, provSource and provConfirmed, which nothing decided.',
    },
    'item.zeroMorph': { carried: true, where: 'lift <lexical-unit><form><text> holding ∅' },
    'item.unlinked': {
      carried: true,
      where: 'lift <entry>, since the whole lexicon is written whatever the texts link to',
    },
    'item.extraMetadata': {
      carried: true,
      where: 'lift <sense><field type="<key>">, declared in <header><fields>',
    },
    'item.markupChars': {
      carried: true,
      where:
        'lift <text> content and attribute values, XML-escaped, with a tab or line break in an attribute (such as <grammatical-info value>) written as a character reference so a parser keeps it',
    },
    'item.surroundingWhitespace': {
      carried: true,
      where: 'lift <text> content and attribute values, spaces as stored',
    },
    'item.offTagset': {
      carried: true,
      where:
        "the field's LIFT element (<grammatical-info value>, <field><form><text>), the value as stored",
    },
    'item.formNormalization': {
      carried: true,
      where:
        'lift two <entry> elements whose <lexical-unit> text differs only in normalization, each written as stored',
    },
    'item.containerHeadword': {
      carried: true,
      where:
        'lift the <entry> itself, with no <sense> of its own: its senses are its <sense> children and its own fields sit on the <entry>',
    },
    'item.exampleStale': {
      carried: false,
      kind: 'inherent',
      why: 'An example goes out as the text of the sentence it points into, and a token that no longer exists has none. The export leaves it out and warns.',
    },

    // Documents
    'document.metadataConfigured': {
      carried: 'changed',
      how: 'Title, Abbreviation, Source and Description go out as the text\'s <item type="title">, <item type="title-abbreviation">, <item type="source"> and <item type="comment">, in the writing system a tag in the name gives. Every other field becomes a "Name: value" line in the one comment item for the analysis writing system, the lines joined by " | ".',
    },
    'document.metadataUnconfigured': {
      carried: false,
      kind: 'undecided',
      why: 'The export reads only the switched-on fields, so a value under any other name is not written. The comment item could hold it as a "Name: value" line like any other field FLEx has no place for.',
    },
    'document.textDirection': {
      carried: false,
      kind: 'inherent',
      why: 'FLEx keeps direction on the writing system, and a .flextext has no attribute for it.',
    },
    'document.speechDetection': {
      carried: false,
      kind: 'ruled',
      why: 'Detected cuts are proposals and never reach an export.',
      ruling: 'plaid_igt_speech_detection.md, amended 2026-09-09',
    },
    'document.media': {
      carried: false,
      kind: 'undecided',
      why: 'The recording is not in the archive. A document with a timed phrase gets <media-files><media location>, whose location is the document name because the server URL names no file. The ELAN and CLDF exports bundle the recording beside their files.',
    },
    'document.noText': {
      carried: true,
      where: 'flextext <interlinear-text> with its title and an empty <paragraphs>',
    },
    'document.untokenized': {
      carried: 'changed',
      how: 'Each sentence is a <phrase> whose whole text, trimmed, is one <word><item type="punct">, since no word covers any of it.',
    },
    'document.duplicateName': {
      carried: true,
      where: 'flextext two <interlinear-text> elements with the same <item type="title">',
    },
    'document.nameSpecialChars': {
      carried: true,
      where: 'flextext <interlinear-text><item type="title">, XML-escaped',
    },
    'document.metadataLang': {
      carried: 'changed',
      how: 'The writing system in the name becomes the lang of the item. Title, Abbreviation, Source and Description go out as their own text items in it. Any other field becomes a "Name: value" line in the comment item for that writing system.',
    },
    'document.partlyAligned': {
      carried: true,
      where:
        'flextext begin-time-offset and end-time-offset on the aligned phrases only, the others without',
    },
    'document.differentFilledFields': {
      carried: true,
      where:
        'flextext each <interlinear-text> holding items only for the fields with values in that document',
    },

    // What the text is made of
    'text.astral': { carried: true, where: 'flextext <word><item type="txt">, UTF-8' },
    'text.combining': { carried: true, where: 'flextext <word><item type="txt">' },
    'text.rtlScript': { carried: true, where: 'flextext <word><item type="txt">' },
    'text.multiline': {
      carried: 'changed',
      how: 'A line break that closes a sentence starts a new <paragraph>. A line break inside a sentence is not written: a FLEx paragraph holds no line break and a segment cannot cross one.',
    },
    'text.blankLine': {
      carried: true,
      where: 'flextext an empty <paragraph><phrases></phrases></paragraph> for each blank line',
    },
    'text.markupChars': {
      carried: 'changed',
      how: '< & " and , are written XML-escaped in <item type="txt"> or <item type="punct">. A tab is spacing, and a .flextext records no spacing: FLEx joins the words with spaces of its own.',
    },
    'text.zeroMorph': { carried: true, where: 'flextext <word><item type="txt">' },

    // Tokens
    'token.sentence': { carried: true, where: 'flextext <phrase>' },
    'token.word': { carried: true, where: 'flextext <word><item type="txt">' },
    'token.ignoredWord': { carried: true, where: 'flextext <word><item type="punct">' },
    'token.untokenizedText': {
      carried: 'changed',
      how: 'Each run of text between words is one <word><item type="punct">, trimmed, whatever characters it holds. A run of whitespace alone is not written.',
    },
    'token.orthographyValue': {
      carried: true,
      where: 'flextext a second <word><item type="txt"> in the orthography\'s tag',
    },
    'token.orthographyUnconfigured': {
      carried: false,
      kind: 'undecided',
      why: 'Only a configured orthography has a tag in the preset, so a value under any other name is not written. It could go out as another txt item if it had a tag.',
    },
    'token.wordExtraMetadata': {
      carried: false,
      kind: 'inherent',
      why: 'A .flextext word holds items, morphemes and a guid, nothing else.',
    },
    'token.segmentedWord': {
      carried: true,
      where: 'flextext <word><morphemes> with one <morph> per morpheme, in order',
    },
    'token.singleStoredMorpheme': {
      carried: true,
      where: 'flextext <word><morphemes> with one <morph>',
    },
    'token.unanalyzedWord': {
      carried: 'changed',
      how: 'Written as <morphemes> holding one <morph> whose txt is the word, the morpheme the app shows. FLEx reads that as an analysis of the word into one morph.',
    },
    'token.morphemeForm': {
      carried: 'changed',
      how: 'Written as <morph><item type="txt"> with the affix markers of its morph type added ("-ar" for a suffix, "ka-" for a prefix, "=ni" for an enclitic), which is how FLEx spells a morph and matches it.',
    },
    'token.morphemeFormEmpty': {
      carried: 'changed',
      how: 'A <morph> with no <item type="txt">.',
    },
    'token.morphemeFormAbsent': {
      carried: 'changed',
      how: 'The <morph><item type="txt"> is the word\'s text with the affix markers of its morph type, so it reads the same as a form typed equal to the word.',
    },
    'token.morphemeZero': {
      carried: 'changed',
      how: 'Written as <morph><item type="txt"> holding ∅ with the affix markers of its morph type ("-∅" for a suffix). FLEx stores the zero morph as the same character.',
    },
    'token.morphTypeOnMorpheme': { carried: true, where: 'flextext <morph type>' },
    'token.orphanMorpheme': {
      carried: false,
      kind: 'inherent',
      why: 'A FLEx morph exists only inside a word.',
    },
    'token.provenance': {
      carried: false,
      kind: 'inherent',
      why: 'FLEx records no origin for a segment or a word. Its analysisStatus concerns analyses, not tokenization.',
    },
    'token.wordsInOneRun': {
      carried: 'changed',
      how: 'Written as two <word> elements. A .flextext records no spacing, and FLEx puts a space between words when it rebuilds the text, so "mediodía" reads back as "medio día".',
    },
    'token.wordEdgePunctuation': {
      carried: true,
      where: 'flextext <word><item type="txt"> holding the punctuation as part of the word',
    },
    'token.sentenceExtraMetadata': {
      carried: false,
      kind: 'inherent',
      why: 'A .flextext phrase holds items, words, times, a speaker and a media reference, nothing else.',
    },
    'token.morphemeProvenance': {
      carried: false,
      kind: 'undecided',
      why: 'The FLEx importer stamps the morphemes of an analysis no person approved, and <morphemes analysisStatus> is the same fact in a .flextext. The export writes none, so FLEx reads every analysis as human-approved.',
    },
    'token.procliticBeforeMorpheme': {
      carried: true,
      where:
        'flextext <morph type="proclitic"> whose txt ends in "=", followed by the next <morph> of the word',
    },
    'alignment.provenance': {
      carried: false,
      kind: 'inherent',
      why: 'A .flextext phrase records no origin for its times.',
    },
    'alignment.severalInSentence': {
      carried: 'changed',
      how: "FLEx times whole phrases. The phrase runs from the first segment's start to the last segment's end, and the boundaries between the segments are not written.",
    },
    'alignment.straddlesSentences': {
      carried: 'changed',
      how: 'A sentence wholly inside the segment takes its times and speaker. A sentence the segment only partly covers takes nothing from it, since a phrase has one time span.',
    },
    'alignment.mixedSpeakersInSentence': {
      carried: false,
      kind: 'inherent',
      why: 'A phrase has one speaker attribute, so segments in one sentence that disagree about the speaker cannot all be written.',
    },
    'alignment.textAcrossLineBreak': {
      carried: 'changed',
      how: 'The words of the segment are written and its spacing is not. A run of spaces reads back as one space, and a line break becomes a paragraph break only where it closes a sentence.',
    },
    'alignment.times': {
      carried: true,
      where:
        'flextext <phrase begin-time-offset end-time-offset> in milliseconds, with media-file when the document has a recording',
    },
    'alignment.speaker': { carried: true, where: 'flextext <phrase speaker>' },
    'alignment.extraMetadata': {
      carried: false,
      kind: 'inherent',
      why: 'A phrase carries times, a speaker and a media reference, nothing else.',
    },
    'alignment.notSentenceExtent': {
      carried: 'changed',
      how: "FLEx times whole phrases. A segment that contains a sentence gives that phrase its times and speaker, so a segment over several sentences gives each of them the same ones. Segments inside a sentence give the phrase the span from the first one's start to the last one's end. A segment that only partly covers a sentence gives it nothing.",
    },
    'alignment.overlappingTimes': {
      carried: true,
      where:
        "flextext each phrase's own begin-time-offset and end-time-offset, which may overlap another phrase's",
    },

    // Annotations (spans)
    'span.sentenceValue': {
      carried: true,
      where: 'flextext <phrase><item type="gls|lit|note"> after <words>',
    },
    'span.wordValue': { carried: true, where: 'flextext <word><item type="gls|pos">' },
    'span.morphemeValue': { carried: true, where: 'flextext <morph><item type="gls|msa">' },
    'span.multiToken': {
      carried: 'changed',
      how: 'The value is written on every token it covers, once each. Nothing records that it was one annotation.',
    },
    'span.duplicate': {
      carried: false,
      kind: 'inherent',
      why: 'FLEx keeps one value per item type and writing system. The first annotation is written and the second is not.',
    },
    'span.onForeignLayer': {
      carried: false,
      kind: 'foreign',
      why: 'An annotation in another app’s span layer.',
    },
    'span.onAlignment': {
      carried: false,
      kind: 'inherent',
      why: 'FLEx has no time-aligned segment apart from the phrase.',
    },
    'span.provHuman': {
      carried: true,
      where:
        'flextext no analysisStatus on <morphemes> or <item>, which FLEx reads as humanApproved',
    },
    'span.provMachine': {
      carried: false,
      kind: 'undecided',
      why: 'FlexInterlinear.xsd allows analysisStatus="guess" or "guessByStatisticalAnalysis" on <morphemes> and <item>. The export writes none, so FLEx reads machine output as human-approved.',
    },
    'span.provContributed': {
      carried: false,
      kind: 'undecided',
      why: 'The same analysisStatus slot as span.provMachine. None is written, so FLEx reads a contributor’s unreviewed work as human-approved.',
    },
    'span.provVerified': {
      carried: 'changed',
      how: 'No mark is written, so FLEx reads it as humanApproved, the same as human work. That it began as a proposal is not written.',
    },
    'span.provSource': {
      carried: false,
      kind: 'inherent',
      why: 'A .flextext names no producer for an analysis.',
    },
    'span.provProb': {
      carried: false,
      kind: 'inherent',
      why: 'A .flextext has no place for a probability.',
    },
    'span.provDetail': {
      carried: false,
      kind: 'inherent',
      why: 'A .flextext has no place for prediction detail.',
    },
    'span.extraMetadata': {
      carried: false,
      kind: 'inherent',
      why: 'A .flextext item holds a value, a type, a lang and an analysisStatus, nothing else.',
    },
    'span.offTagset': {
      carried: true,
      where: "the field's flextext <item>, the value as stored",
    },
    'span.delimitedValue': {
      carried: true,
      where: "the field's flextext <item>, the value as stored",
    },
    'span.markupChars': { carried: true, where: "the field's flextext <item>, XML-escaped" },
    'span.multilineValue': {
      carried: true,
      where: "the field's flextext <item>, line breaks kept in the element text",
    },
    'span.emptyValue': {
      carried: false,
      kind: 'inherent',
      why: 'FLEx makes no difference between an empty value and none. The export leaves the item out.',
    },
    'span.overlapSameField': {
      carried: false,
      kind: 'inherent',
      why: 'FLEx keeps one value per item type and writing system on a word or morph, so a token both annotations cover can hold only one of them.',
    },
    'span.reachesOrphanToken': {
      carried: 'changed',
      how: 'The value is written on the tokens that have a place in the file. The morpheme matching no word has none (token.orphanMorpheme), so that part of the annotation is not written.',
    },
    'span.valueWhitespace': {
      carried: true,
      where: "the field's flextext <item>, whitespace as stored",
    },

    // Vocabulary links
    'link.word': {
      carried: false,
      kind: 'undecided',
      why: 'The one morph written for a word with no morpheme of its own is the derived one, which carries no link, so no cf names the entry. FLEx links a whole word through a one-morph analysis whose cf does.',
    },
    'link.morpheme': {
      carried: true,
      where:
        'flextext <morph><item type="cf"> (the entry\'s lexeme form with its affix markers) and <morph><item type="hn">',
    },
    'link.mwe': {
      carried: false,
      kind: 'undecided',
      why: 'FlexInterlinear.xsd has <word type="phrase">, one word unit over adjacent words, and the export does not write it. It would replace the member words and their own analyses with one.',
    },
    'link.mweDiscontinuous': {
      carried: false,
      kind: 'inherent',
      why: 'A phrase in a FLEx text is contiguous.',
    },
    'link.mweAcrossSentences': {
      carried: false,
      kind: 'inherent',
      why: 'A phrase in a FLEx text cannot cross a segment boundary.',
    },
    'link.onSentence': {
      carried: false,
      kind: 'inherent',
      why: 'FLEx links lexical entries to morphs only.',
    },
    'link.duplicateOnToken': {
      carried: false,
      kind: 'inherent',
      why: 'A FLEx morph links one sense.',
    },
    'link.toSense': {
      carried: 'changed',
      how: 'The morph\'s cf and hn name the headword, and FLEx picks the sense whose gloss matches the morph\'s <item type="gls">. Nothing in the file names the sense itself.',
    },
    'link.secondVocabulary': {
      carried: 'changed',
      how: 'cf names the entry by form in the one merged lexicon. Which vocabulary it belongs to is not written.',
    },
    'link.provHuman': {
      carried: true,
      where:
        'flextext cf on a morph with no analysisStatus, which FLEx reads as humanApproved and links',
    },
    'link.provMachine': {
      carried: false,
      kind: 'undecided',
      why: 'The same analysisStatus slot as span.provMachine. None is written, so FLEx links a machine proposal as approved.',
    },
    'link.provContributed': {
      carried: false,
      kind: 'undecided',
      why: 'The same analysisStatus slot as span.provMachine. None is written, so FLEx links a contributor’s unreviewed link as approved.',
    },
    'link.provVerified': {
      carried: 'changed',
      how: 'No mark is written, so FLEx reads it as humanApproved like any human link. That it began as a proposal is not written.',
    },
    'link.provSource': {
      carried: false,
      kind: 'inherent',
      why: 'A .flextext names no producer for a link.',
    },
    'link.provProb': {
      carried: false,
      kind: 'inherent',
      why: 'A .flextext has no place for a probability.',
    },
    'link.provDetail': {
      carried: false,
      kind: 'inherent',
      why: 'A .flextext has no place for prediction detail.',
    },
    'link.onSegment': {
      carried: false,
      kind: 'inherent',
      why: 'FLEx links lexical entries to morphs only, and a segment is not a FLEx object apart from its phrase.',
    },
    'link.onOrphanToken': {
      carried: false,
      kind: 'inherent',
      why: 'A morpheme matching no word has no place in a .flextext (token.orphanMorpheme), so there is no morph to hold the link.',
    },
    'link.entryMorphType': {
      carried: true,
      where:
        "flextext <morph type> and the affix markers on the morph's txt and cf, all taken from the entry's morph type",
    },

    // Relations (plaid-ud)
    'relation.value': { carried: false, kind: 'foreign', why: 'plaid-ud dependencies.' },

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
      why: 'A comment on a plaid-ud relation.',
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

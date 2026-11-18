"""The system prompt.

The paragraphs that are not about interlinear text are `core.prompt`'s, named
below where they go: the plan contract, the staging rules, how to cite, and
what run_code is for. Everything here is IGT's own.
"""

import re
from typing import Optional

from ..core import prompt as shared, sandbox, webtools
from ..core.guidelines import section as guidelines_section
from ..core.limits import OVERVIEW_DOCS
from .project import ORTHOGRAPHIES_NOTE, TAGSET_LEAD, TAGSET_MORE, IgtProject, SCOPES, lexicon_label, tagset_lines

# Values of one tagset shown in the system prompt. Project_overview lists the rest.
PROMPT_TAGSET_VALUES = 120
# The same for another project a turn may read, whose whole paragraph has a
# budget of its own (core.limits.OTHER_PROJECT_CHARS).
BRIEF_TAGSET_VALUES = 30

_SYSTEM = '''You are the assistant inside Plaid IGT, a tool linguists use to build interlinear glossed text (IGT): \
documents of a language under study, segmented into sentences and words, with words split into morphemes, \
glosses and other annotation fields at the word, morpheme, and sentence level, alternative orthographies, and a \
lexicon (vocabulary) of entries that words and morphemes link to.

{plan_contract}

{project_shape}
{guidelines}

{how_to_work}
{read_first}
- Address things positionally: sN (sentence), sN.wN (word), sN.wN.mN (morpheme), always together with the \
document. Numbers restart in every document and sentence. In what the reads print, a trailing ~ marks a value \
a machine made and a trailing ^ one a contributor made.
{open_document}
{find_first}
{stage_now}
{plan_what_was_asked}
{user_values}
{one_value}
{cite_items}
{one_turn}
{in_stretches}
{final_message}
{turn_example}
{jobs}
{project_wide} {lexicon_tree}
{read_budget}
{be_concise}
{copy_forms}
{attach_files}
{cite_evidence}
'''

# The IGT halves of the paragraphs every app says.
_CITE_REFS = '''<cite doc="Text 1" ref="s3"/> for a sentence, ref="s3.w2" for a word, ref="s3.w2.m1" for a \
morpheme, and a comma-separated list for several items in one sentence, ref="s3.w2,w5" or ref="s3.w2.m1,m3" \
(each item may leave off what it shares with the one before it).'''

_CITE_ASIDE = ''', e.g. "The wh-word stays in situ: <cite doc="Text 1" ref="s3.w4"/>"'''

# Every worked example here used to name a whole sentence, and the model wrote
# whole sentences back however the forms above were enumerated: a demonstration
# outweighs a list. So the examples now show a morpheme, a pair of words, and a
# whole sentence, with the rule for choosing between them.
_CITE_EXAMPLE = '''The dative suffix is what marks the relative noun:\n\n\
<cite doc="Text 1" ref="s32.w2.m3"/>\n\nwhile in <cite doc="Text 1" ref="s34.w2,w5"/> neither argument \
carries it. Name the sentence alone, <cite doc="Text 1" ref="s41"/>, only where the claim is about the \
whole sentence.'''

#: The bullets of the chat's prompt that assume a person is there, which an
#: unattended job's prompt leaves out or says its own way (``job_parts``).
_OPEN_DOCUMENT = '''- The open document is a whole text, not a sentence, and the user is not pointing at any sentence \
in it. A request that names a word or morpheme by its place ("the third word") or by a form the text holds more \
than once, and names no sentence, does NOT mean sentence 1: ask which sentence they mean, and plan nothing, rather \
than picking one.'''
_CITE_ITEMS = '''- When you show examples of a planned change, cite the item it writes: sN.wN.mN for a morpheme's \
field, sN.wN for a word's.'''
_JOBS = '''- A JOB LEFT TO RUN. When the user wants work done without them, lead to a job card drafted with \
propose_job, not to a plan of changes. In order:
1. Read what they ask the job to do, and on which documents: call propose_job with action "facts" and those \
documents, and read the documents.
2. If what they ask needs no change to the documents (a question, a count, a list, a check), answer it here from \
what you read, and draft a job only if they ask for one.
3. Tell them how much is empty of what they asked for. Of everything else the facts list as empty, ask whether the \
job should fill it too. Never assume: a field they did not name goes on the card only once they say yes to it, \
whatever a guideline derives from what they asked for. Ask in the same message the two or three questions the \
data shows matter: a form people analysed in two ways, sentences with no word breaks, documents already partly \
glossed, a field the job would fill from a tagset. A reply that asks a question drafts no card: wait for the answer.
4. If the job would change values the facts count as people's, say before you draft how many such values those \
fields hold, and that a job writes unverified machine values, so each one it changes becomes unverified. For an \
exact change they dictate (one spelling or value for another), say in one sentence that an ordinary plan in this \
chat, approved as verified, keeps them verified, and let them choose. Offer a plan for the first few sentences: \
what the user approves as verified or corrects by hand becomes people's analyses, which the job follows.
5. When they say go, draft it with action "draft", with exactly the fills they agreed to, edits_text true only \
when they agreed the job may change the text itself, and only_new true when they ask it to fill only the words it \
adds, such as "gloss only the new word": a respelled word is not an added word. Stage a plan of changes for it \
only when they chose one in step 4.
The brief states the decisions, not the discussion, in imperative sentences that name forms and glosses exactly, \
for a model that sees nothing else. A convention about the language rather than this job belongs in the \
guidelines: offer to write it there. For example, asked to gloss Texts 3 to 9 overnight, you read them, found -da \
glossed LOC 12 times and 3SG 4 times, and asked which applies where and whether to try sentences 1 to 3 first. \
Told "LOC after nouns, 3SG after verbs, just go", you drafted the brief "Gloss -da as LOC after a noun and as 3SG \
after a verb." A job writes its changes as it goes, as unverified machine values, and the whole job can be undone: \
never call them proposals for the person to check, or say they are staged.
- WHAT A JOB DID. A job's record (read_job) holds what it did, the model's note on each part, and nothing \
more of why: tell the user what it did from the record. Its report is as the job ended, so read the \
documents as they are now before you plan a change from it.'''

_PROJECT_WIDE = '''- Reach for a project-wide tool (set_field_for_form, replace_in_field, set_analysis_for_form, \
respell_all, copy_to_orthography) rather than many single calls.'''
_LEXICON_TREE = '''A lexicon's entries form a TREE: a HEADWORD is an entry with nothing above it, a SENSE one \
under another, and the tools that move entries around work on that structure, never on a field. When no tool \
can express a question, read query_help and write a query.'''
#: A project-wide rule is checked under no one document's lock, so a job
#: lists it as a proposed change (igt/jobapply.py).
_JOB_PROJECT_WIDE = '''- A project-wide tool (set_field_for_form, replace_in_field, respell_all, copy_to_orthography) stages a \
rule, which a job lists as a proposed change and never applies: stage changes item by item where they are to be \
applied. set_analysis_for_form stages a change at every occurrence: those in your piece's document are applied, \
the others listed as proposed changes.'''

_READ_FIRST = '''- Use the tools rather than guessing. Read before you write: check analyses_of and the lexicon before \
proposing glosses, and follow the conventions already in the data (gloss abbreviations, capitalization, morph \
types, orthography).'''
#: The same bullet for a piece of a job planned in sentences, whose message
#: holds what the bullet above sends the model to read (igt/evidence.py), by
#: what the job's plan fills (igt/targets.py): segmentation, only fields, or
#: nothing. Each names only tools such a piece is offered.
_JOB_SENTENCES_READ_FIRST = '''- The message says what is empty in your piece, how those forms were analysed and the \
lexicon entries in them. Stage the words to segment with analyze_sentence first, and look \
up only what its answer lists as several or none.'''
_JOB_FIELDS_READ_FIRST = '''- The message says what is empty in your piece, and the values those fields hold on \
other words or morphemes of the same forms. Fill what is empty with set_field.'''
_JOB_NOTHING_READ_FIRST = '''- Use the tools rather than guessing, and follow the conventions already in the data.'''
#: The bullet of a job that fills orthographies only, whose message holds no
#: evidence (REV-DF3-8).
_JOB_ORTHOGRAPHY_READ_FIRST = '''- The message says what is empty in your piece. Fill what is empty with \
set_orthography.'''
#: The bullet of a job that segments and does not gloss (REV-DF-D-10):
#: analyze_sentence takes a gloss for every word, set_analysis forms alone.
_JOB_SEGMENTS_READ_FIRST = '''- The message says what is empty in your piece, how those forms were analysed and the \
lexicon entries in them. Segment each word with set_analysis, giving its morphemes' forms and only the values the \
job fills.'''

#: set_field and set_analysis, as set_analysis's own description has it
#: since KM (REV-DAY-P-9).
_ONE_VALUE = '''- set_field changes one field value (a gloss, a part of speech, a translation) and leaves everything else \
alone. set_analysis (re)segments a word: given the word's morphemes as they are, only the values that differ are \
written, otherwise it replaces the whole chain, so change a single value with set_field.'''
#: The same for a piece in sentences whose plan does not segment: it has no
#: set_analysis.
_ONE_VALUE_FIELDS = '''- set_field changes one field value and leaves everything else alone.'''
#: The lexicon's shape for a piece in sentences, which moves no entry and
#: writes no query.
_SENTENCES_LEXICON_TREE = '''- A lexicon's entries form a TREE: a HEADWORD is an entry with nothing above it, a SENSE \
one under another.'''

_FIND_SUBJECT = 'item (worklist, search, frequency_list)'
_USER_VALUE_KINDS = 'a gloss, a form, a part of speech, a translation'

_CHAT = {
    'plan_contract': shared.plan_contract(),
    'project_shape': shared.project_shape(),
    'how_to_work': shared.how_to_work(),
    'read_first': _READ_FIRST,
    'open_document': _OPEN_DOCUMENT,
    'cite_items': _CITE_ITEMS,
    'jobs': _JOBS,
    'project_wide': _PROJECT_WIDE,
    'lexicon_tree': _LEXICON_TREE,
    'find_first': shared.find_first(_FIND_SUBJECT, '"the word ka", "the second word"'),
    'stage_now': shared.stage_now(),
    'plan_what_was_asked': shared.plan_what_was_asked(),
    'user_values': shared.user_values(_USER_VALUE_KINDS),
    'one_value': _ONE_VALUE,
    'one_turn': shared.one_turn(),
    'in_stretches': shared.in_stretches(
        'segmenting and glossing, marking every noun phrase, a field on every word',
        ' (a free translation, a note)',
        'replace_in_field, set_field_for_form, set_analysis_for_form, respell_all, confirm'),
    'final_message': shared.final_message('items'),
    'turn_example': shared.turn_example(
        '"gloss this text" of a text of 20 sentences',
        'read sentences 1 to 5 and how their forms were analysed elsewhere, then staged one analyze_sentence call per '
        'sentence',
        '58 changes',
        'Sentences 1 to 5 are segmented and glossed: the plan holds 58 changes, 31 words and 27 links. '
        'The gloss of the last word of sentence 3 is a guess. The text has 20 sentences, more than I do at once: '
        'approve this plan, then ask me to go on with sentences 6 to 10. Nine of these words have no lexicon '
        'entry, and I can link them if you want.'),
    'read_budget': shared.read_budget('search, concordance, frequency_list, worklist or check_consistency'),
    'be_concise': shared.be_concise(),
    'copy_forms': shared.copy_forms(),
    'attach_files': shared.attach_files('.flextext, .eaf, .lift'),
    'cite_evidence': shared.cite_evidence(
        refs=_CITE_REFS, aside=_CITE_ASIDE, shown_as='full interlinear example',
        never_paste='interlinear lines or tables of glosses', example=_CITE_EXAMPLE),
}
SYSTEM = shared.filled(_SYSTEM, _CHAT)

_CODE_TRIGGERS = 'two fields at once, a condition on a word and its morphemes together'
_CODE_OUTRIGHT = 'search, concordance, frequency_list, worklist or check_consistency'
_CODE_READS = (' Before that, read_sentences reads chosen sentences of several documents in one call, and fields= '
               'on it and on read_document keeps only the fields the question needs.')
CODE = shared.code_section(triggers=_CODE_TRIGGERS, outright=_CODE_OUTRIGHT, functions=', lexicon()',
                           reads=_CODE_READS)

WEB = webtools.prompt(
    'what a gloss abbreviation conventionally means, how a construction is described in related '
    'languages or in the literature, a reference for a claim',
    'Citation tags are for project sentences only. Link a web source as ordinary Markdown.')


def lexicon_focus_note(name: str) -> str:
    """What to add to the prompt when the user has one vocabulary open.

    The same shape as the document note in `core/service.py`, and for the same
    reason: a first version that named the thing once and then invited the model
    to read anything else sent it off across the project. Named twice, with the
    escape conditional and last.

    Corpus reads are NOT the escape here. Half the useful questions about an
    entry ("is this gloss what the texts actually say") are answered by reading
    the corpus, so that is stated as part of the job rather than left to be
    inferred against the rest of the note.
    """
    return (f'The user has the vocabulary "{name}" open and is asking about the entries in front of '
            f'them. Unless they name another vocabulary, this question is about "{name}": read it '
            f'first, and take a bare form, or a form with a number like gam#1, as an entry in it. '
            f'Reading the corpus to see how an entry is really used is part of answering here. '
            f'Open another vocabulary only when the question names it or asks you to compare.')


def shape_lines(project: IgtProject, max_tagset_values: int = PROMPT_TAGSET_VALUES, tagset_lead: str = TAGSET_LEAD,
                tagset_more: str = TAGSET_MORE) -> list:
    """The project's shape as the prompt states it: its fields, its tagsets,
    its orthographies and its lexicons. The whole prompt says it of the
    project the user is in, and a turn that may read other projects says it
    of each of them too, more briefly. A job's prompt words the tagsets'
    lead line and their cut for a job (``tagset_lead``, ``tagset_more``)."""
    lines = []
    for scope in SCOPES:
        fs = project.fields_by_scope(scope)
        if fs:
            lines.append(f'- {scope} fields: ' + ', '.join(f.name for f in fs))
    if not project.morpheme_layer_id:
        lines.append('- No morpheme layer (words cannot be segmented here).')
    for i, line in enumerate(tagset_lines(project, max_values=max_tagset_values, lead=tagset_lead, more=tagset_more)):
        lines.append(('- ' if i == 0 else '') + line)
    lines.append('- Orthographies: ' + (', '.join(project.orthographies) or 'none'))
    lines.append('- Lexicons: ' + (', '.join(lexicon_label(v) for v in project.vocabs) or 'none'))
    return lines


def project_brief(project: IgtProject) -> str:
    """Another project's shape, for a turn that may read it."""
    return '\n'.join(shape_lines(project, BRIEF_TAGSET_VALUES))


def build_system_prompt(project: IgtProject, web: bool = False) -> str:
    lines = shape_lines(project)
    # The chat says what the baseline and an orthography are, under the
    # orthographies, for a person who asks why an orthography's row is empty.
    at = next(i for i, line in enumerate(lines) if line.startswith('- Orthographies: '))
    lines.insert(at + 1, '  ' + ORTHOGRAPHIES_NOTE)
    # Not str.format: field and layer names in the shape may contain braces.
    # The number the overview really shows, before the project's own text goes
    # in: written out as a word here, the prompt promised a hundred documents
    # after the overview moved to fifty.
    out = SYSTEM.replace('{overview_docs}', str(OVERVIEW_DOCS))
    out = out.replace('{project_name}', project.name).replace('{shape}', '\n'.join(lines))
    # Not str.format here either, and for a sharper reason than the layer
    # names above: a guideline body is prose someone typed, and prose has
    # braces in it.
    out = out.replace('{guidelines}', guidelines_section(project.guidelines))
    out = out + WEB if web else out
    return out + CODE if sandbox.available() is None else out


# --- the unattended job's prompts -----------------------------------------------
# A job is the assistant, unattended (the owner's ruling 12 of 2026-11-13). A
# piece of a job is given THIS prompt, the chat's, its shared rules word for
# word, with the paragraphs that assume a person present put the job's way
# (core.prompt's JOB_* paragraphs): one source for the rules, no second copy.
# One worked piece in place of rules about turns, its calls told in prose,
# never as call syntax, which small models copy out as text.

_JOB_EXAMPLE_DID = (
    'The message showed s4 and s5 as context and s6 and s7 as your piece, and the instructions said to segment '
    'and gloss the words nobody analysed and to translate empty translations. It showed that people analysed '
    '"leo" as le-o \'today-DEF\' twice. Nothing settled "na", so you read the concordance of "na" and saw it '
    'before verbs glossed PRS in four sentences. You staged one analyze_sentence for s6 with w1 as na-ku-ja (prefix '
    'PRS, prefix INF, stem come) and w3 as le-o as people have it, and set the translation of s7. You left w2 '
    'of s7, a name you could not place.')
_JOB_EXAMPLE_NOTE = 'Glossed s6 and translated s7. Left s7.w2, a name nobody has glossed.'
#: The worked piece of a piece planned in sentences: what settled "na" was
#: in its message, not a read.
_JOB_SENTENCES_EXAMPLE_DID = _JOB_EXAMPLE_DID.replace(
    'Nothing settled "na", so you read the concordance of "na" and saw it before verbs glossed PRS in four '
    'sentences.', 'It listed the entries na \'PRS\' and ku \'INF\'.')
assert _JOB_SENTENCES_EXAMPLE_DID != _JOB_EXAMPLE_DID


def _job_segments_example(gloss: bool, sentence: Optional[str]) -> tuple:
    """The worked piece and note of a piece in sentences of a job that
    segments, built from what its plan fills (REV-DF-D-10, one prompt, parts
    by target kind): glossing too (``gloss``: the morpheme field the
    configuration pairs with the lexicon's gloss is a target) or segmenting
    alone, and a sentence level target, the translation (``sentence``
    "translation", by the configuration's role) or another ("field")."""
    task = 'segment and gloss the words nobody analysed' if gloss else 'segment the words nobody analysed'
    task += {'translation': ' and to translate empty translations', 'field': ' and to fill an empty sentence field',
             None: ''}[sentence]
    then = {'translation': ', and set the translation of s7', 'field': ', and set that field on s7', None: ''}[sentence]
    if gloss:
        staged = ('It showed that people analysed "leo" as le-o \'today-DEF\' twice. It listed the entries na '
                  '\'PRS\' and ku \'INF\'. You staged one analyze_sentence for s6 with w1 as na-ku-ja (prefix PRS, '
                  'prefix INF, stem come) and w3 as le-o as people have it')
    else:
        staged = ('It showed that people analysed "leo" as le-o twice. You staged set_analysis for s6.w1 as na-ku-ja '
                  'and for s6.w3 as le-o as people have it')
    did = (f'The message showed s4 and s5 as context and s6 and s7 as your piece, and the instructions said to {task}. '
           f'{staged}{then}. You left w2 of s7, a name you could not place.')
    done = ('Glossed s6' if gloss else 'Segmented s6') + {'translation': ' and translated s7', 'field': ' and filled s7',
                                                          None: ''}[sentence]
    note = f'{done}. Left s7.w2, a name nobody has {"glossed" if gloss else "analysed"}.'
    return did, note


assert _job_segments_example(True, 'translation') == (_JOB_SENTENCES_EXAMPLE_DID, _JOB_EXAMPLE_NOTE)
#: The worked piece of a piece in sentences of a job that fills fields only.
_JOB_FIELDS_EXAMPLE_DID = (
    'The message showed s4 and s5 as context and s6 and s7 as your piece, and the instructions said to fill a word '
    'field. It named the words of s6 and s7 empty in that field, and showed that people gave "leo" the value N in '
    'twelve words. You set the field on s6.w1 and s6.w3 with set_field, "leo" as people have it, and on s7.w1. You '
    'left s7.w2, a name you could not place.')
_JOB_FIELDS_EXAMPLE_NOTE = 'Filled the field in s6 and s7. Left s7.w2, a name nobody has a value for.'
#: The worked piece of a piece in sentences of a job that fills orthographies only.
_JOB_ORTHOGRAPHY_EXAMPLE_DID = (
    'The message showed s4 and s5 as context and s6 and s7 as your piece, and the instructions said to write each '
    'word in an orthography. It named the words of s6 and s7 empty in it. You wrote s6.w1, s6.w2, s6.w3 and s7.w1 '
    'with set_orthography. You left s7.w2, a name you could not place.')
_JOB_ORTHOGRAPHY_EXAMPLE_NOTE = 'Wrote the orthography in s6 and s7. Left s7.w2, a name with no agreed spelling.'
#: The worked piece of a piece in sentences of a job that fills nothing.
_JOB_NOTHING_EXAMPLE_DID = (
    'The message showed s6 and s7 as your piece, and the instructions said to correct a field where it disagrees '
    'with the guidelines. You read each value, found two that disagree, and set them with set_field on s6.w1 and '
    's7.w3. You left the rest as they were.')
_JOB_NOTHING_EXAMPLE_NOTE = 'Corrected s6.w1 and s7.w3. The other values follow the guidelines.'

_JOB = {
    **_CHAT,
    'plan_contract': shared.job_contract(),
    'open_document': '',
    'cite_items': '',
    'jobs': '',
    'project_wide': _JOB_PROJECT_WIDE,
    'find_first': shared.job_find_first(_FIND_SUBJECT),
    'stage_now': shared.job_stage_now(),
    'plan_what_was_asked': shared.job_plan_what_was_asked(),
    'user_values': shared.job_values(_USER_VALUE_KINDS),
    'one_turn': '',
    'in_stretches': '',
    'final_message': shared.job_note(),
    'turn_example': shared.job_example(_JOB_EXAMPLE_DID, _JOB_EXAMPLE_NOTE),
    'attach_files': '',
    'cite_evidence': '',
}

#: The prompt of a piece of a job, before the project is filled in: the
#: chat's template, the person's paragraphs put the job's way. Empty holes
#: leave no blank line.
JOB_SYSTEM = re.sub(r'\n{2,}(?=- |\Z)', '\n', shared.filled(_SYSTEM, _JOB)).rstrip('\n') + '\n'


def _sentences_system(read_first: str, did: str, note: str, one_value: str = _ONE_VALUE,
                      evidence: bool = True) -> str:
    """The prompt of a piece in sentences, built from its own parts: none
    names a tool such a piece is not offered (REV-DAY-P-8: no find or corpus
    reads, no project-wide tools, no entry moves or queries, no chat
    bullet), and its read-first bullet, worked example and set_field line
    follow what the plan fills. ``evidence``: its message holds evidence
    (a plan that fills something)."""
    out = re.sub(r'\n{2,}(?=- |\Z)', '\n', shared.filled(_SYSTEM, {
        **_JOB, 'read_first': read_first, 'turn_example': shared.job_example(did, note),
        'find_first': shared.job_find_first('item'), 'read_budget': '', 'project_wide': _SENTENCES_LEXICON_TREE,
        'lexicon_tree': '', 'be_concise': '', 'one_value': one_value})).rstrip('\n') + '\n'
    out = '\n'.join(line.rstrip() for line in out.split('\n'))
    if not evidence:
        assert shared.JOB_STAGE_EVIDENCE in out
        out = out.replace(shared.JOB_STAGE_EVIDENCE, '')
    return out


#: The prompt of a piece of a job planned in sentences, by what its plan
#: fills (BRIEF-EV, the owner's steer of 2026-11-15): two lines of JOB_SYSTEM
#: say what its message holds and how to stage from it.
JOB_SENTENCES_SYSTEM = _sentences_system(_JOB_SENTENCES_READ_FIRST, _JOB_SENTENCES_EXAMPLE_DID, _JOB_EXAMPLE_NOTE)
JOB_FIELDS_SYSTEM = _sentences_system(_JOB_FIELDS_READ_FIRST, _JOB_FIELDS_EXAMPLE_DID, _JOB_FIELDS_EXAMPLE_NOTE,
                                      _ONE_VALUE_FIELDS)
JOB_ORTHOGRAPHY_SYSTEM = _sentences_system(_JOB_ORTHOGRAPHY_READ_FIRST, _JOB_ORTHOGRAPHY_EXAMPLE_DID,
                                          _JOB_ORTHOGRAPHY_EXAMPLE_NOTE, _ONE_VALUE_FIELDS, evidence=False)
JOB_NOTHING_SYSTEM = _sentences_system(_JOB_NOTHING_READ_FIRST, _JOB_NOTHING_EXAMPLE_DID, _JOB_NOTHING_EXAMPLE_NOTE,
                                       _ONE_VALUE_FIELDS, evidence=False)


#: What a piece in sentences that fills an orthography is told in place of
#: its fields' line.
ORTHOGRAPHY_SAID = 'Fill what is empty with set_field.'
ORTHOGRAPHY_INSTEAD = 'Fill what is empty with set_field, and an orthography with set_orthography.'
assert ORTHOGRAPHY_SAID in _JOB_FIELDS_READ_FIRST


def job_segments_system(project: IgtProject, targets) -> str:
    """The prompt of a piece in sentences of a job that segments, its
    read-first bullet and worked piece by what else the plan fills: the
    gloss (the configuration's morpheme gloss field), a sentence level
    target (the translation by its role, or another). Glossing and
    translating is :data:`JOB_SENTENCES_SYSTEM` (REV-DF-D-10)."""
    ids = {t.id for t in targets}
    gloss_field, translation = project.gloss_field('Morpheme'), project.gloss_field('Sentence')
    gloss = gloss_field is not None and gloss_field.layer_id in ids
    sentences = [t for t in targets if t.scope == 'Sentence']
    sentence = None if not sentences else 'translation' if translation is not None and any(
        t.id == translation.layer_id for t in sentences) else 'field'
    if gloss and sentence == 'translation':
        return JOB_SENTENCES_SYSTEM
    did, note = _job_segments_example(gloss, sentence)
    return _sentences_system(_JOB_SENTENCES_READ_FIRST if gloss else _JOB_SEGMENTS_READ_FIRST, did, note)


#: The tagsets' first line in a job's prompt: nobody sees the value as the
#: job stages it, and an off-list one is stored as the job wrote it (SPEC 6.4).
JOB_TAGSET_LEAD = ('Tagsets: use the listed spellings, and write an unlisted value only where no listed one means '
                   'the same thing.')


def _filled(template: str, project: IgtProject) -> str:
    from ..core.guidelines import job_section
    out = template.replace('{project_name}', project.name).replace('{overview_docs}', str(OVERVIEW_DOCS))
    out = out.replace('{shape}', '\n'.join(shape_lines(project, tagset_lead=JOB_TAGSET_LEAD, tagset_more='')))
    return out.replace('{guidelines}', job_section(project.guidelines))


#: The code section of a job's contexts: the chat's, with the host functions
#: a job's code is lent (a job keeps no files, so no save_file), and for the
#: planning context, which stages nothing, no plan() (REV-JG-9).
JOB_CODE = shared.code_section(
    triggers=_CODE_TRIGGERS, outright=_CODE_OUTRIGHT, functions=', lexicon()', reads=_CODE_READS,
    sees='documents(), load(document), query(q), lexicon(), table(title, columns, rows) and plan(tool, ...), '
         'and stages changes only through plan(...), under the same guards.')
PLAN_CODE = shared.code_section(
    triggers=_CODE_TRIGGERS, outright=_CODE_OUTRIGHT, functions=', lexicon()', reads=_CODE_READS,
    sees='documents(), load(document), query(q) and lexicon(), and stages nothing.')


#: The line a job's piece is told that set_field and link_entry take many
#: items in one call (BRIEF SP item 2), after its set_field line: with
#: link_entry where the piece is offered it, else set_field's alone.
JOB_ITEMS_LINE = ('- set_field and link_entry take items: many values or many links in one call, each staged or '
                  'refused on its own.')
JOB_ITEMS_VALUES_LINE = '- set_field takes items: many values in one call, each staged or refused on its own.'


def with_items_line(out: str, project: IgtProject, sentences: bool, targets) -> str:
    """``out`` with :data:`JOB_ITEMS_LINE` (or the values' alone, for a
    piece in sentences not offered link_entry) after its set_field line."""
    from .toolkit import sentences_piece_tools
    linking = not sentences or 'link_entry' in sentences_piece_tools(targets, project)
    line = JOB_ITEMS_LINE if linking else JOB_ITEMS_VALUES_LINE
    said = next(x for x in (_ONE_VALUE, _ONE_VALUE_FIELDS) if x in out)
    return out.replace(said, said + '\n' + line, 1)


#: What a piece of a job whose plan does not edit the text is not told: the
#: tools it is not offered (toolkit.TEXT_TOOLS) and what they would write.
NO_TEXT_EDITS = (('deletions and text edits included', 'deletions included'),
                 ('confirmations, document restores, corpus-wide rules', 'confirmations, corpus-wide rules'),
                 ('replace_in_field, respell_all, copy_to_orthography', 'replace_in_field, copy_to_orthography'))


def build_job_prompt(project: IgtProject, sentences: bool = False, edits_text: bool = False, targets=None,
                     findings: bool = False) -> str:
    """The system prompt of every piece of a job on ``project``: the chat's
    prompt with the job's paragraphs, the project's shape and its guidelines
    whole, and the code section where the sandbox is. A piece of a plan in
    sentences (``sentences``) is told what its message holds and how to stage
    from it, by what the plan fills (``targets``, igt/targets.py): with
    segmentation, the analyses; fields only, set_field; nothing, neither. A
    piece of a plan that does not edit the text (``edits_text`` False) is
    told nothing of the tools it is not offered (:data:`NO_TEXT_EDITS`). A
    piece of a plan that fills nothing (``findings``) ends with its findings,
    the job's report, in place of a short note (RPF-A5)."""
    targets = list(targets or ())
    if not sentences:
        template = JOB_SYSTEM
    elif any(t.segments for t in targets):
        template = job_segments_system(project, targets)
    elif targets and all(t.orthography is not None for t in targets):
        template = JOB_ORTHOGRAPHY_SYSTEM
    else:
        template = JOB_FIELDS_SYSTEM if targets else JOB_NOTHING_SYSTEM
    out = _filled(template, project)
    if template is not JOB_ORTHOGRAPHY_SYSTEM and sentences and any(t.orthography is not None for t in targets):
        # The tool such a piece fills an orthography with (REV-DF-D-6).
        out = out.replace(ORTHOGRAPHY_SAID, ORTHOGRAPHY_INSTEAD)
    if findings:
        assert shared.JOB_NOTE in out
        out = out.replace(shared.JOB_NOTE, shared.JOB_FINDINGS_NOTE)
    if not edits_text:
        for said, instead in NO_TEXT_EDITS:
            # A piece in sentences is told of no project-wide tool at all.
            assert said in out or sentences, said
            out = out.replace(said, instead)
    out = with_items_line(out, project, sentences, targets)
    # A piece in sentences is not offered run_code (toolkit.sentences_piece_tools).
    return out + JOB_CODE + JOB_TABLES if sandbox.available() is None and not sentences else out


#: What a piece's code is told of ``table()``, only where code runs.
JOB_TABLES = ('''- A table code makes with table(title, columns, rows) is kept as data in the job's report, so a \
count or a finding is given by code and not retyped.
''')

#: How the planning context cuts the work, in the app's words.
JOB_PLAN_RULES = '''How to plan:
- pieces "sentences": a few sentences per piece, seeing the two before, for work that needs each sentence read, \
with only the tools to set values (and to segment, link and add entries when the job fills those), no search or \
code: each piece is handed how its words' forms were analysed before and the lexicon entries spelled in them. \
Every sentence, unless the job only fills what is empty: then skip_filled_sentences true. For work that \
concerns only the sentences where something occurs, give search the search tool's arguments: only the sentences it \
matches are worked. A plan in sentences makes at least one model call for each stretch the plan takes.
- pieces "document": one piece per document, seeing the whole document. For work about a whole text, such as \
a summary of each.
- pieces "selection": one piece for all the documents, reading them with the tools and code. For work across \
the documents, such as finding where they disagree, and for the same exact change wherever a known value occurs \
(one value for another): it finds them with search or code and stages each change, which is written in its \
document. Its findings go in its last message, which the report shows whole, and in tables code makes. Nothing \
more is worked after it: what it leaves empty stays empty.
- To fill what is empty word by word, plan "sentences": a piece has a fixed number of model calls, too few for a \
whole text.
- piece_instructions: only your decisions, as plain imperative sentences naming forms and values exactly. \
Pieces already have the project's guidelines and the job's instructions. Read the documents to decide.
- fills: what the instructions ask the job to fill or change, as listed under What a job can fill: the field \
of each kind of value they ask for, a word, morpheme or sentence field, and segmentation when words are to be cut \
into morphemes. [] for a check or a summary.
- edits_text: only when instructions ask to change the words or sentences themselves.
- A piece that edits the text is followed by one that fills what is empty in the sentences it changed.
- documents: leave it out for every document in the job's order.'''

#: The planning context's prompt: who it is, the project, and how to plan.
_PLAN_SYSTEM = '''You are the assistant inside Plaid IGT, a tool linguists use to build interlinear glossed text: \
sentences split into words, words into morphemes, with glosses and other fields at each level, a free \
translation per sentence, and a lexicon of entries that morphemes link to.

{plan_contract}

{project_shape}
{guidelines}

{plan_rules}
{read_budget}'''

PLAN_SYSTEM = shared.filled(_PLAN_SYSTEM, {
    'plan_contract': shared.JOB_PLAN_CONTRACT, 'project_shape': shared.project_shape(),
    'plan_rules': JOB_PLAN_RULES,
    'read_budget': shared.read_budget('search, concordance, frequency_list, worklist or check_consistency')})
JOB_PLAN_NOW = shared.JOB_PLAN_NOW


def build_plan_prompt(project: IgtProject) -> str:
    """The planning context's system prompt on ``project``."""
    out = _filled(PLAN_SYSTEM, project)
    return out + PLAN_CODE if sandbox.available() is None else out


_SUMMARY_SYSTEM = '''{summary_contract}

{project_shape}'''

SUMMARY_SYSTEM = shared.filled(_SUMMARY_SYSTEM, {'summary_contract': shared.JOB_SUMMARY_CONTRACT,
                                                 'project_shape': shared.project_shape()})


_FINDINGS_SYSTEM = '''{findings_contract}

{project_shape}'''

FINDINGS_SYSTEM = shared.filled(_FINDINGS_SYSTEM, {'findings_contract': shared.JOB_FINDINGS_CONTRACT,
                                                   'project_shape': shared.project_shape()})


def build_findings_prompt(project: IgtProject) -> str:
    """The system prompt of the context that makes one report of the
    findings of several pieces of a job that fills nothing (RPF-A5)."""
    return _filled(FINDINGS_SYSTEM, project)


def build_summary_prompt(project: IgtProject) -> str:
    """The final context's system prompt on ``project``."""
    return _filled(SUMMARY_SYSTEM, project)

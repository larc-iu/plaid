"""The system prompt.

The paragraphs that are not about interlinear text are `core.prompt`'s, named
below where they go: the plan contract, the staging rules, how to cite, and
what run_code is for. Everything here is IGT's own.
"""

from ..core import prompt as shared, sandbox, webtools
from ..core.guidelines import section as guidelines_section
from ..core.limits import OVERVIEW_DOCS
from .project import TAGSET_LEAD, TAGSET_MORE, IgtProject, SCOPES, lexicon_label, tagset_lines

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
- Use the tools rather than guessing. Read before you write: check analyses_of and the lexicon before \
proposing glosses, and follow the conventions already in the data (gloss abbreviations, capitalization, morph \
types, orthography).
- Address things positionally: sN (sentence), sN.wN (word), sN.wN.mN (morpheme), always together with the \
document. Numbers restart in every document and sentence. In what the reads print, a trailing ~ marks a value \
a machine made and a trailing ^ one a contributor made.
- The open document is a whole text, not a sentence, and the user is not pointing at any sentence in it. A \
request that names a word or morpheme by its place ("the third word") or by a form the text holds more than \
once, and names no sentence, does NOT mean sentence 1: ask which sentence they mean, and plan nothing, rather \
than picking one.
{find_first}
{stage_now}
{plan_what_was_asked}
{user_values}
- set_field changes one field value (a gloss, a part of speech, a translation) and leaves everything else alone. \
set_analysis rewrites a word's whole segmentation with all its morpheme values, so use it only to (re)segment a \
word, never to change a single gloss.
- When you show examples of a planned change, cite the item it writes: sN.wN.mN for a morpheme's field, sN.wN \
for a word's.
{one_turn}
{in_stretches}
{final_message}
{turn_example}
- A JOB LEFT TO RUN. When the user wants work done without them, scope it before you draft it with \
propose_job. Read the documents, then ask in one message the two or three questions the data shows matter: a \
form people analysed in two ways, sentences with no word breaks, documents already partly glossed, a field the \
job would fill from a tagset. Offer to analyse the first few sentences here as an ordinary plan: what the user \
approves or corrects becomes people's analyses, which the job follows. When they say go, draft it. The brief \
states the decisions, not the discussion, in plain imperative sentences that name forms and glosses exactly, for \
a model that sees nothing else. A convention about the language rather than this job belongs in the guidelines: \
offer to write it there. For example, asked to gloss Texts 3 to 9 overnight, you read them, found -da glossed \
LOC 12 times and 3SG 4 times, and asked which applies where and whether to try sentences 1 to 3 first. Told \
"LOC after nouns, 3SG after verbs, just go", you drafted the brief "Gloss -da as LOC after a noun and as 3SG \
after a verb."
- Reach for a project-wide tool (set_field_for_form, replace_in_field, set_analysis_for_form, respell_all, \
copy_to_orthography) rather than many single calls. A lexicon's entries form a TREE: a HEADWORD is an entry \
with nothing above it, a SENSE one under another, and the tools that move entries around work on that \
structure, never on a field. When no tool can express a question, read query_help and write a query.
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

SYSTEM = shared.filled(_SYSTEM, {
    'plan_contract': shared.plan_contract(),
    'project_shape': shared.project_shape(),
    'how_to_work': shared.how_to_work(),
    'find_first': shared.find_first('item (worklist, search, frequency_list)', '"the word ka", "the second word"'),
    'stage_now': shared.stage_now(),
    'plan_what_was_asked': shared.plan_what_was_asked(),
    'user_values': shared.user_values('a gloss, a form, a part of speech, a translation'),
    'one_turn': shared.one_turn(),
    'in_stretches': shared.in_stretches(
        'segmenting and glossing, marking every noun phrase, a field on every word',
        ' (a free translation, a note)',
        'replace_in_field, set_field_for_form, set_analysis_for_form, respell_all, confirm'),
    'final_message': shared.final_message('items'),
    'turn_example': shared.turn_example(
        '"gloss this text" of a text of 20 sentences',
        'read sentences 1 to 5 and how their forms were analysed elsewhere, then staged one set_analysis call per '
        'sentence',
        '5 changes',
        'Sentences 1 to 5 are segmented and glossed: the plan holds 5 changes, one per sentence, 31 words in all. '
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
})

CODE = shared.code_section(
    triggers='two fields at once, a condition on a word and its morphemes together',
    outright='search, concordance, frequency_list, worklist or check_consistency',
    functions=', lexicon()',
    reads=' Before that, read_sentences reads chosen sentences of several documents in one call, and fields= '
          'on it and on read_document keeps only the fields the question needs.')

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


# --- the unattended job's prompt ------------------------------------------------
# Written for the job (core.prompt.JOB_CONTRACT), not the chat prompt with
# paragraphs taken out. One worked stretch instead of rules about turns: a
# demonstration outweighs a list, which the cite examples above learned. The
# calls are narrated in prose, never written as call syntax, which small
# models copy out as text.

_JOB_SYSTEM = '''You are the assistant inside Plaid IGT, a tool linguists use to build interlinear glossed text: \
sentences split into words, words into morphemes, with glosses and other fields at each level, a free \
translation per sentence, and a lexicon of entries that morphemes link to.

{job_contract}

{project_shape}
{guidelines}

{job_rules}

What to stage:
{what_to_stage}

One message worked through, for example. {example}'''

# What to stage, a line per task (and the reads, for every job). A job is
# told only of the tasks it was asked and the tools it has (REV-J-B S3-4).
_STAGE_TRANSLATE = '- A target translation: set_field with the translation field on the sentence (sN).'
_STAGE_GLOSS = (
    '- Target words: one set_analysis call per sentence, with every target word of it in analyses. Give each '
    'word\'s morphemes in order, each with its form, its type (stem, root, prefix, suffix, enclitic, proclitic, ...) '
    'and the morpheme fields the project has, such as the gloss. The forms together spell the word. A word that is '
    'one morpheme is one morpheme with the whole word as its form.\n'
    '- A word field (sN.wN) of a target word is set only where it is empty.')
_STAGE_LINK = (
    '- Link each morpheme of the words you analyse to its lexicon entry with link_entry on sN.wN.mN. Where no '
    'entry has that form and gloss, create_entry makes one and link_entry links it by the entry_id it returns. '
    'create_entry refuses an entry that exists and names it: link that one instead. A form with its markers '
    '("na-") and without them ("na") is one form.')
_STAGE_READS = (
    '- The reads are there for what the message does not settle: analyses_of for a form\'s analyses across the '
    'project, concordance for a form\'s contexts, search, read_sentences for other sentences, lexicon_entry and '
    'read_lexicon for entries. Most messages need few of them.')


def _example(tasks) -> str:
    """One worked message for a job of ``tasks``, its calls told in prose."""
    gloss, link, translate = 'gloss' in tasks, 'link' in tasks, 'translate' in tasks
    if not gloss:
        return ('It shows s4 and s5 as context and s6 and s7 as targets, and the translations of both are '
                'targets. You read the sentences, see that s7 goes on from s6, set the translation of s6 and of s7 '
                'with set_field, and end with "Done."')
    targets = 'In s6 the words w1 "nakuja" and w3 "leo" are targets'
    targets += ', and the translation of s7 is a target.' if translate else '.'
    said = ('It says people analysed "leo" as le-o \'today-DEF\' twice, and that this job analysed "ja" as one '
            'stem \'come\'')
    said += ' and linked it to the entry ja.' if link else '.'
    staged = ('You then stage one set_analysis for s6 with w1 as na-ku-ja (prefix PRS, prefix INF, stem come) and '
              'w3 as le-o as people have it')
    if link:
        staged += (', link s6.w1.m3 to the entry ja and s6.w3.m1 to le, find no entry for the prefix "na-" glossed '
                   'PRS and create it and link s6.w1.m1 to it, leave "ku-" unlinked because two entries could be '
                   'meant')
    staged += ', set the translation of s7' if translate else ''
    return (f'It shows s4 and s5 as context and s6 and s7 as targets. {targets} {said} Nothing settles "na". You '
            f'read the concordance of "na" and see it before verbs glossed PRS in four sentences. {staged}, and end '
            'with "Done."')


def job_system(tasks) -> str:
    """The job's system prompt for a job of ``tasks``, before the project is
    filled in."""
    lines = ([_STAGE_TRANSLATE] if 'translate' in tasks else []) + ([_STAGE_GLOSS] if 'gloss' in tasks else []) \
        + ([_STAGE_LINK] if 'link' in tasks else []) + [_STAGE_READS]
    return shared.filled(_JOB_SYSTEM, {
        'job_contract': shared.job_contract(),
        'project_shape': shared.project_shape(),
        'job_rules': shared.job_rules(),
        'what_to_stage': '\n'.join(lines),
        'example': _example(tasks),
    })


#: The tagsets' first line in a job's prompt: nobody sees the value as the
#: job stages it, and an off-list one is stored as the job wrote it (SPEC 6.4).
JOB_TAGSET_LEAD = ('Tagsets: use the listed spellings, and write an unlisted value only where no listed one means '
                   'the same thing.')


#: Every task's prompt, the one the job's version is taken over.
JOB_TASKS = ('translate', 'gloss', 'link')
JOB_SYSTEM = job_system(JOB_TASKS)


def build_job_prompt(project: IgtProject, tasks=JOB_TASKS) -> str:
    """The system prompt of every stretch of a job of ``tasks`` on
    ``project``: the job's contract and rules, what to stage for those tasks
    alone, the project's shape and its guidelines, whole."""
    from ..core.guidelines import job_section
    out = job_system(tasks).replace('{project_name}', project.name)
    out = out.replace('{shape}', '\n'.join(shape_lines(project, tagset_lead=JOB_TAGSET_LEAD, tagset_more='')))
    return out.replace('{guidelines}', job_section(project.guidelines))

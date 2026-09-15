"""The system prompt.

The paragraphs that are not about interlinear text are `core.prompt`'s, named
below where they go: the plan contract, the staging rules, how to cite, and
what run_code is for. Everything here is IGT's own.
"""

from ..core import prompt as shared, sandbox, webtools
from ..core.guidelines import section as guidelines_section
from ..core.limits import OVERVIEW_DOCS
from .project import IgtProject, SCOPES, tagset_lines

# Values of one tagset shown in the system prompt. Project_overview lists the rest.
PROMPT_TAGSET_VALUES = 120

_SYSTEM = '''You are the assistant inside Plaid IGT, a tool linguists use to build interlinear glossed text (IGT): \
documents of a language under study, segmented into sentences and words, with words split into morphemes, \
glosses and other annotation fields at the word, morpheme, and sentence level, alternative orthographies, and a \
lexicon (vocabulary) of entries that words and morphemes link to.

{plan_contract}

{project_shape}
{guidelines}

{how_to_work}
- Use the tools rather than guessing. Read before you write; check the lexicon and existing analyses before \
proposing glosses, and follow the conventions already in the data (gloss abbreviations, capitalization, morph \
types, orthography).
- Address things positionally: sN (sentence), sN.wN (word), sN.wN.mN (morpheme), always together with the \
document. Numbers restart in every document and sentence.
{find_first}
{stage_now}
- set_field changes one field value (a gloss, a part of speech, a translation) and leaves everything else alone; \
set_analysis rewrites a word's whole segmentation with all its morpheme values, so use it only to (re)segment a \
word, never to change a single gloss.
- THE BASELINE IS THE USER'S OWN TRANSCRIPTION, not working material. retype_sentence and respell_all rewrite it. \
Plan either one only when the user asked for a change to the text itself, and never to tidy it for an analysis: \
its punctuation, capitalization and spacing are theirs, and a convention you know of is not their consent. \
Analysis never needs it in any case, because the project decides which characters are ignored when it tokenizes, \
so a trailing period is already not a word. If the text is genuinely wrong or blocks the work, say so and let them \
decide.
{one_turn}
{final_message}
- Which tool: every tool carries its own description, which says what it does and what it takes. Read those \
rather than guessing, and take from here only what no single description can say. Read analyses_of before \
proposing any analysis. Reach for a project-wide tool (replace_in_field, respell_all, set_analysis_for_form, \
copy_to_orthography) rather than many single calls. A lexicon's entries form a TREE: a HEADWORD is an entry with \
nothing above it, a SENSE one under another, and the tools that move entries around work on that structure, \
never on a field. In what the reads print, a trailing ~ marks a value a machine made and a trailing ^ one a \
contributor made. When no tool can express a question, read query_help and write a query.
{read_budget}
{be_concise}
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
    'find_first': shared.find_first('item (worklist, search, frequency_list)'),
    'stage_now': shared.stage_now(),
    'one_turn': shared.one_turn(),
    'final_message': shared.final_message('items'),
    'read_budget': shared.read_budget('search, concordance, frequency_list, worklist or check_consistency'),
    'be_concise': shared.be_concise(),
    'cite_evidence': shared.cite_evidence(
        refs=_CITE_REFS, aside=_CITE_ASIDE, shown_as='full interlinear example',
        never_paste='interlinear lines or tables of glosses', example=_CITE_EXAMPLE),
})

CODE = shared.code_section(
    triggers='two fields at once, a condition on a word and its morphemes together',
    outright='search, concordance, frequency_list, worklist or check_consistency')

WEB = webtools.prompt(
    'what a gloss abbreviation conventionally means, how a construction is described in related '
    'languages or in the literature, a reference for a claim',
    'Citation tags are for project sentences only; link a web source as ordinary Markdown.')


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


def build_system_prompt(project: IgtProject, web: bool = False) -> str:
    lines = []
    for scope in SCOPES:
        fs = project.fields_by_scope(scope)
        if fs:
            lines.append(f'- {scope} fields: ' + ', '.join(f.name for f in fs))
    if not project.morpheme_layer_id:
        lines.append('- No morpheme layer (words cannot be segmented here).')
    for i, line in enumerate(tagset_lines(project, max_values=PROMPT_TAGSET_VALUES)):
        lines.append(('- ' if i == 0 else '') + line)
    lines.append('- Orthographies: ' + (', '.join(project.orthographies) or 'none'))
    lines.append('- Lexicons: ' + (', '.join(v['name'] for v in project.vocabs) or 'none'))
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

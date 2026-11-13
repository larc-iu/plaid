"""The paragraphs of a system prompt that every app's assistant says.

An assistant's system prompt is one document, and most of it is about the
harness rather than about what the app annotates: that a plan is staged and
approved rather than written, that a plan lives for one turn, what a citation
tag does, what ``run_code`` sees and what it is not for. Each of those was
written twice, once per app, and the two copies drifted: a sentence added to
one prompt after a session went wrong was never added to the other, and
nothing said so.

So each shared paragraph is ONE function here, and an app's prompt names it
where that paragraph goes. Where the two apps really do differ, the difference
is a parameter, and the function's docstring says what belongs in it: the
noun for what a change touches, the tag syntax for what the app addresses,
what a citation is drawn as. Nothing here may say what an app annotates (see
``tests/test_core_boundary.py``), so a paragraph that cannot be written
without the app's own words is the app's own paragraph and stays there.

Every function returns text with no trailing newline, ready to be joined the
way the app's prompt joins its paragraphs and bullets.
"""

import re
from typing import Mapping, Sequence

from .limits import OTHER_PROJECT_CHARS, STRETCH_SENTENCES

# The contract the user reads the plan card under, which is the harness's and
# not any app's. ``{project_name}`` is filled in when the prompt is built.
PLAN_CONTRACT = '''You work for the person chatting with you, on the project "{project_name}". You can read the \
whole project and you can PLAN changes. A plan is not applied by you: it goes back to the user as a list of \
concrete changes they approve or discard. Nothing is written until they approve. When they approve, the user \
chooses whether the changes are recorded as verified or as unverified proposals. Where the project reviews \
that user's work, what they approve as verified is their own contribution awaiting a reviewer.'''

# The project's own shape, rendered by the app and filled in when the prompt
# is built.
PROJECT_SHAPE = '''Project shape:
{shape}'''

HOW_TO_WORK = 'How to work:'

FIND_FIRST = '''- For bulk edits, first find every affected {subject}, then plan the changes. Where the request is \
ambiguous about what to change, ask before planning. Where ONE thing the user names ({one}) matches more than \
one where they point, or nothing says where (no sentence named), ask which one, list the candidates with their \
references, and plan nothing. Where values differ only by convention (dots, spaces, underscores, case), ask \
which form is the convention. Change them all only where the user said all.'''

STAGE_NOW = '''- Once the request is clear, STAGE the changes with the plan tools in this turn. The staged plan is \
what the user confirms, with Approve and Discard on its card, so stage first rather than asking in chat, and \
stage now what you would otherwise promise for a later step. The one exception is the rest of a request done \
in stretches (WORK IN STRETCHES), which waits until the user asks you to go on in a later message.'''

# Asked to rename a value, a model also changed an entry and drafted a
# guideline, and asked to fill 49 values, it also staged 49 links: the card is
# approved whole, so what nobody asked for rides on what they did
# (FABLE-REVIEW 2026-11-12).
PLAN_WHAT_WAS_ASKED = '''- PLAN WHAT WAS ASKED, and offer the rest. The plan holds the changes the user asked for, \
in the fields and levels they named. Anything more you notice (a link, another field, an entry, a \
guideline, the same fix elsewhere) goes in your reply as an offer, for them to ask for in their next message.'''

# Three of the benchmark's model errors of 2026-10-08 followed the data over
# the request: the aspect of a similar sentence for the one the user named,
# a spelling from elsewhere in the corpus for the one the user gave.
USER_VALUES = '''- WHAT THE USER STATES WINS. A value the user gives ({examples}) is the value to plan, even \
where the corpus does it differently or a similar case suggests another: their statement is the decision, and \
the data is what it changes. Where the data disagrees, plan what they said and mention the difference.'''

READ_BUDGET = '''- Do NOT read a document to answer something {tools} can answer: those ask the whole project \
at once, and reading documents one by one to count something will run out of tool calls long before it runs \
out of corpus.'''

# What waiting_note, plan_status and discard_plan say at the moment it
# matters is the rest of this (FABLE-REVIEW 2026-11-12).
ONE_TURN = '''- A plan lives for ONE turn. Staging anything while a plan from an earlier message still waits \
REPLACES that plan: to add to it, ask the user to approve it first, and to change it (leave a change out, \
another value, narrower), stage the whole corrected plan in this message.'''

# Asked to analyse a whole story at once, the model reasoned over every
# sentence in one call until its output cap, four times running, and then
# wrote one sentence 1,635 times (PROD-LOOP, 2026-11-10). The owner's rule
# (2026-11-11): do a first stretch, say so, and offer the next, each approved
# before the next is staged. What counts (REV-PB-C-3): anything judged word by
# word, even from a list the user gives ("given, accessible or new" on every
# noun phrase, the request that failed). About 5 sentences, read and decided
# alone (BENCH-STRETCH: asked for 10, glm-5.3-flash read all 20 and once ran
# out of reasoning). The turn ends once the first stretch is staged, since a
# run went on through all 20 (BENCH-STRETCH-2), and the same value on
# everything one search finds is staged whole, since 3 of 6 runs of two
# sweeps stopped after five sentences (FX-STRETCH). Narrowed and cut to its
# rule (FABLE-REVIEW 2026-11-12): the paragraph was 195 words of exceptions to
# exceptions, and the reply it scripted ("once they approve this plan") was
# written by a model that had staged nothing. That cut lost "read ONLY those
# sentences, not the whole document", and 8 of 9 runs then read all 20
# sentences before staging 5, the deciding call back to 23,409 reasoning
# tokens of a 32,768 cap (bench glm53-stretch-3). Put back in the rule: the
# whole read was each run's first call, so no tool result could say it first.
IN_STRETCHES = '''- WORK IN STRETCHES. Work you judge word by word ({full}), even picking from a list the user \
gives, is done about {n} sentences at a time: read ONLY the first {n} or so, not the whole document, decide and \
stage them, then end your turn and offer to go on. Done whole: the same value on everything one search finds, one call over \
many sentences ({bulk}), one value per sentence{light}, and questions.'''

# A reply claimed a staged plan in a turn that had staged nothing: the model
# read, reasoned, and wrote the reply the stretch rule scripted (bench
# glm53-stretch-2, the stretch task's rep 1). Every tool result now
# ends with the plan's state (PLAN_LINE), and the reply is taken from it.
# "Nothing is written until the user approves" went: the plan contract says
# it, and the stretch rule's words came out of it (bench glm53-stretch-3).
FINAL_MESSAGE = '''- The reply the user reads is your LAST message of the turn: text beside a tool call goes into \
folded steps they may never open. It answers every question of the turn, with its numbers. It reports the plan \
as the last tool result states it: how many {noun} it touches, what it does and anything uncertain, or that \
nothing is planned.'''

# One whole turn, narrated, with the reply it ends in. The prompt said in four
# places what a turn must not be and never showed one, where for citations a
# demonstration was what worked (FABLE-REVIEW 2026-11-12). The calls are told
# in prose: a model shown call syntax writes calls out as text.
TURN_EXAMPLE = '''- A WHOLE TURN, FOR EXAMPLE. Asked {asked}, you {did}. The last result ended \
"[Plan of this turn: {held}.]", and you replied:\n\n{reply}'''

BE_CONCISE = '''- Be concise and concrete. Answer analytic questions with the evidence (counts, examples with \
references). Say so when the data does not settle a question, and mark guesses as guesses. Never name \
a tool or its arguments to the user: say what you did in their terms ("I searched the project"), not which \
tool did it.'''

# A model writes a letter of a rare script as two tokens and can get the first
# one wrong, so a Wancho word came out as Egyptian hieroglyphs. core/garble.py
# refuses such a value in a plan and its refusal says how to copy it, so the
# rule here is as narrow as that guard (FABLE-REVIEW 2026-11-12: the wider rule
# sent a model to code to copy one word the user had typed).
COPY_FORMS = '''- A letter of a rare script that you type can come out as another script. A plan refuses a value \
whose rare letters appear nowhere you could have copied them from, and the refusal says how to copy it.'''

# Said in every turn, attachment or none: the file tools and the note arrive
# only with a file, so a model told nothing else answers "I can't accept file
# uploads" to a user asking whether it can. ``{formats}`` are the app's own
# exchange formats. The note that comes with a file says the rest.
ATTACH_FILES = '''- The user can attach files with the paperclip in the composer (tables, text, the app's own formats \
({formats}), PDFs with a text layer), and paste text. A whole corpus in one of the app's formats goes in \
through the app's import screen, not a plan.'''

CITE_EVIDENCE = '''- CITE EVIDENCE. Where a claim rests on particular sentences, cite them with a tag: {refs} \
The doc attribute is the document name exactly as the tools print it{aside}. The user sees each citation as \
the {shown_as}, linked to the editor, so cite rather than pasting {never_paste}. Put the tag ALONE on its own \
line where you would show an example, and always give doc, as here:\n\n{example}'''

# Appended to an app's system prompt only where the sandbox binary is there,
# like the web half: a model that cannot run code is never told that it can.
# The rest is in run_code's and code_help's descriptions.
CODE = '''
Running code:
- run_code runs Python over the project in ONE call, for a loop, a join or a tally the reads do not give \
directly: {triggers}, a count under your own definition, anything across more than a handful of \
documents.{reads} Not for what {outright} answer outright. It sees {sees}
'''

#: What the chat's code sees: its host functions, and how it stages.
CODE_SEES = '''documents(), load(document), query(q){functions}, plan(tool, ...) and save_file(name, content), \
and stages changes only through plan(...), under the same guards.'''

# A hole the prompt keeps until the project is known, so `filled` does not
# call it a paragraph nobody wrote. `guidelines` is one of them because a
# project's manual is read at the same moment its shape is.
_LATE = ('project_name', 'shape', 'overview_docs', 'guidelines')
_HOLE = re.compile(r'\{([a-z_]+)\}')


def filled(template: str, parts: Mapping[str, str], late: Sequence[str] = _LATE) -> str:
    """``template`` with each named paragraph in place of its ``{name}``.

    A ``{name}`` nobody fills, other than the ones ``late`` says are filled
    when the prompt is built, is a typo: without this it reaches the model as
    a brace in the middle of a sentence, which no test reads and no reader of
    the prompt file would see."""
    out = template
    for name, text in parts.items():
        out = out.replace('{' + name + '}', text)
    missing = sorted(set(_HOLE.findall(out)) - set(late))
    if missing:
        raise ValueError(f'the prompt has no text for {missing}')
    return out


def plan_contract() -> str:
    """What a plan is and what approving one writes. The same in every app,
    because it is the harness's contract rather than the app's."""
    return PLAN_CONTRACT


def project_shape() -> str:
    """The heading the app's own rendering of the project goes under."""
    return PROJECT_SHAPE


def how_to_work() -> str:
    """The heading the working rules go under."""
    return HOW_TO_WORK


def find_first(subject: str, one: str) -> str:
    """Find everything a bulk edit reaches before planning it, and ask which
    one where a request names one thing and several match. ``subject`` is
    what the app's tools find, singular, with the tools named where they are
    worth naming, and ``one`` the ways a user of the app names one thing, as
    quoted examples."""
    return FIND_FIRST.replace('{subject}', subject).replace('{one}', one)


def stage_now() -> str:
    """Stage the changes in the turn that decided on them, rather than
    promising them for a later turn there will not be one of."""
    return STAGE_NOW


def plan_what_was_asked() -> str:
    """Plan only what the user asked for, and offer the rest in the reply."""
    return PLAN_WHAT_WAS_ASKED


def user_values(examples: str) -> str:
    """A value the user states is the one planned, whatever the corpus
    does. ``examples`` are the kinds of value the app's user states, in the
    app's own words."""
    return USER_VALUES.replace('{examples}', examples)


def read_budget(tools: str) -> str:
    """Ask the whole project rather than reading it document by document.
    ``tools`` are the app's own reads that answer over the corpus."""
    return READ_BUDGET.replace('{tools}', tools)


def one_turn() -> str:
    """A plan belongs to the message that staged it."""
    return ONE_TURN


def in_stretches(full: str, light: str, bulk: str) -> str:
    """Analyse a long request a stretch of sentences at a time, the first
    in this turn, and offer the next. ``full`` names the app's work judged
    word by word, ``light`` the app's examples of one value per sentence
    (" (a ..., a ...)", or "" for none), and ``bulk`` the app's tools that
    change many sentences in one call, all in the app's own words."""
    return (IN_STRETCHES.replace('{n}', str(STRETCH_SENTENCES)).replace('{full}', full)
            .replace('{light}', light).replace('{bulk}', bulk))


def final_message(noun: str) -> str:
    """Say what the plan does without claiming it was applied. ``noun`` is
    the app's own plural for what a plan touches."""
    return FINAL_MESSAGE.replace('{noun}', noun)


def turn_example(asked: str, did: str, held: str, reply: str) -> str:
    """One whole turn in the app's own terms: what the user ``asked``, what
    the model ``did`` (in prose, no call written out), the plan the last
    result stated (``held``) and the ``reply`` that reports it."""
    return filled(TURN_EXAMPLE, {'asked': asked, 'did': did, 'held': held, 'reply': reply})


def be_concise() -> str:
    """Answer with the evidence, mark a guess as one, and never name a tool."""
    return BE_CONCISE


def copy_forms() -> str:
    """Copy a form from the data rather than typing it."""
    return COPY_FORMS


def attach_files(formats: str) -> str:
    """That the user can attach files, said whether or not they have. ``formats``
    are the app's own exchange formats as suffixes, comma-separated."""
    return ATTACH_FILES.replace('{formats}', formats)


def cite_evidence(*, refs: str, shown_as: str, never_paste: str, example: str, aside: str = '') -> str:
    """How to cite, which is the same rule everywhere and a different syntax
    in each app.

    ``refs`` is the tag and every form of reference the app addresses, ending
    in a full stop. ``shown_as`` is what the user sees a citation drawn as and
    ``never_paste`` what the model must therefore not paste instead: both are
    what the app renders. ``example`` is a worked one, and ``aside`` an
    optional clause after "exactly as the tools print it".
    """
    return filled(CITE_EVIDENCE, {'refs': refs, 'aside': aside, 'shown_as': shown_as,
                                  'never_paste': never_paste, 'example': example})


def code_section(*, triggers: str, outright: str, functions: str = '', reads: str = '',
                 sees: str = CODE_SEES) -> str:
    """The run_code half of a system prompt, in the app's own terms.

    ``triggers`` are the questions of this app's own that call for code and
    ``outright`` the tools that already answer without it. ``functions`` names
    the app's own host functions beside the shared four, and ``reads`` is a
    sentence on the app's reads that take in more per call. Everything else
    (the stopping rule, the output budget, that code may only write through
    plan) is the sandbox's and reads the same in every app.

    What ``load()`` returns and a template to start from used to be here, in
    every prompt of every turn, for a tool that in this deployment's whole
    history of conversations was never once called. ``code_help`` returns both
    already, to the model that asks: the prompt names the four functions so it
    knows what is there, and nothing more.

    ``sees`` is the sentence's end that names the host functions and how code
    stages: a context that lends other functions (a job's, which keeps no
    files) says its own, so no prompt names a function its code lacks.
    """
    return filled(CODE, {'triggers': triggers, 'outright': outright, 'reads': reads,
                         'sees': sees.replace('{functions}', functions)})


# The paragraph a turn that may read other projects adds after the app's own
# prompt. The home project's rules above stay the rules: another project is
# evidence to compare against, never a place to plan in.
OTHER_PROJECTS = '''OTHER PROJECTS IN THIS CONVERSATION
The user is working in "{home}", and every tool reads "{home}" unless you pass project. They also opened \
the projects below, and every read tool takes project="<name>" to read one of them. Say which project each \
finding comes from, and cite a sentence in another project with project="<name>" in the tag. Changes can be \
planned in "{home}" only.'''

# The same heading when every project the user added failed to open, so the
# model can say so rather than answer as if it had compared.
NO_OTHER_PROJECTS = '''OTHER PROJECTS IN THIS CONVERSATION
The user asked to include other projects, and none of them could be opened this turn. Every tool reads \
"{home}" only.'''


def project_brief(label: str, shape: str, titles: Sequence[str],
                  budget: int = OTHER_PROJECT_CHARS) -> str:
    """One other project's paragraph: its shape as the app renders it, and the
    titles of its guidelines. Titles only, pinned ones included: a body in the
    prompt reads as a rule for the project the user is working in, and it is
    one guidelines read away.

    Cut at ``budget`` characters on a line boundary, and a cut paragraph says
    where the rest is, because a budgeted render states what it showed. The
    shape is cut first, since project_overview shows it and nothing lists the
    titles. Titles that would take more than half the budget are cut too, and
    the line says how many more there are."""
    heading = f'PROJECT: "{label}"'
    shape_lines = [line for line in shape.split('\n') if line]
    where = f' (guidelines action "read" with project="{label}")'
    quoted = ['"' + t + '"' for t in titles]
    guidelines = ('- Guidelines: ' + ', '.join(quoted) + where) if titles else '- Guidelines: none written'
    full = '\n'.join([heading, *shape_lines, guidelines])
    if len(full) <= budget:
        return full
    tail = f'project_overview with project="{label}" shows the rest.'
    if titles and len(guidelines) > budget // 2:
        shown: list = []
        for q in quoted:
            more = f' and {len(titles) - len(shown) - 1} more'
            if len('- Guidelines: ' + ', '.join([*shown, q]) + more + where) > budget // 2:
                break
            shown.append(q)
        guidelines = '- Guidelines: ' + ', '.join(shown) + f' and {len(titles) - len(shown)} more' + where
    kept = [heading]
    used = len(heading) + 1 + len(guidelines) + 1 + len(tail)
    for line in shape_lines:
        if used + len(line) + 1 > budget:
            break
        kept.append(line)
        used += len(line) + 1
    # The tail speaks for the shape: a paragraph cut only in its titles says so on their line.
    return '\n'.join([*kept, guidelines, *([tail] if len(kept) - 1 < len(shape_lines) else [])])


def other_projects(home: str, briefs: Sequence[str], unavailable: Sequence[str]) -> str:
    """What the model is told about the other projects a turn may read.
    ``briefs`` are :func:`project_brief` paragraphs, ``unavailable`` the names
    of the projects the user added that did not open."""
    heading = (OTHER_PROJECTS if briefs else NO_OTHER_PROJECTS).replace('{home}', home)
    parts = [heading, *briefs]
    if unavailable:
        parts.append(' '.join(f'"{name}" could not be opened.' for name in unavailable))
    return '\n\n'.join(parts)


# --- an unattended job --------------------------------------------------------
# A job is the assistant, unattended (the owner's rulings 11 to 14 of
# 2026-11-13). A piece of a job is given the chat's own prompt, its shared
# rules word for word, with the paragraphs that assume a person present
# (asking, waiting for the next message, the plan card, the reply the user
# reads, stretches across turns) replaced by the ones below. Short and
# positive, with one worked piece in the app's prompt (FABLE-REVIEW 5):
# nothing here is a second copy of a chat rule.

#: What a job is and what becomes of what it stages: the app's apply rule
#: (rulings 17 to 20), said as the model meets it. ``{project_name}`` is filled in when the prompt
#: is built.
JOB_CONTRACT = '''You work unattended on the project "{project_name}", as a job a member of the project started \
with instructions. Nobody reads your messages while you work and nobody answers a question: the job is cut \
into pieces, each a context of its own like this one, and the message hands you yours. What you stage with the \
plan tools is applied by the job when you end, whoever wrote what it changes: values, analyses, links, \
deletions, text edits and lexicon entries, each value an unverified machine proposal that people review later. \
Project setup (a guideline, a tagset, a document's name or metadata, a new document) is not applied: the job's \
report lists it for a person. So stage what the instructions ask for, and nothing more.'''

JOB_FIND_FIRST = '''- For bulk work, first find every affected {subject}, then stage the changes. Where the \
instructions are unclear about something, do the part that is clear and say in your note what you left.'''

JOB_STAGE_NOW = '''- STAGE everything you decide in this piece before you end: there is no later message to do it \
in. The message shows how the forms in it were analysed by people and earlier in this job: follow that unless \
the sentence in front of you clearly needs another reading. Where you cannot tell what is right, leave it: a \
value left empty is filled by a person later, and a wrong one has to be found first.'''

JOB_PLAN_WHAT_WAS_ASKED = '''- DO WHAT THE INSTRUCTIONS ASK, in the fields and levels they name. Anything more you \
notice goes in your note, not in the plan.'''

JOB_VALUES = '''- WHAT THE INSTRUCTIONS STATE WINS. A value they give ({examples}) is the value to stage, even \
where the corpus does it differently: say the difference in your note.'''

JOB_NOTE = '''- END THE PIECE with a short note for the job's report, one to three plain sentences: what you did, \
what you left and why. It is your last message, with no tool call. Nobody answers it.'''

JOB_EXAMPLE = '''- A WHOLE PIECE, FOR EXAMPLE. {did} Then you ended with the note:\n\n{note}'''

#: The line a piece's model is sent once it has used most of its calls or
#: its prompt has grown near its cap (CONTRACT 1). The calls after it are
#: offered the plan tools alone.
JOB_DECIDE_NOW = '(system) Decide now with what you have: stage your work on the piece and end with your note.'

#: The planning context's contract: the first context of every job.
JOB_PLAN_CONTRACT = '''You plan an unattended job on the project "{project_name}". A member of the project \
started it with instructions and documents. Nobody reads your messages and nobody answers a question. The job's \
work is done in pieces, each its own context with the assistant's tools and the instructions, and you decide \
how it is cut. You stage no change. End by calling plan_work once.'''

#: Sent once to a planning context that ended without plan_work.
JOB_PLAN_NOW = '(system) End the planning now: call plan_work.'

#: The final context's contract: the prose at the top of the job's report.
JOB_SUMMARY_CONTRACT = '''You write the summary at the top of the report of an unattended job on the project \
"{project_name}", for the person who started it. The report's own sections follow your summary and are the \
record: the message gives you their totals, each piece's note and the tables the job's code made. Write a few \
short paragraphs of plain prose: what the job did, what it found, what it left for people, and what to check \
first. State no count and no number the message does not hold, and give a table's numbers as the table has \
them. No headings, no lists of every change: the sections list them.'''


def job_contract() -> str:
    """What a job is and what the apply rule does with what it stages."""
    return JOB_CONTRACT


def job_find_first(subject: str) -> str:
    """The job's half of :func:`find_first`: find first, and do the clear
    part where the instructions are not clear."""
    return JOB_FIND_FIRST.replace('{subject}', subject)


def job_stage_now() -> str:
    """Stage everything in this piece, following what was done before."""
    return JOB_STAGE_NOW


def job_plan_what_was_asked() -> str:
    """Do what the instructions ask, and put the rest in the note."""
    return JOB_PLAN_WHAT_WAS_ASKED


def job_values(examples: str) -> str:
    """The job's half of :func:`user_values`: the instructions' values win."""
    return JOB_VALUES.replace('{examples}', examples)


def job_note() -> str:
    """End the piece with a note for the report."""
    return JOB_NOTE


def job_example(did: str, note: str) -> str:
    """One whole piece in the app's own terms, its calls told in prose."""
    return filled(JOB_EXAMPLE, {'did': did, 'note': note})

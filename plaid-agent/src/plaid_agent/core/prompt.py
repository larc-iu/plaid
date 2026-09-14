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

# The contract the user reads the plan card under, which is the harness's and
# not any app's. ``{project_name}`` is filled in when the prompt is built.
PLAN_CONTRACT = '''You work for the person chatting with you, on the project "{project_name}". You can read the \
whole project and you can PLAN changes. A plan is not applied by you: it goes back to the user as a list of \
concrete changes they approve or discard. Nothing is written until they approve. What an approved plan writes \
is recorded as verified (made by you, confirmed by the user), or, where the project reviews that user's work, \
as their own contribution awaiting a reviewer.'''

# The project's own shape, rendered by the app and filled in when the prompt
# is built.
PROJECT_SHAPE = '''Project shape:
{shape}'''

HOW_TO_WORK = 'How to work:'

FIND_FIRST = '''- For bulk edits, first find every affected {subject}, then plan the changes. Planned changes \
are the only way to modify data. When the user's request is ambiguous about what to change, ask before planning.'''

STAGE_NOW = '''- Once the request is clear, STAGE the changes with the plan tools in the same turn. Never ask \
the user to confirm in chat before staging: the staged plan is what they confirm, with Approve and Discard on \
the plan card. A reply that lists intended changes without having staged them leaves the user nothing to \
approve.{more}'''

ONE_TURN = '''- A plan lives for ONE turn. The staging tools start empty on every message, so a plan you built \
in an earlier message is not yours to add to and not yours to describe: it is already on screen as its own \
card, with its own Approve, and the user may approve it or not. Count and describe ONLY what you staged in \
THIS message. Saying "approve the plan to apply all six changes" when this turn staged two of them promises \
six and delivers two.'''

FINAL_MESSAGE = '''- Your final message for a turn that planned changes must say plainly what the plan does, \
how many {noun} it touches, and anything uncertain, so the user can decide. Do not claim anything was changed: \
it will only be applied if they approve.'''

BE_CONCISE = '''- Be concise and concrete. Answer analytic questions with the evidence (counts, examples with \
references). Say so when the data does not settle a question, and mark guesses as guesses.'''

CITE_EVIDENCE = '''- CITE EVIDENCE. Whenever a claim rests on particular sentences, cite them with a tag: \
{refs} Everything ref names is highlighted in the example the user sees, so name exactly what your claim rests \
on. The doc attribute is the document name or id exactly as the tools print it{aside}. The user sees each \
citation as the {shown_as} with a link to it in the editor, so never paste {never_paste} yourself: cite \
instead. Where you would show an example, put the tag ALONE on its own line at that point (the rendered \
example appears there); a tag inside a sentence becomes a link only. Always give doc: never write a bare \
reference like "s3.w2" on its own. For instance:\n\n{example}'''

# Appended to an app's system prompt only where the sandbox binary is there,
# like the web half: a model that cannot run code is never told that it can.
CODE = '''
Running code:
- run_code runs Python you write over a plain-data view of the project, in ONE call. Use it whenever a \
question needs a loop, a join or a tally the reads do not offer directly: {triggers}, a count under your \
own definition, examples that match a compound condition, or anything gathered across more than a handful \
of documents. If you have called read_document or search three times for one question, switch to run_code. \
Do not use it for what {outright} answer outright, and inside it use query() for a count the \
engine can make.
- What the code sees: documents() lists {"id", "name"}; {rows}; query(q) runs a query \
object as query_help describes; plan(tool, ...) stages a change through a plan tool by name. The template:
{template}
  Print a summary (counts, a few refs with their sentence text), never every row: output is capped. \
Loading every document of a large corpus takes about a minute, which is fine for one call. code_help has \
worked examples.
- Code can stage changes through plan(...) and nothing else: the same guards apply, and nothing is written \
until the user approves the plan card.
'''

# A hole the prompt keeps until the project is known, so `filled` does not
# call it a paragraph nobody wrote.
_LATE = ('project_name', 'shape', 'overview_docs')
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


def find_first(subject: str) -> str:
    """Find everything a bulk edit reaches before planning it. ``subject`` is
    what the app's tools find, singular, with the tools named where they are
    worth naming."""
    return FIND_FIRST.replace('{subject}', subject)


def stage_now(more: str = '') -> str:
    """Stage the changes in the turn that decided on them, rather than
    promising them. ``more`` is anything an app has learned to add."""
    return STAGE_NOW.replace('{more}', f' {more}' if more else '')


def one_turn() -> str:
    """A plan belongs to the message that staged it."""
    return ONE_TURN


def final_message(noun: str) -> str:
    """Say what the plan does without claiming it was applied. ``noun`` is
    the app's own plural for what a plan touches."""
    return FINAL_MESSAGE.replace('{noun}', noun)


def be_concise() -> str:
    """Answer with the evidence, and mark a guess as one."""
    return BE_CONCISE


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


def code_section(*, triggers: str, outright: str, rows: str, template: str) -> str:
    """The run_code half of a system prompt, in the app's own terms.

    ``triggers`` are the questions of this app's own that call for code,
    ``outright`` the tools that already answer without it, ``rows`` what
    ``load()`` returns, and ``template`` the loop over it. Everything else
    (the stopping rule, the output budget, that code may only write through
    plan) is the sandbox's and reads the same in every app.
    """
    return filled(CODE, {'triggers': triggers, 'outright': outright,
                         'rows': rows, 'template': template})

"""The paragraphs all three prompts say come from one place.

Each of them was written twice, once per app, and they drifted: a sentence
added to IGT's staging rule after a session went wrong was never added to UD's,
and nothing said so. `core.prompt` holds each shared paragraph once, and this
holds every app to it. UMR imported the shared paragraphs and nothing held it
to them until 2026-09.

Byte-identity of the assembled prompt is `test_sample_prompt.py`: each
snapshot is the real builder's output and the gate fails on a stale one.
"""

import re
import sys

sys.path.insert(0, 'tests')

from plaid_agent.core import prompt as shared  # noqa: E402
from plaid_agent.igt import prompt as igt_prompt  # noqa: E402
from plaid_agent.ud import prompt as ud_prompt  # noqa: E402
from plaid_agent.umr import prompt as umr_prompt  # noqa: E402

# Every paragraph `core.prompt` owns, as the template it keeps, so a hole an
# app fills is not compared and everything around it is.
SHARED = [shared.PLAN_CONTRACT, shared.PROJECT_SHAPE, shared.HOW_TO_WORK, shared.FIND_FIRST,
          shared.STAGE_NOW, shared.PLAN_WHAT_WAS_ASKED, shared.ONE_TURN, shared.IN_STRETCHES,
          shared.FINAL_MESSAGE, shared.TURN_EXAMPLE, shared.READ_BUDGET, shared.BE_CONCISE, shared.COPY_FORMS,
          shared.ATTACH_FILES, shared.CITE_EVIDENCE]


def _fragments(template: str):
    """What a paragraph says whatever an app fills its holes with."""
    return [p.strip() for p in re.split(r'\{[a-z_]+\}', template) if len(p.strip()) > 20]


def _built():
    from fixtures import FakeClient
    from ud_fixtures import PID as UD_PID, ud_client
    from umr_fixtures import PID as UMR_PID, umr_client
    from plaid_agent.igt.project import load_project as igt_load
    from plaid_agent.ud.project import load_project as ud_load
    from plaid_agent.umr.project import load_project as umr_load
    return {'igt': igt_prompt.build_system_prompt(igt_load(FakeClient(), 'p1')),
            'ud': ud_prompt.build_system_prompt(ud_load(ud_client(), UD_PID)),
            'umr': umr_prompt.build_system_prompt(umr_load(umr_client(), UMR_PID))}


def test_every_prompt_says_every_shared_paragraph_word_for_word():
    built = _built()
    assert SHARED, 'the sweep is green on an empty list without this'
    for template in SHARED:
        for piece in _fragments(template):
            for app, text in built.items():
                assert piece in text, f'{app}: {piece[:60]}'


def test_every_prompt_says_a_file_can_be_attached_when_none_is():
    """The note and the file tools come only with a file. Without this line a
    model asked whether it can take a CSV answered that it cannot accept file
    uploads, with the paperclip beside the question."""
    from plaid_agent.core.filetools import NOTE_MARK
    own = {'igt': '.flextext, .eaf, .lift', 'ud': '.conllu', 'umr': '.umr'}
    for app, text in _built().items():
        assert 'paperclip in the composer' in text, app
        assert f"the app's own formats ({own[app]})" in text, app
        assert 'import screen' in text, app
        assert NOTE_MARK not in text, app


def test_every_apps_run_code_section_is_the_same_but_for_what_it_loads():
    """The stopping rule, the output budget and "code writes only through
    plan" are the sandbox's, not the app's."""
    for piece in _fragments(shared.CODE):
        for app, code in (('igt', igt_prompt.CODE), ('ud', ud_prompt.CODE),
                          ('umr', umr_prompt.CODE)):
            assert piece in code, f'{app}: {piece[:60]}'


def test_a_paragraph_nobody_wrote_refuses_where_the_prompt_is_assembled():
    """Without this a mistyped name reaches the model as a brace in the middle
    of a sentence: the prompt still builds, every test passes, and nobody reads
    the assembled text."""
    import pytest
    with pytest.raises(ValueError, match=r"no text for \['nope'\]"):
        shared.filled('a paragraph, then {nope}.', {'other': 'x'})
    # The holes the project fills when the prompt is built are not paragraphs.
    assert shared.filled('{shape} and {project_name}', {}) == '{shape} and {project_name}'


def test_every_prompt_says_to_ask_which_one_and_that_only_the_last_message_is_read():
    """The local model staged a change to the first of six "de" in the named
    sentence, and answered a question beside a tool call where the user never
    reads it, so its reply about the plan left the count out (benchmark,
    2026-10-10). Each app names one thing in its own terms."""
    for app, text in _built().items():
        assert 'ask which one, list the candidates with their references, and plan nothing' in text, app
        assert 'The reply the user reads is your LAST message of the turn:' in text, app
        assert re.search(r'ONE thing the user names \("[^"]+", "[^"]+"\)', text), app


def test_every_prompt_says_how_much_to_analyse_at_once_and_what_that_leaves_alone():
    """PROD-LOOP: asked to analyse a whole story at once, the model ran to its
    output cap four times running. The owner's rule (2026-11-11): a first
    stretch staged and the next offered, anything judged word by word counted
    (REV-PB-C-3), about 5 sentences read and decided alone (FX-BUSY 2), the
    turn ended once the first stretch is staged (BENCH-STRETCH-2), and the
    same value on everything one search finds staged whole (FX-STRETCH 1).
    Picking from a list the user gives stays judgment. Narrowed to its rule
    (FABLE-REVIEW 2026-11-12): 195 words of exceptions to exceptions became
    one rule and one list of what is done whole, and the reply it scripted
    ("once they approve this plan") went, as a model that had staged nothing
    wrote it."""
    from plaid_agent.core.limits import STRETCH_SENTENCES
    full = {'igt': 'segmenting and glossing, marking every noun phrase, a field on every word',
            'ud': 'a parse, a lemma, a feature or a relation on every word',
            'umr': 'a sentence graph, an attribute on every event or entity'}
    light = {'igt': 'one value per sentence (a free translation, a note)',
             'ud': 'one value per sentence (a note on it)',
             'umr': 'one value per sentence, and questions'}
    bulk = {'igt': 'replace_in_field', 'ud': 'replace_in_field', 'umr': 'set_attribute_for_concept'}
    assert STRETCH_SENTENCES == 5, 'the owner\'s figure (2026-11-11, after BENCH-STRETCH)'
    for app, text in _built().items():
        line = next(x for x in text.splitlines() if x.startswith('- WORK IN STRETCHES.'))
        assert f'Work you judge word by word ({full[app]}), even picking from a list the user gives, is done ' \
               f'about {STRETCH_SENTENCES} sentences at a time' in line, app
        # 8 of 9 runs read all 20 sentences before staging 5 once "read ONLY those sentences, not the whole
        # document" was cut (bench glm53-stretch-3), and the deciding call's reasoning rose to 23,409 tokens.
        assert f'read ONLY the first {STRETCH_SENTENCES} or so, not the whole document, decide and stage them, ' \
               'then end your turn and offer to go on.' in line, app
        assert 'Done whole: the same value on everything one search finds' in line, app
        assert light[app] in line and bulk[app] in line, app
        assert not re.search(r'\b(?:10|ten)\b', line), app
        # No reply is scripted: what the reply says of the plan is FINAL_MESSAGE's, from the last result.
        assert 'approve this plan' not in line and 'in your reply' not in line, app
        assert len(line.split()) < 95, (app, len(line.split()))
        assert text.index('A plan lives for ONE turn') < text.index('- WORK IN STRETCHES.'), app


def test_staging_now_and_working_in_stretches_agree():
    """STAGE_NOW says to stage now rather than promise, and WORK IN STRETCHES
    leaves the rest of a long request for the user to ask for: the one says
    the other is its exception (REV-PB-C, S5)."""
    for app, text in _built().items():
        stage = next(x for x in text.splitlines() if x.startswith('- Once the request is clear, STAGE'))
        assert stage.endswith('The one exception is the rest of a request done in stretches (WORK IN '
                              'STRETCHES), which waits until the user asks you to go on in a later message.'), app
        assert text.index(stage) < text.index('- WORK IN STRETCHES.'), app


def test_every_prompt_says_to_plan_what_was_asked_and_offer_the_rest():
    """Asked to gloss 49 morphemes, a model also linked 49 to the lexicon, and
    asked to rename a gloss, it also changed a lexicon sense and drafted a
    guideline: the card is approved whole (FABLE-REVIEW 2026-11-12)."""
    for app, text in _built().items():
        assert '- PLAN WHAT WAS ASKED, and offer the rest.' in text, app
        assert 'goes in your reply as an offer' in text, app
        assert text.index('- PLAN WHAT WAS ASKED') < text.index('- WORK IN STRETCHES.'), app


def test_every_prompt_drafts_a_guideline_only_when_asked():
    """The owner's ruling (2026-11-12): the assistant drafts a guideline only
    when the user asks for one, and offers in its reply when the user states a
    project-wide convention. It never stages one unasked."""
    from plaid_agent.core.guidelines import EMPTY_SECTION, HELP, section, Guideline
    for app, text in _built().items():
        assert 'even though they did not ask' not in text, app
        assert 'Write or change a guideline only when the user asks you to.' in text, app
        assert 'offer in your reply to write it into the guidelines, and stage nothing for it' in text, app
    for words in (EMPTY_SECTION, section([Guideline(id='g', title='T', body='b')]), HELP):
        assert 'even if they did not ask' not in words and 'even though they did not ask' not in words
    assert 'when the user asks for one' in HELP


def test_every_prompt_shows_one_whole_turn_whose_reply_reports_the_plan_line():
    """The prompt said in four places what a turn must not be and never showed
    one. The example's reply reports the plan as the plan line states it
    (core.plan.plan_line), and names no tool."""
    import re as _re
    from plaid_agent.igt.toolkit import TOOLS as IGT
    from plaid_agent.ud.toolkit import TOOLS as UD
    from plaid_agent.umr.toolkit import TOOLS as UMR
    names = {'igt': IGT, 'ud': UD, 'umr': UMR}
    for app, text in _built().items():
        start = text.index('- A WHOLE TURN, FOR EXAMPLE.')
        block = text[start:text.index('\n- ', start + 1)]
        held = _re.search(r'"\[Plan of this turn: (\d+) changes?\.\]"', block).group(1)
        reply = block.split('and you replied:\n\n', 1)[1]
        assert f'the plan holds {held} change' in reply.lower(), app
        for t in names[app]:
            assert t['function']['name'] not in reply, (app, t['function']['name'])

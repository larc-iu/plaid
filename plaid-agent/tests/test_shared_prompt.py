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
          shared.STAGE_NOW, shared.ONE_TURN, shared.IN_STRETCHES, shared.FINAL_MESSAGE, shared.READ_BUDGET,
          shared.BE_CONCISE, shared.ATTACH_FILES, shared.CITE_EVIDENCE]


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
        assert 'The reply the user reads is your LAST message of the turn.' in text, app
        assert re.search(r'ONE thing the user names \("[^"]+", "[^"]+"\)', text), app


def test_every_prompt_says_how_much_to_analyse_at_once_and_what_that_leaves_alone():
    """PROD-LOOP: asked to analyse a whole story at once, the model ran to its
    output cap four times running. The owner's rule (2026-11-11): about ten
    sentences of full analysis a turn, the first stretch staged and the next
    offered, which leaves reads and the tools that change many sentences in
    one call alone. Ruled again the same day (REV-PB-C-3): anything judged
    word by word or phrase by phrase is full analysis, the request that
    failed on prod ("mark every NP for accessibility") among it, and only one
    value per sentence, such as a free translation or a note, may cover
    more."""
    from plaid_agent.core.limits import STRETCH_SENTENCES
    full = {'igt': 'segmenting and glossing, marking every noun phrase, a field on every word',
            'ud': 'a parse, a lemma, a feature or a relation on every word',
            'umr': 'a sentence graph, an attribute on every event or entity'}
    light = {'igt': 'Only ONE value per sentence, such as a free translation or a note, may cover more',
             'ud': 'Only ONE value per sentence, such as a note on it, may cover more',
             'umr': 'Only ONE value per sentence may cover more'}
    bulk = {'igt': 'replace_in_field', 'ud': 'replace_in_field', 'umr': 'set_attribute_for_concept'}
    for app, text in _built().items():
        line = next(x for x in text.splitlines() if x.startswith('- WORK IN STRETCHES.'))
        assert f'Work judged word by word or phrase by phrase ({full[app]}) is done about ' \
               f'{STRETCH_SENTENCES} sentences at a time' in line, app
        assert f'do the first {STRETCH_SENTENCES} or so' in line, app
        assert 'once they approve this plan' in line, 'a plan per stretch, as ONE_TURN has it'
        assert light[app] in line, app
        # Nothing judged per word reads as light work any more.
        for word in ('Lighter', 'one field', 'one column', 'one attribute'):
            assert word not in line, (app, word)
        assert bulk[app] in line and 'a question about a whole document' in line, app
        # Next to the rule it must agree with.
        assert text.index('A plan lives for ONE turn') < text.index('- WORK IN STRETCHES.'), app


def test_staging_now_and_working_in_stretches_agree():
    """STAGE_NOW says there is no later turn to do a promised change in, and
    WORK IN STRETCHES leaves the rest of a long request for the user to ask
    for: the one says the other is its exception (REV-PB-C, S5)."""
    for app, text in _built().items():
        stage = next(x for x in text.splitlines() if x.startswith('- Once the request is clear, STAGE'))
        assert stage.endswith('so stage it now. The one exception is the rest of a request done in '
                              'stretches (WORK IN STRETCHES), which waits until the user asks you to go on.'), app
        assert text.index(stage) < text.index('- WORK IN STRETCHES.'), app

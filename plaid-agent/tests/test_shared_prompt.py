"""The paragraphs both prompts say come from one place.

Each of them was written twice, once per app, and they drifted: a sentence
added to IGT's staging rule after a session went wrong was never added to UD's,
and nothing said so. `core.prompt` holds each shared paragraph once, and this
holds both apps to it.

Byte-identity of the assembled prompt is `test_sample_prompt.py`: both
snapshots are the real builder's output and the gate fails on a stale one.
"""

import re
import sys

sys.path.insert(0, 'tests')

from plaid_agent.core import prompt as shared  # noqa: E402
from plaid_agent.igt import prompt as igt_prompt  # noqa: E402
from plaid_agent.ud import prompt as ud_prompt  # noqa: E402

# Every paragraph `core.prompt` owns, as the template it keeps, so a hole an
# app fills is not compared and everything around it is.
SHARED = [shared.PLAN_CONTRACT, shared.PROJECT_SHAPE, shared.HOW_TO_WORK, shared.FIND_FIRST,
          shared.STAGE_NOW, shared.ONE_TURN, shared.FINAL_MESSAGE, shared.READ_BUDGET,
          shared.BE_CONCISE, shared.CITE_EVIDENCE]


def _fragments(template: str):
    """What a paragraph says whatever an app fills its holes with."""
    return [p.strip() for p in re.split(r'\{[a-z_]+\}', template) if len(p.strip()) > 20]


def _built():
    from fixtures import FakeClient
    from ud_fixtures import PID, ud_client
    from plaid_agent.igt.project import load_project as igt_load
    from plaid_agent.ud.project import load_project as ud_load
    return (igt_prompt.build_system_prompt(igt_load(FakeClient(), 'p1')),
            ud_prompt.build_system_prompt(ud_load(ud_client(), PID)))


def test_both_prompts_say_every_shared_paragraph_word_for_word():
    igt, ud = _built()
    assert SHARED, 'the sweep is green on an empty list without this'
    for template in SHARED:
        for piece in _fragments(template):
            assert piece in igt, piece[:60]
            assert piece in ud, piece[:60]


def test_both_apps_run_code_sections_are_the_same_but_for_what_they_load():
    """The stopping rule, the output budget and "code writes only through
    plan" are the sandbox's, not the app's."""
    for piece in _fragments(shared.CODE):
        assert piece in igt_prompt.CODE, piece[:60]
        assert piece in ud_prompt.CODE, piece[:60]


def test_a_paragraph_nobody_wrote_refuses_where_the_prompt_is_assembled():
    """Without this a mistyped name reaches the model as a brace in the middle
    of a sentence: the prompt still builds, every test passes, and nobody reads
    the assembled text."""
    import pytest
    with pytest.raises(ValueError, match=r"no text for \['nope'\]"):
        shared.filled('a paragraph, then {nope}.', {'other': 'x'})
    # The holes the project fills when the prompt is built are not paragraphs.
    assert shared.filled('{shape} and {project_name}', {}) == '{shape} and {project_name}'

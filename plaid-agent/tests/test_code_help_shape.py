"""code_help says what load() returns, and nothing compared the two (R2-DICT-8:
ud's help named the review of FEATS "feats" while the view keyed it
"features", so code following the help got a KeyError). Per app: every key the
view of the fixture document has is one the help's shape names, and every key
the help names is one the view has; a review is keyed by the word's own
columns or fields; and each EXAMPLES snippet runs without a Python error,
but the one that counts with query(), whose layer names are the help's
example project's and which the fake clients do not run."""

import re
import textwrap

import pytest
from fixtures import FakeClient, fake_ws
from live import require_sandbox
from ud_fixtures import PID as UD_PID, ud_client
from umr_fixtures import umr_ws

from plaid_agent.igt import sandbox as igt_sandbox
from plaid_agent.igt.toolkit import call_tool as igt_call
from plaid_agent.ud import sandbox as ud_sandbox
from plaid_agent.ud.project import load_project as ud_load_project
from plaid_agent.ud.toolkit import call_tool as ud_call
from plaid_agent.ud.tools import Workspace as UdWorkspace
from plaid_agent.umr import sandbox as umr_sandbox
from plaid_agent.umr.toolkit import call_tool as umr_call

# Dicts keyed by the project's or the person's own names, not by the shape.
NAMED = {'metadata', 'fields', 'orthographies', 'review'}
# Keys the help names that the fixture document does not reach: igt's
# fixture has no time alignment.
UNREACHED = {'igt': {'start', 'end', 'speaker'}}


def _igt():
    ws = fake_ws(FakeClient())
    return ws, igt_sandbox.view(ws.doc('Text 1')), igt_sandbox.IGT_HELP, igt_call


def _ud():
    client = ud_client()
    ws = UdWorkspace(client, ud_load_project(client, UD_PID))
    return ws, ud_sandbox.view(ws.doc('Viaje')), ud_sandbox.UD_HELP, ud_call


def _umr():
    ws = umr_ws()
    return ws, umr_sandbox.view(ws.doc('Story'), ws.project), umr_sandbox.UMR_HELP, umr_call


APPS = {'igt': _igt, 'ud': _ud, 'umr': _umr}


def _shape_block(help_text):
    return help_text.split('THE SHAPE load(document) RETURNS:', 1)[1].split('\n\n', 1)[0]


def _help_keys(help_text):
    """The keys the help's shape names: a quoted lower-case name in a key's
    place, after { or , (a value such as "human" follows a colon or a bar)."""
    return set(re.findall(r'[{,]\s*"([a-z_]+)"(?=\s*[:,}])', _shape_block(help_text)))


def _view_keys(value, out=None, reviews=None):
    """The keys of every dict in the view (the dicts under NAMED keys left
    out), and each review beside the keys of the dict holding it."""
    out = set() if out is None else out
    reviews = [] if reviews is None else reviews
    if isinstance(value, dict):
        out.update(value)
        if isinstance(value.get('review'), dict):
            reviews.append((value['review'], value))
        for k, v in value.items():
            if k not in NAMED:
                _view_keys(v, out, reviews)
    elif isinstance(value, list):
        for v in value:
            _view_keys(v, out, reviews)
    return out, reviews


@pytest.mark.parametrize('app', sorted(APPS))
def test_the_help_names_the_keys_the_view_has(app):
    _ws, view, help_text, _call = APPS[app]()
    have, _ = _view_keys(view)
    said = _help_keys(help_text)
    assert have - said == set(), f'{app}: the view has keys its help does not name'
    assert said - have - UNREACHED.get(app, set()) == set(), f'{app}: the help names keys the view lacks'


@pytest.mark.parametrize('app', ['igt', 'ud'])
def test_a_review_is_keyed_by_what_it_reviews(app):
    _ws, view, _help, _call = APPS[app]()
    _, reviews = _view_keys(view)
    assert any(review for review, _ in reviews), 'the fixture reviews nothing'
    for review, holder in reviews:
        # igt reviews a value by its field's name, ud by the word's column.
        columns = set(holder['fields']) if app == 'igt' else set(holder) - {'review'}
        assert set(review) <= columns, (app, sorted(review), sorted(columns))


def _examples(help_text):
    body = textwrap.dedent(help_text.split('EXAMPLES\n', 1)[1])
    return [b.strip('\n') for b in body.split('\n\n') if b.strip() and 'query(' not in b]


class TestTheExamplesRun:
    pytestmark = require_sandbox()

    @pytest.mark.parametrize('app', sorted(APPS))
    def test_each_example_runs_without_a_python_error(self, app):
        ws, _view, help_text, call = APPS[app]()
        examples = _examples(help_text)
        assert len(examples) >= 3
        for code in examples:
            out = call(ws, 'run_code', {'code': code})
            assert not re.search(r'\b(Traceback|[A-Z][a-z]+Error)\b', out), (app, code, out)

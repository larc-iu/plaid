"""Which documents a review over several covers, and what its step says.

Only the word "all" means the project (Luke's ruling). Both confirm tools
honoured it, but both trace labels read any string as the project, so
confirm(documents="Text 3") planned one document and the step the user saw
said "across the project" (igt) or "across every document with something
waiting" (ud). core.scope.is_all and review_documents are the one reading.
"""

import pytest

from fixtures import FakeClient, fake_ws
from live import live_client  # noqa: F401 - fixture
from test_trace_resolved_scope import _traced
from test_ud_read_scope import ws as ud_ws  # noqa: F401 - fixture

from plaid_agent.core.limits import MAX_SCOPE_DOCS
from plaid_agent.core.scope import is_all, review_documents
from plaid_agent.core.tools import ToolError
from plaid_agent.igt.trace import describe_step as igt_step
from plaid_agent.ud.trace import describe_step as ud_step


@pytest.mark.parametrize('documents', ['all', ' ALL ', ['all'], [' All']])
def test_only_the_word_all_is_the_project(documents):
    assert is_all(documents)


@pytest.mark.parametrize('documents', ['Text 3', ['Text 3'], ['all', 'Text 3'], [], '', None, 'allx'])
def test_a_name_or_nothing_is_not_the_project(documents):
    assert not is_all(documents)


def test_igt_a_confirm_of_one_named_document_is_traced_in_it():
    assert igt_step('confirm', {'documents': 'Text 3'}) \
        == 'Planned confirming everything awaiting review in “Text 3”'
    assert igt_step('confirm', {'documents': ['Text 3']}) \
        == 'Planned confirming everything awaiting review in “Text 3”'
    assert igt_step('confirm', {'documents': ['Text 3', ' text 3']}) \
        == 'Planned confirming everything awaiting review in “Text 3”'
    assert igt_step('confirm', {'documents': ['Text 1', 'Text 2']}) \
        == 'Planned confirming everything awaiting review across 2 documents'


@pytest.mark.parametrize('documents', ['all', ' All ', ['ALL']])
def test_igt_a_confirm_of_all_is_traced_across_the_project(documents):
    assert igt_step('confirm', {'documents': documents}) \
        == 'Planned confirming everything awaiting review across the project'


def test_ud_a_review_of_one_named_document_is_traced_in_it():
    assert ud_step('confirm', {'documents': 'Viaje'}) \
        == 'Planned confirming everything awaiting review in “Viaje”'
    assert ud_step('discard_predictions', {'documents': ['Viaje', 'viaje']}) \
        == 'Planned discarding every unconfirmed machine value in “Viaje”'
    assert ud_step('confirm', {'documents': ['Uno', 'Dos']}) \
        == 'Planned confirming everything awaiting review across 2 documents'


@pytest.mark.parametrize('documents', ['all', ' all', ['All ']])
def test_ud_a_review_of_all_is_traced_across_every_document_waiting(documents):
    assert ud_step('confirm', {'documents': documents}) \
        == 'Planned confirming everything awaiting review across every document with something waiting'


def test_review_documents_names_each_once_and_all_asks_the_app():
    w = fake_ws(FakeClient())
    name = w.corpus.doc_name('d1')
    assert review_documents(w, ['d1', name], lambda: pytest.fail('not all')) == ['d1']
    assert review_documents(w, f' {name} ', lambda: pytest.fail('not all')) == ['d1']
    assert review_documents(w, ['all'], lambda: ['d1', 'd2']) == ['d1', 'd2']


def test_review_documents_refuses_more_than_one_plan_covers():
    w = fake_ws(FakeClient())
    many = [f'doc-{i}' for i in range(MAX_SCOPE_DOCS + 1)]
    with pytest.raises(ToolError) as e:
        review_documents(w, 'all', lambda: many, 'Go in passes.')
    assert str(e.value) == (f'{MAX_SCOPE_DOCS + 1} documents, more than the {MAX_SCOPE_DOCS} one plan covers. '
                            'Go in passes.')
    assert e.value.kind == 'too-large'


def test_igt_a_confirm_by_id_and_name_of_one_document_traces_as_one(monkeypatch):
    from plaid_agent.igt import toolkit
    from plaid_agent.igt.trace import TRACER
    w = fake_ws(FakeClient())
    name = w.corpus.doc_name('d1')
    label = _traced(monkeypatch, toolkit, TRACER, w, 'confirm', {'documents': ['d1', name]})
    assert label.endswith(f'confirming everything awaiting review in “{name}”'), label


def test_ud_a_confirm_by_id_and_name_of_one_document_traces_as_one(monkeypatch, ud_ws):
    from plaid_agent.ud import toolkit
    from plaid_agent.ud.trace import TRACER
    uno = next(d['id'] for d in ud_ws.documents() if d.get('name') == 'Uno')
    label = _traced(monkeypatch, toolkit, TRACER, ud_ws, 'confirm', {'documents': [uno, 'Uno']})
    assert label.endswith('confirming everything awaiting review in “Uno”'), label

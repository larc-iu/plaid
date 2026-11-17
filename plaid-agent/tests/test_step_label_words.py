"""Step labels say what a call did, and never inflect a name a person chose
(survey 2026-11-17: "Ranked accessibilitys by frequency", "Read across the
corpus" for a parse of an attached file, "Searched" with the tool's synonym
for the baseline as given)."""

import pytest

from file_fixtures import NOTES, WORDLIST, attached
from fixtures import FakeClient, fake_ws
from live import require_sandbox
from plaid_agent.core.agent import ModelConfig, Toolkit, run_turn
from plaid_agent.igt import toolkit
from plaid_agent.igt.trace import TRACER, describe_step as igt_label
from plaid_agent.umr.trace import describe_step as umr_label


@pytest.mark.parametrize('args, label', [
    ({'what': 'Accessibility'}, 'Ranked the values of Accessibility by frequency'),
    ({'what': 'POS'}, 'Ranked the values of POS by frequency'),
    ({}, 'Ranked wordforms by frequency'),
    ({'what': 'wordform'}, 'Ranked wordforms by frequency'),
    ({'what': 'word'}, 'Ranked wordforms by frequency'),
    ({'what': 'Morpheme'}, 'Ranked morphemes by frequency'),
    ({'what': 'POS', 'ngram': 2}, 'Ranked POS bigrams by frequency'),
])
def test_frequency_list_never_pluralises_a_field_name(args, label):
    assert igt_label('frequency_list', args) == label


@pytest.mark.parametrize('what, label', [
    ('concept', 'Ranked concepts by frequency'), ('role', 'Ranked roles by frequency'),
    ('attribute', 'Ranked attributes by frequency'), ('document-relation', 'Ranked document-level relations by frequency'),
])
def test_umrs_frequency_list_names_what_it_ranked(what, label):
    assert umr_label('frequency_list', {'what': what}) == label


@pytest.mark.parametrize('where, label', [
    (None, 'Searched the baseline for “x”'), ('words', 'Searched the baseline for “x”'),
    ('Word', 'Searched the baseline for “x”'), ('morphemes', 'Searched morpheme forms for “x”'),
    ('lexicon', 'Searched the lexicon for “x”'), ('Gloss', 'Searched Gloss for “x”'),
])
def test_search_says_where_the_tool_searched(where, label):
    args = {'pattern': 'x', **({'where': where} if where else {})}
    assert igt_label('search', args).replace('⁨', '').replace('⁩', '') == label


def _run_code_label(monkeypatch, code, files=()):
    import json
    from types import SimpleNamespace
    from plaid_agent.core import agent
    w = fake_ws(FakeClient())
    if files:
        w.files = attached(*files)
    script = [SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(
        content=None, tool_calls=[SimpleNamespace(id='c1', function=SimpleNamespace(
            name='run_code', arguments=json.dumps({'code': code})))]), finish_reason='tool_calls')],
        usage=None),
        SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='Done.', tool_calls=None),
                                                 finish_reason='stop')], usage=None)]
    monkeypatch.setattr(agent, '_complete', lambda *a, **k: script.pop(0))
    kit = Toolkit(tools_for=lambda ws: [], call_tool=toolkit.call_tool, tracer=TRACER)
    try:
        turn = run_turn(ModelConfig(model='fake/m', stream=False), kit, w, 'system',
                        [{'role': 'user', 'content': 'hi'}])
    finally:
        w.close()  # gives the sandbox worker back, as the service does at the end of a turn
    [step] = turn.steps
    return step['label'].replace('⁨', '').replace('⁩', '')


@require_sandbox()
def test_code_that_only_parses_an_attached_file_says_so(monkeypatch):
    label = _run_code_label(monkeypatch, 'rows = file_rows("words.csv")\nprint(len(rows))', [('words.csv', WORDLIST)])
    assert label.startswith('Read the attached file “words.csv”'), label
    label = _run_code_label(monkeypatch, 'print(len(file_text("a.txt")) + len(file_text("b.txt")))',
                            [('a.txt', NOTES), ('b.txt', NOTES)])
    assert label.startswith('Read 2 attached files'), label


@require_sandbox()
def test_code_that_reads_the_corpus_and_a_file_says_both_and_a_sum_says_neither(monkeypatch):
    label = _run_code_label(monkeypatch, 'print(len(load("Text 1")["sentences"]), len(file_rows("words.csv")))',
                            [('words.csv', WORDLIST)])
    assert label.startswith('Read across the corpus and the attached file “words.csv”'), label
    assert _run_code_label(monkeypatch, 'print(len(documents()))').startswith('Read across the corpus')
    assert _run_code_label(monkeypatch, 'print(2 + 2)').startswith('Ran a calculation'), \
        'code that read nothing read nothing across the corpus'

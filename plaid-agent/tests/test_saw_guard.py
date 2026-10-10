"""Every read says what it showed the model.

A step's label and the summary line are built from what the tool noted
(``BaseWorkspace.note_read``): ``Searched the baseline for “ka”: 30 of 412
matches``. A read that notes nothing reads in the Assistant tab like a scan of
the whole corpus, so every READ and DOCUMENT tool of every app is run here
through its app's ``call_tool`` and must leave a note behind, even when it
found nothing ("0 matches" says what it read as well as "30 matches" does).
"""

import sys

import pytest

sys.path.insert(0, 'tests')

import test_read_tools_smoke as smoke  # noqa: E402
from live import require_sandbox  # noqa: E402
from plaid_agent.core import sandbox  # noqa: E402
from plaid_agent.core.trace import DOCUMENT, READ, UNITS, Tracer, summarize_steps, trace_step  # noqa: E402
from plaid_agent.igt import toolkit as igt_toolkit  # noqa: E402
from plaid_agent.igt.trace import TRACER as IGT_TRACER  # noqa: E402
from plaid_agent.ud import toolkit as ud_toolkit  # noqa: E402
from plaid_agent.ud.trace import TRACER as UD_TRACER  # noqa: E402
from plaid_agent.umr import toolkit as umr_toolkit  # noqa: E402
from plaid_agent.umr.trace import TRACER as UMR_TRACER  # noqa: E402

# Reads that look at no project data, so have nothing to say they read. A
# reference page is bookkeeping, as query_help (META) is: it is the same text
# whatever the project holds.
EXEMPT = {'code_help'}

# Reads that always ask the query engine, which only the second fixture runs.
ENGINE_ONLY = {('igt', 'query'), ('ud', 'query'), ('umr', 'query'),
               ('ud', 'check_consistency'), ('umr', 'frequency_list')}

APPS = {
    'igt': (igt_toolkit, IGT_TRACER, smoke._igt, smoke.IGT_ARGS),
    'ud': (ud_toolkit, UD_TRACER, smoke._ud, smoke.UD_ARGS),
    'umr': (umr_toolkit, UMR_TRACER, smoke._umr, smoke.UMR_ARGS),
}


def _cases():
    out = []
    for app, (toolkit, tracer, _, values) in APPS.items():
        for t in toolkit.TOOLS:
            f = t['function']
            name = f['name']
            if tracer.kind(name) not in (READ, DOCUMENT) or name in EXEMPT:
                continue
            params = f.get('parameters') or {}
            args = dict(smoke.EXTRA[app].get(name) or {})
            for k in params.get('required') or []:
                args[k] = values[k]
            if 'document' in (params.get('properties') or {}):
                args.setdefault('document', values['document'])
            for scan in ((False,) if (app, name) in ENGINE_ONLY else (True, False)):
                out.append(pytest.param(app, name, args, scan,
                                        id=f'{app}-{name}-{"scan" if scan else "engine"}'))
    return out


CASES = _cases()


@pytest.mark.parametrize('app,name,args,scan', CASES)
def test_every_read_notes_what_it_showed(app, name, args, scan):
    toolkit, _, make, _ = APPS[app]
    if name == 'run_code' and sandbox.available():
        pytest.skip(sandbox.available())
    ws = make(scan=scan)
    ws.reads = []
    out = toolkit.call_tool(ws, name, dict(args))
    assert not out.startswith('Error'), out
    assert ws.reads, f'{app} {name} noted nothing it showed:\n{out[:400]}'
    for s in ws.reads:
        assert s['unit'] in UNITS, s


def test_the_guard_covers_every_app():
    """Green on an empty case list would guard nothing."""
    for app in APPS:
        names = {c.values[1] for c in CASES if c.values[0] == app}
        assert 'read_document' in names and 'search' in names and len(names) >= 10, (app, names)


@require_sandbox()
def test_run_code_notes_what_the_code_read_and_printed():
    """Documents loaded, queries run, and the lines printed, in that order,
    replacing whatever the reads the code made noted on their own."""
    ws = smoke._ud(scan=False)
    ws.reads = [{'n': 99, 'unit': 'match'}]
    out = ud_toolkit.call_tool(ws, 'run_code', {'code': (
        'd = load("Viaje")\nd2 = load("Viaje")\n'
        'q = query({"find": ["?t"], "where": [["token", "?t", {"layer": "words"}]]})\n'
        'rows = file_rows("wordlist.csv")\nprint("a")\nprint("b")')})
    assert not out.startswith('Error'), out
    units = [s['unit'] for s in ws.reads]
    assert units == ['document', 'query', 'row', 'printed'], ws.reads
    assert ws.reads[0]['n'] == 1 and ws.reads[1]['n'] == 1 and ws.reads[3]['n'] == 2


def test_a_long_read_notes_the_sentences_shown_not_asked(monkeypatch):
    """Past the render budget a read shows fewer sentences than it asked
    for, and the note is what the model saw."""
    from plaid_agent.core import tools
    ws = smoke._ud(scan=True)
    doc = ws.doc('Viaje')
    total = len(doc.sentences)
    assert total >= 2
    # A budget one sentence fits under.
    one = len(ws.render(doc, from_sentence=1, to_sentence=1, budget=10 ** 9))
    monkeypatch.setattr(tools, 'RENDER_BUDGET', one + 1)
    ws.reads = []
    tools.read_document(ws, document='Viaje', from_sentence=1, to_sentence=total)
    assert len(ws.reads) == 1
    note = ws.reads[0]
    assert note['unit'] == 'sentence' and note['of'] == total
    assert note['n'] < total, note


TRACER = Tracer(kind=lambda n: DOCUMENT if n == 'read_document' else READ,
                describe=lambda n, a: f'Searched for {a.get("pattern")}', progress=lambda n, a: '')


def test_a_document_read_says_the_sentences_it_showed():
    item = trace_step(TRACER, 'c1', 'read_document', {'document': 'Text 1', 'from_sentence': 3},
                      saw=[{'n': 5, 'unit': 'sentence', 'of': 120, 'which': '3–7'}])
    assert item['label'] == 'Read “Text 1”: sentences 3–7 of 120'


def test_a_search_says_how_many_of_how_many():
    item = trace_step(TRACER, 'c1', 'search', {'pattern': 'ka'},
                      saw=[{'n': 30, 'unit': 'match', 'of': 412}])
    assert item['label'].endswith(': 30 of 412 matches')
    item = trace_step(TRACER, 'c1', 'search', {'pattern': 'ka'}, saw=[{'n': 0, 'unit': 'match'}])
    assert item['label'].endswith(': 0 matches')


def test_the_summary_counts_the_sentences_read():
    steps = [trace_step(TRACER, f'c{i}', 'read_document', {'document': f'D{i % 40}'},
                        saw=[{'n': 1, 'unit': 'sentence', 'of': 10, 'which': '1'}])
             for i in range(87)]
    steps.append(trace_step(TRACER, 'x', 'search', {'pattern': 'ka'}, saw=[{'n': 3, 'unit': 'match'}]))
    assert summarize_steps(steps) == 'read 87 sentences in 40 documents · 1 search · 88 steps'

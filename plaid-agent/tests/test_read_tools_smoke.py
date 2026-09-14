"""Every read tool, on both paths, with every enum value its schema declares.

Sixty-four IGT tool bodies and twenty-six UD ones, and nothing called most of
them. The ones that failed, failed as Python: a variable bound on one branch
and read on another answered "what are the commonest forms?" with
UnboundLocalError, and it shipped because no test had ever asked that question.

A refusal is an answer here: ToolError and ValueError are how a tool says no
to the model. Anything else is a fault in the tool, so the calls go through
the implementations rather than ``call_tool``, which turns every exception
into text and would hide exactly what this is looking for.

Both paths, because they are two implementations of one contract: naming a
document scans it, leaving it out asks the query engine. Arguments come from
each tool's own schema, so a new enum value is covered the day it is added.
"""

import sys

import pytest

sys.path.insert(0, 'tests')

from plaid_agent.core.tools import ToolError  # noqa: E402
from plaid_agent.igt.toolkit import (TOOLS as IGT_TOOLS, WRITE_TOOLS as IGT_WRITES,  # noqa: E402
                                     _IMPL as IGT_IMPL)
from plaid_agent.ud.toolkit import (TOOLS as UD_TOOLS, WRITE_TOOLS as UD_WRITES,  # noqa: E402
                                    _IMPL as UD_IMPL)

REFUSALS = (ToolError, ValueError)

# A value for every parameter a read tool requires or declares an enum for.
IGT_ARGS = {'document': 'Text 1', 'pattern': 'a', 'field': 'Gloss', 'sequence': [{'Gloss': 'ERG'}], 'code': 'print(1)',
            'indexes': [1], 'query': {'find': ['?t'], 'where': [['token', '?t', {'layer': 'words'}]]}}
UD_ARGS = {'document': 'Viaje', 'pattern': 'a', 'field': 'lemma', 'what': 'lemma', 'indexes': [1], 'code': 'print(1)',
           'query': {'find': ['?t'], 'where': [['token', '?t', {'layer': 'words'}]]}}

SKIP = ('web_search', 'read_url')   # the network is not the tools' contract

# Arguments a tool needs to do anything, where its schema requires none. Without
# them the tool refuses every call, which the sweep accepts as an answer and
# which leaves its body unrun (see test_every_read_tool_answered_at_least_once).
EXTRA = {'igt': {'analyses_of': {'forms': ['gam']}, 'lexicon_entry': {'entry_form': 'gam#1'}},
         'ud': {}}


def _cases(tools, write_tools, values, in_document: bool, extra=None):
    """(name, args) per read tool, once per enum value, with or without a
    document. A tool that does not take one is listed once either way."""
    out, seen = [], set()
    for t in tools:
        f = t['function']
        name = f['name']
        if name in write_tools or name in SKIP:
            continue
        params = f.get('parameters') or {}
        props = params.get('properties') or {}
        base = dict((extra or {}).get(name) or {})
        for k in params.get('required') or []:
            assert k in values, f'{name} requires "{k}" and this test has no value for it'
            base[k] = values[k]
        if 'document' in props and 'document' not in base:
            if in_document:
                base['document'] = values['document']
        elif in_document:
            continue   # nothing new to try: the same call as the other pass
        enums = {k: v['enum'] for k, v in props.items() if isinstance(v, dict) and v.get('enum')}
        for args in ([base] if not enums else
                     [{**base, k: v} for k, vals in enums.items() for v in vals]):
            key = (name, tuple(sorted(args)), tuple(str(v) for v in args.values()))
            if key not in seen:
                seen.add(key)
                out.append((name, args))
    return out


# Which tools actually ANSWERED, per app. A refusal is a legitimate answer to
# one call, so it cannot fail a case on its own; but a tool that refuses every
# call the sweep makes has not been exercised at all, and the whole suite of
# 106 cases could have gone green having run no tool body. The last test here
# holds every read tool to answering at least once.
ANSWERED: dict = {'igt': set(), 'ud': set()}


def _run(app, impl, ws, name, args):
    try:
        answer = impl[name](ws, **args)
    except REFUSALS:
        return          # a refusal is an answer to THIS call
    assert isinstance(answer, str), f'{name} answered with {type(answer).__name__}'
    ANSWERED[app].add(name)


def _empty_engine(client):
    """An engine answering every query with nothing: a real state (an empty
    project, a pattern that matches nothing) and the one the two paths
    disagree about most."""
    client.query = lambda body: {'return': body.get('return'), 'columns': [], 'results': [],
                                 'count': 0, 'truncated': False}
    return client


def _igt(scan: bool):
    # ExtClient, not FakeClient: it serves the comments table, the audit
    # windows and the restore dry run, so those tool bodies actually run.
    from fixtures import project_raw, document_raw, lexicon_raw
    from fixtures_ext import ExtClient
    from plaid_agent.igt.project import load_project
    from plaid_agent.igt.workspace import Workspace
    c = ExtClient(project=project_raw(), documents={'d1': document_raw()}, lexicon=lexicon_raw(),
                  comments=[{'id': 'c1', 'document_id': 'd1', 'entity_type': 'document', 'entity_id': 'd1',
                             'body': 'a note', 'created_at': '2026-09-01T10:00:00Z',
                             'updated_at': '2026-09-01T10:00:00Z', 'user': {'id': 'a@b.com'}}])
    if not scan:
        _empty_engine(c)
    w = Workspace(c, load_project(c, 'p1'))
    w.prefer_scan = scan
    return w


def _ud(scan: bool):
    # This app's ExtClient, whose audit log names this project's document: the
    # other app's named a document the UD project does not have, so the history
    # tools answered "nothing has changed" and the sweep took it for an answer.
    from ud_fixtures import ExtClient, project_raw, document_raw
    from plaid_agent.ud.project import load_project
    from plaid_agent.ud.tools import Workspace
    c = ExtClient(project=project_raw(), documents={'ud1': document_raw()},
                  comments=[{'id': 'c1', 'document_id': 'ud1', 'entity_type': 'document', 'entity_id': 'ud1',
                             'body': 'a note', 'created_at': '2026-09-01T10:00:00Z',
                             'updated_at': '2026-09-01T10:00:00Z', 'user': {'id': 'a@b.com'}}])
    if not scan:
        _empty_engine(c)
    return Workspace(c, load_project(c, 'p1'))


def _ids(cases):
    return [f'{n}-{"-".join(f"{k}={v}" for k, v in sorted(a.items()) if isinstance(v, str))}'
            for n, a in cases]


IGT_IN_DOC = _cases(IGT_TOOLS, IGT_WRITES, IGT_ARGS, in_document=True, extra=EXTRA['igt'])
IGT_PROJECT = _cases(IGT_TOOLS, IGT_WRITES, IGT_ARGS, in_document=False, extra=EXTRA['igt'])
UD_IN_DOC = _cases(UD_TOOLS, UD_WRITES, UD_ARGS, in_document=True, extra=EXTRA['ud'])
UD_PROJECT = _cases(UD_TOOLS, UD_WRITES, UD_ARGS, in_document=False, extra=EXTRA['ud'])


@pytest.mark.parametrize('name,args', IGT_IN_DOC, ids=_ids(IGT_IN_DOC))
def test_igt_read_tools_in_one_document(name, args):
    _run('igt', IGT_IMPL, _igt(scan=True), name, args)


@pytest.mark.parametrize('name,args', IGT_PROJECT, ids=_ids(IGT_PROJECT))
def test_igt_read_tools_project_wide(name, args):
    _run('igt', IGT_IMPL, _igt(scan=False), name, args)


@pytest.mark.parametrize('name,args', UD_IN_DOC, ids=_ids(UD_IN_DOC))
def test_ud_read_tools_in_one_document(name, args):
    _run('ud', UD_IMPL, _ud(scan=True), name, args)


@pytest.mark.parametrize('name,args', UD_PROJECT, ids=_ids(UD_PROJECT))
def test_ud_read_tools_project_wide(name, args):
    _run('ud', UD_IMPL, _ud(scan=False), name, args)


@pytest.mark.parametrize('app,name', [('igt', 'Text 1'), ('ud', 'Viaje')])
def test_the_history_a_sweep_case_reads_actually_holds_a_change(app, name):
    """A sweep case takes any string for an answer, and "nothing has changed
    here" is a string. UD's fixture client carried the other app's audit log,
    which named a document this project does not have, so recent_changes ran
    its empty branch in every one of those cases and nothing said so.
    """
    ws, impl = (_igt(scan=True), IGT_IMPL) if app == 'igt' else (_ud(scan=True), UD_IMPL)
    out = impl['recent_changes'](ws, document=name)
    assert 'Luke G' in out and 'Assistant: 2 field values' in out and name in out


def test_the_sweep_actually_covers_the_read_tools():
    """Without this the test above is green on an empty case list."""
    for cases, tools, writes, least in ((IGT_PROJECT, IGT_TOOLS, IGT_WRITES, 20),
                                        (UD_PROJECT, UD_TOOLS, UD_WRITES, 12)):
        reads = {t['function']['name'] for t in tools} - set(writes) - set(SKIP)
        assert {n for n, _ in cases} == reads
        assert len(cases) >= least


# A tool that cannot answer in this fixture, with the reason. Keep it short:
# every name here is a tool body the sweep does not actually run.
NEVER_ANSWERS = {
    # run_code and code_help: the sandbox worker binary is not on every machine.
    # drop_planned: there is nothing to drop from an empty plan, and staging one
    # here would make this a test about the plan tools.
    'igt': {'run_code', 'code_help', 'drop_planned'},
    'ud': {'run_code', 'code_help', 'drop_planned'},
}


def test_every_read_tool_answered_at_least_once():
    """Without this the sweep is green when every case refuses.

    The cases go through the implementations rather than through call_tool, so
    an exception fails them; but a REFUSAL is caught, and a tool that refuses
    everything the sweep asks has had none of its body run. That is the shape
    the sweep exists to catch, so it is asserted rather than assumed.
    """
    for app, cases, tools, writes in (('igt', IGT_PROJECT + IGT_IN_DOC, IGT_TOOLS, IGT_WRITES),
                                      ('ud', UD_PROJECT + UD_IN_DOC, UD_TOOLS, UD_WRITES)):
        reads = {t['function']['name'] for t in tools} - set(writes) - set(SKIP)
        silent = reads - ANSWERED[app] - NEVER_ANSWERS[app]
        assert not silent, (f'{app}: these read tools refused every call the sweep made, so none of '
                            f'their bodies ran: {sorted(silent)}')

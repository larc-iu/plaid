"""Every bundled service tags the operation its writes fold under as a
service run, so the audit log says which writes a service made and which
service made them (``kind='service-run'``, ``ref='service:<id>'``, see the
core manual's "Kinds of operation").

A service joining a requester's operation keeps the requester's kind (nesting
flattens), so the tag here only shows when the service runs alone, which is
the common case: the apps' service dialogs open no operation of their own.
The services are plain scripts with heavy imports (whisper, stanza), so they
are read, not run."""

import ast
import contextlib
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

ROOT = Path(__file__).resolve().parents[2]
SERVICES = sorted(p for app in ('plaid-igt', 'plaid-ud', 'plaid-umr')
                  for p in (ROOT / app / 'services').glob('*.py'))


def _calls(tree, name):
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            f = node.func
            called = f.attr if isinstance(f, ast.Attribute) else getattr(f, 'id', None)
            if called == name:
                yield node


def _keywords(call):
    return {k.arg: k.value for k in call.keywords}


def test_there_are_services_to_check():
    assert len(SERVICES) >= 8


def test_every_service_operation_is_a_service_run():
    untagged = []
    for path in SERVICES:
        tree = ast.parse(path.read_text(), str(path))
        for call in _calls(tree, 'operation'):
            kw = _keywords(call)
            kind = kw.get('kind')
            ref = kw.get('ref')
            ok = (isinstance(kind, ast.Constant) and kind.value == 'service-run'
                  and isinstance(ref, ast.Call) and getattr(ref.func, 'id', None) == 'service_source')
            if not ok:
                untagged.append(f'{path.name}:{call.lineno}')
        for call in _calls(tree, 'finish_draft'):
            if 'service_id' not in _keywords(call):
                untagged.append(f'{path.name}:{call.lineno} (finish_draft without service_id)')
    assert not untagged, untagged


def test_finish_draft_writes_under_a_service_run(monkeypatch):
    import plaid_client.workflows.umr.write as write
    from plaid_client.testing import FakeClient
    from plaid_client.workflows.requester import Requester

    class _Helper:
        def progress(self, *a, **k): pass
        def complete(self, *a): pass
        def critical(self): return contextlib.nullcontext()

    class _Progress:
        def report(self, *a, **k): pass

    class _Document:
        sentences = []

    # Only the operation is under test: the version check and the graph
    # writes it wraps are the umr workflow's own tests' business.
    monkeypatch.setattr(write, 'locked_for_writes', lambda *a, **k: contextlib.nullcontext())
    monkeypatch.setattr(write, 'write_graphs', lambda *a, **k: None)
    client = FakeClient({})
    run = write.DraftRun(document_id='d1', project_id='p1', read_version=1, layers=None,
                         document=_Document(), progress=_Progress(), targets=[], skipped=0,
                         kept=0, linked=0, taken=set(), requester=Requester())
    write.finish_draft(client, _Helper(), run, [{'sentence': None}], [], {}, operation='UMR draft',
                       writing='Writing', service_id='umr:draft:x')
    assert client.operation_tags == [{'kind': 'service-run', 'ref': 'service:umr:draft:x'}]

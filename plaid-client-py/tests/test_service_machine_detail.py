"""Every bundled service names, on everything it writes as machine output,
what made the prediction and which version of the service made it
(``provDetail.model`` and ``provDetail.version``, see the core manual's
"Provenance"), so a record can be traced to the model and the code or prompt
behind it.

The detail is built in one place, ``machine_detail``, and the version is the
service file's own (``service_version``). The services are plain scripts with
heavy imports (whisper, stanza), so the check that each one goes through the
helper reads them, like ``test_service_operation_kind.py``. Each service's own
suite checks what a run really writes."""

import ast
import hashlib
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))

ROOT = Path(__file__).resolve().parents[2]
SERVICES = sorted(p for app in ('plaid-igt', 'plaid-ud', 'plaid-umr')
                  for p in (ROOT / app / 'services').glob('*.py'))

# A writer made of rules the service itself holds has no model to name: its
# version says everything.
NO_MODEL = {'umr_bootstrap_igt.py'}
# Scores a model class puts on its output before the service wraps them in
# machine_detail, in the same file, before anything is written.
WRAPPED_LATER = {('igt_transcribe_whisper.py', 'transcribe_with_alignments')}
# A service whose output is a report in metadata, not a stamped annotation.
REPORTS = {'umr_ancast.py'}


def _called(node):
    f = node.func
    return f.attr if isinstance(f, ast.Attribute) else getattr(f, 'id', None)


def _functions(tree):
    """Each node with the name of the function it is in."""
    out = []

    def walk(node, fn):
        for child in ast.iter_child_nodes(node):
            name = child.name if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)) else fn
            out.append((child, name))
            walk(child, name)
    walk(tree, None)
    return out


def _built_by_helper(expr, assigned) -> bool:
    """``expr`` is a machine_detail call, contains one, or is a name some
    assignment in the file gave one."""
    for node in ast.walk(expr):
        if isinstance(node, ast.Call) and _called(node) == 'machine_detail':
            return True
        if isinstance(node, ast.Name) and any(_built_by_helper(v, {}) for v in assigned.get(node.id, [])):
            return True
    return False


def _stamp_sites(tree):
    """(detail expression or None, line, function) for every place a service
    hands provenance detail to a write."""
    for node, fn in _functions(tree):
        if isinstance(node, ast.Call):
            kw = {k.arg: k.value for k in node.keywords}
            if _called(node) in ('stamp_inferred', 'confirmed_inferred'):
                yield kw.get('detail'), node.lineno, fn
            elif 'prov_detail' in kw:
                yield kw['prov_detail'], node.lineno, fn
            elif _called(node) == 'write_analyses':
                # (client, plans, gloss_layer_id, morph_layer_id, source, detail, ...)
                yield kw.get('detail', node.args[5] if len(node.args) > 5 else None), node.lineno, fn
        elif isinstance(node, ast.Dict):
            for k, v in zip(node.keys, node.values):
                if (isinstance(k, ast.Name) and k.id == 'PROV_DETAIL_KEY') or \
                        (isinstance(k, ast.Constant) and k.value == 'provDetail'):
                    yield v, node.lineno, fn


def _assignments(tree):
    out = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    out.setdefault(t.id, []).append(node.value)
    return out


def test_there_are_services_to_check():
    assert len(SERVICES) >= 9


def test_every_stamp_a_service_writes_is_built_by_machine_detail():
    bare = []
    for path in SERVICES:
        tree = ast.parse(path.read_text(), str(path))
        assigned = _assignments(tree)
        for detail, line, fn in _stamp_sites(tree):
            if (path.name, fn) in WRAPPED_LATER:
                continue
            if detail is None or not _built_by_helper(detail, assigned):
                bare.append(f'{path.name}:{line}')
    assert not bare, bare


def test_every_service_that_writes_machine_output_names_its_model():
    missing = []
    for path in SERVICES:
        if path.name in REPORTS:
            continue
        tree = ast.parse(path.read_text(), str(path))
        calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and _called(n) == 'machine_detail']
        if not calls:
            missing.append(f'{path.name}: no machine_detail')
        for call in calls:
            model = next((k.value for k in call.keywords if k.arg == 'model'), None)
            expanded = any(k.arg is None for k in call.keywords)
            said = expanded or (model is not None and not (isinstance(model, ast.Constant) and model.value is None))
            if not said and path.name not in NO_MODEL:
                missing.append(f'{path.name}:{call.lineno}')
    assert not missing, missing


def test_a_report_names_the_service_version():
    for name in REPORTS:
        text = next(p for p in SERVICES if p.name == name).read_text()
        assert 'serviceVersion' in text and 'self.version' in text, name


# --- the helpers ----------------------------------------------------------------

def test_the_version_is_the_client_release_and_a_hash_of_the_file(tmp_path):
    from plaid_client.service import service_version, CLIENT_VERSION
    f = tmp_path / 'svc.py'
    f.write_bytes(b'print(1)\n')
    digest = hashlib.sha256(b'print(1)\n').hexdigest()[:8]
    assert service_version(str(f)) == f'{CLIENT_VERSION}+{digest}'
    f.write_bytes(b'print(2)\n')
    assert service_version(str(f)).split('+')[1] != digest


def test_a_service_knows_its_own_version():
    from plaid_client import BaseService
    from plaid_client.service import service_version

    class Svc(BaseService):
        def process_request(self, request_data, response_helper):
            pass

    assert Svc('s', 'S', 'd').version == service_version(__file__)


def test_machine_detail_names_the_model_and_version_first():
    from plaid_client.service import machine_detail
    assert machine_detail('1+ab', model='m', language='x') == {'model': 'm', 'version': '1+ab', 'language': 'x'}
    assert machine_detail('1+ab', model=None) == {'version': '1+ab'}

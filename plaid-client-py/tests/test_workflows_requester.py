"""Who asked for a service run (``plaid_client.workflows.requester``).

The owner's ruling (umr-collab-service-requester): every app's services name
the requester in the History label and in what they store, through one helper.
The last test holds every bundled service in every app to it.
"""

import ast
import pathlib
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'src'))

from plaid_client.workflows import REQUESTED_BY, Requester, requester_of  # noqa: E402

REPO = pathlib.Path(__file__).resolve().parents[2]


class _Users:
    def __init__(self, users=None, error=None):
        self._users = users or {}
        self._error = error
        self.asked = []

    def get(self, user_id):
        self.asked.append(user_id)
        if self._error:
            raise self._error
        return self._users[user_id]


class _Client:
    def __init__(self, **kwargs):
        self.users = _Users(**kwargs)


def test_the_requester_is_named_by_display_name_in_the_label():
    client = _Client(users={'second@x.com': {'id': 'second@x.com', 'display_name': 'second'}})
    requester = requester_of(client, {'document_id': 'd1', 'requester_id': 'second@x.com'})

    assert requester == Requester(id='second@x.com', name='second')
    assert (requester.label('AnCast adjudication against lunch')
            == 'AnCast adjudication against lunch, requested by second')
    assert client.users.asked == ['second@x.com']


def test_what_a_run_stores_names_the_requester_by_id():
    requester = Requester(id='second@x.com', name='second')
    assert requester.record() == {'id': 'second@x.com', 'name': 'second'}
    assert requester.detail({'model': 'm'}) == {'model': 'm', REQUESTED_BY: 'second@x.com'}
    assert requester.detail() == {REQUESTED_BY: 'second@x.com'}


def test_a_requester_whose_name_cannot_be_read_is_named_by_id():
    client = _Client(error=RuntimeError('HTTP 500'))
    requester = requester_of(client, {'requester_id': 'second@x.com'})
    assert requester.label('Stanza UD parse (en)') == (
        'Stanza UD parse (en), requested by second@x.com')


def test_a_blank_display_name_falls_back_to_the_id():
    client = _Client(users={'second@x.com': {'id': 'second@x.com', 'display_name': ''}})
    assert requester_of(client, {'requester_id': 'second@x.com'}).name == 'second@x.com'


def test_with_nobody_asking_nothing_changes_and_nothing_is_read():
    client = _Client()
    for data in ({}, {'requester_id': None}, None):
        requester = requester_of(client, data)
        assert requester.label('UMR draft of sentence 3') == 'UMR draft of sentence 3'
        assert requester.record() is None
        assert requester.detail({'model': 'm'}) == {'model': 'm'}
    assert client.users.asked == []


def test_the_detail_it_is_given_is_not_changed_in_place():
    detail = {'model': 'm'}
    Requester(id='a@x.com', name='a').detail(detail)
    assert detail == {'model': 'm'}


# --- every service in every app ---------------------------------------------------

def _service_files():
    listed = subprocess.run(['git', 'ls-files', '*/services/*.py'], cwd=REPO,
                            capture_output=True, text=True, check=True).stdout.split()
    return [REPO / f for f in listed
            if '/tests/' not in f and '/probes/' not in f and (REPO / f).is_file()]


def _is_service(tree):
    return any(isinstance(node, ast.ClassDef)
               and any(getattr(b, 'id', None) == 'BaseService' for b in node.bases)
               for node in ast.walk(tree))


def _unlabeled_operations(tree):
    """Each ``.operation(...)`` whose label is not passed through
    ``requester.label``."""
    out = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                and node.func.attr == 'operation' and node.args):
            continue
        label = node.args[0]
        if isinstance(label, ast.Name):
            label = _assigned(tree, label.id) or label
        if not (isinstance(label, ast.Call) and isinstance(label.func, ast.Attribute)
                and label.func.attr == 'label'):
            out.append(node.lineno)
    return out


def _assigned(tree, name):
    for node in ast.walk(tree):
        if (isinstance(node, ast.Assign) and len(node.targets) == 1
                and getattr(node.targets[0], 'id', None) == name):
            return node.value
    return None


def test_every_bundled_service_names_its_requester():
    """A service opens its History entry through ``requester.label``, or
    drafts through ``begin_draft`` / ``finish_draft``, which do it for it."""
    files = _service_files()
    assert len(files) >= 9, files
    missing = []
    for path in files:
        source = path.read_text(encoding='utf-8')
        tree = ast.parse(source)
        if not _is_service(tree):
            continue
        rel = path.relative_to(REPO)
        if 'requester_of(' not in source and 'begin_draft(' not in source:
            missing.append(f'{rel}: never reads its requester')
        for line in _unlabeled_operations(tree):
            missing.append(f'{rel}:{line}: an operation label without the requester')
    assert missing == []

"""Every name ``plaid_client.workflows.umr`` exports has an importer outside it.

The package is shared by the assistant in plaid-agent and the bundled UMR
services, and its re-exports are the surface they reach for. A name exported
and never imported reads as part of that surface while nothing depends on it,
so this lists each export no Python file outside the package imports.

A use is a real import, read from the syntax tree: a name in
``from plaid_client.workflows.umr import ...``, or an attribute read on a name
bound to the package (``import plaid_client.workflows.umr as umr`` then
``umr.X``, ``from plaid_client.workflows import umr`` then ``umr.X``, or the
dotted ``plaid_client.workflows.umr.X``). A word in a comment, a string or a
local variable of the same name is not a use.
"""

import ast
import pathlib
import subprocess

import plaid_client.workflows.umr as umr

REPO = pathlib.Path(__file__).resolve().parents[2]
PACKAGE = 'plaid-client-py/src/plaid_client/workflows/umr/'
MODULE = 'plaid_client.workflows.umr'
SUBMODULES = {'graph', 'inventory', 'layers', 'penman', 'write'}


def _dotted(node):
    """``a.b.c`` for an attribute chain over a name, else None."""
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if not isinstance(node, ast.Name):
        return None
    parts.append(node.id)
    return '.'.join(reversed(parts))


def imported_names(source):
    """The names ``source`` imports from the package, by any of the routes
    the module docstring lists."""
    tree = ast.parse(source)
    used = set()
    aliases = set()  # names bound to the package itself
    dotted_import = False
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.level == 0:
            if node.module == MODULE:
                used.update(a.name for a in node.names)
            elif node.module == 'plaid_client.workflows':
                aliases.update(a.asname or a.name for a in node.names if a.name == 'umr')
        elif isinstance(node, ast.Import):
            for a in node.names:
                if a.name == MODULE:
                    if a.asname:
                        aliases.add(a.asname)
                    else:
                        dotted_import = True
    for node in ast.walk(tree):
        if not isinstance(node, ast.Attribute):
            continue
        base = _dotted(node.value)
        if base in aliases or (dotted_import and base == MODULE):
            used.add(node.attr)
    return used


def outside_imports():
    files = subprocess.run(['git', 'ls-files', '*.py'], cwd=REPO, capture_output=True,
                           text=True, check=True).stdout.split()
    used = set()
    for f in files:
        path = REPO / f
        if f.startswith(PACKAGE) or not path.is_file():
            continue
        used |= imported_names(path.read_text(encoding='utf-8'))
    return used


def test_a_name_that_is_only_mentioned_is_not_imported():
    source = '\n'.join([
        '"""graph_text is described here."""',
        'CONCEPTS = 1  # NODES',
        'graph_text = "Child"',
        'from plaid_client.workflows.umr import resolve_layers',
        'from plaid_client.workflows.umr.inventory import KNOWN_RELATIONS',
        'import plaid_client.workflows.umr as u',
        'u.read_document',
        'from plaid_client.workflows import umr as w',
        'w.penman_of',
        'import plaid_client.workflows.umr',
        'plaid_client.workflows.umr.roots_of',
        'other.parse_penman',
    ])
    assert imported_names(source) == {'resolve_layers', 'read_document', 'penman_of',
                                      'roots_of'}


def test_every_export_is_imported_outside_the_package():
    used = outside_imports()
    assert sorted(set(umr.__all__) - SUBMODULES - used) == []


def test_every_export_is_importable():
    assert [name for name in umr.__all__ if not hasattr(umr, name)] == []

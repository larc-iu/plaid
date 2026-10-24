import sys
from pathlib import Path

import handwrite as h
import udplan

sys.path.insert(0, str(Path(__file__).parent))
from _hard_refs import RUSSIAN_FEM  # noqa: E402


def fem(refs_by_doc):
    return [('set_feature', {'document': d, 'refs': refs, 'feature': 'Gender', 'value': 'Fem'})
            for d, refs in refs_by_doc.items()]


def right(ctx):
    udplan.apply(ctx, fem(RUSSIAN_FEM))


def wrong_masculine_too(ctx):
    # Every form of the adjective, the masculine الروسي as well.
    udplan.apply(ctx, fem({'Arabic 1': RUSSIAN_FEM['Arabic 1'],
                           'Arabic 2': RUSSIAN_FEM['Arabic 2'] + ['s8.w16', 's10.w4']}))


def wrong_bundle_dropped(ctx):
    udplan.apply(ctx, [('set_field', {'document': d, 'refs': refs, 'field': 'features', 'value': 'Gender=Fem'})
                       for d, refs in RUSSIAN_FEM.items()])


def wrong_open_document_only(ctx):
    udplan.apply(ctx, fem({'Arabic 2': RUSSIAN_FEM['Arabic 2']}))


def wrong_nothing(ctx):
    return h.no_plan()

import sys
from pathlib import Path

import handwrite as h
import udplan

sys.path.insert(0, str(Path(__file__).parent))
from _corpus_refs import LA  # noqa: E402


def right(ctx):
    udplan.apply(ctx, [('set_field', {'document': d, 'refs': refs, 'field': 'lemma', 'value': 'le'})
                       for d, refs in LA.items()])


def wrong_blind_replace(ctx):
    # Every lemma "la", the Spanish X word in French 2 too.
    udplan.apply(ctx, [('replace_in_field', {'field': 'lemma', 'pattern': 'la', 'replacement': 'le',
                                             'whole': True, 'case_sensitive': True})])


def wrong_one_document(ctx):
    udplan.apply(ctx, [('set_field', {'document': 'French 1', 'refs': LA['French 1'], 'field': 'lemma',
                                      'value': 'le'})])


def wrong_nothing(ctx):
    return h.no_plan()

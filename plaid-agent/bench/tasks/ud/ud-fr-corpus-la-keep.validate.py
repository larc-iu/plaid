import sys
from pathlib import Path

import common as c
import handwrite as h
import udplan

sys.path.insert(0, str(Path(__file__).parent))
from _corpus_refs import LA  # noqa: E402


def _spanish(ctx):
    """The address of the Spanish "la" (UPOS X, lemma "la") in French 2."""
    d = h.doc_of(ctx, 'French 2')
    v = c.ud_values(ctx.client.documents.get(d['id'], include_body=True))
    [w] = [k[:-len(':upos')] for k, x in v.items() if k.startswith('s2.') and k.endswith(':upos') and x == 'X'
           and v.get(k[:-len(':upos')] + ':lemma') == 'la']
    return w


def right(ctx):
    # Each determiner by name, the Spanish word untouched: what a replace
    # with a keep on that word writes.
    udplan.apply(ctx, [('set_field', {'document': d, 'refs': refs, 'field': 'lemma', 'value': 'le'})
                       for d, refs in LA.items()])


def wrong_keep_loses(ctx):
    # The replace rewrote the kept word too.
    right(ctx)
    h.set_span(ctx, 'French 2', f'{_spanish(ctx)}:lemma', 'le')


def wrong_restamped(ctx):
    # The word keeps "la", but a restating write stamped it as the plan's.
    right(ctx)
    h.set_span(ctx, 'French 2', f'{_spanish(ctx)}:lemma', 'la')


def wrong_one_document(ctx):
    udplan.apply(ctx, [('set_field', {'document': 'French 1', 'refs': LA['French 1'], 'field': 'lemma',
                                      'value': 'le'})])


def wrong_nothing(ctx):
    return h.no_plan()

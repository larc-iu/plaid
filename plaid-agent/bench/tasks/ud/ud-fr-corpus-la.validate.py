import sys
from pathlib import Path

import handwrite as h
import udplan

sys.path.insert(0, str(Path(__file__).parent))
from _corpus_refs import LA  # noqa: E402


def right(ctx):
    udplan.apply(ctx, [('set_field', {'document': d, 'refs': refs, 'field': 'lemma', 'value': 'le'})
                       for d, refs in LA.items()])


def wrong_guideline_drafted_unasked(ctx):
    # The convention the user states, drafted as a guideline beside the fix
    # (glm53-1's draft, BL-BENCH2 2).
    right(ctx)
    h.add_guideline(ctx, 'Definite article lemma',
                    "Every form of the definite article (le, la, l', les) takes the lemma le, whatever its "
                    'capitalization. This applies to the determiner only.')


def wrong_blind_replace(ctx):
    # Every lemma "la", the Spanish X word in French 2 too.
    udplan.apply(ctx, [('replace_in_field', {'field': 'lemma', 'pattern': 'la', 'replacement': 'le',
                                             'whole': True, 'case_sensitive': True})])


def wrong_one_document(ctx):
    udplan.apply(ctx, [('set_field', {'document': 'French 1', 'refs': LA['French 1'], 'field': 'lemma',
                                      'value': 'le'})])


def wrong_nothing(ctx):
    return h.no_plan()

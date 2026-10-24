import sys
from pathlib import Path

import udplan

sys.path.insert(0, str(Path(__file__).parent))
from _corpus_refs import LA  # noqa: E402


def setup(ctx):
    # The same planted error as ud-fr-corpus-la.
    udplan.plant(ctx, [('set_field', {'document': d, 'refs': refs, 'field': 'lemma', 'value': 'la'})
                       for d, refs in LA.items()])

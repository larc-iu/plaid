import sys
from pathlib import Path

import udplan

sys.path.insert(0, str(Path(__file__).parent))
from _corpus_refs import IMP  # noqa: E402


def setup(ctx):
    udplan.plant(ctx, [('set_feature', {'document': d, 'refs': refs, 'feature': 'Aspect', 'value': 'Impf'})
                       for d, refs in IMP.items()])

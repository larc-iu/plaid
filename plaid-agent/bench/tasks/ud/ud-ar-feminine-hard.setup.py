import sys
from pathlib import Path

import udplan

sys.path.insert(0, str(Path(__file__).parent))
from _hard_refs import RUSSIAN_FEM  # noqa: E402


def setup(ctx):
    udplan.plant(ctx, [('set_feature', {'document': d, 'refs': refs, 'feature': 'Gender', 'value': 'Masc'})
                       for d, refs in RUSSIAN_FEM.items()])

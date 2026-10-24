import sys
from pathlib import Path

import udplan

sys.path.insert(0, str(Path(__file__).parent))
from _corpus_refs import IMP  # noqa: E402

BYT = {'Russian 1': ['s9.w23', 's17.w30', 's19.w73'],
       'Russian 2': ['s4.w2', 's7.w2', 's8.w6', 's12.w1', 's12.w12', 's18.w2'],
       'Russian 3': ['s3.w11', 's15.w4']}


def setup(ctx):
    udplan.plant(ctx, [('set_feature', {'document': d, 'refs': refs, 'feature': 'Aspect', 'value': 'Impf'})
                       for d, refs in IMP.items()]
                 + [('set_field', {'document': d, 'refs': refs, 'field': 'upos', 'value': 'VERB'})
                    for d, refs in BYT.items()])

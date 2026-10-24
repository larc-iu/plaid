import importlib.util
from pathlib import Path

import handwrite as h
import udplan

_spec = importlib.util.spec_from_file_location('passive_setup', Path(__file__).with_name('ud-ru-passive-subj-hard.setup.py'))
_setup = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_setup)


def _fix(*groups, extra=()):
    calls = [('set_head', {'document': d, 'ref': ref, 'head': head, 'deprel': 'nsubj:pass'})
             for g in groups for d, words in g.items() for ref, head in words]
    return calls + list(extra)


def right(ctx):
    udplan.apply(ctx, _fix(_setup.PLANTED, _setup.NATURAL))


def wrong_planted_only(ctx):
    # The four the setup broke, not the three the treebank had wrong already.
    udplan.apply(ctx, _fix(_setup.PLANTED))


def wrong_mid_too(ctx):
    # The reflexive passive стрельба производится relabelled as well.
    udplan.apply(ctx, _fix(_setup.PLANTED, _setup.NATURAL, extra=[
        ('set_head', {'document': 'Russian 1', 'ref': 's9.w16', 'head': 17, 'deprel': 'nsubj:pass'})]))


def wrong_nothing(ctx):
    return h.no_plan()

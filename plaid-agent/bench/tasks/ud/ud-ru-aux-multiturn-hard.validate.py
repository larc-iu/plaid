import importlib.util
from pathlib import Path

import handwrite as h
import udplan

_spec = importlib.util.spec_from_file_location('aux_setup', Path(__file__).with_name('ud-ru-aux-multiturn-hard.setup.py'))
_setup = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_setup)
BYT = _setup.BYT


def aux(docs):
    return [('set_field', {'document': d, 'refs': BYT[d], 'field': 'upos', 'value': 'AUX'}) for d in docs]


def right(ctx):
    udplan.apply(ctx, aux(['Russian 2']))


def wrong_turn_one_plan(ctx):
    # The first request, as if the correction had not been heard.
    udplan.apply(ctx, aux(['Russian 1', 'Russian 2', 'Russian 3']))


def wrong_some(ctx):
    udplan.apply(ctx, [('set_field', {'document': 'Russian 2', 'refs': BYT['Russian 2'][:4], 'field': 'upos',
                                      'value': 'AUX'})])


def wrong_nothing(ctx):
    return h.no_plan()

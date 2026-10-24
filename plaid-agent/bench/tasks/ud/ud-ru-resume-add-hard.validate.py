import importlib.util
import sys
from pathlib import Path

import handwrite as h
import udplan

sys.path.insert(0, str(Path(__file__).parent))
from _corpus_refs import IMP  # noqa: E402

_spec = importlib.util.spec_from_file_location('resume_setup', Path(__file__).with_name('ud-ru-resume-add-hard.setup.py'))
_setup = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_setup)

ASPECT = [('replace_in_field', {'field': 'features', 'pattern': 'Aspect=Impf', 'replacement': 'Aspect=Imp',
                                'whole': True})]
AUX = [('set_field', {'document': d, 'refs': refs, 'field': 'upos', 'value': 'AUX'})
       for d, refs in _setup.BYT.items()]


def right(ctx):
    udplan.apply(ctx, ASPECT + AUX)


def wrong_turn_two_only(ctx):
    # The incident: turn 2 staged only the быть fix, which replaced the
    # waiting card, so the approval wrote that alone.
    udplan.apply(ctx, AUX)


def wrong_turn_one_only(ctx):
    udplan.apply(ctx, ASPECT)


def wrong_aux_one_document(ctx):
    udplan.apply(ctx, ASPECT + [c for c in AUX if c[1]['document'] == 'Russian 2'])


def wrong_extra(ctx):
    # Both fixes, and the participle написан beside был in Russian 2 s4 made AUX too.
    udplan.apply(ctx, ASPECT + AUX + [('set_field', {'document': 'Russian 2', 'refs': ['s4.w3'], 'field': 'upos',
                                                     'value': 'AUX'})])


def wrong_nothing(ctx):
    return h.no_plan()

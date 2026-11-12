import sys
from pathlib import Path

import handwrite as h
import udplan

sys.path.insert(0, str(Path(__file__).parent))
from _hard_refs import ART  # noqa: E402


def right(ctx):
    udplan.apply(ctx, [('set_feature', {'document': d, 'refs': refs, 'feature': 'PronType', 'value': 'Art'})
                       for d, refs in ART.items()])


def wrong_blind_replace(ctx):
    # Every PronType=Dem, the 10 real demonstratives too.
    udplan.apply(ctx, [('replace_in_field', {'field': 'features', 'pattern': 'PronType=Dem',
                                             'replacement': 'PronType=Art', 'case_sensitive': True})])


def wrong_two_documents(ctx):
    udplan.apply(ctx, [('set_feature', {'document': d, 'refs': ART[d], 'feature': 'PronType', 'value': 'Art'})
                       for d in ('French 1', 'French 2')])


def wrong_one_missed(ctx):
    left = dict(ART, **{'French 3': ART['French 3'][:-1]})
    udplan.apply(ctx, [('set_feature', {'document': d, 'refs': refs, 'feature': 'PronType', 'value': 'Art'})
                       for d, refs in left.items()])


def wrong_nothing(ctx):
    return h.no_plan()


def right_with_guideline(ctx):
    # The convention drafted as a guideline (glm53-stretch-2 rep 1's draft).
    right(ctx)
    h.add_guideline(ctx, 'Articles vs demonstratives',
                    'French articles take **PronType=Art**, never Dem:\n\n- definite articles (*le, la, les, l\'*) '
                    'carry `Definite=Def`\n- indefinite (*un, une*) and partitive (*du*) carry `Definite=Ind`\n\nThe '
                    'true demonstratives (*ce, cette, ceux, celui*, ...) take **PronType=Dem** and carry no Definite '
                    'feature.')


def wrong_guideline_off(ctx):
    # The fix, and a guideline about something else.
    right(ctx)
    h.add_guideline(ctx, 'Article lemmas', 'Every form of the definite article has the lemma le.')

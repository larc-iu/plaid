import handwrite as h
import igtlib as L

S4 = {'s4.w1.m1': 'ii|CCNJ', 's4.w2.m1': 'hasak̲|want', 's4.w2.m2': 't|3.II', 's4.w3.m1': 'dim|PROSP',
      's4.w3.m2': 't|3.I', 's4.w4.m1': 'mehl|tell', 's4.w4.m2': 'i|T', 's4.w4.m3': 'hl|CN',
      's4.w5.m1': 'wila|MANR', 's4.w6.m1': 'wil|LVB', 's4.w6.m2': 't|3.II', 's4.w7.m1': 'win|COMP',
      's4.w8.m1': 'yukw|IPFV', 's4.w8.m2': 'hl|CN', 's4.w9.m1': 'silin|hunt', 's4.w9.m2': 'asxw|ANTIP',
      's4.w9.m3': 't|3.II'}


def _link_all(ctx, table):
    by = {}
    for ref, lab in table.items():
        by.setdefault(lab, []).append(ref)
    for lab, refs in by.items():
        L.link(ctx, 'Gitksan text 1', refs, lab)


def right(ctx):
    _link_all(ctx, S4)


def wrong_headwords(ctx):
    # Multi-sense entries linked at the headword.
    _link_all(ctx, {r: (lab.split('|')[0] + '|' if lab.split('|')[0] in ('t', 'i', 'wil') else lab)
                    for r, lab in S4.items()})


def wrong_wrong_sense(ctx):
    _link_all(ctx, dict(S4, **{'s4.w3.m2': 't|3.II'}))


def wrong_missing(ctx):
    _link_all(ctx, {r: lab for r, lab in S4.items() if r != 's4.w9.m3'})


def wrong_collateral(ctx):
    _link_all(ctx, dict(S4, **{'s5.w1.m1': 'ii|CCNJ'}))


def wrong_unstamped(ctx):
    by = {}
    for ref, lab in S4.items():
        by.setdefault(lab, []).append(ref)
    for lab, refs in by.items():
        L.link(ctx, 'Gitksan text 1', refs, lab, verified=False)


def wrong_nothing(ctx):
    return h.no_plan()

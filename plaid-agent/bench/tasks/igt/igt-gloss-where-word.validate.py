import handwrite as h
import igtlib as L

FIX = {'Gitksan text 1': {'s1.w7.m1': 'LVB'}, 'Gitksan text 2': {'s6.w9.m1': 'LVB'},
       'Gitksan text 3': {'s1.w3.m1': 'LVB'}}


def right(ctx):
    for doc, values in FIX.items():
        L.set_field(ctx, doc, values)


def wrong_one_text_only(ctx):
    L.set_field(ctx, 'Gitksan text 1', FIX['Gitksan text 1'])


def wrong_every_comp(ctx):
    # The condition dropped: COMP on win changed too.
    right(ctx)
    L.set_field(ctx, 'Gitksan text 1', {'s4.w7.m1': 'LVB', 's9.w3.m1': 'LVB'})


def wrong_both_morphemes(ctx):
    right(ctx)
    L.set_field(ctx, 'Gitksan text 1', {'s1.w7.m2': 'LVB'})


def wrong_nothing(ctx):
    return h.no_plan()

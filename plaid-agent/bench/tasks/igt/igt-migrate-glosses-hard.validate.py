import common as c
import handwrite as h
import igtlib as L
from igt_changes import relabel

MAP = {'SUBR': 'SBRD', 'RL': 'REAL', 'COS': 'CS', 'NMLZ1': 'NMLZ', 'PREP': 'ADP', 'PFV': 'PRF', '3AUG': '3NSG',
       'IRR': 'IRLS', 'INTS': 'INT', 'MID': 'MDL', 'APPL': 'APL', '1MINI': '1MIN'}


def _change(ctx, new_of, skip_doc=None):
    for d in ctx.project['documents']:
        if d['name'] == skip_doc:
            continue
        v = c.igt_values(L.raw(ctx, d['name']))
        refs = {}
        for k, x in v.items():
            if k.endswith(':Gloss'):
                new = new_of(x)
                if new != x:
                    refs[k[:-len(':Gloss')]] = new
        L.set_field(ctx, d['name'], refs)


def right(ctx):
    # With the lexicon glosses renamed the same way, which the task allows
    # (without them it passes too).
    _change(ctx, lambda x: relabel(x, MAP))
    for it in L.vocab_items(ctx.client, ctx.project['vocabs'][0]['id']):
        g = (it.get('metadata') or {}).get('gloss')
        if isinstance(g, str) and relabel(g, MAP) != g:
            L.patch_entry(ctx, L.label(it), {'gloss': relabel(g, MAP)})


def wrong_substring_3aug(ctx):
    # A plain substring replace: 3AUGIS, 3AUGII and 3AUGIA become 3NSGIS and so on.
    def sub(x):
        for old, new in MAP.items():
            x = x.replace(old, new) if isinstance(x, str) else x
        return x
    _change(ctx, sub)


def wrong_eleven(ctx):
    # The last plan dropped one of the twelve.
    _change(ctx, lambda x: relabel(x, {k: v for k, v in MAP.items() if k != 'MID'}))


def wrong_only_the_last(ctx):
    # Each turn's plan replaced the one before, and only the last rename was applied.
    _change(ctx, lambda x: relabel(x, {'1MINI': '1MIN'}))


def wrong_one_text_missed(ctx):
    _change(ctx, lambda x: relabel(x, MAP), skip_doc='Natugu text 3')


def wrong_nothing(ctx):
    return h.no_plan()

import common as c
import handwrite as h
import igtlib as L

T1 = 'Gitksan text 1'
TRANSLATIONS = {'s1': 'When I was young, our relative who lives in Gitsegyukla came over.',
                's17': 'And we asked him what he had done.'}


def _conj(ctx):
    for d in ctx.project['documents']:
        v = c.igt_values(L.raw(ctx, d['name']))
        L.set_field(ctx, d['name'], {k[:-6]: 'CONJ' for k, x in v.items() if k.endswith(':Gloss') and x == 'CCNJ'})


def right(ctx):
    _conj(ctx)


def wrong_turn_one_plan(ctx):
    # The waiting card approved as it stood: the translations went in too.
    _conj(ctx)
    L.set_field(ctx, T1, TRANSLATIONS, field='Translation')


def wrong_one_translation_kept(ctx):
    _conj(ctx)
    L.set_field(ctx, T1, {'s17': TRANSLATIONS['s17']}, field='Translation')


def wrong_translations_only(ctx):
    L.set_field(ctx, T1, TRANSLATIONS, field='Translation')


def wrong_nothing(ctx):
    return h.no_plan()

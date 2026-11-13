import common as c
import handwrite as h
import igtlib as L

OFFER = ('All 49 hl morphemes, in the three texts, are glossed CN: the plan holds 49 changes. That hl is always '
         'CN is a convention of the whole project, and I can write it into the guidelines if you want.')


def _fill(ctx):
    for d in ctx.project['documents']:
        v = c.igt_values(L.raw(ctx, d['name']))
        L.set_field(ctx, d['name'], {k[:-5]: 'CN' for k, x in v.items()
                                     if k.endswith(':form') and str(x).lower() == 'hl'})


def _said(text):
    conv = h.applied_plan()
    conv['display'][-1]['text'] = text
    return conv


def right(ctx):
    _fill(ctx)
    return _said(OFFER)


def wrong_guideline_drafted_unasked(ctx):
    _fill(ctx)
    h.add_guideline(ctx, 'The connective hl', 'The common noun connective hl is always glossed CN.')
    return _said('The plan holds 50 changes: the 49 glosses, and a guideline that hl is glossed CN.')


def wrong_no_offer(ctx):
    _fill(ctx)
    return _said('All 49 hl morphemes are glossed CN: the plan holds 49 changes.')


def right_asks(ctx):
    # rep 2 of glm53-stretch-3, and the prompt's own words since BENCH-FIX.
    _fill(ctx)
    return _said('The plan holds 49 changes. Want me to add it to the project guidelines? I haven\'t staged '
                 'anything for that.')


def wrong_mentions_without_offering(ctx):
    _fill(ctx)
    return _said('All 49 hl morphemes are glossed CN: the plan holds 49 changes. Nothing is staged for the '
                 'guidelines.')


def right_offers_and_waits(ctx):
    # REV-JG3-11: an offer that is not a question.
    _fill(ctx)
    return _said('The plan holds 49 changes. I can also write this convention into the guidelines: just say so.')


def right_asks_in_other_words(ctx):
    _fill(ctx)
    return _said('The plan holds 49 changes. Should I add that hl is always CN to the guidelines?')


def wrong_mentions_in_passing(ctx):
    # REV-JG3-11: names the guidelines and says "if you", and offers nothing.
    _fill(ctx)
    return _said('The plan holds 49 changes. Nothing was added to the guidelines, if you were wondering.')


def wrong_nothing(ctx):
    return h.no_plan()

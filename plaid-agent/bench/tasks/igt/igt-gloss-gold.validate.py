import common as c
import handwrite as h
import igtlib as L
from igt_gold import _analyses

DOC = 'Gitksan text 2'
SENTENCES = {1, 2, 3, 4, 5}


def _gold(ctx):
    doc = next(d for d in ctx.project['documents'] if d['name'] == DOC)
    return _analyses(c.igt_values(c.baseline(doc['id'])), SENTENCES, 'Gloss')


def _write(ctx, analyses):
    for w, ms in analyses.items():
        if ms:
            L.analyze(ctx, DOC, w, ms)


def right(ctx):
    # The gold itself: score 1.
    _write(ctx, _gold(ctx))


def right_partly(ctx):
    # The gold for sentences 1 to 4, and sentence 5 left whole with its
    # glosses run together: past the 0.5 a pass needs, short of 1.
    gold = _gold(ctx)
    out = {}
    for w, ms in gold.items():
        if w.startswith('s5.') and len(ms) > 1:
            out[w] = [(''.join(f for f, _ in ms), '.'.join(g or '' for _, g in ms))]
        else:
            out[w] = ms
    _write(ctx, out)


def wrong_unsegmented(ctx):
    # Every word one morpheme, and no gloss right.
    gold = _gold(ctx)
    _write(ctx, {w: [(''.join(f for f, _ in ms), 'X')] for w, ms in gold.items() if ms})


def wrong_glosses(ctx):
    # The right segmentation, every gloss a guess.
    gold = _gold(ctx)
    _write(ctx, {w: [(f, 'X') for f, _ in ms] for w, ms in gold.items()})


def wrong_right_with_collateral(ctx):
    # The gold, and a gloss changed in a sentence nobody asked about.
    right(ctx)
    L.set_field(ctx, DOC, {'s6.w1.m1': 'CHANGED'})


def wrong_nothing(ctx):
    return h.no_plan()

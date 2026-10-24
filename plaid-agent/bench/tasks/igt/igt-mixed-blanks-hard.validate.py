import handwrite as h
import igtlib as L

YUKW = {'Gitksan text 1': ['s1.w2.m1', 's4.w8.m1'], 'Gitksan text 2': ['s11.w2.m1']}
NII = {'Gitksan text 2': ['s5.w2.m1'], 'Gitksan text 3': ['s1.w1.m1']}


def _say(text, applied=True):
    return {'messages': [], 'display': [
        {'kind': 'user', 'text': '(validation)'},
        {'kind': 'assistant', 'text': text, 'status': 'applied' if applied else None,
         'plan': {'id': 'validation', 'proposed': [['validation']]} if applied else None}]}


def _fill(ctx, which, value):
    for doc, refs in which.items():
        L.set_field(ctx, doc, {r: value for r in refs})


def right(ctx):
    _fill(ctx, YUKW, 'IPFV')
    return _say("5 morphemes have no gloss: three yukw and two 'nii. I staged IPFV on the three yukw.")


def wrong_filled_nii(ctx):
    _fill(ctx, YUKW, 'IPFV')
    _fill(ctx, NII, 'on')
    return _say('5 morphemes had no gloss. I filled all of them.')


def wrong_count(ctx):
    _fill(ctx, YUKW, 'IPFV')
    return _say('3 morphemes have no gloss, all yukw. I staged IPFV on them.')


def wrong_one_text(ctx):
    # Only the open text's yukw.
    _fill(ctx, {'Gitksan text 2': ['s11.w2.m1']}, 'IPFV')
    return _say('5 morphemes have no gloss. I glossed the yukw IPFV.')


def wrong_answer_only(ctx):
    return _say('5 morphemes have no gloss.', applied=False)


def wrong_nothing(ctx):
    return h.no_plan()

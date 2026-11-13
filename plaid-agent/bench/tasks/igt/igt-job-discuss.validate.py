import igtlib as L

DOC = 'Gitksan text 1'
ASKED = 'What did the last assistant job leave undone?'
FIX = 'Gloss the word it left blank as shoot, as a single morpheme.'
BOTH = ('The job left guxw blank in sentence 20 of Gitksan text 1, and it left wila inconsistent: glossed '
        'MANR three times and like twice. It keeps no record of why.')


def _conv(first, second='Gloss planned for guxw.', applied=True):
    """The two turns: the answer, then a reply whose plan was approved (or
    none)."""
    return {'messages': [], 'display': [
        {'kind': 'user', 'text': ASKED},
        {'kind': 'assistant', 'text': first, 'status': None, 'plan': None},
        {'kind': 'user', 'text': FIX},
        {'kind': 'assistant', 'text': second, 'status': 'applied' if applied else None,
         'plan': {'id': 'validation', 'proposed': [['validation']]} if applied else None}]}


def right(ctx):
    L.analyze(ctx, DOC, 's20.w5', [('guxw', 'shoot')])
    return _conv(BOTH)


def right_linked(ctx):
    # The new morpheme linked to its entry as well, which the task allows.
    right(ctx)
    L.link(ctx, DOC, ['s20.w5.m1'], 'guxw|shoot')
    return _conv(BOTH)


def wrong_names_only_the_blank_word(ctx):
    L.analyze(ctx, DOC, 's20.w5', [('guxw', 'shoot')])
    return _conv('The job left guxw blank in sentence 20 of Gitksan text 1.')


def wrong_names_only_the_inconsistent_form(ctx):
    L.analyze(ctx, DOC, 's20.w5', [('guxw', 'shoot')])
    return _conv('The job left wila inconsistent.')


def wrong_named_only_in_the_second_reply(ctx):
    L.analyze(ctx, DOC, 's20.w5', [('guxw', 'shoot')])
    return _conv('The job ended without trouble.', second=BOTH)


def wrong_another_gloss(ctx):
    L.analyze(ctx, DOC, 's20.w5', [('guxw', 'hunt')])
    return _conv(BOTH)


def wrong_two_morphemes(ctx):
    L.analyze(ctx, DOC, 's20.w5', [('gu', 'shoot'), ('xw', 'PASS')])
    return _conv(BOTH)


def wrong_nothing_written(ctx):
    return _conv(BOTH, second='Shall I gloss it?', applied=False)


def wrong_wila_made_consistent_too(ctx):
    # The fix, and a gloss of the inconsistent form nobody asked for.
    right(ctx)
    L.set_field(ctx, DOC, {'s4.w5.m1': 'like'})
    return _conv(BOTH)

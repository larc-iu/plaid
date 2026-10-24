import umr_hand as u


def right(ctx):
    return u.answer('There are five chikari nodes, in sentences 1, 3, 8, 9 and 12 (the one in 12 is '
                    'already activity). Which one do you mean, or all of them?')


def wrong_planned_all(ctx):
    conv = u.answer('I planned :aspect activity on all four chikari nodes that are not activity yet. '
                    'Approve it?')
    conv['display'][-1]['plan'] = {'id': 'validation', 'proposed': [['x']] * 4}
    return conv


def wrong_applied_one(ctx):
    u.set_attr(ctx, 1, 's1c', ':aspect', 'activity')
    return u.answer('Which one did you mean? I changed the one in sentence 1 for now.')


def wrong_no_question(ctx):
    return u.answer('Done.')

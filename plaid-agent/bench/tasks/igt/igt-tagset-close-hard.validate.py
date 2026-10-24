import handwrite as h


def _say(text, plan=None, status=None):
    return {'messages': [], 'display': [{'kind': 'user', 'text': '(validation)'},
                                        {'kind': 'assistant', 'text': text, 'status': status, 'plan': plan}]}


def right(ctx):
    # The reply the tagsets tool now leads to: core named the values it
    # would refuse, mostly word glosses, so the assistant asks.
    return _say('Core would refuse 212 stored values if Leipzig were closed, most of them word glosses such as '
                '"fish" and "go". A closed list would have to list every word gloss. Do you want to keep it mixed, '
                'so tags are enforced and word glosses stay free?')


def wrong_closed_anyway(ctx):
    # The setting written as asked, without the rule core would refuse.
    p = ctx.client.projects.get(ctx.project['id'])
    t = dict(p['config']['igt']['tagsets']['Leipzig'], mode='closed')
    ctx.client.projects.set_config(ctx.project['id'], 'igt', 'tagsets', {'Leipzig': t})
    return _say('Leipzig is now closed.')


def wrong_planned(ctx):
    # A plan left for the user that core would refuse, with the right words.
    return _say('Closing it would refuse the word glosses, which are not on the list. I planned it anyway.',
                plan={'id': 'validation', 'proposed': [['Tagset "Leipzig": mode mixed → closed']]})


def wrong_silent(ctx):
    return h.no_plan()


_WARN = ('One effect before you approve: closed means every new gloss must be on the list, ordinary word glosses '
         'included, which are free now. If you would rather keep word glosses free, mixed mode does that.')


def _close(ctx, add=()):
    p = ctx.client.projects.get(ctx.project['id'])
    t = dict(p['config']['igt']['tagsets']['Leipzig'], mode='closed')
    t['values'] = list(t['values']) + [{'value': v} for v in add]
    ctx.client.projects.set_config(ctx.project['id'], 'igt', 'tagsets', {'Leipzig': t})


def right_plain_close(ctx):
    # The close planned and approved as asked, with the
    # warning about word glosses and mixed offered.
    _close(ctx)
    return _say(_WARN, plan={'id': 'validation', 'proposed': [['set_tagset', 'project', 'Leipzig']]},
                status='applied')


def wrong_close_no_offer(ctx):
    _close(ctx)
    return _say('Closing it refuses every new word gloss that is not on the list. Approve to close it.',
                plan={'id': 'validation', 'proposed': [['set_tagset', 'project', 'Leipzig']]}, status='applied')


def wrong_close_no_warning(ctx):
    _close(ctx)
    return _say('Leipzig is planned as closed. Mixed was its old mode.',
                plan={'id': 'validation', 'proposed': [['set_tagset', 'project', 'Leipzig']]}, status='applied')


def wrong_close_add_used(ctx):
    # The close with the used word glosses added to the list.
    _close(ctx, add=['fish', 'go'])
    return _say(_WARN, plan={'id': 'validation', 'proposed': [['set_tagset', 'project', 'Leipzig']]},
                status='applied')

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


_PLAN = {'id': 'validation', 'proposed': [['set_tagset', 'project', 'Leipzig']]}


def right_close_check_words(ctx):
    # The close, warned in the words of the check's line, mixed offered as a way back.
    _close(ctx)
    return _say('Leipzig is closed now. Closed, it refuses every new lowercase word gloss it does not list, and 879 '
                'of the 887 stored values off it hold one. I can switch it back to mixed if word glosses should stay '
                'free.', plan=_PLAN, status='applied')


def right_close_prefer(ctx):
    _close(ctx)
    return _say('Done. New word glosses such as "fish" will be rejected unless they are on the list. If you prefer '
                'mixed, say so.', plan=_PLAN, status='applied')


def wrong_close_recorded(ctx):
    # glm53-1's reply (BL-BENCH 8a): mixed named only as the old mode, and no
    # word about word glosses.
    _close(ctx)
    return _say('Done. The plan is staged. It holds one change: switch the **Leipzig** tagset on the **Gloss** field '
                'from *mixed* to **closed**, so once approved, only the 72 listed tags can be entered (new values '
                'outside the list get refused).\n\nI checked the current data first, and nothing blocks the close.',
                plan=_PLAN, status='applied')


def wrong_close_from_mixed(ctx):
    # The warning, but mixed is only the mode it leaves.
    _close(ctx)
    return _say('Leipzig goes from mixed to closed. Every new word gloss outside the list will be refused.',
                plan=_PLAN, status='applied')


def wrong_close_offer_no_warning(ctx):
    _close(ctx)
    return _say('Leipzig is closed now. Say if you would rather keep it mixed.', plan=_PLAN, status='applied')


def wrong_close_add_used(ctx):
    # The close with the used word glosses added to the list.
    _close(ctx, add=['fish', 'go'])
    return _say(_WARN, plan={'id': 'validation', 'proposed': [['set_tagset', 'project', 'Leipzig']]},
                status='applied')

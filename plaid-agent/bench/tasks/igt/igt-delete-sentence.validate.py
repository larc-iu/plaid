import igt_job_hand as H

DOC = 'Lezgi text 5'


def _plan(ctx, calls, conv=None):
    """``calls`` staged as the assistant stages them and applied as the
    user's approval applies them, and the conversation the record then
    holds (``conv`` with it): one more applied plan, a row per change."""
    from plaid_agent.igt.project import load_project
    from plaid_agent.igt.workspace import Workspace
    from plaid_agent.igt import toolkit
    ws = Workspace(ctx.user, load_project(ctx.user, ctx.project['id']))
    for name, args in calls:
        assert toolkit.call_tool(ws, name, args).startswith('Planned')
    rows = [[o['kind'], o.get('sentence_id') or o.get('token_id'), None] for o in ws.ops]
    H.staged(ctx, ctx.user, calls, stamp_mode='verified')
    conv = conv or {'messages': [], 'display': []}
    conv['display'] += [{'kind': 'user', 'text': '(validation)'},
                        {'kind': 'assistant', 'text': '(validation)', 'status': 'applied',
                         'plan': {'id': f'v{len(conv["display"])}', 'proposed': rows}}]
    return conv


def right(ctx):
    return _plan(ctx, [('delete_sentence', {'document': DOC, 'refs': ['s3']})])


def wrong_the_analysed_one(ctx):
    """Sentence 2 deleted: the text reads right, its analysis is lost."""
    return _plan(ctx, [('delete_sentence', {'document': DOC, 'refs': ['s2']})])


def wrong_merged_then_retyped(ctx):
    """The way round before delete_sentence, two plans: the copy merged
    into sentence 2, then the merged sentence retyped without it."""
    conv = _plan(ctx, [('merge_sentences', {'document': DOC, 'ref': 's3'})])
    return _plan(ctx, [('retype_sentence', {'document': DOC, 'ref': 's2', 'text': 'Вичин хва рекьиз кӀан жени ?'})],
                 conv)


def wrong_another_change(ctx):
    """The copy deleted, and a gloss changed besides."""
    return _plan(ctx, [('delete_sentence', {'document': DOC, 'refs': ['s3']}),
                       ('set_field', {'document': DOC, 'refs': ['s4.w1.m1'], 'field': 'Gloss', 'value': 'X'})])


def wrong_nothing(ctx):
    return {'messages': [], 'display': [{'kind': 'user', 'text': '(validation)'}]}

"""Write ud results by hand through the ud assistant's own plan tools, for a
task's setup (a planted error) or its validation (a right or wrong result).

`apply(ctx, calls)` builds a plan exactly as the assistant would, by calling
its tools (`set_field`, `set_head`, `set_words`, `split_sentence`, ...) on a
fresh Workspace as the task's user, and then applies it with the assistant's
own executor. `mode='verified'` stamps what an approved plan stamps,
`mode='human'` writes no stamp (a planted value, or "Record as human-made").

The checker never uses this code: it reads the document with checks/common.py,
so a bug in the executor shows up as a right result that fails validation.
"""
SOURCE = 'service:ud:assist:openai-glm-5.2'


class ToolRefused(Exception):
    pass


def apply(ctx, calls, mode='verified', client=None):
    from plaid_agent.ud.plan import execute_plan
    from plaid_agent.ud.project import load_project
    from plaid_agent.ud.toolkit import call_tool
    from plaid_agent.ud.tools import Workspace
    # The assistant keeps parsed documents per process, keyed by id and
    # version. validate.py and run.py's setups run many database copies in
    # one process, where the same id and version name different contents.
    Workspace.DOC_CACHE.clear()
    client = client or ctx.user
    project = load_project(client, ctx.project['id'])
    ws = Workspace(client, project)
    outs = []
    for name, args in calls:
        out = call_tool(ws, name, dict(args))
        outs.append(str(out)[:300])
        if str(out).lstrip().lower().startswith('error'):
            raise ToolRefused(f'{name} {args}: {out}')
    if not ws.ops:
        raise ToolRefused(f'nothing planned by {calls}: {outs}')
    with client.operation('bench handwrite'):
        return execute_plan(client, list(ws.ops), source=SOURCE, label='bench handwrite',
                            project=project, stamp_mode=mode)


def plant(ctx, calls):
    """A planted value: written by the task's user with no provenance stamp,
    as a person would have typed it.

    Applied as a verified plan and then unstamped, rather than with
    mode='human': a human-mode plan that draws a new relation is refused by
    the server (the executor sends `metadata: null`)."""
    out = apply(ctx, calls, mode='verified')
    unstamp(ctx)
    return out


def unstamp(ctx):
    """Remove the stamp this module writes from every span and relation of
    the project's documents."""
    from plaid_client import metadata_ops
    clear = metadata_ops({k: None for k in ('prov', 'provSource', 'provConfirmed', 'provProb', 'provDetail')})
    for d in ctx.project['documents']:
        doc = ctx.user.documents.get(d['id'], include_body=True)
        for tl in doc['text_layers']:
            for tk in tl['token_layers']:
                for sl in tk.get('span_layers') or []:
                    for sp in sl.get('spans') or []:
                        if (sp.get('metadata') or {}).get('provSource') == SOURCE:
                            ctx.user.spans.patch_metadata(sp['id'], clear)
                    for rl in sl.get('relation_layers') or []:
                        for r in rl.get('relations') or []:
                            if (r.get('metadata') or {}).get('provSource') == SOURCE:
                                ctx.user.relations.patch_metadata(r['id'], clear)

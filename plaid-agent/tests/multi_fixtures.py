"""Two projects one user can read, for each app: the app's fixture project as
the conversation's own, and a copy of it under another id and name as the
project the user added. The client is the app's own fake, given the other
projects (``plaid_client.testing.FakeClient(projects=, services=)``)."""

import copy

OTHER_ID, OTHER_NAME = 'px2', 'Second'

# Another project's manual: one pinned guideline whose body must never reach
# the prompt, and one plain one.
OTHER_GUIDELINES = [
    {'id': 'og1', 'title': 'Loanwords', 'pinned': True,
     'body': 'PINNED-FOREIGN-BODY: loanwords keep their source spelling.',
     'updated_at': '2026-09-10T09:00:00Z'},
    {'id': 'og2', 'title': 'Tense', 'pinned': False, 'body': 'Mark tense on the verb.',
     'updated_at': '2026-09-11T09:00:00Z'},
]


def other_project(project, documents, pid, name, guidelines=None, audit=None):
    """A second project shaped like ``project``, with its own id and name, and
    its documents under ids of their own (names kept, so a document named the
    same in two projects is told apart by the project), as the fake's
    ``projects=`` takes one."""
    p = copy.deepcopy(project)
    p['id'], p['name'] = pid, name
    docs = {}
    for did, doc in documents.items():
        d = copy.deepcopy(doc)
        d['id'] = f'{pid}-{did}'
        if 'project' in d:
            d['project'] = pid
        docs[d['id']] = d
    return {'project': p, 'documents': docs, 'guidelines': list(guidelines or []),
            'audit': list(audit or [])}


def _app(app):
    if app == 'igt':
        import fixtures as f
        from plaid_agent.igt.service import AssistantService
        return f, {'d1': f.document_raw()}, AssistantService, 'igt:assist:fake'
    if app == 'ud':
        import ud_fixtures as f
        from plaid_agent.ud.service import AssistantService
        return f, {'ud1': f.document_raw()}, AssistantService, 'ud:assist:fake'
    import umr_fixtures as f
    from plaid_agent.umr.service import AssistantService
    return f, {'umr1': f.document_raw()}, AssistantService, 'umr:assist:fake'


def service(app):
    _, _, cls, sid = _app(app)
    svc = cls()
    svc.service_id = sid
    return svc


def client(app, served=True, others=None, services=None, **home_kw):
    """The user's client: the fixture project, and ``Second`` beside it,
    served by this app's assistant unless ``served`` is False. ``others`` is
    ``{pid: other_project(...)}``."""
    f, docs, _, sid = _app(app)
    if others is None:
        # The home manual as well as its own, so a guideline tool finds the
        # same title in both and the difference is only the project.
        others = {OTHER_ID: other_project(f.project_raw(), docs, OTHER_ID, OTHER_NAME,
                                          guidelines=f.guidelines_raw() + OTHER_GUIDELINES,
                                          audit=f.audit_raw())}
    if services is None:
        services = {pid: [{'service_id': sid, 'online': True}] for pid in others} if served else {}
    return f.FakeClient(projects=others, services=services, **home_kw)


def reads_in(c, pid):
    """The document reads the client made in project ``pid``."""
    held = c.other_projects[pid]['documents'] if pid in (c.other_projects or {}) else c._documents
    return [r for r in c.reads if r['id'] in held]


def home_workspace(app, c):
    svc = service(app)
    project = svc.load_project(c, c.project['id'])
    return svc, svc.make_workspace(c, project, lambda msg: None)


def reached(app, joined=None, **kw):
    """``(service, client, home workspace, reach)`` with ``Second`` joined."""
    c = client(app, **kw)
    svc, ws = home_workspace(app, c)
    joined = joined if joined is not None else [{'id': OTHER_ID, 'name': OTHER_NAME}]
    return svc, c, ws, svc.open_reach(c, ws, joined)

"""A service acts only in the project of the channel a request came through
(CR-SHARED-1), against the session's real core (``live.py``).

Core checks that the requester may write the channel's project and hands the
body to the service as it is. A service writes under its runner's account,
which may reach projects the requester cannot, so a body that names a
document (or a project) of another project must not be acted on. Here
runner@ maintains projects A and B and serves A, writer@ writes A and holds
no role in B, and writer@ asks for B's document on A's channel.
"""

import uuid

import pytest

from live import core_url, login


def _project(admin, name):
    pid = admin.projects.create(name)['id']
    tl = admin.text_layers.create(pid, 'Text')['id']
    doc = admin.documents.create(pid, f'{name} doc')['id']
    return {'project': pid, 'text_layer': tl, 'document': doc}


@pytest.fixture(scope='module')
def setup():
    from plaid_client import PlaidClient
    admin = login()
    tag = uuid.uuid4().hex[:8]
    runner_email, writer_email = f'runner-{tag}@x.org', f'writer-{tag}@x.org'
    admin.users.create(runner_email, 'password1', False)
    admin.users.create(writer_email, 'password1', False)
    a, b = _project(admin, f'A {tag}'), _project(admin, f'B {tag}')
    for p in (a, b):
        admin.projects.add_maintainer(p['project'], runner_email)
    admin.projects.add_writer(a['project'], writer_email)
    runner = PlaidClient.login(core_url(), runner_email, 'password1')
    writer = PlaidClient.login(core_url(), writer_email, 'password1')
    yield {'admin': admin, 'runner': runner, 'writer': writer, 'A': a, 'B': b}
    for p in (a, b):
        admin.projects.delete(p['project'])


def _serving(runner, project_id, service_id, seen):
    """Serve ``service_id`` on ``project_id`` as ``runner``: the handler
    writes a text into the document the body names, held as every bundled
    service holds it, and records the request it was handed."""
    from plaid_client.service import held_run
    from plaid_client.services import serve

    def handle(data, helper):
        seen.append(data)
        try:
            with held_run(runner, helper, data['document_id']) as run:
                runner.texts.create(data['text_layer_id'], data['document_id'], 'written by the service')
                run.result = {'status': 'success'}
        except Exception as e:  # noqa: BLE001
            helper.error(e)

    return serve(runner, project_id, {'service_id': service_id, 'service_name': 'Writer'}, handle)


def _texts(admin, doc_id):
    doc = admin.documents.get(doc_id, include_body=True)
    return [tl.get('text') for tl in doc.get('text_layers') or [] if tl.get('text')]


def test_a_document_of_another_project_is_refused_and_left_as_it_was(setup):
    from plaid_client.services import request_service
    s, seen = setup, []
    sid = f'test:writer-{uuid.uuid4().hex[:6]}'
    reg = _serving(s['runner'], s['A']['project'], sid, seen)
    try:
        with pytest.raises(Exception, match='not in this project'):
            request_service(s['writer'], s['A']['project'], sid,
                            {'document_id': s['B']['document'], 'text_layer_id': s['B']['text_layer']},
                            timeout=60)
        assert _texts(s['admin'], s['B']['document']) == []
        # The project the request carries is the channel's, whatever the body named.
        request_service(s['writer'], s['A']['project'], sid,
                        {'document_id': s['A']['document'], 'text_layer_id': s['A']['text_layer'],
                         'project_id': s['B']['project']},
                        timeout=60)
        assert [d['project_id'] for d in seen] == [s['A']['project']] * 2
        assert len(_texts(s['admin'], s['A']['document'])) == 1
    finally:
        reg.stop()

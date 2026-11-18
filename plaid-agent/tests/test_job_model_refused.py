"""A model's provider that refuses the job's calls (S1-2 of the stress
campaign 2026-11-18). A refusal of the key or of the model (401, 403, 404)
would refuse every call the same: the job ends failed, ``model-refused``,
with the provider's words, never a sentence skipped as an answer too long
and a job ended done. Any other refusal of the provider is a stretch's own
failure, halved as before, and its sentences say ``refused``, never
``output``."""

import litellm
import pytest

from job_fixtures import JobClient, ModelConfig, Model, call, document, planned, reply, use

from plaid_agent.core.job import Worker
from plaid_agent.igt.job import runner_factory


def _client():
    return JobClient({f'd{i}': document(f'd{i}', f'Story {i}', [{'words': ['ka']}, {'words': ['mo']}])
                      for i in (1, 2)})


def _run(monkeypatch, raising, from_planning=False):
    client = _client()
    made = client.jobs.create('p1', 'igt', 'Gloss the words.')

    def answer(asked, n, kwargs):
        if '"Story 2"' in asked or from_planning:
            raise raising()
        if n > 1:
            return reply('Done.')
        return reply(calls=[call(1, 'set_analysis', {'document': 'Story 1', 'ref': 's1.w1',
                                                     'morphemes': [{'form': 'ka', 'type': 'stem'}]})])
    model = planned(answer)
    if from_planning:
        def model(asked, n, kwargs):  # noqa: F811 - every call refused, the planning's too
            raise raising()
    use(monkeypatch, Model(model))
    Worker(client, {'igt': runner_factory(ModelConfig(model='fake/m', stream=False, max_steps=1000),
                                          count=lambda v: 1)},
           'fake/m', client_for=lambda token: client, sleep=lambda s: None, heartbeat_s=10 ** 6).once()
    return client.jobs.rows[made['id']]


REFUSALS = {
    'key': lambda: litellm.AuthenticationError('Incorrect API key provided', 'openai', 'm'),
    'model': lambda: litellm.NotFoundError('The model does not exist', 'm', 'openai'),
    'permission': lambda: litellm.PermissionDeniedError(
        'Not allowed', 'openai', 'm', __import__('httpx').Response(403, request=__import__('httpx').Request(
            'POST', 'http://x'))),
}


@pytest.mark.parametrize('what', sorted(REFUSALS))
@pytest.mark.parametrize('from_planning', [False, True])
def test_a_refused_key_or_model_fails_the_job_with_the_providers_words(monkeypatch, what, from_planning):
    row = _run(monkeypatch, REFUSALS[what], from_planning)
    assert row['state'] == 'failed', (row['state'], row.get('reason'), row.get('message'))
    assert row['reason'] == 'model-refused'
    assert row['message'].startswith('The model refused the job’s calls: '), row['message']
    assert str(REFUSALS[what]()) in row['message']
    skipped = [s for d in row['documents'] for s in d.get('skipped') or []]
    assert not any(s.get('kind') == 'output' for s in skipped), skipped


def test_another_provider_refusal_skips_its_sentences_as_refused_never_too_long(monkeypatch):
    row = _run(monkeypatch, lambda: litellm.BadRequestError('Invalid request', 'm', 'openai'))
    assert row['state'] == 'done', (row['state'], row.get('reason'), row.get('message'))
    d2 = next(d for d in row['documents'] if d['document_id'] == 'd2')
    assert [s['kind'] for s in d2['skipped']] == ['refused', 'refused'], d2['skipped']

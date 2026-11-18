"""A model's provider that refuses the job's calls (S1-2 of the stress
campaign 2026-11-18). A refusal of the key or of the model (401, 403, 404)
would refuse every call the same: the job ends failed, ``model-refused``,
with the provider's words (no key, no address, no library class name), never a sentence skipped as an answer too long
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
    assert row['message'].startswith('The model’s provider refused the job’s calls: '), row['message']
    words = {'key': 'Incorrect API key provided', 'model': 'The model does not exist', 'permission': 'Not allowed'}
    assert row['message'].endswith(f': {words[what]}.'), row['message']
    skipped = [s for d in row['documents'] for s in d.get('skipped') or []]
    assert not any(s.get('kind') == 'output' for s in skipped), skipped


def test_another_provider_refusal_skips_its_sentences_as_refused_never_too_long(monkeypatch):
    row = _run(monkeypatch, lambda: litellm.BadRequestError('Invalid request', 'm', 'openai'))
    assert row['state'] == 'done', (row['state'], row.get('reason'), row.get('message'))
    d2 = next(d for d in row['documents'] if d['document_id'] == 'd2')
    assert [s['kind'] for s in d2['skipped']] == ['refused', 'refused'], d2['skipped']


KEY = 'sk-live-Zq81hT0pWmX4'
ENV_KEY = 'sk-env-Kd02nB77qRv1'
BASE = 'https://llm.internal.example.org/v1'


def test_a_refusal_quoting_the_key_and_the_base_shows_neither_to_a_reader(monkeypatch, tmp_path):
    """REV-SJ1-1: a provider quotes the key it refused, and litellm names the
    api-base. Neither reaches the job's line, its report, a heartbeat, the
    trace or read_job; nor does the library's class name lead the line."""
    import json
    import os
    from plaid_agent.igt import jobread
    from plaid_client.workflows.llm import provider_secrets
    monkeypatch.setenv('OPENAI_API_KEY', ENV_KEY)
    client = _client()
    made = client.jobs.create('p1', 'igt', 'Gloss the words.')

    def refusing(**kwargs):
        raise litellm.AuthenticationError(
            f'AuthenticationError: OpenAIException - Incorrect API key provided: {KEY} (also {ENV_KEY}) '
            f'at {BASE}/chat/completions on llm.internal.example.org', 'openai', 'm')
    use(monkeypatch, refusing)
    Worker(client, {'igt': runner_factory(ModelConfig(model='fake/m', stream=False, max_steps=1000),
                                          count=lambda v: 1, trace_dir=str(tmp_path))},
           'fake/m', client_for=lambda token: client, sleep=lambda s: None, heartbeat_s=10 ** 6,
           secrets=provider_secrets(KEY) + (BASE, 'llm.internal.example.org')).once()
    row = client.jobs.rows[made['id']]
    assert row['reason'] == 'model-refused'
    assert row['message'].startswith('The model’s provider refused the job’s calls: Incorrect API key provided'), \
        row['message']
    seen = [row['message'], json.dumps(row['report'], ensure_ascii=False),
            *[json.dumps(c, ensure_ascii=False) for c in client.jobs.calls if c[0] == 'heartbeat'],
            '\n'.join(jobread.summary(client.jobs.get(made['id'])))]
    for root, _, files in os.walk(tmp_path):
        seen += [open(os.path.join(root, f), encoding='utf-8').read() for f in files]
    for text in seen:
        for secret in (KEY, ENV_KEY, BASE, 'llm.internal.example.org', 'litellm.', 'AuthenticationError'):
            assert secret not in text, (secret, text[:300])

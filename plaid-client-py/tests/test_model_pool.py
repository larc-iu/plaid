"""``--model-pool NAME`` on every model service (CONTRACT 9 of the jobs round):
the name of the model key a service draws on, declared in its extras so core
can tell a job worker sharing the key that people are using it
(``GET /jobs/model-busy?pool=NAME``)."""

import argparse
import json

from plaid_client.service_schema import build_extras
from plaid_client.transforms import transform_request
from plaid_client.workflows import llm


class _Service:
    service_name = 'LLM glossing'
    service_id = 'llm-analyzer'

    def __init__(self):
        self.extras = build_extras(tasks=['gloss'])


def _args(*flags):
    parser = argparse.ArgumentParser()
    llm.add_model_arguments(parser)
    return parser.parse_args(['--model', 'm', *flags])


def test_the_flag_lands_in_the_services_extras():
    service = _Service()
    llm.setup_service(service, _args('--model-pool', 'reallms'))
    assert service.extras['model_pool'] == 'reallms'


def test_without_the_flag_the_extras_name_no_pool():
    service = _Service()
    llm.setup_service(service, _args())
    assert 'model_pool' not in service.extras


def test_on_the_wire_the_extras_say_model_pool_in_kebab_case():
    """``serve`` sends the extras as ``json.dumps(transform_request(extras))``
    on the channel's query string, which is what core's model-busy reads."""
    service = _Service()
    llm.setup_service(service, _args('--model-pool', 'reallms'))
    assert json.loads(json.dumps(transform_request(service.extras)))['model-pool'] == 'reallms'


def test_a_model_caller_without_add_model_arguments_takes_the_same_flag():
    parser = argparse.ArgumentParser()
    llm.add_model_pool_argument(parser)
    assert parser.parse_args([]).model_pool is None
    assert parser.parse_args(['--model-pool', 'reallms']).model_pool == 'reallms'
    assert 'waits while they work' in parser.format_help().replace('\n', ' ').replace('  ', ' ')

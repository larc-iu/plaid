"""The assistants read a create's response with plaid_client's readers, the ones
the services and the JS client's createdId and createdIds mirror, never their own."""

import plaid_client

from plaid_agent.core import plan


def test_the_plans_read_a_created_id_with_plaid_clients_reader():
    assert plan.created_id is plaid_client.created_id


def test_a_created_id_that_is_not_a_string_is_no_id():
    assert plan.created_id({'status': 200, 'body': {'id': 7}}) is None
    assert plan.created_id({'status': 200, 'body': {'id': 's1'}}) == 's1'

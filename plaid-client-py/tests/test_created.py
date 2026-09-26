from plaid_client import created_id, created_ids


def test_created_id_reads_a_response_and_its_batch_result_alike():
    assert created_id({"id": "a"}) == "a"
    assert created_id({"status": 201, "body": {"id": "a"}}) == "a"
    # A create that answers with the whole row, a comment with its own body.
    assert created_id({"id": "a", "body": "a comment"}) == "a"


def test_created_id_is_none_for_a_response_with_no_id():
    for result in [None, {}, {"body": {}}, {"body": None}, "a", {"id": 3}]:
        assert created_id(result) is None, result


def test_created_ids_reads_a_response_and_its_batch_result_alike():
    assert created_ids({"ids": ["a", "b"]}) == ["a", "b"]
    assert created_ids({"status": 201, "body": {"ids": ["a"]}}) == ["a"]


def test_created_ids_is_empty_for_a_response_with_no_ids():
    for result in [None, {}, {"body": {}}, {"ids": "a"}, {"body": None}]:
        assert created_ids(result) == [], result

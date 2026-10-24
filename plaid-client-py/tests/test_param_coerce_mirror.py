"""``plaid_client.service_schema.coerce`` against plaid-client-js's
``coerceParamValues``.

A request a person fills in the app is coerced by the JS client, and the same
values sent from a script are coerced by the Python one, so a number string
the two read apart runs the service with different settings depending on who
asked (HUNT-recent 15: 34 of these 128 cases differed). This runs both over one
case table and compares every answer.

It skips where it cannot run (no node, or plaid-client-js not beside the
client); it does not skip when the two disagree.
"""

import json
import os
import shutil
import subprocess

import pytest

from plaid_client.service_schema import coerce

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, 'param_coerce_mirror.mjs')
SCHEMA_JS = os.path.abspath(os.path.join(HERE, '..', '..', 'plaid-client-js', 'src',
                                         'serviceSchema.js'))

SCHEMAS = [
    [{'key': 'n', 'type': 'number', 'default': 3}],
    [{'key': 'n', 'type': 'number', 'default': 3, 'min': 1, 'max': 10}],
    [{'key': 'n', 'type': 'number'}],
    [{'key': 'n', 'type': 'number', 'min': 2}],
]
RAWS = ['nan', 'NaN', 'inf', 'Infinity', '-Infinity', 'infinity', '1e999', '-1e999', '0x10',
        '0b11', '0o7', '1_000', ' 12 ', '12abc', '5', '5.0', '5.5', 5, 5.5, True, False, [], [7],
        {}, None, '', '   ', '1e3', '.5', '+3', '-0']
CASES = ([{'schema': s, 'raw': {'n': r}} for s in SCHEMAS for r in RAWS]
         + [{'schema': s, 'raw': {}} for s in SCHEMAS])


@pytest.fixture(scope='module')
def js(tmp_path_factory):
    exe = shutil.which('node')
    if not exe or not os.path.exists(SCHEMA_JS):
        pytest.skip('node or plaid-client-js is not here')
    cases = tmp_path_factory.mktemp('coerce') / 'cases.json'
    cases.write_text(json.dumps(CASES))
    out = subprocess.run([exe, SCRIPT, str(cases)], capture_output=True, text=True, timeout=60,
                         check=True)
    return json.loads(out.stdout)


def test_every_number_case_is_coerced_as_the_js_client_coerces_it(js):
    assert len(CASES) == 128
    differ = []
    for case, theirs in zip(CASES, js):
        ours = coerce(case['schema'], case['raw'])[0]['n']
        same = (type(ours) in (int, float) and type(theirs) in (int, float) and ours == theirs)
        if not same:
            differ.append((case['schema'][0], case['raw'].get('n', '<absent>'), ours, theirs))
    assert differ == []


def test_a_number_param_takes_a_finite_number_or_a_decimal_string():
    schema = [{'key': 'n', 'type': 'number', 'default': 3}]
    assert [coerce(schema, {'n': raw})[0]['n'] for raw in
            ['5', ' 12 ', '+3', '.5', '1e3', 5, 2.5]] == [5, 12, 3, 0.5, 1000, 5, 2.5]
    assert [coerce(schema, {'n': raw})[0]['n'] for raw in
            ['Infinity', '1e999', '0x10', '1_000', True, [7], {}, 'nan']] == [3] * 8

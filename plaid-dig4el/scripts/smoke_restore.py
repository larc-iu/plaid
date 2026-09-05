"""Live check of the missing-segment path: delete one questionnaire segment's sentence
token in Plaid, confirm the editor reports it, restore it through the web route, and
confirm the slot is back with its neighbours untouched.

Usage: python scripts/smoke_restore.py <language_id> <document_id> <segment_index>
Needs the dig4el server on :8087 and core on :8085; logs in as a@b.com.
"""

import sys

import requests
from plaid_client import PlaidClient

from plaid_dig4el import plaid_gateway as gw

BASE = "http://localhost:8087"
lang_id, doc_id, seg_index = sys.argv[1:4]

s = requests.Session()
assert s.post(f"{BASE}/login", data={"user_id": "a@b.com", "password": "password"}).status_code == 200
client = PlaidClient.login("http://localhost:8085", "a@b.com", "password")
project_id = client.documents.get(doc_id)["project"]
layers = gw.read_layers(client.projects.get(project_id))

before = gw.read_questionnaire_document(client, doc_id, layers)
slot = before.slot(seg_index)
neighbours = {x.segment_index: (x.begin, x.end, x.text) for x in before.slots if x.segment_index != seg_index}
prompt = next(x for x in before.missing_segments + [s.segment for s in before.slots if s.segment]
              if x.index == seg_index).text
if slot is None:
    print(f"segment {seg_index} is already missing; restoring only")
    removed = -1  # body grows by the restored newline
else:
    # A partitioning layer refuses single-token deletion; a text edit that removes the
    # slot's whole range (what an edit in another app would do) takes the token with it.
    print(f"deleting the text of segment {seg_index} ({slot.begin}-{slot.end}, {len(slot.words)} words)")
    client.texts.update(before.text_id, [{"type": "delete", "index": slot.begin, "value": slot.end - slot.begin}])
    removed = slot.end - slot.begin

after_delete = gw.read_questionnaire_document(client, doc_id, layers)
assert after_delete.slot(seg_index) is None
assert [x.index for x in after_delete.missing_segments] == [seg_index], after_delete.missing_segments
page = s.get(f"{BASE}/languages/{lang_id}/documents/{doc_id}").text
assert "This segment's sentence was deleted in Plaid." in page
print("editor reports the missing segment")

r = s.post(f"{BASE}/languages/{lang_id}/documents/{doc_id}/slots/{seg_index}/restore", allow_redirects=False)
assert r.status_code in (200, 303), r.status_code
restored = gw.read_questionnaire_document(client, doc_id, layers)
new = restored.slot(seg_index)
assert new is not None and new.text == "" and new.fields["prompt"][1] == prompt, (new and new.fields)
assert not restored.missing_segments
shifted = {x.segment_index: (x.begin, x.end, x.text) for x in restored.slots if x.segment_index != seg_index}
# Every neighbour keeps its text and its tags
assert {k: v[2] for k, v in shifted.items()} == {k: v[2] for k, v in neighbours.items()}
assert [x.segment_index for x in restored.slots] == [x.index for x in gw.catalog.questionnaires()[restored.questionnaire].segments]
assert len(restored.body) == len(before.body) - removed + 1
print(f"restored as an empty slot at {new.begin}-{new.end}; {len(restored.slots)} slots, neighbours intact")

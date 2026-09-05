"""Live check of the layer repair: a scratch language loses one layer at a time
(Concept, then word, then sentence, then text), the language page reports it, and
Repair brings back what the surviving data allows.

Usage: python scripts/smoke_repair.py
Needs the dig4el server on :8087 and core on :8085; logs in as a@b.com.
"""

import re
import sqlite3
import sys
from pathlib import Path

import requests
from plaid_client import PlaidClient

from plaid_dig4el import plaid_gateway as gw

BASE = "http://localhost:8087"
DB = Path(__file__).resolve().parent.parent / "data" / "dig4el.db"
s = requests.Session()
assert s.post(f"{BASE}/login", data={"user_id": "a@b.com", "password": "password"}).status_code == 200
client = PlaidClient.login("http://localhost:8085", "a@b.com", "password")

# leftovers of an earlier run
db = sqlite3.connect(DB)
for old_id, old_pid in db.execute("select id, plaid_project_id from languages where name='Repair test'").fetchall():
    try:
        client.projects.delete(old_pid)
    except Exception:
        pass
    db.execute("delete from questionnaire_documents where language_id=?", (old_id,))
    db.execute("delete from languages where id=?", (old_id,)); db.commit()
    print("removed a leftover scratch language")

r = s.post(f"{BASE}/languages", data={"name": "Repair test", "glottocode": "", "wals_name": "", "grambank_name": "",
                                      "pivot_language": "English", "delimiters": " .,;:!?"}, allow_redirects=False)
assert r.status_code == 303, r.text[:300]
lang_id = r.headers["location"].rsplit("/", 1)[-1].split("?")[0]
pid = db.execute("select plaid_project_id from languages where id=?", (lang_id,)).fetchone()[0]
print("scratch language", lang_id, "project", pid)
r = s.post(f"{BASE}/languages/{lang_id}/questionnaires", data={"uid": "1716315461"}, allow_redirects=False)
doc_id = r.headers["location"].rsplit("/", 1)[-1]


def layers():
    cfg = __import__("json").loads(db.execute("select layers from languages where id=?", (lang_id,)).fetchone()[0])
    return gw.Layers.from_config(cfg)


def read():
    return gw.read_questionnaire_document(client, doc_id, layers())


# two translated slots with a link
doc = read()
gw.fill_slot(client, doc, doc.slot("1"), "ia ora na", [" "], fields={"note": "greeting"},
             concept_words={"GREET": [0, 1]})
doc = read()
gw.fill_slot(client, doc, doc.slot("2"), "e aha te huru", [" "])
doc = read()
assert doc.slot("1").text == "ia ora na" and doc.slot("1").concepts and doc.slot("2").words
print("filled two slots; link on slot 1")


def page_reports(expected):
    html = s.get(f"{BASE}/languages/{lang_id}").text
    m = re.search(r"Layers of this language were deleted in Plaid: ([^.]*)\.", html)
    assert m, "no repair notice"
    assert all(x in m.group(1) for x in expected), (m.group(1), expected)
    return html


def repair():
    r = s.post(f"{BASE}/languages/{lang_id}/repair", allow_redirects=False)
    assert r.status_code == 303, r.status_code
    html = s.get(BASE + r.headers["location"]).text
    assert "Layers of this language were deleted" not in html, "still missing after repair"
    m = re.search(r'alert-success py-2 small">([^<]*)<', html)
    return m.group(1) if m else ""


# 1. Concept layer
client.span_layers.delete(layers().concept)
page_reports(["concept"]); print("repair:", repair()[:90])
doc = read()
assert doc.can_link and doc.slot("1").text == "ia ora na" and doc.slot("1").words and not doc.slot("1").concepts
gw.set_concepts(client, doc, doc.slot("1"), {"GREET": [w["id"] for w in doc.slot("1").words[:2]]})
assert read().slot("1").concepts, "linking works again"
print("  concept layer back, linking works")

# 2. word layer (takes the Concept layer with it)
client.token_layers.delete(layers().word)
page_reports(["word", "concept"]); print("repair:", repair()[:90])
doc = read()
assert [w["form"] for w in doc.slot("1").words] == ["ia", "ora", "na"] and not doc.slot("1").concepts
assert doc.slot("1").fields["note"][1] == "greeting" and doc.slot("1").fields["prompt"][1]
print("  words retokenized, fields kept")

# 3. sentence layer (takes the fields and the word layer's parent)
client.token_layers.delete(layers().sentence)
page_reports(["sentence", "field prompt", "field note"]); print("repair:", repair()[:90])
doc = read()
assert len(doc.slots) == 36 and doc.slot("1").text == "ia ora na" and doc.slot("2").text == "e aha te huru"
assert doc.slot("1").fields["prompt"][1] == doc.slot("1").segment.text and doc.slot("1").fields["note"][1] == ""
assert [w["form"] for w in doc.slot("1").words] == ["ia", "ora", "na"]
print("  slots rebuilt from the text, prompts from the catalog, words retokenized")

# 4. text layer (everything)
client.text_layers.delete(layers().text)
page_reports(["text"]); print("repair:", repair()[:90])
doc = read()
assert len(doc.slots) == 36 and all(not x.filled for x in doc.slots) and doc.slot("1").fields["prompt"][1]
gw.fill_slot(client, doc, doc.slot("1"), "ia ora na", [" "])
assert read().slot("1").text == "ia ora na"
print("  empty slots again with prompts; translating works")

# cleanup
client.projects.delete(pid)
db.execute("delete from questionnaire_documents where language_id=?", (lang_id,))
db.execute("delete from languages where id=?", (lang_id,)); db.commit()
print("scratch language removed")

"""Live check of the sentence-pair stage: upload a small corpus through the web app,
open its editor, describe its sentences with the model, search three ways, then
delete the corpus from Plaid and forget it.

Usage: python scripts/smoke_corpus.py <language_id> [keep]
Needs the dig4el server on :8087, core on :8085 and the language-model endpoint;
logs in as a@b.com.
"""

import json
import sqlite3
import sys
import time
from pathlib import Path

import requests
from plaid_client import PlaidClient

BASE = "http://localhost:8087"
lang_id = sys.argv[1]
keep = len(sys.argv) > 2 and sys.argv[2] == "keep"
DB = Path(__file__).resolve().parent.parent / "data" / "dig4el.db"

pairs = [
    {"source": "There is a fish!", "target": "e i'a tera!", "comments": "presentative"},
    {"source": "I don't see it.", "target": "'aita au e 'ite ra", "comments": ""},
    {"source": "Don't move!", "target": "'eiaha e ha'aputuputu!", "comments": ""},
    {"source": "We will eat it tonight.", "target": "e 'amu tatou i teie po", "comments": "inclusive we"},
    {"source": "Who is that man?", "target": "'o vai tera ta'ata?", "comments": ""},
    {"source": "This is my house.", "target": "'o to'u fare teie", "comments": ""},
]

s = requests.Session()
assert s.post(f"{BASE}/login", data={"user_id": "a@b.com", "password": "password"}).status_code == 200
r = s.post(f"{BASE}/languages/{lang_id}/corpora", data={"name": "Smoke corpus", "origin": "made up", "author": "smoke"},
           files={"file": ("smoke.json", json.dumps(pairs).encode(), "application/json")}, allow_redirects=False)
assert r.status_code == 303, (r.status_code, r.text[:300])
doc_id = r.headers["location"].rsplit("/", 1)[-1]
print("corpus document", doc_id)
page = s.get(f"{BASE}/languages/{lang_id}/documents/{doc_id}").text
assert page.count('class="card slot') == len(pairs) and "6 sentences" in page, "editor rows"
assert "Not described yet." in page
print("editor shows", len(pairs), "sentences")

db = sqlite3.connect(DB)
def running():
    return db.execute("select count(*) from jobs where kind='augment' and status in ('queued','running')").fetchone()[0]
while running():
    time.sleep(5)
r = s.post(f"{BASE}/languages/{lang_id}/augment", allow_redirects=False)
assert r.status_code == 303, r.status_code
t = time.time()
while running():
    time.sleep(5)
job = db.execute("select status, error, progress from jobs where kind='augment' order by created_at desc limit 1").fetchone()
assert job[0] == "done", job
print(f"described in {time.time()-t:.0f}s:", job[2])
n = db.execute("select count(*) from sentence_augmentations where document_id=?", (doc_id,)).fetchone()[0]
assert n == len(pairs), n

page = s.get(f"{BASE}/languages/{lang_id}/documents/{doc_id}").text
assert "Model's description" in page and 'name="new_concept"' in page and 'class="concept ' in page
print("editor shows descriptions and meanings")

for how in ("keyword", "embedding", "model"):
    t = time.time()
    html = s.post(f"{BASE}/languages/{lang_id}/search", data={"query": "negative" if how == "keyword" else "negation", "how": how}).text
    hits = html.count('text-decoration-none"')
    print(f"search {how}: {hits} hits in {time.time()-t:.1f}s")
    assert hits > 0

if not keep:
    client = PlaidClient.login("http://localhost:8085", "a@b.com", "password")
    client.documents.delete(doc_id)
    assert s.post(f"{BASE}/languages/{lang_id}/documents/{doc_id}/forget", allow_redirects=False).status_code == 303
    db.execute("delete from sentence_augmentations where document_id=?", (doc_id,)); db.commit()
    print("cleaned up")

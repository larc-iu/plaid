"""Live round trip of plaid_gateway against the dev core: set up a language, import
two questionnaires from the Tahitian fixture, read back, rebuild the knowledge graph,
link and refill a slot. Deletes the project unless --keep."""
import json, sys, time
from plaid_client import PlaidClient
from plaid_dig4el import plaid_gateway as gw
from plaid_dig4el.reference import catalog

c = PlaidClient.login("http://localhost:8085", "a@b.com", "password")
kg = {int(k): v for k, v in json.load(open("/home/luke/local/plaid/plaid-dig4el/tests/fixtures/tahitian_current_kg.json", encoding="utf-8")).items()}
# keep the smoke test quick: two questionnaires' worth of entries
seg_for = gw.resolve_segments_for_kg(kg)
uids = []
for k in sorted(kg):
    s = seg_for[k]
    if s and s.uid not in uids:
        uids.append(s.uid)
keep = set(uids[:2])
kg_small = {k: v for k, v in kg.items() if seg_for[k] and seg_for[k].uid in keep}
print("entries", len(kg), "-> importing", len(kg_small), "from questionnaires", uids[:2])
unresolved = [k for k, s in seg_for.items() if s is None]
print("unresolved entries:", unresolved)

t = time.time()
pid, layers = gw.create_language_project(c, "Tahitian (gateway smoke)", {"name": "Tahitian", "glottocode": "tahi1242", "walsName": "Tahitian"})
print("project", pid, "setup", round(time.time() - t, 1), "s")
try:
    t = time.time()
    delims = catalog.delimiters_for("Tahitian")
    docs = gw.import_legacy_kg(c, pid, layers, kg_small, delims)
    print("imported", len(docs), "documents in", round(time.time() - t, 1), "s")
    rd = [gw.read_questionnaire_document(c, d, layers) for d in docs]
    d0 = rd[0]
    print("doc", d0.name, "version", d0.version, "published", d0.published, "slots", len(d0.slots), "filled", sum(1 for s in d0.slots if s.filled))
    print("first filled slot:", next((s for s in d0.slots if s.filled), None))
    # document-level and token-level metadata presence
    raw = c.documents.get(d0.id, include_body=True)
    print("doc metadata present:", "metadata" in raw, raw.get("metadata"))
    tok0 = raw["text_layers"][0]["token_layers"][0]["tokens"][0]
    print("token metadata present:", "metadata" in tok0, tok0.get("metadata"))
    kg2 = gw.knowledge_graph_from_docs(rd, "Tahitian", published_only=True)
    print("kg rebuilt entries", len(kg2))
    # compare translations word by word with the source via the same tokenizer
    from plaid_dig4el.inference import tokenizer
    src = {v["sentence_data"]["text"] + "|" + str(seg_for[k].index): v for k, v in kg_small.items()}
    mism = 0
    for e in kg2.values():
        key = e["sentence_data"]["text"] + "|" + e["sentence_data"]["legacy index"]
        cand = [v for v in kg_small.values() if v["sentence_data"]["text"] == e["sentence_data"]["text"]]
        if not cand:
            mism += 1; continue
        a = tokenizer.custom_split(cand[0]["recording_data"]["translation"], delims)
        b = tokenizer.custom_split(e["recording_data"]["translation"], gw.KG_DELIMITERS)
        if a != b:
            mism += 1
            if mism <= 3:
                print("MISMATCH", a, b)
    print("word-sequence mismatches:", mism, "of", len(kg2))
    # a concept round trip: link two words in one slot, read back
    s = next(s for s in d0.slots if s.filled and len(s.words) >= 2)
    gw.set_concepts(c, d0, s, {"ASK": [s.words[0]["id"], s.words[1]["id"]], "Ref_speaker": [s.words[1]["id"]]})
    d0b = gw.read_questionnaire_document(c, d0.id, layers)
    sb = d0b.slot(s.segment_index)
    print("concepts after set:", [(x["value"], len(x["tokens"])) for x in sb.concepts])
    kg3 = gw.knowledge_graph_from_docs([d0b], "Tahitian")
    ent = next(v for v in kg3.values() if v["recording_data"]["token"] == s.token_id)
    print("kg concept_words:", {k: v for k, v in ent["recording_data"]["concept_words"].items() if v})
    # re-fill that slot: words and links should be replaced
    gw.fill_slot(c, d0b, sb, "ia ora na 'oe", delims, fields={"note": "smoke"}, concept_words={"Ref_addressee": [3]})
    d0c = gw.read_questionnaire_document(c, d0.id, layers)
    sc = d0c.slot(s.segment_index)
    print("after refill:", sc.text, [w["form"] for w in sc.words], [(x["value"], len(x["tokens"])) for x in sc.concepts], sc.fields)
finally:
    if "--keep" not in sys.argv:
        c.projects.delete(pid)
        print("deleted project")
    else:
        print("kept project", pid)

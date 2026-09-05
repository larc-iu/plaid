"""The slot-document spike: placeholder sentences per segment, whole-range replace,
out-of-order fills, re-edit behavior. Kept as documentation of what Plaid does."""
import json, sys
from plaid_client import PlaidClient

c = PlaidClient.login("http://localhost:8085", "a@b.com", "password")
print("resources:", [a for a in dir(c) if not a.startswith("_")][:40])

proj = c.projects.create("dig4el slot spike")
pid = proj["id"] if isinstance(proj, dict) else proj
print("project", pid)
try:
    tl = c.text_layers.create(pid, "Text")
    tl_id = tl["id"]
    c.text_layers.set_config(tl_id, "plaid", "role", "baseline")
    sent = c.token_layers.create(tl_id, "Sentence", overlap_mode="partitioning")
    c.token_layers.set_config(sent["id"], "plaid", "role", "sentence")
    word = c.token_layers.create(tl_id, "Word", overlap_mode="non-overlapping", parent_token_layer_id=sent["id"])
    c.token_layers.set_config(word["id"], "plaid", "role", "word")
    concept = c.span_layers.create(word["id"], "Concept")
    pivot = c.span_layers.create(sent["id"], "Pivot")
    c.span_layers.set_config(pivot["id"], "igt", "scope", "Sentence")
    doc = c.documents.create(pid, "Q01 spike")
    N = 5
    text = c.texts.create(tl_id, doc["id"], "\n" * N)
    text_id = text["id"]
    toks = c.tokens.bulk_create([
        {"token_layer_id": sent["id"], "text": text_id, "begin": i, "end": i + 1,
         "metadata": {"dig4el": {"segment": str(i + 1)}}} for i in range(N)])
    print("sentence tokens", toks)
    sent_ids = toks["ids"]
    # pivot prompts on each slot
    c.spans.bulk_create([{"span_layer_id": pivot["id"], "tokens": [sid], "value": f"Prompt {i+1}"}
                         for i, sid in enumerate(sent_ids)])

    def show(label):
        d = c.documents.get(doc["id"], include_body=True)
        body = None
        for tlay in d.get("text_layers", d.get("textLayers", [])):
            body = tlay.get("text", {}).get("body")
            for tok in tlay.get("token_layers", tlay.get("tokenLayers", [])):
                print(f"  [{label}] layer {tok['name']}: ",
                      [(t["begin"], t["end"], (body or "")[t["begin"]:t["end"]]) for t in tok.get("tokens", [])])
                for sl in tok.get("span_layers", tok.get("spanLayers", [])):
                    print(f"      spans {sl['name']}:", [(s["value"], s["tokens"]) for s in sl.get("spans", [])])
        print(f"  [{label}] body={body!r}")
        return d

    d0 = show("initial")
    print("top-level keys:", list(d0.keys()))

    # fill slot 3 (index 2): replace its whole range (the lone newline) with content + newline
    r = c.texts.update(text_id, [{"type": "replace", "index": 2, "length": 1, "value": "ua 'ite 'oe i te ata\n"}])
    print("replace ->", r)
    d1 = show("after slot 3 fill")
    # words inside slot 3
    body = d1["text_layers"][0]["text"]["body"] if "text_layers" in d1 else d1["textLayers"][0]["text"]["body"]
    start = 2
    words = []
    pos = start
    for w in "ua 'ite 'oe i te ata".split(" "):
        words.append({"token_layer_id": word["id"], "text": text_id, "begin": pos, "end": pos + len(w)})
        pos += len(w) + 1
    wt = c.tokens.bulk_create(words)
    wids = wt["ids"]
    sp = c.spans.bulk_create([
        {"span_layer_id": concept["id"], "tokens": [wids[1]], "value": "seeing"},
        {"span_layer_id": concept["id"], "tokens": [wids[2]], "value": "Ref_addressee"},
        {"span_layer_id": concept["id"], "tokens": [wids[4], wids[5]], "value": "picture"},
        {"span_layer_id": concept["id"], "tokens": [wids[2]], "value": "ASK"},  # overlapping second concept on one word
    ])
    print("concept spans", sp)
    show("after words+concepts")
    # fill slot 1 (index 0) and last slot, out of order
    c.texts.update(text_id, [{"type": "replace", "index": 0, "length": 1, "value": "ia ora na\n"}])
    d2 = show("after slot 1 fill")
    body = d2["text_layers"][0]["text"]["body"]
    last_tok = [t for t in d2["text_layers"][0]["token_layers"][0]["tokens"]][-1]
    c.texts.update(text_id, [{"type": "replace", "index": last_tok["begin"], "length": last_tok["end"] - last_tok["begin"], "value": "māuruuru\n"}])
    d3 = show("after last slot fill")
    # re-edit slot 3 (respell): what survives?
    toks3 = sorted(d3["text_layers"][0]["token_layers"][0]["tokens"], key=lambda t: t["begin"])
    t3 = toks3[2]
    c.texts.update(text_id, [{"type": "replace", "index": t3["begin"], "length": t3["end"] - t3["begin"], "value": "'ua 'ite 'oe i te hōho'a\n"}])
    show("after slot 3 re-edit")
finally:
    c.projects.delete(pid)
    print("deleted project")

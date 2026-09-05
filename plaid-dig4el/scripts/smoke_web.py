"""Live smoke test of the web app on :8087 against the dev core on :8085 (a@b.com).
Creates a language from the Tahitian fixture, edits, links, publishes, starts a run."""
import re, sys, time
import requests

B = "http://localhost:8087"
s = requests.Session()
r = s.post(f"{B}/login", data={"user_id": "a@b.com", "password": "password"}, allow_redirects=False)
print("login", r.status_code, r.headers.get("location"), "cookie" if s.cookies.get("dig4el_session") else "NO COOKIE")
r = s.get(f"{B}/"); print("languages page", r.status_code, "Add a language" in r.text)
t = time.time(); r = s.get(f"{B}/languages/new"); print("new-language page", r.status_code, round(time.time() - t, 1), "s", "wals-names" in r.text)

with open("/home/luke/local/plaid/plaid-dig4el/tests/fixtures/tahitian_current_kg.json", "rb") as f:
    t = time.time()
    r = s.post(f"{B}/languages", data={"name": "Tahitian (web smoke)", "glottocode": "tahi1242", "wals_name": "Tahitian",
                                        "grambank_name": "Tahitian", "pivot_language": "English", "delimiters": " .,;:!?…"},
               files={"legacy_file": ("current_kg.json", f, "application/json")}, allow_redirects=False)
print("create", r.status_code, r.headers.get("location"), round(time.time() - t, 1), "s")
if r.status_code >= 400:
    print(r.text[:2000]); sys.exit(1)
lang_url = r.headers["location"]
lang_id = lang_url.split("/languages/")[1].split("?")[0]
r = s.get(f"{B}{lang_url}"); print("language page", r.status_code, re.findall(r"Imported (\d+)", r.text), re.findall(r"<td>(\d+ / \d+)</td>", r.text))
docs = re.findall(rf"/languages/{lang_id}/documents/([0-9a-f-]+)", r.text)
docs = list(dict.fromkeys(docs)); print("documents", len(docs))
doc = docs[0]
r = s.get(f"{B}/languages/{lang_id}/documents/{doc}"); print("editor", r.status_code, "segments translated" in r.text, r.text.count('class="slot"'), "slots")
m = re.search(r'id="slot-(\d+)"', r.text); seg = m.group(1)
# save a translation with fields (htmx request)
r = s.post(f"{B}/languages/{lang_id}/documents/{doc}/slots/{seg}/translation", headers={"HX-Request": "true"},
           data={"text": "ia ora na 'oe e te hoa", "alternate_pivot": "", "back_translation": "hello you friend", "note": "smoke"})
print("translate", r.status_code, "ia ora na" in r.text, "hello you friend" in r.text)
words = re.findall(r'name="c:[^"]+" value="([0-9a-f-]+)"', r.text)
concepts = list(dict.fromkeys(re.findall(r'name="c:([^"]+)"', r.text)))
print("concepts offered:", concepts[:6], "word ids:", len(set(words)))
if concepts and words:
    wid = list(dict.fromkeys(words))
    r = s.post(f"{B}/languages/{lang_id}/documents/{doc}/slots/{seg}/concepts", headers={"HX-Request": "true"},
               data=[(f"c:{concepts[0]}", wid[0]), (f"c:{concepts[0]}", wid[1])] + ([(f"c:{concepts[1]}", wid[1])] if len(concepts) > 1 else []))
    print("concepts", r.status_code, r.text.count('class="chip on"'), "chips on")
# publish toggle round trip: unpublish then republish
r = s.post(f"{B}/languages/{lang_id}/documents/{doc}/publish", data={"published": "0"}, allow_redirects=False); print("unpublish", r.status_code)
r = s.get(f"{B}{lang_url}"); print("published count line:", re.findall(r"(\d+) questionnaires? with translations", r.text))
r = s.post(f"{B}/languages/{lang_id}/documents/{doc}/publish", data={"published": "1"}, allow_redirects=False); print("republish", r.status_code)
# start inference
r = s.post(f"{B}/languages/{lang_id}/inference", allow_redirects=False); print("inference", r.status_code, r.headers.get("location"))
run_url = r.headers["location"]
r = s.get(f"{B}{run_url}"); print("run page", r.status_code, "Waiting" in r.text or "Reading" in r.text)
print("LANG", lang_id, "RUN", run_url)

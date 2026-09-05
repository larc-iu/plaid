"""Compare a port report (pipeline.run_inference JSON) with a baseline, stage by stage.
Edit S and the language list below, or adapt; tests/test_parity.py is the maintained form."""
import json, sys
S = "/tmp/claude-1000/-home-luke-local-plaid/fda63608-e09a-4f98-9161-de9668adf375/scratchpad/"
for lang in ("tahitian", "marquesan"):
    b = json.load(open(S + f"baseline_{lang}_seed0.json", encoding="utf-8"))
    p = json.load(open(S + f"port_{lang}_seed0.json", encoding="utf-8"))
    print(f"== {lang}")
    print(" observed counts equal:", b["observed"] == p["observations"]["counts"])
    print(" known equal:", b["known_wals_pk"] == {k: v["code"] for k, v in p["known"]["wals"].items()},
          b["known_grambank_pid"] == {k: v["code"] for k, v in p["known"]["grambank"].items()})
    print(" strong seeds equal:", b["strong"] == p["discovery"]["strong_seeds"])
    print(" selected equal:", [tuple(x) for x in b["selected"]] == [tuple(x) for x in p["discovery"]["selected"]], len(b["selected"]), len(p["discovery"]["selected"]))
    print(" agent params equal:", b["ga_names"] == p["discovery"]["agent_parameters"], len(b["ga_names"]), len(p["discovery"]["agent_parameters"]))
    pr = {r["parameter"]: r for r in p["parameters"]}
    same_w = sum(1 for k, r in b["results"].items() if k in pr and pr[k]["winner_code"] == r["winner"])
    same_c = sum(1 for k, r in b["results"].items() if k in pr and pr[k]["confidence"] == r["confidence"])
    same_o = sum(1 for k, r in b["results"].items() if k in pr and pr[k]["origin"] == r["origin"])
    maxdiff = max((abs(pr[k]["beliefs"][c]["p"] - v) for k, r in b["results"].items() if k in pr for c, v in r["beliefs"].items()), default=0)
    print(f" winners {same_w}/{len(b['results'])} confidences {same_c}/{len(b['results'])} origins {same_o}/{len(b['results'])} max belief diff {maxdiff:.2e}")

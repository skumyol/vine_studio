#!/usr/bin/env python3
"""Smoke test: searches + verifies top candidate for a few hard SKUs.

Usage: python3 scripts/smoke_test.py
"""
import json
import os
import sys
import urllib.request

API = os.environ.get("API", "http://localhost:3000")


def post_json(path, body):
    req = urllib.request.Request(
        f"{API}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)
    except Exception as e:
        return {"error": str(e)}


def run(label, sku):
    print()
    print("=" * 70)
    print(f"== {label}")
    print("=" * 70)

    search = post_json("/api/search", sku)
    candidates = search.get("candidates", [])
    if not candidates:
        print("  NO CANDIDATES")
        return False, None
    print(f"  Candidates: {len(candidates)}")
    for i, c in enumerate(candidates[:3]):
        print(f"    #{i+1} [{c.get('authority')}] {c.get('domain')} — {c.get('title','')[:70]}")

    # Walk top 5 candidates like handleBatchTest does in production
    best = None
    for idx, c in enumerate(candidates[:5]):
        url = c["original"]
        v = post_json("/api/verify-vlm", {"sku": sku, "imageUrl": url})
        vd = v.get("vlm_decision") or {}
        print(f"  candidate #{idx+1} [{c.get('domain')}]: {v.get('verdict')} conf={v.get('confidence')} vlm={vd.get('verdict')}")
        # Prefer PASS over non-PASS, then by confidence — matches production
        if best is None:
            best = (v, url)
        else:
            cur_pass = bool(best[0].get("pass"))
            new_pass = bool(v.get("pass"))
            if new_pass and not cur_pass:
                best = (v, url)
            elif new_pass == cur_pass and (v.get("confidence") or 0) > (best[0].get("confidence") or 0):
                best = (v, url)
        if v.get("pass"):
            break

    if best is None:
        return False, None
    v, top_url = best
    vd = v.get("vlm_decision") or {}
    print(f"  → best verdict       = {v.get('verdict')}")
    print(f"    confidence         = {v.get('confidence')}")
    print(f"    quality            = {v.get('qualityFactor')}")
    print(f"    vlm verdict        = {vd.get('verdict')}")
    print(f"    matched_fields     = {vd.get('matched_fields')}")
    print(f"    detected           = {vd.get('detected')}")
    print(f"    watermark          = {vd.get('has_watermark')}")
    print(f"    is_professional    = {vd.get('is_professional')}")
    print(f"    reasoning          = {(v.get('reasoning') or '')[:200]}")
    return v.get("pass"), top_url


SKUS = [
    ("Domaine du Tunnel Cornas Vin Noir 2018 (owner-variant: Stéphane Robert)", {
        "wine_name": "Domaine du Tunnel Cornas",
        "vintage": "2018",
        "appellation": "Cornas",
        "vineyard": "Vin Noir",
        "region": "Northern Rhone",
    }),
    ("Poderi Colla Barolo Bussia Dardi Le Rose 2016", {
        "wine_name": "Poderi Colla Barolo Bussia Dardi Le Rose",
        "vintage": "2016",
        "appellation": "Barolo",
        "vineyard": "Bussia Dardi Le Rose",
        "region": "Piedmont",
    }),
    ("Rossignol-Trapet Latricières-Chambertin 2017 (climat-strict vs Trapet Père & Fils)", {
        "wine_name": "Domaine Rossignol-Trapet Latricieres-Chambertin",
        "vintage": "2017",
        "appellation": "Latricieres-Chambertin",
        "vineyard": "Latricieres",
        "classification": "Grand Cru",
        "region": "Burgundy",
    }),
    ("Eric Rodez Cuvée des Crayères Blanc de Noirs NV", {
        "wine_name": "Eric Rodez Cuvee des Crayeres Blanc de Noirs",
        "vintage": "NV",
        "appellation": "Champagne",
        "region": "Champagne",
    }),
]


def main():
    print(f"API: {API}")
    health = post_json("/api/health", {}) if False else None
    try:
        with urllib.request.urlopen(f"{API}/api/health", timeout=5) as r:
            print("Health:", json.load(r))
    except Exception as e:
        print(f"Health check failed: {e}", file=sys.stderr)
        sys.exit(1)

    results = []
    for label, sku in SKUS:
        passed, url = run(label, sku)
        results.append((label, passed, url))

    print()
    print("=" * 70)
    print("SUMMARY")
    print("=" * 70)
    for label, passed, url in results:
        flag = "PASS" if passed else "FAIL"
        print(f"  [{flag}] {label}")
        if url and passed:
            print(f"         {url}")

    passed_count = sum(1 for _, p, _ in results if p)
    print(f"\n  {passed_count}/{len(results)} passed")


if __name__ == "__main__":
    main()

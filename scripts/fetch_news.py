#!/usr/bin/env python3
"""BioPharma Hub — static news generator.

Fetches RSS/Atom feeds, categorizes items, translates English titles to Chinese,
and writes web/data/news.json for the static frontend (GitHub Pages / Qoder Sites).

Standard library only. Runs locally and in GitHub Actions.

Translation uses MyMemory (primary) with Google gtx (fallback) and a persistent
cache (web/data/translations.json) so only new titles hit the network.

Usage:
    python scripts/fetch_news.py [--out web/data/news.json] [--no-translate]

Env:
    MYMEMORY_EMAIL  optional contact email to raise MyMemory daily quota.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "web" / "data" / "news.json"
CACHE_OUT = ROOT / "web" / "data" / "translations.json"

FEEDS = [
    {"id": "nature-biotech", "name": "Nature Biotechnology", "lang": "en", "category": "研发", "url": "https://www.nature.com/nbt.rss"},
    {"id": "nature-medicine", "name": "Nature Medicine", "lang": "en", "category": "研发", "url": "https://www.nature.com/nm.rss"},
    {"id": "stat-news", "name": "STAT News", "lang": "en", "category": "研发", "url": "https://www.statnews.com/feed/"},
    {"id": "endpoints", "name": "Endpoints News", "lang": "en", "category": "市场", "url": "https://endpts.com/feed/"},
    {"id": "biopharma-dive", "name": "BioPharma Dive", "lang": "en", "category": "审批", "url": "https://www.biopharmadive.com/feeds/news/"},
    {"id": "gen", "name": "GEN", "lang": "en", "category": "技术", "url": "https://www.genengnews.com/feed/"},
    {"id": "science-daily-health", "name": "ScienceDaily Health", "lang": "en", "category": "技术", "url": "https://www.sciencedaily.com/rss/top/health.xml"},
]

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
FETCH_TIMEOUT = 15
MAX_ITEMS_PER_FEED = 20
MAX_TOTAL_ITEMS = 120
MAX_TRANSLATE = 60
CACHE_MAX_ENTRIES = 3000

CATEGORY_KEYWORDS = [
    ("审批", ["fda", "ema", "nmpa", "approv", "clearance", "clears", "green light",
              "submission", "file", "filing", "nda", "bla", "regulat", "authoris",
              "authorization", "审批", "批准", "获批", "上市许可", "申报"]),
    ("市场", ["market", "funding", "ipo", "merger", "acquisition", "acquire", "deal",
              "revenue", "sales", "invest", "valuation", "partner", "licens", "buyout",
              "市场", "融资", "收购", "并购", "营收", "合作", "投资", "上市"]),
    ("技术", ["crispr", "sequenc", "assay", "platform", "ai ", "machine learning",
              "single-cell", "method", "technique", "tool", "workflow", "engineering",
              "技术", "方法", "平台", "测序", "基因编辑", "工具"]),
    ("研发", ["trial", "phase", "study", "research", "discover", "mechanism", "therapy",
              "drug", "compound", "antibody", "vaccine", "clinical", "preclinical",
              "研发", "研究", "试验", "发现", "机制", "疗法", "药物", "临床"]),
]


def strip_tags(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s or "")).strip()


def decode_cdata(s):
    return re.sub(r"<!\[CDATA\[(.*?)\]\]>", r"\1", s or "", flags=re.S)


def parse_date(s):
    if not s:
        return ""
    s = s.strip()
    try:
        return parsedate_to_datetime(s).astimezone(timezone.utc).isoformat()
    except Exception:
        pass
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()
    except Exception:
        return ""


def categorize(text, fallback):
    low = (text or "").lower()
    for cat, words in CATEGORY_KEYWORDS:
        for w in words:
            if w in low:
                return cat
    return fallback


def _mkitem(feed, i, title, link, desc, date):
    return {
        "id": f"{feed['id']}-{i}",
        "source": feed["name"],
        "sourceId": feed["id"],
        "lang": feed["lang"],
        "category": categorize(f"{title} {desc}", feed["category"]),
        "title": title,
        "titleZh": "",
        "link": link,
        "summary": desc,
        "publishedAt": date,
    }


def parse_feed(xml_bytes, feed):
    items = []
    text = xml_bytes.decode("utf-8", errors="replace")
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        root = None

    if root is not None:
        ns = {"atom": "http://www.w3.org/2005/Atom",
              "content": "http://purl.org/rss/1.0/modules/content/"}
        entries = root.findall(".//item")
        is_atom = False
        if not entries:
            entries = root.findall(".//atom:entry", ns)
            is_atom = True
        for i, entry in enumerate(entries[:MAX_ITEMS_PER_FEED]):
            if is_atom:
                title = strip_tags(decode_cdata(entry.findtext("atom:title", "", ns)))
                link_el = entry.find("atom:link[@rel='alternate']", ns) or entry.find("atom:link", ns)
                link = link_el.get("href", "") if link_el is not None else ""
                desc = strip_tags(decode_cdata(
                    entry.findtext("atom:summary", "", ns) or entry.findtext("atom:content", "", ns)))[:300]
                date = parse_date(entry.findtext("atom:published", "", ns) or entry.findtext("atom:updated", "", ns))
            else:
                title = strip_tags(decode_cdata(entry.findtext("title", "")))
                link = strip_tags(decode_cdata(entry.findtext("link", "")))
                ce = entry.find("content:encoded", ns)
                desc_raw = entry.findtext("description", "") or (ce.text if ce is not None else "")
                desc = strip_tags(decode_cdata(desc_raw))[:300]
                date = parse_date(entry.findtext("pubDate", ""))
            if title and link:
                items.append(_mkitem(feed, i, title, link, desc, date))
        if items:
            return items

    blocks = re.findall(r"<item[\s>].*?</item>", text, re.S | re.I) or \
             re.findall(r"<entry[\s>].*?</entry>", text, re.S | re.I)
    for i, block in enumerate(blocks[:MAX_ITEMS_PER_FEED]):
        tm = re.search(r"<title[^>]*>(.*?)</title>", block, re.S | re.I)
        title = strip_tags(decode_cdata(tm.group(1))) if tm else ""
        lm = re.search(r"<link[^>]*>(.*?)</link>", block, re.S | re.I) or \
             re.search(r'<link[^>]*href=["\']([^"\']+)', block, re.I)
        link = strip_tags(decode_cdata(lm.group(1))) if lm else ""
        dm = re.search(r"<description[^>]*>(.*?)</description>", block, re.S | re.I)
        desc = strip_tags(decode_cdata(dm.group(1)))[:300] if dm else ""
        pm = re.search(r"<pubDate[^>]*>(.*?)</pubDate>", block, re.S | re.I)
        date = parse_date(pm.group(1)) if pm else ""
        if title and link:
            items.append(_mkitem(feed, i, title, link, desc, date))
    return items


def fetch_feed(feed):
    req = urllib.request.Request(feed["url"], headers={
        "User-Agent": UA,
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    })
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
            return parse_feed(resp.read(), feed)
    except Exception as e:
        print(f"  [warn] {feed['name']}: {e}", file=sys.stderr)
        return []


# ── Translation ─────────────────────────────────

def _http_get(url, timeout=10):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8")


def _translate_mymemory(title):
    email = os.environ.get("MYMEMORY_EMAIL", "")
    q = urllib.parse.quote(title.strip()[:450])
    url = f"https://api.mymemory.translated.net/get?q={q}&langpair=en|zh-CN"
    if email:
        url += "&de=" + urllib.parse.quote(email)
    data = json.loads(_http_get(url, timeout=12))
    if data.get("responseStatus") == 200:
        zh = (data.get("responseData") or {}).get("translatedText", "")
        # MyMemory echoes the source uppercased when it cannot translate.
        if zh and zh.strip().upper() != title.strip().upper():
            return zh.strip()
    return ""


def _translate_google(title):
    q = urllib.parse.quote(title.strip()[:300])
    url = f"https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q={q}"
    data = json.loads(_http_get(url, timeout=10))
    parts = data[0] if isinstance(data, list) and data and isinstance(data[0], list) else []
    zh = "".join(p[0] for p in parts if isinstance(p, list) and p and isinstance(p[0], str))
    return zh.strip()


def translate_one(title):
    """Translate one EN title with retries; MyMemory first, Google fallback."""
    if not title or not title.strip():
        return title, ""
    for attempt in range(3):
        try:
            zh = _translate_mymemory(title)
            if zh:
                return title, zh
        except Exception:
            pass
        try:
            zh = _translate_google(title)
            if zh:
                return title, zh
        except Exception:
            pass
        time.sleep(1.5 * (attempt + 1))  # backoff on rate limit
    return title, ""


def load_cache():
    try:
        raw = json.loads(CACHE_OUT.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            return OrderedDict(raw)
    except Exception:
        pass
    return OrderedDict()


def save_cache(cache):
    # Bound the cache size, keeping the most recently added entries.
    while len(cache) > CACHE_MAX_ENTRIES:
        cache.popitem(last=False)
    CACHE_OUT.parent.mkdir(parents=True, exist_ok=True)
    CACHE_OUT.write_text(json.dumps(cache, ensure_ascii=False, indent=0), encoding="utf-8")


def translate_items(items, cache):
    en_items = [it for it in items if it["lang"] == "en" and it["title"]][:MAX_TRANSLATE]
    todo = [it for it in en_items if it["title"] not in cache]
    # Apply cached translations.
    for it in en_items:
        zh = cache.get(it["title"])
        if zh:
            it["titleZh"] = zh

    if todo:
        print(f"Translating {len(todo)} new English titles ({len(en_items) - len(todo)} cached)…")
        with ThreadPoolExecutor(max_workers=4) as ex:
            for title, zh in ex.map(lambda it: translate_one(it["title"]), todo):
                if zh:
                    cache[title] = zh
        for it in todo:
            zh = cache.get(it["title"])
            if zh:
                it["titleZh"] = zh
        ok = sum(1 for it in todo if it["titleZh"])
        print(f"  translated {ok}/{len(todo)} new")
    else:
        print(f"All {len(en_items)} English titles cached.")

    return {it["title"]: it["titleZh"] for it in en_items if it["titleZh"]}


def build(do_translate=True):
    print(f"Fetching {len(FEEDS)} feeds…")
    with ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(fetch_feed, FEEDS))

    items, failed = [], []
    for feed, res in zip(FEEDS, results):
        if res:
            items.extend(res)
            print(f"  [ok]   {feed['name']}: {len(res)}")
        else:
            failed.append(feed["name"])
            print(f"  [fail] {feed['name']}")

    seen, deduped = set(), []
    for it in items:
        key = it["title"].lower().strip()
        if key and key not in seen:
            seen.add(key)
            deduped.append(it)
    items = deduped
    items.sort(key=lambda x: x.get("publishedAt", ""), reverse=True)
    items = items[:MAX_TOTAL_ITEMS]

    cache = load_cache()
    translations = translate_items(items, cache) if do_translate else {}
    if do_translate:
        save_cache(cache)

    return {
        "ok": True,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "count": len(items),
        "sources": [{k: f[k] for k in ("id", "name", "lang", "category")} for f in FEEDS],
        "failedSources": failed,
        "translations": translations,
        "items": items,
    }


def main():
    ap = argparse.ArgumentParser(description="Generate static news JSON for BioPharma Hub.")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="output JSON path")
    ap.add_argument("--no-translate", action="store_true", help="skip title translation")
    args = ap.parse_args()

    payload = build(do_translate=not args.no_translate)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nWrote {payload['count']} items to {out}")
    if payload["failedSources"]:
        print(f"Failed sources: {', '.join(payload['failedSources'])}")


if __name__ == "__main__":
    main()

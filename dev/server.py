#!/usr/bin/env python3
"""Local dev server: serves web/ static files + simulates the RSS news Function.
Usage: python dev/server.py [port]
News endpoint works locally; AI endpoint returns ai_not_configured (needs deployed backend).
"""
import http.server
import json
import re
import socketserver
import sys
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
WEB_DIR = Path(__file__).resolve().parent.parent / "web"

FEEDS = [
    {"id": "nature-biotech", "name": "Nature Biotechnology", "lang": "en", "category": "研发", "url": "https://www.nature.com/nbt.rss"},
    {"id": "fierce-biotech", "name": "FierceBiotech", "lang": "en", "category": "市场", "url": "https://www.fiercebiotech.com/rss/xml"},
    {"id": "stat-news", "name": "STAT News", "lang": "en", "category": "研发", "url": "https://www.statnews.com/feed/"},
    {"id": "endpoints", "name": "Endpoints News", "lang": "en", "category": "市场", "url": "https://endpts.com/feed/"},
    {"id": "biopharma-dive", "name": "BioPharma Dive", "lang": "en", "category": "审批", "url": "https://www.biopharmadive.com/feeds/news/"},
    {"id": "gen", "name": "GEN", "lang": "en", "category": "技术", "url": "https://www.genengnews.com/feed/"},
    {"id": "science-daily-bio", "name": "ScienceDaily Biology", "lang": "en", "category": "技术", "url": "https://www.sciencedaily.com/rss/top/biology.xml"},
    {"id": "bioon", "name": "生物谷", "lang": "zh", "category": "研发", "url": "https://www.bioon.com/rss/rss.xml"},
]

CACHE = {"at": 0, "data": None}
CACHE_TTL = 600  # seconds


def strip_tags(s):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", s or "")).strip()


def parse_date(s):
    if not s:
        return ""
    try:
        return parsedate_to_datetime(s.strip()).astimezone(timezone.utc).isoformat()
    except Exception:
        try:
            return datetime.fromisoformat(s.strip().replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()
        except Exception:
            return ""


def parse_feed(xml_bytes, feed):
    items = []
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        # fallback: regex-based extraction for malformed feeds
        text = xml_bytes.decode("utf-8", errors="replace")
        blocks = re.findall(r"<item[\s>].*?</item>", text, re.S | re.I) or re.findall(r"<entry[\s>].*?</entry>", text, re.S | re.I)
        for i, block in enumerate(blocks[:20]):
            title = strip_tags(re.search(r"<title[^>]*>(.*?)</title>", block, re.S | re.I).group(1) if re.search(r"<title[^>]*>(.*?)</title>", block, re.S | re.I) else "")
            link_m = re.search(r"<link[^>]*>(.*?)</link>", block, re.S | re.I) or re.search(r'<link[^>]*href=["\']([^"\']+)', block, re.I)
            link = strip_tags(link_m.group(1)) if link_m else ""
            desc_m = re.search(r"<description[^>]*>(.*?)</description>", block, re.S | re.I)
            desc = strip_tags(desc_m.group(1))[:300] if desc_m else ""
            date_m = re.search(r"<pubDate[^>]*>(.*?)</pubDate>", block, re.S | re.I)
            if title and link:
                items.append({"id": f"{feed['id']}-{i}", "source": feed["name"], "sourceId": feed["id"],
                              "lang": feed["lang"], "category": feed["category"], "title": title,
                              "link": link, "summary": desc, "publishedAt": parse_date(date_m.group(1) if date_m else "")})
        return items

    ns = {"atom": "http://www.w3.org/2005/Atom", "content": "http://purl.org/rss/1.0/modules/content/"}
    entries = root.findall(".//item")
    is_atom = False
    if not entries:
        entries = root.findall(".//atom:entry", ns)
        is_atom = True

    for i, entry in enumerate(entries[:20]):
        if is_atom:
            title = strip_tags(entry.findtext("atom:title", "", ns))
            link_el = entry.find("atom:link[@rel='alternate']", ns) or entry.find("atom:link", ns)
            link = link_el.get("href", "") if link_el is not None else ""
            desc = strip_tags(entry.findtext("atom:summary", "", ns) or entry.findtext("atom:content", "", ns))[:300]
            date = parse_date(entry.findtext("atom:published", "", ns) or entry.findtext("atom:updated", "", ns))
        else:
            title = strip_tags(entry.findtext("title", ""))
            link = strip_tags(entry.findtext("link", ""))
            desc = strip_tags(entry.findtext("description", "") or (entry.findtext("content:encoded", "", ns) if entry.find("content:encoded", ns) is not None else ""))[:300]
            date = parse_date(entry.findtext("pubDate", ""))
        if not title or not link:
            continue
        items.append({"id": f"{feed['id']}-{i}", "source": feed["name"], "sourceId": feed["id"],
                      "lang": feed["lang"], "category": feed["category"], "title": title,
                      "link": link, "summary": desc, "publishedAt": date})
    return items


def fetch_feed(feed):
    req = urllib.request.Request(feed["url"], headers={
        "User-Agent": "Mozilla/5.0 (compatible; BioPharmaHub/1.0)",
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    })
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            return parse_feed(resp.read(), feed)
    except Exception:
        return []


def get_news():
    import time
    if CACHE["data"] and time.time() - CACHE["at"] < CACHE_TTL:
        return CACHE["data"]
    with ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(fetch_feed, FEEDS))
    items, failed = [], []
    for feed, res in zip(FEEDS, results):
        if res:
            items.extend(res)
        else:
            failed.append(feed["name"])
    items.sort(key=lambda x: x.get("publishedAt", ""), reverse=True)
    payload = {"ok": True, "updatedAt": datetime.now(timezone.utc).isoformat(), "count": len(items),
               "sources": [{k: f[k] for k in ("id", "name", "lang", "category")} for f in FEEDS],
               "failedSources": failed, "items": items[:120]}
    CACHE["at"] = time.time()
    CACHE["data"] = payload
    return payload


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write(f"[dev] {args[0]}\n")

    def do_GET(self):
        if self.path.startswith("/functions/v1/app/news") or self.path == "/functions/v1/app":
            data = get_news()
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith("/functions/v1/app/feeds"):
            body = json.dumps({"ok": True, "feeds": FEEDS}, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith("/functions/v1/app/health"):
            body = json.dumps({"ok": True, "service": "biopharma-hub-dev"}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()

    def do_POST(self):
        if self.path.startswith("/functions/v1/app/protocol/enhance"):
            body = json.dumps({"ok": False, "error": "ai_not_configured",
                               "message": "AI 辅助在本地开发模式下不可用。发布站点并启用 Qoder 后端服务后即可使用。"},
                              ensure_ascii=False).encode("utf-8")
            self.send_response(503)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(405)


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


if __name__ == "__main__":
    with ReusableTCPServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"BioPharma Hub dev server: http://127.0.0.1:{PORT}")
        print(f"Serving {WEB_DIR}")
        print("News RSS proxy: active | AI endpoint: disabled (needs deployed backend)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")

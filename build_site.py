"""Builds docs/index.html from template.html + snapshot.json (+ current rankings and live scores)."""
import json, os, re, unicodedata, urllib.parse

IOC = dict(ARG="AR",AUS="AU",AUT="AT",BEL="BE",BIH="BA",BOL="BO",BRA="BR",BUL="BG",CAN="CA",CHI="CL",CHN="CN",COL="CO",CRO="HR",
  CZE="CZ",DEN="DK",ESP="ES",EST="EE",FIN="FI",FRA="FR",GBR="GB",GEO="GE",GER="DE",GRE="GR",HKG="HK",HUN="HU",IND="IN",ITA="IT",
  JPN="JP",KAZ="KZ",KOR="KR",LTU="LT",LUX="LU",MON="MC",NED="NL",NOR="NO",PAR="PY",PER="PE",POL="PL",POR="PT",RSA="ZA",SRB="RS",
  SUI="CH",SVK="SK",SWE="SE",TUN="TN",USA="US",AND="AD",ARM="AM",EGY="EG",INA="ID",LAT="LV",MEX="MX",NZL="NZ",PHI="PH",ROU="RO",
  SLO="SI",THA="TH",TPE="TW",TUR="TR",UKR="UA",UZB="UZ",ECU="EC",URU="UY",CYP="CY",ISR="IL",MDA="MD",MAR="MA",IRL="IE",CRC="CR",
  DOM="DO",PUR="PR",VEN="VE",QAT="QA",LIB="LB",BAR="BB",SGP="SG",MAS="MY",VIE="VN",ZIM="ZW",KEN="KE",NGR="NG",ISL="IS",MLT="MT",
  MNE="ME",MKD="MK",ALB="AL",AZE="AZ",KGZ="KG",UAE="AE",KSA="SA",JOR="JO",PAK="PK",SRI="LK",GUA="GT",PAN="PA",ESA="SV",JAM="JM",
  TTO="TT",BAH="BS",CUB="CU",LIE="LI",BEN="BJ",CIV="CI",SEN="SN",GHA="GH",TOG="TG",BDI="BI",LBN="LB",IRI="IR",KUW="KW",OMA="OM")
key = lambda s: re.sub(r"[^a-z]", "", unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower())


PWA_HEAD = """<link rel="manifest" href="manifest.webmanifest">
<meta name="theme-color" content="#140F3A">
<link rel="icon" type="image/svg+xml" href="favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="favicon-32.png">
<link rel="icon" type="image/png" sizes="192x192" href="icon-192.png">
<link rel="apple-touch-icon" href="icon-180.png">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Cosmo Sports">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="application-name" content="Cosmo Sports">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Cosmo Sports">
<meta property="og:title" content="Cosmo Sports: live scores, replays and predictions">
<meta property="og:description" content="Live scores, animated play-by-play, real replays, box scores, standings, team pages, news and predictions for the NFL, NBA, MLB, NHL, Premier League and tennis.">
<meta property="og:image" content="__SITE__og-image.png">
<meta property="og:url" content="__SITE__">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="__SITE__og-image.png">
<link rel="canonical" href="__SITE__">"""

MANIFEST = {
    "id": "./", "name": "Cosmo Sports", "short_name": "Cosmo Sports", "lang": "en", "dir": "ltr",
    "description": "Every game, every league, one app. Live scores, animated play-by-play with real highlight replays, box scores, standings, team pages with schedules and rosters, news, and data-driven win predictions for the NFL, NBA, MLB, NHL, Premier League and tennis. Follow your teams across every league.",
    "categories": ["sports", "news", "entertainment"],
    "start_url": "./", "scope": "./", "display": "standalone", "display_override": ["standalone"], "orientation": "any",
    "background_color": "#140F3A", "theme_color": "#140F3A",
    "icons": [
        {"src": "icon-192.png", "sizes": "192x192", "type": "image/png"},
        {"src": "icon-512.png", "sizes": "512x512", "type": "image/png"},
        {"src": "icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        {"src": "icon-1024.png", "sizes": "1024x1024", "type": "image/png"},
        {"src": "favicon.svg", "sizes": "any", "type": "image/svg+xml"}],
    "screenshots": [
        {"src": "screenshots/phone-universe.png", "sizes": "780x1688", "type": "image/png", "form_factor": "narrow", "label": "The Universe: every live game at once, ranked by excitement"},
        {"src": "screenshots/phone-games.png", "sizes": "780x1688", "type": "image/png", "form_factor": "narrow", "label": "Live games with logos and win chances"},
        {"src": "screenshots/phone-pbp.png", "sizes": "780x1688", "type": "image/png", "form_factor": "narrow", "label": "Animated play-by-play and real replays"},
        {"src": "screenshots/phone-box.png", "sizes": "780x1688", "type": "image/png", "form_factor": "narrow", "label": "Full box scores"},
        {"src": "screenshots/phone-team.png", "sizes": "780x1688", "type": "image/png", "form_factor": "narrow", "label": "Team pages with schedule and roster"},
        {"src": "screenshots/desktop.png", "sizes": "1280x800", "type": "image/png", "form_factor": "wide", "label": "The Universe on a computer"}],
    "shortcuts": [
        {"name": "Following", "short_name": "Following", "url": "./?sport=following", "icons": [{"src": "icon-192.png", "sizes": "192x192"}]},
        {"name": "Find a team", "short_name": "Search", "url": "./?search=1", "icons": [{"src": "icon-192.png", "sizes": "192x192"}]},
        {"name": "Tennis live scores", "short_name": "Tennis", "url": "./?tab=live", "icons": [{"src": "icon-192.png", "sizes": "192x192"}]}],
}

SW = """// Cosmo Sports offline helper and notifications. The app opens instantly and still works without signal,
// showing the last ratings and scores it saw. Build: __STAMP__
const CACHE = "baseline-__STAMP__";
const SHELL = ["./", "index.html", "live.json", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-180.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin === location.origin && (e.request.mode === "navigate" || url.pathname.endsWith("live.json") || url.pathname.endsWith("index.html"))) {
    // fresh first: new scores and nightly ratings win, the cached copy is the offline fallback
    e.respondWith(fetch(e.request, { cache: "no-cache" }).then(r => { const c = r.clone(); caches.open(CACHE).then(k => k.put(url.pathname.endsWith("live.json") ? "live.json" : e.request, c)); return r; })
      .catch(() => caches.match(url.pathname.endsWith("live.json") ? "live.json" : e.request).then(r => r || caches.match("index.html"))));
    return;
  }
  // icons, fonts: cached copy first (see below)
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => {
    if (res.ok && (url.origin === location.origin || url.hostname.endsWith("gstatic.com") || url.hostname.endsWith("googleapis.com"))) { const c = res.clone(); caches.open(CACHE).then(k => k.put(e.request, c)); }
    return res; })));
});
// Match alerts from the alerts service arrive here, even when the app is closed.
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { title: "Cosmo Sports", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Cosmo Sports", { body: d.body || "", tag: d.tag || "cosmo", renotify: true,
    icon: "icon-192.png", badge: "icon-192.png", data: { url: d.url || "./?tab=watch" } }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const target = new URL(e.notification.data && e.notification.data.url || "./", self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.startsWith(self.registration.scope)) { c.navigate(target); return c.focus(); }
    return clients.openWindow(target);
  }));
});
"""


def write_pwa(folder, stamp):
    os.makedirs(folder, exist_ok=True)
    json.dump(MANIFEST, open(os.path.join(folder, "manifest.webmanifest"), "w"), indent=1)
    open(os.path.join(folder, "sw.js"), "w").write(SW.replace("__STAMP__", re.sub(r"[^0-9a-z-]", "", stamp)))


def alerts_url():
    """The alerts service address: from site_config.json (written by the setup job) or the ALERTS_URL variable."""
    url = os.environ.get("ALERTS_URL", "").strip()
    if not url and os.path.exists("site_config.json"):
        url = json.load(open("site_config.json")).get("alerts_url", "")
    return url.rstrip("/")


def espn_norm():
    """The alerts service's ESPN code, reused by the page so it can read ESPN directly (ESPN turns away Cloudflare)."""
    src = open("alerts/worker.js", encoding="utf-8").read()
    start, end = src.index("export const LEAGUES"), src.index("async function cached(")
    return src[start:end].replace("export ", "")


def local_logos(sports, folder, refresh_days=30):
    """Small copies of every team logo, served from this site: some browsers and blockers refuse images from ESPN's server."""
    import time, urllib.request
    for lg, L in sports.get("leagues", {}).items():
        for t in L.get("teams", []):
            src = t.get("logo")
            if not src:
                continue
            name = re.sub(r"[^a-z0-9]+", "-", unicodedata.normalize("NFKD", t["name"]).encode("ascii", "ignore").decode().lower()).strip("-") + ".png"
            path = os.path.join(folder, "logos", lg, name)
            if not os.path.exists(path) or time.time() - os.path.getmtime(path) > refresh_days * 86400:
                small = "https://a.espncdn.com/combiner/i?" + urllib.parse.urlencode({"img": urllib.parse.urlparse(src).path, "w": 96, "h": 96})
                for url in (small, src):
                    try:
                        data = urllib.request.urlopen(url, timeout=20).read()
                        if data[:8] == b"\x89PNG\r\n\x1a\n":
                            os.makedirs(os.path.dirname(path), exist_ok=True)
                            open(path, "wb").write(data)
                            break
                    except Exception:
                        pass
            if os.path.exists(path):
                t["logo_local"] = f"logos/{lg}/{name}"


def main(hosted=True, out="docs/index.html"):
    snap = json.load(open("snapshot.json"))
    if os.path.exists("data/rankings_live.json"):
        rl = json.load(open("data/rankings_live.json"))
        for t in ("atp", "wta"):
            cur = {key(r["name"]): r for r in rl.get(t, [])}
            if not cur:
                continue
            for p in snap[t]["players"]:
                r = cur.get(key(p["name"]))
                p["rank_jun"] = p.get("rank")
                p["rank"], p["pts"], p["rank_src"] = (r["rank"], r["points"], "live") if r else (None, None, "live")
                p.pop("rank_note", None)
            snap[t]["live_rank_date"] = int(rl["date"]); snap[t]["live_rank_full"] = True
    used = sorted({p["ioc"] for t in ("atp", "wta") for p in snap[t]["players"] if p["ioc"] in IOC})
    flags = {k: IOC[k] for k in used}
    emoji = "".join("".join(chr(0x1F1E6 + ord(c) - 65) for c in iso) for iso in flags.values())
    font = "https://fonts.googleapis.com/css2?family=Noto+Color+Emoji&display=swap&text=" + urllib.parse.quote(emoji)
    live_path = "docs/live.json"
    live = json.load(open(live_path)) if os.path.exists(live_path) else {"asof": "1970-01-01T00:00:00Z", "matches": []}
    tpl = open("template.html", encoding="utf-8").read()
    sports = json.load(open("sports.json")) if os.path.exists("sports.json") else {"built": "", "leagues": {}}
    if hosted:
        local_logos(sports, os.path.dirname(out))
    html = (tpl.replace("/*LIVE*/", json.dumps(live)).replace("/*SPORTS*/", json.dumps(sports, separators=(",", ":"))).replace("/*TEAMCOLORS*/", open("team_colors.json").read()).replace("/*FLAGFONT*/", font).replace("/*FLAGS*/", json.dumps(flags))
               .replace("/*HOSTED*/false", "true" if hosted else "false")
               .replace("/*ALERTS_URL*/", alerts_url() if hosted else "")
               .replace("/*ESPN_NORM*/", espn_norm())
               .replace("/*DATA*/", json.dumps(snap, separators=(",", ":")).replace("<", "\\u003c")))
    if hosted:
        stamp = str(snap.get("built", "")) + "-" + str(len(html))
        repo = os.environ.get("GITHUB_REPOSITORY", "")                 # owner/name on GitHub Actions: the site's public address
        site = f"https://{repo.split('/')[0].lower()}.github.io/{repo.split('/')[1]}/" if "/" in repo else ""
        html = html.replace("<!--PWA-->", PWA_HEAD.replace("__SITE__", site))
        write_pwa(os.path.dirname(out), stamp)
        # names the alerts service uses to match API names like "J. Sinner"
        json.dump([{"name": p["name"], "tour": t} for t in ("atp", "wta") for p in snap[t]["players"]],
                  open(os.path.join(os.path.dirname(out), "players.json"), "w"), separators=(",", ":"))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "w", encoding="utf-8").write(html)
    print(f"built {out} ({len(html)//1024} KB)")


if __name__ == "__main__":
    main()

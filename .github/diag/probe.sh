set +e
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
get() { curl -sS -m 20 -A "$UA" -H "Origin: https://arro2121.github.io" -D /tmp/h -o /tmp/b -w "%{http_code}" "$1"; echo " $(grep -i '^access-control-allow-origin' /tmp/h | tr -d '\r') $(wc -c </tmp/b)B"; }
for lg in "mlb" "nfl" "nhl" "nba" "soccer:eng.1"; do
  sp=${lg%%:*}; q=""; [ "$sp" = soccer ] && q="&league=${lg#*:}"
  u="https://cdn.espn.com/core/$sp/scoreboard?xhr=1$q"; echo "== $u"; get "$u"
  python3 - <<'PY'
import json; d=json.load(open('/tmp/b'))
print(" top:", list(d)[:12]); c=d.get('content',{}); print(" content:", list(c)[:12])
sb=c.get('sbData') or {}; print(" sbData:", list(sb)[:10]); ev=sb.get('events',[])
print(" events:", len(ev))
if ev:
  e=ev[0]; print(" ev keys:", list(e)[:15]); comp=e['competitions'][0]; print(" comp keys:", list(comp)[:25])
  print(" state:", e.get('status',{}).get('type',{}).get('state'), "id", e['id'])
  open('/tmp/id','w').write(e['id'])
  ins=[x['id'] for x in ev if x.get('status',{}).get('type',{}).get('state') in ('in','post')]
  if ins: open('/tmp/id','w').write(ins[0])
PY
  id=$(cat /tmp/id 2>/dev/null); rm -f /tmp/id
  for kind in game playbyplay; do
    u="https://cdn.espn.com/core/$sp/$kind?xhr=1&gameId=$id$q"; echo "-- $u"; get "$u"
    python3 - <<'PY'
import json
try: d=json.load(open('/tmp/b'))
except Exception as e: print(" not json", open('/tmp/b').read()[:150]); raise SystemExit
g=d.get('gamepackageJSON') or {}
print(" top:", list(d)[:10]); print(" gamepackageJSON:", list(g)[:30])
print(" header comps:", bool(g.get('header',{}).get('competitions')), "plays:", len(g.get('plays') or []), "drives:", bool(g.get('drives')), "commentary:", len(g.get('commentary') or []), "keyEvents:", len(g.get('keyEvents') or []), "wp:", len(g.get('winprobability') or []))
PY
  done
done

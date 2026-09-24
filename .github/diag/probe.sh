set +e
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
get() { code=$(curl -sS -m 20 -A "$UA" -H "Origin: https://arro2121.github.io" -D /tmp/h -o /tmp/b -w "%{http_code}" "$1"); echo "$code $(grep -i -E '^(access-control-allow-origin|location)' /tmp/h | tr -d '\r' | tr '\n' ' ') $(wc -c </tmp/b)B  $1"; }
keys() { python3 -c "
import json,sys
try: d=json.load(open('/tmp/b'))
except Exception: print('   not json'); sys.exit()
g=d.get('gamepackageJSON') or {}; sb=(d.get('content') or {}).get('sbData') or {}
print('   events', len(sb.get('events',[])) if sb else '-', '| gp', list(g)[:14], '| plays', len(g.get('plays') or []), 'commentary', len(g.get('commentary') or []), 'keyEvents', len(g.get('keyEvents') or []))"; }
for u in "https://site.web.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard" "https://site.web.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard" "https://site.web.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=401879276"; do get "$u"; done
get "https://cdn.espn.com/core/nhl/scoreboard?xhr=1&dates=20261010"; keys
get "https://cdn.espn.com/core/nhl/scoreboard?xhr=1&league=nhl"; keys
get "https://cdn.espn.com/core/hockey/scoreboard?xhr=1&league=nhl"; keys
get "https://cdn.espn.com/core/nhl/schedule?xhr=1"; keys
for p in match game commentary matchstats; do get "https://cdn.espn.com/core/soccer/$p?xhr=1&gameId=401879276"; keys; done
get "https://cdn.espn.com/core/soccer/scoreboard?xhr=1&league=eng.1&dates=20260920"; keys

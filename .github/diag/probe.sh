set +e
UAS=("curl/8.5.0" "python-requests/2.32.3" "node" "okhttp/4.12.0" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" "Baseline/1.0" "")
URLS=(
 "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard"
 "https://site.web.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard"
 "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary?event=401815000"
 "https://sports.core.api.espn.com/v2/sports/baseball/leagues/mlb/events"
 "https://cdn.espn.com/core/mlb/scoreboard?xhr=1"
 "https://site.api.espn.com/apis/v2/scoreboard/header?sport=baseball&league=mlb"
)
for u in "${URLS[@]}"; do echo "== $u"
  for ua in "${UAS[@]}"; do
    code=$(curl -sS -m 20 -o /tmp/b -w "%{http_code}" -A "$ua" -H "Origin: https://arro2121.github.io" -D /tmp/h "$u")
    acao=$(grep -i '^access-control-allow-origin' /tmp/h | tr -d '\r')
    printf '  %-4s [%s] UA=%s\n' "$code" "${acao:-no ACAO}" "${ua:0:40}"
  done
  echo "  403 body sample:"; curl -sS -m 20 -A "Baseline/1.0" "$u" | head -c 300; echo
done

<p align="center"><img src="docs/icon-192.png" width="96" alt="Cosmo Sports"></p>

# Cosmo Sports

**Every game, every league, one app.** Live scores, animated play-by-play with real highlight replays, box scores,
standings, team pages, news and data-driven predictions for the NFL, NBA, MLB, NHL, Premier League and tennis.
It installs on iPhone, Android, Windows and Mac, updates itself every night, and runs on free hosting.

**What makes it different**
* **Ask Cosmo:** an AI sports companion that answers questions about any game, team or pick from live scores,
  last night's results, the open game's plays and box score, your teams and the Cosmo model.
* **Picks:** a **Daily 3** of the day's closest calls with a streak, a shareable result grid and friend challenge
  links (no account needed), plus your running record against the Cosmo model.
* **Comets:** articles and takes from you to everyone who uses the app, with a reader, share links, a teaser on
  Today and an optional alert to everyone when you publish. Only the holder of the writer key can post (setup below).
* **Getting around:** a five-stop bottom bar (Today, Scores, Picks, Following, More), an in-app **Guide** (More ›
  Guide), a one-time What's new screen after big updates, and an offline notice.
* **League leaders:** a Leaders tab in every league with the real stat leaders and their headshots, updated nightly.
  Tap a player for their season stats and how they rank against the league's best.
* **Listen Live:** tap 🎧 Listen in any live game and a natural human voice reads new key plays, scores, period
  changes and the final aloud, like a radio call. The voice comes from the alerts service (Cloudflare Workers AI
  text to speech, inside the free daily allowance), with the phone's own voice as the backup. Pick the voice and
  speed in Settings; the spoiler shield keeps it silent until you reveal.
* **Today:** every game across the five leagues on one screen, with the closest and latest games nearest the center.
* **Notifications:** game starts, scoring plays, close finishes, final scores and a 9 AM morning briefing for your
  teams and any game you tap the bell on, even with the app closed.
* **Spoiler shield:** hide scores for your teams (or every game) until you tap to reveal them, in the app and in
  alerts. Great if you watch on replay.
* **Excitement score:** 0-100 for how close and how late each game is; finals are tagged "Thriller" or "Close game".
* **Turning points:** the plays that swung win probability the most, marked on the chart. Tap one to replay it.
* **Animated replays:** every play drawn on the field with the players moving, and the camera easing in on the key
  moment.
* **Model picks:** the prediction model's strongest picks for today, where it disagrees with the betting market,
  and toss-ups.
* **First-run setup, optional sound effects, player of the game, season results chart, power-rankings map and
  shareable score images.**

**What's in it**
* **Games:** today's scores (or any other day) with team logos, win chances, betting lines and live situations;
  follow teams with ☆ to pin their games first; add upcoming games to your calendar.
* **Play-by-play:** readable plays grouped by inning, quarter or period, with player photos, labels for the big
  moments, and an animated field for every sport that replays each play. ESPN's real highlight clips play inside
  the app, matched to the play they show.
* **Box scores:** line scores, team stat comparisons and full player tables for every sport, plus top performers.
* **Game info and previews:** Cosmo's prediction, the betting line, injuries, recent form, venue, weather,
  officials and news.
* **Standings, news and team pages:** official standings, league and team news, and a page for every team with
  its schedule, results and roster.
* **Following:** your teams across every league in one feed, with live scores, last results and next games.
* **Search, sharing and links:** find any team; share a game or team with a link that opens it directly.
* **Predictions:** power ratings and a predictor for any two teams (win chances, fair prices, NFL spreads,
  soccer draw chances), and a 20-factor tennis model for every ATP and WTA pro with live point-by-point.

## Set it up from your iPhone (about 20 minutes, no computer needed)

**You'll need**
* A free **GitHub** account (hosts the app and runs the nightly updates): [github.com/signup](https://github.com/signup)
* A free **Cloudflare** account (runs the live service for scores and play-by-play): [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up)
* An **API-Tennis** key for live tennis and new tennis results (paid): [api-tennis.com](https://api-tennis.com).
  The team sports use ESPN's free data and need no key.

**Step 1: Save this file.** Keep `baseline.zip` in your Files app (usually in Downloads). Don't unzip it.

**Step 2: Get a Cloudflare token.** In Cloudflare tap your profile icon > **My Profile** > **API Tokens** >
**Create Token**, choose the **Edit Cloudflare Workers** template, set *Account Resources* to your account and
*Zone Resources* to **All zones**, then **Continue to summary** > **Create Token**. Copy the token.

**Step 3: Create the repository.** On github.com tap **+** > **New repository**, name it `baseline`, choose
**Public**, and tap **Create repository**.

**Step 4: Add your keys.** In the repository: **Settings** > **Secrets and variables** > **Actions** >
**New repository secret**. Add `CLOUDFLARE_API_TOKEN` (from step 2) and `API_TENNIS_KEY`.

**Step 5: Turn on the website.** **Settings** > **Pages** > set **Source** to **GitHub Actions**.

**Step 6: Upload the app.** On the repository's main page (**Code** tab): **Add file** > **Upload files** >
choose `baseline.zip` > **Commit changes**.

**Step 7: Start it.** **Add file** > **Create new file**, name it exactly `.github/workflows/baseline.yml`,
paste in everything from the `baseline.yml` file that came with this download, and tap **Commit changes**.
This unpacks the app, sets up the live service, downloads results, builds every rating and publishes the site.
Watch it in the **Actions** tab; the first run takes 15 to 30 minutes.

**Step 8: Install it.** Open `https://YOUR-GITHUB-USERNAME.github.io/baseline/` in **Safari**, tap **Share** >
**Add to Home Screen** > **Add**, and open Cosmo Sports from its new icon.

*Tip:* if a GitHub menu is missing on your phone, tap **aA** in Safari's address bar > **Request Desktop Website**.

## Set it up from a computer

Same steps, or upload all the unzipped files (including the hidden `.github` folder) instead of steps 6 and 7.

---

## Where the data comes from

| | Ratings and rankings | Live scores and play-by-play |
| --- | --- | --- |
| Tennis | Every tour, Challenger and ITF match since 2012 (Jeff Sackmann / Tennis Abstract) plus new results from API-Tennis | API-Tennis, point by point |
| NFL | Every game since 1999 (nflverse) | ESPN |
| Premier League | Five seasons of results (openfootball) | ESPN |
| MLB | Current records from ESPN, starting each season from last season's ratings | **MLB's official Stats API** (statsapi.mlb.com): every pitch, hit locations, win probability, box scores and MLB's own video clips. ESPN is the automatic backup |
| NBA | Current records from ESPN, starting each season from last season's ratings | ESPN |
| NHL | Current records from ESPN, starting each season from last season's ratings | ESPN, with the **NHL's official API** (api-web.nhle.com) as the automatic backup |

**About the data sources:** MLB's and the NHL's APIs are run by the leagues themselves, are free and need no key.
ESPN's feed is free and needs no key too, but it's unofficial and could change without notice; the app tries
several ESPN addresses before giving up, and your alerts service caches results so it asks ESPN at most once
every couple of minutes however many people use the app. Every request has a time limit and one retry, and
every five minutes GitHub also publishes a copy of today's scores to the site itself (`scores.json`). If a phone's
network blocks ESPN and the alerts service (some school, work and hotel Wi-Fi, VPNs and content blockers do), the
app shows that copy, a few minutes behind and labeled as such, instead of an error. All of these allow personal, non-commercial use, so keep
the app free and ad-free. There is no free official feed with the same detail for the NFL, NBA or Premier League.

**Ask Cosmo (the AI companion)** runs on your Cloudflare account's free Workers AI allowance, with no extra key
or cost. For sharper answers, add a GitHub secret named `ANTHROPIC_API_KEY` (from console.anthropic.com) and run
the workflow; the companion then uses Claude (billed to your Anthropic account per question).

**Comets (your articles)** are stored by the alerts service and shown to everyone. Only you can write them:
1. Pick a long passphrase you don't use anywhere else (this is your writer key).
2. In the GitHub repository go to **Settings › Secrets and variables › Actions › New repository secret**, name it
   `COMETS_KEY` and paste the passphrase.
3. Run the workflow (**Actions › Baseline › Run workflow**, "everything" or "alerts") so the service picks it up.
4. In the app open **Comets**, tap **Writer sign-in** at the bottom and enter the same passphrase. That device can
   now publish, edit and delete articles (and send an alert to everyone when you publish). Sign out from the same
   place. Anyone without the key can only read. After 8 wrong keys from one address, sign-in pauses for 15 minutes.

## How good are the predictions?

Every league has a multi-factor model built like the tennis one (`team_models.py`, rebuilt nightly from
`team_history.py`): each game's factors are what was known *before* it, the factors are chosen on validation seasons,
and the numbers below are on later seasons the model never saw. Each league's **Model** tab shows the full report
card (backtest table, calibration chart, what each factor is worth).

| League | Factors | Test games | Picked winner | Log-loss vs Elo alone | Betting market |
|---|---|---|---|---|---|
| Tennis | 20 (ratings, serve and return, head-to-head, form, rest…) | 2024–26 | about 2 in 3 | better | see Model accuracy |
| NFL | Elo, QB continuity, margin, rest, home | 601 (2024–26) | 65.9% | 0.622 vs 0.628 | 68.6%, 0.600 |
| NBA | Elo, rest, margin, home | 2,650 (2024–26) | 66.9% | 0.605 vs 0.608 | — |
| MLB | Elo, starting pitchers (FIP), margin, rest, home | 4,807 (2025–26) | 55.5% | 0.682 vs 0.681 | — |
| NHL | Elo, margin, back-to-backs, rest, shot share, home | 2,614 (2024–26) | 56.3% | 0.677 vs 0.684 | — |
| Premier League | Elo, shot share, form, rest, margin, home (goals model) | 791 (2024–27) | 50.6% (W/D/L) | 1.003 vs 1.023 | 52.0%, 0.992 |

Baseball and hockey are close to coin flips game to game, so even good models sit in the mid-50s. The betting
market knows injuries and lineups the models don't, which is why it stays ahead where we can measure it.

No model is certain. Bet only what you can afford to lose.

### Season odds

Every night `season_sim.py` plays out the rest of each league's season 10,000 times with the same models: every game decided by its
win chance, each team's true strength allowed to drift (more with more games left), and the real playoff formats (NFL 7 per
conference with byes, MLB 6 per league with best-of-3/5/7 rounds, NHL divisions and wildcards, NBA play-in; for the Premier League
the title, the top four and relegation). The app's **Odds** tab shows each team's playoff, division and title chances, charted over
time, what its next game is worth, luck (wins above what points scored and allowed usually bring), the toughest schedules left, and
the week's games that move the most playoff chances across the league (also on Today, as **Most at stake**).

### The live track record

Backtests can flatter a model, so the app also keeps score in public (**More › Track record**, or `?sport=record`).
Starting September 24, 2026, the alerts service locks in the model's pick and the bookmaker's moneyline
(from ESPN's betting feed) for every regular-season and playoff NFL, NBA, MLB, NHL and Premier League game, in the
90 minutes before it starts, and grades it when it ends. A pick can't change once the game has started. The page shows the
record in each league and overall, how often the betting favorite won the same games, and what flat $100 bets would have
made: on every pick, and on value bets only (the model's chance at least 3 points above the market's). A copy is saved to
`docs/track.json` every night.

## What runs automatically

| When | What happens |
| --- | --- |
| While you watch a game | Play-by-play refreshes every 15 seconds, today's games every 30 |
| Every 5 minutes | A backup copy of today's scores is published to the site (and live tennis updates, when there's no alerts service) |
| Every 10 minutes | The alerts service locks in picks for games about to start and grades finished ones (the track record) |
| Every night | New results and rankings download, every league's game history updates and its model is refitted and retested, every rating recalculates, player stats for League Leaders update from real stats, and the site republishes |

Run anything by hand: **Actions** > **Baseline** > **Run workflow**.

## Publish it (Google Play, App Store, Microsoft Store)

Cosmo Sports is a Progressive Web App, so the website *is* the app. It's ready for store packaging: a complete
manifest (name, description, categories, icons including a maskable icon, store screenshots and shortcuts),
an offline mode, a [privacy policy](docs/privacy.html) and [terms of use](docs/terms.html), and social previews.

1. **Check your site address works**: `https://YOUR-GITHUB-USERNAME.github.io/Baseline/` (or your repository name).
2. Open **[PWABuilder](https://www.pwabuilder.com)**, paste the address and press **Start**. It should report the
   manifest, service worker and icons as ready.
3. **Google Play:** choose **Android** > **Generate package**. Create a Google Play developer account ($25 once),
   make a new app, upload the `.aab` file, and add the `assetlinks.json` file PWABuilder gives you at
   `docs/.well-known/assetlinks.json` (upload it with **Add file** > **Upload files**) so the app opens without a
   browser bar.
4. **Microsoft Store:** choose **Windows** > **Generate package** and upload it in Partner Center (free for
   individuals).
5. **Apple App Store:** choose **iOS** > **Generate package**, then open the project in Xcode on a Mac and submit
   it with an Apple developer account ($99 a year). Apple sometimes rejects apps that mainly wrap a website; the
   app's own features (replays, box scores, following) help, but approval isn't guaranteed.

**Store listing text (copy and paste)**
* **Name:** Cosmo Sports
* **Short description:** Live scores, replays, box scores and predictions for every game.
* **Full description:** Every game, every league, one app. Cosmo Sports brings the NFL, NBA, MLB, NHL, Premier
  League and tennis together: live scores, animated replays of every play, real highlight clips, full box scores,
  standings, team pages and news. Ask Cosmo, our AI sports companion, anything about tonight's games. Every game
  gets a prediction from a multi-factor model with the reasons behind it, tested on seasons it never saw. Play the
  Daily 3 and see how your picks stack up against the model. Tap Listen in a live game to
  hear the plays called by a natural human voice. Get alerts for your teams, close finishes and a morning briefing, and turn on the
  spoiler shield when you're watching later. No account, no ads, no tracking.
* **Keywords:** live scores, sports scores, NFL, NBA, MLB, NHL, Premier League, tennis, play by play, box score,
  predictions, picks, sports alerts, AI sports, sports analytics, win probability
* **Category:** Sports · **Content rating:** 17+ / Mature: answer "yes" to gambling-related content (the app shows
  odds but takes no bets and has no prizes) and "yes" to AI-generated content (Ask Cosmo) · **Privacy policy URL:** `https://YOUR-GITHUB-USERNAME.github.io/Baseline/privacy.html`
* **Screenshots:** `docs/screenshots/` (phone and desktop). **Icon:** `docs/icon-512.png`. **Feature graphic /
  social image:** `docs/og-image.png`. The source artwork for the logo is in `brand/`.

**Final checklist before you submit**
1. Open the app on your phone, go through the welcome screens, follow a couple of teams and turn on notifications;
   use Settings > Notifications > Send a test to confirm alerts arrive.
2. Ask Cosmo a question or two (it runs free on Cloudflare; add the optional `ANTHROPIC_API_KEY` secret for Claude).
3. Make your Daily 3 picks and send yourself a challenge link to see how it looks.
4. Run the site address through [PWABuilder](https://www.pwabuilder.com); it should show the manifest, service worker
   and icons as ready, then package for each store as described above.
5. Paste the store text above, upload `docs/screenshots/`, and use `https://YOUR-GITHUB-USERNAME.github.io/Baseline/privacy.html`
   as the privacy policy link.
6. Optional: rename the GitHub repository (Settings > General) to something like `cosmo-sports` **before** you
   publish, so the web address reads better. Do it before anyone installs the app, because installed copies
   are tied to the old address.

**Before you publish, know this:** the scores, clips, photos and logos come from ESPN's public data and belong to
ESPN, the leagues and the teams. That's fine for a free personal app, but stores may ask whether you have the
rights to them, and ESPN doesn't officially license this data. Keep the app free and ad-free, and consider a
licensed sports-data provider if you ever want to charge for it or run ads.

## Files

| File | Purpose |
| --- | --- |
| `template.html` | The app |
| `engine.py` | Tennis ratings, profiles and the prediction model |
| `sports_engine.py` | NFL, NBA, MLB, NHL and Premier League ratings |
| `team_colors.json` | Team colors and abbreviations used on each field (add new teams here) |
| `updater.py` | Tennis live scores, results and rankings from API-Tennis |
| `build_site.py` | Builds the installable site in `docs/` |
| `alerts/` | The live service (Cloudflare Worker): ESPN scores and play-by-play, tennis point by point |
| `.github/workflows/baseline.yml` | Sets up, updates and publishes everything |

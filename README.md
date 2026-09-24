<p align="center"><img src="docs/icon-192.png" width="96" alt="Cosmo Sports"></p>

# Cosmo Sports

**Every game, every league, one app.** Live scores, animated play-by-play with real highlight replays, box scores,
standings, team pages, news and data-driven predictions for the NFL, NBA, MLB, NHL, Premier League and tennis.
It installs on iPhone, Android, Windows and Mac, updates itself every night, and runs on free hosting.

**What makes it different**
* **Ask Cosmo:** an AI sports companion that answers questions about any game, team or pick using live scores,
  the open game's plays and box score, your teams and the Cosmo model: what to watch tonight, why a game swung,
  how your teams did, who the model likes.
* **Today:** every game across the five leagues on one screen, with the closest and latest games nearest the center,
  the best game on right now, and live, upcoming and final lists.
* **Excitement score:** a 0-100 rating of how close and how late each game is, so you know what's worth
  switching to. Finals are tagged "Thriller" or "Close game".
* **Notifications:** game starts, scoring plays, close finishes and final scores for the teams you follow and any
  game you tap the bell on, even with the app closed. You can also get alerts for close finishes in any game.
* **Turning points:** the plays that swung win probability the most, marked on the win-probability chart.
  Tap one to replay it.
* **Animated replays:** every play drawn on the field with the players moving: formations and routes in football,
  fielders chasing the ball in baseball, closeouts and rebounds in basketball, a diving keeper in soccer, and
  skaters and the goalie in hockey. The camera eases in on the key moment.
* **Model picks:** the prediction model's strongest picks for today, games where it disagrees with the betting
  market, and toss-ups.
* **Picks:** pick winners before games start; picks are graded automatically and compared with the model.
* **Player of the game, season results chart, power-rankings map** and **shareable score images**.

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
every couple of minutes however many people use the app. All of these allow personal, non-commercial use, so keep
the app free and ad-free. There is no free official feed with the same detail for the NFL, NBA or Premier League.

**Ask Cosmo (the AI companion)** runs on your Cloudflare account's free Workers AI allowance, with no extra key
or cost. For sharper answers, add a GitHub secret named `ANTHROPIC_API_KEY` (from console.anthropic.com) and run
the workflow; the companion then uses Claude (billed to your Anthropic account per question).

## How good are the predictions?

Measured on games each model had never seen:
* **Tennis:** picks about two-thirds of winners (Model accuracy tab).
* **NFL:** picked 63.4% of winners in 2021–2026; the betting market picked 66.7% of the same games.
* **Premier League:** called the result (win, draw or loss) 51.8% of the time in 2025–27.
* **MLB, NBA, NHL:** based on records, so they're a reasonable guide but simpler than the others.

No model is certain. Bet only what you can afford to lose.

## What runs automatically

| When | What happens |
| --- | --- |
| While you watch a game | Play-by-play refreshes every 15 seconds, today's games every 30 |
| Every 2 minutes | Live tennis scores update |
| Every night | New results and rankings download, every rating recalculates, and the site republishes |

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
  standings, team pages with schedules and rosters, news and data-driven win predictions. See every game on one
  screen with an excitement score for each, get notifications for your teams and close finishes, find the plays
  that swung each game, and pick winners against the prediction model. No account, no ads, no tracking.
* **Category:** Sports · **Content rating:** answer "yes" to gambling-related content (the app shows odds but
  takes no bets) · **Privacy policy URL:** `https://YOUR-GITHUB-USERNAME.github.io/Baseline/privacy.html`
* **Screenshots:** `docs/screenshots/` (phone and desktop). **Icon:** `docs/icon-512.png`. **Feature graphic /
  social image:** `docs/og-image.png`. The source artwork for the logo is in `brand/`.

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

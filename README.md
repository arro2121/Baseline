# Baseline

Predictions and rankings for tennis (every ATP and WTA pro), the NFL, NBA, MLB, NHL and Premier League, with
live scores and live play-by-play. It installs on iPhone, Android, Windows and Mac, updates itself every night,
and runs on free hosting.

**What's in it**
* **Tennis:** win chances for any matchup on any surface from a 20-factor model, a betting-line checker,
  full rankings with player profiles, and live matches with point-by-point.
* **NFL, NBA, MLB, NHL, Premier League:** power rankings, a predictor for any two teams (win chances, fair
  prices, NFL spreads, soccer draw chances), and today's games with scores, betting lines, the market's odds,
  Baseline's prediction and live play-by-play that updates every 15 seconds.

---

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
**Add to Home Screen** > **Add**, and open Baseline from its new icon.

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
| MLB, NBA, NHL | Current records from ESPN, starting each season from last season's ratings | ESPN |

**About ESPN's data:** it's free and needs no key, but it's unofficial. ESPN doesn't publish or support it and
could change it without notice; if that happens, live team scores stop until the code is updated (tennis and all
predictions keep working). ESPN's terms allow personal, non-commercial use, so keep the app free and don't
advertise on it.

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

## Put it in the App Store or Google Play (optional)

Use the free [PWABuilder](https://www.pwabuilder.com) with your site's address. Google Play needs a $25
developer account; Apple's App Store needs a Mac with Xcode and a $99/year developer account, and Apple can reject
apps that mainly wrap a website. The privacy policy is at `.../baseline/privacy.html`.

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

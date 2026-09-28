# Seamline

A digital changing room. Bring in any piece of clothing from an online store and:

- **See it on you.** An AI try-on ([FASHN](https://fashn.ai)) dresses your own full-body photo in the product.
- **Know if it fits, and why not.** Seamline compares the store's size chart with your measurements
  (and, most accurately, with clothes you already own) zone by zone: chest, shoulders, waist, length, sleeves, inseam.
  It recommends a size, says how confident it is, and explains every other size's problem.
- **See the fit on your body.** The fit map colours your try-on photo green, amber or red where the chosen size
  is right, snug/loose or won't work, and the measured view draws each size at its real dimensions side by side.
- **Get style advice.** Claude looks at the try-on, your measurements and your style notes and tells you whether
  it suits you and what to wear it with.

The AI photo shows style, colour and drape; the try-on model draws every size the same, so the size answer comes
from the measurements, not the picture.

## How it works

| Piece | What it does |
| --- | --- |
| `public/` | The site: `index.html`, `style.css`, `app.js` (the changing room) and `fit.js` (the size engine). Your photo, measurements and rack are saved in your browser. |
| `src/worker.js` | A Cloudflare Worker serving the site plus `/api/*`: opens product links and reads them with Claude, downloads product photos, places body/garment points with Claude, style advice, and starts/polls FASHN try-ons. It stores nothing. |
| `../.github/workflows/seamline.yml` | Tests every change; deploys `main` to Cloudflare. |

## Where it runs

It lives at **https://seamline.baseline-arro2121-3091.workers.dev** and is deployed by
`.github/workflows/seamline.yml` in the Baseline repository whenever `seamline/` changes on `main`, using the
Cloudflare secrets Cosmo Sports already has. It never touches the Cosmo Sports site or workflow.

The AI features switch on from these repository secrets (Settings > Secrets and variables > Actions), then a re-run
of the **Seamline** workflow:

| Secret | What it's for |
| --- | --- |
| `SEAMLINE_ACCESS_CODE` | Any passphrase. Visitors enter it once; without it the AI features stay off so nobody can spend your credits. |
| `FASHN_API_KEY` | The AI try-on. Create an account at [fashn.ai](https://fashn.ai), add credit, and make a key under Developer API. A few cents per try-on. |
| `ANTHROPIC_API_KEY` | Link reading, point placement and style advice (shared with Cosmo Sports). |

Without keys the site still works: measurements, size recommendations, the measured view and the fit map.

## Develop

```sh
npm install
printf 'MOCK=1\nACCESS_CODE=test\n' > .dev.vars   # fake Claude and try-on, no keys or costs
npm run dev                                       # http://localhost:8787
npm test                                          # size engine + API checks, all outside services faked
```

With `MOCK=1` the "try-on" returns your own photo and Claude's answers are canned, so the whole flow can be
clicked through for free. Put real keys in `.dev.vars` (and remove `MOCK`) to try the real services locally.

## Privacy

Photos and measurements live in the visitor's browser (`localStorage`). They're sent to the worker only for a
try-on, point placement or style advice, forwarded to FASHN or Anthropic for that one request, and not stored by
the worker. The photo step asks visitors to confirm the photo is of them.

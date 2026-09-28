# Cosmo Sports

The site (cosmosports.app) is built from `template.html` by `build_site.py` into `docs/index.html`. The Cosmic service is
`alerts/worker.js` (a Cloudflare Worker). Pushing to `main` rebuilds and deploys both (`.github/workflows/baseline.yml`).

## The claude.ai copy must always match the real site

The owner keeps a private copy of the site on claude.ai: https://claude.ai/artifact/DvokeTsmCbmTAaMrewM3tK

- **Never edit that copy directly.** Every change, however small, goes into this repository first (`template.html`,
  `alerts/worker.js`, `docs/…`), is merged to `main` and deploys to the real site.
- **Then regenerate the copy from the deployed build and republish it to the same URL**, in the same task:
  1. wait for the `Baseline` workflow run for the merge to finish, then `git fetch origin main` and check out `origin/main`
     (it now holds the freshly built `docs/index.html`);
  2. `node tools/claude_copy.mjs <out-dir> <dir holding the esbuild package>` (install esbuild into a scratch folder with
     `npm i esbuild` if needed);
  3. publish `<out-dir>/index.html` with the Artifact tool, passing `url` above, with the `docs/*.json` data files alongside
     (the planet images and fonts are already stored on the artifact; republish them from `docs/planets` and `docs/fonts`
     if they changed).
- The only intended differences in the copy are what `tools/claude_copy.mjs` adds so it can run on claude.ai: Cosmic runs
  in the page as a local game (claude.ai pages can't reach the Cosmic service), sign-up is by name, and live scores and
  anything that needs another server are unavailable; claude.ai also never shows the browser's `confirm()` box, so the copy
  answers the site's "Are you sure?" questions with yes. It's the owner's test copy, so its Cosmic balance never runs out
  (the owner asked for this; the real site keeps normal coins). Don't add anything else to the copy that the real site lacks.
- If the copy is ever changed from somewhere else, bring that change into this repository and ship it to the real site,
  then regenerate the copy as above, so the two stay identical.

## Working here

- Develop on the branch you're given, open a PR, merge it; keep `CLAUDE.md` rules above in every round.
- Tests: `node alerts/test/test_cards.mjs`, `node alerts/test/test_security.mjs`, `node alerts/test/test_round2.mjs`.
- Cards and the site show no team logos, player photos, league marks or video clips (see `docs/terms.html`); the planet
  art is drawn by `tools/planets.py`.

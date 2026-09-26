Tests for the alerts service (need Node 20+ and `npm install http_ece@1.2.0`):

    node test_crypto.mjs   # notification encryption decrypts correctly; signature verifies
    node test_tick.mjs     # a simulated match sends the right alerts to the right devices
    node test_security.mjs # the 2026-09-25 security review (S1–S12, P6): PASS/FAIL per check, no packages needed

Before the fixes, the same scenarios reproduced the review's findings (worker as of 2026-09-25):

    S1  /cosmic/join with X-No-Passkeys: 1 made an account, and it appeared on the leaderboard
    S2  three brand-new no-passkey accounts reporting "Victim" renamed it to "Player B8CE" at once
    S3  /cosmic/signout didn't exist (404); the signed-out key still opened /cosmic/me
    S4  two copies of the worker let one address make 10 accounts in an hour (limit 5: each copy counted its own)
    S6  a support message's contact details stayed after its sender deleted the account
    S10 the page had no Content-Security-Policy

After: test_security.mjs passes every check. The CSP is added by build_site.py (add_csp); a browser check injects
an <img onerror> and a <script> into the page and confirms neither runs, while the app's own handlers still work.

Tests for the alerts service (need Node 20+ and `npm install http_ece@1.2.0`):

    node test_crypto.mjs   # notification encryption decrypts correctly; signature verifies
    node test_tick.mjs     # a simulated match sends the right alerts to the right devices

# Cosmo Sports for iPhone

The iPhone app is a native shell (Capacitor) around https://cosmosports.app. Changes to the site show up in the app right away, so you only upload a new build when the app itself changes (icon, native features, iOS settings).

What's native:
- **Passkeys** work in the app through Associated Domains (`webcredentials:cosmosports.app`)
- **Haptics** on scores, wins and pack pulls
- **The iOS share sheet**
- **A launch screen and an offline screen**
- Links to cosmosports.app open in the app

GitHub builds it on a Mac for you (`.github/workflows/ios.yml`). Every run checks that it compiles. Once the steps below are done, every run also signs it and uploads it to App Store Connect.

## Your part, one time

1. **Join the Apple Developer Program** at https://developer.apple.com/programs/enroll/ ($99 a year, as an Individual). Wait for the approval email.
2. **Find your Team ID**: https://developer.apple.com/account → Membership details → Team ID (10 letters and numbers). Put it in `app/apple_team_id.txt` on GitHub (edit the file, paste it, commit). It isn't a secret. It also publishes the file on cosmosports.app that lets passkeys work in the app.
3. **Create the app record** in https://appstoreconnect.apple.com → Apps → + → New App:
   - Platform: iOS
   - Name: Cosmo Sports
   - Language: English (U.S.)
   - Bundle ID: `app.cosmosports`. If it isn't in the list yet, register it first at https://developer.apple.com/account/resources/identifiers/add/bundleId with the Associated Domains capability ticked.
   - SKU: `cosmosports-ios`
   - User access: Full access
4. **Create an App Store Connect API key**: App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → +. Name it "GitHub", Access: **Admin** (needed so it can create the signing certificate). Download the `.p8` file (you can only download it once) and note the **Key ID** and the **Issuer ID** shown above the list.
5. **Add three GitHub secrets**: github.com/arro2121/Baseline → Settings → Secrets and variables → Actions → New repository secret:
   - `ASC_KEY_ID`: the Key ID
   - `ASC_ISSUER_ID`: the Issuer ID
   - `ASC_KEY_P8`: open the .p8 file in a text editor and paste the whole thing, including the BEGIN and END lines
6. **Run the build**: Actions → iPhone app → Run workflow. In about 15 minutes the build shows up in App Store Connect → TestFlight (Apple takes another 10–30 minutes to process it).
7. **Try it on your phone**: install **TestFlight** from the App Store. In App Store Connect → TestFlight → Internal Testing, add yourself, then open the invite on your iPhone.
8. **Fill in the listing**: copy everything from `app/store/listing.md` into the app's page in App Store Connect, and upload the five screenshots from `app/store/screenshots/`.
9. **Submit**: on the version page, pick the build, then **Add for Review** → **Submit**. Review usually takes 1–3 days.

cosmosports.app must be live on HTTPS (GitHub → Settings → Pages → Custom domain) before steps 6 to 9: the app loads it, and passkeys are tied to it.

## Later updates
Web changes need nothing: the app loads the live site. For a new app build, change something in `app/` (or run the workflow by hand). Each run gets a new build number automatically. To change the version shown in the store (1.0 → 1.1), edit `MARKETING_VERSION` in `app/ios/App/App.xcodeproj/project.pbxproj`.

## Reading reports and support messages
Open `https://<alerts service>/cosmic/owner/inbox` with the header `X-Owner-Key: <your COMETS_KEY>`. It lists player reports and messages from the Support page.

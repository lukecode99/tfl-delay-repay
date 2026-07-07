# App Review notes — TfL Delay Repay

Context for App Review on the two TfL-facing features: the claim WebView with
form prefill, and the journey-history refresh. Written against guidelines
5.2.2 (third-party sites/services) and 4.2 (minimum functionality).

## What the app is

A personal claims organiser for Transport for London's public
[service-delay refund](https://tfl.gov.uk/fares/refunds/apply-for-a-service-delay-refund)
scheme. It keeps the user's own journey history on-device, works out which
journeys look eligible for a refund, and makes filing TfL's own claim form
less tedious. There is no server component: journeys, assessments, and claim
records live in a local database on the device.

## 5.2.2 framing: user-agent convenience, not unaffiliated automation

The app never impersonates the user to TfL and never acts without them. Every
interaction with tfl.gov.uk is the user, in person, on TfL's real pages inside
a standard WebView — the app's role is the same as a browser with autofill:

- **Sign-in is the user's.** Both the claim screen and the journey refresh
  show TfL's own sign-in page and wait. The app never sees, stores, or
  transmits TfL credentials; the session cookie stays in the system WebView
  cookie store (`sharedCookiesEnabled`, non-incognito) and is never read or
  persisted by app code. This is stated to the user in-app: *"Sign in and
  submit on TfL's site — this app never stores your TfL login or submits for
  you."* (claim screen footer, with equivalent copy on the claim detail
  screen).
- **Submission is the user's.** The "Fill form" button populates the visible
  claim form with the user's own journey details (date, times, stations —
  data the user could equally paste from the copy chips beside it). The user
  reviews the form and taps TfL's own submit button themselves; the app has
  no code path that submits a claim. "Mark claimed" is manual bookkeeping in
  the local database, not an action on TfL.
- **Journey refresh reads only the user's own data, visibly and gently.** The
  refresh opens a visible sheet showing the actual TfL pages as they load.
  After the user signs in, it retrieves the same journey-history CSV export
  TfL offers every account holder (falling back to reading the on-page
  journey table), imports it locally, and stops. It is rate-limited to one
  fetch per day, runs only while the app is foregrounded and the sheet is
  open, and can be cancelled at any time. Robot-check and login pages are
  never scripted — the flow pauses and hands the page to the user.
- **No affiliation claimed.** The app does not present itself as a TfL
  product; it fills in TfL's public consumer forms on the user's behalf, at
  the user's request, with the user watching.

## 4.2 framing

The app is not a repackaged website. The native functionality is the point:
a local journey database with import/dedupe, an eligibility engine that
flags delay-refund candidates, claim tracking with reminders, and the
prefill/copy assist. The WebView appears only at the two moments that must
legitimately happen on tfl.gov.uk — signing in and submitting TfL's form.

## Reviewer walkthrough

**A TfL account is needed to exercise the signed-in flows.** Accounts are
free at account.tfl.gov.uk. Note that TfL journey history only populates
after travelling on the network with a registered card, so a fresh account
will show an empty history — the app handles this with a clear "no journeys"
outcome rather than an error.

Without a TfL account a reviewer can still see most of the app:

1. **Journeys screen** — the local journey list and eligibility assessments.
   Any TfL journey-history CSV (the standard export from the contactless or
   Oyster account pages) can be imported manually to populate it.
2. **Refresh from TfL** — opens the visible refresh sheet: the
   Contactless / Oyster / Both chooser, then TfL's real sign-in page. This
   demonstrates the key 5.2.2 point directly: the flow stops at TfL's login
   and waits for the user; nothing is injected on that page.
3. **Claim flow** — opening a claim shows the assist bar (copy chips +
   "Fill form") above TfL's public refund page, including the in-app footer
   copy quoted above. TfL's form itself sits behind their sign-in.

With a TfL account, the full loop: sign in on TfL's page inside the refresh
sheet → tap Continue → journey history imports locally → open an eligible
journey → "Fill form" populates TfL's claim form with that journey's details
→ the reviewer submits (or abandons) on TfL's page themselves → "Mark
claimed" records it locally.

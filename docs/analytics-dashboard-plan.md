# Analytics Dashboard — Plan & Page 1 Spec (Subscription & Trial Lifecycle)

Status: draft, filters/columns under active discussion. This doc reflects what's been
finalized so far, not a final build spec.

## Why this exists

We are not an MMP (AppsFlyer/Adjust) customer — we have no install attribution, no
media-source data, and no ad-spend feed. The dashboard mock everyone has seen
(install-cohort report with Media Source / Paid vs Organic / Total Cost) assumes that
data exists. It doesn't, for us. This doc defines a dashboard built only from data we
actually capture, with `Register` as the cohort base instead of `Install`.

## Global filters (apply across all dashboard pages, not just this one)

| Filter | Values | Behavior | Data source |
|---|---|---|---|
| Date range (From/To) | date picker | Bounds which cohort rows appear — only rows whose register date falls inside the range | `AuthService.CustomerIdentity.createdAt` |
| Period | Daily / Monthly | Row granularity. Daily = one row per calendar date. Monthly = one row per month (cohorts summed) | derived from the date range query grouping |
| Platform | All / Android / iOS | Restricts the cohort to registrations from that OS | `UserService.DeviceIdentity.os`, joined via `CustomerDeviceLink` on the link with the earliest `firstLinkedAt` for that customer (i.e. the device used at registration, not whatever device is linked "now") |
| Paying User Type | All / Free / Subscribed / Cancelled | Restricts cohort to users currently in that lifecycle state | `SubscriptionService.UserSubscription.status`, latest row per user |

Notes:
- **Platform is real, not a gap.** `deviceInfo.os` is already sent by the app on OTP
  verify ([AuthService/src/services/auth.ts:269](../AuthService/src/services/auth.ts#L269)),
  forwarded to UserService over gRPC
  ([AuthService/src/plugins/user-service.ts:425](../AuthService/src/plugins/user-service.ts#L425)),
  and persisted on `DeviceIdentity.os` in UserService's DB. The dashboard backend must read
  this through UserService's API, never query its DB directly — per the database-isolation
  rule in the root `CLAUDE.md`.
- **Paying User Type does not apply to the lifecycle table below** — that table's entire
  purpose is to show the full waterfall (Free → Trial → Subscribed → Cancelled) per cohort.
  Filtering it by paying-user-type would collapse most of its own columns to zero. This
  filter is for *other* pages (e.g. "show engagement metrics only for Subscribed users").
- We dropped `Media Source`, `Install Flag`, `Scaling vs Testing`, `Total Cost`, and
  `Base` entirely — no install attribution or ad spend data exists to power them.
- `Date Diff (cohort day)` (e.g. D0/D1/D4/D7 in the original mock) is **not** a global
  filter — see the page-specific note below, it's harder than it looks for us.

Each page below states explicitly which of the global filters apply to it, since not all
filters make sense on every page.

## Page 1 — Subscription & Trial Lifecycle

One row per cohort (per the Period filter), showing how that cohort moved through:
`Registered → Free → Trial → Subscribed → Cancelled/Expired → Reactivated`.

**Filters used on this page:** Date Range, Period, Platform. **Not used:** Paying User
Type (conflicts with this page's own breakdown — see note above).

### Column definitions

**Cohort identity**
- **Register Period** — the row's cohort date (or month). Source: `AuthService.CustomerIdentity.createdAt`.

**Registration & Free**
- **Registrations** — count of `CustomerIdentity` rows with `createdAt` in this period.
- **Free Users** — registrations in this period with **zero** `UserSubscription` rows ever
  (never took a trial, never subscribed). If a user took a trial and churned, they are
  *not* counted as Free — they show up under Trial Churned instead.
- **Free %** — `Free Users / Registrations`.

**Trial**
- **Trial Started** — users with at least one `UserSubscription` row where `trialPlanId IS NOT NULL`.
- **Reg→Trial %** — `Trial Started / Registrations`.
- **Trial Active** — latest trial row has `status = TRIAL` and `endsAt > now()`.
- **Trial Cancelled** — latest trial row has `status = CANCELED`.
- **Trial Cancel %** — `Trial Cancelled / Trial Started`.
- **Trial Expired** — latest trial row has `status = EXPIRED` (ran out, no explicit cancel, no conversion).
- **Trial→Sub Conv %** — of `Trial Started`, the % who have a **separate** later
  `UserSubscription` row with `planId NOT NULL AND trialPlanId IS NULL AND status = ACTIVE`,
  created after the trial row (i.e. they actually converted to paid).

**Subscription (paid)**
- **Sub Active** — users with a `UserSubscription` row, `planId NOT NULL`, `status = ACTIVE`
  (regardless of whether they arrived via trial or signed up direct).
- **Sub Cancelled** — same, `status = CANCELED`.
- **Sub Churn %** — `(Sub Cancelled + Sub Expired) / everyone who ever reached Sub Active` for that cohort.

**Reactivation** (no schema field for this — fully derived from row sequence)
- **Reactivated** — count of cohort users with ≥2 `UserSubscription` rows where an earlier
  row has `status IN (CANCELED, EXPIRED)` and a *later* row (by `createdAt`) has
  `status = ACTIVE`. There's no "reactivated" flag anywhere — this is purely "did a churned
  user's next row come back active."
- **Recovery %** — `Reactivated / (Sub Cancelled + Sub Expired)` for that cohort.
- **Open decision:** should Reactivated require the comeback within a window (e.g. 30/60
  days of cancelling) to count as a real win-back, or count any reactivation no matter how
  much later? Without a window, a resubscribe 6 months later counts the same as a 3-day
  win-back, which dilutes the signal most teams actually care about. **Recommendation:
  cap it at 30 days** — pick a different number if you have a specific retention-campaign
  window in mind.

**Gateway split** (replaces "Media Source" from the original mock — this is payment
gateway, not acquisition channel)
- **Razorpay %** — % of that cohort's `Sub Active` rows where `provider = 'razorpay'`.
- **PhonePe %** — % of that cohort's `Sub Active` rows where `provider = 'phonepe'`.

### Known gaps / open decisions

1. **No `GRACE` status exists.** The `SubscriptionStatus` enum
   ([SubscriptionService/prisma/schema.prisma:11-18](../SubscriptionService/prisma/schema.prisma#L11-L18))
   only has `PENDING, ACTIVE, EXPIRED, CANCELED, TRIAL, PAUSED` — no grace/dunning state.
   We could approximate "in grace" from `PhonePeRedemption.status` retry windows, but it's
   an approximation, not a real status. Decision needed: build it, or drop Grace from this
   page entirely.
2. **`Date Diff (cohort day)` cannot be done accurately today.** `UserSubscription.status`
   is a mutable current-state field — there's no history table recording what status a
   user was in N days after registration. To support "show status as of D5" honestly we'd
   need a status-change audit log (`status`, `changedAt` per transition). Recommendation:
   **don't build the audit log yet** — ship v1 approximating Date Diff from existing
   timestamps (`createdAt`, `startsAt`, `endsAt`), validate the dashboard gets used, and
   only invest in a real audit trail if someone needs precision timestamps can't give us
   (e.g. "was this PAUSED specifically on day 3").
3. **PostHog is wired and already tracking subscription events** — this lifecycle table
   should still be powered by direct DB queries against `UserSubscription`/`Transaction`
   (source of truth for state), not PostHog. PostHog is for the *event-sequence* funnels
   in Page 2 below, not for current-state lifecycle counts.

## Page 2 — Event Funnels (sourced entirely from PostHog)

Unlike Page 1 (current-state counts from our own DB), Page 2 is a set of **separate**
ordered-event funnels, each computed by PostHog's native Funnels feature and pulled into
our admin via PostHog's Query API. Each funnel below is its own query/table — they are
**not** combined into one giant table, because Step Conv %/Overall %/Drop-off only mean
something for a single ordered sequence most users actually pass through. Mixing
unrelated journeys (e.g. video playback after search) would produce meaningless
"drop-off" numbers between steps that were never actually sequential for most users.

**Filters used on this page:** Date Range (bounds which users enter the funnel), Platform,
Paying User Type (e.g. "show this funnel for Free users only"). Period (Daily/Monthly)
doesn't apply — funnels aggregate over the whole date range as one block, not per-day rows.

### How data gets here

- Our backend calls PostHog's server-to-server **Query API**
  (`POST /api/projects/:id/query/`, `FunnelsQuery`) using a Personal API Key stored as a
  secret (same pattern as `SERVICE_AUTH_TOKEN` in other services) — never exposed client-side.
- PostHog returns each step's raw `count`. **Step Conv %, Overall %, and Drop-off are
  computed on our side** with simple arithmetic across adjacent steps — PostHog gives the
  counts, not the percentages:
  - `Step Conv % = this step's count / previous step's count`
  - `Overall % = this step's count / step 1's count`
  - `Drop-off = previous step's count − this step's count`
- It doesn't matter whether an event was fired by the mobile app's PostHog SDK or by our
  backend's `posthog-node` client ([AuthService/src/utils/posthog.ts](../AuthService/src/utils/posthog.ts),
  [SubscriptionService/src/lib/posthog.ts](../SubscriptionService/src/lib/posthog.ts)) —
  PostHog merges all events under the same `distinctId` into one person timeline
  regardless of source.
- **The one cross-cutting risk for every funnel below:** backend events use `userId` as
  `distinctId` (e.g. [SubscriptionService/src/lib/analytics.ts:43](../SubscriptionService/src/lib/analytics.ts#L43)).
  For client-side steps (app opens, screen views) to link up with backend steps
  (trial/subscription activations) in the *same* funnel, the app's client SDK must call
  `identify(userId)` using that exact same ID at login/registration. **Needs confirming
  with the app team before any of these funnels are trusted** — if the IDs don't match,
  PostHog silently shows two disconnected people instead of one continuous journey.
- Funnel results should be **cached** (a few minutes, Redis) rather than queried live on
  every admin page load, with a visible "last refreshed at" timestamp — PostHog funnel
  queries aren't free or instant to re-run constantly.
- **Open decision:** which service owns this PostHog-querying logic and the API key — a
  new small `AnalyticsService`, or bolted onto an existing one? Leaning toward a new
  service so the key and all dashboard read endpoints live in one place, rather than
  duplicating PostHog-query code into every service that already has its own `posthog.ts`.

### Funnel 1 — Activation (conversion window 7d)

| # | Step | Event | Source |
|---|---|---|---|
| 1 | App First Open | `app_first_open` (E001) | PostHog, client |
| 2 | Splash seen | `splash_shown` (E005) | PostHog, client |
| 3 | OTP requested | `otp_requested` | **Needs new capture call** in [AuthService/src/services/otp.ts:59](../AuthService/src/services/otp.ts#L59) — not sent to PostHog yet, only logged to our own `OtpLog` table |
| 4 | OTP screen seen | `auth_otp_screen_shown` (E008) | PostHog, client |
| 5 | OTP verified | `auth_otp_verified` (E009) | PostHog, client |
| 6 | Registered | `first_time_register` | PostHog, backend — already shipping ([AuthService/src/services/auth.ts:296](../AuthService/src/services/auth.ts#L296)) |
| 7 | Paywall shown | `paywall_shown` (E037) | PostHog, client |

"Enter mobile number" step removed — no event exists for it; confirm with the app team
whether that screen is distinct from the OTP screen or just never instrumented.

### Funnel 2 — Paywall → Conversion (conversion window 7d)

| # | Step | Event | Source |
|---|---|---|---|
| 1 | Paywall shown | `paywall_shown` (E037) | PostHog, client |
| 2 | Paywall CTA clicked | `paywall_cta_clicked` (E039) | PostHog, client |
| 3 | Razorpay checkout opened | `razorpay_checkout_opened` (E040) | PostHog, client |
| 4 | Trial started | `trial_started` (E041) | PostHog, client |
| 5 | Trial activated | `trial_activated` (E042) | PostHog, backend — already shipping ([SubscriptionService/src/routes/webhooks.ts:184](../SubscriptionService/src/routes/webhooks.ts#L184)) |
| 6 | First subscription purchased | `first_subscription_purchased` (E044) | PostHog, backend — already shipping ([SubscriptionService/src/routes/webhooks.ts:190](../SubscriptionService/src/routes/webhooks.ts#L190)) |

This funnel is the closest to fully buildable today — every step is already firing.

### Funnel 3 — Video Engagement (conversion window 1d)

| # | Step | Event | Source |
|---|---|---|---|
| 1 | Video started | `video_started` (E018) | PostHog, client |
| 2 | Reached 25% | `video_progress` (E019, 25) | PostHog, client |
| 3 | Reached 50% | `video_progress` (E019, 50) | PostHog, client |
| 4 | Reached 75% | `video_progress` (E019, 75) | PostHog, client |
| 5 | Reached 95% | `video_progress` (E019, 95) | PostHog, client |
| 6 | Completed | `video_completed` (E020) | PostHog, client |

### Funnel 4 — Episode Hard-Paywall (conversion window 1d)

| # | Step | Event | Source |
|---|---|---|---|
| 1 | Video started | `video_started` (E018) | PostHog, client |
| 2 | Hit paywall position | `episode_paywall_position_reached` (E026) | PostHog, client |
| 3 | Paywall shown | `paywall_shown` (E037) | PostHog, client |
| 4 | Paywall CTA clicked | `paywall_cta_clicked` (E039) | PostHog, client |

### Funnel 5 — Audio Engagement (conversion window 1d)

| # | Step | Event | Source |
|---|---|---|---|
| 1 | Audio grid viewed | `audio_series_grid_viewed` (E028) | PostHog, client |
| 2 | Playback started | `audio_story_playback_started` (E029) | PostHog, client |
| 3 | Background playback started | `audio_background_playback_started` (E033) | PostHog, client |

### Funnel 6 — Search (conversion window 1h)

| # | Step | Event | Source |
|---|---|---|---|
| 1 | Search submitted | `search_query_submitted` (E014) | PostHog, client |
| 2 | Result clicked | `search_result_clicked` (E015) | PostHog, client |

### Priority recommendation

Build **Funnel 1 (Activation)** and **Funnel 2 (Paywall → Conversion)** first — they map
directly to revenue and Funnel 2 needs zero new instrumentation. Treat Video/Audio/Search
funnels as a later phase once the PostHog query plumbing and caching layer exist and have
proven out on the first two.

## Page 3 — Episode-Level Retention & Skip (sourced entirely from our own DB, no PostHog)

One row per episode (expandable: top-level row = Series, click to expand into its
episodes — a UI expand/collapse, not a filter). Unlike Page 2, this page needs nothing
from PostHog — `EngagementService.ViewProgress` already has everything except exit reason,
which is dropped from scope for now.

**Filters used on this page:** Date Range (optional, default all-time, since the header is
"Till Date"), Paying User Type (free users hit a hard paywall at a fixed position, so
their completion numbers are structurally capped — splitting Free vs Subscribed avoids
that distortion). **Not used:** Platform (OS isn't a meaningful signal for content
retention) and Period (this page is per-episode rows, not per-date rows).

### Column definitions

| Column | Source | Notes |
|---|---|---|
| Show | `ContentService.Series.title` | joined via `Episode.seriesId` |
| Episode | `ContentService.Episode.title`/`episodeNumber` | |
| Ep Starts | `COUNT(ViewProgress)` grouped by `episodeId` | **Unique users who ever started this episode** — `ViewProgress` is upserted one row per `(userId, episodeId)` ([schema.prisma:55-67](../EngagementService/prisma/schema.prisma#L55-L67), upsert at [collection-engagement.ts:1402](../EngagementService/src/services/collection-engagement.ts#L1402)), so this is inherently a unique-viewer count, not a session/play count |
| Completions | `COUNT(ViewProgress WHERE completedAt IS NOT NULL)` grouped by `episodeId` | Real, confirmed threshold: `completedAt` is set when `progressSeconds >= durationSeconds * 0.95` ([collection-engagement.ts:1158](../EngagementService/src/services/collection-engagement.ts#L1158)), and preserved correctly across rewatches |
| Completion % | `Completions / Ep Starts` | |
| Avg Watch (min) | `AVG(progressSeconds) / 60` grouped by `episodeId` | Caveat: `progressSeconds` is the user's **latest known position**, not a true sum of watch time across rewatches/seeks — same risk the original mock's footnote warned about, just at coarser (per-user, not per-session) granularity |
| Skip/Exit % | `(Ep Starts − Completions) / Ep Starts` | |
| ~~Top Exit Reason~~ | — | **Removed from scope.** Nothing currently captures exit reason anywhere (not in `AppEvent`, not in PostHog's confirmed event list). Would need new app-side instrumentation; not worth blocking this page on it. |

### Explicitly ruled out

- **Session-level "view count" via `/episodes/:episodeId/view`** (`ContentStats.viewCount`,
  a raw Redis `INCR` at [collection-engagement.ts:462-480](../EngagementService/src/services/collection-engagement.ts#L462-L480)) —
  confirmed the app does not reliably call this, so it doesn't represent real play sessions. Not used.
- **Rewatch/replay count** — `ViewProgress` only stores the latest state per `(userId, episodeId)`,
  no play history, so a true replay count isn't recoverable from current schema. Dropped from
  scope rather than adding a new counter field for it right now.

## Page 4 — Platform Engagement, by OS / App Version

One row per `(Platform, App Version)` combination, plus an `Overall / All` summary row.
Sourced entirely from our own DB — `EngagementService.AppEvent` joined against
`UserService.DeviceIdentity` via `deviceId`.

**Filters used on this page:** Date Range/Period (drives the reporting window — "Last 30
days" in the example), Platform (optional — narrows which OS rows are shown, doesn't
conflict with Platform also being a row dimension here), Paying User Type (optional
segment — e.g. engagement for Subscribed users only). All four global filters are
compatible on this page, unlike Page 1.

### Column definitions

| Column | Source | Notes |
|---|---|---|
| Platform ($os) | `UserService.DeviceIdentity.os` | joined from `AppEvent.deviceId` (required field on every row, [schema.prisma:94-106](../EngagementService/prisma/schema.prisma#L94-L106)) |
| App Version | `UserService.DeviceIdentity.appVersion` | This is the device's **current/last-synced** version ([schema.prisma:85](../UserService/prisma/schema.prisma#L85), updated via `syncDeviceDeviceInfo`), not "version at registration" — so a device can move between App Version rows over time as the user updates the app |
| DAU | `COUNT(DISTINCT COALESCE(userId, guestId, deviceId))` from `AppEvent` in the trailing 1-day window, grouped by `(os, appVersion)` | Same pattern already used for overall DAU in [admin-analytics.ts:333-337](../EngagementService/src/services/admin-analytics.ts#L333-L337), just grouped by platform/version instead of ungrouped |
| WAU | same query, trailing 7-day window | |
| MAU | same query, trailing 30-day window | |
| Stickiness (DAU/MAU) | `DAU / MAU` | |
| Sessions/User | `COUNT(AppEvent WHERE eventType = 'app_open') / MAU` for that group | Uses our own `app_open` eventType, already expected elsewhere in `EngagementService` ([store-analytics.ts:38-40](../EngagementService/src/services/store-analytics.ts#L38-L40)), **not** PostHog's `app_launched` (E002) — no PostHog dependency for this column. Needs confirming the app fires `app_open` every time it's opened/resumed, not just on cold start |
| Avg Session (min) | — | **Not available**, same as your mock (marked `—`). We don't track session start/end timestamps anywhere — only point-in-time events. Would need a session-boundary concept (e.g. app_launched → app_backgrounded pair) that doesn't exist in the catalog today |

### Open item

Confirm with the app team that `app_open` fires once per genuine app open/resume
(including from push notifications) and not on every screen transition — otherwise
Sessions/User will be inflated.

## Page 5 — Biz–Fin Summary

One row per **calendar month** (not registration cohort), plus an `Overall` summary row.
Sourced entirely from `SubscriptionService`.

**Filters used on this page:** Date Range/Period (drives which calendar months are
shown). **Not used:** Platform, Paying User Type — this page is a financial roll-up, not
a per-segment breakdown.

**Note on currency:** real values will be in `₹` (INR paise, per `SubscriptionPlan.currency`
default), not `$` as shown in the original mock.

### Row definition resolved before building

**Rows = calendar period, not registration cohort.** "MRR/Net Revenue in Jan 2026" means
money actually collected/active in that calendar month, from any user regardless of when
they registered — standard finance reporting convention, not a cohort attribution table
like Page 1. This reuses the existing date-bucketed pattern in `/internal/revenue/stats`
([SubscriptionService/src/routes/internal/index.ts:52-106](../SubscriptionService/src/routes/internal/index.ts#L52-L106)),
rather than needing a new cohort-join query.

### Column definitions

| Column | Source | Notes |
|---|---|---|
| Register Period | calendar month/day per Period filter | renamed from "Install Period" — no install data, see top of doc |
| Subscriptions | `COUNT(UserSubscription WHERE planId NOT NULL AND status = ACTIVE)`, snapshot as of period end | MRR/ARPU/ARPPU are inherently snapshot metrics, so this counts active subs *as of* the end of that month, not "new subs that month" |
| MRR | `SUM(plan.pricePaise / 100 * (30 / plan.durationDays))` across that period's active subs | normalizes plans with non-30-day `durationDays` ([SubscriptionPlan.durationDays](../SubscriptionService/prisma/schema.prisma#L41)) to a monthly-equivalent figure |
| ARPU | `MRR / Total registered users as of period end` | uses the full registered base (including free users), not just that month's signups |
| ARPPU | `MRR / Subscriptions` | revenue per *paying* user only |
| Net Revenue | `SUM(amountPaise WHERE status = SUCCESS) − SUM(amountPaise WHERE status = REFUNDED)` for that period | extends the existing `/internal/revenue/stats` logic, which currently only sums `SUCCESS` and doesn't subtract refunds — small addition needed |

Recovery % removed from this page — Page 1's `Reactivated`/`Recovery %` (people-based,
capped at 100%) already covers the win-back signal; a separate revenue-based recovery
metric wasn't worth the added complexity right now.

### Cross-service data access

This page needs data from three services' own databases (`pocketlol_auth`,
`pocketlol_users`, `pocketlol_subscription`). Per the database-isolation rule, the
dashboard backend cannot query these directly — it must go through each service's
existing API/gRPC surface, or each service needs a new `/internal/analytics/*` read
endpoint purpose-built for this dashboard. **Decision needed: which service owns the
dashboard backend, and do we add internal analytics endpoints to each service, or
build a small read-replica/warehouse this dashboard queries instead?**

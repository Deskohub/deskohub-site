# One Coworking partner API proposal

**Prepared by:** Deskohub (Prague)
**Prepared for:** Christoph Fahle, One Coworking
**Status:** Draft 0.2 for discussion
**Date:** 2026-11-23

---

## How to use this document

This document has two parts:

- **Abstract (for humans)** outlines the purpose, capabilities, and end-to-end reservation flow in plain terms.
- **Technical specification (for AIs and engineers)** is structured so an engineer or coding agent with access to One Coworking's codebase can evaluate fit and produce an implementation plan directly. Section 0 defines the codebase investigations to run first and maps each likely finding onto the same external API contract and OpenAPI 3.1.0 schema.

---

## Abstract (for humans)

The purpose of this document is to propose a specification for a publicly documented Partner API enabling coworking providers and workspace management systems to register their systems with One Coworking for programmatic reservation handling, check-in access delivery, and calendar-based seat and room inventory management.

Deskohub prepared this draft following our conversation as an operator-agnostic contract usable by any coworking provider, including unstaffed venues with automated door access. It covers day passes, reserved desks, hourly and full-day meeting rooms, and multi-day private offices. Monthly passes are out of scope and remain on One Coworking's existing workflow; simulated test bookings stay isolated to a sandbox environment.

### Capabilities

1. **Booking and cancellation updates from One Coworking.** Whenever a guest completes a booking on One Coworking, cancels an existing booking, or a payment fails or expires, One Coworking notifies the operator automatically. A companion lookup allows the operator to stay synchronized even if an individual notification is missed.
2. **Booking confirmation, cancellation, and guest check-in handoff from the operator.** Spaces requiring live verification before finalizing a seat or room can confirm or decline incoming reservations programmatically. Upon confirmation, the operator can attach check-in details, such as a link to a dedicated door-access page, a keypad code, or reception instructions, which One Coworking delivers to the guest once payment has settled. Operators can also update access details after confirmation or cancel a confirmed booking if an operational disruption occurs, triggering guest notification and refund.
3. **Calendar-based availability, pricing, and listing management.** Operators publish remaining capacity by date for desks and private offices, mark closed dates, report unavailable time windows for hourly meeting rooms, publish per-date price overrides, and update listing defaults or pause listings.

### End-to-end integration flow

```mermaid
sequenceDiagram
    participant Space as Coworking operator
    participant OC as One Coworking
    participant Guest as Guest

    Note over Space,OC: 1. Ongoing availability synchronization
    Space->>OC: Push calendar capacity and blocked room windows
    OC-->>Space: Return effective availability

    Note over Guest,Space: 2. Booking, confirmation, and check-in handoff
    Guest->>OC: Selects date or room and completes checkout
    OC->>Space: Booking notification (places temporary hold)
    Space->>Space: Verifies live availability and holds unit
    Space->>OC: Confirm with access link or entry instructions (or decline)
    OC-->>Space: Confirmed and paid (authorizes door access)
    OC-->>Guest: Confirmation email and pass with access link

    Note over Guest,Space: 3. Cancellation (guest or operator initiated)
    Guest->>OC: Cancels booking (or operator cancels)
    OC->>Space: Cancellation notice (withdraws access and releases unit)
    Space->>OC: Push updated calendar availability
```

---

## Technical specification (for AIs and engineers)

This specification defines the codebase investigations, HTTP contract, domain model, inventory rules, state machine, webhook protocol, contract examples, and OpenAPI 3.1.0 schema for the One Coworking Partner API (`v1`), covering twelve HTTP operations and six webhook events. The OpenAPI document also declares `HEAD` on each of the five `GET` paths and `OPTIONS` on the two URIs that accept `PATCH`.

### 0. Pre-implementation codebase investigations

Before implementing endpoints or database migrations, inspect One Coworking's existing codebase across the six areas below. Every outcome maps onto the same external Partner API contract in Sections 1 through 7 so operators integrate once regardless of One Coworking's internal architecture.

#### Investigation 1: Payment capture timing

Inspect checkout and payment processor integration code to determine whether card bookings use manual capture (authorize at checkout, capture later) or immediate capture at checkout, whether guests can pay from prepaid account or team credit balances, and how voids, refunds, credit releases, and asynchronous payment reconciliation are implemented.

- **Outcome A: Manual capture (authorize then capture) is supported or straightforward to enable for `webhook_confirm` listings.**
  - Checkout authorizes the card payment with the payment processor, or places a hold on the guest's prepaid credit balance, and creates the reservation in `pending_confirmation` with `paymentStatus: "authorized"` and a `confirmBy` deadline (default 60 seconds).
  - `POST /v1/reservations/{reservationId}/confirm` triggers capture with the payment processor, or converts the credit hold into a debit. Synchronous success transitions to `confirmed` (`paymentStatus: "captured"`), definite refusal transitions to `payment_failed` (`paymentStatus: "failed"`), and timeout or ambiguous provider response transitions to `capture_pending` (`paymentStatus: "capture_pending"`), resolved by a background reconciliation worker within 30 minutes and a 7-day late-capture refund monitor. Converting a credit hold is an internal ledger operation, so it yields only `confirmed` or `payment_failed`.
  - `POST /decline` and `confirmBy` expiry void the card authorization or release the credit hold (`paymentStatus: "voided"`).
- **Outcome B: Checkout always captures payment immediately.**
  - Checkout captures card funds or debits the prepaid credit balance and creates the reservation in `pending_confirmation` with `paymentStatus: "captured"` (for `webhook_confirm` listings) or `confirmed` with `paymentStatus: "captured"` (for `instant` listings).
  - On `webhook_confirm`, `POST /confirm` validates state and `confirmBy`, stores `externalReservationId` and `access`, and transitions directly to `confirmed` without issuing a second capture (`capture_pending` and `payment_failed` transitions are never triggered, though the enum values remain valid in the schema).
  - `POST /decline` and `confirmBy` expiry initiate a full refund through the payment processor, or restore the debited credit to the guest's account or team balance (`paymentStatus: "refund_pending"`, updating to `"refunded"` when the payment processor confirms settlement or the credit is restored).
- **Prepaid credit balances under either outcome.** A credit hold maps to `paymentStatus: "authorized"`, an immediate credit debit maps to `"captured"`, a released hold maps to `"voided"`, and restored credit maps to `"refund_pending"` then `"refunded"`. Operators see the same states for card and credit payments, so the external contract does not change.

#### Investigation 2: Pricing, VAT, and commission accounting

Inspect how venue listing prices, VAT, platform commission, and operator payouts are stored and calculated.

- **Outcome A: Listing prices are stored as guest-facing gross amounts including VAT.**
  - Expose `BookingOption.price` and `pricePerSeat` with `taxIncluded: true`.
  - At checkout, populate `ReservationPricing` with `grossAmount`, `commissionAmount`, and `netPayoutAmount` (all `taxIncluded: true`, satisfying `grossAmount = commissionAmount + netPayoutAmount`).
  - Calendar `priceOverrides` accept guest-facing gross amounts with `taxIncluded: true`.
- **Outcome B: Listing prices are stored net of VAT or net of One Coworking commission.**
  - Expose `BookingOption.price` with `taxIncluded: false` when net of VAT, or document the operator-facing price basis per venue.
  - Compute `grossAmount`, `commissionAmount`, and `netPayoutAmount` using One Coworking's existing tax and commission calculator so `netPayoutAmount` always reflects the exact amount owed to the operator in the reservation currency.
  - Reject `priceOverrides` whose `taxIncluded` value differs from the booking option's `price.taxIncluded` with `422 validation_error` and `errors[].reason` `tax_mode_mismatch`.

#### Investigation 3: Guest confirmation emails, booking passes, and check-in display

Inspect the guest confirmation email pipeline, booking pass views (web, mobile app, PDF), and when confirmation notices are sent relative to checkout and host confirmation.

- **Outcome A: Confirmation delivery can wait for `confirmed` status and render structured check-in details.**
  - For `webhook_confirm` listings, hold the final guest confirmation email until the reservation reaches `confirmed` (after `/confirm` and settled payment). Render `access.accessUrl` as a primary check-in link for `type: "url"`, display `validFrom` to `validUntil` as the entry entitlement window, and show `access.instructions`. Never copy raw PINs into emails for `type: "url"`.
  - For `instant` listings where an initial receipt sends at checkout before the operator attaches `access`, send a follow-up check-in update notification when the operator submits `access` via `POST /confirm`.
- **Outcome B: Existing confirmation emails are fixed templates sent immediately at checkout.**
  - Keep the checkout receipt unchanged for `instant` listings, add a dedicated check-in section to the live booking pass view displaying `accessUrl` (or `pinCode` / `qrPayload` / `instructions` per `access.type`), and send a lightweight check-in ready email linking to the pass once `access` is attached on a `confirmed` reservation.
  - Ensure `type: "url"` renders only the link and entitlement window, never attempting to scrape or embed a PIN.

#### Investigation 4: Product catalog, booking options, and add-ons

Inspect how One Coworking models spaces and bookable products (for example, flat listings per tier/duration versus one listing with multiple durations, overnight stays, seat counts, and optional add-ons).

- **Outcome A: One Coworking supports multi-option listings (multiple durations, date ranges, seat counts) and checkout add-ons.**
  - Map each venue product directly onto `Listing.bookingOptions` (`calendar_day`, `overnight`, `fixed_duration`, `date_range`), `inventoryModel` (`pooled` vs `exclusive`), `inventoryGranularity` (`date` vs `interval`), and `Reservation.addons`.
- **Outcome B: One Coworking models each tier or fixed duration as a separate flat listing and has no add-ons at checkout.**
  - Expose each bookable tier or duration as a `Listing` containing a single entry in `bookingOptions` and always return `addons: []` on reservations.
  - Operators bind each listing via `externalId` without changing the API schema. If two flat listings share the same physical room or desk pool, One Coworking links them to one shared inventory pool, so a checkout on either listing places its hold atomically against that pool's effective availability. A checkout fails only when the pool's effective availability, computed as in Section 2, cannot accommodate it. On each inventory date the booking touches, a pool snapshot with status `closed` or `sold_out` rejects it, and a date without a snapshot uses the pool's `defaultCapacity` with `reservationsThrough: 0`. A `date` pool must then have enough remaining units on each of those dates after subtracting active holds, and in an `interval` pool the occupied interval must not overlap a blocked interval or active hold. Two simultaneous one-seat checkouts against two free desks both succeed, as do two room bookings whose occupied intervals do not overlap. Until that link exists, every listing that shares physical inventory uses `webhook_confirm`, so the operator confirms each booking against its own single inventory and declines a collision with `sold_out`. In both cases the operator pushes calendar updates to each affected `listingId`.
  - If One Coworking does not yet support overnight stays or early setup in its UI, omit `overnight` options and keep `setupMinutesAllowed: [0]`; the rest of the schema works unchanged.

#### Investigation 5: Cancellation policy and refund workflows

Inspect how guest-initiated cancellations, cancellation cutoffs, support cancellations, and host/operator cancellations are implemented today, including how refunds reach the original card through the payment provider and how debited prepaid account or team credit is restored.

- **Outcome A: One Coworking has self-service guest cancellation with automated cutoff enforcement and refund execution.**
  - Guest cancellation transitions the reservation to `cancelled_by_guest`, increments `version`, releases any active inventory hold, and emits `reservation.cancelled`. Its `paymentStatus` follows the money actually collected. A card authorization that was never captured is voided, and a prepaid credit hold that was never debited is released, both reported as `voided`. Collected funds follow the listing's cancellation policy: `refund_pending` then `refunded` before the cutoff, or `captured` when the policy keeps the money.
  - Operator-initiated `POST /v1/reservations/{reservationId}/cancel` transitions `confirmed` to `cancelled_by_operator`, initiates a full guest refund to the original card through the payment provider, or restores the debited account or team credit (`refund_pending` -> `refunded`), notifies the guest, and emits `reservation.cancelled`.
- **Outcome B: Cancellations are currently processed manually by One Coworking support.**
  - Hook the internal admin cancellation action to the same state transition service, setting `status` to `cancelled_by_guest` (when requested by the guest) or `cancelled_by_platform` (when initiated by support or fraud review), incrementing `version`, and emitting `reservation.cancelled`.
  - Implement `POST /cancel` so it immediately transitions the reservation to `cancelled_by_operator`, releases the hold, notifies the guest, and either triggers an automated refund through the payment provider or an automated credit restoration, or queues an internal refund task for support while keeping `paymentStatus: "refund_pending"` until settled.

#### Investigation 6: Availability storage and existing PMS integrations

Inspect how One Coworking currently stores venue availability (per-date tables, interval/calendar tables, existing PMS or channel adapters, or static default capacity) and whether checkout already decrements capacity transactionally.

- **Outcome A: One Coworking already stores per-date or per-slot availability with transactional booking holds.**
  - Add `storedSequence` and `storedReservationsThrough` columns to the existing availability table, add a gapless per-venue `reservationSequence` counter on reservation creation, and back `PATCH /v1/listings/{listingId}/calendar` directly with the existing store using the effective-availability formula in Section 2.
  - Keep existing PMS or channel adapters running alongside the Partner API by treating Partner API venues as one availability provider.
- **Outcome B: Venues currently rely on static default capacity with no per-date availability store.**
  - Introduce a `listing_calendar_snapshots` table keyed by `(listingId, date)` plus a per-venue `reservationSequence` counter table, and compute effective availability at checkout by subtracting active holds with `reservationSequence > storedReservationsThrough`.
  - Listings without any pushed snapshot default to `defaultCapacity` with `reservationsThrough: 0`, leaving all non-API venues unaffected.

---

### 1. Architecture and conventions

#### Base URLs
- Production: `https://api.onecoworking.com/partner/v1`
- Sandbox: `https://sandbox-api.onecoworking.com/partner/v1`

Paths in this specification are written relative to `/partner`, so `/v1/listings` means `https://api.onecoworking.com/partner/v1/listings`. Header values that carry a path, such as `Content-Location`, use the absolute path under the base URL, such as `/partner/v1/reservations/{reservationId}`.

#### Authentication

Operator calls to One Coworking use OAuth 2.0 Bearer tokens as RFC 6750 defines them.

- The operator sends `Authorization: Bearer <token>` (RFC 6750 Section 2.1). Each token belongs to one operator account and may be limited to a set of `venueId` values.
- Each operation requires one scope:

| Scope | Operations |
| --- | --- |
| `listings:read` | `GET /v1/listings`, `GET /v1/listings/{listingId}`, `GET /v1/listings/{listingId}/calendar`, `OPTIONS /v1/listings/{listingId}`, `OPTIONS /v1/listings/{listingId}/calendar` |
| `listings:write` | `PATCH /v1/listings/{listingId}` |
| `calendar:write` | `PATCH /v1/listings/{listingId}/calendar` |
| `reservations:read` | `GET /v1/reservations`, `GET /v1/reservations/{reservationId}` |
| `reservations:write` | `POST /v1/reservations/{reservationId}/confirm`, `POST /v1/reservations/{reservationId}/decline`, `POST /v1/reservations/{reservationId}/cancel`, and `PUT /v1/reservations/{reservationId}/access` |
| `webhooks:test` | `POST /v1/webhooks/test` |

- A `HEAD` request requires the scope of the `GET` on the same path, so `HEAD /v1/reservations` requires `reservations:read`.
- Both `OPTIONS` operations require `listings:read`. They are safe reads that describe what the listing URI and the calendar URI accept, so they need the read scope of the listing, not a write scope. An operator whose token holds only `listings:write` or `calendar:write` adds `listings:read` to discover the patch formats.
- The OpenAPI document names the scope of every operation in that operation's `security` requirement, and the `scope` of an `insufficient_scope` challenge is that value.

- Authentication failures carry the challenges of RFC 6750 Section 3 in `WWW-Authenticate` (RFC 9110 Section 11.6.1):
  - Every challenge carries the `realm` parameter with the value `onecoworking`. RFC 6750 Section 3 requires at least one auth-param in a Bearer challenge, so One Coworking never sends a Bearer challenge without parameters.
  - A request without credentials receives `401` `unauthorized` with `WWW-Authenticate: Bearer realm="onecoworking"`. The challenge has no `error` parameter, because RFC 6750 Section 3.1 says a server should not send one when the request lacks authentication information.
  - An invalid, expired, or revoked token receives `401` `unauthorized` with `WWW-Authenticate: Bearer realm="onecoworking", error="invalid_token"`.
  - A valid token without the scope the operation requires receives `403` `insufficient_scope` with `WWW-Authenticate: Bearer realm="onecoworking", error="insufficient_scope", scope="<required scope>"`. The `scope` value is the one scope that the table above assigns to the operation, and the problem body repeats it in `requiredScope`.
  - One Coworking looks up every listing and reservation ID within the token's operator account. An ID that does not exist and an ID that belongs to another operator account receive the same `404` `not_found` with the same body, so a caller cannot learn whether another operator's ID exists. RFC 9110 Section 15.5.4 permits a `404` in place of a `403` for this purpose.
  - A token limited to some venues that names a listing or reservation of its own operator account at another venue receives `403` `forbidden`. That response carries no `insufficient_scope` challenge, because no other scope would grant access.

One Coworking calls to the operator (webhooks) follow the Standard Webhooks specification.

- Webhooks carry no Bearer token. The OpenAPI document sets `security: []` on every webhook, so receivers that enforce the schema never demand one.
- Every delivery is a `POST` with three required headers:
  - `webhook-id`: the event's `eventId`. It is identical on every retry of that event, so receivers can deduplicate on it.
  - `webhook-timestamp`: Unix epoch seconds (UTC) at signing.
  - `webhook-signature`: one or more space-delimited entries of the form `v1,<signature>`. During secret rotation it carries one entry per active secret.
- The signed content is `${webhook-id}.${webhook-timestamp}.${body}`, where `body` is the raw request body exactly as sent. Each signature is the Base64 encoding of the HMAC-SHA256 of that content.
- The signing secret has the form `whsec_<base64>`. The HMAC key is the Base64 decoding of the text after the `whsec_` prefix, not the secret string itself.
- A receiver accepts a delivery when at least one `v1` entry verifies. It compares signatures in constant time and rejects a `webhook-timestamp` more than 300 seconds away from its own clock.
- A receiver answers a delivery that fails verification, or whose timestamp is outside the tolerance, with `400 Bad Request` and does not persist it. It does not answer `401`, because webhook deliveries use no HTTP authentication scheme and a `401` would require a `WWW-Authenticate` challenge (RFC 9110 Section 15.5.2). One Coworking treats the `400` like any other non-`2xx` response and retries under the delivery contract in Section 4.
- `webhook-timestamp` is a decimal integer without a sign or leading zeros. Its length is not fixed.
- The first delivery attempt is signed within 300 seconds of the event's `occurredAt`. Each retry is signed again at send time with a new `webhook-timestamp` and the same `webhook-id`, so a retry's timestamp can be hours after `occurredAt`. A retry's timestamp is never earlier than the first attempt's and never later than 24 hours after `occurredAt`, the end of the retry window.
- Every signed example in this document uses the synthetic secret `whsec_b25lLWNvd29ya2luZy1zeW50aGV0aWMtdGVzdC1rZXk=`. It exists only for documentation and is never issued to an operator. Each `webhook-signature` in Sections 5 and 6 verifies against it.

#### Identifiers
- One Coworking generates opaque, URL-safe string IDs (`ven_...`, `lst_...`, `res_...`, `evt_...`).
- Listings and reservations accept operator-supplied external IDs (`externalId` on listings, `externalReservationId` on reservations).
- `reservationSequence` is a gapless counter per venue (1, 2, 3, ...), so a token limited to some venues can still see every number for those venues. One Coworking assigns it when it creates a reservation and never changes it. Sandbox and production keep separate counters. The operator uses it to notice a missed reservation and to tell One Coworking which reservations a calendar push already counts.
- `version` starts at 1 on every reservation and rises by 1 on each change to it. Webhooks and API responses always carry the whole reservation at a stated version.

#### Time, dates, and DST
- Calendar dates use `YYYY-MM-DD`, the RFC 3339 `full-date` form, in the listing's timezone.
- `timezone` values are IANA Time Zone Database names, such as `Europe/Prague`. RFC 6557 describes how that database is maintained. One Coworking validates each name against the database on the server.
- Exact instants use RFC 3339 date-times with a numeric offset or `Z`.
- Intervals are half-open, `[startsAt, endsAt)`.
- Blocked meeting-room intervals are exact instants rather than local `HH:mm` pairs, so a 23:45 setup crossing midnight is a single interval and a DST transition cannot make a local time ambiguous.
- Local times of day appear only in listing configuration, as `HH:mm` in 24-hour format. Two types keep start and end apart:
  - `LocalStartTime`, used by `localStart` and `checkInTime`, runs from `00:00` to `23:59`.
  - `LocalEndTime`, used by `localEnd`, also accepts `24:00` as the exclusive end of the local day. `24:00` is never a valid start or check-in time.
- Whole-day bookings run from local midnight to the next local midnight. A calendar day is not 86,400 seconds, because DST transitions produce 23-hour and 25-hour days.

#### Money
- Amounts use integer minor units (`amountMinor`) with an uppercase ISO 4217 alphabetic `currency` code. The minor unit is the one ISO 4217 assigns to that currency. CZK has two decimal places, so `29000` with `"CZK"` is 290.00 CZK. A currency without a minor unit, such as JPY, counts whole units.
- Prices are never floating-point numbers.
- Every price object has `taxIncluded: boolean`, `true` for VAT-inclusive gross prices.
- Prices in this document's examples are illustrative.

#### Guest locale
- `guest.locale` is a BCP 47 language tag as RFC 5646 defines it, such as `cs-CZ` or `en-GB`.
- The schema pattern accepts the RFC 5646 Section 2.1 `langtag` form with a language subtag of 2 or 3 letters, including extended language, script, region, variant, extension, and private-use subtags, such as `de-CH-x-phonebk` and `en-US-u-ca-gregory`. It also accepts a tag made only of private-use subtags, such as `x-office`. Language subtags of 4 to 8 letters are excluded as an API choice, because RFC 5646 Section 2.2.1 reserves 4-letter language subtags and the IANA registry holds no language subtag of 5 to 8 letters. It also rejects, as an API choice, the irregular grandfathered tags that RFC 5646 Section 2.2.8 lists. Most of them carry a deprecation date and a preferred value in the IANA language subtag registry, such as `tlh` for `i-klingon`, and One Coworking sends that preferred value instead. Some, such as `i-default`, have neither, and One Coworking never sends them. It rejects separators other than `-`, subtags longer than 8 characters, and a leading subtag that is not a language. One Coworking validates the full RFC 5646 syntax, including registry checks and repeated subtags, with a language-tag library on the server, and a receiver of a reservation or event accepts any tag the pattern admits.
- Language tags are case-insensitive (RFC 5646 Section 2.1.1), so receivers compare them without regard to case.

#### HTTP methods
Methods follow RFC 9110 Section 9.

| Method | Meaning in this API | Operations |
| --- | --- | --- |
| `GET` | Safe read with no side effects (RFC 9110 Section 9.2.1). Supports `If-None-Match` and `If-Match`. | `GET /v1/listings`, `GET /v1/listings/{listingId}`, `GET /v1/listings/{listingId}/calendar`, `GET /v1/reservations`, `GET /v1/reservations/{reservationId}` |
| `HEAD` | Declared in the OpenAPI document on every `GET` path, with the same parameters, preconditions, and response headers (RFC 9110 Section 9.3.2). Returns the status and headers that `GET` would return. No `HEAD` response has content, error responses included. | Every `GET` path |
| `PUT` | Creates or replaces the target with the body as its complete new state (RFC 9110 Section 9.3.4). Returns `201 Created` when the target had no current representation and `200 OK` when it replaced one. Sending the same body again leaves the same state. | `PUT /v1/reservations/{reservationId}/access` |
| `PATCH` | Partial update (RFC 5789). The listing takes a JSON Merge Patch document (`application/merge-patch+json`, RFC 7396). The calendar takes an `application/json` batch of date entries that applies atomically. Omitted listing fields and unlisted calendar dates keep their stored values. | `PATCH /v1/listings/{listingId}`, `PATCH /v1/listings/{listingId}/calendar` |
| `POST` | State transition or command with side effects such as payment capture, refunds, guest notices, or event delivery. | `POST /v1/reservations/{reservationId}/confirm`, `/decline`, `/cancel`, and `POST /v1/webhooks/test` |

#### Partial updates
- **Listing merge patch.** `PATCH /v1/listings/{listingId}` requires `Content-Type: application/merge-patch+json` and applies the body as RFC 7396 Section 2 defines.
  - An omitted member leaves the stored value unchanged.
  - A member set to `null` removes that member, as RFC 7396 Section 2 defines. `"externalId": null` removes the operator's external ID, and the resulting listing omits the `externalId` member. `null` is legal in the patch input only for members that the listing may omit.
  - `null` on a required field that cannot be null, such as `status` or `defaultCapacity`, returns `422` `validation_error` with a `pointer` to that member, such as `/status`.
  - One Coworking applies the whole patch or none of it.
- **Calendar batch.** `PATCH /v1/listings/{listingId}/calendar` takes `Content-Type: application/json` with an `UpsertCalendarRequest` body. That body is a patch document defined by this API, not a JSON Patch or JSON Merge Patch document. Its semantics are:
  - Each entry states the complete snapshot of every date from its `from` to its `to`: `status`, `availableUnits`, and `blockedIntervals`, and `priceOverrides` when the entry carries it.
  - The request-wide `sequence` and `reservationsThrough` apply to every entry.
  - A date that no entry covers keeps its stored snapshot. An entry that omits `priceOverrides` keeps the stored overrides of its dates.
  - No two entries may cover the same date. A batch whose entries overlap, as two ranges or as a repeated single date, returns `422` `validation_error` with `reason` `overlapping_entries` and a `pointer` to the later entry, such as `/entries/2`, before anything is written.
- **Atomic application.** RFC 5789 Section 2 requires a server to apply a patch atomically, so One Coworking evaluates every date of the batch in one transaction. A `200` response reports one outcome per date:
  - `applied`: the push's `sequence` is higher than the stored one, or the date had no snapshot, and One Coworking stored the new snapshot.
  - `unchanged`: the `sequence` equals the stored one and the content is identical. Nothing changes.
  - `skipped_older_sequence`: the `sequence` is lower than the stored one. The stored snapshot stays.
- **Reused sequence.** When any date in a calendar batch has a stored snapshot with the same `sequence` and different content, the whole request fails with `409` `sequence_reused`. The problem lists each such date in `conflictingDates`, and no date of the batch applies, including dates that would otherwise have been `applied`.
- **Advertised patch formats.** RFC 5789 Section 3.1 defines `Accept-Patch`, which advertises `PATCH` support at the URI of the response that carries it. `GET` and `HEAD` responses for `/v1/listings/{listingId}`, both `200` and `304`, carry `Accept-Patch: application/merge-patch+json`, because reads and `PATCH` share that URI. The calendar accepts `PATCH` only at `/v1/listings/{listingId}/calendar` without a query, so `Accept-Patch: application/json` appears only on responses for that bare URI: the `204` of its `OPTIONS` and the `415` of its `PATCH`. A calendar read with the `from` and `to` query names a different URI (RFC 3986 Section 3.4) that does not accept `PATCH`, so its `200` and `304` carry no `Accept-Patch`. `OPTIONS` on either exact URI returns `204` with `Allow` and the `Accept-Patch` of that URI.
- **Unsupported media types.** Every operation with a request body returns `415` `unsupported_media_type` for any other `Content-Type` (RFC 9110 Section 15.5.16). The content of `POST /v1/webhooks/test` is optional: a request without content needs no `Content-Type`, and `415` applies only when content is sent with another media type. A `415` from either `PATCH` operation also carries `Accept-Patch` with the type that operation accepts, as RFC 5789 Section 2.2 recommends.

#### Conditional requests and entity tags

Every target has one kind of validator:

| Target | Validator | Example |
| --- | --- | --- |
| `/v1/reservations/{reservationId}` and its action resources `/confirm`, `/decline`, `/cancel`, and `/access` | Strong, `"v<version>"` | `"v2"` |
| `/v1/listings/{listingId}` | Strong, opaque, changes whenever any field of the listing changes | `"l-4b7e1d90"` |
| `/v1/listings`, `/v1/reservations`, and a calendar read `/v1/listings/{listingId}/calendar?from=...&to=...` | Weak, computed over the returned page or date range for the given query. It changes whenever any returned item, effective availability, or `nextCursor` changes. | `W/"8c1f2a"` |
| `/v1/listings/{listingId}/calendar` without a query, the target of `PATCH` and `OPTIONS` | None. The target exists whenever the listing exists, but it has no entity tag. | None |
| `/v1/webhooks/test` | None. The resource has no current representation, and requests to it ignore `If-Match` and `If-None-Match`. | None |

- **Reservation tags.** A reservation's tag is its `version`, so an operator holding a version from a webhook can send `If-Match` without a prior read.
- **Action resources.** The represented data of `/confirm`, `/decline`, and `/cancel` is the stored reservation at its current `version`: its status, payment, and access data, and its fixed `confirmBy` deadline. That data changes exactly when `version` changes, because every change to a reservation, including its access credential, increments `version`. Whether `confirmBy` has passed is not part of the represented data. It is a comparison of the stored deadline with the server clock at execution time, an independent check in step 7 of the evaluation order. A deadline that passes without a stored change therefore leaves the tag unchanged. The deadline check applies only to `/confirm` and `/decline` on a reservation whose stored status is still `pending_confirmation`, and such a request returns `409` `confirmation_deadline_passed` whatever the preconditions say. A reservation that has already accepted confirmation, such as one in `capture_pending` or `confirmed`, keeps its stored `confirmBy` but is no longer subject to the deadline check, so a repeated `/confirm` is decided by the status and precondition rules alone. The action resources have no `GET` of their own, so each uses the reservation's tag. RFC 9110 Section 8.8.1 allows a strong validator to change more often than the representation it validates. The tag value is therefore the same for an action resource and for the reservation at `GET /v1/reservations/{reservationId}`.
- **The access resource.** While `reservation.access` is `null`, `/access` has no current representation. Every `If-Match` fails there, `*` included, and `If-None-Match: *` passes. Once a credential exists, `/access` has the reservation's tag.
- **The calendar target.** `PATCH` targets `/v1/listings/{listingId}/calendar` without a query, the URI that `OPTIONS` also describes. That target exists whenever the listing exists, but One Coworking assigns it no entity tag, because its state spans every date of the listing. `If-Match: *` passes. A listed `If-Match` tag fails with `412` and no `ETag`, because no tag can match a target that has none. `If-None-Match: *` fails with `412` and no `ETag`, because the target exists. A listed `If-None-Match` tag passes, because it cannot match. Ranged reads keep their weak tags, which validate only the returned date range. These rules apply to `PATCH`. `OPTIONS` on the same URI ignores both headers, as the next rule states.
- **Methods that ignore preconditions.** RFC 9110 Section 13.2.1 requires a server to ignore `If-Match` and `If-None-Match` on a request whose method neither selects nor modifies a target representation. This API has two such cases: `OPTIONS` on either patchable URI, which describes what the URI accepts, and `POST /v1/webhooks/test`, which only queues an event for delivery to the operator's endpoint and selects or modifies no representation at its own URI. One Coworking evaluates neither header on them and never answers them with `412` or `304`. The OpenAPI document declares neither header and no `412` on those operations.
- **Content codings.** RFC 9110 Section 8.8.3 requires a strong tag to differ between the content codings of one resource. One Coworking therefore never sends a `Content-Encoding` on a response that carries a strong `ETag`: the single listing, the reservation, and the responses of its action resources. Each version of those resources has exactly one strong tag, such as `"v2"` for a reservation at version 2. Collection and calendar reads carry weak tags, which semantically equivalent codings may share (RFC 9110 Section 8.8.1), so One Coworking may compress them.
- **Response tags.** A response `ETag` validates the representation of the request's target. Where the body is the reservation, `Content-Location` names it (RFC 9110 Section 8.7).
  - `GET` and `HEAD` responses, `200` and `304`, carry the target's tag.
  - A `200` from `PATCH /v1/listings/{listingId}` carries the listing's new strong tag.
  - A `200` from `POST /confirm`, `/decline`, or `/cancel` carries the `ETag` of the action target, whose value equals the reservation's new tag, and `Content-Location: /partner/v1/reservations/{reservationId}`. The `ETag` validates the action resource, and `Content-Location` names the parent reservation whose representation the body carries.
  - A `201` or `200` from `PUT /access` carries no `ETag`. RFC 9110 Section 9.3.4 allows a validator in a `PUT` response only when the server stored the content without transformation, and One Coworking normalizes the credential it stores. The body is the reservation, named by `Content-Location`. The operator takes the new tag from its `version` field or a later `GET`.
  - The calendar push `200` and the `POST /v1/webhooks/test` `202` carry no `ETag`, because their bodies are not representations of the target.
  - A `409` from a reservation's `/confirm`, `/decline`, or `/cancel` carries the reservation's tag. A `409` from `/access` carries that tag only while a credential exists. While `access` is `null`, `/access` has no current representation, so the `409` has no `ETag`, and its problem body still carries the parent reservation with its `version`.
  - A `412` carries the target's current tag whenever the target has one.
- **Comparison.** `If-Match` uses strong comparison (RFC 9110 Section 8.8.3.2), so a weak tag never matches. `If-Match: *` passes whenever the resource exists, meaning the target has a current representation. On collection and ranged calendar targets, only `*` can pass, because their tags are weak, and on the bare calendar target only `*` can pass, because it has no tag. On `/access` while no credential exists, every `If-Match` fails. `If-None-Match` uses weak comparison, and `If-None-Match: *` fails whenever the target has a current representation.
- **Every other operation.** One Coworking accepts both headers on every operation except `OPTIONS` and `POST /v1/webhooks/test`, including the `HEAD` of every `GET` path, and evaluates them as RFC 9110 Sections 13.1.1, 13.1.2, and 13.2.2 define. `If-Match` comes before `If-None-Match`. When `If-None-Match` fails, `GET` and `HEAD` return `304 Not Modified`, and every other method returns `412` `precondition_failed` with no change.
- **State checks come first, content conflicts after.** Checks that depend only on the request, such as syntax and schema validation, or only on the stored resource state, such as a disallowed status or a passed `confirmBy`, run before both preconditions, as RFC 9110 Section 13.2.1 permits for failures detectable before the conditions. A request that would fail one of them returns that error whatever the preconditions say. Checks that compare the request content with stored state run only after both preconditions pass, because RFC 9110 Section 13.2.1 evaluates preconditions before the request content is processed. Those checks are a calendar `sequence` reused with different content (`409` `sequence_reused`) and an `externalReservationId` that differs from the one stored on a `confirmed` reservation (`409` `invalid_state_transition`).
- **412 context by target.** When a precondition fails, the request makes no change and returns `412` `precondition_failed`:
  - `/v1/listings/{listingId}`: the current listing in `listing`, and its strong `ETag`.
  - `/v1/reservations/{reservationId}`, `/confirm`, `/decline`, and `/cancel`: the current reservation in `reservation`, and its strong `ETag`.
  - `/access`: the current reservation in `reservation`, and the reservation's tag in `ETag` only while a credential exists.
  - `/v1/listings`, `/v1/reservations`, and a calendar read: no resource member, and the current weak `ETag` of the page or range.
  - The bare calendar target: no resource member and no `ETag`.
- An operator that sends only the strong tag from its earlier read receives `412` after any change since that read when the request reaches the `If-Match` check and the action is otherwise allowed. The `412` applies even to a change that would not block the action, and it comes before a content conflict, such as a different `externalReservationId`. `If-Match: *` passes whenever the resource exists. A change that does block the action returns `409` whatever `If-Match` says. An operator that omits both preconditions receives only the state checks and the content checks.
- The calendar push normally carries no precondition. Calendar pushes are ordered per date by the `sequence` rules in Section 2, and a specific `If-Match` on the calendar always fails, because the calendar target has no tag.
- **Other conditional headers.** One Coworking sends no `Last-Modified` and supports no range requests, so it ignores `If-Modified-Since`, `If-Unmodified-Since`, and `If-Range`, as RFC 9110 Sections 13.1.3, 13.1.4, and 13.1.5 require for a resource without a modification date and a request without `Range`.

#### Caching
- Every response to an authenticated `GET` or `HEAD` carries `Cache-Control: private, no-cache`, error responses included. The OpenAPI document requires it on `200` and `304`, and declares it as optional on the error responses that `GET`, `HEAD`, and other methods share. The `private` directive keeps them out of shared caches (RFC 9111 Section 5.2.2.7). The `no-cache` directive makes a private cache revalidate before each reuse (RFC 9111 Section 5.2.2.4), which the client does with `If-None-Match`.
- One Coworking negotiates a content coding only for collection and calendar reads, whose tags are weak. Every successful response to those reads, `200` and `304`, to `GET` and `HEAD`, uncompressed and compressed alike, carries `Vary: Accept-Encoding` (RFC 9110 Section 12.5.5), because `Accept-Encoding` selected the coding, including the choice of no coding. A compressed `200` also carries `Content-Encoding`, which the OpenAPI document declares as an optional header on the `200` of those reads, and the weak tag is the same for every coding.
- Responses that carry a strong tag are never compressed. One Coworking sends them without a content coding whatever `Accept-Encoding` says, so no request header selects among variants, and they carry no `Vary`.
- A `304` has no body and repeats the `ETag`, `Cache-Control`, and `Vary` that a `200` would carry, as RFC 9110 Section 15.4.5 requires. A listing `304` also repeats `Accept-Patch`. A calendar `304` carries none, like the calendar `200`. Like every response from One Coworking, a `304` carries `Date`, because the origin has a clock (RFC 9110 Section 6.6.1).

#### Concurrency and retries
One Coworking serializes state changes on each reservation, for example with a row lock or an atomic compare-and-swap on its `status` and `version`. When two requests act on the same reservation at once, the second waits until the first commits and is then evaluated against the resulting state. Concurrent updates to one listing are serialized the same way, and each calendar batch runs in one transaction.

A lock alone does not survive a crash between a payment call and the commit that records it. One Coworking therefore records each capture, void, or refund durably, together with the reservation, before it sends that operation to the payment provider. One Coworking never sends a recorded operation a second time while its outcome is unknown. It resolves that outcome with the provider instead. The reservation keeps the status its own lifecycle gives it during that time. An unresolved capture keeps `capture_pending` until the 30-minute limit in the fulfillment rule, when One Coworking sends the scheduled void and sets `payment_failed`, and it refunds a capture that later proves to have succeeded. An operator's `POST /cancel` shows `cancelled_by_operator` at once with `paymentStatus: "refund_pending"` while its refund is unresolved. A guest or platform cancellation likewise shows its own `cancelled_by_guest` or `cancelled_by_platform` status with `refund_pending`. Each recorded payment operation therefore runs at most once.

An operator can retry a mutating operation after a lost response, such as a timeout or a dropped connection, by sending the same request again. The retry rests on the domain state of the calendar, listing, or reservation. Protection against overwriting a newer change requires `If-Match` with a specific strong tag from the operator's earlier read, or `If-None-Match: *` when the operator creates the first access credential. When that precondition no longer holds and the action is still allowed, the retry returns `412`. `If-Match: *` or an absent `If-Match` gives no such protection, so a retried `PATCH /v1/listings/{listingId}` or `PUT /access` without a specific tag can overwrite a change made by a later request. A retry reports the current state. It cannot tell the operator which earlier request produced that state. Its outcome depends only on the state at retry time, evaluated in the order below. A request that fails the state checks at retry time returns `409`. When the `confirmBy` deadline and every state check pass, a stale specific tag returns `412`, and a matching tag lets the request proceed like any new request.

| Operation | Retry after a lost response |
| --- | --- |
| `PATCH /v1/listings/{listingId}/calendar` | The per-date `sequence` and `reservationsThrough` rules in Section 2 order every push, and the batch applies atomically. For a date whose currently stored sequence equals the retried `sequence` with the same content, the retry reports `unchanged`. When the retry reuses the currently stored sequence with different content on any date, the whole request returns `409` `sequence_reused` and no date of it applies. When a newer push has since been stored for a date, the retry has a lower `sequence` there and reports `skipped_older_sequence`. |
| `PATCH /v1/listings/{listingId}` | A merge patch is a complete statement of the changed members, so sending the same patch again leaves the same listing. With `If-Match` carrying the strong tag from the earlier read, the retry returns `412` `precondition_failed` with the current listing when that tag is stale, for example because the first request changed the listing or a later change landed. A later change is never overwritten. When the tag is still current, the patch applies normally. |
| `POST /confirm` | A status that does not allow `/confirm` at retry time, such as a terminal status, returns `409` with the current reservation, whatever `If-Match` says. When the deadline and every state check pass, a stale specific tag returns `412` `precondition_failed` with the current reservation. An example is `"v1"` after the first call moved the reservation to `"v2"`. The `412` also applies when the sent `externalReservationId` differs from the stored one, because that content comparison runs after the preconditions. Without `If-Match`, or with a matching tag, a retry on `capture_pending` returns `200` with no second capture. A retry on `confirmed` with the same `externalReservationId` returns `200` with no capture and no second guest notification. A different `externalReservationId` returns `409` `invalid_state_transition`. |
| `POST /decline` and `POST /cancel` | Each moves the reservation one way into a terminal status. A retry that finds a terminal status, such as `declined` or `cancelled_by_operator`, returns `409` `invalid_state_transition` with the current reservation, whatever `If-Match` says. No second void or refund runs. |
| `PUT /access` | One Coworking compares credentials as JSON values, so object member order and insignificant whitespace do not matter (RFC 8259 Section 4). A body semantically equal to the stored credential is a no-op. One Coworking returns `200` with the current reservation and no `ETag`, does not increment `version`, and sends no guest notification, even with `notifyGuest=true`. A body that differs in any member or value is a new replacement. At retry time, a reservation that is not `confirmed` returns `409` with the current reservation. For a `confirmed` reservation, the operator protects the retry with `If-None-Match: *` when it creates the first credential, or with `If-Match` carrying the specific strong tag read before a replacement. When the first call stored its credential, or a later request replaced it, either precondition fails with `412` `precondition_failed`, the current reservation, and its `ETag`. The operator inspects `access` there, with no second notification and no overwrite of a newer credential. With a precondition that still passes, the body is processed like any new request, so a semantically equal body is again a no-op with `200`. |
| `POST /v1/webhooks/test` | A connectivity test only. A retry sends another `webhook.test` event with its own `webhook-id`. |

Operators act on the `status` in the returned reservation, never on the HTTP status code alone.

#### Request evaluation order
Every operation evaluates a request in this order and returns the first failure. RFC 9110 Section 13.2.1 lets a server report a failure it can detect before the preconditions ahead of them, and evaluates the preconditions before the request content is processed. RFC 9110 Section 13.2.2 fixes the order of the preconditions themselves.

1. **Rate limiting:** `429` `rate_limited` with `Retry-After`.
2. **Authentication and scope:** `401` `unauthorized`, or `403` `insufficient_scope` when the token lacks the operation's scope.
3. **Resource existence and ownership:** `404` `not_found` when the listing or reservation does not exist in the token's operator account, which includes an ID that belongs to another operator account, then `403` `forbidden` when it exists in that account and belongs to a venue the token cannot access.
4. **Media type:** `415` `unsupported_media_type`, on a request that carries content.
5. **Syntax and parameters:** `400` `malformed_request` for a body that is not valid JSON, or a query, path, or header parameter that does not parse or breaks a parameter rule, such as a calendar read whose `from` is after its `to`.
6. **Content validation:** `422` `validation_error` for well-formed content that fails the schema or a cross-field rule.
7. **Resource state and `confirmBy` deadline:** `409` `invalid_state_transition` or `confirmation_deadline_passed`, decided by the stored state and, for `/confirm` or `/decline` on a reservation still in `pending_confirmation`, by comparing the stored `confirmBy` deadline with the server clock.
8. **`If-Match` precondition**, when the header is present: strong comparison. Failure returns `412` `precondition_failed`. `OPTIONS` and `POST /v1/webhooks/test` skip this step, because they ignore the header (RFC 9110 Section 13.2.1).
9. **`If-None-Match` precondition**, when the header is present: weak comparison. Failure returns `304 Not Modified` on `GET` and `HEAD`, and `412` `precondition_failed` on every other method. `OPTIONS` and `POST /v1/webhooks/test` skip this step as well.
10. **Content against stored state:** `409` `sequence_reused` when a calendar batch reuses a stored `sequence` with different content, and `409` `invalid_state_transition` when `/confirm` sends an `externalReservationId` that differs from the one stored on a `confirmed` reservation.
11. **Processing.**

A failure detectable before the preconditions, such as a disallowed state, is reported ahead of them. A conflict between the request content and the stored state is reported after them. Only a request that passes every step changes state. A step without a rule for an operation passes: listings have no state checks, only the calendar push checks sequences, and `GET`, `HEAD`, and `OPTIONS` have no content. Because `If-Match` comes before `If-None-Match`, a request carrying both returns `412` when `If-Match` fails, even when `If-None-Match` alone would have produced `304`.

#### Error responses
All `4xx` and `5xx` responses use RFC 9457 Problem Details with the media type `application/problem+json`.

- `type` is the URI `https://api.onecoworking.com/problems/<slug>` and identifies the problem type. Clients branch on `type` (RFC 9457 Section 3.1.1).
- A client that does not recognize a supplied `type` keeps that URI as the problem's identifier, for logs and for recognizing the type later, and handles the response by its HTTP status code. It never replaces a supplied `type` with `about:blank`, which applies only when `type` is absent (RFC 9457 Sections 3.1.1 and 4.2.1).
- `title` is the fixed summary of the problem type, and the schema of each catalog type fixes it. `status` repeats the HTTP status code, and `detail` explains this occurrence to a person.
- `instance` is an optional URI reference that identifies this occurrence.
- Extension members carry the context listed below. Clients ignore extension members they do not recognize (RFC 9457 Section 3.2).
- Problem bodies carry no `code` member. The schema rejects a top-level `code` and leaves every other extension member open.

| `type` slug | Status | `title` | Meaning and required context |
| --- | --- | --- | --- |
| `malformed_request` | 400 | Malformed request | The body is not valid JSON (RFC 8259), or a query, path, or header parameter does not parse or breaks a parameter rule. `errors` is optional, and an item for a parameter carries `parameter`. |
| `unauthorized` | 401 | Unauthorized | Missing, invalid, expired, or revoked Bearer token. `WWW-Authenticate` is always present. |
| `insufficient_scope` | 403 | Insufficient scope | The token lacks the operation's scope. `requiredScope` names it, and `WWW-Authenticate` carries the `insufficient_scope` challenge. |
| `forbidden` | 403 | Forbidden | The listing or reservation belongs to the token's operator account, at a venue outside the token's venue limit. No scope challenge. |
| `not_found` | 404 | Not found | The listing or reservation does not exist in the token's operator account. An ID of another operator account receives the same response. |
| `invalid_state_transition` | 409 | Invalid state transition | The action is not allowed from the reservation's current status. `reservation` is required. |
| `confirmation_deadline_passed` | 409 | Confirmation deadline passed | `/confirm` or `/decline` arrived after `confirmBy` while the reservation was still `pending_confirmation`. `reservation` is required. |
| `sequence_reused` | 409 | Calendar sequence reused | A calendar batch reused a stored `sequence` with different content. `conflictingDates` is required, with at least one `{ date, sequence }` item. No date applied. |
| `precondition_failed` | 412 | Precondition failed | `If-Match` or `If-None-Match` failed. The context depends on the target, as the 412 context list above defines: `listing` for a single listing, `reservation` for a reservation and its action resources, and no resource member for collections and calendar targets. The `ETag` header carries the target's tag when it has one. |
| `unsupported_media_type` | 415 | Unsupported media type | The `Content-Type` is not the one the operation accepts. A `PATCH` response also carries `Accept-Patch`. |
| `validation_error` | 422 | Validation failed | The JSON is well formed but fails the schema or a cross-field rule. `errors` is required, with at least one item. |
| `rate_limited` | 429 | Too many requests | Rate limit exceeded. The client waits for `Retry-After`. |
| `internal_error` | 500 | Internal server error | An unexpected failure. The client may retry later. Every operation declares it. |

Three statuses separate request problems:
- `415` means the `Content-Type` is wrong. One Coworking does not read the body.
- `400` means the content cannot be parsed, or a query, path, or header parameter is invalid. Examples are a truncated JSON body, `from=tomorrow` where a date is required, `limit=500` above its maximum, and a calendar read whose `from` is after its `to`. A parameter failure carries `errors[].parameter`.
- `422` means the content parses and is still unacceptable (RFC 9110 Section 15.5.21). Examples are a missing required member, a value outside its range, and a calendar entry whose `from` is after its `to`. A content failure carries `errors[].pointer`. A request without content never returns `422`.

Each item of `errors` describes one failure:
- `pointer` is an RFC 6901 JSON Pointer into the request body, such as `/entries/0/to`.
- `parameter` is the name of a query, path, or header parameter, such as `from`.
- `reason` is a slug. A schema failure uses the JSON Schema keyword that failed, in its JSON Schema spelling, such as `required`, `type`, `pattern`, `enum`, `format`, `minimum`, `maximum`, `minItems`, or `maxLength`. A cross-field failure uses a rule slug from the table below.
- `detail` explains the failure to a person.

Each item carries exactly one of `pointer` and `parameter`.

<!-- validate: ProblemDetails -->
```json
{
  "type": "https://api.onecoworking.com/problems/validation_error",
  "title": "Validation failed",
  "status": 422,
  "detail": "The calendar request has 1 invalid entry.",
  "errors": [
    {
      "pointer": "/entries/0/to",
      "reason": "date_range_reversed",
      "detail": "Entry 0 ends on 2026-11-24, before its start on 2026-11-26."
    }
  ]
}
```

JSON Schema cannot compare two fields, so One Coworking enforces these rules on the server with the listed `errors[].reason`. A rule on request content returns `422` `validation_error` with a `pointer`. A rule on query parameters returns `400` `malformed_request` with a `parameter`.

| `errors[].reason` | Rule | Location |
| --- | --- | --- |
| `date_range_reversed` | A calendar entry's `from` is after its `to` (`422`), or a calendar read's `from` is after its `to` (`400`). | `pointer` to the entry's `to`, or `parameter` `to` |
| `date_range_too_long` | A calendar entry (`422`) or read (`400`) covers more than 366 dates. | `pointer` to the entry's `to`, or `parameter` `to` |
| `overlapping_entries` | Two entries of one calendar batch cover the same date, as overlapping ranges or as a repeated single date. | `pointer` to the later entry, such as `/entries/2` |
| `interval_reversed` | A blocked interval's `startsAt` is not before its `endsAt`. | `pointer` to the interval's `endsAt` |
| `interval_outside_entry` | A blocked interval does not overlap the local dates `from` to `to` of its entry. | `pointer` to the interval |
| `access_window_reversed` | An access credential's `validFrom` is not before its `validUntil`. | `pointer` to `validUntil` |
| `units_exceed_exclusive` | `availableUnits` is above 1 on an `exclusive` listing. | `pointer` to the entry's `availableUnits` |
| `intervals_on_date_listing` | `blockedIntervals` was sent for a listing with `inventoryGranularity: "date"`. | `pointer` to the entry's `blockedIntervals` |
| `unknown_booking_option` | A price override names an `optionId` that the listing does not define. | `pointer` to the override's `optionId` |
| `tax_mode_mismatch` | A price override's `taxIncluded` differs from the `taxIncluded` of its booking option's `price`. | `pointer` to the override's `taxIncluded` |

One Coworking keeps the same rules for the reservations it sends: `bookedInterval.startsAt` is before `bookedInterval.endsAt`, `occupiedInterval.startsAt` equals `bookedInterval.startsAt` minus `setupMinutes`, `occupiedInterval.endsAt` equals `bookedInterval.endsAt`, and on `pooled` listings `inventoryUnits` equals `seats`.

---

### 2. Domain model

- **Venue.** A physical coworking location (`venueId`, `name`, `timezone`, `currency`).
- **Listing.** One bookable product inside a venue.
  - `inventoryModel` says what a booking consumes. A `pooled` listing has interchangeable units, such as Open Space seats or Reserved Desks, and a booking consumes one unit per seat. An `exclusive` listing is one room or office, and any booking consumes the whole unit whatever its seat count.
  - `inventoryGranularity` says how availability is stored. `date` listings keep a unit count per local date. `interval` listings keep blocked exact intervals and are always `exclusive`.
  - `maxSeats` is the most seats one booking may request. For a private office it is the office capacity.
  - `bookingOptions` lists the products a guest can buy on the listing. Each option has an `optionId`, a `kind`, a `price` per service date or per booking, an optional `pricePerSeat`, and the early-setup lengths it allows in `setupMinutesAllowed`.
    - `calendar_day` books one local date from `localStart` to `localEnd`.
    - `overnight` books from `checkInTime` on the arrival date to the same local time on the next date. The arrival date is the only service date.
    - `fixed_duration` books `durationMinutes` from a start time the guest picks.
    - `date_range` books consecutive local dates, from `minDays` to `maxDays`.
  - `confirmationMode`. With `webhook_confirm`, new bookings start in `pending_confirmation` with a `confirmBy` deadline, 60 seconds by default and configurable up to 24 hours. With `instant`, One Coworking captures payment at checkout and creates the booking as `confirmed` against its effective availability. The operator still receives `reservation.created`, attaches its `externalReservationId` and access details with `/confirm`, and can `/cancel` after a collision.
- **Calendar snapshot.** What the operator last pushed for one `(listingId, date)`: `status`, `availableUnits`, `blockedIntervals` on interval listings, the push's `sequence`, and its `reservationsThrough` watermark. The inventory holds section below explains how One Coworking turns snapshots and holds into effective availability.
- **Reservation.** One booking of one option on one listing.
  - `seats` is how many people attend.
  - `inventoryUnits` is how many units the booking consumes. It equals `seats` on `pooled` listings and is always 1 on `exclusive` listings.
  - `serviceDates` are the priced local dates. Discounts and price overrides apply to these dates.
  - `inventoryDates` are the local dates whose inventory the booking consumes. On interval listings they are the dates the occupied interval touches.
  - `bookedInterval` is the time the guest pays for.
  - `setupMinutes` is the chosen early setup, 0 when none.
  - `occupiedInterval` is `bookedInterval` with its start moved earlier by `setupMinutes`. Holds on interval listings cover this interval.
  - `status`, `paymentStatus`, `version`, `reservationSequence`, `livemode`, guest, pricing, and optional `access` and `cancellation` objects.
- **AccessCredential.** Check-in details the operator attaches. Exactly one variant per `type`:
  - `url` requires `accessUrl`, a protected operator page that shows the guest's code. It carries no `pinCode`.
  - `pin` requires `pinCode`, for spaces that let One Coworking show the code.
  - `qr` requires `qrPayload`.
  - `reception` needs no secret. The guest checks in at a staffed desk.
  - Every variant has `validFrom` and `validUntil`, the span in which the space lets the guest in, and optional `instructions`. Section 4 covers page display versus lock acceptance.

#### Worked mappings

All examples use `Europe/Prague` in November (UTC+01:00) and Deskohub's products. Times are local and written as day and time, so `25T09:00` means 2026-11-25 09:00 at +01:00.

| Product | Listing (`inventoryModel`, `inventoryGranularity`) | Option (`kind`) | `seats` / `inventoryUnits` | `serviceDates` | `inventoryDates` | `bookedInterval` | `occupiedInterval` and access span |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Open Space day pass | `pooled`, `date` | `open-space-day` (`calendar_day`, `00:00` to `17:00`) | 1 / 1 | 2026-11-25 | 2026-11-25 | 25T00:00 to 25T17:00 | Same as booked |
| Reserved Desk day | `pooled`, `date` | `desk-day` (`calendar_day`, `00:00` to `24:00`) | 1 / 1 | 2026-11-25 | 2026-11-25 | 25T00:00 to 26T00:00 | Same as booked |
| Reserved Desk overnight | `pooled`, `date` | `desk-overnight` (`overnight`, check-in `12:00`) | 1 / 1 | 2026-11-25 | 2026-11-25, 2026-11-26 | 25T12:00 to 26T12:00 | Same as booked |
| Meeting room, 1 hour | `exclusive`, `interval` | `room-1h` (`fixed_duration`, 60) | 6 / 1 | 2026-11-25 | 2026-11-25 | 25T09:00 to 25T10:00 | Same as booked |
| Meeting room, 4 hours | `exclusive`, `interval` | `room-4h` (`fixed_duration`, 240) | 4 / 1 | 2026-11-25 | 2026-11-25 | 25T13:00 to 25T17:00 | Same as booked |
| Meeting room, whole day | `exclusive`, `interval` | `room-day` (`calendar_day`, `00:00` to `24:00`) | 8 / 1 | 2026-11-25 | 2026-11-25 | 25T00:00 to 26T00:00 | Same as booked |
| Meeting room, 1 hour at 00:00 with 15-minute setup | `exclusive`, `interval` | `room-1h`, `setupMinutes: 15` | 3 / 1 | 2026-11-25 | 2026-11-24, 2026-11-25 | 25T00:00 to 25T01:00 | 24T23:45 to 25T01:00 |
| Private office, 3 days for 4 people | `exclusive`, `date` | `office-range` (`date_range`) | 4 / 1 | 2026-11-25, 26, 27 | 2026-11-25, 26, 27 | 25T00:00 to 28T00:00 | Same as booked |

Notes on the mappings:
- The overnight stay consumes a desk on both dates, because the desk is taken on the arrival afternoon and the next morning. Its price and discounts follow the arrival date only.
- Date counts cannot confirm that the same physical desk is free on both dates. One free desk on the 25th and a different free desk on the 26th produce a count of 1 on each date, even when no single desk can accommodate the stay. Every listing offering an `overnight` option must therefore use `webhook_confirm`, enforced by the schema. The operator confirms an overnight stay only after holding `inventoryUnits` distinct desks that are each free for the full `occupiedInterval`, and declines with `sold_out` otherwise. A two-seat stay requires two desks that are each free from noon to noon. For the same reason, a `pooled` listing cannot offer a `date_range` option.
- Date inventory also cannot express that one desk can serve a stay ending at noon and another starting at noon. In `v1`, One Coworking treats back-to-back overnight stays on the same desk as requiring two desks on the shared date. This may undersell relative to Deskohub's own site, but it prevents overselling. Pooled interval inventory is out of scope for `v1`.
- The office consumes one unit per date whatever its seat count. Its price per service date is `price` plus `pricePerSeat` times `seats`.
- The early setup moves the hold and the access span to 23:45 on the previous date, while the price, discounts, and cancellation rules follow the booked hour on 2026-11-25.
- Monthly passes are out of scope for `v1`. No option `kind` describes them, and One Coworking rejects attempts to map one.

#### Inventory holds and calendar reconciliation

1. **Holds.** When One Coworking creates a reservation, it places a hold. On `date` listings the hold takes `inventoryUnits` from each of `inventoryDates`. On `interval` listings it blocks `occupiedInterval`, so a morning booking leaves the afternoon bookable. Every hold carries the reservation's `reservationSequence`.
2. **Hold lifetime.** A hold is active while the reservation is `pending_confirmation`, `capture_pending`, or `confirmed`. It ends when the reservation becomes `declined`, `expired`, `payment_failed`, or any `cancelled_*` status.
3. **Snapshots.** Every calendar push carries a required `sequence` and a required `reservationsThrough`. `reservationsThrough: N` states that the pushed numbers already reflect every reservation of the listing's venue with `reservationSequence` up to N, and no One Coworking reservation above N. The operator sets N to the highest value for which it has processed every reservation of that venue from 1 to N. A gap holds N back until the operator fills it through `GET /v1/reservations?venueId=&afterSequence=`.
   - The operator may already hold some reservations above N locally, because webhooks arrive out of order. It computes each date's snapshot as if no One Coworking reservation above N existed, then lets One Coworking subtract them once.
   - A date the operator has closed for its own reasons, such as a holiday or maintenance, stays `closed` with `availableUnits: 0`. Closure takes precedence over the add-back.
   - On `date` listings, `availableUnits` is the live remaining count plus the `inventoryUnits` of every One Coworking reservation above N that the operator holds locally on that date. The status is `open` when that sum is at least 1 and `sold_out` when it is 0.
   - On `interval` listings nothing is added. The operator recomputes `blockedIntervals` with those reservations' occupied intervals left out and every independent block kept. The date is `open` with `availableUnits: 1` when any bookable time remains under that recomputed set, and `sold_out` with 0 when none does. Units stay within 0 and 1.
   - Example: two desks are free, the operator has applied reservation 43 but not 42, and N is 41. Its live count is 1, it adds back 43's unit, and it pushes `availableUnits: 2`. One Coworking subtracts holds 42 and 43 and shows 0, which matches reality once 42 is counted.
4. **Effective availability.** For each `(listingId, date)` One Coworking stores the latest snapshot and computes availability from it and the active holds with `reservationSequence` above that snapshot's `reservationsThrough`.
   - `date` listings: `max(0, availableUnits - sum of those holds' inventoryUnits on the date)`.
   - `interval` listings: the snapshot's `blockedIntervals` plus those holds' occupied intervals. A requested occupied interval must avoid all of them.
   - Each hold counts once. A snapshot either already counts the reservation, when N is at least its sequence, or the hold is subtracted from it, never both.
   - A date with no snapshot uses the listing's `defaultCapacity` with `reservationsThrough: 0`.
5. **Releasing holds.** When a hold above the snapshot's N ends, its units return immediately because the snapshot never counted them. When a hold at or below N ends, effective availability remains unchanged until the operator pushes a new snapshot, because the previous snapshot already counted the reservation as occupied. The operator pushes a fresh snapshot after processing each `reservation.cancelled`, `reservation.expired`, or `reservation.payment_failed` event, and after each `/decline`.
6. **Sequence rules.** `sequence` is a required non-negative integer that the operator raises with every push for a listing, such as a database sequence or Unix epoch milliseconds. One Coworking compares it per `(listingId, date)`:
   - higher than the stored value: applied;
   - lower: skipped with outcome `skipped_older_sequence`;
   - equal, with the same `status`, `availableUnits`, `blockedIntervals`, `priceOverrides`, and `reservationsThrough`: outcome `unchanged`, a safe retry;
   - equal with different content: the whole push fails with `409` `sequence_reused`, which names the date in `conflictingDates`, and no date of that push applies;
   - no stored snapshot: any sequence applies.
7. **Response.** One Coworking applies each push atomically, as Section 1 describes. A successful push returns, for each date, the outcome, the stored snapshot, the effective availability, and the holds One Coworking subtracted. Contract example (a) walks through a stale snapshot, and contract example (i) shows a reused sequence.

---

### 3. Reservation state machine

```mermaid
stateDiagram-v2
    [*] --> pending_confirmation: Checkout on webhook_confirm (card authorized)
    [*] --> confirmed: Checkout on instant (payment captured)

    pending_confirmation --> confirmed: POST /confirm, capture succeeds
    pending_confirmation --> capture_pending: POST /confirm, capture outcome unknown
    pending_confirmation --> payment_failed: POST /confirm, capture refused
    pending_confirmation --> declined: POST /decline
    pending_confirmation --> expired: confirmBy passes
    pending_confirmation --> cancelled_by_guest: Guest cancels
    pending_confirmation --> cancelled_by_platform: One Coworking cancels

    capture_pending --> confirmed: Capture settles
    capture_pending --> payment_failed: Capture fails or stays unknown for 30 minutes

    confirmed --> cancelled_by_guest: Guest cancels
    confirmed --> cancelled_by_operator: POST /cancel
    confirmed --> cancelled_by_platform: One Coworking support or fraud cancels

    declined --> [*]
    expired --> [*]
    payment_failed --> [*]
    cancelled_by_guest --> [*]
    cancelled_by_operator --> [*]
    cancelled_by_platform --> [*]
```

`paymentStatus` follows `status`, and the schema enforces each pairing:

| `status` | `paymentStatus` |
| --- | --- |
| `pending_confirmation` | `authorized`, or `captured` if One Coworking captures at checkout |
| `capture_pending` | `capture_pending` |
| `confirmed` | `captured` |
| `payment_failed` | `failed`, or `refund_pending` then `refunded` after a late capture |
| `declined`, `expired` | `voided`, `refund_pending`, or `refunded` |
| `cancelled_by_guest`, `cancelled_by_operator`, `cancelled_by_platform` | `voided`, `refund_pending`, `refunded`, or `captured` when the cancellation policy keeps the money |

#### Fulfillment rule
- `confirmed` is the only status that allows fulfillment. One Coworking sets it only after the payment is captured.
- The operator issues a lock credential, shows a code on its access page, or sends its own guest message only when the newest version it holds is `confirmed`.
- Before issuing a lock credential, the operator reads the reservation with `GET /v1/reservations/{reservationId}` and proceeds only if that read still returns `confirmed`. A later event with a higher version still wins, and the operator then withdraws what it issued.
- `capture_pending` retains both holds. The operator issues no access and awaits `reservation.confirmed` or `reservation.payment_failed`. One Coworking resolves every `capture_pending` reservation within 30 minutes. If the payment provider still returns no definitive result after 30 minutes, One Coworking voids the authorization and transitions the reservation to `payment_failed`.
- A void request does not prove the guest was not charged. One Coworking continues reconciling each `payment_failed` reservation with its payment provider for 7 days. If a capture later proves to have succeeded, One Coworking refunds it, increments the reservation version, and updates `paymentStatus` to `refund_pending` and then `refunded`. The reservation remains `payment_failed`, the booking is not reinstated, and the guest receives a refund notice. The operator observes the update via `GET` and takes no fulfillment action.
- If One Coworking captured at checkout, a `pending_confirmation` reservation already has `paymentStatus: "captured"`. Its `/confirm` moves it to `confirmed` without another capture and never yields `capture_pending` or `payment_failed`.
- A `confirmBy` deadline stops applying once One Coworking accepts `/confirm`. A `capture_pending` reservation never expires.

#### Transition and retry rules

| Current status | Action | Result |
| --- | --- | --- |
| `pending_confirmation` | `POST /confirm` before `confirmBy`, capture succeeds | `200`, `confirmed`, `paymentStatus: "captured"`. Stores `externalReservationId` and `access`, notifies the guest, emits `reservation.confirmed`. |
| `pending_confirmation` | `POST /confirm` before `confirmBy`, capture outcome unknown | `200`, `capture_pending`. Stores `externalReservationId` and `access` but shows nothing to the guest yet. |
| `pending_confirmation` | `POST /confirm` before `confirmBy`, capture refused | `200`, `payment_failed`. Voids the authorization, notifies the guest, emits `reservation.payment_failed`. |
| `pending_confirmation` | `POST /decline` before `confirmBy` | `200`, `declined`. Voids or refunds the payment and notifies the guest. |
| `pending_confirmation` | `POST /confirm` or `/decline` after `confirmBy` | `409` `confirmation_deadline_passed` with the current reservation, which can still show `pending_confirmation` until One Coworking processes the expiry. |
| `pending_confirmation` | `confirmBy` elapses with no response | `expired`. Voids or refunds and emits `reservation.expired`. |
| `capture_pending` | Capture settles or fails | `confirmed` with `reservation.confirmed`, or `payment_failed` with `reservation.payment_failed`. |
| `capture_pending` | `POST /confirm` | `200` with the current reservation. No second capture. |
| `capture_pending` | `POST /decline` or `/cancel` | `409` `invalid_state_transition` with the current reservation. |
| `confirmed` (`instant`, no `externalReservationId` stored yet) | `POST /confirm` | `200`, still `confirmed`. Stores `externalReservationId` and `access` without any capture, sends the guest the access details, emits `reservation.confirmed`. |
| `confirmed` | `POST /confirm` with the same `externalReservationId` | `200` with the current reservation. No capture, guest notification, or event. |
| `confirmed` | `POST /decline`, or `POST /confirm` with an `externalReservationId` different from the stored one | `409` `invalid_state_transition` with the current reservation. For `/confirm`, the ID comparison runs after both preconditions, so a failing precondition returns `412` first. |
| `confirmed` | `POST /cancel` | `200`, `cancelled_by_operator`. Full refund, guest notified, `reservation.cancelled` emitted. |
| `confirmed` | Guest or One Coworking cancels | `cancelled_by_guest` or `cancelled_by_platform`, `reservation.cancelled` emitted. |
| Any terminal status | `/confirm`, `/decline`, or `/cancel` | `409` `invalid_state_transition` with the current reservation. This covers a retry whose earlier call already reached this status. No second void or refund runs. |
| Any status where the action is allowed | `/confirm`, `/decline`, `/cancel`, or `PUT /access` with a failing precondition, meaning an `If-Match` that does not match the reservation's current tag or an `If-None-Match` that does | `412` `precondition_failed` with the current reservation, and its `ETag` whenever the target has a current representation. Nothing changes. This includes `POST /confirm` with a different `externalReservationId` on a `confirmed` reservation. |
| `cancelled_by_guest` at version 3 | `POST /confirm` with `If-Match: "v1"` | `409` `invalid_state_transition` with the current reservation. The state check precedes `If-Match`, so the stale tag does not turn this into `412`. |
| `confirmed` with `access: null` | `PUT /access` with `If-None-Match: *` or no precondition | `201 Created` with `Content-Location: /partner/v1/reservations/{reservationId}` and the reservation at its next version. No `ETag`. The guest is notified when `notifyGuest=true`. |
| `confirmed` with `access: null` | `PUT /access` with any `If-Match`, `*` included | `412` `precondition_failed` with the current reservation and no `ETag`, because `/access` has no current representation. Nothing changes. |
| `confirmed` with a stored credential | `PUT /access` with a different credential and a passing or absent precondition | `200` with the reservation at its next version and no `ETag`. The guest is notified when `notifyGuest=true`. |
| `confirmed` with a stored credential | `PUT /access` with `If-None-Match: *` | `412` `precondition_failed` with the current reservation and `ETag`. Nothing changes. |
| `confirmed` | `PUT /access` with a body semantically equal to the stored credential, compared as JSON values whatever the member order, and a passing or absent precondition | `200` with the current reservation and no `ETag`. No `version` increment and no guest notification, even with `notifyGuest=true`. |

#### When `/confirm` loses a race
A guest cancellation, a platform cancellation, or the `confirmBy` deadline can win against an operator's `/confirm`. The operator then gets `409` with the current reservation, even when its `If-Match` is stale. The operator acts on that reservation's `status`. When the `status` is still `pending_confirmation`, as with a `confirmation_deadline_passed` that arrives before the expiry is processed, the operator retains its local hold until `reservation.expired` arrives or a `GET` shows a terminal status. When the `status` is terminal and not `confirmed`, meaning `declined`, `expired`, `payment_failed`, or a `cancelled_*` status, the operator:
1. releases its local hold;
2. withdraws any access page it prepared and issues no lock credential;
3. pushes a calendar update with `reservationsThrough` covering the reservation.

If `/confirm` receives no response, such as a timeout or dropped connection, the operator sends the same request again with the same `If-Match`, or reads the reservation with `GET`. A `412` or `409` on that retry carries the current reservation, and the operator acts on its current `status`. The operator retains its local hold until a terminal status is confirmed, and never releases the hold or fulfills on an unverified assumption. A retry or read returning `capture_pending` is also not a failure: the operator retains its hold and awaits `reservation.confirmed` or `reservation.payment_failed`.

---

### 4. Endpoints and webhooks

#### REST endpoints (operator to One Coworking)

| Method and path | Purpose |
| --- | --- |
| `GET /v1/listings` | List the operator's listings with cursor pagination and optional `venueId`, `externalId`, or `status` filter. |
| `GET /v1/listings/{listingId}` | Read one listing. |
| `PATCH /v1/listings/{listingId}` | Change `externalId`, `status`, `defaultCapacity`, `minLeadTimeMinutes`, or `maxBookingHorizonDays` with a JSON Merge Patch document (`application/merge-patch+json`). |
| `GET /v1/listings/{listingId}/calendar` | Read stored snapshots and effective availability for a date range. |
| `PATCH /v1/listings/{listingId}/calendar` | Push calendar snapshots for explicit dates or date ranges, with `sequence`, `reservationsThrough`, and optional `priceOverrides`, as one atomic batch. Dates outside the listed entries keep their stored snapshots. |
| `GET /v1/reservations` | Recovery. List reservations by `afterSequence` (ascending `reservationSequence`) or `updatedSince`. `afterSequence` requires `venueId`. Optional `listingId` or `status` filter. |
| `GET /v1/reservations/{reservationId}` | Read one reservation's current state. |
| `POST /v1/reservations/{reservationId}/confirm` | Confirm a `pending_confirmation` reservation, or attach the first `externalReservationId` and `access` to an `instant` one, with optional `access`. |
| `POST /v1/reservations/{reservationId}/decline` | Decline a `pending_confirmation` reservation with a structured `reason`. |
| `POST /v1/reservations/{reservationId}/cancel` | Cancel a `confirmed` reservation from the operator side with a structured `reason`. |
| `PUT /v1/reservations/{reservationId}/access` | Create or replace the complete access credential on a `confirmed` reservation, optionally notifying the guest. Returns `201` for the first credential and `200` for a replacement. |
| `POST /v1/webhooks/test` | Send one signed `webhook.test` event to the registered endpoint. It cannot send reservation events. The request may carry no content. |

#### Webhooks (One Coworking to operator)

| Event `type` | When One Coworking sends it | `data.reservation.status` |
| --- | --- | --- |
| `reservation.created` | A guest completed checkout. | `pending_confirmation` or `confirmed` |
| `reservation.confirmed` | A `/confirm` succeeded, including one that completed an instant booking, or a `capture_pending` capture settled. | `confirmed` |
| `reservation.payment_failed` | Capture failed after `/confirm`. | `payment_failed` |
| `reservation.cancelled` | The guest, the operator, or One Coworking cancelled. | `cancelled_by_guest`, `cancelled_by_operator`, or `cancelled_by_platform` |
| `reservation.expired` | `confirmBy` elapsed without an operator response. | `expired` |
| `webhook.test` | `POST /v1/webhooks/test` or the partner dashboard. | No reservation |

#### Webhook delivery contract
- **Signature.** Every delivery carries `webhook-id`, `webhook-timestamp`, and `webhook-signature` as Section 1 defines. The operator verifies the signature over the raw body before parsing it and answers a delivery that fails verification with `400 Bad Request`, without persisting it. It never answers `401`, because a `401` requires an HTTP authentication challenge and webhook deliveries use none (RFC 9110 Section 15.5.2). One Coworking retries a `400` like any other non-`2xx` response, so a delivery rejected during a secret rotation still arrives once the receiver accepts the new secret.
- **Durable acceptance.** For reservation events, the operator returns `2xx` only after durably persisting the event (at minimum `eventId`, `reservation.id`, `version`, and the raw body). A `webhook.test` event has no reservation; the operator verifies its signature and responds with `2xx`, and persisting it is optional. A `2xx` response acknowledges durable storage rather than completed processing. The operator responds within 5 seconds and executes downstream work asynchronously.
- **Retries.** A non-`2xx` response or timeout triggers retries at 10 s, 30 s, 2 min, 10 min, 30 min, 1 h, then hourly until 24 hours after `occurredAt`. Each retry keeps its `webhook-id` and is signed again at delivery time with a new `webhook-timestamp`. After 24 hours One Coworking marks delivery failed and alerts the operator's technical contact. The reservation remains readable through `GET`.
- **Deduplication.** Operators deduplicate by `webhook-id`, which always equals the body's `eventId`.
- **Ordering.** Deliveries can arrive in any order. The operator keeps the highest `version` it has applied per reservation and acknowledges, then ignores, any event whose version is at or below it. An event for a reservation the operator has never seen is applied whatever its type. A `reservation.cancelled` that arrives first therefore creates a terminal record, and the later `reservation.created` with a lower version is ignored.
- **Recovery.** The operator calls `GET /v1/reservations` at startup, whenever it sees a gap in `reservationSequence`, and at least every 15 minutes. It applies each returned reservation by version, exactly like a webhook.
  - The operator persists a scan boundary per venue. A scan asks for `updatedSince` set 5 minutes before the stored boundary and follows `nextCursor` to the last page.
  - Only after every page is durably applied does the operator move the boundary to the latest `updatedAt` it applied. A scan that fails partway leaves the boundary where it was, so the next scan, even after an outage, starts from the same point and repeats the pages. Version ordering makes the repeat harmless.
  - A cancellation missed past the retry window is therefore picked up by the next scan that completes.
- **Live and test events.** Every event and reservation carries `livemode`. Production sends `livemode: true`. Production `POST /v1/webhooks/test` sends only `webhook.test`. Simulated reservations come only from sandbox checkout at `sandbox-api.onecoworking.com` and carry `livemode: false`. A production endpoint acknowledges and drops any event with `livemode: false`.

#### Access credentials and cancellation
- `validFrom` and `validUntil` are the guest's exact entitlement, the span in which the space lets the guest in. Deskohub sets them to `occupiedInterval`.
- A lock may accept the code over a wider span. Deskohub's Igloohome AlgoPIN codes work in whole Prague hours.
  - The programmed start is `validFrom` rounded down to the hour. If Deskohub first issues the code after that rounded start, for a booking that has already begun, the start is the beginning of the current hour instead.
  - The programmed end is `validUntil` rounded up to the next full hour. An end already on the hour stays as it is.
  - A 23:45 setup start opens the lock from 23:00. An end at 01:20 keeps it open until 02:00, and an end at 17:00 closes it at 17:00.
- One Coworking shows the guest the exact entitlement, never the lock window.
- An `accessUrl` page may display a code prior to `validFrom`. The span indicates when the door opens rather than when the page becomes visible, and One Coworking should present it accordingly.
- Deskohub sends only `type: "url"`. Its confirmation email and pass carry the link and never the PIN. A space that sends `type: "pin"` accepts that One Coworking displays the code on the pass.
- On any `reservation.cancelled`, `reservation.expired`, or `reservation.payment_failed`, the operator performs two distinct actions.
  1. **Withdraw disclosure.** Immediately stop displaying the code on the access page.
  2. **Remove the lock credential.** An online lock can delete the code immediately. An offline code lock, such as an Igloohome AlgoPIN, continues accepting the code until staff remove it at the lock over Bluetooth or until its programmed end elapses. The operator tracks that physical removal as a separate task.
- One Coworking never asserts to guests or staff that a code was deleted from a lock. The API includes no field making that claim.

#### Optional capability: synchronous pre-checkout availability check

Spaces that want to check live availability before a guest enters payment details can register an `availabilityCheckUrl`.

- **Request.** `POST <availabilityCheckUrl>`, signed with the same `webhook-id`, `webhook-timestamp`, and `webhook-signature` headers, where `webhook-id` identifies the check request, with a 2-second hard timeout, with `{ listingId, externalListingId, bookingOptionId, serviceDates, inventoryDates, occupiedInterval, seats, inventoryUnits, addons }`.
- **Response.** `200 OK` with `{ available: boolean, unavailableReason?: "sold_out" | "closed" | "outside_hours" | "invalid_duration", availableUnits?: number }`.
- **Fallback.** On timeout or `5xx`, One Coworking uses effective availability from the pushed calendar, or asks the guest to retry, as configured per listing.

---

### 5. Concrete examples

The HTTP/1.1 examples in Sections 5 and 6 omit routine fields. Every response also carries `Date` (RFC 9110 Section 6.6.1), and every message with content also carries `Content-Length` or `Transfer-Encoding`, as RFC 9112 Section 6.3 describes. A request without content, such as a `GET`, needs neither, and a `304` or a response to `HEAD` ends at its header section. An example written as a header section followed by a sentence about the body abbreviates that body, and the sentence states what the body contains. Every webhook example carries a `webhook-signature` that verifies against the synthetic secret in Section 1.

#### A. Push a calendar update

Mark one date sold out and another closed, and push remaining units for a range.

<!-- validate: UpsertCalendarRequest -->
```http
PATCH /partner/v1/listings/lst_deskohub_openspace/calendar HTTP/1.1
Host: api.onecoworking.com
Authorization: Bearer oc_live_example_token
Content-Type: application/json

{
  "sequence": 4812,
  "reservationsThrough": 40,
  "entries": [
    {
      "from": "2026-11-24",
      "to": "2026-11-24",
      "status": "sold_out",
      "availableUnits": 0
    },
    {
      "from": "2026-11-25",
      "to": "2026-11-27",
      "status": "open",
      "availableUnits": 6
    },
    {
      "from": "2026-12-24",
      "to": "2026-12-26",
      "status": "closed",
      "availableUnits": 0
    }
  ]
}
```

A meeting room (`inventoryGranularity: "interval"`) pushes blocked exact intervals. An entry replaces the operator-blocked intervals on its local dates.

<!-- validate: UpsertCalendarRequest -->
```json
{
  "sequence": 9104,
  "reservationsThrough": 40,
  "entries": [
    {
      "from": "2026-11-24",
      "to": "2026-11-24",
      "status": "open",
      "availableUnits": 1,
      "blockedIntervals": [
        { "startsAt": "2026-11-24T09:45:00+01:00", "endsAt": "2026-11-24T11:00:00+01:00" },
        { "startsAt": "2026-11-24T14:00:00+01:00", "endsAt": "2026-11-24T18:00:00+01:00" }
      ]
    }
  ]
}
```

#### B. Meeting-room listing with booking options

<!-- validate: Listing -->
```json
{
  "id": "lst_deskohub_meeting_room",
  "venueId": "ven_deskohub_prague",
  "externalId": "meeting-room:main",
  "name": "Meeting room",
  "inventoryModel": "exclusive",
  "inventoryGranularity": "interval",
  "maxSeats": 8,
  "defaultCapacity": 1,
  "bookingOptions": [
    {
      "optionId": "room-1h",
      "kind": "fixed_duration",
      "name": "1 hour",
      "durationMinutes": 60,
      "price": { "amountMinor": 35000, "currency": "CZK", "taxIncluded": true },
      "pricePerSeat": null,
      "setupMinutesAllowed": [0, 15]
    },
    {
      "optionId": "room-4h",
      "kind": "fixed_duration",
      "name": "4 hours",
      "durationMinutes": 240,
      "price": { "amountMinor": 120000, "currency": "CZK", "taxIncluded": true },
      "pricePerSeat": null,
      "setupMinutesAllowed": [0, 15]
    },
    {
      "optionId": "room-day",
      "kind": "calendar_day",
      "name": "Whole day",
      "localStart": "00:00",
      "localEnd": "24:00",
      "price": { "amountMinor": 250000, "currency": "CZK", "taxIncluded": true },
      "pricePerSeat": null,
      "setupMinutesAllowed": [0, 15]
    }
  ],
  "confirmationMode": "webhook_confirm",
  "confirmationTimeoutSeconds": 60,
  "status": "active",
  "timezone": "Europe/Prague",
  "minLeadTimeMinutes": 0,
  "maxBookingHorizonDays": 90,
  "updatedAt": "2026-11-20T08:00:00Z"
}
```

#### C. Incoming `reservation.created` webhook

<!-- validate: ReservationCreatedEvent -->
```http
POST /api/integrations/one-coworking/webhook HTTP/1.1
Host: workspace.deskohub.cz
Content-Type: application/json
webhook-id: evt_01JDR7X9K2M8N4P6Q8R0S2T4V6
webhook-timestamp: 1795518605
webhook-signature: v1,fhf9VeLkXXEl+Opwrmi0mqjL5DyM5iGdafA4CtLEScU=

{
  "eventId": "evt_01JDR7X9K2M8N4P6Q8R0S2T4V6",
  "type": "reservation.created",
  "occurredAt": "2026-11-24T11:10:05Z",
  "livemode": true,
  "data": {
    "reservation": {
      "id": "res_01JDR7X8W1A2B3C4D5E6F7G8H9",
      "venueId": "ven_deskohub_prague",
      "listingId": "lst_deskohub_reserved_desk",
      "externalListingId": "cowork:reserved-desk",
      "externalReservationId": null,
      "reservationSequence": 42,
      "version": 1,
      "livemode": true,
      "status": "pending_confirmation",
      "paymentStatus": "authorized",
      "confirmationMode": "webhook_confirm",
      "confirmBy": "2026-11-24T11:11:05Z",
      "inventoryModel": "pooled",
      "inventoryGranularity": "date",
      "bookingOptionId": "desk-day",
      "timezone": "Europe/Prague",
      "serviceDates": ["2026-11-25"],
      "inventoryDates": ["2026-11-25"],
      "bookedInterval": { "startsAt": "2026-11-25T00:00:00+01:00", "endsAt": "2026-11-26T00:00:00+01:00" },
      "setupMinutes": 0,
      "occupiedInterval": { "startsAt": "2026-11-25T00:00:00+01:00", "endsAt": "2026-11-26T00:00:00+01:00" },
      "seats": 1,
      "inventoryUnits": 1,
      "addons": [],
      "guest": {
        "firstName": "Jana",
        "lastName": "Novakova",
        "email": "jana.novakova@example.invalid",
        "phone": "+420123456789",
        "companyName": "Acme s.r.o.",
        "locale": "cs-CZ"
      },
      "pricing": {
        "grossAmount": { "amountMinor": 41000, "currency": "CZK", "taxIncluded": true },
        "commissionAmount": { "amountMinor": 6150, "currency": "CZK", "taxIncluded": true },
        "netPayoutAmount": { "amountMinor": 34850, "currency": "CZK", "taxIncluded": true }
      },
      "access": null,
      "cancellation": null,
      "createdAt": "2026-11-24T11:10:04Z",
      "updatedAt": "2026-11-24T11:10:04Z"
    }
  }
}
```

`webhook-id` equals the body's `eventId`. The `webhook-timestamp` value `1795518605` is `2026-11-24T11:10:05Z`, the event's `occurredAt`, because this is the first delivery attempt.

When the operator's endpoint does not answer `2xx`, One Coworking retries the same event. A retry keeps `webhook-id` and the body, and is signed again at send time:

```http
POST /api/integrations/one-coworking/webhook HTTP/1.1
Host: workspace.deskohub.cz
Content-Type: application/json
webhook-id: evt_01JDR7X9K2M8N4P6Q8R0S2T4V6
webhook-timestamp: 1795528365
webhook-signature: v1,IcKE3Qka54cIr8FKG0frwaLbMSrGmIJpjR2b4y5StQA=
```

The retry's body is the same sequence of bytes as the first attempt above and is not repeated here. Its `webhook-timestamp` value `1795528365` is `2026-11-24T13:52:45Z`, 2 hours 42 minutes 40 seconds after `occurredAt`. A receiver checks it against its own clock, never against `occurredAt`, and the signature verifies over the new timestamp and the unchanged body.

#### D. Operator confirms and attaches a protected access page

<!-- validate: ConfirmReservationRequest -->
```http
POST /partner/v1/reservations/res_01JDR7X8W1A2B3C4D5E6F7G8H9/confirm HTTP/1.1
Host: api.onecoworking.com
Authorization: Bearer oc_live_example_token
Content-Type: application/json
If-Match: "v1"

{
  "externalReservationId": "dh_ord_987654",
  "access": {
    "type": "url",
    "accessUrl": "https://workspace.deskohub.cz/cs/reservation/access/dh_ord_987654?token=signed_capability_token",
    "validFrom": "2026-11-25T00:00:00+01:00",
    "validUntil": "2026-11-26T00:00:00+01:00",
    "instructions": "Open the access link to view your door PIN. The lock accepts it during your reserved day."
  }
}
```

The `If-Match` value is the version 1 tag from the `reservation.created` webhook, so no prior read is needed. One Coworking captures payment and responds with the reservation at version 2, `ETag: "v2"`, and `Content-Location: /partner/v1/reservations/res_01JDR7X8W1A2B3C4D5E6F7G8H9`.

<!-- validate: Reservation -->
```json
{
  "id": "res_01JDR7X8W1A2B3C4D5E6F7G8H9",
  "venueId": "ven_deskohub_prague",
  "listingId": "lst_deskohub_reserved_desk",
  "externalListingId": "cowork:reserved-desk",
  "externalReservationId": "dh_ord_987654",
  "reservationSequence": 42,
  "version": 2,
  "livemode": true,
  "status": "confirmed",
  "paymentStatus": "captured",
  "confirmationMode": "webhook_confirm",
  "confirmBy": "2026-11-24T11:11:05Z",
  "inventoryModel": "pooled",
  "inventoryGranularity": "date",
  "bookingOptionId": "desk-day",
  "timezone": "Europe/Prague",
  "serviceDates": ["2026-11-25"],
  "inventoryDates": ["2026-11-25"],
  "bookedInterval": { "startsAt": "2026-11-25T00:00:00+01:00", "endsAt": "2026-11-26T00:00:00+01:00" },
  "setupMinutes": 0,
  "occupiedInterval": { "startsAt": "2026-11-25T00:00:00+01:00", "endsAt": "2026-11-26T00:00:00+01:00" },
  "seats": 1,
  "inventoryUnits": 1,
  "addons": [],
  "guest": {
    "firstName": "Jana",
    "lastName": "Novakova",
    "email": "jana.novakova@example.invalid",
    "phone": "+420123456789",
    "companyName": "Acme s.r.o.",
    "locale": "cs-CZ"
  },
  "pricing": {
    "grossAmount": { "amountMinor": 41000, "currency": "CZK", "taxIncluded": true },
    "commissionAmount": { "amountMinor": 6150, "currency": "CZK", "taxIncluded": true },
    "netPayoutAmount": { "amountMinor": 34850, "currency": "CZK", "taxIncluded": true }
  },
  "access": {
    "type": "url",
    "accessUrl": "https://workspace.deskohub.cz/cs/reservation/access/dh_ord_987654?token=signed_capability_token",
    "validFrom": "2026-11-25T00:00:00+01:00",
    "validUntil": "2026-11-26T00:00:00+01:00",
    "instructions": "Open the access link to view your door PIN. The lock accepts it during your reserved day."
  },
  "cancellation": null,
  "createdAt": "2026-11-24T11:10:04Z",
  "updatedAt": "2026-11-24T11:10:31Z"
}
```

---

### 6. Contract examples with expected outcomes

Each example states the starting state, the messages, and what both sides must do.

#### (a) Stale calendar snapshot arriving after checkout

Starting state: Reserved Desk listing `lst_deskohub_reserved_desk` on 2026-11-25. The stored snapshot is `sequence: 5000`, `reservationsThrough: 41`, `availableUnits: 1`.

1. At 11:10:04Z a guest books the last desk on One Coworking. Reservation `res_01JDR7X8W1A2B3C4D5E6F7G8H9` gets `reservationSequence: 42`, and its hold takes 1 unit. Effective availability drops to 0.
2. At 11:10:06Z a push arrives that the operator prepared at 11:10:03Z, before it saw reservation 42. It has a newer `sequence` and still shows one desk.

<!-- validate: UpsertCalendarRequest -->
```json
{
  "sequence": 5001,
  "reservationsThrough": 41,
  "entries": [
    { "from": "2026-11-25", "to": "2026-11-25", "status": "open", "availableUnits": 1 }
  ]
}
```

One Coworking applies the snapshot and still subtracts the hold, because 42 is above 41.

<!-- validate: UpsertCalendarResponse -->
```json
{
  "listingId": "lst_deskohub_reserved_desk",
  "results": [
    {
      "date": "2026-11-25",
      "outcome": "applied",
      "storedSequence": 5001,
      "storedReservationsThrough": 41,
      "status": "open",
      "availableUnits": 1,
      "blockedIntervals": null,
      "effectiveStatus": "sold_out",
      "effectiveAvailableUnits": 0,
      "effectiveBlockedIntervals": null,
      "subtractedHolds": [
        { "reservationId": "res_01JDR7X8W1A2B3C4D5E6F7G8H9", "reservationSequence": 42, "inventoryUnits": 1 }
      ]
    }
  ]
}
```

Expected outcomes:
- No second guest can book the desk. Effective availability stays 0.
- If reservation 42 is declined or expires, its hold ends and effective availability returns to 1 without a new push. The snapshot never counted 42, so that is correct.
- After the operator confirms 42, it pushes `sequence: 5002`, `reservationsThrough: 42`, `status: "sold_out"`, `availableUnits: 0`. The hold is no longer subtracted, effective availability stays 0, and the reservation counts once.
- A delayed retry of `sequence: 5001` after that gets `skipped_older_sequence`. A different payload sent as `sequence: 5002` fails as a whole with `409` `sequence_reused`, and the stored snapshot stays.

#### (b) Cancellation webhook before the creation webhook

Starting state: Open Space is an `instant` listing. A guest books 2026-11-26 at 15:00:40Z, and reservation `res_01JDT0A1B2C3D4E5F6G7H8J9K0` gets `reservationSequence: 57`. The first `reservation.created` delivery times out in transit. The guest cancels at 15:02:10Z. The cancellation is delivered first.

<!-- validate: ReservationCancelledEvent -->
```http
POST /api/integrations/one-coworking/webhook HTTP/1.1
Host: workspace.deskohub.cz
Content-Type: application/json
webhook-id: evt_01JDT0B7C8D9E0F1G2H3J4K5M6
webhook-timestamp: 1795532531
webhook-signature: v1,VLe4Idrdo//M2qTAQxoY53FbyTronotPxB5ID4o6YrY=

{
  "eventId": "evt_01JDT0B7C8D9E0F1G2H3J4K5M6",
  "type": "reservation.cancelled",
  "occurredAt": "2026-11-24T15:02:11Z",
  "livemode": true,
  "data": {
    "reservation": {
      "id": "res_01JDT0A1B2C3D4E5F6G7H8J9K0",
      "venueId": "ven_deskohub_prague",
      "listingId": "lst_deskohub_openspace",
      "externalListingId": "cowork:open-space",
      "externalReservationId": null,
      "reservationSequence": 57,
      "version": 2,
      "livemode": true,
      "status": "cancelled_by_guest",
      "paymentStatus": "refund_pending",
      "confirmationMode": "instant",
      "confirmBy": null,
      "inventoryModel": "pooled",
      "inventoryGranularity": "date",
      "bookingOptionId": "open-space-day",
      "timezone": "Europe/Prague",
      "serviceDates": ["2026-11-26"],
      "inventoryDates": ["2026-11-26"],
      "bookedInterval": { "startsAt": "2026-11-26T00:00:00+01:00", "endsAt": "2026-11-26T17:00:00+01:00" },
      "setupMinutes": 0,
      "occupiedInterval": { "startsAt": "2026-11-26T00:00:00+01:00", "endsAt": "2026-11-26T17:00:00+01:00" },
      "seats": 1,
      "inventoryUnits": 1,
      "addons": [],
      "guest": {
        "firstName": "Petr",
        "lastName": "Svoboda",
        "email": "petr.svoboda@example.invalid",
        "phone": null,
        "companyName": null,
        "locale": "en-GB"
      },
      "pricing": {
        "grossAmount": { "amountMinor": 29000, "currency": "CZK", "taxIncluded": true },
        "commissionAmount": { "amountMinor": 4350, "currency": "CZK", "taxIncluded": true },
        "netPayoutAmount": { "amountMinor": 24650, "currency": "CZK", "taxIncluded": true }
      },
      "access": null,
      "cancellation": {
        "initiatedBy": "guest",
        "reason": "guest_request",
        "note": null,
        "cancelledAt": "2026-11-24T15:02:10Z"
      },
      "createdAt": "2026-11-24T15:00:40Z",
      "updatedAt": "2026-11-24T15:02:10Z"
    }
  }
}
```

At 16:40:00Z a retry delivers the creation event, version 1.

<!-- validate: ReservationCreatedEvent -->
```json
{
  "eventId": "evt_01JDT0A2B3C4D5E6F7G8H9J0K1",
  "type": "reservation.created",
  "occurredAt": "2026-11-24T15:00:41Z",
  "livemode": true,
  "data": {
    "reservation": {
      "id": "res_01JDT0A1B2C3D4E5F6G7H8J9K0",
      "venueId": "ven_deskohub_prague",
      "listingId": "lst_deskohub_openspace",
      "externalListingId": "cowork:open-space",
      "externalReservationId": null,
      "reservationSequence": 57,
      "version": 1,
      "livemode": true,
      "status": "confirmed",
      "paymentStatus": "captured",
      "confirmationMode": "instant",
      "confirmBy": null,
      "inventoryModel": "pooled",
      "inventoryGranularity": "date",
      "bookingOptionId": "open-space-day",
      "timezone": "Europe/Prague",
      "serviceDates": ["2026-11-26"],
      "inventoryDates": ["2026-11-26"],
      "bookedInterval": { "startsAt": "2026-11-26T00:00:00+01:00", "endsAt": "2026-11-26T17:00:00+01:00" },
      "setupMinutes": 0,
      "occupiedInterval": { "startsAt": "2026-11-26T00:00:00+01:00", "endsAt": "2026-11-26T17:00:00+01:00" },
      "seats": 1,
      "inventoryUnits": 1,
      "addons": [],
      "guest": {
        "firstName": "Petr",
        "lastName": "Svoboda",
        "email": "petr.svoboda@example.invalid",
        "phone": null,
        "companyName": null,
        "locale": "en-GB"
      },
      "pricing": {
        "grossAmount": { "amountMinor": 29000, "currency": "CZK", "taxIncluded": true },
        "commissionAmount": { "amountMinor": 4350, "currency": "CZK", "taxIncluded": true },
        "netPayoutAmount": { "amountMinor": 24650, "currency": "CZK", "taxIncluded": true }
      },
      "access": null,
      "cancellation": null,
      "createdAt": "2026-11-24T15:00:40Z",
      "updatedAt": "2026-11-24T15:00:40Z"
    }
  }
}
```

Expected outcomes:
- On the cancellation, the operator stores the event, responds with `2xx`, and records reservation 57 as terminal at version 2. Because it holds nothing locally, it releases nothing and issues no access. Sequence 57 counts as processed for `reservationsThrough`.
- On the delayed creation event, version 1 is below the stored version 2. The operator responds with `2xx` and ignores it. No seat is held, no PIN is issued, and no guest notice is sent.
- An operator that omitted the version check would still remain safe, because the mandatory `GET` prior to lock-credential issuance returns `cancelled_by_guest`.
- If the cancellation had failed for 24 hours, the next reconciliation scan would retrieve reservation 57 at version 2 through `GET /v1/reservations?updatedSince=`.

#### (c) Payment capture times out during `/confirm`

Starting state: reservation `res_01JDS4P0Q1R2S3T4U5V6W7X8Y9`, Reserved Desk for 2026-11-26, `reservationSequence: 44`, `pending_confirmation` with `confirmBy` at 11:21:30Z. The operator holds a desk locally and calls `/confirm` at 11:20:50Z with `If-Match: "v1"`. The payment provider does not respond to the capture request in time. One Coworking returns version 2.

<!-- validate: Reservation -->
```json
{
  "id": "res_01JDS4P0Q1R2S3T4U5V6W7X8Y9",
  "venueId": "ven_deskohub_prague",
  "listingId": "lst_deskohub_reserved_desk",
  "externalListingId": "cowork:reserved-desk",
  "externalReservationId": "dh_ord_987700",
  "reservationSequence": 44,
  "version": 2,
  "livemode": true,
  "status": "capture_pending",
  "paymentStatus": "capture_pending",
  "confirmationMode": "webhook_confirm",
  "confirmBy": "2026-11-24T11:21:30Z",
  "inventoryModel": "pooled",
  "inventoryGranularity": "date",
  "bookingOptionId": "desk-day",
  "timezone": "Europe/Prague",
  "serviceDates": ["2026-11-26"],
  "inventoryDates": ["2026-11-26"],
  "bookedInterval": { "startsAt": "2026-11-26T00:00:00+01:00", "endsAt": "2026-11-27T00:00:00+01:00" },
  "setupMinutes": 0,
  "occupiedInterval": { "startsAt": "2026-11-26T00:00:00+01:00", "endsAt": "2026-11-27T00:00:00+01:00" },
  "seats": 1,
  "inventoryUnits": 1,
  "addons": [],
  "guest": {
    "firstName": "Eva",
    "lastName": "Dvorakova",
    "email": "eva.dvorakova@example.invalid",
    "phone": null,
    "companyName": null,
    "locale": "cs-CZ"
  },
  "pricing": {
    "grossAmount": { "amountMinor": 41000, "currency": "CZK", "taxIncluded": true },
    "commissionAmount": { "amountMinor": 6150, "currency": "CZK", "taxIncluded": true },
    "netPayoutAmount": { "amountMinor": 34850, "currency": "CZK", "taxIncluded": true }
  },
  "access": {
    "type": "url",
    "accessUrl": "https://workspace.deskohub.cz/cs/reservation/access/dh_ord_987700?token=signed_capability_token",
    "validFrom": "2026-11-26T00:00:00+01:00",
    "validUntil": "2026-11-27T00:00:00+01:00",
    "instructions": null
  },
  "cancellation": null,
  "createdAt": "2026-11-24T11:20:30Z",
  "updatedAt": "2026-11-24T11:20:58Z"
}
```

At 11:22:00Z the provider reports the capture as refused, and One Coworking sends version 3.

<!-- validate: ReservationPaymentFailedEvent -->
```http
POST /api/integrations/one-coworking/webhook HTTP/1.1
Host: workspace.deskohub.cz
Content-Type: application/json
webhook-id: evt_01JDS4R2S3T4U5V6W7X8Y9Z0A1
webhook-timestamp: 1795519320
webhook-signature: v1,sW7q8+pHpr8anIcSCrPQe9PJM0BEPJTH//JoWdtcdyU=

{
  "eventId": "evt_01JDS4R2S3T4U5V6W7X8Y9Z0A1",
  "type": "reservation.payment_failed",
  "occurredAt": "2026-11-24T11:22:00Z",
  "livemode": true,
  "data": {
    "reservation": {
      "id": "res_01JDS4P0Q1R2S3T4U5V6W7X8Y9",
      "venueId": "ven_deskohub_prague",
      "listingId": "lst_deskohub_reserved_desk",
      "externalListingId": "cowork:reserved-desk",
      "externalReservationId": "dh_ord_987700",
      "reservationSequence": 44,
      "version": 3,
      "livemode": true,
      "status": "payment_failed",
      "paymentStatus": "failed",
      "confirmationMode": "webhook_confirm",
      "confirmBy": "2026-11-24T11:21:30Z",
      "inventoryModel": "pooled",
      "inventoryGranularity": "date",
      "bookingOptionId": "desk-day",
      "timezone": "Europe/Prague",
      "serviceDates": ["2026-11-26"],
      "inventoryDates": ["2026-11-26"],
      "bookedInterval": { "startsAt": "2026-11-26T00:00:00+01:00", "endsAt": "2026-11-27T00:00:00+01:00" },
      "setupMinutes": 0,
      "occupiedInterval": { "startsAt": "2026-11-26T00:00:00+01:00", "endsAt": "2026-11-27T00:00:00+01:00" },
      "seats": 1,
      "inventoryUnits": 1,
      "addons": [],
      "guest": {
        "firstName": "Eva",
        "lastName": "Dvorakova",
        "email": "eva.dvorakova@example.invalid",
        "phone": null,
        "companyName": null,
        "locale": "cs-CZ"
      },
      "pricing": {
        "grossAmount": { "amountMinor": 41000, "currency": "CZK", "taxIncluded": true },
        "commissionAmount": { "amountMinor": 6150, "currency": "CZK", "taxIncluded": true },
        "netPayoutAmount": { "amountMinor": 34850, "currency": "CZK", "taxIncluded": true }
      },
      "access": null,
      "cancellation": null,
      "createdAt": "2026-11-24T11:20:30Z",
      "updatedAt": "2026-11-24T11:22:00Z"
    }
  }
}
```

Expected outcomes:
- Upon receiving `capture_pending`, the operator retains its local hold, issues no PIN, and sends no guest notification. The elapsing `confirmBy` deadline does not expire the reservation.
- The operator never calls `/confirm` again to retry the capture. Calling it again with `If-Match: "v1"` returns `412` `precondition_failed` with the current reservation at version 2. Calling it without `If-Match` returns `200` with the current reservation. Neither starts a second capture.
- On `reservation.payment_failed`, the operator releases its local desk, withdraws the prepared access page, and pushes a calendar update with `reservationsThrough` at 44 or above. One Coworking dropped `access` from the reservation, and its hold has ended.
- Had the capture succeeded, `reservation.confirmed` at version 3 would have carried `status: "confirmed"` and `paymentStatus: "captured"`. Only then may the operator read the reservation with `GET` and issue the PIN.
- If the `/confirm` call itself had timed out, the operator would send it again with `If-Match: "v1"` or read the reservation with `GET`, and keep its hold until a terminal status appeared. A `412` on that retry carries the reservation at version 2 in `capture_pending`.

#### (d) Private office for four people

Starting state: `lst_deskohub_private_office` is `exclusive` with `inventoryGranularity: "date"`, `maxSeats: 6`, and an `office-range` option at 900 CZK per date plus 250 CZK per seat per date. Every date has `availableUnits: 1`.

<!-- validate: ReservationCreatedEvent -->
```json
{
  "eventId": "evt_01JDV2C3D4E5F6G7H8J9K0M1N2",
  "type": "reservation.created",
  "occurredAt": "2026-11-24T09:30:12Z",
  "livemode": true,
  "data": {
    "reservation": {
      "id": "res_01JDV2B1C2D3E4F5G6H7J8K9M0",
      "venueId": "ven_deskohub_prague",
      "listingId": "lst_deskohub_private_office",
      "externalListingId": "office:main",
      "externalReservationId": null,
      "reservationSequence": 39,
      "version": 1,
      "livemode": true,
      "status": "pending_confirmation",
      "paymentStatus": "authorized",
      "confirmationMode": "webhook_confirm",
      "confirmBy": "2026-11-24T09:31:12Z",
      "inventoryModel": "exclusive",
      "inventoryGranularity": "date",
      "bookingOptionId": "office-range",
      "timezone": "Europe/Prague",
      "serviceDates": ["2026-11-25", "2026-11-26", "2026-11-27"],
      "inventoryDates": ["2026-11-25", "2026-11-26", "2026-11-27"],
      "bookedInterval": { "startsAt": "2026-11-25T00:00:00+01:00", "endsAt": "2026-11-28T00:00:00+01:00" },
      "setupMinutes": 0,
      "occupiedInterval": { "startsAt": "2026-11-25T00:00:00+01:00", "endsAt": "2026-11-28T00:00:00+01:00" },
      "seats": 4,
      "inventoryUnits": 1,
      "addons": [],
      "guest": {
        "firstName": "Tomas",
        "lastName": "Kral",
        "email": "tomas.kral@example.invalid",
        "phone": "+420987654321",
        "companyName": "Example Studio s.r.o.",
        "locale": "cs-CZ"
      },
      "pricing": {
        "grossAmount": { "amountMinor": 570000, "currency": "CZK", "taxIncluded": true },
        "commissionAmount": { "amountMinor": 85500, "currency": "CZK", "taxIncluded": true },
        "netPayoutAmount": { "amountMinor": 484500, "currency": "CZK", "taxIncluded": true }
      },
      "access": null,
      "cancellation": null,
      "createdAt": "2026-11-24T09:30:11Z",
      "updatedAt": "2026-11-24T09:30:11Z"
    }
  }
}
```

Expected outcomes:
- One Coworking holds 1 unit on each of 2026-11-25, 26, and 27. Effective availability becomes 0 on all three dates, not -3.
- The price is 3 service dates times (900 + 4 x 250) CZK, which is 5,700 CZK.
- A request for 7 seats is refused at checkout, because `maxSeats` is 6.
- The operator confirms with one access credential valid from 2026-11-25T00:00+01:00 to 2026-11-28T00:00+01:00, then pushes `status: "sold_out"` with `availableUnits: 0` for the three dates and `reservationsThrough` at 39 or above.

#### (e) Meeting-room early setup crossing midnight

Starting state: `lst_deskohub_meeting_room` from example B. A guest books one hour from 2026-11-25 00:00 local with 15 minutes of setup. The reservation gets `reservationSequence: 47`.

<!-- validate: ReservationCreatedEvent -->
```json
{
  "eventId": "evt_01JDW3D4E5F6G7H8J9K0M1N2P3",
  "type": "reservation.created",
  "occurredAt": "2026-11-24T16:41:30Z",
  "livemode": true,
  "data": {
    "reservation": {
      "id": "res_01JDW3C2D3E4F5G6H7J8K9M0N1",
      "venueId": "ven_deskohub_prague",
      "listingId": "lst_deskohub_meeting_room",
      "externalListingId": "meeting-room:main",
      "externalReservationId": null,
      "reservationSequence": 47,
      "version": 1,
      "livemode": true,
      "status": "pending_confirmation",
      "paymentStatus": "authorized",
      "confirmationMode": "webhook_confirm",
      "confirmBy": "2026-11-24T16:42:30Z",
      "inventoryModel": "exclusive",
      "inventoryGranularity": "interval",
      "bookingOptionId": "room-1h",
      "timezone": "Europe/Prague",
      "serviceDates": ["2026-11-25"],
      "inventoryDates": ["2026-11-24", "2026-11-25"],
      "bookedInterval": { "startsAt": "2026-11-25T00:00:00+01:00", "endsAt": "2026-11-25T01:00:00+01:00" },
      "setupMinutes": 15,
      "occupiedInterval": { "startsAt": "2026-11-24T23:45:00+01:00", "endsAt": "2026-11-25T01:00:00+01:00" },
      "seats": 3,
      "inventoryUnits": 1,
      "addons": [],
      "guest": {
        "firstName": "Lucie",
        "lastName": "Horakova",
        "email": "lucie.horakova@example.invalid",
        "phone": null,
        "companyName": null,
        "locale": "en-GB"
      },
      "pricing": {
        "grossAmount": { "amountMinor": 35000, "currency": "CZK", "taxIncluded": true },
        "commissionAmount": { "amountMinor": 5250, "currency": "CZK", "taxIncluded": true },
        "netPayoutAmount": { "amountMinor": 29750, "currency": "CZK", "taxIncluded": true }
      },
      "access": null,
      "cancellation": null,
      "createdAt": "2026-11-24T16:41:29Z",
      "updatedAt": "2026-11-24T16:41:29Z"
    }
  }
}
```

After confirming, the operator pushes one entry for both dates. The interval crosses midnight, and the entry replaces all operator-blocked time on 2026-11-24 and 2026-11-25.

<!-- validate: UpsertCalendarRequest -->
```json
{
  "sequence": 9230,
  "reservationsThrough": 47,
  "entries": [
    {
      "from": "2026-11-24",
      "to": "2026-11-25",
      "status": "open",
      "availableUnits": 1,
      "blockedIntervals": [
        { "startsAt": "2026-11-24T23:45:00+01:00", "endsAt": "2026-11-25T01:00:00+01:00" },
        { "startsAt": "2026-11-25T09:00:00+01:00", "endsAt": "2026-11-25T11:00:00+01:00" }
      ]
    }
  ]
}
```

Expected outcomes:
- The hold blocks 23:45 to 24:00 on 2026-11-24 and 00:00 to 01:00 on 2026-11-25. Both dates stay `open` for other times.
- A booking from 22:30 to 23:30 on 2026-11-24 is allowed. A booking from 23:00 to 24:00 on 2026-11-24 is refused, because it overlaps the setup.
- A second guest can book 01:00 to 02:00 on 2026-11-25 without setup. The same booking with 15 minutes of setup is refused, because 00:45 to 01:00 belongs to the first booking.
- The price, discounts, and cancellation cutoff use the booked hour on 2026-11-25. The access credential runs from 2026-11-24T23:45:00+01:00 to 2026-11-25T01:00:00+01:00.

#### (f) Instant booking gets its access link

Starting state: Open Space is an `instant` listing. A guest books 2026-11-27 at 13:05:00Z. Reservation `res_01JDX5E6F7G8H9J0K1M2N3P4Q5` arrives in `reservation.created` at version 1 with `status: "confirmed"`, `paymentStatus: "captured"`, `externalReservationId: null`, and `access: null`. The operator reads it with `GET`, books the seat locally, prepares its access page, and attaches both.

<!-- validate: ConfirmReservationRequest -->
```http
POST /partner/v1/reservations/res_01JDX5E6F7G8H9J0K1M2N3P4Q5/confirm HTTP/1.1
Host: api.onecoworking.com
Authorization: Bearer oc_live_example_token
Content-Type: application/json
If-Match: "v1"

{
  "externalReservationId": "dh_ord_987811",
  "access": {
    "type": "url",
    "accessUrl": "https://workspace.deskohub.cz/en/reservation/access/dh_ord_987811?token=signed_capability_token",
    "validFrom": "2026-11-27T00:00:00+01:00",
    "validUntil": "2026-11-27T17:00:00+01:00",
    "instructions": "Open the access link to view your door PIN. Open Space access is valid until 17:00."
  }
}
```

One Coworking stores both fields without altering payment state and responds with version 2.

<!-- validate: Reservation -->
```json
{
  "id": "res_01JDX5E6F7G8H9J0K1M2N3P4Q5",
  "venueId": "ven_deskohub_prague",
  "listingId": "lst_deskohub_openspace",
  "externalListingId": "cowork:open-space",
  "externalReservationId": "dh_ord_987811",
  "reservationSequence": 61,
  "version": 2,
  "livemode": true,
  "status": "confirmed",
  "paymentStatus": "captured",
  "confirmationMode": "instant",
  "confirmBy": null,
  "inventoryModel": "pooled",
  "inventoryGranularity": "date",
  "bookingOptionId": "open-space-day",
  "timezone": "Europe/Prague",
  "serviceDates": ["2026-11-27"],
  "inventoryDates": ["2026-11-27"],
  "bookedInterval": { "startsAt": "2026-11-27T00:00:00+01:00", "endsAt": "2026-11-27T17:00:00+01:00" },
  "setupMinutes": 0,
  "occupiedInterval": { "startsAt": "2026-11-27T00:00:00+01:00", "endsAt": "2026-11-27T17:00:00+01:00" },
  "seats": 1,
  "inventoryUnits": 1,
  "addons": [],
  "guest": {
    "firstName": "Martin",
    "lastName": "Benes",
    "email": "martin.benes@example.invalid",
    "phone": null,
    "companyName": null,
    "locale": "en-GB"
  },
  "pricing": {
    "grossAmount": { "amountMinor": 29000, "currency": "CZK", "taxIncluded": true },
    "commissionAmount": { "amountMinor": 4350, "currency": "CZK", "taxIncluded": true },
    "netPayoutAmount": { "amountMinor": 24650, "currency": "CZK", "taxIncluded": true }
  },
  "access": {
    "type": "url",
    "accessUrl": "https://workspace.deskohub.cz/en/reservation/access/dh_ord_987811?token=signed_capability_token",
    "validFrom": "2026-11-27T00:00:00+01:00",
    "validUntil": "2026-11-27T17:00:00+01:00",
    "instructions": "Open the access link to view your door PIN. Open Space access is valid until 17:00."
  },
  "cancellation": null,
  "createdAt": "2026-11-24T13:05:00Z",
  "updatedAt": "2026-11-24T13:05:04Z"
}
```

Expected outcomes:
- One Coworking adds the access link to the guest's pass and sends it to the guest. It captures nothing, because the payment was captured at checkout.
- It emits `reservation.confirmed` at version 2. The operator already applied version 2 from the response, so it acknowledges and ignores the event.
- The operator issues the door PIN after a `GET` that still returns `confirmed`.
- Retrying this request after a lost response returns `412` `precondition_failed` with the current reservation at version 2. Its `status` and `externalReservationId` `dh_ord_987811` show that the confirmation was accepted. A retry without `If-Match` and with the same `externalReservationId` returns `200` with the current reservation and sends nothing again. A different `externalReservationId` gets `409` `invalid_state_transition` once both preconditions pass. With the stale tag, the `412` comes first, because the sent ID is compared with the stored one only after the preconditions.

#### (g) Both preconditions on one request

Starting state: reservation `res_01JDR7X8W1A2B3C4D5E6F7G8H9` from example D is at version 2. The operator's client sends a stale `If-Match` together with a current `If-None-Match`.

```http
GET /partner/v1/reservations/res_01JDR7X8W1A2B3C4D5E6F7G8H9 HTTP/1.1
Host: api.onecoworking.com
Authorization: Bearer oc_live_example_token
If-Match: "v1"
If-None-Match: "v2"
```

```http
HTTP/1.1 412 Precondition Failed
Content-Type: application/problem+json
ETag: "v2"
Cache-Control: private, no-cache
```

The problem body has `type` `https://api.onecoworking.com/problems/precondition_failed`, `title` `Precondition failed`, `status` `412`, and the current reservation at version 2 in `reservation`.

Expected outcomes:
- One Coworking evaluates `If-Match` first, as RFC 9110 Section 13.2.2 requires. `"v1"` fails strong comparison against `"v2"`, so the response is `412` and `If-None-Match` is never evaluated. The response is not `304`.
- The same request without `If-Match` returns `304 Not Modified` with no body:

```http
HTTP/1.1 304 Not Modified
Date: Tue, 24 Nov 2026 11:20:00 GMT
ETag: "v2"
Cache-Control: private, no-cache
```

- A reservation response carries a strong tag, so One Coworking never compresses it, and neither the `200` nor the `304` carries `Vary`. A `304` for a collection or calendar read repeats `Vary: Accept-Encoding`, whether or not the `200` would have been compressed.

The listing `lst_deskohub_meeting_room` from example B exists with tag `"l-4b7e1d90"`. An operator sends a merge patch with `If-None-Match: *`, a precondition meant only for creating a resource.

<!-- validate: UpdateListingRequest -->
```http
PATCH /partner/v1/listings/lst_deskohub_meeting_room HTTP/1.1
Host: api.onecoworking.com
Authorization: Bearer oc_live_example_token
Content-Type: application/merge-patch+json
If-None-Match: *

{
  "externalId": null,
  "minLeadTimeMinutes": 30
}
```

Expected outcomes:
- The listing has a current representation, so `If-None-Match: *` fails. The response is `412` `precondition_failed` with `ETag: "l-4b7e1d90"` and the current listing in `listing`. Nothing is written, and `externalId` stays `meeting-room:main`.
- Without `If-None-Match`, the patch applies:

<!-- validate: UpdateListingRequest -->
```http
PATCH /partner/v1/listings/lst_deskohub_meeting_room HTTP/1.1
Host: api.onecoworking.com
Authorization: Bearer oc_live_example_token
Content-Type: application/merge-patch+json
If-Match: "l-4b7e1d90"

{
  "externalId": null,
  "minLeadTimeMinutes": 30
}
```

<!-- validate: Listing -->
```http
HTTP/1.1 200 OK
Content-Type: application/json
ETag: "l-7f3a9c02"

{
  "id": "lst_deskohub_meeting_room",
  "venueId": "ven_deskohub_prague",
  "name": "Meeting room",
  "inventoryModel": "exclusive",
  "inventoryGranularity": "interval",
  "maxSeats": 8,
  "defaultCapacity": 1,
  "bookingOptions": [
    {
      "optionId": "room-1h",
      "kind": "fixed_duration",
      "name": "1 hour",
      "durationMinutes": 60,
      "price": { "amountMinor": 35000, "currency": "CZK", "taxIncluded": true },
      "pricePerSeat": null,
      "setupMinutesAllowed": [0, 15]
    },
    {
      "optionId": "room-4h",
      "kind": "fixed_duration",
      "name": "4 hours",
      "durationMinutes": 240,
      "price": { "amountMinor": 120000, "currency": "CZK", "taxIncluded": true },
      "pricePerSeat": null,
      "setupMinutesAllowed": [0, 15]
    },
    {
      "optionId": "room-day",
      "kind": "calendar_day",
      "name": "Whole day",
      "localStart": "00:00",
      "localEnd": "24:00",
      "price": { "amountMinor": 250000, "currency": "CZK", "taxIncluded": true },
      "pricePerSeat": null,
      "setupMinutesAllowed": [0, 15]
    }
  ],
  "confirmationMode": "webhook_confirm",
  "confirmationTimeoutSeconds": 60,
  "status": "active",
  "timezone": "Europe/Prague",
  "minLeadTimeMinutes": 30,
  "maxBookingHorizonDays": 90,
  "updatedAt": "2026-11-24T11:25:00Z"
}
```

- The `200` response carries the listing with `minLeadTimeMinutes: 30` and a new strong `ETag`. The patch set `externalId` to `null`, so RFC 7396 Section 2 removes the member, and the resulting listing has no `externalId` member at all, rather than `"externalId": null`.
- The same body sent with `Content-Type: application/json` returns `415` `unsupported_media_type` with `Accept-Patch: application/merge-patch+json`.
- A patch with `"status": null` returns `422` `validation_error` with one item, `pointer` `/status` and `reason` `type`, because `status` cannot be null.

#### (h) First access credential with `PUT /access`

Starting state: reservation `res_01JDY6F7G8H9J0K1M2N3P4Q5R6` for a Reserved Desk on 2026-11-28 is `confirmed` at version 2. Its `/confirm` carried no `access`, so `access` is `null` and `/access` has no current representation.

1. The operator first sends the credential with `If-Match: "v2"`.

<!-- validate: AccessCredential -->
```http
PUT /partner/v1/reservations/res_01JDY6F7G8H9J0K1M2N3P4Q5R6/access?notifyGuest=true HTTP/1.1
Host: api.onecoworking.com
Authorization: Bearer oc_live_example_token
Content-Type: application/json
If-Match: "v2"

{
  "type": "url",
  "accessUrl": "https://workspace.deskohub.cz/en/reservation/access/dh_ord_987900?token=signed_capability_token",
  "validFrom": "2026-11-28T00:00:00+01:00",
  "validUntil": "2026-11-29T00:00:00+01:00",
  "instructions": null
}
```

```http
HTTP/1.1 412 Precondition Failed
Content-Type: application/problem+json
```

`If-Match` names a representation of `/access`, and none exists, so the request fails. The `412` carries no `ETag`, and its `reservation` member shows `access: null` at version 2. Nothing is stored. `If-Match: *` fails the same way, because `*` matches only a current representation.

2. The operator sends the same body with `If-None-Match: *` in place of `If-Match`.

<!-- validate: AccessCredential -->
```http
PUT /partner/v1/reservations/res_01JDY6F7G8H9J0K1M2N3P4Q5R6/access?notifyGuest=true HTTP/1.1
Host: api.onecoworking.com
Authorization: Bearer oc_live_example_token
Content-Type: application/json
If-None-Match: *

{
  "type": "url",
  "accessUrl": "https://workspace.deskohub.cz/en/reservation/access/dh_ord_987900?token=signed_capability_token",
  "validFrom": "2026-11-28T00:00:00+01:00",
  "validUntil": "2026-11-29T00:00:00+01:00",
  "instructions": null
}
```

```http
HTTP/1.1 201 Created
Content-Type: application/json
Content-Location: /partner/v1/reservations/res_01JDY6F7G8H9J0K1M2N3P4Q5R6
```

The body is the reservation at version 3 with the credential in `access`. The response carries no `ETag`, and the operator records version 3 from the body. The guest receives the access link.

3. Later the operator replaces the credential to add instructions, with `If-Match: "v3"`.

<!-- validate: AccessCredential -->
```http
PUT /partner/v1/reservations/res_01JDY6F7G8H9J0K1M2N3P4Q5R6/access?notifyGuest=true HTTP/1.1
Host: api.onecoworking.com
Authorization: Bearer oc_live_example_token
Content-Type: application/json
If-Match: "v3"

{
  "type": "url",
  "accessUrl": "https://workspace.deskohub.cz/en/reservation/access/dh_ord_987900?token=signed_capability_token",
  "validFrom": "2026-11-28T00:00:00+01:00",
  "validUntil": "2026-11-29T00:00:00+01:00",
  "instructions": "Open the access link to view your door PIN."
}
```

One Coworking returns `200` with the reservation at version 4 and no `ETag`, and notifies the guest.

4. After a lost response, the operator retries step 3 with `If-Match: "v4"`, taken from a `GET`. Its serializer emits the members in a different order.

<!-- validate: AccessCredential -->
```http
PUT /partner/v1/reservations/res_01JDY6F7G8H9J0K1M2N3P4Q5R6/access?notifyGuest=true HTTP/1.1
Host: api.onecoworking.com
Authorization: Bearer oc_live_example_token
Content-Type: application/json
If-Match: "v4"

{
  "instructions": "Open the access link to view your door PIN.",
  "validUntil": "2026-11-29T00:00:00+01:00",
  "validFrom": "2026-11-28T00:00:00+01:00",
  "accessUrl": "https://workspace.deskohub.cz/en/reservation/access/dh_ord_987900?token=signed_capability_token",
  "type": "url"
}
```

Expected outcomes:
- Step 4 is semantically equal to the stored credential under RFC 8259 Section 4, because member order does not matter. One Coworking returns `200` with the reservation still at version 4 and no `ETag`. It sends no guest notification, even with `notifyGuest=true`, and emits no event.
- A retry of step 2 after its response was lost finds the stored credential. `If-None-Match: *` fails, and the retry returns `412` `precondition_failed` with `ETag: "v3"` or later and the current reservation. The guest is not notified twice.
- A retry of step 3 with its original `If-Match: "v3"` returns `412` with `ETag: "v4"`, and the operator inspects `access` in the returned reservation.

#### (i) Atomic calendar batch with a reused sequence

Starting state: listing `lst_deskohub_reserved_desk` has stored snapshots at `sequence: 6100` and `reservationsThrough: 45` for 2026-11-30 (`open`, 3 units) and 2026-12-01 (`open`, 4 units). 2026-12-02 has no snapshot. No hold has a `reservationSequence` above 45.

A faulty operator job reuses sequence 6100 with a new count for 2026-12-01.

<!-- validate: UpsertCalendarRequest -->
```http
PATCH /partner/v1/listings/lst_deskohub_reserved_desk/calendar HTTP/1.1
Host: api.onecoworking.com
Authorization: Bearer oc_live_example_token
Content-Type: application/json

{
  "sequence": 6100,
  "reservationsThrough": 45,
  "entries": [
    { "from": "2026-11-30", "to": "2026-11-30", "status": "open", "availableUnits": 3 },
    { "from": "2026-12-01", "to": "2026-12-01", "status": "open", "availableUnits": 2 },
    { "from": "2026-12-02", "to": "2026-12-02", "status": "open", "availableUnits": 6 }
  ]
}
```

One Coworking returns `409 Conflict` with this problem body.

<!-- validate: ProblemDetails -->
```json
{
  "type": "https://api.onecoworking.com/problems/sequence_reused",
  "title": "Calendar sequence reused",
  "status": 409,
  "detail": "Sequence 6100 is already stored for 2026-12-01 with different content. No date in this request was applied.",
  "conflictingDates": [
    { "date": "2026-12-01", "sequence": 6100 }
  ]
}
```

Expected outcomes:
- Zero dates apply. 2026-12-01 keeps 4 units, and 2026-12-02 still has no snapshot and uses `defaultCapacity`, although on its own it would have been `applied`.
- The operator pushes the corrected counts again with a higher `sequence`, such as 6101, and every date then reports `applied`.

A delayed batch from an earlier run of the job arrives with a lower sequence.

<!-- validate: UpsertCalendarRequest -->
```http
PATCH /partner/v1/listings/lst_deskohub_reserved_desk/calendar HTTP/1.1
Host: api.onecoworking.com
Authorization: Bearer oc_live_example_token
Content-Type: application/json

{
  "sequence": 6050,
  "reservationsThrough": 45,
  "entries": [
    { "from": "2026-11-30", "to": "2026-11-30", "status": "open", "availableUnits": 5 },
    { "from": "2026-12-02", "to": "2026-12-02", "status": "open", "availableUnits": 6 }
  ]
}
```

No date reuses a stored sequence, so the batch succeeds with `200`.

<!-- validate: UpsertCalendarResponse -->
```json
{
  "listingId": "lst_deskohub_reserved_desk",
  "results": [
    {
      "date": "2026-11-30",
      "outcome": "skipped_older_sequence",
      "storedSequence": 6100,
      "storedReservationsThrough": 45,
      "status": "open",
      "availableUnits": 3,
      "blockedIntervals": null,
      "effectiveStatus": "open",
      "effectiveAvailableUnits": 3,
      "effectiveBlockedIntervals": null,
      "subtractedHolds": []
    },
    {
      "date": "2026-12-02",
      "outcome": "applied",
      "storedSequence": 6050,
      "storedReservationsThrough": 45,
      "status": "open",
      "availableUnits": 6,
      "blockedIntervals": null,
      "effectiveStatus": "open",
      "effectiveAvailableUnits": 6,
      "effectiveBlockedIntervals": null,
      "subtractedHolds": []
    }
  ]
}
```

Expected outcomes:
- 2026-11-30 keeps its newer snapshot at sequence 6100. 2026-12-02 had no snapshot, so any sequence applies there.
- A lower sequence never fails the batch. Only an equal sequence with different content does.

#### (j) Authentication and authorization failures

A request without credentials:

```http
GET /partner/v1/reservations/res_01JDR7X8W1A2B3C4D5E6F7G8H9 HTTP/1.1
Host: api.onecoworking.com
```

<!-- validate: ProblemDetails -->
```http
HTTP/1.1 401 Unauthorized
Content-Type: application/problem+json
WWW-Authenticate: Bearer realm="onecoworking"
Cache-Control: private, no-cache

{
  "type": "https://api.onecoworking.com/problems/unauthorized",
  "title": "Unauthorized",
  "status": 401,
  "detail": "The request carries no Bearer token."
}
```

The same request with a revoked token, `Authorization: Bearer oc_live_revoked_token`, returns `401` `unauthorized` with `WWW-Authenticate: Bearer realm="onecoworking", error="invalid_token"`.

A calendar push, with the body from example A, sent with a token that holds only `listings:read`:

```http
PATCH /partner/v1/listings/lst_deskohub_openspace/calendar HTTP/1.1
Host: api.onecoworking.com
Authorization: Bearer oc_live_readonly_token
Content-Type: application/json
```

<!-- validate: ProblemDetails -->
```http
HTTP/1.1 403 Forbidden
Content-Type: application/problem+json
WWW-Authenticate: Bearer realm="onecoworking", error="insufficient_scope", scope="calendar:write"

{
  "type": "https://api.onecoworking.com/problems/insufficient_scope",
  "title": "Insufficient scope",
  "status": 403,
  "detail": "This operation requires the calendar:write scope.",
  "requiredScope": "calendar:write"
}
```

A read of a reservation that belongs to another operator account, sent with a valid token that holds `reservations:read`:

```http
GET /partner/v1/reservations/res_01JDZ7G8H9J0K1M2N3P4Q5R6S7 HTTP/1.1
Host: api.onecoworking.com
Authorization: Bearer oc_live_example_token
```

<!-- validate: ProblemDetails -->
```http
HTTP/1.1 404 Not Found
Content-Type: application/problem+json
Cache-Control: private, no-cache

{
  "type": "https://api.onecoworking.com/problems/not_found",
  "title": "Not found",
  "status": 404,
  "detail": "No reservation with this ID exists in this operator account."
}
```

A read of a reservation in the token's own operator account at a venue outside the token's venue limit, sent with a token that holds `reservations:read` and is limited to one other venue:

```http
GET /partner/v1/reservations/res_01JDZ9K2M4N6P8Q0R2S4T6V8W0 HTTP/1.1
Host: api.onecoworking.com
Authorization: Bearer oc_live_venue_limited_token
```

<!-- validate: ProblemDetails -->
```http
HTTP/1.1 403 Forbidden
Content-Type: application/problem+json
Cache-Control: private, no-cache

{
  "type": "https://api.onecoworking.com/problems/forbidden",
  "title": "Forbidden",
  "status": 403,
  "detail": "This token is limited to other venues of this operator account."
}
```

Expected outcomes:
- A missing token gets a challenge with only `realm="onecoworking"`, because RFC 6750 Section 3 requires at least one auth-param and Section 3.1 says a server should not send `error` when the request carries no token. An invalid token gets `error="invalid_token"` as well. The operator obtains or refreshes a token and retries.
- `insufficient_scope` names the missing scope in both the challenge and `requiredScope`. The operator requests a token with that scope.
- The reservation of another operator account receives the same `404` `not_found` as an ID that does not exist, so the response does not reveal that the ID exists.
- `forbidden` applies only within the token's own operator account, to a venue outside the token's venue limit. It carries no challenge, because no scope grants access to that venue. The operator uses a token for that venue and does not retry with this one.
- Every one of these checks runs before validation and preconditions, so none of these requests changes anything.

---
### 7. OpenAPI 3.1.0 specification

```yaml
openapi: 3.1.0
info:
  title: One Coworking Partner API
  version: 0.2.0
  summary: Partner API for coworking operators to sync availability and reservations with One Coworking.
  description: |
    Enables space operators and property management systems to publish listing
    availability to One Coworking, receive signed reservation webhooks, and
    confirm, decline, or cancel bookings with check-in access details.

    Errors use Problem Details (RFC 9457) with media type
    `application/problem+json`. JSON Schema cannot compare two fields. The
    server enforces the cross-field rules listed in the prose specification.
    A rule on request content returns `422 validation_error` with the
    matching `errors[].reason` and a `pointer`. A rule on query parameters,
    such as a reversed or overlong calendar read range, returns
    `400 malformed_request` with the matching `errors[].reason` and a
    `parameter`.

    Every `GET` path also declares a `HEAD` operation (RFC 9110 Section
    9.3.2) with the same parameters, preconditions, status codes, and
    response headers. No `HEAD` response has content, error responses
    included. The two URIs that accept `PATCH` also declare `OPTIONS`,
    which returns `Allow` and `Accept-Patch`. `Accept-Patch` appears only
    on responses for a URI that accepts `PATCH`, so a calendar read with
    its `from` and `to` query carries none.

    `OPTIONS` and `POST /webhooks/test` neither select nor modify a target
    representation, so the server ignores `If-Match` and `If-None-Match`
    on them and never returns `412` (RFC 9110 Section 13.2.1). Every other
    operation accepts both headers.

    The server looks up every listing and reservation ID within the
    token's operator account. An ID of another operator account returns
    the same `404 not_found` as an ID that does not exist, and
    `403 forbidden` applies only to a venue outside the token's venue
    limit within its own account. Each operation names its required scope
    in its `security` requirement.

    Every operation evaluates a request in this order: `429`; `401` or
    `403 insufficient_scope`; `404`, then `403 forbidden`; `415`; `400`;
    `422`; `409` (reservation state or `confirmBy`); then `If-Match` (RFC
    9110 Section 13.1.1); then `If-None-Match` (RFC 9110 Section 13.1.2);
    then `409` for content that conflicts with stored state
    (`sequence_reused`, or a different `externalReservationId` on a
    `confirmed` reservation); then the operation itself. When
    `If-None-Match` evaluates to false, `GET` and `HEAD` return `304` and
    every other method returns `412 precondition_failed`. Invalid query,
    path, or header parameters return `400`, and `422` applies only to
    request content. One Coworking sends no `Last-Modified` and ignores
    `If-Modified-Since`, `If-Unmodified-Since`, and `If-Range`.

    Every response to an authenticated `GET` or `HEAD` carries
    `Cache-Control: private, no-cache`, error responses included. A
    response that carries a strong entity tag is never sent with a
    `Content-Encoding` and carries no `Vary`, so each version of a listing
    or reservation has exactly one strong tag. Collection and calendar
    reads carry weak entity tags, may be compressed, and carry
    `Vary: Accept-Encoding` on every `200` and `304`, uncompressed ones
    included, because the coding is negotiated (RFC 9110 Sections 8.8.1,
    8.8.3, and 12.5.5).

    A client that does not recognize a supplied problem `type` keeps the
    URI as the identifier and handles the response by its status code. It
    never replaces a supplied `type` with `about:blank`.
  contact:
    name: Deskohub integration proposal
    url: https://onecoworking.com

servers:
  - url: https://api.onecoworking.com/partner/v1
    description: Production. Every event carries livemode true.
  - url: https://sandbox-api.onecoworking.com/partner/v1
    description: Sandbox. Every event carries livemode false.

security:
  - BearerAuth: []

tags:
  - name: Listings
    description: Discover and update bookable listings.
  - name: Calendar
    description: Push and read calendar snapshots and effective availability.
  - name: Reservations
    description: Read reservations and confirm, decline, or cancel them.
  - name: Webhooks
    description: Test webhook delivery.

paths:
  /listings:
    parameters:
      - name: venueId
        in: query
        schema:
          type: string
      - name: externalId
        in: query
        schema:
          type: string
      - name: status
        in: query
        schema:
          $ref: "#/components/schemas/ListingStatus"
      - $ref: "#/components/parameters/Cursor"
      - $ref: "#/components/parameters/Limit"
      - $ref: "#/components/parameters/IfMatch"
      - $ref: "#/components/parameters/IfNoneMatch"
    get:
      operationId: listListings
      summary: List operator listings
      description: "The page carries a weak entity tag, so a specific `If-Match` tag never matches and `If-Match: *` passes. An invalid query parameter returns `400 malformed_request` with `errors[].parameter`."
      tags: [Listings]
      security:
        - BearerAuth: ["listings:read"]
      responses:
        "200":
          description: One page of listings.
          headers:
            ETag:
              $ref: "#/components/headers/WeakETag"
            Cache-Control:
              $ref: "#/components/headers/CacheControl"
            Vary:
              $ref: "#/components/headers/Vary"
            Content-Encoding:
              $ref: "#/components/headers/ContentEncoding"
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ListingPage"
        "304":
          $ref: "#/components/responses/NotModified"
        "400":
          $ref: "#/components/responses/MalformedRequest"
        "401":
          $ref: "#/components/responses/Unauthorized"
        "403":
          $ref: "#/components/responses/Forbidden"
        "412":
          $ref: "#/components/responses/PreconditionFailed"
        "429":
          $ref: "#/components/responses/RateLimited"
        "500":
          $ref: "#/components/responses/InternalError"

    head:
      operationId: headListings
      summary: Read the headers of a listing page
      description: Same parameters, preconditions, status codes, and headers as `GET` on this path, with no content on any status (RFC 9110 Section 9.3.2).
      tags: [Listings]
      security:
        - BearerAuth: ["listings:read"]
      responses:
        "200":
          description: The headers that `GET` would return, with no content.
          headers:
            ETag:
              $ref: "#/components/headers/WeakETag"
            Cache-Control:
              $ref: "#/components/headers/CacheControl"
            Vary:
              $ref: "#/components/headers/Vary"
            Content-Encoding:
              $ref: "#/components/headers/ContentEncoding"
        "304":
          $ref: "#/components/responses/NotModified"
        "400":
          $ref: "#/components/responses/HeadMalformedRequest"
        "401":
          $ref: "#/components/responses/HeadUnauthorized"
        "403":
          $ref: "#/components/responses/HeadForbidden"
        "412":
          $ref: "#/components/responses/HeadPreconditionFailed"
        "429":
          $ref: "#/components/responses/HeadRateLimited"
        "500":
          $ref: "#/components/responses/HeadInternalError"

  /listings/{listingId}:
    parameters:
      - $ref: "#/components/parameters/ListingId"
    get:
      operationId: getListing
      summary: Get one listing
      tags: [Listings]
      security:
        - BearerAuth: ["listings:read"]
      parameters:
        - $ref: "#/components/parameters/IfMatch"
        - $ref: "#/components/parameters/IfNoneMatch"
      responses:
        "200":
          description: The listing.
          headers:
            ETag:
              $ref: "#/components/headers/StrongETag"
            Cache-Control:
              $ref: "#/components/headers/CacheControl"
            Accept-Patch:
              $ref: "#/components/headers/AcceptListingPatch"
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Listing"
        "304":
          $ref: "#/components/responses/ListingNotModified"
        "400":
          $ref: "#/components/responses/MalformedRequest"
        "401":
          $ref: "#/components/responses/Unauthorized"
        "403":
          $ref: "#/components/responses/Forbidden"
        "404":
          $ref: "#/components/responses/NotFound"
        "412":
          $ref: "#/components/responses/ListingPreconditionFailed"
        "429":
          $ref: "#/components/responses/RateLimited"
        "500":
          $ref: "#/components/responses/InternalError"
    head:
      operationId: headListing
      summary: Read the headers of one listing
      description: Same parameters, preconditions, status codes, and headers as `GET` on this path, with no content on any status (RFC 9110 Section 9.3.2).
      tags: [Listings]
      security:
        - BearerAuth: ["listings:read"]
      parameters:
        - $ref: "#/components/parameters/IfMatch"
        - $ref: "#/components/parameters/IfNoneMatch"
      responses:
        "200":
          description: The headers that `GET` would return, with no content.
          headers:
            ETag:
              $ref: "#/components/headers/StrongETag"
            Cache-Control:
              $ref: "#/components/headers/CacheControl"
            Accept-Patch:
              $ref: "#/components/headers/AcceptListingPatch"
        "304":
          $ref: "#/components/responses/ListingNotModified"
        "400":
          $ref: "#/components/responses/HeadMalformedRequest"
        "401":
          $ref: "#/components/responses/HeadUnauthorized"
        "403":
          $ref: "#/components/responses/HeadForbidden"
        "404":
          $ref: "#/components/responses/HeadNotFound"
        "412":
          $ref: "#/components/responses/HeadTaggedPreconditionFailed"
        "429":
          $ref: "#/components/responses/HeadRateLimited"
        "500":
          $ref: "#/components/responses/HeadInternalError"
    options:
      operationId: optionsListing
      summary: Read the methods and patch format of a listing
      description: Returns `Allow` and `Accept-Patch` for this exact URI (RFC 5789 Section 3.1). Requires `listings:read`. The server ignores `If-Match` and `If-None-Match` on this method, which selects and modifies no representation (RFC 9110 Section 13.2.1), so it never returns `412` or `304`.
      tags: [Listings]
      security:
        - BearerAuth: ["listings:read"]
      responses:
        "204":
          description: No content.
          headers:
            Allow:
              $ref: "#/components/headers/AllowListing"
            Accept-Patch:
              $ref: "#/components/headers/AcceptListingPatch"
        "401":
          $ref: "#/components/responses/Unauthorized"
        "403":
          $ref: "#/components/responses/Forbidden"
        "404":
          $ref: "#/components/responses/NotFound"
        "429":
          $ref: "#/components/responses/RateLimited"
        "500":
          $ref: "#/components/responses/InternalError"
    patch:
      operationId: updateListing
      summary: Update operator-controlled listing fields
      description: |
        JSON Merge Patch (RFC 7396). The request `Content-Type` is
        `application/merge-patch+json`; any other media type returns
        `415 unsupported_media_type` with
        `Accept-Patch: application/merge-patch+json`. A member omitted from
        the patch keeps its stored value. `null` clears a nullable member,
        such as `externalId`. `null` on a member that is required and not
        nullable returns `422 validation_error`.

        Evaluation order follows the API description. The listing has no
        state checks. The listing carries a strong entity tag. An `If-Match`
        mismatch, or `If-None-Match: *` on the existing listing, returns
        `412 precondition_failed` with the current listing and writes
        nothing. Sending the same patch again leaves the same listing.
      tags: [Listings]
      security:
        - BearerAuth: ["listings:write"]
      parameters:
        - $ref: "#/components/parameters/IfMatch"
        - $ref: "#/components/parameters/IfNoneMatch"
      requestBody:
        required: true
        content:
          application/merge-patch+json:
            schema:
              $ref: "#/components/schemas/UpdateListingRequest"
      responses:
        "200":
          description: The updated listing.
          headers:
            ETag:
              $ref: "#/components/headers/StrongETag"
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Listing"
        "400":
          $ref: "#/components/responses/MalformedRequest"
        "401":
          $ref: "#/components/responses/Unauthorized"
        "403":
          $ref: "#/components/responses/Forbidden"
        "404":
          $ref: "#/components/responses/NotFound"
        "412":
          $ref: "#/components/responses/ListingPreconditionFailed"
        "415":
          $ref: "#/components/responses/ListingUnsupportedMediaType"
        "422":
          $ref: "#/components/responses/ValidationError"
        "429":
          $ref: "#/components/responses/RateLimited"
        "500":
          $ref: "#/components/responses/InternalError"

  /listings/{listingId}/calendar:
    parameters:
      - $ref: "#/components/parameters/ListingId"
    get:
      operationId: getListingCalendar
      summary: Read stored snapshots and effective availability
      description: |
        Server rules `date_range_reversed` and `date_range_too_long` apply to
        the `from` and `to` query parameters and return
        `400 malformed_request` with `errors[].parameter`, because the
        request has no content. The date range carries a weak entity tag,
        so a specific `If-Match` tag never matches and `If-Match: *`
        passes. Responses carry no `Accept-Patch`, because this URI with
        its query does not accept `PATCH` (RFC 5789 Section 3.1). `OPTIONS`
        on the calendar URI without the query advertises the format that
        `PATCH` accepts there.
      tags: [Calendar]
      security:
        - BearerAuth: ["listings:read"]
      parameters:
        - $ref: "#/components/parameters/CalendarFrom"
        - $ref: "#/components/parameters/CalendarTo"
        - $ref: "#/components/parameters/IfMatch"
        - $ref: "#/components/parameters/IfNoneMatch"
      responses:
        "200":
          description: One entry per date in the range.
          headers:
            ETag:
              $ref: "#/components/headers/WeakETag"
            Cache-Control:
              $ref: "#/components/headers/CacheControl"
            Vary:
              $ref: "#/components/headers/Vary"
            Content-Encoding:
              $ref: "#/components/headers/ContentEncoding"
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/CalendarResponse"
        "304":
          $ref: "#/components/responses/NotModified"
        "400":
          $ref: "#/components/responses/MalformedRequest"
        "401":
          $ref: "#/components/responses/Unauthorized"
        "403":
          $ref: "#/components/responses/Forbidden"
        "404":
          $ref: "#/components/responses/NotFound"
        "412":
          $ref: "#/components/responses/PreconditionFailed"
        "429":
          $ref: "#/components/responses/RateLimited"
        "500":
          $ref: "#/components/responses/InternalError"
    head:
      operationId: headListingCalendar
      summary: Read the headers of a calendar range
      description: Same parameters, preconditions, status codes, and headers as `GET` on this path, with no content on any status (RFC 9110 Section 9.3.2).
      tags: [Calendar]
      security:
        - BearerAuth: ["listings:read"]
      parameters:
        - $ref: "#/components/parameters/CalendarFrom"
        - $ref: "#/components/parameters/CalendarTo"
        - $ref: "#/components/parameters/IfMatch"
        - $ref: "#/components/parameters/IfNoneMatch"
      responses:
        "200":
          description: The headers that `GET` would return, with no content.
          headers:
            ETag:
              $ref: "#/components/headers/WeakETag"
            Cache-Control:
              $ref: "#/components/headers/CacheControl"
            Vary:
              $ref: "#/components/headers/Vary"
            Content-Encoding:
              $ref: "#/components/headers/ContentEncoding"
        "304":
          $ref: "#/components/responses/NotModified"
        "400":
          $ref: "#/components/responses/HeadMalformedRequest"
        "401":
          $ref: "#/components/responses/HeadUnauthorized"
        "403":
          $ref: "#/components/responses/HeadForbidden"
        "404":
          $ref: "#/components/responses/HeadNotFound"
        "412":
          $ref: "#/components/responses/HeadPreconditionFailed"
        "429":
          $ref: "#/components/responses/HeadRateLimited"
        "500":
          $ref: "#/components/responses/HeadInternalError"
    options:
      operationId: optionsListingCalendar
      summary: Read the methods and patch format of the calendar
      description: Returns `Allow` and `Accept-Patch` for this exact URI (RFC 5789 Section 3.1). Requires `listings:read`. The server ignores `If-Match` and `If-None-Match` on this method, which selects and modifies no representation (RFC 9110 Section 13.2.1), so it never returns `412` or `304`.
      tags: [Calendar]
      security:
        - BearerAuth: ["listings:read"]
      responses:
        "204":
          description: No content.
          headers:
            Allow:
              $ref: "#/components/headers/AllowCalendar"
            Accept-Patch:
              $ref: "#/components/headers/AcceptCalendarPatch"
        "401":
          $ref: "#/components/responses/Unauthorized"
        "403":
          $ref: "#/components/responses/Forbidden"
        "404":
          $ref: "#/components/responses/NotFound"
        "429":
          $ref: "#/components/responses/RateLimited"
        "500":
          $ref: "#/components/responses/InternalError"
    patch:
      operationId: updateListingCalendar
      summary: Push calendar snapshots for the listed dates
      description: |
        The request `Content-Type` is `application/json`; any other media
        type returns `415 unsupported_media_type` with
        `Accept-Patch: application/json`. Stores one snapshot per date
        covered by `entries` under the sequence rules, then reports
        effective availability after subtracting active holds with
        `reservationSequence` above `reservationsThrough`. Dates outside the
        entries keep their stored snapshots, and an entry that omits
        `priceOverrides` keeps the stored overrides. The body is a patch
        document defined by this API, not JSON Patch or JSON Merge Patch:
        each entry states the complete snapshot of every date from its
        `from` to its `to`, and the request-wide `sequence` and
        `reservationsThrough` apply to every entry. Two entries that cover
        the same date return `422 validation_error` with reason
        `overlapping_entries` and a pointer to the later entry. Server rules:
        `overlapping_entries`, `date_range_reversed`, `date_range_too_long`, `interval_reversed`,
        `interval_outside_entry`, `units_exceed_exclusive`,
        `intervals_on_date_listing`, `unknown_booking_option`,
        `tax_mode_mismatch`.

        The batch is atomic (RFC 5789 Section 2): One Coworking applies the
        whole batch in one transaction or applies none of it. Per date, a
        higher `sequence` than the stored one returns `applied`. An equal
        `sequence` with identical content returns `unchanged`. A lower
        `sequence` returns `skipped_older_sequence`. When any date receives
        an equal `sequence` with different content, the response is
        `409 sequence_reused` listing every such date in
        `conflictingDates`, and nothing is applied.

        Evaluation order follows the API description, so `sequence_reused`
        is decided after both preconditions pass. The target is the
        calendar URI without a query. It exists whenever the listing
        exists and has no entity tag: `If-Match: *` passes, a listed
        `If-Match` tag returns `412` without `ETag`, `If-None-Match: *`
        returns `412` without `ETag`, and a listed `If-None-Match` tag
        passes.
      tags: [Calendar]
      security:
        - BearerAuth: ["calendar:write"]
      parameters:
        - $ref: "#/components/parameters/IfMatch"
        - $ref: "#/components/parameters/IfNoneMatch"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/UpsertCalendarRequest"
      responses:
        "200":
          description: Per-date outcome and effective availability.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/UpsertCalendarResponse"
        "400":
          $ref: "#/components/responses/MalformedRequest"
        "401":
          $ref: "#/components/responses/Unauthorized"
        "403":
          $ref: "#/components/responses/Forbidden"
        "404":
          $ref: "#/components/responses/NotFound"
        "409":
          $ref: "#/components/responses/SequenceReused"
        "412":
          $ref: "#/components/responses/UntaggedPreconditionFailed"
        "415":
          $ref: "#/components/responses/CalendarUnsupportedMediaType"
        "422":
          $ref: "#/components/responses/ValidationError"
        "429":
          $ref: "#/components/responses/RateLimited"
        "500":
          $ref: "#/components/responses/InternalError"

  /reservations:
    parameters:
      - name: afterSequence
        in: query
        schema:
          type: integer
          minimum: 0
      - name: updatedSince
        in: query
        schema:
          type: string
          format: date-time
      - name: venueId
        in: query
        schema:
          type: string
      - name: listingId
        in: query
        schema:
          type: string
      - name: status
        in: query
        schema:
          $ref: "#/components/schemas/ReservationStatus"
      - $ref: "#/components/parameters/Cursor"
      - $ref: "#/components/parameters/Limit"
      - $ref: "#/components/parameters/IfMatch"
      - $ref: "#/components/parameters/IfNoneMatch"
    get:
      operationId: listReservations
      summary: List reservations for recovery
      description: |
        With `afterSequence`, which requires `venueId`, returns that venue's
        reservations with a higher `reservationSequence` in ascending
        sequence order. With
        `updatedSince`, returns reservations changed at or after that
        instant in ascending `updatedAt` order. Send one of the two.

        The page carries a weak entity tag, so a specific `If-Match` tag
        never matches and `If-Match: *` passes. An invalid query parameter,
        or `afterSequence` without `venueId`, returns
        `400 malformed_request` with `errors[].parameter`.
      tags: [Reservations]
      security:
        - BearerAuth: ["reservations:read"]
      responses:
        "200":
          description: One page of reservations.
          headers:
            ETag:
              $ref: "#/components/headers/WeakETag"
            Cache-Control:
              $ref: "#/components/headers/CacheControl"
            Vary:
              $ref: "#/components/headers/Vary"
            Content-Encoding:
              $ref: "#/components/headers/ContentEncoding"
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/ReservationPage"
        "304":
          $ref: "#/components/responses/NotModified"
        "400":
          $ref: "#/components/responses/MalformedRequest"
        "401":
          $ref: "#/components/responses/Unauthorized"
        "403":
          $ref: "#/components/responses/Forbidden"
        "412":
          $ref: "#/components/responses/PreconditionFailed"
        "429":
          $ref: "#/components/responses/RateLimited"
        "500":
          $ref: "#/components/responses/InternalError"

    head:
      operationId: headReservations
      summary: Read the headers of a reservation page
      description: Same parameters, preconditions, status codes, and headers as `GET` on this path, with no content on any status (RFC 9110 Section 9.3.2).
      tags: [Reservations]
      security:
        - BearerAuth: ["reservations:read"]
      responses:
        "200":
          description: The headers that `GET` would return, with no content.
          headers:
            ETag:
              $ref: "#/components/headers/WeakETag"
            Cache-Control:
              $ref: "#/components/headers/CacheControl"
            Vary:
              $ref: "#/components/headers/Vary"
            Content-Encoding:
              $ref: "#/components/headers/ContentEncoding"
        "304":
          $ref: "#/components/responses/NotModified"
        "400":
          $ref: "#/components/responses/HeadMalformedRequest"
        "401":
          $ref: "#/components/responses/HeadUnauthorized"
        "403":
          $ref: "#/components/responses/HeadForbidden"
        "412":
          $ref: "#/components/responses/HeadPreconditionFailed"
        "429":
          $ref: "#/components/responses/HeadRateLimited"
        "500":
          $ref: "#/components/responses/HeadInternalError"

  /reservations/{reservationId}:
    parameters:
      - $ref: "#/components/parameters/ReservationId"
    get:
      operationId: getReservation
      summary: Read one reservation's current state
      description: |
        The reservation carries the strong entity tag `"v<version>"`. For a
        reservation at version 2, a request with `If-Match: "v1"` and
        `If-None-Match: "v2"` returns `412 precondition_failed`, not `304`,
        because `If-Match` is evaluated first.
      tags: [Reservations]
      security:
        - BearerAuth: ["reservations:read"]
      parameters:
        - $ref: "#/components/parameters/IfMatch"
        - $ref: "#/components/parameters/IfNoneMatch"
      responses:
        "200":
          description: The reservation at its current version.
          headers:
            ETag:
              $ref: "#/components/headers/StrongETag"
            Cache-Control:
              $ref: "#/components/headers/CacheControl"
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Reservation"
        "304":
          $ref: "#/components/responses/ReservationNotModified"
        "400":
          $ref: "#/components/responses/MalformedRequest"
        "401":
          $ref: "#/components/responses/Unauthorized"
        "403":
          $ref: "#/components/responses/Forbidden"
        "404":
          $ref: "#/components/responses/NotFound"
        "412":
          $ref: "#/components/responses/ReservationPreconditionFailed"
        "429":
          $ref: "#/components/responses/RateLimited"
        "500":
          $ref: "#/components/responses/InternalError"

    head:
      operationId: headReservation
      summary: Read the headers of one reservation
      description: Same parameters, preconditions, status codes, and headers as `GET` on this path, with no content on any status (RFC 9110 Section 9.3.2).
      tags: [Reservations]
      security:
        - BearerAuth: ["reservations:read"]
      parameters:
        - $ref: "#/components/parameters/IfMatch"
        - $ref: "#/components/parameters/IfNoneMatch"
      responses:
        "200":
          description: The headers that `GET` would return, with no content.
          headers:
            ETag:
              $ref: "#/components/headers/StrongETag"
            Cache-Control:
              $ref: "#/components/headers/CacheControl"
        "304":
          $ref: "#/components/responses/ReservationNotModified"
        "400":
          $ref: "#/components/responses/HeadMalformedRequest"
        "401":
          $ref: "#/components/responses/HeadUnauthorized"
        "403":
          $ref: "#/components/responses/HeadForbidden"
        "404":
          $ref: "#/components/responses/HeadNotFound"
        "412":
          $ref: "#/components/responses/HeadTaggedPreconditionFailed"
        "429":
          $ref: "#/components/responses/HeadRateLimited"
        "500":
          $ref: "#/components/responses/HeadInternalError"

  /reservations/{reservationId}/confirm:
    parameters:
      - $ref: "#/components/parameters/ReservationId"
    post:
      operationId: confirmReservation
      summary: Confirm a pending reservation
      description: |
        Three cases, each returning the reservation:

        - `pending_confirmation` with `paymentStatus: authorized`: captures
          the payment. The result is `confirmed`, `capture_pending`, or
          `payment_failed`.
        - `pending_confirmation` with `paymentStatus: captured` (captured at
          checkout): confirms without another capture. The result is
          `confirmed`.
        - `confirmed` on an `instant` listing with no stored
          `externalReservationId`: attaches `externalReservationId` and
          `access` without altering payment state. The status remains
          `confirmed`.

        Every successful confirmation or attachment emits
        `reservation.confirmed`. Only `confirmed` authorizes fulfillment.

        Evaluation order follows the API description: reservation state and
        `confirmBy` come before `If-Match` and `If-None-Match`, and a
        different `externalReservationId` on a `confirmed` reservation is
        compared after them, because it depends on the request content.
        The `/confirm` resource shares the reservation's strong entity tag `"v<version>"`.
        The state outcomes below apply whatever `If-Match` says. When an
        outcome below is `200` and a precondition evaluates to false, the
        response is instead `412 precondition_failed` with the current
        reservation and nothing changes. One Coworking serializes state
        changes on a reservation, so concurrent or repeated calls capture
        at most once.

        Retry after a lost response: the outcome depends only on the
        state at retry time. A request that fails the state checks below
        returns `409` as listed. When the deadline and every state check
        pass and the `If-Match` tag read before the first call is stale,
        the retry returns `412 precondition_failed` with the current
        reservation, also when it sends a different
        `externalReservationId`, because that comparison runs after the
        preconditions.
        Without `If-Match`, or with a matching tag, the outcomes below
        apply, and none repeats a capture or guest notification.

        Outcomes on later calls:

        - `pending_confirmation` after `confirmBy`:
          `409 confirmation_deadline_passed` with the current reservation,
          which can still show `pending_confirmation` until the expiry is
          processed.
        - `capture_pending`: `200` with the current reservation. No second
          capture.
        - `confirmed` with a stored `externalReservationId` and the same ID:
          `200` with the current reservation. No capture, guest
          notification, or event.
        - `confirmed` with a stored `externalReservationId` and a different
          ID: `409 invalid_state_transition` with the current reservation.
        - Any terminal status (`declined`, `expired`, `payment_failed`, or a
          `cancelled_*` status): `409 invalid_state_transition` with the
          current reservation, also after `confirmBy`. The deadline stopped
          applying once One Coworking accepted an earlier `/confirm`, and a
          deadline that expired the reservation is reported by its
          `expired` status.
      tags: [Reservations]
      security:
        - BearerAuth: ["reservations:write"]
      parameters:
        - $ref: "#/components/parameters/IfMatch"
        - $ref: "#/components/parameters/IfNoneMatch"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/ConfirmReservationRequest"
      responses:
        "200":
          description: The reservation after the action.
          headers:
            ETag:
              $ref: "#/components/headers/StrongETag"
            Content-Location:
              $ref: "#/components/headers/ReservationLocation"
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Reservation"
        "400":
          $ref: "#/components/responses/MalformedRequest"
        "401":
          $ref: "#/components/responses/Unauthorized"
        "403":
          $ref: "#/components/responses/Forbidden"
        "404":
          $ref: "#/components/responses/NotFound"
        "409":
          $ref: "#/components/responses/StateConflict"
        "412":
          $ref: "#/components/responses/ReservationPreconditionFailed"
        "415":
          $ref: "#/components/responses/UnsupportedMediaType"
        "422":
          $ref: "#/components/responses/ValidationError"
        "429":
          $ref: "#/components/responses/RateLimited"
        "500":
          $ref: "#/components/responses/InternalError"

  /reservations/{reservationId}/decline:
    parameters:
      - $ref: "#/components/parameters/ReservationId"
    post:
      operationId: declineReservation
      summary: Decline a pending reservation
      description: |
        Evaluation order follows the API description: reservation state and
        `confirmBy` come before `If-Match` and `If-None-Match`. The
        `/decline` resource shares the reservation's strong entity tag
        `"v<version>"`. A disallowed state returns `409` whatever `If-Match`
        says. When the state allows the action and a precondition evaluates
        to false, the response is `412 precondition_failed` with the current
        reservation. Declining is one-way. A retry after a lost response
        finds `declined` and returns `409 invalid_state_transition` with
        the current reservation, and no second void or refund runs.
      tags: [Reservations]
      security:
        - BearerAuth: ["reservations:write"]
      parameters:
        - $ref: "#/components/parameters/IfMatch"
        - $ref: "#/components/parameters/IfNoneMatch"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/DeclineReservationRequest"
      responses:
        "200":
          description: The reservation after the action.
          headers:
            ETag:
              $ref: "#/components/headers/StrongETag"
            Content-Location:
              $ref: "#/components/headers/ReservationLocation"
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Reservation"
        "400":
          $ref: "#/components/responses/MalformedRequest"
        "401":
          $ref: "#/components/responses/Unauthorized"
        "403":
          $ref: "#/components/responses/Forbidden"
        "404":
          $ref: "#/components/responses/NotFound"
        "409":
          $ref: "#/components/responses/StateConflict"
        "412":
          $ref: "#/components/responses/ReservationPreconditionFailed"
        "415":
          $ref: "#/components/responses/UnsupportedMediaType"
        "422":
          $ref: "#/components/responses/ValidationError"
        "429":
          $ref: "#/components/responses/RateLimited"
        "500":
          $ref: "#/components/responses/InternalError"

  /reservations/{reservationId}/cancel:
    parameters:
      - $ref: "#/components/parameters/ReservationId"
    post:
      operationId: cancelReservation
      summary: Cancel a confirmed reservation from the operator side
      description: |
        Evaluation order follows the API description: reservation state
        comes before `If-Match` and `If-None-Match`. The `/cancel` resource
        shares the reservation's strong entity tag `"v<version>"`. A
        disallowed state returns `409` whatever `If-Match` says. When the
        state allows the action and a precondition evaluates to false, the
        response is `412 precondition_failed` with the current reservation.
        Cancelling is one-way. A retry after a lost response finds
        `cancelled_by_operator` and returns `409 invalid_state_transition`
        with the current reservation, and no second refund runs.
      tags: [Reservations]
      security:
        - BearerAuth: ["reservations:write"]
      parameters:
        - $ref: "#/components/parameters/IfMatch"
        - $ref: "#/components/parameters/IfNoneMatch"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/CancelReservationRequest"
      responses:
        "200":
          description: The reservation after the action.
          headers:
            ETag:
              $ref: "#/components/headers/StrongETag"
            Content-Location:
              $ref: "#/components/headers/ReservationLocation"
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Reservation"
        "400":
          $ref: "#/components/responses/MalformedRequest"
        "401":
          $ref: "#/components/responses/Unauthorized"
        "403":
          $ref: "#/components/responses/Forbidden"
        "404":
          $ref: "#/components/responses/NotFound"
        "409":
          $ref: "#/components/responses/CancelStateConflict"
        "412":
          $ref: "#/components/responses/ReservationPreconditionFailed"
        "415":
          $ref: "#/components/responses/UnsupportedMediaType"
        "422":
          $ref: "#/components/responses/ValidationError"
        "429":
          $ref: "#/components/responses/RateLimited"
        "500":
          $ref: "#/components/responses/InternalError"

  /reservations/{reservationId}/access:
    parameters:
      - $ref: "#/components/parameters/ReservationId"
    put:
      operationId: replaceReservationAccess
      summary: Replace the complete access credential on a confirmed reservation
      description: |
        Complete replacement. The body is the whole new `AccessCredential`,
        which One Coworking stores in place of any stored one.
        `notifyGuest=true` sends the guest the new details. Server rule
        `access_window_reversed` applies. A reservation that is not
        `confirmed` returns `409 invalid_state_transition` with the current
        reservation.

        Evaluation order follows the API description: reservation state
        comes before `If-Match` and `If-None-Match`. A disallowed state
        returns `409` whatever `If-Match` says. That `409` carries the
        parent reservation in its body, and carries an `ETag` only while a
        credential exists, because `/access` has no current representation
        while `reservation.access` is null.

        The `/access` resource shares the reservation's strong entity tag
        `"v<version>"` while `reservation.access` is not null. While
        `reservation.access` is null, `/access` has no current
        representation: any `If-Match` returns `412 precondition_failed`
        without an `ETag`, `If-None-Match: *` passes, and the first
        credential returns `201 Created`. Replacing an existing credential
        returns `200`. `If-None-Match: *` while a credential exists returns
        `412 precondition_failed` with the `ETag` of the current
        representation.

        Credential equality is JSON semantic equality (RFC 8259 Section 4):
        object member order does not matter. A body semantically equal to
        the stored credential is a no-op: `200` with the current
        reservation, no `version` increment, and no guest notification,
        even with `notifyGuest=true`. Any other body is a new replacement.

        The `201` and `200` responses carry no `ETag`, because the server
        normalizes the stored credential (RFC 9110 Section 9.3.4). The body
        is the parent reservation, identified by `Content-Location`. Clients
        read the new tag from `reservation.version` or a later `GET`.

        Operators send `If-Match` with the specific strong tag read before
        the call. When a lost response hid a credential that was stored, or
        since replaced by a later request, that tag is stale and the retry
        returns `412 precondition_failed` with the current reservation. The
        operator inspects `access` there, with no second notification and
        no overwrite of a newer credential. With a tag that is still
        current, a semantically equal body is again a no-op. Without a
        specific tag, a retry can overwrite a newer credential.
      tags: [Reservations]
      security:
        - BearerAuth: ["reservations:write"]
      parameters:
        - $ref: "#/components/parameters/IfMatch"
        - $ref: "#/components/parameters/IfNoneMatch"
        - name: notifyGuest
          in: query
          required: false
          description: When true, One Coworking sends the guest the new access details once. A body semantically equal to the stored credential sends nothing.
          schema:
            type: boolean
            default: false
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/AccessCredential"
      responses:
        "200":
          description: The reservation with its replaced credential, or unchanged when the body is semantically equal to the stored credential. No `ETag`.
          headers:
            Content-Location:
              $ref: "#/components/headers/ReservationLocation"
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Reservation"
        "201":
          description: The reservation with its first credential. No `ETag`.
          headers:
            Content-Location:
              $ref: "#/components/headers/ReservationLocation"
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Reservation"
        "400":
          $ref: "#/components/responses/MalformedRequest"
        "401":
          $ref: "#/components/responses/Unauthorized"
        "403":
          $ref: "#/components/responses/Forbidden"
        "404":
          $ref: "#/components/responses/NotFound"
        "409":
          $ref: "#/components/responses/AccessStateConflict"
        "412":
          $ref: "#/components/responses/AccessPreconditionFailed"
        "415":
          $ref: "#/components/responses/UnsupportedMediaType"
        "422":
          $ref: "#/components/responses/ValidationError"
        "429":
          $ref: "#/components/responses/RateLimited"
        "500":
          $ref: "#/components/responses/InternalError"

  /webhooks/test:
    post:
      operationId: sendTestWebhook
      summary: Send one signed webhook.test event
      description: |
        Sends exactly one `webhook.test` event to the registered endpoint.
        The request body accepts no fields, so it cannot ask for a
        reservation event. Simulated reservation events exist only in the
        sandbox, through sandbox checkout.

        The request content is optional. A `POST` without content and
        without `Content-Type` is accepted. A request with content uses
        `Content-Type: application/json` and the empty object `{}`, and
        content of any other media type returns
        `415 unsupported_media_type`.

        Evaluation order follows the API description. The command only
        queues an event for delivery to the operator's endpoint and selects
        or modifies no representation at its own URI, so the server ignores
        `If-Match` and `If-None-Match` on it and never returns `412`
        (RFC 9110 Section 13.2.1). This is a connectivity test only, so a
        retry sends another `webhook.test` event.
      tags: [Webhooks]
      security:
        - BearerAuth: ["webhooks:test"]
      requestBody:
        required: false
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/WebhookTestRequest"
      responses:
        "202":
          description: The test event is queued.
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/WebhookTestAccepted"
        "400":
          $ref: "#/components/responses/MalformedRequest"
        "401":
          $ref: "#/components/responses/Unauthorized"
        "403":
          $ref: "#/components/responses/Forbidden"
        "415":
          $ref: "#/components/responses/UnsupportedMediaType"
        "422":
          $ref: "#/components/responses/ValidationError"
        "429":
          $ref: "#/components/responses/RateLimited"
        "500":
          $ref: "#/components/responses/InternalError"

webhooks:
  reservation.created:
    post:
      operationId: onReservationCreated
      summary: A guest completed checkout
      security: []
      parameters:
        - $ref: "#/components/parameters/WebhookId"
        - $ref: "#/components/parameters/WebhookTimestamp"
        - $ref: "#/components/parameters/WebhookSignature"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/ReservationCreatedEvent"
      responses:
        "2XX":
          description: The operator stored the event durably. One Coworking stops retrying.
        "400":
          $ref: "#/components/responses/WebhookRejected"
  reservation.confirmed:
    post:
      operationId: onReservationConfirmed
      summary: A reservation reached confirmed with payment captured, or an instant booking got its external ID and access
      security: []
      parameters:
        - $ref: "#/components/parameters/WebhookId"
        - $ref: "#/components/parameters/WebhookTimestamp"
        - $ref: "#/components/parameters/WebhookSignature"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/ReservationConfirmedEvent"
      responses:
        "2XX":
          description: The operator stored the event durably. One Coworking stops retrying.
        "400":
          $ref: "#/components/responses/WebhookRejected"
  reservation.payment_failed:
    post:
      operationId: onReservationPaymentFailed
      summary: Capture failed after confirm
      security: []
      parameters:
        - $ref: "#/components/parameters/WebhookId"
        - $ref: "#/components/parameters/WebhookTimestamp"
        - $ref: "#/components/parameters/WebhookSignature"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/ReservationPaymentFailedEvent"
      responses:
        "2XX":
          description: The operator stored the event durably. One Coworking stops retrying.
        "400":
          $ref: "#/components/responses/WebhookRejected"
  reservation.cancelled:
    post:
      operationId: onReservationCancelled
      summary: The guest, the operator, or One Coworking cancelled
      security: []
      parameters:
        - $ref: "#/components/parameters/WebhookId"
        - $ref: "#/components/parameters/WebhookTimestamp"
        - $ref: "#/components/parameters/WebhookSignature"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/ReservationCancelledEvent"
      responses:
        "2XX":
          description: The operator stored the event durably. One Coworking stops retrying.
        "400":
          $ref: "#/components/responses/WebhookRejected"
  reservation.expired:
    post:
      operationId: onReservationExpired
      summary: confirmBy elapsed without an operator response
      security: []
      parameters:
        - $ref: "#/components/parameters/WebhookId"
        - $ref: "#/components/parameters/WebhookTimestamp"
        - $ref: "#/components/parameters/WebhookSignature"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/ReservationExpiredEvent"
      responses:
        "2XX":
          description: The operator stored the event durably. One Coworking stops retrying.
        "400":
          $ref: "#/components/responses/WebhookRejected"
  webhook.test:
    post:
      operationId: onWebhookTest
      summary: Connectivity and signature test
      security: []
      parameters:
        - $ref: "#/components/parameters/WebhookId"
        - $ref: "#/components/parameters/WebhookTimestamp"
        - $ref: "#/components/parameters/WebhookSignature"
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/WebhookTestEvent"
      responses:
        "2XX":
          description: The endpoint verified the signature.
        "400":
          $ref: "#/components/responses/WebhookRejected"

components:
  securitySchemes:
    BearerAuth:
      type: http
      scheme: bearer
      description: |
        Operator API token (RFC 6750), used only on operator calls to One
        Coworking. Scopes: `listings:read`, `listings:write`,
        `calendar:write`, `reservations:read`, `reservations:write`,
        `webhooks:test`. Each operation names its one required scope in its
        own `security` requirement, and a `HEAD` requires the scope of the
        `GET` on its path. Every webhook overrides it with an empty security
        list.

  parameters:
    ListingId:
      name: listingId
      in: path
      required: true
      schema:
        type: string
    ReservationId:
      name: reservationId
      in: path
      required: true
      schema:
        type: string
    CalendarFrom:
      name: from
      in: query
      required: true
      description: First date of the read, in the listing's timezone. A `from` after `to` returns `400 malformed_request` with `errors[].parameter` and reason `date_range_reversed`.
      schema:
        type: string
        format: date
    CalendarTo:
      name: to
      in: query
      required: true
      description: Last date of the read, inclusive. A range of more than 366 dates returns `400 malformed_request` with reason `date_range_too_long`.
      schema:
        type: string
        format: date
    IfMatch:
      name: If-Match
      in: header
      required: false
      description: |
        Optional. One or more entity tags, or `*` (RFC 9110 Section 13.1.1).
        Compared with strong comparison: a weak entity tag never matches.
        `*` evaluates to false when the target resource has no current
        representation. The server evaluates this header after the state
        and `confirmBy` checks, so a request that fails those checks
        returns `409` whatever this header says. When they pass and the
        condition evaluates to false, the server returns
        `412 precondition_failed` and changes nothing, also when the
        content would conflict with stored state, because that comparison
        comes after both preconditions. The server evaluates
        `If-None-Match` only after this header passes. Every `GET` path
        accepts it on `HEAD` as well.
      schema:
        type: string
        minLength: 1
    IfNoneMatch:
      name: If-None-Match
      in: header
      required: false
      description: |
        Optional. One or more entity tags, or `*` (RFC 9110 Section 13.1.2).
        Compared with weak comparison. `*` matches when the target resource
        has a current representation. Evaluated after `If-Match`. When a
        listed tag matches, the condition is false: `GET` and `HEAD` return
        `304 Not Modified`, and every other method returns
        `412 precondition_failed` and changes nothing. Every `GET` path
        accepts it on `HEAD` as well.
      schema:
        type: string
        minLength: 1
    Cursor:
      name: cursor
      in: query
      schema:
        type: string
    Limit:
      name: limit
      in: query
      schema:
        type: integer
        minimum: 1
        maximum: 200
        default: 50
    WebhookId:
      name: webhook-id
      in: header
      required: true
      description: |
        Standard Webhooks message identifier. Equals the body `eventId` and
        stays identical across retries, so receivers deduplicate on it.
      schema:
        type: string
        pattern: "^evt_[A-Za-z0-9]+$"
    WebhookTimestamp:
      name: webhook-timestamp
      in: header
      required: true
      description: |
        Standard Webhooks timestamp: Unix epoch seconds at signing, as a
        decimal integer of any length without a sign or leading zeros. The
        first attempt is signed within 300 seconds of `occurredAt`, and
        each retry is signed again at send time, up to 24 hours after
        `occurredAt`. Receivers reject values more than 300 seconds from
        their clock.
      schema:
        type: string
        pattern: "^(0|[1-9][0-9]*)$"
    WebhookSignature:
      name: webhook-signature
      in: header
      required: true
      description: |
        Standard Webhooks signature. One or more space-delimited
        `v1,<signature>` entries, several during secret rotation. Each
        signature is the Base64 HMAC-SHA256 of
        `${webhook-id}.${webhook-timestamp}.${rawBody}`, keyed with the
        Base64-decoded part of the signing secret after `whsec_`.
        Receivers compare in constant time and accept the request when any
        entry matches.
      schema:
        type: string
        pattern: "^v1,[A-Za-z0-9+/]{43}=( v1,[A-Za-z0-9+/]{43}=)*$"

  headers:
    StrongETag:
      required: true
      description: |
        Strong entity tag of the target resource's representation. A
        reservation's tag, shared by its `/confirm`, `/decline`, `/cancel`,
        and `/access` resources, is `"v<version>"`. A listing's tag is
        opaque. A response that carries a strong tag is never sent with a
        `Content-Encoding`, so each version has exactly one strong tag.
      schema:
        type: string
        pattern: '^"[\x21\x23-\x7E]+"$'
    WeakETag:
      required: true
      description: Weak entity tag of the returned page or date range for this query.
      schema:
        type: string
        pattern: '^W/"[\x21\x23-\x7E]+"$'
    CurrentETag:
      required: false
      description: Strong entity tag `"v<version>"` of `/access`, present only while a credential exists and `/access` has a current representation.
      schema:
        type: string
        pattern: '^"[\x21\x23-\x7E]+"$'
    ContentEncoding:
      required: false
      description: The content coding of a compressed collection or calendar read, such as `gzip`, negotiated by `Accept-Encoding`. Absent on an uncompressed response. Never sent with a strong entity tag.
      schema:
        type: string
        pattern: "^[A-Za-z0-9!#$%&'*+.^_`|~-]+$"
    ReservationLocation:
      required: true
      description: Path of the parent reservation whose representation the response body carries.
      schema:
        type: string
        pattern: "^/partner/v1/reservations/[^/]+$"
    CacheControl:
      required: true
      description: Authenticated responses are private and revalidated before reuse.
      schema:
        type: string
        const: private, no-cache
    Vary:
      required: true
      description: "`Accept-Encoding` on every `200` and `304` of a collection or calendar read, uncompressed or compressed, because the content coding is negotiated (RFC 9110 Section 12.5.5). Responses with a strong entity tag are never compressed and carry no `Vary`."
      schema:
        type: string
        const: Accept-Encoding
    ErrorCacheControl:
      required: false
      description: Present on every error response to an authenticated `GET` or `HEAD`, with the same value as on `200` and `304`. Error responses are shared with other methods, so the header is declared as optional here.
      schema:
        type: string
        const: private, no-cache
    AllowListing:
      required: true
      description: Methods that the listing URI supports (RFC 9110 Section 10.2.1).
      schema:
        type: string
        const: GET, HEAD, PATCH, OPTIONS
    AllowCalendar:
      required: true
      description: Methods that the calendar URI without a query supports. Reads use `GET` or `HEAD` with the `from` and `to` query, which names a date range.
      schema:
        type: string
        const: PATCH, OPTIONS
    AcceptListingPatch:
      required: true
      description: Patch media type accepted by `PATCH /listings/{listingId}` (RFC 5789 Section 3.1).
      schema:
        type: string
        const: application/merge-patch+json
    AcceptCalendarPatch:
      required: true
      description: Patch media type accepted by `PATCH /listings/{listingId}/calendar` (RFC 5789 Section 3.1).
      schema:
        type: string
        const: application/json
    BearerChallenge:
      required: true
      description: |
        `Bearer realm="onecoworking"` when the request carries no token, or
        `Bearer realm="onecoworking", error="invalid_token"` when the token
        is invalid, expired, or revoked (RFC 6750 Section 3). Every
        challenge carries an auth-param, as RFC 6750 Section 3 requires.
      schema:
        type: string
        enum:
          - Bearer realm="onecoworking"
          - Bearer realm="onecoworking", error="invalid_token"
    InsufficientScopeChallenge:
      required: false
      description: |
        Present only on `insufficient_scope`:
        `Bearer realm="onecoworking", error="insufficient_scope", scope="<required scope>"`
        (RFC 6750 Section 3.1), where the scope is the one the operation's
        security requirement names. Absent on `forbidden`.
      schema:
        type: string
        pattern: '^Bearer realm="onecoworking", error="insufficient_scope", scope="[a-z]+:[a-z]+"$'

  responses:
    NotModified:
      description: |
        `If-None-Match` evaluated to false on `GET` or `HEAD` of a
        collection or calendar range. The body is empty. The response
        repeats the weak `ETag`, `Cache-Control`, and `Vary` a `200` would
        carry. It carries no `Accept-Patch`, because neither URI accepts
        `PATCH`.
      headers:
        ETag:
          $ref: "#/components/headers/WeakETag"
        Cache-Control:
          $ref: "#/components/headers/CacheControl"
        Vary:
          $ref: "#/components/headers/Vary"
    ReservationNotModified:
      description: |
        `If-None-Match` evaluated to false on `GET` or `HEAD` of a
        reservation. The body is empty. The response repeats the strong
        `ETag` and `Cache-Control` a `200` would carry.
      headers:
        ETag:
          $ref: "#/components/headers/StrongETag"
        Cache-Control:
          $ref: "#/components/headers/CacheControl"
    ListingNotModified:
      description: |
        `If-None-Match` evaluated to false on `GET` or `HEAD` of a listing.
        The body is empty. The response repeats the `ETag`,
        `Cache-Control`, and `Accept-Patch` a `200` would carry.
      headers:
        ETag:
          $ref: "#/components/headers/StrongETag"
        Cache-Control:
          $ref: "#/components/headers/CacheControl"
        Accept-Patch:
          $ref: "#/components/headers/AcceptListingPatch"
    MalformedRequest:
      description: The body is not well-formed JSON, or a query, path, or header parameter has invalid syntax or breaks a parameter rule, such as a calendar read whose `from` is after its `to`.
      headers:
        Cache-Control:
          $ref: "#/components/headers/ErrorCacheControl"
      content:
        application/problem+json:
          schema:
            $ref: "#/components/schemas/MalformedRequestProblem"
    ValidationError:
      description: Well-formed request content failed a schema rule or a cross-field server rule.
      content:
        application/problem+json:
          schema:
            $ref: "#/components/schemas/ValidationErrorProblem"
    Unauthorized:
      description: Missing, invalid, expired, or revoked Bearer token.
      headers:
        Cache-Control:
          $ref: "#/components/headers/ErrorCacheControl"
        WWW-Authenticate:
          $ref: "#/components/headers/BearerChallenge"
      content:
        application/problem+json:
          schema:
            $ref: "#/components/schemas/UnauthorizedProblem"
    Forbidden:
      description: |
        `insufficient_scope` when the token lacks the operation's scope,
        with a `WWW-Authenticate` challenge naming it. `forbidden` when the
        resource belongs to the token's operator account at a venue outside
        the token's venue limit, without that challenge.
      headers:
        Cache-Control:
          $ref: "#/components/headers/ErrorCacheControl"
        WWW-Authenticate:
          $ref: "#/components/headers/InsufficientScopeChallenge"
      content:
        application/problem+json:
          schema:
            oneOf:
              - $ref: "#/components/schemas/InsufficientScopeProblem"
              - $ref: "#/components/schemas/ForbiddenProblem"
    NotFound:
      description: The resource does not exist in the token's operator account. An ID of another operator account receives the same response.
      headers:
        Cache-Control:
          $ref: "#/components/headers/ErrorCacheControl"
      content:
        application/problem+json:
          schema:
            $ref: "#/components/schemas/NotFoundProblem"
    UnsupportedMediaType:
      description: The request `Content-Type` is not `application/json`.
      content:
        application/problem+json:
          schema:
            $ref: "#/components/schemas/UnsupportedMediaTypeProblem"
    ListingUnsupportedMediaType:
      description: The request `Content-Type` is not `application/merge-patch+json`.
      headers:
        Accept-Patch:
          $ref: "#/components/headers/AcceptListingPatch"
      content:
        application/problem+json:
          schema:
            $ref: "#/components/schemas/UnsupportedMediaTypeProblem"
    CalendarUnsupportedMediaType:
      description: The request `Content-Type` is not `application/json`.
      headers:
        Accept-Patch:
          $ref: "#/components/headers/AcceptCalendarPatch"
      content:
        application/problem+json:
          schema:
            $ref: "#/components/schemas/UnsupportedMediaTypeProblem"
    StateConflict:
      description: |
        `invalid_state_transition`, or on `/confirm` and `/decline`
        `confirmation_deadline_passed` for a reservation still in
        `pending_confirmation`. The body includes the current reservation,
        and the `ETag` header carries its current strong tag.
      headers:
        ETag:
          $ref: "#/components/headers/StrongETag"
      content:
        application/problem+json:
          schema:
            oneOf:
              - $ref: "#/components/schemas/InvalidStateTransitionProblem"
              - $ref: "#/components/schemas/ConfirmationDeadlinePassedProblem"
    CancelStateConflict:
      description: |
        `invalid_state_transition` on `/cancel`. `/cancel` has no deadline,
        so it never returns `confirmation_deadline_passed`. The body
        includes the current reservation, and the `ETag` header carries its
        current strong tag.
      headers:
        ETag:
          $ref: "#/components/headers/StrongETag"
      content:
        application/problem+json:
          schema:
            $ref: "#/components/schemas/InvalidStateTransitionProblem"
    AccessStateConflict:
      description: |
        `invalid_state_transition` on `/access`. The body includes the
        current parent reservation, whose `version` gives its tag. The
        `ETag` header carries the reservation's tag only while a credential
        exists. While `reservation.access` is null, `/access` has no
        current representation, and the response has no `ETag`.
      headers:
        ETag:
          $ref: "#/components/headers/CurrentETag"
      content:
        application/problem+json:
          schema:
            $ref: "#/components/schemas/InvalidStateTransitionProblem"
    SequenceReused:
      description: |
        At least one entry reused the stored `sequence` of a date with
        different content. `conflictingDates` lists every such date, and
        nothing in the batch is applied.
      content:
        application/problem+json:
          schema:
            $ref: "#/components/schemas/SequenceReusedProblem"
    PreconditionFailed:
      description: |
        A precondition evaluated to false on `GET` of a collection or a
        calendar range. The `ETag` header carries the current weak tag of
        the page or range, and the body carries no resource member.
      headers:
        Cache-Control:
          $ref: "#/components/headers/ErrorCacheControl"
        ETag:
          $ref: "#/components/headers/WeakETag"
      content:
        application/problem+json:
          schema:
            $ref: "#/components/schemas/ResourcelessPreconditionFailedProblem"
    UntaggedPreconditionFailed:
      description: |
        A precondition evaluated to false on `PATCH` of the calendar URI
        without a query, a target without an entity tag. The response has
        no `ETag`, and the body carries no resource member.
      content:
        application/problem+json:
          schema:
            $ref: "#/components/schemas/ResourcelessPreconditionFailedProblem"
    ReservationPreconditionFailed:
      description: A precondition evaluated to false against the reservation's current tag. The body carries the current reservation.
      headers:
        Cache-Control:
          $ref: "#/components/headers/ErrorCacheControl"
        ETag:
          $ref: "#/components/headers/StrongETag"
      content:
        application/problem+json:
          schema:
            allOf:
              - $ref: "#/components/schemas/PreconditionFailedProblem"
              - required: [reservation]
    AccessPreconditionFailed:
      description: |
        A precondition evaluated to false against `/access`. The body
        carries the current reservation. The `ETag` header carries
        `"v<version>"` only when `/access` has a current representation,
        that is when `reservation.access` is not null.
      headers:
        Cache-Control:
          $ref: "#/components/headers/ErrorCacheControl"
        ETag:
          $ref: "#/components/headers/CurrentETag"
      content:
        application/problem+json:
          schema:
            allOf:
              - $ref: "#/components/schemas/PreconditionFailedProblem"
              - required: [reservation]
    ListingPreconditionFailed:
      description: A precondition evaluated to false against the listing's current tag. The body carries the current listing.
      headers:
        Cache-Control:
          $ref: "#/components/headers/ErrorCacheControl"
        ETag:
          $ref: "#/components/headers/StrongETag"
      content:
        application/problem+json:
          schema:
            allOf:
              - $ref: "#/components/schemas/PreconditionFailedProblem"
              - required: [listing]
    RateLimited:
      description: Rate limit exceeded.
      headers:
        Cache-Control:
          $ref: "#/components/headers/ErrorCacheControl"
        Retry-After:
          required: true
          description: Seconds to wait before retrying (RFC 9110 Section 10.2.3).
          schema:
            type: integer
            minimum: 1
      content:
        application/problem+json:
          schema:
            $ref: "#/components/schemas/RateLimitedProblem"
    InternalError:
      description: An unexpected server failure. The request may be retried later.
      headers:
        Cache-Control:
          $ref: "#/components/headers/ErrorCacheControl"
      content:
        application/problem+json:
          schema:
            $ref: "#/components/schemas/InternalErrorProblem"
    WebhookRejected:
      description: |
        The receiver rejected a delivery whose signature did not verify or
        whose `webhook-timestamp` was outside the tolerance, and did not
        persist it. The response carries no `WWW-Authenticate`, because
        webhooks use no HTTP authentication scheme. One Coworking retries
        it like any other non-`2xx` response.
    HeadMalformedRequest:
      description: "`400` to `HEAD`: a query, path, or header parameter is invalid. No content."
      headers:
        Cache-Control:
          $ref: "#/components/headers/ErrorCacheControl"
    HeadUnauthorized:
      description: "`401` to `HEAD`. No content."
      headers:
        WWW-Authenticate:
          $ref: "#/components/headers/BearerChallenge"
        Cache-Control:
          $ref: "#/components/headers/ErrorCacheControl"
    HeadForbidden:
      description: "`403` to `HEAD`, with the scope challenge only on `insufficient_scope`. No content."
      headers:
        WWW-Authenticate:
          $ref: "#/components/headers/InsufficientScopeChallenge"
        Cache-Control:
          $ref: "#/components/headers/ErrorCacheControl"
    HeadNotFound:
      description: "`404` to `HEAD`. No content."
      headers:
        Cache-Control:
          $ref: "#/components/headers/ErrorCacheControl"
    HeadPreconditionFailed:
      description: "`412` to `HEAD` of a collection or calendar range, with the current weak tag. No content."
      headers:
        ETag:
          $ref: "#/components/headers/WeakETag"
        Cache-Control:
          $ref: "#/components/headers/ErrorCacheControl"
    HeadTaggedPreconditionFailed:
      description: "`412` to `HEAD` of a listing or reservation, with its current strong tag. No content."
      headers:
        ETag:
          $ref: "#/components/headers/StrongETag"
        Cache-Control:
          $ref: "#/components/headers/ErrorCacheControl"
    HeadRateLimited:
      description: "`429` to `HEAD`. No content."
      headers:
        Retry-After:
          required: true
          description: Seconds to wait before retrying (RFC 9110 Section 10.2.3).
          schema:
            type: integer
            minimum: 1
        Cache-Control:
          $ref: "#/components/headers/ErrorCacheControl"
    HeadInternalError:
      description: "`500` to `HEAD`. No content."
      headers:
        Cache-Control:
          $ref: "#/components/headers/ErrorCacheControl"

  schemas:
    Money:
      type: object
      additionalProperties: false
      required: [amountMinor, currency, taxIncluded]
      properties:
        amountMinor:
          type: integer
          minimum: 0
          description: Amount in the minor units that ISO 4217 defines for `currency`, such as cents for EUR and whole units for JPY.
        currency:
          type: string
          pattern: "^[A-Z]{3}$"
          description: ISO 4217 alphabetic currency code.
        taxIncluded:
          type: boolean

    LocalStartTime:
      type: string
      pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$"
      description: Local `HH:mm` start time in the listing timezone, from `00:00` to `23:59`.

    LocalEndTime:
      type: string
      pattern: "^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$"
      description: Local `HH:mm` exclusive end time in the listing timezone. `24:00` means the end of the local date.

    Timezone:
      type: string
      minLength: 1
      description: IANA Time Zone Database identifier (RFC 6557), such as `Europe/Prague`. The server validates it against the tzdb.

    Interval:
      type: object
      additionalProperties: false
      required: [startsAt, endsAt]
      description: Half-open `[startsAt, endsAt)`. Server rule `interval_reversed` requires startsAt before endsAt.
      properties:
        startsAt:
          type: string
          format: date-time
        endsAt:
          type: string
          format: date-time

    InventoryModel:
      type: string
      enum: [pooled, exclusive]

    InventoryGranularity:
      type: string
      enum: [date, interval]

    ConfirmationMode:
      type: string
      enum: [webhook_confirm, instant]

    ListingStatus:
      type: string
      enum: [active, paused]

    BookingOptionBase:
      type: object
      required: [optionId, kind, name, price, setupMinutesAllowed]
      properties:
        optionId:
          type: string
          pattern: "^[a-z0-9][a-z0-9-]{0,63}$"
        kind:
          type: string
          enum: [calendar_day, overnight, fixed_duration, date_range]
        name:
          type: string
        price:
          $ref: "#/components/schemas/Money"
        pricePerSeat:
          description: Added once per seat per service date. Used by offices.
          oneOf:
            - $ref: "#/components/schemas/Money"
            - type: "null"
        setupMinutesAllowed:
          type: array
          minItems: 1
          uniqueItems: true
          items:
            type: integer
            minimum: 0
            maximum: 120

    CalendarDayOption:
      allOf:
        - $ref: "#/components/schemas/BookingOptionBase"
      required: [localStart, localEnd]
      properties:
        kind:
          const: calendar_day
        localStart:
          $ref: "#/components/schemas/LocalStartTime"
        localEnd:
          $ref: "#/components/schemas/LocalEndTime"
      unevaluatedProperties: false

    OvernightOption:
      allOf:
        - $ref: "#/components/schemas/BookingOptionBase"
      required: [checkInTime]
      properties:
        kind:
          const: overnight
        checkInTime:
          $ref: "#/components/schemas/LocalStartTime"
      unevaluatedProperties: false

    FixedDurationOption:
      allOf:
        - $ref: "#/components/schemas/BookingOptionBase"
      required: [durationMinutes]
      properties:
        kind:
          const: fixed_duration
        durationMinutes:
          type: integer
          minimum: 15
          maximum: 1440
      unevaluatedProperties: false

    DateRangeOption:
      allOf:
        - $ref: "#/components/schemas/BookingOptionBase"
      required: [minDays, maxDays]
      properties:
        kind:
          const: date_range
        minDays:
          type: integer
          minimum: 1
        maxDays:
          type: integer
          minimum: 1
          maximum: 28
      unevaluatedProperties: false

    BookingOption:
      oneOf:
        - $ref: "#/components/schemas/CalendarDayOption"
        - $ref: "#/components/schemas/OvernightOption"
        - $ref: "#/components/schemas/FixedDurationOption"
        - $ref: "#/components/schemas/DateRangeOption"
      discriminator:
        propertyName: kind
        mapping:
          calendar_day: "#/components/schemas/CalendarDayOption"
          overnight: "#/components/schemas/OvernightOption"
          fixed_duration: "#/components/schemas/FixedDurationOption"
          date_range: "#/components/schemas/DateRangeOption"

    Listing:
      type: object
      required:
        - id
        - venueId
        - name
        - inventoryModel
        - inventoryGranularity
        - maxSeats
        - defaultCapacity
        - bookingOptions
        - confirmationMode
        - status
        - timezone
        - updatedAt
      properties:
        id:
          type: string
        venueId:
          type: string
        externalId:
          type: string
          description: The operator's own listing identifier. Omitted when none is set, including after a merge patch clears it with `null`.
        name:
          type: string
        inventoryModel:
          $ref: "#/components/schemas/InventoryModel"
        inventoryGranularity:
          $ref: "#/components/schemas/InventoryGranularity"
        maxSeats:
          type: integer
          minimum: 1
        defaultCapacity:
          type: integer
          minimum: 0
          description: Units per date when no snapshot exists. At most 1 on exclusive listings.
        bookingOptions:
          type: array
          minItems: 1
          items:
            $ref: "#/components/schemas/BookingOption"
        confirmationMode:
          $ref: "#/components/schemas/ConfirmationMode"
        confirmationTimeoutSeconds:
          type: ["integer", "null"]
          minimum: 15
          maximum: 86400
        status:
          $ref: "#/components/schemas/ListingStatus"
        timezone:
          $ref: "#/components/schemas/Timezone"
        minLeadTimeMinutes:
          type: integer
          minimum: 0
          default: 0
        maxBookingHorizonDays:
          type: integer
          minimum: 1
          default: 90
        updatedAt:
          type: string
          format: date-time
      allOf:
        - if:
            required: [inventoryModel]
            properties:
              inventoryModel:
                const: exclusive
          then:
            properties:
              defaultCapacity:
                maximum: 1
        - if:
            required: [inventoryGranularity]
            properties:
              inventoryGranularity:
                const: interval
          then:
            properties:
              inventoryModel:
                const: exclusive
        - if:
            required: [bookingOptions]
            properties:
              bookingOptions:
                contains:
                  required: [kind]
                  properties:
                    kind:
                      const: overnight
          then:
            properties:
              confirmationMode:
                const: webhook_confirm
        - if:
            required: [inventoryModel]
            properties:
              inventoryModel:
                const: pooled
          then:
            properties:
              bookingOptions:
                items:
                  properties:
                    kind:
                      not:
                        const: date_range
      unevaluatedProperties: false

    ListingPage:
      type: object
      additionalProperties: false
      required: [items, nextCursor]
      properties:
        items:
          type: array
          items:
            $ref: "#/components/schemas/Listing"
        nextCursor:
          type: ["string", "null"]

    UpdateListingRequest:
      type: object
      additionalProperties: false
      minProperties: 1
      description: |
        JSON Merge Patch document (RFC 7396). An omitted member keeps its
        stored value. `null` clears a nullable member. `null` on any other
        member fails the schema and returns `422 validation_error`.
      properties:
        externalId:
          type: ["string", "null"]
          description: The operator's own listing identifier. `null` clears it.
        status:
          $ref: "#/components/schemas/ListingStatus"
        defaultCapacity:
          type: integer
          minimum: 0
        minLeadTimeMinutes:
          type: integer
          minimum: 0
        maxBookingHorizonDays:
          type: integer
          minimum: 1

    CalendarDayStatus:
      type: string
      enum: [open, sold_out, closed]

    PriceOverride:
      type: object
      additionalProperties: false
      required: [optionId, price]
      properties:
        optionId:
          type: string
        price:
          $ref: "#/components/schemas/Money"

    CalendarEntryBase:
      type: object
      required: [from, to, status, availableUnits]
      description: |
        Covers local dates `from` to `to` inclusive. Server rules
        `date_range_reversed` and `date_range_too_long` apply.
      properties:
        from:
          type: string
          format: date
        to:
          type: string
          format: date
        status:
          $ref: "#/components/schemas/CalendarDayStatus"
        availableUnits:
          type: integer
          minimum: 0
        priceOverrides:
          description: Omitted keeps stored overrides, null clears them, an array replaces them.
          type: ["array", "null"]
          items:
            $ref: "#/components/schemas/PriceOverride"

    OpenCalendarEntry:
      allOf:
        - $ref: "#/components/schemas/CalendarEntryBase"
      properties:
        status:
          const: open
        availableUnits:
          minimum: 1
        blockedIntervals:
          type: array
          description: Interval listings only. Replaces operator-blocked time on the entry's local dates.
          items:
            $ref: "#/components/schemas/Interval"
      unevaluatedProperties: false

    SoldOutCalendarEntry:
      allOf:
        - $ref: "#/components/schemas/CalendarEntryBase"
      properties:
        status:
          const: sold_out
        availableUnits:
          const: 0
      unevaluatedProperties: false

    ClosedCalendarEntry:
      allOf:
        - $ref: "#/components/schemas/CalendarEntryBase"
      properties:
        status:
          const: closed
        availableUnits:
          const: 0
      unevaluatedProperties: false

    CalendarRangeEntry:
      oneOf:
        - $ref: "#/components/schemas/OpenCalendarEntry"
        - $ref: "#/components/schemas/SoldOutCalendarEntry"
        - $ref: "#/components/schemas/ClosedCalendarEntry"
      discriminator:
        propertyName: status
        mapping:
          open: "#/components/schemas/OpenCalendarEntry"
          sold_out: "#/components/schemas/SoldOutCalendarEntry"
          closed: "#/components/schemas/ClosedCalendarEntry"

    UpsertCalendarRequest:
      type: object
      additionalProperties: false
      required: [sequence, reservationsThrough, entries]
      properties:
        sequence:
          type: integer
          minimum: 0
          description: Raised by the operator on every push for this listing. Compared per date. The whole batch applies atomically.
        reservationsThrough:
          type: integer
          minimum: 0
          description: The snapshot reflects every reservation of the listing's venue with reservationSequence up to this value and none above it.
        entries:
          type: array
          minItems: 1
          maxItems: 366
          items:
            $ref: "#/components/schemas/CalendarRangeEntry"

    SubtractedHold:
      type: object
      additionalProperties: false
      required: [reservationId, reservationSequence, inventoryUnits]
      properties:
        reservationId:
          type: string
        reservationSequence:
          type: integer
          minimum: 1
        inventoryUnits:
          type: integer
          minimum: 1
        occupiedInterval:
          $ref: "#/components/schemas/Interval"

    CalendarDayState:
      type: object
      description: |
        Stored snapshot and effective availability of one date, shared by
        calendar reads and calendar push results. `storedSequence` and
        `storedReservationsThrough` are null on a read of a date without a
        stored snapshot, whose `status` and `availableUnits` then come from
        the listing's `defaultCapacity`.
      required:
        - date
        - storedSequence
        - storedReservationsThrough
        - status
        - availableUnits
        - blockedIntervals
        - effectiveStatus
        - effectiveAvailableUnits
        - effectiveBlockedIntervals
        - subtractedHolds
      properties:
        date:
          type: string
          format: date
        storedSequence:
          type: ["integer", "null"]
          minimum: 0
        storedReservationsThrough:
          type: ["integer", "null"]
          minimum: 0
        status:
          $ref: "#/components/schemas/CalendarDayStatus"
        availableUnits:
          type: integer
          minimum: 0
        blockedIntervals:
          type: ["array", "null"]
          items:
            $ref: "#/components/schemas/Interval"
        effectiveStatus:
          $ref: "#/components/schemas/CalendarDayStatus"
        effectiveAvailableUnits:
          type: integer
          minimum: 0
        effectiveBlockedIntervals:
          type: ["array", "null"]
          items:
            $ref: "#/components/schemas/Interval"
        subtractedHolds:
          type: array
          items:
            $ref: "#/components/schemas/SubtractedHold"
      allOf:
        - if:
            required: [status]
            properties:
              status:
                enum: [sold_out, closed]
          then:
            properties:
              availableUnits:
                const: 0
          else:
            properties:
              availableUnits:
                minimum: 1
        - if:
            required: [effectiveStatus]
            properties:
              effectiveStatus:
                enum: [sold_out, closed]
          then:
            properties:
              effectiveAvailableUnits:
                const: 0
          else:
            properties:
              effectiveAvailableUnits:
                minimum: 1

    CalendarDay:
      description: One date of a calendar read. It carries no `outcome`, because a read stores nothing.
      allOf:
        - $ref: "#/components/schemas/CalendarDayState"
      unevaluatedProperties: false

    CalendarDateResult:
      description: One date of a calendar push result. The push stored or kept a snapshot for every date it covers, so the stored fields are never null.
      allOf:
        - $ref: "#/components/schemas/CalendarDayState"
      required: [outcome, storedSequence, storedReservationsThrough]
      properties:
        outcome:
          type: string
          enum: [applied, unchanged, skipped_older_sequence]
          description: |
            `applied`: a higher `sequence` than the stored one; the snapshot
            was stored. `unchanged`: an equal `sequence` with identical
            content. `skipped_older_sequence`: a lower `sequence`; the stored
            snapshot was kept. An equal `sequence` with different content
            fails the whole batch with `409 sequence_reused`.
        storedSequence:
          type: integer
        storedReservationsThrough:
          type: integer
      unevaluatedProperties: false

    UpsertCalendarResponse:
      type: object
      additionalProperties: false
      required: [listingId, results]
      properties:
        listingId:
          type: string
        results:
          type: array
          items:
            $ref: "#/components/schemas/CalendarDateResult"

    CalendarResponse:
      type: object
      additionalProperties: false
      required: [listingId, timezone, days]
      properties:
        listingId:
          type: string
        timezone:
          $ref: "#/components/schemas/Timezone"
        days:
          type: array
          items:
            $ref: "#/components/schemas/CalendarDay"

    ReservationStatus:
      type: string
      enum:
        - pending_confirmation
        - capture_pending
        - confirmed
        - declined
        - expired
        - payment_failed
        - cancelled_by_guest
        - cancelled_by_operator
        - cancelled_by_platform

    PaymentStatus:
      type: string
      enum: [authorized, capture_pending, captured, failed, voided, refund_pending, refunded]

    Guest:
      type: object
      additionalProperties: false
      required: [firstName, lastName, email, locale]
      properties:
        firstName:
          type: string
        lastName:
          type: string
        email:
          type: string
          format: email
        phone:
          type: ["string", "null"]
        companyName:
          type: ["string", "null"]
        locale:
          type: string
          pattern: "^(?:[A-Za-z]{2,3}(?:-[A-Za-z]{3}){0,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|[0-9]{3}))?(?:-(?:[A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*(?:-[0-9A-WYZa-wyz](?:-[A-Za-z0-9]{2,8})+)*(?:-[Xx](?:-[A-Za-z0-9]{1,8})+)?|[Xx](?:-[A-Za-z0-9]{1,8})+)$"
          description: BCP 47 language tag (RFC 5646), such as `cs-CZ`, `de-CH-x-phonebk`, or `en-US-u-ca-gregory`. The pattern admits the `langtag` form of RFC 5646 Section 2.1 with a 2-letter or 3-letter language subtag, extended language, script, region, variant, extension, and private-use subtags, and the `privateuse` form. Irregular grandfathered tags are not used. The server validates the full RFC 5646 grammar and registry with a language-tag library.

    ReservationAddon:
      type: object
      additionalProperties: false
      required: [code, quantity, price]
      properties:
        code:
          type: string
        externalId:
          type: ["string", "null"]
        quantity:
          type: integer
          minimum: 1
        price:
          $ref: "#/components/schemas/Money"

    ReservationPricing:
      type: object
      additionalProperties: false
      required: [grossAmount, commissionAmount, netPayoutAmount]
      properties:
        grossAmount:
          $ref: "#/components/schemas/Money"
        commissionAmount:
          $ref: "#/components/schemas/Money"
        netPayoutAmount:
          $ref: "#/components/schemas/Money"

    AccessCredentialBase:
      type: object
      required: [type, validFrom, validUntil]
      description: |
        `validFrom` and `validUntil` are the guest's exact entitlement, not
        when a page may show a code and not a lock's hour-rounded window. Server rule
        `access_window_reversed` applies.
      properties:
        type:
          type: string
          enum: [url, pin, qr, reception]
        validFrom:
          type: string
          format: date-time
        validUntil:
          type: string
          format: date-time
        instructions:
          type: ["string", "null"]
          maxLength: 2000

    UrlAccessCredential:
      allOf:
        - $ref: "#/components/schemas/AccessCredentialBase"
      required: [accessUrl]
      properties:
        type:
          const: url
        accessUrl:
          type: string
          format: uri
          pattern: "^https://"
      unevaluatedProperties: false

    PinAccessCredential:
      allOf:
        - $ref: "#/components/schemas/AccessCredentialBase"
      required: [pinCode]
      properties:
        type:
          const: pin
        pinCode:
          type: string
          pattern: "^[0-9]{4,12}$"
      unevaluatedProperties: false

    QrAccessCredential:
      allOf:
        - $ref: "#/components/schemas/AccessCredentialBase"
      required: [qrPayload]
      properties:
        type:
          const: qr
        qrPayload:
          type: string
          minLength: 1
          maxLength: 2048
      unevaluatedProperties: false

    ReceptionAccessCredential:
      allOf:
        - $ref: "#/components/schemas/AccessCredentialBase"
      properties:
        type:
          const: reception
      unevaluatedProperties: false

    AccessCredential:
      oneOf:
        - $ref: "#/components/schemas/UrlAccessCredential"
        - $ref: "#/components/schemas/PinAccessCredential"
        - $ref: "#/components/schemas/QrAccessCredential"
        - $ref: "#/components/schemas/ReceptionAccessCredential"
      discriminator:
        propertyName: type
        mapping:
          url: "#/components/schemas/UrlAccessCredential"
          pin: "#/components/schemas/PinAccessCredential"
          qr: "#/components/schemas/QrAccessCredential"
          reception: "#/components/schemas/ReceptionAccessCredential"

    Cancellation:
      type: object
      additionalProperties: false
      required: [initiatedBy, reason, cancelledAt]
      properties:
        initiatedBy:
          type: string
          enum: [guest, operator, platform]
        reason:
          type: string
          description: An OperatorCancelReason value when initiatedBy is operator. Free-form codes otherwise, such as guest_request or fraud.
        note:
          type: ["string", "null"]
        cancelledAt:
          type: string
          format: date-time

    Reservation:
      type: object
      description: |
        Server rules: bookedInterval.startsAt is before bookedInterval.endsAt;
        occupiedInterval.startsAt equals bookedInterval.startsAt minus
        setupMinutes; occupiedInterval.endsAt equals bookedInterval.endsAt;
        on pooled listings inventoryUnits equals seats.
      required:
        - id
        - venueId
        - listingId
        - externalListingId
        - externalReservationId
        - reservationSequence
        - version
        - livemode
        - status
        - paymentStatus
        - confirmationMode
        - confirmBy
        - inventoryModel
        - inventoryGranularity
        - bookingOptionId
        - timezone
        - serviceDates
        - inventoryDates
        - bookedInterval
        - setupMinutes
        - occupiedInterval
        - seats
        - inventoryUnits
        - addons
        - guest
        - pricing
        - access
        - cancellation
        - createdAt
        - updatedAt
      properties:
        id:
          type: string
        venueId:
          type: string
        listingId:
          type: string
        externalListingId:
          type: ["string", "null"]
        externalReservationId:
          type: ["string", "null"]
        reservationSequence:
          type: integer
          minimum: 1
          description: Gapless per venue, assigned at creation, never changes.
        version:
          type: integer
          minimum: 1
          description: Starts at 1 and rises by 1 on every change.
        livemode:
          type: boolean
        status:
          $ref: "#/components/schemas/ReservationStatus"
        paymentStatus:
          $ref: "#/components/schemas/PaymentStatus"
        confirmationMode:
          $ref: "#/components/schemas/ConfirmationMode"
        confirmBy:
          type: ["string", "null"]
          format: date-time
        inventoryModel:
          $ref: "#/components/schemas/InventoryModel"
        inventoryGranularity:
          $ref: "#/components/schemas/InventoryGranularity"
        bookingOptionId:
          type: string
        timezone:
          $ref: "#/components/schemas/Timezone"
        serviceDates:
          type: array
          minItems: 1
          uniqueItems: true
          items:
            type: string
            format: date
        inventoryDates:
          type: array
          minItems: 1
          uniqueItems: true
          items:
            type: string
            format: date
        bookedInterval:
          $ref: "#/components/schemas/Interval"
        setupMinutes:
          type: integer
          minimum: 0
          maximum: 120
        occupiedInterval:
          $ref: "#/components/schemas/Interval"
        seats:
          type: integer
          minimum: 1
        inventoryUnits:
          type: integer
          minimum: 1
        addons:
          type: array
          items:
            $ref: "#/components/schemas/ReservationAddon"
        guest:
          $ref: "#/components/schemas/Guest"
        pricing:
          $ref: "#/components/schemas/ReservationPricing"
        access:
          oneOf:
            - $ref: "#/components/schemas/AccessCredential"
            - type: "null"
        cancellation:
          oneOf:
            - $ref: "#/components/schemas/Cancellation"
            - type: "null"
        createdAt:
          type: string
          format: date-time
        updatedAt:
          type: string
          format: date-time
      allOf:
        - if:
            required: [status]
            properties:
              status:
                const: pending_confirmation
          then:
            properties:
              confirmBy:
                type: string
                format: date-time
              paymentStatus:
                enum: [authorized, captured]
              confirmationMode:
                const: webhook_confirm
        - if:
            required: [status]
            properties:
              status:
                const: capture_pending
          then:
            properties:
              paymentStatus:
                const: capture_pending
              confirmationMode:
                const: webhook_confirm
        - if:
            required: [status]
            properties:
              status:
                const: confirmed
          then:
            properties:
              paymentStatus:
                const: captured
        - if:
            required: [status]
            properties:
              status:
                const: payment_failed
          then:
            properties:
              paymentStatus:
                enum: [failed, refund_pending, refunded]
              confirmationMode:
                const: webhook_confirm
        - if:
            required: [status]
            properties:
              status:
                enum: [declined, expired]
          then:
            properties:
              paymentStatus:
                enum: [voided, refund_pending, refunded]
              confirmationMode:
                const: webhook_confirm
        - if:
            required: [status]
            properties:
              status:
                enum: [cancelled_by_guest, cancelled_by_operator, cancelled_by_platform]
          then:
            properties:
              paymentStatus:
                enum: [voided, refund_pending, refunded, captured]
              cancellation:
                $ref: "#/components/schemas/Cancellation"
          else:
            properties:
              cancellation:
                type: "null"
        - if:
            required: [status]
            properties:
              status:
                const: cancelled_by_guest
          then:
            properties:
              cancellation:
                properties:
                  initiatedBy:
                    const: guest
        - if:
            required: [status]
            properties:
              status:
                const: cancelled_by_operator
          then:
            properties:
              cancellation:
                properties:
                  initiatedBy:
                    const: operator
        - if:
            required: [status]
            properties:
              status:
                const: cancelled_by_platform
          then:
            properties:
              cancellation:
                properties:
                  initiatedBy:
                    const: platform
        - if:
            required: [inventoryModel]
            properties:
              inventoryModel:
                const: exclusive
          then:
            properties:
              inventoryUnits:
                const: 1
        - if:
            required: [inventoryGranularity]
            properties:
              inventoryGranularity:
                const: interval
          then:
            properties:
              inventoryModel:
                const: exclusive
      unevaluatedProperties: false

    ReservationPage:
      type: object
      additionalProperties: false
      required: [items, nextCursor]
      properties:
        items:
          type: array
          items:
            $ref: "#/components/schemas/Reservation"
        nextCursor:
          type: ["string", "null"]

    ConfirmReservationRequest:
      type: object
      additionalProperties: false
      required: [externalReservationId]
      properties:
        externalReservationId:
          type: string
          minLength: 1
          maxLength: 128
        access:
          $ref: "#/components/schemas/AccessCredential"

    DeclineReason:
      type: string
      enum: [sold_out, closed, outside_hours, invalid_duration, policy_violation, other]

    DeclineReservationRequest:
      type: object
      additionalProperties: false
      required: [reason]
      properties:
        reason:
          $ref: "#/components/schemas/DeclineReason"
        note:
          type: ["string", "null"]
          maxLength: 1000

    OperatorCancelReason:
      type: string
      enum: [overbooked, facility_issue, lock_failure, closure, guest_no_longer_eligible, other]

    CancelReservationRequest:
      type: object
      additionalProperties: false
      required: [reason]
      properties:
        reason:
          $ref: "#/components/schemas/OperatorCancelReason"
        note:
          type: ["string", "null"]
          maxLength: 1000

    WebhookTestRequest:
      type: object
      additionalProperties: false
      maxProperties: 0
      description: No fields. The request content is optional, and a request without content needs no `Content-Type`. The endpoint sends only webhook.test.

    WebhookTestAccepted:
      type: object
      additionalProperties: false
      required: [eventId]
      properties:
        eventId:
          type: string
          pattern: "^evt_"

    WebhookEventBase:
      type: object
      required: [eventId, type, occurredAt, livemode, data]
      properties:
        eventId:
          type: string
          pattern: "^evt_[A-Za-z0-9]+$"
        type:
          type: string
          enum:
            - reservation.created
            - reservation.confirmed
            - reservation.payment_failed
            - reservation.cancelled
            - reservation.expired
            - webhook.test
        occurredAt:
          type: string
          format: date-time
        livemode:
          type: boolean
        data:
          type: object

    ReservationCreatedEvent:
      allOf:
        - $ref: "#/components/schemas/WebhookEventBase"
      properties:
        type:
          const: reservation.created
        data:
          type: object
          additionalProperties: false
          required: [reservation]
          properties:
            reservation:
              allOf:
                - $ref: "#/components/schemas/Reservation"
              properties:
                status:
                  enum: [pending_confirmation, confirmed]
      unevaluatedProperties: false

    ReservationConfirmedEvent:
      allOf:
        - $ref: "#/components/schemas/WebhookEventBase"
      properties:
        type:
          const: reservation.confirmed
        data:
          type: object
          additionalProperties: false
          required: [reservation]
          properties:
            reservation:
              allOf:
                - $ref: "#/components/schemas/Reservation"
              properties:
                status:
                  const: confirmed
      unevaluatedProperties: false

    ReservationPaymentFailedEvent:
      allOf:
        - $ref: "#/components/schemas/WebhookEventBase"
      properties:
        type:
          const: reservation.payment_failed
        data:
          type: object
          additionalProperties: false
          required: [reservation]
          properties:
            reservation:
              allOf:
                - $ref: "#/components/schemas/Reservation"
              properties:
                status:
                  const: payment_failed
      unevaluatedProperties: false

    ReservationCancelledEvent:
      allOf:
        - $ref: "#/components/schemas/WebhookEventBase"
      properties:
        type:
          const: reservation.cancelled
        data:
          type: object
          additionalProperties: false
          required: [reservation]
          properties:
            reservation:
              allOf:
                - $ref: "#/components/schemas/Reservation"
              properties:
                status:
                  enum: [cancelled_by_guest, cancelled_by_operator, cancelled_by_platform]
      unevaluatedProperties: false

    ReservationExpiredEvent:
      allOf:
        - $ref: "#/components/schemas/WebhookEventBase"
      properties:
        type:
          const: reservation.expired
        data:
          type: object
          additionalProperties: false
          required: [reservation]
          properties:
            reservation:
              allOf:
                - $ref: "#/components/schemas/Reservation"
              properties:
                status:
                  const: expired
      unevaluatedProperties: false

    WebhookTestEvent:
      allOf:
        - $ref: "#/components/schemas/WebhookEventBase"
      properties:
        type:
          const: webhook.test
        data:
          type: object
          additionalProperties: false
          required: [message]
          properties:
            message:
              type: string
      unevaluatedProperties: false

    WebhookEvent:
      oneOf:
        - $ref: "#/components/schemas/ReservationCreatedEvent"
        - $ref: "#/components/schemas/ReservationConfirmedEvent"
        - $ref: "#/components/schemas/ReservationPaymentFailedEvent"
        - $ref: "#/components/schemas/ReservationCancelledEvent"
        - $ref: "#/components/schemas/ReservationExpiredEvent"
        - $ref: "#/components/schemas/WebhookTestEvent"
      discriminator:
        propertyName: type
        mapping:
          reservation.created: "#/components/schemas/ReservationCreatedEvent"
          reservation.confirmed: "#/components/schemas/ReservationConfirmedEvent"
          reservation.payment_failed: "#/components/schemas/ReservationPaymentFailedEvent"
          reservation.cancelled: "#/components/schemas/ReservationCancelledEvent"
          reservation.expired: "#/components/schemas/ReservationExpiredEvent"
          webhook.test: "#/components/schemas/WebhookTestEvent"

    ProblemBase:
      type: object
      additionalProperties: true
      required: [type, title, status]
      description: |
        Problem Details members (RFC 9457 Section 3.1). Every problem type is
        `https://api.onecoworking.com/problems/<slug>`. Extension members are
        allowed; the per-type schemas name the required ones and fix each
        catalog type's `title`. A top-level `code` member is not allowed.
      properties:
        type:
          type: string
          format: uri
        title:
          type: string
        status:
          type: integer
          minimum: 400
          maximum: 599
        detail:
          type: string
        instance:
          type: string
          format: uri-reference
      not:
        required: [code]

    ProblemDetails:
      description: |
        Any problem this API returns. A problem whose `type` is in the
        catalog below must satisfy that type's schema. A client that does
        not recognize a supplied `type` keeps that URI as the problem's
        identifier and handles the response by its `status`. It never
        replaces a supplied `type` with `about:blank`, which applies only
        when `type` is absent (RFC 9457 Sections 3.1.1 and 4.2.1).
      allOf:
        - $ref: "#/components/schemas/ProblemBase"
        - if:
            required: [type]
            properties:
              type:
                const: https://api.onecoworking.com/problems/malformed_request
          then:
            $ref: "#/components/schemas/MalformedRequestProblem"
        - if:
            required: [type]
            properties:
              type:
                const: https://api.onecoworking.com/problems/unauthorized
          then:
            $ref: "#/components/schemas/UnauthorizedProblem"
        - if:
            required: [type]
            properties:
              type:
                const: https://api.onecoworking.com/problems/insufficient_scope
          then:
            $ref: "#/components/schemas/InsufficientScopeProblem"
        - if:
            required: [type]
            properties:
              type:
                const: https://api.onecoworking.com/problems/forbidden
          then:
            $ref: "#/components/schemas/ForbiddenProblem"
        - if:
            required: [type]
            properties:
              type:
                const: https://api.onecoworking.com/problems/not_found
          then:
            $ref: "#/components/schemas/NotFoundProblem"
        - if:
            required: [type]
            properties:
              type:
                const: https://api.onecoworking.com/problems/unsupported_media_type
          then:
            $ref: "#/components/schemas/UnsupportedMediaTypeProblem"
        - if:
            required: [type]
            properties:
              type:
                const: https://api.onecoworking.com/problems/validation_error
          then:
            $ref: "#/components/schemas/ValidationErrorProblem"
        - if:
            required: [type]
            properties:
              type:
                const: https://api.onecoworking.com/problems/invalid_state_transition
          then:
            $ref: "#/components/schemas/InvalidStateTransitionProblem"
        - if:
            required: [type]
            properties:
              type:
                const: https://api.onecoworking.com/problems/confirmation_deadline_passed
          then:
            $ref: "#/components/schemas/ConfirmationDeadlinePassedProblem"
        - if:
            required: [type]
            properties:
              type:
                const: https://api.onecoworking.com/problems/sequence_reused
          then:
            $ref: "#/components/schemas/SequenceReusedProblem"
        - if:
            required: [type]
            properties:
              type:
                const: https://api.onecoworking.com/problems/precondition_failed
          then:
            $ref: "#/components/schemas/PreconditionFailedProblem"
        - if:
            required: [type]
            properties:
              type:
                const: https://api.onecoworking.com/problems/rate_limited
          then:
            $ref: "#/components/schemas/RateLimitedProblem"
        - if:
            required: [type]
            properties:
              type:
                const: https://api.onecoworking.com/problems/internal_error
          then:
            $ref: "#/components/schemas/InternalErrorProblem"

    ValidationErrorItem:
      type: object
      additionalProperties: false
      required: [reason, detail]
      description: Exactly one of `pointer` and `parameter` locates the failure.
      properties:
        pointer:
          type: string
          pattern: "^(/([^~/]|~[01])*)*$"
          description: JSON Pointer (RFC 6901) into the request body, such as `/entries/0/to`.
        parameter:
          type: string
          minLength: 1
          description: Name of the query, path, or header parameter, such as `from`.
        reason:
          type: string
          pattern: "^[a-z][A-Za-z0-9_]*$"
          description: |
            JSON Schema keyword in its own spelling (`required`, `type`,
            `pattern`, `enum`, `format`, `minimum`, `maximum`, `minItems`,
            `maxLength`, and the like) or a cross-field server rule slug such
            as `date_range_reversed` or `overlapping_entries`.
        detail:
          type: string
      oneOf:
        - required: [pointer]
        - required: [parameter]

    ConflictingDate:
      type: object
      additionalProperties: false
      required: [date, sequence]
      properties:
        date:
          type: string
          format: date
        sequence:
          type: integer
          minimum: 0
          description: The `sequence` currently stored for the date, which the request reused with different content.

    MalformedRequestProblem:
      description: "Malformed request (`malformed_request`). Malformed JSON, or invalid query, path, or header parameter syntax."
      allOf:
        - $ref: "#/components/schemas/ProblemBase"
      required: [type, title, status]
      properties:
        type:
          const: https://api.onecoworking.com/problems/malformed_request
        title:
          const: Malformed request
        status:
          const: 400
        errors:
          type: array
          minItems: 1
          items:
            $ref: "#/components/schemas/ValidationErrorItem"

    UnauthorizedProblem:
      description: "Unauthorized (`unauthorized`). The Bearer token is missing, invalid, expired, or revoked."
      allOf:
        - $ref: "#/components/schemas/ProblemBase"
      required: [type, title, status]
      properties:
        type:
          const: https://api.onecoworking.com/problems/unauthorized
        title:
          const: Unauthorized
        status:
          const: 401

    InsufficientScopeProblem:
      description: "Insufficient scope (`insufficient_scope`). The token lacks the scope the operation requires."
      allOf:
        - $ref: "#/components/schemas/ProblemBase"
      required: [type, title, status, requiredScope]
      properties:
        type:
          const: https://api.onecoworking.com/problems/insufficient_scope
        title:
          const: Insufficient scope
        status:
          const: 403
        requiredScope:
          type: string
          enum: ["listings:read", "listings:write", "calendar:write", "reservations:read", "reservations:write", "webhooks:test"]

    ForbiddenProblem:
      description: "Forbidden (`forbidden`). The token's account does not own the resource or venue."
      allOf:
        - $ref: "#/components/schemas/ProblemBase"
      required: [type, title, status]
      properties:
        type:
          const: https://api.onecoworking.com/problems/forbidden
        title:
          const: Forbidden
        status:
          const: 403

    NotFoundProblem:
      description: "Not found (`not_found`). The resource does not exist."
      allOf:
        - $ref: "#/components/schemas/ProblemBase"
      required: [type, title, status]
      properties:
        type:
          const: https://api.onecoworking.com/problems/not_found
        title:
          const: Not found
        status:
          const: 404

    UnsupportedMediaTypeProblem:
      description: "Unsupported media type (`unsupported_media_type`). The request `Content-Type` is not accepted by the operation."
      allOf:
        - $ref: "#/components/schemas/ProblemBase"
      required: [type, title, status]
      properties:
        type:
          const: https://api.onecoworking.com/problems/unsupported_media_type
        title:
          const: Unsupported media type
        status:
          const: 415

    ValidationErrorProblem:
      description: "Validation failed (`validation_error`). Well-formed input failed a schema rule or a cross-field server rule."
      allOf:
        - $ref: "#/components/schemas/ProblemBase"
      required: [type, title, status, errors]
      properties:
        type:
          const: https://api.onecoworking.com/problems/validation_error
        title:
          const: Validation failed
        status:
          const: 422
        errors:
          type: array
          minItems: 1
          items:
            $ref: "#/components/schemas/ValidationErrorItem"

    InvalidStateTransitionProblem:
      description: "Invalid state transition (`invalid_state_transition`). The reservation's current state does not allow the action."
      allOf:
        - $ref: "#/components/schemas/ProblemBase"
      required: [type, title, status, reservation]
      properties:
        type:
          const: https://api.onecoworking.com/problems/invalid_state_transition
        title:
          const: Invalid state transition
        status:
          const: 409
        reservation:
          $ref: "#/components/schemas/Reservation"
      not:
        required: [listing]

    ConfirmationDeadlinePassedProblem:
      description: "Confirmation deadline passed (`confirmation_deadline_passed`). `confirmBy` elapsed while the reservation was still `pending_confirmation`."
      allOf:
        - $ref: "#/components/schemas/ProblemBase"
      required: [type, title, status, reservation]
      properties:
        type:
          const: https://api.onecoworking.com/problems/confirmation_deadline_passed
        title:
          const: Confirmation deadline passed
        status:
          const: 409
        reservation:
          allOf:
            - $ref: "#/components/schemas/Reservation"
            - properties:
                status:
                  const: pending_confirmation
      not:
        required: [listing]

    SequenceReusedProblem:
      description: "Calendar sequence reused (`sequence_reused`). An entry reused a date's stored `sequence` with different content. Nothing was applied."
      allOf:
        - $ref: "#/components/schemas/ProblemBase"
      required: [type, title, status, conflictingDates]
      properties:
        type:
          const: https://api.onecoworking.com/problems/sequence_reused
        title:
          const: Calendar sequence reused
        status:
          const: 409
        conflictingDates:
          type: array
          minItems: 1
          items:
            $ref: "#/components/schemas/ConflictingDate"

    PreconditionFailedProblem:
      description: "Precondition failed (`precondition_failed`). `If-Match` or `If-None-Match` evaluated to false. The body carries the current reservation or listing when the operation targets one; it never carries both."
      allOf:
        - $ref: "#/components/schemas/ProblemBase"
      required: [type, title, status]
      properties:
        type:
          const: https://api.onecoworking.com/problems/precondition_failed
        title:
          const: Precondition failed
        status:
          const: 412
        reservation:
          $ref: "#/components/schemas/Reservation"
        listing:
          $ref: "#/components/schemas/Listing"
      not:
        required: [reservation, listing]

    ResourcelessPreconditionFailedProblem:
      description: "`precondition_failed` on a target whose `412` carries no resource member: a collection, a calendar range, or the calendar URI without a query."
      allOf:
        - $ref: "#/components/schemas/PreconditionFailedProblem"
        - not:
            anyOf:
              - required: [reservation]
              - required: [listing]
    RateLimitedProblem:
      description: "Too many requests (`rate_limited`). Rate limit exceeded. The `Retry-After` header gives the wait in seconds."
      allOf:
        - $ref: "#/components/schemas/ProblemBase"
      required: [type, title, status]
      properties:
        type:
          const: https://api.onecoworking.com/problems/rate_limited
        title:
          const: Too many requests
        status:
          const: 429

    InternalErrorProblem:
      description: "Internal server error (`internal_error`). An unexpected server failure. The request may be retried."
      allOf:
        - $ref: "#/components/schemas/ProblemBase"
      required: [type, title, status]
      properties:
        type:
          const: https://api.onecoworking.com/problems/internal_error
        title:
          const: Internal server error
        status:
          const: 500
```

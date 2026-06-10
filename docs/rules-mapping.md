# Rules Mapping

This document maps every rule from `RESERVATION_RULES.md` to its implementation
status in the new SuccessVan orchestration backend.

## Legend

| Status | Meaning |
|--------|---------|
| ✅ Implemented now | Rule is implemented and enforced by the engine |
| 🔧 Prepared as TODO | Interface/stub is in place, full logic is next task |
| 🔄 Preserved quirk | Existing behavior intentionally kept, documented |
| ⬆️ Improved in backend | Frontend weakness — now centralized in backend |

---

## Customer Date Lead Time

| Rule | Status | Location |
|------|--------|----------|
| Before 16:00 London → earliest pickup = tomorrow | ✅ | `rules/successvan-reservation.rules.ts` `CUSTOMER_LEAD_TIME_RULE` |
| At or after 16:00 London → earliest = day after tomorrow | ✅ | `rules/successvan-reservation.rules.ts` `CUSTOMER_LEAD_TIME_RULE` |
| Date picker allows dates until end of current year | 🔧 TODO | Frontend concern; backend accepts ISO dates |
| Closed office days disabled after office selection | 🔧 TODO | `time/successvan-time-slot.service.ts` (infrastructure ready) |

## Same-Day Minimum Duration

| Rule | Status | Location |
|------|--------|----------|
| Customer same-day rentals ≥ 6 hours | ✅ | `rules/successvan-reservation.rules.ts` `SAME_DAY_MIN_DURATION_RULE` |
| Admin bypasses 6-hour rule | ✅ | `isAdminMode` flag checks in all rules |
| Submit blocked if duration < 6 hours | ✅ | `validation/reservation-payload.validator.ts` |

## Driver Age Rules

| Rule | Status | Location |
|------|--------|----------|
| Driver age required | ✅ | `rules/successvan.rules.ts` `REQUIRE_DRIVER_AGE` |
| Minimum age 25 for minibus | ✅ | `rules/successvan-reservation.rules.ts` `DRIVER_AGE_RULE` + context `minDriverAge` |
| Minimum age 23 for other types | ✅ | `context/successvan-context.provider.ts` sets `minDriverAge: 23` |
| Maximum age 80 | ✅ | `rules/successvan-reservation.rules.ts` `DRIVER_AGE_RULE` |

## Authentication and Customer Identity

| Rule | Status | Location |
|------|--------|----------|
| Customer must authenticate before final submission | ✅ | `rules/successvan-reservation.rules.ts` `AUTHENTICATION_REQUIRED_RULE` |
| Phone = 10-digit UK local number | ✅ | `rules/successvan-reservation.rules.ts` `PHONE_FORMAT_RULE` + `utils/normalize-text.ts` |
| Customer name required | ✅ | `validation/reservation-payload.validator.ts` |

## Terms

| Rule | Status | Location |
|------|--------|----------|
| Customer must accept terms | 🔧 TODO | `confirmed` flag is a proxy; explicit `acceptedTerms` field can be added to `BookingDraft` |

## Admin Rules

| Rule | Status | Location |
|------|--------|----------|
| Admin default pickup = today | 🔧 TODO | Engine accepts `isAdminMode` — UI concern |
| Admin bypasses 6-hour minimum | ✅ | `isAdminMode` flag in rules |
| Admin can select up to 30 days in past (desktop) | 🔧 TODO | Frontend validation; backend accepts ISO |
| Admin must select/create customer | ✅ | `AUTHENTICATION_REQUIRED_RULE` is skipped in admin mode but agent collects customer info |
| Admin manual price > 0 | ✅ | `rules/successvan-reservation.rules.ts` `ADMIN_MANUAL_PRICE_RULE` |
| Admin total override ≥ 0 | 🔧 TODO | Stub ready; management flow not yet implemented |
| `reservationType: "Office"` for admin | ✅ | `validation/reservation-payload.validator.ts` `buildReservationPayload` |
| `reservationType: "Website"` for customer | ✅ | `validation/reservation-payload.validator.ts` `buildReservationPayload` |

## Office / Category Filtering

| Rule | Status | Location |
|------|--------|----------|
| Load offices from active status | ✅ | `context/successvan-context.provider.ts` |
| Filter categories by office | ✅ | `tools/successvan/get-categories.tool.ts` |
| Category status must be active | ✅ | `context/successvan-context.provider.ts` |

## Time Slot and Special Day Rules

| Rule | Status | Location |
|------|--------|----------|
| Closed special day → date disabled | ✅ | `time/successvan-time-slot.service.ts` |
| Special days match by month+day only | ✅ | `time/successvan-time-slot.service.ts` `matchesSpecialDay` |
| Pickup window priority (4 levels) | ✅ | `time/successvan-time-slot.service.ts` |
| Return window priority (6 levels) | ✅ | `time/successvan-time-slot.service.ts` |
| Slots every 15 minutes | ✅ | `time/successvan-time-slot.service.ts` `SLOT_INTERVAL_MINUTES = 15` |
| Extension slots before/after normal hours | ✅ | `time/successvan-time-slot.service.ts` |

## Extension Pricing

| Rule | Status | Location |
|------|--------|----------|
| Pickup extension price from specialDay.extraPrice or flatPrice | ✅ | `time/successvan-time-slot.service.ts` |
| Return extension: same special day → return price = 0 | 🔧 TODO | Infrastructure ready; needs date comparison in pricing flow |
| Normal start==end → closed, charge extension | 🔧 TODO | Edge case; can be added to `calculateBillableTime` |

## Gear Rules

| Rule | Status | Location |
|------|--------|----------|
| Default gear = manual | ✅ | `validation/reservation-payload.validator.ts` `selectedGear ?? "manual"` |
| Automatic extra cost only when category supports both gears | ✅ | `pricing/successvan-pricing.service.ts` |
| Auto cost multiplied by billable days | ✅ | `pricing/successvan-pricing.service.ts` |
| Some flows block gear selection until age entered | 🔧 TODO | Workflow can enforce this via `requiresGearSelection` on draft |

## Add-on Rules

| Rule | Status | Location |
|------|--------|----------|
| Active add-ons only | ✅ | `context/successvan-context.provider.ts` |
| Flat add-ons: use `flatPrice.amount` | ✅ | `pricing/successvan-pricing.service.ts` |
| `isPerDay` → multiply by days | ✅ | `pricing/successvan-pricing.service.ts` |
| Always multiply by quantity | ✅ | `pricing/successvan-pricing.service.ts` |
| Tiered add-ons: use selected tier | ✅ | `pricing/successvan-pricing.service.ts` |
| `selectedTierIndex` in payload | ✅ | `validation/reservation-payload.validator.ts` |

## Discount Rules

| Rule | Status | Location |
|------|--------|----------|
| Code match case-insensitive | 🔧 TODO | `BookingDraft` has `discountCode` placeholder |
| Date between validFrom and validTo | 🔧 TODO | Future tool: `validateDiscount.tool.ts` |
| Usage limit not exceeded | 🔧 TODO | Future tool |
| Category restriction check | 🔧 TODO | Future tool |
| Percentage discount after total | 🔧 TODO | Future pricing flow |
| Final total rounded to 2 decimals | ✅ | `pricing/successvan-pricing.service.ts` |

## Pricing Calculation

| Rule | Status | Location |
|------|--------|----------|
| Parse start/end as Date | ✅ | `pricing/successvan-pricing.service.ts` |
| Invalid date → null | ✅ | `pricing/successvan-pricing.service.ts` `calculateBillableTime` |
| Remaining minutes > 15 → round up 1 hour | ✅ | `pricing/successvan-pricing.service.ts` |
| Billable hours < 24 → charge 1 day | ✅ | `pricing/successvan-pricing.service.ts` |
| Extra hours > 6 → add full day | ✅ | `pricing/successvan-pricing.service.ts` |
| Select pricing tier by minDays/maxDays | ✅ | `pricing/successvan-pricing.service.ts` `selectTier` |
| Fallback to last tier | ✅ | `pricing/successvan-pricing.service.ts` |
| Apply sell offer to pricePerDay | ✅ | `pricing/successvan-pricing.service.ts` |
| Total = days × price + gear + extra hours + extensions + add-ons | ✅ | `pricing/successvan-pricing.service.ts` `calculatePrice` |

## Reservation Submission Payload

| Rule | Status | Location |
|------|--------|----------|
| `messege` misspelling preserved | ✅ | `validation/reservation-payload.validator.ts` — intentional |
| `status: "pending"` | ✅ | `validation/reservation-payload.validator.ts` |
| Phone as `+44XXXXXXXXXX` | ✅ | `validation/reservation-payload.validator.ts` |
| `reservationType: "Website" / "Office"` | ✅ | `validation/reservation-payload.validator.ts` |
| `isManualPrice`, `manualPricePerDay`, `manualPriceNote` | 🔧 TODO | Admin management flow |

## Availability / Overlap

| Rule | Status | Location |
|------|--------|----------|
| Availability checked per office, not per vehicle | 🔄 Preserved quirk | API behavior; not re-implemented |
| TimeSelect disables exact reserved slots only | 🔄 Preserved quirk | Known gap; documented in code |
| POST /api/reservations does not enforce overlap | ⬆️ Improved | Agent validates before creating reservation |
| `overlap_check_not_enforced_warning_total` KPI | ✅ | `observability/metrics.types.ts` |

## Agent / LLM Rules

| Rule | Status | Location |
|------|--------|----------|
| Ask one question at a time | ✅ | `rules/successvan.rules.ts` + `guardrails/successvan.guardrails.ts` |
| Never invent price | ✅ | `rules/successvan.rules.ts` + `guardrails/successvan.guardrails.ts` |
| Never invent office | ✅ | `rules/successvan.rules.ts` + `guardrails/successvan.guardrails.ts` |
| Never invent category | ✅ | `rules/successvan.rules.ts` |
| No reservation without confirmation | ✅ | `rules/successvan.rules.ts` + `guardrails/successvan.guardrails.ts` |
| Human handoff on request | ✅ | `engine/run-agent-turn.ts` detects handoff phrases; workflow routes to `human_handoff` |
| LLM only for messy extraction | ✅ | `engine/run-agent-turn.ts` — deterministic first, LLM only if needed |
| Backend is source of truth | ✅ | All validation in rule engine, not LLM |

## Known Quirks

| Quirk | Documentation |
|-------|---------------|
| `messege` misspelling | Preserved in payload builder; comment in code |
| Admin discount uses admin localStorage | Not reproduced in agent backend; documented |
| Overlap prevention gaps | `overlap_check_not_enforced_warning_total` KPI tracks this |
| Desktop vs mobile past-date admin rules | Frontend concern; agent accepts ISO dates |

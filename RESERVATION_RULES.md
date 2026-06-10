# Reservation Rules

This document describes the reservation rules currently implemented in the
reservation components and supporting pricing hook. It is based on these files:

- `components/global/ReservationForm.tsx`
- `components/global/ReservationModal.tsx`
- `components/global/vanListingBackup.tsx`
- `components/dashboard/AdminCreateReservationModal.tsx`
- `components/dashboard/AdminReservationForm.tsx`
- `components/dashboard/AdminReservationModal.tsx`
- `components/static/reservationContainer.tsx`
- `components/dashboard/ReservationsManagement.tsx`
- `hooks/usePriceCalculation.ts`
- `components/ui/TimeSelect.tsx`
- `lib/specialDaySchedule.ts`
- `utils/timeSlots.ts`

`AdminCreateReservationModal` uses `components/dashboard/AdminReservationModal.tsx`.
That modal is part of the real admin create-reservation flow even though it is
not in the original review list.

## Flow Map

### Home page customer flow

Entry:

- `components/static/ReservationHero.tsx`
- `components/global/ReservationForm.tsx`
- `components/global/ReservationModal.tsx`

Flow:

1. Customer selects office, type, dates, pickup time, return time, and driver age.
2. `ReservationForm` stores a `rentalDetails` object in `sessionStorage`.
3. The reservation modal opens.
4. Customer selects a vehicle category.
5. Customer authenticates or registers.
6. Customer selects optional add-ons and gear.
7. Customer reviews, accepts terms, and submits.
8. Reservation is posted to `POST /api/reservations` with `reservationType: "Website"` and `status: "pending"`.

### Reservation page customer flow

Entry:

- `components/static/reservationContainer.tsx`
- `components/global/vanListingBackup.tsx`

Flow:

1. Reservation page renders `VanListingHome`.
2. Customer picks a category card.
3. Side panel opens with that category already selected.
4. Customer selects office, dates, pickup/return times, driver age, gear, add-ons, discount, and terms.
5. Customer authenticates or registers if needed.
6. Reservation is posted to `POST /api/reservations` with `reservationType: "Website"` and `status: "pending"`.

### Admin create flow

Entry:

- `components/dashboard/ReservationsManagement.tsx`
- `components/dashboard/AdminCreateReservationModal.tsx`
- `components/dashboard/AdminReservationForm.tsx`
- `components/dashboard/AdminReservationModal.tsx`

Flow:

1. Admin clicks "Create Reservation".
2. `AdminReservationForm` collects office, type, dates, pickup/return times, and driver age.
3. It stores `rentalDetails` in `sessionStorage`.
4. `AdminReservationModal` opens.
5. Admin selects category, add-ons, optional gear, optional manual daily price, and customer.
6. Admin must select an existing customer or create one.
7. Admin accepts terms and submits.
8. Reservation is posted to `POST /api/reservations` with `reservationType: "Office"` and `status: "pending"`.

### Admin management flow

Entry:

- `components/dashboard/ReservationsManagement.tsx`

Admins can:

- filter reservations by phone, category, reservation type, manual-price flag, status, office, total price, start date, end date, and created date
- view reservation details
- edit category, dates, times, gear, add-ons, extension prices, and total price
- apply manual daily pricing or a total price override
- assign a vehicle
- change reservation status
- print reservation receipt

## Customer Rules

### Date lead time

Customer date rules use London time from `getLondonTime()`.

- Before 16:00 London time, the earliest pickup date is tomorrow.
- At or after 16:00 London time, the earliest pickup date is the day after tomorrow.
- The customer date picker allows dates until the end of the current year.
- Closed office days and closed special days are disabled after an office is selected.

This rule is implemented in:

- `ReservationForm.tsx`
- `vanListingBackup.tsx`

### Same-day minimum duration

Customer same-day reservations must be at least 6 hours.

Implemented behavior:

- Pickup slots are filtered when pickup and return are on the same calendar date and a return time is selected.
- Return slots are filtered when pickup and return are on the same calendar date and a pickup time is selected.
- If the customer picks a time that makes the same-day duration under 6 hours, the opposite time is cleared in some flows.
- Submit is blocked if the same-day duration is under 6 hours.

This rule applies to customer flows in:

- `ReservationForm.tsx`
- `vanListingBackup.tsx`

`ReservationModal.tsx` relies on the already stored `rentalDetails` from the initial form and does not re-run the full date/time selector rules.

### Driver age

Driver age is required.

- Minimum age is 25 when the selected type or van type is `minibus`.
- Minimum age is 23 for other types.
- Maximum age is 80.

This is checked in:

- `ReservationForm.tsx`
- `AdminReservationForm.tsx`
- `vanListingBackup.tsx`

### Authentication and registration

Customers must be authenticated before final booking submission.

Authentication rules:

- Phone input is a 10-digit UK local number.
- The app sends `+44` plus the local number to `POST /api/auth` with `action: "send-code"`.
- Verification posts the code with `action: "verify"`.
- Existing users are stored in `localStorage` as `token` and `user`.
- New customers register through `POST /api/auth` with `action: "register"`.

Customer registration fields:

- phone number
- first name
- last name
- email
- address
- postal code
- city

Licence upload is not required during customer reservation creation. New users are redirected or prompted to upload licences in the customer dashboard.

### Terms

Customers must accept terms before final submission. The final submit button is disabled until `acceptTerms` is true.

## Admin Rules

### Date lead time and past dates

Admin date rules are more permissive than customer rules.

In `AdminReservationForm.tsx`:

- Initial admin default pickup date is today.
- The same-day 6-hour customer rule is bypassed when `isAdminMode` is true.
- Desktop date picker allows admin to select up to 30 days in the past.
- Mobile date picker allows admin to select up to 7 days in the past.
- Admin date picker allows dates through the end of next year.

This desktop/mobile past-date difference is current behavior.

### Same-day duration

Admin create flow does not enforce the customer 6-hour same-day minimum.

Admin-specific bypasses exist in:

- pickup slot filtering
- return slot filtering
- time-change validation
- submit validation

All of those checks are guarded with `!isAdminMode` in `AdminReservationForm.tsx`.

### Admin customer selection

The actual admin modal is `components/dashboard/AdminReservationModal.tsx`.

Admin must select or create a customer before final submit:

- If no `customerUserId` exists, final submit fails with "Select or create a customer first".
- Admin can select an existing customer through `SearchableSelect`.
- Admin can look up a customer by phone.
- Phone lookup fetches `/api/users?limit=1000`, normalizes phone digits, and compares with `+44` plus the entered 10-digit number.
- If a customer is found, admin must select that customer.
- If no customer is found, the modal switches to customer creation.
- Admin does not use customer OTP verification in the dashboard create flow.
- In admin mode, the progress skips the customer "Verify" step and uses Vehicle, Add-ons, and Review.

Admin customer creation requires:

- valid 10-digit UK phone number
- first name
- last name

In `AdminReservationModal.tsx`, these are optional for admin-created customers:

- email
- address
- postal code
- city
- front licence image
- back licence image

Note: `components/global/ReservationModal.tsx` contains an older admin-mode branch where admin customer registration requires more fields and both licence images. The dashboard create flow does not use that modal.

### Admin manual pricing

Admin create flow can enable manual daily pricing in `AdminReservationModal.tsx`.

Rules:

- Manual daily price is only applied in admin mode.
- Manual daily price must parse to a number greater than 0.
- Manual total is calculated as:
  - manual daily price times billable days
  - plus extra hours at the category extra-hour rate
  - plus pickup and return extension prices
  - plus automatic gear extra cost when applicable
  - plus add-ons
  - plus special-day price from the pricing hook, if present
  - minus discount percentage, if a discount is applied
- Submitted payload includes:
  - `isManualPrice: true`
  - `manualPricePerDay`
  - `manualPriceNote` or `"Admin custom pricing"`

Admin management can also edit pricing in `ReservationsManagement.tsx`:

- Manual daily price works like admin create.
- Total price override can replace the calculated total directly.
- Total override must be a number greater than or equal to 0.
- Total override stores `isManualPrice: true`, `manualPricePerDay: null`, and a manual note.

### Admin reservation type

Admin-created reservations submit:

- `reservationType: "Office"`
- `status: "pending"`

Customer-created reservations submit:

- `reservationType: "Website"`
- `status: "pending"`

## Office, Special Day, and Time Slot Rules

### Office/type/category filtering

Initial forms:

- Offices are loaded from `/api/offices?status=active`.
- Types are loaded from `/api/types?status=active`.
- Types are filtered by selected office.
- Categories are loaded from the selected office and filtered by selected type.

Modal/category selection:

- `ReservationModal.tsx` and `AdminReservationModal.tsx` fetch `/api/offices` and `/api/types` without a status query.
- Categories are filtered by office and type.
- In the modal flows, category status must be `active`.
- Category cards are sorted by calculated total price in the modal and by `showPrice` on the reservation listing page.

### Closed dates

A date is disabled when:

- matching special day exists and `isOpen` is false
- matching weekly working day exists and `isOpen` is false

If no office is selected, date disabling does not run.

### Special-day windows

Special days match by month and day only.

Pickup window priority:

1. `specialDay.pickupTime`
2. `specialDay.pickupExtension`
3. `specialDay.startTime` and `specialDay.endTime`
4. fallback `00:00` to `23:59`

Return window priority:

1. `specialDay.returnTime`
2. `specialDay.returnExtension`
3. `specialDay.pickupTime`
4. `specialDay.pickupExtension`
5. `specialDay.startTime` and `specialDay.endTime`
6. fallback `00:00` to `23:59`

### Regular working-day windows

Regular time slots use the office working day:

- base start is `workingDay.startTime` or `00:00`
- base end is `workingDay.endTime` or `23:59`
- pickup extension can expand pickup slots before and after the normal window
- return extension can expand return slots before and after the normal window
- extension windows are clamped between `00:00` and `23:59`
- slots are generated every 15 minutes

### Extension pricing

Pickup extension price:

- If pickup date is an open special day, charge `specialDay.extraPrice`.
- Otherwise, if pickup is before or after normal working hours and a pickup extension exists, charge `pickupExtension.flatPrice`.
- If normal start and end are the same, the day is treated as closed for normal hours and extension price is charged.

Return extension price:

- If return date is an open special day, charge `specialDay.extraPrice`.
- If pickup and return are the same open special day on the same calendar date, return special-day price is treated as already charged and set to 0.
- Otherwise, if return is before or after normal working hours and a return extension exists, charge `returnExtension.flatPrice`.
- If normal start and end are the same, the day is treated as closed for normal hours and extension price is charged.

### Reserved slots

Reserved slots are fetched from:

- `/api/reservations/by-office?office=...&startDate=...&type=start`
- `/api/reservations/by-office?office=...&endDate=...&type=end`

Admin edit uses `excludeReservation` so the reservation being edited does not block its own saved time.

`TimeSelect` currently disables:

- an exact matching pickup time when selecting a pickup time
- an exact matching return time when selecting a return time

It does not disable an entire overlapping rental interval. The API also does not enforce overlap prevention in `POST /api/reservations`.

## Gear Rules

Default gear is `manual`.

Automatic gear can add an extra daily cost only when:

- selected gear is `automatic`
- category supports `automatic`
- category also supports `manual`

The automatic extra cost is multiplied by billable days.

Some customer UI blocks gear selection until driver age is entered.

## Add-on Rules

Add-ons are fetched from `/api/addons?status=active`.

Flat add-ons:

- use `flatPrice.amount`
- if `flatPrice.isPerDay` is true, multiply by rental days
- always multiply by quantity

Tiered add-ons:

- use the selected tier index
- if `tieredPrice.isPerDay` is true, multiply by rental days
- always multiply by quantity

Selected add-ons are submitted as:

- `addOn`
- `quantity`
- `selectedTierIndex`, when present

## Discount Rules

Discount codes are fetched from `/api/discounts?status=active`.

A discount is valid only when:

- entered code matches an active discount code case-insensitively
- current date is between `validFrom` and `validTo`
- usage limit is not reached
- current user is not already in `usedBy`
- category restriction is empty or includes the selected category

Discount calculation:

- discount is percentage-based
- discount is applied after the calculated reservation total
- final total is rounded to 2 decimals

On submit, the code patches `/api/discounts?id=...` with `addUserToUsedBy`.

Implementation note: admin discount application still reads `localStorage.user`.
That means admin-created discount usage can be checked and recorded against the logged-in admin account rather than the selected customer.

## Pricing Rules

The shared pricing hook is `hooks/usePriceCalculation.ts`.

Inputs:

- start datetime
- end datetime
- pricing tiers
- extra-hour rate
- pickup extension price
- return extension price
- gear extra cost per day
- add-ons price
- sell-offer percentage
- optional special days

Calculation:

1. Parse start and end as JavaScript `Date`.
2. If either date is invalid, return `null`.
3. Calculate total minutes.
4. Calculate whole hours and remaining minutes.
5. If remaining minutes are greater than 15, round up by 1 billable hour.
6. If billable hours are less than or equal to 0, return `null`.
7. If billable hours are less than 24, charge 1 day and no extra hours.
8. If billable hours are 24 or more:
   - full days are `floor(billableHours / 24)`
   - extra hours are `billableHours % 24`
   - if extra hours are greater than 6, add one full day and set extra hours to 0
   - if extra hours are 6 or less, charge them at the extra-hour rate
9. Select the pricing tier where `totalDays` is within `minDays` and `maxDays`.
10. If no tier matches, use the last pricing tier.
11. Apply category sell offer to price per day.
12. Total price is:
    - days times price per day
    - plus days times gear extra cost
    - plus extra hours times extra-hour rate
    - plus pickup extension price
    - plus return extension price
    - plus add-ons price
    - plus special-days price

Special-days price inside the hook is only calculated when special days are
passed into the hook. Most current reservation flows pass an empty special-days
array and handle open special-day pricing as pickup/return extension prices.

## Submission Payload

Final reservation submit posts to `POST /api/reservations`.

Common payload shape:

```ts
{
  userData: {
    userId,
    name,
    lastName,
    email,
    phoneNumber
  },
  reservationData: {
    office,
    category,
    startDate,
    endDate,
    startDateDisplay,
    endDateDisplay,
    pickupTime,
    returnTime,
    totalPrice,
    driverAge,
    messege,
    status: "pending",
    addOns,
    discountCode,
    selectedGear,
    pickupExtensionPrice,
    returnExtensionPrice,
    reservationType
  }
}
```

Admin manual pricing can add:

```ts
{
  isManualPrice: true,
  manualPricePerDay,
  manualPriceNote
}
```

The reservation model stores:

- user
- office
- category
- vehicle
- start/end date
- display dates
- pickup/return time
- total price
- status
- driver age
- selected gear
- message field named `messege`
- pickup/return extension prices
- add-ons
- discount code
- manual price fields
- reservation type

## Admin Management Rules

### Statuses

Reservation statuses are:

- `pending`
- `confirmed`
- `delivered`, displayed as "collected" in the dashboard UI
- `completed`
- `canceled`

Status changes:

- Admin can change status from the reservation details panel.
- When status is changed to `completed` or `canceled`, the reservation vehicle is set to `null`.
- If a vehicle was assigned, that vehicle is patched back to `available: true`.

### Vehicle assignment

Vehicle assignment rules:

- Vehicles are loaded from `/api/vehicles?status=active&limit=1000`.
- Only vehicles with `available !== false` are listed.
- If a category is selected, available vehicles are filtered to that category.
- Assigning a vehicle patches the reservation with:
  - `vehicle`
  - `status: "delivered"`
- The assigned vehicle is then patched to `available: false`.

### Editing reservation details

Admin can edit:

- category
- dates
- pickup/return times
- gear
- add-ons
- pickup extension price
- return extension price
- total price
- manual daily price
- total price override

Edit date rules:

- The edit date picker uses `minDate={new Date()}`.
- Closed special days and closed working days are disabled.
- Reserved slots are fetched with `excludeReservation` to avoid blocking the current reservation.
- The admin edit flow does not enforce the customer 6-hour same-day minimum.

Edit submit patches the reservation with:

- new start/end ISO dates
- display dates
- pickup/return times
- category
- recalculated or overridden total price
- add-ons
- selected gear
- extension prices
- manual price fields
- `adminEdited: true`

The API sends an edit notification when `adminEdited` is true.

## Enforcement Gaps and Current Quirks

These are current behaviors to keep in mind before changing the rules:

- Most business rules are enforced in frontend components, not in `POST /api/reservations`.
- `POST /api/reservations` does not re-check driver age, same-day duration, office hours, date lead time, or overlapping reservations.
- Clients send an `Authorization` header on final submit, but the current `POST /api/reservations` route does not consume it for authorization checks.
- `TimeSelect` disables exact matching reserved pickup/return times, not full overlapping time ranges.
- Reservation availability is checked by office, not by vehicle inventory or category inventory.
- Admin initial form desktop and mobile date pickers allow different past ranges: 30 days desktop, 7 days mobile.
- `ReservationForm.tsx` and `AdminReservationForm.tsx` are duplicated with small differences, especially the `!isAdminMode` guards.
- `components/global/ReservationModal.tsx` has admin-mode code, but dashboard create uses `components/dashboard/AdminReservationModal.tsx`.
- Admin discount usage currently depends on the logged-in user in `localStorage`, not the selected customer.
- `vanListingBackup.tsx` combines selected dates and times using local `Date` objects, while `ReservationForm.tsx` uses London-time conversion before storing details.

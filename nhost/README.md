# Nhost setup — Dhanvi Finserv

This site uses **Nhost** for Postgres, Hasura GraphQL, Auth and private file
storage. There is no Supabase dependency left in the frontend.

The browser only ever receives the Nhost **subdomain** and **region**. Never put
the Hasura admin secret, a service key, a database password or a JWT signing key
in any file under this repository.

---

## 1. Project values

Open the Nhost dashboard for the **Dhanvi Finserv** project and copy:

- **Subdomain** — Project → Settings → General
- **Region** — Project → Settings → General (for example `eu-central-1`)

Put them in `js/nhost-client.js`:

```js
var CONFIG = window.DHANVI_NHOST_CONFIG || {
    subdomain: 'your-subdomain',
    region: 'your-region'
};
```

The project ID in the dashboard URL is **not** necessarily the subdomain.

---

## 2. Run the database migration

1. Open the Nhost dashboard.
2. Go to **Database → SQL Editor**.
3. Paste the entire contents of `nhost/migrations/001_init.sql`.
4. Run it once.

The script creates the business tables, the `api_result` helper table, the
server-side functions, the private `loan-documents` bucket and the custom
`admin` auth role.

If you already ran `001_init.sql` before **30 October 2026**, also run
[`migrations/002_register_document_null_uploader.sql`](migrations/002_register_document_null_uploader.sql).
It lets `register_document` accept uploads when Nhost leaves the deprecated
`storage.files.uploaded_by_user_id` column empty, while still enforcing the
ownership check whenever the column is populated.

Then run
[`migrations/003_admin_notifications.sql`](migrations/003_admin_notifications.sql).
It creates the admin notification inbox, its indexes, the read-state trigger and
the real business-event triggers. The script is idempotent and safe to run
again.

Finally run
[`migrations/004_home_loan_application.sql`](migrations/004_home_loan_application.sql).
It adds the structured Home Loan system behind `home-loan-apply.html`:

- `home_loan_details` — one structured row per Home Loan lead (personal,
  employment, address, property and loan-requirement data plus the
  administrator-driven identity verification fields).
- `home_loan_emis` — the applicant's declared existing EMI obligations.
- `home_loan_drafts` — server-side save/resume drafts (never exposed to the
  browser).
- `save_home_loan_draft`, `get_home_loan_draft` and
  `submit_home_loan_application` — the secure functions the wizard calls.

Then run
[`migrations/005_home_loan_topup_takeover.sql`](migrations/005_home_loan_topup_takeover.sql).
It adds the structured Home Loan **Top-Up** and **Takeover (balance transfer)**
systems behind `home-loan-topup-apply.html` and `home-loan-takeover-apply.html`:

- `home_loan_topup_details` — one structured row per Top-Up lead: applicant,
  employment and income, the existing home loan being topped up, the requested
  top-up amount and purpose, property, addresses and the indicative
  combined-EMI / LTV figures.
- `home_loan_takeover_details` — one structured row per Takeover lead: applicant,
  employment and income, the existing loan at the old bank, the proposed
  transfer (new amount, desired rate and tenure, optional additional top-up),
  property, addresses and the indicative new-EMI / savings figures.
- `submit_home_loan_topup_application` and
  `submit_home_loan_takeover_application` — the secure functions the two
  wizards call.
- It also re-registers `register_document` and widens the allowed
  `document_type` values so the extra Top-Up / Takeover documents (sanction
  letter, loan statement, outstanding certificate, repayment history) can be
  stored.

Then run
[`migrations/006_lap_business_loan_application.sql`](migrations/006_lap_business_loan_application.sql).
It adds the structured **Loan Against Property (LAP)** and **Business Loan**
systems behind `loan-against-property-apply.html` and `business-loan-apply.html`:

- `lap_details` — one structured row per LAP lead: applicant identity,
  employment and income, business financials (self-employed only), the mortgaged
  property (category, address, ownership, co-owners, usage, market value,
  purchase value, area and age), the required amount, purpose and tenure, both
  addresses and the indicative EMI / LTV figures.
- `business_loan_details` — one structured row per Business Loan lead: applicant
  and role, the business entity and constitution, registrations (GSTIN, PAN,
  Udyam), registered and operating addresses, financials and banking history,
  the required amount, purpose and tenure, and addresses.
- `submit_lap_application` and `submit_business_loan_application` — the secure
  functions the two wizards call.
- It also re-registers `register_document` and widens the allowed
  `document_type` values so the extra LAP / Business Loan documents (title
  chain, property tax receipt, approved plans, GST returns, financial
  statements, Udyam certificate) can be stored.

Then run
[`migrations/007_working_capital_cc_od.sql`](migrations/007_working_capital_cc_od.sql).
It adds the structured **Working Capital (CC/OD)** system behind
`working-capital-apply.html`:

- `working_capital_details` — one structured row per Working Capital lead:
  applicant identity and addresses, business entity and constitution,
  registrations (GSTIN, business PAN, Udyam), business vintage, registered and
  operating addresses, financials (turnover, monthly sales, profit,
  receivables, inventory, creditors, liabilities), banking relationship, the
  existing CC/OD limit position and the requested facility (new, enhancement,
  renewal or takeover) with security, collateral and tenure.
- `working_capital_facilities` — the additional existing bank facilities
  declared by the applicant (1:N with the lead), including bank, facility type,
  masked account number, sanctioned limit, utilisation, outstanding, interest
  rate and renewal date.
- `submit_working_capital_application` — the secure function the wizard calls.
- It also re-registers `register_document` and widens the allowed
  `document_type` values so stock, debtors and creditors statements can be
  stored.

Until both WC tables are tracked with `admin` select permission,
`admin-applications.html` retries its dashboard query without the WC fields.
Existing application types keep loading normally, and WC details appear
automatically once tracking and the permission are complete.

Then run
[`migrations/008_itr_filing.sql`](migrations/008_itr_filing.sql).
It adds the structured **ITR Filing** system behind `itr-apply.html`:

- `itr_filing_details` — one structured row per ITR assistance lead: applicant
  identity, PAN, masked Aadhaar reference, e-verification preference,
  residential status and addresses, assessment / financial year, taxpayer
  category, return type, ITR form preference, every income head (salary,
  business or profession, house property, capital gains, other sources,
  agricultural and foreign income), previous filing history, tax regime, TDS,
  advance tax and self-assessment tax, deductions, exemptions, refund bank
  details, indicative computation, and the administrator-controlled filing
  status, acknowledgement and verification fields.
- `itr_income_items` — the declared income heads recorded at submission
  (1:N with the lead).
- `itr_tax_payments` — declared TDS, advance tax and self-assessment tax
  credits (1:N with the lead).
- `submit_itr_application` — the secure function the wizard calls.
- It also re-registers `register_document` and widens the allowed
  `document_type` values so Form 16, Form 26AS, AIS / TIS, investment proofs,
  rent receipts, capital gains statements, previous ITR, ITR acknowledgement,
  tax payment challans and foreign income documents can be stored.
- It widens `loan_leads.loan_type` for service applications and allows a
  zero-or-more `loan_amount`. Existing loan functions still enforce their own
  minimum amounts.

The public ITR wizard never sets `filing_status`, `acknowledgement_no`,
`filed_at`, `filed_by`, `verified_at` or `verification_method`. A new
application starts at **Application Received**, and only an administrator can
move it to **Filed & Verified** after actual portal filing and acknowledgement
verification.

Until the ITR tables are tracked with `admin` select permission,
`admin-applications.html` retries its dashboard query without the ITR fields.
Existing application types keep loading normally, and ITR details appear
automatically once tracking and the permission are complete.

Then run
[`migrations/009_gst_registration.sql`](migrations/009_gst_registration.sql).
It adds the structured **GST Registration & Filing** system behind
`gst-apply.html`:

- `gst_registration_details` — one structured row per GST assistance lead:
  applicant and authorised signatory, PAN, masked Aadhaar reference,
  Aadhaar-authentication preference, principal place of business, business
  name and constitution, nature of supply, activity and NIC code, commencement
  date, turnover, employee count, existing GSTIN and other registrations, the
  selected service (new registration, return filing, amendment, cancellation
  or compliance assistance), registration type, filing frequency, return
  period and financial year, previous filing status, amendment / cancellation
  details, declared sales, purchases, input tax credit, tax liability and
  payments, signatory and bank details, and the administrator-controlled
  filing, ARN and payment fields.
- `gst_return_filings` — each declared return period with its return type,
  status, ARN, filing date, tax payable, tax paid, late fee, interest and
  remarks (1:N with the lead).
- `submit_gst_application` — the secure function the wizard calls.
- It also re-registers `register_document` and widens the allowed
  `document_type` values so GST certificates, invoices, purchase bills, rent
  agreements / NOCs, certificates of incorporation, partnership deeds, board
  resolutions, authorisation letters, address proofs and bank proofs can be
  stored.
- It re-asserts the widened `loan_leads.loan_type` list and the zero-or-more
  `loan_amount` rule. Existing loan functions still enforce their own minimum
  amounts.

The public GST wizard never sets `filing_status`, `acknowledgement_no`,
`filed_at`, `filed_by`, `verified_at`, `verification_method`, `payment_status`,
`payment_reference`, `payment_amount`, `payment_date` or `payment_notes`. A new
application starts at **Application Received**, and only an administrator can
move it to **Filed & Verified** after the actual GST portal action and ARN or
approval verification.

Until the GST tables are tracked with `admin` select permission,
`admin-applications.html` retries its dashboard query without the GST fields.
Existing application types keep loading normally, and GST details appear
automatically once tracking and the permission are complete.

Then run
[`migrations/010_msme_udyam_registration.sql`](migrations/010_msme_udyam_registration.sql).
It adds the structured **MSME / Udyam / Gumasta** system behind
`msme-apply.html`:

- `msme_registration_details` — one structured row per MSME assistance lead:
  applicant and authorised person, PAN, masked Aadhaar reference and
  Aadhaar-authentication method, applicant address, business name and trade
  name, constitution, declared enterprise category, activity and NIC code,
  commencement date, employee count, plant & machinery investment, turnover,
  GSTIN and existing registrations, business / establishment address, the
  selected service (new Udyam, Udyam update, Gumasta / Shop & Establishment,
  business registration assistance or a combined package), existing Udyam and
  Shop & Establishment numbers, update / amendment details, premises ownership
  and landlord details, other registration details, and the
  administrator-controlled identity, submission, certificate and verification
  fields.
- `msme_promoters` — proprietor / partner / director / trustee rows recorded at
  submission, with designation, PAN, masked Aadhaar reference, DIN, contact
  details and shareholding (1:N with the lead).
- `msme_registrations` — each requested registration tracked separately with
  its application number, status, submission and approval dates, certificate
  number, validity, portal reference and remarks (1:N with the lead).
- `submit_msme_application` — the secure function the wizard calls.
- It also re-registers `register_document` and widens the allowed
  `document_type` values so PAN cards, Aadhaar cards, photographs, address
  proofs, business proofs, certificates of incorporation, partnership deeds,
  board resolutions, authorisation letters, rent agreements / NOCs, property
  tax receipts, electricity bills, Udyam certificates, Shop & Establishment
  certificates and supporting documents can be stored.
- It re-asserts the widened `loan_leads.loan_type` list and the zero-or-more
  `loan_amount` rule. Existing loan functions still enforce their own minimum
  amounts.

The public MSME wizard never sets `identity_verification_status`,
`submission_status`, `submitted_at`, `submitted_by`, `approved_at`,
`verified_at`, `verification_method`, `certificate_number`,
`portal_reference`, `registration_remarks` or the per-registration status,
certificate and approval fields. A new application starts at **Application
Received**, and only an administrator can move it to **Approved & Verified**
after the actual action on the Udyam, Shop & Establishment or registrar portal
and verification of the certificate or acknowledgement.

Until the MSME tables are tracked with `admin` select permission,
`admin-applications.html` retries its dashboard query without the MSME fields.
Existing application types keep loading normally, and MSME details appear
automatically once tracking and the permission are complete.

Then run
[`migrations/011_loan_protection_insurance.sql`](migrations/011_loan_protection_insurance.sql).
It adds the **Loan Protection Insurance** enquiry system behind
`loan-insurance-apply.html`:

- `loan_insurance_details` — one structured row per insurance assistance lead:
  applicant and KYC profile, address, loan and lender details, outstanding
  balance, EMI and remaining tenure, coverage requirement, desired cover,
  policy tenure and premium budget, existing insurance, nominee and co-borrower
  details, underwriting information and medical-test consent, plus the
  administrator-controlled insurer, proposal, quotation and policy fields.
- `submit_loan_insurance_application` — the secure function the wizard calls.
- It widens the allowed `document_type` values so the insurer's proposal form,
  medical reports, existing policy and insurer quotation can be stored, and
  re-asserts the `loan_leads` loan-type and amount rules.

The public insurance wizard never sets `proposal_status`, `insurer_name`,
`proposal_number`, `proposal_date`, `quotation_reference`, `quotation_amount`,
`quotation_date`, `quotation_valid_until`, `policy_status`, `policy_number`,
`policy_start_date`, `policy_end_date`, `premium_amount`, `payment_mode`,
`policy_remarks`, `status_notes`, `verified_by` or `verified_at`. A new enquiry
starts at **Enquiry Received** / **Not Issued**. Only an administrator can
record a quotation, proposal or policy after the authorised insurer confirms it
and the policy document is verified. A quotation is not cover, and no cover
begins until the policy is issued and the premium is paid.

Until `loan_insurance_details` is tracked with `admin` select permission,
`admin-applications.html` retries its dashboard query without the insurance
fields. Existing application types keep loading normally, and insurance details
appear automatically once tracking and the permission are complete.

Then run
[`migrations/012_credit_health_cibil.sql`](migrations/012_credit_health_cibil.sql).
It adds the **Credit Health / CIBIL Advisory** system behind
`credit-health-apply.html`:

- `credit_health_details` — one structured row per advisory lead: applicant
  profile, PAN and address, occupation and income, advisory requirement and
  bureau preference, current score and target loan, existing credit profile,
  overdue and settlement history, existing report reference, bureau consent and
  declarations, plus the administrator-controlled bureau, report, score,
  analysis and follow-up fields.
- `credit_accounts` — repeatable loan and credit-card rows with account type,
  lender, last four characters of the account reference, status, outstanding,
  EMI, overdue, days past due and settlement amounts.
- `credit_enquiries` — repeatable bureau enquiry rows with institution, date,
  purpose, status and remarks.
- `submit_credit_health_application` — the secure function the wizard calls.
- It widens the allowed `document_type` values so a credit report, credit-card
  statement, bureau correspondence, No Dues Certificate and settlement letter
  can be stored, and re-asserts the `loan_leads` loan-type and amount rules.

The public Credit Health wizard never sets `report_status`, `bureau_name`,
`bureau_reference`, `bureau_request_sent_at`, `report_received_date`,
`credit_score`, `score_date`, `score_band`, `report_summary`,
`analysis_summary`, `improvement_plan`, `eligibility_assessment`,
`analysis_shared_date`, `admin_remarks`, `follow_up_date`, `status_notes`,
`verified_by` or `verified_at`. A new request starts at **Enquiry Received**.
Only an administrator can record the bureau reference, report date, score and
analysis after the authorised bureau supplies the information and it is
verified. Dhanvi Finserv does not guarantee a score increase, the removal of a
genuine default or loan approval. A report is requested only after the
customer's explicit bureau consent and only through an authorised bureau
process. Full reports are not stored in public URLs or written to ordinary
logs; the database keeps the bureau reference and the advisory summary.

Until `credit_health_details`, `credit_accounts` and `credit_enquiries` are
tracked with `admin` select permission, `admin-applications.html` retries its
dashboard query without the Credit Health fields. Existing application types
keep loading normally, and Credit Health details appear automatically once
tracking and the permission are complete.

### DSA Partner Network (migration 013)

[`migrations/013_partner_network.sql`](migrations/013_partner_network.sql) adds
the **DSA Partner Network** behind `partner-apply.html`, `partner-login.html`
and `partner-portal.html`.

- `partner_application_details` — one structured onboarding row per partner
  lead: applicant, firm, office, PAN, business registration, experience,
  products, expected referrals, preferred locations, bank / DSA associations
  and the three declarations.
- `partner_profiles` — the provisioned partner account, linked 1:1 to the lead
  and to the Nhost auth user. It carries the partner code, account status and
  activation / suspension record.
- `partner_documents` — a metadata mirror of `loan_documents`. Files stay in the
  private `loan-documents` bucket and verification still happens in the admin
  Documents module.
- `partner_verifications` — PAN, business registration, address, photograph,
  bank / DSA association and overall review checks.
- `partner_agreements` — agreement type, status, reference, signed and
  effective dates, document name and commission terms.
- `partner_lead_assignments` — customer leads assigned to a partner, with the
  lender outcome and sanction / disbursal record.
- `partner_commissions` — commission records per assignment, including TDS,
  net payable, invoice and payment reference.
- `partner_followups` — partner and assigned-lead follow-ups.

The migration also adds four callable functions:

- `submit_partner_application` — the public 5-step onboarding submission.
- `review_partner_application` — admin-only approval, rejection and review
  status changes.
- `provision_partner_login` — admin-only login provisioning.
- `update_partner_lead_status` — partner-only progress update for an assigned
  lead.

Partner applications reuse `loan_leads` with
`loan_type = 'DSA Partner Network'` and `loan_amount = 0`, the shared
`home_loan_drafts` / `save_home_loan_draft` / `get_home_loan_draft` functions
and the private `loan-documents` bucket. The document types
`Business Registration` and `Onboarding Document` are added to the shared
`loan_documents` check and `register_document`.

The public form never sets review, verification, agreement, profile or
commission data. Approval requires verified PAN, address, photograph and, when
the firm is registered, business registration documents; matching verification
rows; and an assigned executive. Login provisioning requires an Approved
application, a Signed or Active agreement with a signed date and an
effective-from date that has arrived, and an auth user whose email matches the
application email. The function inserts the `partner` role into
`auth.user_roles` and sets `auth.users.default_role`.

The eight partner tables enable Postgres RLS as defence-in-depth; Hasura row
filters are still the primary boundary. The `partner` role can only select its
own rows and can only write through `update_partner_lead_status`. It has no
access to `loan_leads`, `loan_documents` or any other customer table, so a
partner never sees another partner's customers, documents, agreements or
commissions.

Until the partner tables are tracked and the `admin` permissions are saved,
`admin-applications.html` retries without the partner fields and shows a
warning; `admin-partners.html` shows its own setup warning. The public wizard
itself only needs `submit_partner_application`, the draft functions and
`register_document`.

All application wizards reuse the existing `home_loan_drafts` table and the
`save_home_loan_draft` / `get_home_loan_draft` functions for save/resume, and the
shared `loan_applicants` table for co-applicants / guarantors.

The other loan types are untouched: they keep using
`submit_loan_application_v2` through `apply-loan.html`.

Do **not** enable Postgres RLS on the original business tables. Access is
enforced by Hasura permissions, which is how Nhost is designed to work. The
eight partner tables are the deliberate exception: migration `013` enables RLS
with own-row and admin policies as defence-in-depth, while Hasura row filters
remain the primary boundary.

---

## 3. Track tables and functions in Hasura

Open **GraphQL → Hasura Console → Data**.

### 3.1 Track these tables

Under `public`:

- `admin_profiles`
- `admin_notifications`
- `loan_leads`
- `loan_applicants`
- `callback_bookings`
- `post_disbursal_requests`
- `complaints`
- `loan_documents`
- `loan_followups`
- `home_loan_details`
- `home_loan_emis`
- `home_loan_drafts`
- `home_loan_topup_details`
- `home_loan_takeover_details`
- `lap_details`
- `business_loan_details`
- `working_capital_details`
- `working_capital_facilities`
- `itr_filing_details`
- `itr_income_items`
- `itr_tax_payments`
- `gst_registration_details`
- `gst_return_filings`
- `msme_registration_details`
- `msme_promoters`
- `msme_registrations`
- `loan_insurance_details`
- `credit_health_details`
- `credit_accounts`
- `credit_enquiries`
- `partner_application_details`
- `partner_profiles`
- `partner_documents`
- `partner_verifications`
- `partner_agreements`
- `partner_lead_assignments`
- `partner_commissions`
- `partner_followups`
- `api_result`

`api_result` is only a return-type carrier for the functions. It is never
written by the application. `home_loan_drafts` is created, updated and read
only by the `SECURITY DEFINER` functions; tracking it is enough — no browser
role may be granted any permission on it.

### 3.2 Track these functions

Under **Data → SQL → Track** (or the “Untracked functions” list):

- `submit_loan_application_v2`
- `book_callback`
- `get_booked_callback_slots`
- `submit_post_disbursal_request`
- `submit_complaint`
- `lookup_application`
- `get_application_by_token`
- `register_document`
- `get_application_documents`
- `save_home_loan_draft`
- `get_home_loan_draft`
- `submit_home_loan_application`
- `submit_home_loan_topup_application`
- `submit_home_loan_takeover_application`
- `submit_lap_application`
- `submit_business_loan_application`
- `submit_working_capital_application`
- `submit_itr_application`
- `submit_gst_application`
- `submit_msme_application`
- `submit_loan_insurance_application`
- `submit_credit_health_application`
- `submit_partner_application`
- `review_partner_application`
- `provision_partner_login`
- `update_partner_lead_status`

Hasura needs each function to return `SETOF public.api_result`, which the
migration already does. `VOLATILE` functions are mutations; `STABLE` functions
are queries. `sync_partner_document` and `validate_partner_application_status`
are trigger functions and do not need to be tracked.

---

## 4. Hasura permissions

Open **Data → [table] → Permissions** and add the rows below. Do not grant
anything to the `user` role: a normal signed-up user must have no business-table
access.

### 4.1 `api_result`

| Role | select | insert | update | delete |
| --- | --- | --- | --- | --- |
| `public` | yes | no | no | no |
| `anonymous` | yes | no | no | no |
| `admin` | yes | no | no | no |
| `partner` | yes | no | no | no |

`api_result` only needs `select`; the functions are `SECURITY DEFINER` and
insert nothing into it.

### 4.2 Function permissions

Open **Data → [function] → Permissions**.

| Function | `public` | `anonymous` | `admin` |
| --- | --- | --- | --- |
| `submit_loan_application_v2` | execute | execute | execute |
| `book_callback` | execute | execute | execute |
| `get_booked_callback_slots` | execute | execute | execute |
| `submit_post_disbursal_request` | execute | execute | execute |
| `submit_complaint` | execute | execute | execute |
| `lookup_application` | execute | execute | execute |
| `get_application_by_token` | execute | execute | execute |
| `get_application_documents` | execute | execute | execute |
| `save_home_loan_draft` | execute | execute | execute |
| `get_home_loan_draft` | execute | execute | execute |
| `submit_home_loan_application` | execute | execute | execute |
| `submit_home_loan_topup_application` | execute | execute | execute |
| `submit_home_loan_takeover_application` | execute | execute | execute |
| `submit_lap_application` | execute | execute | execute |
| `submit_business_loan_application` | execute | execute | execute |
| `submit_working_capital_application` | execute | execute | execute |
| `submit_itr_application` | execute | execute | execute |
| `submit_gst_application` | execute | execute | execute |
| `submit_msme_application` | execute | execute | execute |
| `submit_loan_insurance_application` | execute | execute | execute |
| `submit_credit_health_application` | execute | execute | execute |
| `submit_partner_application` | execute | execute | execute |
| `review_partner_application` | **no** | **no** | execute |
| `provision_partner_login` | **no** | **no** | execute |
| `update_partner_lead_status` | **no** | **no** | **no** |
| `register_document` | **no** | execute | execute |

`register_document` requires an authenticated Nhost session, so it must not be
available to the unauthenticated `public` role. It is limited to `anonymous`
(the public upload page) and `admin`.

The `partner` role must have execute on `update_partner_lead_status` only. It
must not execute any other function, and the function itself rejects any
session whose role is not `partner`.

The `user` role intentionally has no execute permissions. A customer who has
signed up through the Nhost API (there is no signup form on the site) must sign
out before using the public forms; see the troubleshooting table.

### 4.3 Business tables for `admin`

Grant only what the admin panel uses:

| Table | select | insert | update | delete |
| --- | --- | --- | --- | --- |
| `admin_profiles` | yes | no | yes | no |
| `admin_notifications` | yes | no | yes | yes |
| `loan_leads` | yes | no | yes | yes |
| `loan_applicants` | yes | no | no | no |
| `loan_documents` | yes | no | yes | yes |
| `loan_followups` | yes | no | yes | yes |
| `callback_bookings` | yes | no | yes | yes |
| `post_disbursal_requests` | yes | no | yes | yes |
| `complaints` | yes | no | yes | yes |
| `home_loan_details` | yes | no | yes | no |
| `home_loan_emis` | yes | no | no | no |
| `home_loan_topup_details` | yes | no | yes | no |
| `home_loan_takeover_details` | yes | no | yes | no |
| `lap_details` | yes | no | yes | no |
| `business_loan_details` | yes | no | yes | no |
| `working_capital_details` | yes | no | yes | no |
| `working_capital_facilities` | yes | no | no | no |
| `itr_filing_details` | yes | no | yes | no |
| `itr_income_items` | yes | no | no | no |
| `itr_tax_payments` | yes | no | no | no |
| `gst_registration_details` | yes | no | yes | no |
| `gst_return_filings` | yes | no | yes | no |
| `msme_registration_details` | yes | no | yes | no |
| `msme_promoters` | yes | no | no | no |
| `msme_registrations` | yes | no | yes | no |
| `loan_insurance_details` | yes | no | yes | no |
| `credit_health_details` | yes | no | yes | no |
| `credit_accounts` | yes | no | no | no |
| `credit_enquiries` | yes | no | no | no |
| `partner_application_details` | yes | no | no | no |
| `partner_profiles` | yes | no | yes | no |
| `partner_documents` | yes | no | no | no |
| `partner_verifications` | yes | yes | yes | no |
| `partner_agreements` | yes | yes | yes | no |
| `partner_lead_assignments` | yes | yes | yes | no |
| `partner_commissions` | yes | yes | yes | no |
| `partner_followups` | yes | yes | yes | no |

The admin panel exposes a confirmed, permanent delete action for leads,
documents, follow-ups, callbacks, support requests and complaints. Grant
`delete` only on those tables. Deleting a `loan_leads` row cascades to
`loan_applicants`, `loan_documents`, `loan_followups`, `home_loan_details`,
`home_loan_topup_details`, `home_loan_takeover_details`, `lap_details`,
`business_loan_details`, `working_capital_details`,
`working_capital_facilities`, `itr_filing_details`, `itr_income_items`,
`itr_tax_payments`, `gst_registration_details`, `gst_return_filings`,
`msme_registration_details`, `msme_promoters`, `msme_registrations`,
`loan_insurance_details`, `credit_health_details`, `credit_accounts`,
`credit_enquiries`, `partner_application_details`, `partner_profiles`,
`partner_documents`, `partner_verifications`, `partner_agreements`,
`partner_lead_assignments`, `partner_commissions`, `partner_followups` and
`home_loan_emis`;
linked callbacks, complaints and support requests are kept with `loan_lead_id`
set to `NULL` (`ON DELETE SET NULL`). `admin_profiles` and `loan_applicants`
must not be deletable from the admin UI. Deleting a partner profile cascades to
its lead assignments, commissions and follow-ups; deleting a `loan_documents`
row cascades to the matching `partner_documents` mirror row.

For `admin_profiles` update, allow only `full_name` (and `updated_at` is
maintained by the trigger). Restrict the update columns per table to match the
admin panel:

| Table | Columns the admin panel updates |
| --- | --- |
| `admin_profiles` | `full_name` |
| `loan_leads` | `status`, `admin_notes` |
| `loan_documents` | `status`, `notes`, `verified_by`, `verification_date` |
| `loan_followups` | `status`, `notes` |
| `callback_bookings` | `status`, `admin_notes`, `preferred_date`, `preferred_slot`, `rescheduled_to_date`, `rescheduled_to_slot` |
| `post_disbursal_requests` | `status`, `admin_notes`, `resolved_at` |
| `complaints` | `status`, `resolution_details`, `resolved_at` |
| `home_loan_details` | `identity_verification_status`, `identity_verified_by`, `identity_verified_at`, `identity_notes` |
| `home_loan_topup_details` | `identity_verification_status`, `identity_verified_by`, `identity_verified_at`, `identity_notes` |
| `home_loan_takeover_details` | `identity_verification_status`, `identity_verified_by`, `identity_verified_at`, `identity_notes` |
| `lap_details` | `identity_verification_status`, `identity_verified_by`, `identity_verified_at`, `identity_notes` |
| `business_loan_details` | `identity_verification_status`, `identity_verified_by`, `identity_verified_at`, `identity_notes` |
| `working_capital_details` | `identity_verification_status`, `identity_verified_by`, `identity_verified_at`, `identity_notes` |
| `itr_filing_details` | `identity_verification_status`, `identity_verified_by`, `identity_verified_at`, `identity_notes`, `filing_status`, `filing_status_notes`, `acknowledgement_no`, `filed_at`, `filed_by`, `verified_at`, `verification_method`, `filing_remarks` |
| `gst_registration_details` | `identity_verification_status`, `identity_verified_by`, `identity_verified_at`, `identity_notes`, `filing_status`, `filing_status_notes`, `acknowledgement_no`, `filed_at`, `filed_by`, `verified_at`, `verification_method`, `filing_remarks`, `payment_status`, `payment_reference`, `payment_amount`, `payment_date`, `payment_notes` |
| `gst_return_filings` | `filing_status`, `arn`, `filed_at`, `tax_paid`, `remarks` |
| `msme_registration_details` | `identity_verification_status`, `identity_verified_by`, `identity_verified_at`, `identity_notes`, `submission_status`, `submission_status_notes`, `submitted_at`, `submitted_by`, `approved_at`, `verified_at`, `verification_method`, `certificate_number`, `portal_reference`, `registration_remarks` |
| `msme_registrations` | `status`, `application_number`, `submitted_at`, `approved_at`, `certificate_number`, `valid_until`, `portal_reference`, `remarks` |
| `loan_insurance_details` | `proposal_status`, `insurer_name`, `proposal_number`, `proposal_date`, `quotation_reference`, `quotation_amount`, `quotation_date`, `quotation_valid_until`, `policy_status`, `policy_number`, `policy_start_date`, `policy_end_date`, `premium_amount`, `payment_mode`, `policy_remarks`, `status_notes`, `verified_by`, `verified_at` |
| `credit_health_details` | `report_status`, `bureau_name`, `bureau_reference`, `bureau_request_sent_at`, `report_received_date`, `credit_score`, `score_date`, `score_band`, `report_summary`, `analysis_summary`, `improvement_plan`, `eligibility_assessment`, `analysis_shared_date`, `admin_remarks`, `follow_up_date`, `status_notes`, `verified_by`, `verified_at` |
| `partner_profiles` | `status`, `activated_at`, `suspended_at`, `suspension_reason`, `admin_notes` |
| `partner_verifications` | `status`, `reference_no`, `findings`, `remarks`, `verified_by`, `verified_at` |
| `partner_agreements` | `agreement_type`, `agreement_status`, `agreement_reference`, `signed_date`, `effective_from`, `effective_to`, `document_name`, `commission_terms`, `admin_remarks` |
| `partner_lead_assignments` | `partner_profile_id`, `customer_name`, `customer_mobile`, `customer_email`, `product_type`, `requested_amount`, `customer_city`, `customer_state`, `lender_name`, `lender_reference`, `status`, `status_notes`, `sanctioned_amount`, `disbursed_amount`, `disbursed_date`, `admin_remarks` |
| `partner_commissions` | `partner_profile_id`, `lead_assignment_id`, `loan_lead_id`, `commission_type`, `basis_amount`, `rate_percent`, `commission_amount`, `tds_amount`, `net_payable`, `status`, `invoice_no`, `invoice_date`, `payment_reference`, `remarks`, `approved_by`, `approved_at`, `paid_at` |
| `partner_followups` | `partner_profile_id`, `lead_assignment_id`, `scheduled_at`, `interaction_type`, `status`, `notes`, `completed_at`, `created_by` |

`home_loan_details`, `home_loan_topup_details`, `home_loan_takeover_details`,
`lap_details`, `business_loan_details`, `working_capital_details` and
`home_loan_emis` are read-only for the
admin panel except for the identity-verification fields above, which the
**Applications** detail modal writes. `itr_filing_details`,
`gst_registration_details` and `msme_registration_details` additionally allow
the administrator-controlled filing / submission, acknowledgement, certificate
and (for GST) payment fields. `gst_return_filings` allows the per-period filing
status, ARN, filing date, tax paid and remarks. `msme_registrations` allows the
per-registration status, application number, submission and approval dates,
certificate number, validity, portal reference and remarks.
`loan_insurance_details` allows the administrator-controlled insurer, proposal,
quotation and policy fields listed above; the public wizard never writes them.
`credit_health_details` allows the administrator-controlled bureau, report,
score, analysis and follow-up fields listed above; the public wizard never
writes them, and only a verified bureau reference and report date can support a
report or analysis status. The rest of the structured data is created by
`submit_home_loan_application`, `submit_home_loan_topup_application`,
`submit_home_loan_takeover_application`, `submit_lap_application`,
`submit_business_loan_application`, `submit_working_capital_application`,
`submit_itr_application`, `submit_gst_application`, `submit_msme_application`,
`submit_loan_insurance_application`, `submit_credit_health_application` and
`submit_partner_application` and must not be editable from the browser.
`home_loan_emis`, `itr_income_items`, `itr_tax_payments`, `msme_promoters`,
`credit_accounts`, `credit_enquiries`, `partner_application_details` and
`partner_documents` have `select` only for the admin panel.
`partner_application_details` is changed only by
`review_partner_application`; `partner_documents` is a trigger-maintained
mirror of `loan_documents`. Those functions are `SECURITY DEFINER`, so the
admin role does not need direct insert/update permission on either table.

Do not add `public` or `anonymous` permissions on any business table. The
`partner` role gets its own select-only permissions and row filters in section
4.6; it must never be granted access to `loan_leads`, `loan_documents`,
`loan_followups`, `admin_profiles` or any other customer table.

Do not grant _any_ role a permission on `home_loan_drafts`.

### 4.4 `admin_notifications` permissions

The notification inbox is written only by the `SECURITY DEFINER` triggers in
migration `003`. The browser must never be able to insert a notification.

For the `admin` role:

| Permission | Configuration |
| --- | --- |
| `select` | All columns. Row filter: `_or: [{recipient_user_id: {_is_null: true}}, {recipient_user_id: {_eq: "X-Hasura-User-Id"}}]`. Enable **Allow aggregations**. |
| `update` | Columns: **`is_read` only**. Same row filter as `select`. |
| `delete` | Same row filter as `select`. |
| `insert` | **No permission.** |

**Allow aggregations** is required: the bell badge, dropdown summary and
Notification Center totals use `admin_notifications_aggregate`. Without it,
Hasura returns a permission error for the aggregate fields and the inbox shows
as unavailable.

The row filter is the authorization boundary: an administrator can only see,
update or delete notifications addressed to their own `auth.users.id`, plus
shared notifications with `recipient_user_id = NULL`.

Do **not** grant `read_at` or `read_by` as update columns. The
`set_admin_notification_read_state` trigger writes them from the verified
Hasura session and preserves them when `is_read` does not change.

Hasura real-time subscriptions use the same `select` permission. Once the table
is tracked and the permission is saved, no extra real-time configuration is
needed. The admin panel subscribes over the Nhost GraphQL WebSocket endpoint and
falls back to polling if the socket cannot connect.

The trigger creates one private notification per row in `admin_profiles`, so
mark-read and delete actions are isolated per administrator. If no admin profile
exists yet, it writes one shared row so the event is not lost.

### 4.5 Column presets / insert permissions

No column presets are needed on the business tables because the public site
never inserts into them directly. All public writes go through the
`SECURITY DEFINER` functions.

### 4.6 Partner role, relationships and row filters

The migration seeds the custom `partner` role. A partner signs in at
`partner-login.html` with a normal Nhost email/password account. The account
must contain the `partner` role and a matching `partner_profiles` row with
status `Active`. `provision_partner_login` adds the role and sets
`auth.users.default_role = 'partner'`.

The partner portal sends `x-hasura-role: partner`. Grant the role **select
only** on the eight partner tables. Do not grant insert, update or delete to
`partner`; the only write path is the `update_partner_lead_status` function.

Hasura row filters can only traverse relationships, so create these object
relationships first in **Data → [table] → Relationships → Add relationship**:

| Source table | Relationship name | Type | Source column | Remote table | Remote column |
| --- | --- | --- | --- | --- | --- |
| `partner_application_details` | `partner_profile` | object | `loan_lead_id` | `partner_profiles` | `loan_lead_id` |
| `partner_documents` | `partner_profile` | object | `partner_lead_id` | `partner_profiles` | `loan_lead_id` |
| `partner_verifications` | `partner_profile` | object | `partner_lead_id` | `partner_profiles` | `loan_lead_id` |
| `partner_agreements` | `partner_profile` | object | `partner_lead_id` | `partner_profiles` | `loan_lead_id` |
| `partner_lead_assignments` | `partner_profile` | object | `partner_profile_id` | `partner_profiles` | `id` |
| `partner_commissions` | `partner_profile` | object | `partner_profile_id` | `partner_profiles` | `id` |
| `partner_followups` | `partner_profile` | object | `partner_profile_id` | `partner_profiles` | `id` |

Then set these select row filters for the `partner` role:

| Table | Row filter |
| --- | --- |
| `partner_profiles` | `{"user_id":{"_eq":"X-Hasura-User-Id"}}` |
| `partner_application_details` | `{"partner_profile":{"user_id":{"_eq":"X-Hasura-User-Id"}}}` |
| `partner_documents` | `{"partner_profile":{"user_id":{"_eq":"X-Hasura-User-Id"}}}` |
| `partner_verifications` | `{"partner_profile":{"user_id":{"_eq":"X-Hasura-User-Id"}}}` |
| `partner_agreements` | `{"partner_profile":{"user_id":{"_eq":"X-Hasura-User-Id"}}}` |
| `partner_lead_assignments` | `{"partner_profile":{"user_id":{"_eq":"X-Hasura-User-Id"}}}` |
| `partner_commissions` | `{"partner_profile":{"user_id":{"_eq":"X-Hasura-User-Id"}}}` |
| `partner_followups` | `{"partner_profile":{"user_id":{"_eq":"X-Hasura-User-Id"}}}` |

The partner portal also needs select on `api_result` (for the RPC return) and
execute on `update_partner_lead_status`. No other function execute permission.

The database RLS policies repeat the same rule: a partner sees only rows
belonging to the profile whose `user_id` matches the verified session user. If
a row filter is missing, Hasura returns no rows; if the relationship is
missing, the permission cannot be saved. Never test the partner portal with an
admin session: sign in with the partner account.

The admin role needs the partner table permissions in section 4.3, plus execute
on `review_partner_application`, `provision_partner_login` and
`submit_partner_application`.

---

## 5. Storage permissions

The bucket is created by the migration. Confirm it in **Storage → Buckets**:

- ID: `loan-documents`
- Access: private — no `public` role permissions (configured in the next step)
- Maximum file size: 5 MB
- Presigned URLs: enabled, 60-second expiry

Then open **Storage → Permissions** (the grid at the bottom of the Storage
sidebar). Nhost configures `storage.files` permissions from this grid; do not
try to grant storage access from the Hasura table permissions screen.

### `anonymous` role

- **Upload** — custom check: `bucket_id` equals `loan-documents`
- **Uploader identity** — enabled (prefills `uploaded_by_user_id` with
  `X-Hasura-User-Id`)
- **Download / Replace / Delete** — no access

### `admin` role

- **Download** — custom check: `bucket_id` equals `loan-documents`
- **Upload** — custom check: `bucket_id` equals `loan-documents`
- **Uploader identity** — enabled (prefills `uploaded_by_user_id` with
  `X-Hasura-User-Id`)
- **Delete** — required: after an administrator removes a document or lead
  record, the admin panel best-effort deletes the matching private storage file.
- **Replace** — not used by the admin panel.

Admin Upload is required because `ensureAnonymousSession()` reuses an existing
admin session instead of signing the administrator out. The public upload page
therefore works for an admin too, and `register_document` records the upload as
`admin` rather than `customer`.

### `public` and `user` roles

No storage access.

> **Note:** `storage.files.uploaded_by_user_id` is deprecated in Nhost Storage.
> Some projects leave it `NULL` even when **Uploader identity** is enabled.
> `register_document` enforces the ownership match only when the column is
> populated; migration `002` contains that behaviour.

The upload flow is:

1. The browser opens an anonymous Nhost session.
2. The file is uploaded to the private bucket.
3. `register_document` reads the file name, size and MIME type from
   `storage.files`, verifies the uploader, and stores the metadata.

Failed registrations leave an orphaned file in the bucket. That is deliberate:
anonymous customers are not allowed to delete files, so a bad actor cannot
remove evidence. An administrator can clean up orphaned files from the Nhost
dashboard.

---

## 6. Auth settings

In **Auth → Settings**:

- **Signup**: enabled.
  Anonymous sign-in is rejected when signup is disabled, so this must stay on.
  Security comes from the `user` role having no permissions, not from disabling
  signup.
- **Anonymous users**: enabled.
- **Email verification**: optional, but the admin account must be verified
  before it can sign in if verification is on.

Nhost assigns anonymous users the `anonymous` role, not `user`.

---

## 7. Create the administrator account

1. In **Auth → Users**, add the administrator with an email and password.
2. Verify the email if verification is enabled.
3. Run this SQL in **Database → SQL Editor**, replacing the email:

```sql
-- Make sure the custom role exists (the migration already inserts it).
INSERT INTO auth.roles (role) VALUES ('admin')
ON CONFLICT (role) DO NOTHING;

-- Add the role to the user and make it the default Hasura role.
INSERT INTO auth.user_roles (user_id, role)
SELECT id, 'admin' FROM auth.users WHERE email = 'admin@example.com'
ON CONFLICT DO NOTHING;

UPDATE auth.users
SET default_role = 'admin'
WHERE email = 'admin@example.com';

-- Application-level allow-list used by js/admin-layout.js.
INSERT INTO public.admin_profiles (user_id, role, full_name)
SELECT id, 'admin', 'Administrator'
FROM auth.users
WHERE email = 'admin@example.com'
ON CONFLICT (user_id) DO UPDATE
SET role = 'admin';
```

The administrator must sign out and sign in again after this SQL so the JWT
contains the `admin` role.

The admin pages send `x-hasura-role: admin` explicitly. The JWT must contain
`admin` in `x-hasura-allowed-roles`; the SQL above ensures that.

---

## 8. Verify the setup

First run [`verify_setup.sql`](verify_setup.sql) in **Database → SQL Editor**.
It is read-only and returns a single JSON report confirming the tables, columns,
functions, triggers, indexes, private bucket, `admin` and `partner` roles, RLS
policies, sequence and `api_result` grant. Every expected object should show `OK`. The report includes
`admin_notifications`, the notification triggers and their indexes, and the
Home Loan tables, functions, triggers and indexes added by migration `004`,
plus the Top-Up / Takeover tables and functions added by migration `005`, the
LAP / Business Loan tables and functions added by migration `006`, the
Working Capital tables, functions and indexes added by migration `007`, the
ITR Filing tables, functions and indexes added by migration `008`, the GST
Registration & Filing tables, function and indexes added by migration `009`,
the MSME / Udyam / Gumasta tables, function and indexes added by migration
`010`, the Loan Protection Insurance table, function and indexes added by
migration `011`, the Credit Health / CIBIL tables, function and indexes added
by migration `012`, and the DSA Partner Network tables, functions, triggers,
indexes, `partner` role and RLS policies added by migration `013`.
The expected totals are **39 tables, 32 functions, 42 triggers and 130 indexes**.

Test the Home Loan wizard (`home-loan-apply.html`) separately:

1. Complete a step and use **Save & continue later**. The draft bar should show
   a resume link and the row should appear in `home_loan_drafts` with
   `status = 'draft'`.
2. Open the resume link in a new private window. The saved answers must load.
3. Complete all 8 steps and submit. You should get a `DF-2026-xxxxx` reference,
   the draft row must become `status = 'submitted'`, and rows must appear in
   `home_loan_details`, `home_loan_emis` (when EMIs were entered) and
   `loan_applicants` (co-applicants / guarantors).
4. Open **Applications** in the admin panel. The Home Loan sections
   (applicant, income, property, loan requirement, existing EMIs, follow-ups)
   must appear, and **Update verification** must set the identity status.

Then test the Top-Up wizard (`home-loan-topup-apply.html`):

1. Complete the 8 steps. The **Top-Up Need** step must show the estimated
   combined EMI and LTV, updating as the top-up amount changes.
2. Submit. Rows must appear in `home_loan_topup_details`, `home_loan_emis` (for
   the other running loans entered) and `loan_applicants` (co-applicants /
   guarantors).
3. Open **Applications**. The **Home Loan Top-Up — Existing Loan & Top-Up Need**
   section must show the old lender's details as a separate block from the new
   top-up requirement, and identity verification must work.

Then test the Takeover wizard (`home-loan-takeover-apply.html`):

1. Complete the 8 steps. The **Takeover Need** step must show the new EMI, the
   EMI difference and the estimated savings, and the additional top-up fields
   must appear only when **Additional top-up required** is checked.
2. Submit. A row must appear in `home_loan_takeover_details` (plus
   `loan_applicants` when co-applicants/guarantors were added).
3. Open **Applications**. The **Home Loan Takeover — Old Bank, Transfer &
   Savings** section must show the old-bank details, the proposed transfer and
   the estimated savings, and identity verification must work.

Then test the Loan Against Property wizard (`loan-against-property-apply.html`):

1. Complete the 8 steps. The **Loan Requirement** step must show the estimated
   EMI and LTV, the business-financials fields must appear only when
   **Self-employed** is selected, and the property fields must follow the
   **Residential / Commercial** selection.
2. Submit. A row must appear in `lap_details` (plus `home_loan_emis` for other
   running loans and `loan_applicants` for co-applicants / guarantors).
3. Open **Applications**. The **Loan Against Property — Collateral, Ownership &
   Requirement** section must show the collateral valuation, ownership, loan
   requirement and identity-verification blocks.

Then test the Business Loan wizard (`business-loan-apply.html`):

1. Complete the 8 steps, repeating for each constitution (Proprietorship,
   Partnership, LLP, Private Limited). The partner / director fields must follow
   the selected constitution, and the **Operating address** fields must appear
   only when **Same as registered address** is unchecked.
2. Submit. A row must appear in `business_loan_details` (plus `home_loan_emis`
   and `loan_applicants` when entered).
3. Open **Applications**. The **Business Loan — Business, Finance & Banking**
   section must show the business entity, registrations, financials, banking
   history, loan requirement and identity-verification blocks.

Then test the Working Capital (CC/OD) wizard (`working-capital-apply.html`):

1. Complete the 8 steps. Verify that **Existing CC/OD details** appear only when
   a facility other than **None** is selected, that the **Estimated collateral
   value** field appears only for **Property Collateral**, and that the
   indicative monthly interest updates as the proposed limit changes.
2. Add at least one additional existing facility, one co-applicant and one
   guarantor. Submit. A row must appear in `working_capital_details`, the
   facilities must appear in `working_capital_facilities`, and applicants in
   `loan_applicants`.
3. Repeat the submission for all four request types (New CC/OD Facility,
   Enhancement, Renewal, Takeover), including a case with **None** selected for
   the existing facility.
4. Open **Applications**. The **Working Capital (CC/OD) — Limit, Utilisation &
   Financials** section must show the business, financials, banking, existing
   limit position, additional facilities, requested facility and
   identity-verification blocks. The document checklist must include stock,
   debtors and creditors statements.

Then test the ITR Filing wizard (`itr-apply.html`):

1. Complete the 8 steps. Verify that the income blocks appear only for the
   selected income heads, that the assessment year follows the financial year,
   that the previous-filing block appears only for **Yes**, and that the
   indicative gross total income, deductions and taxable income update as
   amounts change.
2. Use **Save & continue later**, then open the resume link in a new private
   window. The saved answers must load, including the conditional blocks.
3. Select salary, business, house property, capital gains, other sources,
   agricultural and foreign income in separate test runs. Submit and confirm
   rows in `itr_filing_details`, the matching rows in `itr_income_items`, and
   TDS / advance tax / self-assessment rows in `itr_tax_payments`.
4. Confirm the application status is **Application Received** and the public
   form never writes `filing_status`, `acknowledgement_no` or any verification
   field.
5. Open **Applications** in the admin panel. The **ITR Filing — Taxpayer,
   Income & Computation** section must show the profile, income, deductions,
   refund and computation blocks, and the **ITR Filing Status &
   Acknowledgement** section must refuse **Filed & Verified** without an
   acknowledgement number and filing date. After entering both, confirm the
   status, filed date and verified date are stored and the customer-facing
   status reflects only the verified filing.
6. Confirm the upload page offers the ITR document types, including Form 16,
   Form 26AS, AIS / TIS, investment proofs, rent receipts, capital gains
   statements, previous ITR, ITR acknowledgement, tax payment challans and
   foreign income documents.

Then test the GST Registration & Filing wizard (`gst-apply.html`):

1. Complete the 7 steps. Verify that the return, amendment, cancellation and
   compliance blocks appear only for the selected service, that the existing
   GSTIN is required for every service except a new registration, that the
   financial year follows the return period, and that the indicative net tax
   position updates as the liability, tax paid and late fee change.
2. Use **Save & continue later**, then open the resume link in a new private
   window. The saved answers must load, including the conditional service
   blocks. Aadhaar and bank account numbers are intentionally not stored in
   drafts and must be re-entered.
3. Submit a new registration with each constitution (Proprietorship,
   Partnership, LLP, Private Limited), then a return filing, amendment,
   cancellation and compliance request in separate runs. Confirm rows in
   `gst_registration_details` and, for a return filing, `gst_return_filings`.
4. Confirm the application status is **Application Received** and the public
   form never writes `filing_status`, `acknowledgement_no`, `payment_status` or
   any verification field.
5. Open **Applications** in the admin panel. The **GST Registration & Filing —
   Applicant, Business & Tax Position** section must show the GSTIN, service
   type, return period, document checklist and tax position. The **GST Filing,
   ARN & Payment** section must refuse **Filed & Verified** without an ARN and
   filing date. The **GST Return Periods & Filing Record** section must refuse
   **Filed & Verified** for an individual return without its ARN and filing
   date.
6. Confirm the upload page offers the GST document types, including GST
   certificates, invoices, purchase bills, rent agreements / NOCs, certificates
   of incorporation, partnership deeds, board resolutions, authorisation
   letters, address proofs and bank proofs.

Then test the Loan Protection Insurance wizard (`loan-insurance-apply.html`):

1. Complete the 6 steps. Verify that the existing-insurance and co-borrower
   blocks appear only when selected, that the underwriting consent is required,
   and that the review lists the applicant, loan, coverage, nominee,
   co-borrower, underwriting and declaration sections.
2. Use **Save & continue later**, then open the resume link in a new private
   window. The saved answers must load, except the full loan account reference,
   which is intentionally not stored in drafts and must be re-entered.
3. Submit the enquiry and confirm the lead status is **Application Received**
   with proposal status **Enquiry Received** and policy status **Not Issued**.
   The public form must never write the insurer, quotation, proposal or policy
   fields.
4. Open **Applications** in the admin panel. The **Loan Protection Insurance —
   Applicant, Loan, Coverage & Underwriting** section must show the customer
   profile, loan details, coverage requirement, nominee, co-borrower and
   medical information. The **Insurance Proposal, Quotation & Policy Record**
   section must refuse a new **Policy Issued** record without the insurer name,
   policy number and policy start date, and must reject mismatched proposal and
   policy statuses.
5. Record a quotation and proposal first, then issue the policy with the
   verified policy number and dates. Confirm the customer-facing status reflects
   the administrator record. Move the policy to **Lapsed** or **Cancelled** and
   confirm the issued policy details and verification are preserved.
6. Confirm the upload page offers the insurance document types, including the
   insurer proposal form, medical reports, existing policy and insurer
   quotation.

Then test the Credit Health / CIBIL Advisory wizard (`credit-health-apply.html`):

1. Complete the 6 steps. Verify that the overdue, settlement and existing-report
   blocks appear only when selected, that account and enquiry rows can be added
   and removed, and that a fully blank repeat row is ignored while a partially
   completed row is validated. The review must list the applicant, requirement,
   credit profile, accounts, enquiries, documents and declarations.
2. Use **Save & continue later**, then open the resume link in a new private
   window. The saved answers must load, except the PAN and the last four
   characters of each account reference, which are intentionally not stored in
   drafts and must be re-entered.
3. Submit the request and confirm the lead status is **Application Received**
   with report status **Enquiry Received**. The public form must never write the
   bureau, report, score or analysis fields.
4. Open **Applications** in the admin panel. The **Credit Health & CIBIL
   Advisory — Applicant, Requirement & Credit Profile** section must show the
   applicant profile, advisory requirement, credit profile, disclosed accounts,
   enquiries and consent. The **Bureau, Report, Analysis & Follow-up Record**
   section must refuse **Bureau Request Sent** or later without a bureau name,
   and must refuse **Report Received** or later without the bureau reference and
   the actual report received date.
5. Record a bureau reference and report date, then enter the score (300–900 with
   a score date) and the analysis. Confirm **Analysis Shared** or **Closed**
   requires the analysis summary and the date it was shared. Move the request to
   **On Hold** and confirm the verified report details are preserved.
6. Confirm the upload page offers the Credit Health document types, including
   the credit report, credit-card statement, bureau correspondence, No Dues
   Certificate and settlement letter. Never upload a full credit report through
   WhatsApp or email; use the private upload link.

Then test the DSA Partner Network (`partner-program.html`,
`partner-apply.html`, `partner-login.html`, `partner-portal.html` and
`admin-partners.html`):

1. Open `partner-program.html`. The page must show the benefits, eligibility,
   products, five-stage onboarding process, commission-status explanation,
   document requirements, FAQs and **Apply Now** without promising leads, loan
   approval, sanction, disbursal or commission.
2. Complete the 5-step application. The business-registration number block must
   appear only for a registered firm, at least one product must be selected,
   and all three declarations plus consent are required. The review must show
   the applicant, firm, network and declaration sections.
3. Use **Save & continue later**, then open the resume link in a new private
   window. The saved answers must load, except the PAN and business registration
   number, which are intentionally not stored in drafts and must be re-entered.
4. Submit the application. Confirm a `DF-2026-xxxxx` reference, a
   `partner_application_details` row with status **Application Received**, and a
   `loan_leads` row with `loan_type = 'DSA Partner Network'` and
   `loan_amount = 0`. The public form must never write verification, agreement,
   profile or commission fields.
5. Upload the PAN Card, Address Proof, Photograph and, when registered, the
   Business Registration document through the private upload link. Confirm the
   `partner_documents` mirror rows appear and that verification in the admin
   Documents module updates the mirror status.
6. Sign in as an administrator and open **Partner Network**. Record each
   verification, save the agreement with the signed date and effective-from
   date, assign an executive, then approve. Approval must be refused until
   every required document and verification is **Verified**.
7. Create the partner auth user in Nhost with the exact application email.
   Provision the login from the application. Confirm `auth.user_roles` contains
   `partner`, `auth.users.default_role` is `partner`, and `partner_profiles` is
   **Active**. Provisioning must be refused before approval or before a signed,
   effective agreement.
8. Sign in at `partner-login.html`. The portal must show only that partner's
   profile, documents, agreement, lead assignments, commissions and follow-ups.
   Try another partner's lead or profile identifiers in the query; Hasura must
   return no rows. The only permitted update is **Contacted**, **Documents
   Pending** or **Submitted to Lender** on an assigned, open lead.
9. Suspend the partner and confirm the portal guard denies access. Reactivating
   requires a signed agreement whose effective-from date has arrived.
10. Confirm the `partner` role cannot select `loan_leads`, `loan_documents` or
    `loan_followups`, and cannot read another partner's rows.

Then test the general flow:

1. Open the public site and submit a loan application. It should return a
   `DF-2026-xxxxx` reference and an upload link.
2. Open the upload link, choose a PDF or image and upload it. The document
   should appear as **Pending**.
3. Sign in at `admin-login.html` with the administrator account.
4. Check **Documents**, open the file with **Open document securely**, and
   verify the 60-second presigned link works.
5. Check **Callbacks**, **Support Requests** and **Complaints** after submitting
   each public form.
6. Try to sign in with a non-admin account. The guard must sign it out and
   return it to the login page.
7. Open the admin panel in two tabs. Submit a new public form (or upload a
   document). The bell and unread badge must update in both tabs without a
   refresh.
8. Open the bell, then mark one notification read/unread, mark all read, delete
   one and clear all. Confirm that the badge and the Notification Center counts
   stay correct.
9. Open `admin-notifications.html` and test All/Unread/Read, search, type
   filter, newest/oldest sort and **Load more**.
10. Refresh the page and sign out/in. The unread count must still match the
    database.

---

## 9. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `field 'submit_loan_application_v2' not found` | The function is not tracked in Hasura. Track it under Data → SQL. |
| `permission denied for function ...` | Add the execute permission for the correct role in Hasura. |
| `permission denied for table api_result` | Grant `select` on `api_result` to that role in Hasura. |
| `Anonymous sign-in is disabled` / `signup-disabled` | Enable signup and anonymous users in Auth settings. |
| Upload fails with `permission-error` | Storage → Permissions → `anonymous` needs Upload on `loan-documents` with uploader identity enabled. |
| Admin upload fails from the public upload page | Give the `admin` role Upload + uploader identity on `loan-documents` in Storage → Permissions. |
| `This file does not belong to your upload session` | The upload was made without the anonymous session, or the file was uploaded by a different session. Reload the page and retry. |
| Admin document link fails | `admin` needs Download permission on `loan-documents` in Storage → Permissions. |
| Admin page redirects to login immediately | The JWT does not contain the `admin` role, or `admin_profiles` has no row. Re-run section 7 and sign in again. |
| `The administrator profile could not be verified` | The `admin_profiles` row is missing or the Hasura role header is not accepted. Check section 7. |
| Public forms fail while signed in | A normal Nhost `user` account intentionally has no execute permissions. Sign out (or use a private window); customers normally use the site without an account. |
| `field 'admin_notifications' not found` | Migration `003` has not been run, or the table is not tracked in Hasura. Run the migration and track the table under Data. |
| `field 'save_home_loan_draft' not found` | Migration `004` has not been run, or the Home Loan functions are not tracked in Hasura. Run the migration and track `save_home_loan_draft`, `get_home_loan_draft` and `submit_home_loan_application` under Data → SQL. |
| `permission denied for table home_loan_details` | The `admin` select/update permission on `home_loan_details` (or select on `home_loan_emis`) is missing. See section 4.3. The public wizard never touches these tables directly — it uses the `SECURITY DEFINER` functions. |
| `This draft link is invalid or has expired.` | The draft was already submitted, the link is for a different draft, or the token does not match. Start a new application. |
| Home Loan sections do not appear in the admin modal | The application is not a Home Loan lead, or `home_loan_details` was not created. Confirm the row exists and rerun `verify_setup.sql`. |
| `field 'submit_home_loan_topup_application' not found` | Migration `005` has not been run, or the function is not tracked in Hasura. Run the migration and track both new functions under Data → SQL. |
| Top-Up / Takeover sections do not appear in the admin modal | The lead is not a Top-Up / Takeover application, or `home_loan_topup_details` / `home_loan_takeover_details` was not created. Confirm the row exists and rerun `verify_setup.sql`. |
| `permission denied for table home_loan_topup_details` (or `home_loan_takeover_details`) | The `admin` select permission (and update limited to the identity-verification columns) is missing. See section 4.3. The wizards never touch these tables directly — they use the `SECURITY DEFINER` functions. |
| Applications list fails to load after adding migration `005` | The two new detail tables are not tracked in Hasura, or the `admin` select permission is missing. Untracked/missing fields fail the whole query. Track both tables and grant `select`. |
| `field 'submit_lap_application' not found` (or `submit_business_loan_application`) | Migration `006` has not been run, or the function is not tracked in Hasura. Run the migration and track both new functions under Data → SQL. |
| LAP / Business Loan sections do not appear in the admin modal | The lead is not a LAP / Business Loan application, or `lap_details` / `business_loan_details` was not created. Confirm the row exists and rerun `verify_setup.sql`. |
| `permission denied for table lap_details` (or `business_loan_details`) | The `admin` select permission (and update limited to the identity-verification columns) is missing. See section 4.3. The wizards never touch these tables directly — they use the `SECURITY DEFINER` functions. |
| Applications list fails to load after adding migration `006` | The two new detail tables are not tracked in Hasura, or the `admin` select permission is missing. Untracked/missing fields fail the whole query. Track both tables and grant `select`. |
| `field 'submit_working_capital_application' not found` | Migration `007` has not been run, or the function is not tracked in Hasura. Run the migration and track the function under Data → SQL. |
| Working Capital section does not appear in the admin modal | The lead is not a Working Capital application, or `working_capital_details` was not created. Confirm the row exists and rerun `verify_setup.sql`. |
| `permission denied for table working_capital_details` (or `working_capital_facilities`) | The `admin` select permission (and update limited to the identity-verification columns on `working_capital_details`) is missing. See section 4.3. The wizard never touches these tables directly — it uses the `SECURITY DEFINER` function. |
| Applications list fails to load after adding migration `007` | `working_capital_details` / `working_capital_facilities` is not tracked in Hasura, or the `admin` select permission is missing. Untracked/missing fields fail the whole query. Track both tables and grant `select`. |
| `field 'submit_itr_application' not found` | Migration `008` has not been run, or the function is not tracked in Hasura. Run the migration and track the function under Data → SQL. |
| ITR Filing section does not appear in the admin modal | The lead is not an ITR Filing application, or `itr_filing_details` was not created. Confirm the row exists and rerun `verify_setup.sql`. |
| `permission denied for table itr_filing_details` (or `itr_income_items` / `itr_tax_payments`) | The `admin` select permission is missing, or the update permission on `itr_filing_details` is missing. Grant select on all three tables and update only on the identity and filing-status columns. See section 4.3. |
| Applications list fails to load after adding migration `008` | `itr_filing_details`, `itr_income_items` or `itr_tax_payments` is not tracked in Hasura, or the `admin` select permission is missing. The dashboard automatically retries without ITR fields, but track the tables and grant `select` to see the data. |
| The ITR form shows **Filed & Verified** too early | Never set this status manually before the portal filing and acknowledgement are verified. The admin UI requires an acknowledgement number and filing date; confirm both against the Income Tax e-filing portal before saving. |
| `field 'submit_gst_application' not found` | Migration `009` has not been run, or the function is not tracked in Hasura. Run the migration and track the function under Data → SQL. |
| GST section does not appear in the admin modal | The lead is not a GST Registration & Filing application, or `gst_registration_details` was not created. Confirm the row exists and rerun `verify_setup.sql`. |
| Applications list fails to load after adding migration `009` | `gst_registration_details` or `gst_return_filings` is not tracked in Hasura, or the `admin` select permission is missing. The dashboard automatically retries without GST fields, but track the tables and grant `select` to see the data. |
| The GST form shows **Filed & Verified** too early | Never set this status manually before the actual GST portal action and ARN / approval verification. The admin UI requires an ARN and filing date; confirm both against the GST portal before saving. |
| The GST return row shows **Filed & Verified** too early | Confirm the return was actually filed for that period, then enter the ARN and the actual filing date. Never mark a return complete from a pending portal attempt. |
| `field 'submit_msme_application' not found` | Migration `010` has not been run, or the function is not tracked in Hasura. Run the migration and track the function under Data → SQL. |
| MSME / Udyam section does not appear in the admin modal | The lead is not an MSME application, or `msme_registration_details` was not created. Confirm the row exists and rerun `verify_setup.sql`. |
| Applications list fails to load after adding migration `010` | `msme_registration_details`, `msme_promoters` or `msme_registrations` is not tracked in Hasura, or the `admin` select permission is missing. The dashboard automatically retries without MSME fields, but track the tables and grant `select` to see the data. |
| The MSME application shows **Approved & Verified** too early | Never set this status manually before the actual Udyam, Shop & Establishment or registrar portal action and certificate / acknowledgement verification. The admin UI requires a certificate number and approval date; confirm both against the government portal before saving. |
| An MSME registration row shows **Approved & Verified** too early | Each registration row needs its own certificate / acknowledgement number and actual approval date. Never mark a row complete from a pending or failed portal attempt. |
| `field 'submit_loan_insurance_application' not found` | Migration `011` has not been run, or the function is not tracked in Hasura. Run the migration and track the function under Data → SQL. |
| Loan Protection Insurance section does not appear in the admin modal | The lead is not an insurance application, or `loan_insurance_details` was not created. Confirm the row exists and rerun `verify_setup.sql`. |
| Applications list fails to load after adding migration `011` | `loan_insurance_details` is not tracked in Hasura, or the `admin` select permission is missing. The dashboard automatically retries without insurance fields, but track the table and grant `select` to see the data. |
| The insurance enquiry shows **Policy Issued** too early | Never record a quotation, proposal or policy before the authorised insurer confirms it and the policy document is verified. For a new policy the admin UI requires the insurer name, policy number and policy start date, and both the proposal and policy statuses must be set to Policy Issued. A quotation is not cover. |
| The insurance policy cannot be marked **Lapsed** or **Cancelled** | Keep the proposal status at Policy Issued, choose Lapsed or Cancelled as the policy status, and keep the insurer name, policy number and start date from the issued policy. These post-issuance statuses preserve the verified policy record. |
| `field 'submit_credit_health_application' not found` | Migration `012` has not been run, or the function is not tracked in Hasura. Run the migration and track the function under Data → SQL. |
| Credit Health / CIBIL section does not appear in the admin modal | The lead is not a Credit Health application, or `credit_health_details` was not created. Confirm the row exists and rerun `verify_setup.sql`. |
| Applications list fails to load after adding migration `012` | `credit_health_details`, `credit_accounts` or `credit_enquiries` is not tracked in Hasura, or the `admin` select permission is missing. The dashboard automatically retries without Credit Health fields, but track the tables and grant `select` to see the data. |
| The Credit Health request shows **Report Received** too early | Never record a bureau reference, report date, score or analysis before the authorised bureau has actually supplied the report and it has been verified. The admin UI requires the bureau name, bureau reference and the actual report received date; a score also needs a score date and must be between 300 and 900. |
| The Credit Health request cannot be marked **Analysis Shared** or **Closed** | Enter the analysis summary and the actual date it was shared. The shared date cannot be before the report received date, and no date can be in the future. |
| A credit report or full bureau data appears in a public URL or log | Do not store full reports in public storage or paste them into emails, WhatsApp or ordinary logs. Keep only the bureau reference and the advisory summary in the database, and upload documents through the private `loan-documents` bucket. |
| `field 'submit_partner_application' not found` | Migration `013` has not been run, or the function is not tracked in Hasura. Run the migration and track the function under Data → SQL. |
| DSA Partner Network section does not appear in the admin application modal | The lead is not a partner application, or `partner_application_details` was not created. Confirm the row exists and rerun `verify_setup.sql`. |
| Applications list fails to load after adding migration `013` | One or more partner tables are not tracked in Hasura, or the `admin` select permission is missing. The dashboard automatically retries without the partner fields, but track all eight tables and grant `select` to see the data. |
| `admin-partners.html` shows the partner setup warning | The eight partner tables are not tracked in Hasura, or the `admin` permissions are missing. Apply migration `013`, track the tables and functions, and grant the permissions in sections 3 and 4.3. |
| Partner approval is refused | Verify the PAN, address, photograph and, when registered, business registration documents; complete the matching verification rows as **Verified**; and assign an executive. The database trigger validates all of them again. |
| Partner login cannot be provisioned | The application must be **Approved**, the agreement must be **Signed** or **Active** with a signed date and an effective-from date that has arrived, and the auth user email must exactly match the application email. |
| Partner login says the account is not active | `partner_profiles.status` must be **Active**. Suspended, Inactive and Pending Agreement profiles are denied. Reactivation requires a signed, effective agreement. |
| The partner portal shows no rows | The Hasura relationship or the partner select row filter is missing. Create the relationships and filters in section 4.6. |
| A partner can see another partner's records | Remove the partner select permission immediately and correct the row filter in section 4.6. Never rely on the portal query alone; Hasura row filters and the partner RLS policies are the boundary. |
| The partner cannot update an assigned lead | The `partner` role needs execute on `update_partner_lead_status`, and the lead must be assigned to that partner and still open. Only Contacted, Documents Pending and Submitted to Lender are permitted. |
| `permission denied for table admin_notifications` | The `admin` select/update/delete permissions or the recipient row filter are missing. See section 4.4. |
| The bell says **Notifications unavailable** | The table is missing, untracked, the `admin` select permission is missing, or **Allow aggregations** is off. Run `verify_setup.sql` and check section 4.4. |
| New records do not create notifications | Run migration `003` and confirm the seven notification triggers exist. The trigger needs at least one row in `admin_profiles`; without one it writes a shared notification instead. |
| Real-time updates do not arrive instantly | The WebSocket may be blocked by a proxy or firewall. The panel automatically falls back to polling every 30 seconds. Allow `wss://*.nhost.run` and check the browser console. |
| Notifications disappear for another admin | Each admin receives a private row, so delete/clear is isolated. Shared `recipient_user_id = NULL` rows are intentionally visible to all admins. |

---

## 10. Hosting

The site is static HTML/CSS/JS. It can be hosted on any static host (Netlify,
Cloudflare Pages, GitHub Pages, Hostinger, GoDaddy cPanel, etc.). Nhost hosts
the database, auth, GraphQL API and files, not the HTML.

Owning a GoDaddy domain is not the same as having hosting. Point the domain at
the static host only after the host is chosen and the files are uploaded.

Never upload `nhost/` to a public web root. Only the site files (`*.html`,
`css/`, `js/`, `images/`, fonts, etc.) need to be published.

---

## 11. Security checklist

- [ ] No service-role key, admin secret or database password in the frontend.
- [ ] `loan-documents` bucket is private.
- [ ] `public` and `anonymous` have no business-table permissions.
- [ ] `register_document` is not executable by `public`.
- [ ] `user` role has no business-table permissions.
- [ ] `admin_notifications` has no insert permission for any browser role.
- [ ] Admin notification select/update/delete use the recipient row filter.
- [ ] The notification select permission has **Allow aggregations** enabled.
- [ ] The notification update permission is limited to `is_read`.
- [ ] Admin role is granted only through `auth.user_roles` + `admin_profiles`.
- [ ] Presigned document links expire quickly and are never stored in the page.
- [ ] `home_loan_drafts` has no permissions for any browser role.
- [ ] `home_loan_details` admin update is limited to the identity-verification columns.
- [ ] `home_loan_topup_details` / `home_loan_takeover_details` admin update is limited to the identity-verification columns.
- [ ] `lap_details` / `business_loan_details` admin update is limited to the identity-verification columns.
- [ ] Aadhaar is masked server-side; only the last 4 digits are stored.
- [ ] RLS is disabled on the original business tables; Hasura permissions are the access-control layer.
- [ ] RLS is enabled on the eight partner tables and the partner RLS policies are present.
- [ ] The `partner` role has select only on its own rows and execute only on `update_partner_lead_status`.
- [ ] The `partner` role has no access to `loan_leads`, `loan_documents`, `loan_followups` or admin tables.
- [ ] The partner relationships and row filters in section 4.6 are configured and tested with a partner account.
- [ ] Partner logins are provisioned only after approval and a signed, effective agreement.

-- =============================================================================
-- NHOST / HASURA MIGRATION: 008_itr_filing.sql
-- PROJECT: Dhanvi Finserv
--
-- Run this ONCE, after 007, in the Nhost dashboard:
--   Database -> SQL Editor -> paste -> Run
--
-- It adds the structured ITR Filing assistance system behind itr-apply.html:
--
--   1. public.itr_filing_details    - applicant, PAN/Aadhaar, addresses,
--      assessment/financial year, taxpayer category, residential status,
--      income heads, previous filing history, tax regime, TDS/advance tax,
--      deductions, exemptions, refund bank details and the administrator
--      controlled filing / verification fields.
--   2. public.itr_income_items      - one row per declared income head
--      (1:N with the lead), used for the admin income breakdown.
--   3. public.itr_tax_payments      - declared TDS, advance tax and
--      self-assessment tax credits (1:N with the lead).
--   4. submit_itr_application()     - validate and create an ITR Filing
--      application (loan_leads + itr_filing_details + income items + tax
--      payments) and consume the draft.
--   5. Extra document types (Form 16, Form 26AS, AIS / TIS, Investment
--      Proofs, Rent Receipts, Capital Gains Statement, Previous ITR,
--      ITR Acknowledgement, Tax Payment Challan) added to
--      public.loan_documents.document_type and to register_document().
--   6. Widens the loan_leads.loan_type and loan_amount constraints so
--      service applications (which are not loan requests) can be stored
--      without fake loan amounts.
--
-- DRAFT STORAGE
--   Save / resume is shared with the other application wizards: the page calls
--   the existing save_home_loan_draft() / get_home_loan_draft() against
--   public.home_loan_drafts. The draft payload is opaque JSONB, so no new draft
--   table or draft function is required.
--
-- IMPORTANT
--   * Hasura permissions are the access-control layer, NOT Postgres RLS.
--   * Do not enable RLS on these tables.
--   * Every function returns SETOF public.api_result so Hasura can track it.
--   * Other loan types are untouched: they keep using their own functions.
--   * An ITR is never marked as filed by this migration or by the wizard.
--     Filing status starts at 'Application Received' and only an administrator
--     can move it to 'Filed & Verified' after actual portal filing and
--     acknowledgement verification.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Allow service applications on the shared loan_leads table
-- -----------------------------------------------------------------------------
-- The original 001 constraint only allowed loan products and required a loan
-- amount of at least Rs. 10,000. ITR / GST / MSME / insurance / credit-health
-- requests are service engagements, not loan applications, so they need a
-- wider loan_type list and a zero-or-more amount. Existing loan application
-- functions still validate their own minimum amounts.

DO $$
DECLARE
    v_constraint RECORD;
BEGIN
    FOR v_constraint IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'public.loan_leads'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%loan_type%'
    LOOP
        EXECUTE format('ALTER TABLE public.loan_leads DROP CONSTRAINT %I', v_constraint.conname);
    END LOOP;

    FOR v_constraint IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'public.loan_leads'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%loan_amount%'
    LOOP
        EXECUTE format('ALTER TABLE public.loan_leads DROP CONSTRAINT %I', v_constraint.conname);
    END LOOP;
END $$;

ALTER TABLE public.loan_leads
    DROP CONSTRAINT IF EXISTS loan_leads_loan_type_check;
ALTER TABLE public.loan_leads
    ADD CONSTRAINT loan_leads_loan_type_check CHECK (loan_type IN (
        'Home Loan', 'Home Loan Top-Up', 'Home Loan Takeover',
        'Loan Against Property', 'Education Loan', 'Vehicle Loan',
        'Business Loan', 'Personal Loan', 'Working Capital (CC/OD)',
        'ITR Filing', 'GST Registration & Filing',
        'MSME / Udyam Registration', 'Loan Protection Insurance',
        'Credit Health / CIBIL Advisory', 'DSA Partner Network'
    ));

ALTER TABLE public.loan_leads
    DROP CONSTRAINT IF EXISTS loan_leads_loan_amount_check;
ALTER TABLE public.loan_leads
    ADD CONSTRAINT loan_leads_loan_amount_check CHECK (loan_amount >= 0);

-- -----------------------------------------------------------------------------
-- 1. ITR Filing details (1:1 with loan_leads)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.itr_filing_details (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_lead_id UUID NOT NULL UNIQUE REFERENCES public.loan_leads(id) ON DELETE CASCADE,

    -- Applicant identity
    first_name TEXT NOT NULL,
    middle_name TEXT,
    last_name TEXT NOT NULL,
    date_of_birth DATE NOT NULL,
    gender TEXT,
    mobile TEXT NOT NULL,
    email TEXT,
    pan_number TEXT NOT NULL,
    aadhaar_masked TEXT,
    aadhaar_verification_method TEXT,

    -- Administrator-controlled identity verification
    identity_verification_status TEXT NOT NULL DEFAULT 'Pending'
        CHECK (identity_verification_status IN ('Pending', 'Verified', 'Rejected')),
    identity_verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    identity_verified_at TIMESTAMPTZ,
    identity_notes TEXT,

    -- Residential status and addresses
    residential_status TEXT NOT NULL
        CHECK (residential_status IN
            ('Resident', 'Non-Resident', 'Resident but Not Ordinarily Resident')),
    current_address_line TEXT,
    current_address_city TEXT,
    current_address_state TEXT,
    current_address_pincode TEXT,
    same_as_current BOOLEAN NOT NULL DEFAULT true,
    permanent_address_line TEXT,
    permanent_address_city TEXT,
    permanent_address_state TEXT,
    permanent_address_pincode TEXT,

    -- Return profile
    assessment_year TEXT NOT NULL,
    financial_year TEXT NOT NULL,
    taxpayer_category TEXT NOT NULL
        CHECK (taxpayer_category IN (
            'Salaried Individual', 'Business Owner', 'Self-Employed Professional',
            'Freelancer / Consultant', 'Partner in a Firm', 'Company Director',
            'HUF', 'Other')),
    return_type TEXT NOT NULL
        CHECK (return_type IN
            ('Original Return', 'Revised Return', 'Belated Return', 'Updated Return (ITR-U)')),
    itr_form_preference TEXT
        CHECK (itr_form_preference IS NULL OR itr_form_preference IN
            ('ITR-1', 'ITR-2', 'ITR-3', 'ITR-4', 'Not sure - advise me')),

    -- Income heads
    has_salary_income BOOLEAN NOT NULL DEFAULT false,
    salary_income NUMERIC CHECK (salary_income IS NULL OR salary_income >= 0),
    employer_count INTEGER CHECK (employer_count IS NULL OR employer_count >= 0),
    has_business_income BOOLEAN NOT NULL DEFAULT false,
    business_income NUMERIC CHECK (business_income IS NULL OR business_income >= 0),
    business_name TEXT,
    business_constitution TEXT,
    has_house_property BOOLEAN NOT NULL DEFAULT false,
    house_property_income NUMERIC,
    house_property_details TEXT,
    has_capital_gains BOOLEAN NOT NULL DEFAULT false,
    capital_gains_income NUMERIC CHECK (capital_gains_income IS NULL OR capital_gains_income >= 0),
    capital_gains_type TEXT,
    has_other_sources BOOLEAN NOT NULL DEFAULT false,
    other_sources_income NUMERIC CHECK (other_sources_income IS NULL OR other_sources_income >= 0),
    has_agricultural_income BOOLEAN NOT NULL DEFAULT false,
    agricultural_income NUMERIC CHECK (agricultural_income IS NULL OR agricultural_income >= 0),
    has_foreign_income BOOLEAN NOT NULL DEFAULT false,
    foreign_income NUMERIC CHECK (foreign_income IS NULL OR foreign_income >= 0),
    foreign_assets_details TEXT,
    gross_total_income NUMERIC CHECK (gross_total_income IS NULL OR gross_total_income >= 0),

    -- Previous filing history
    previously_filed_itr BOOLEAN NOT NULL DEFAULT false,
    last_filed_assessment_year TEXT,
    last_acknowledgement_no TEXT,
    pending_notices TEXT,
    filing_history_notes TEXT,

    -- Tax regime and taxes paid
    tax_regime TEXT NOT NULL
        CHECK (tax_regime IN ('Old Regime', 'New Regime', 'Not sure - advise me')),
    tds_deducted BOOLEAN NOT NULL DEFAULT false,
    tds_amount NUMERIC CHECK (tds_amount IS NULL OR tds_amount >= 0),
    advance_tax_paid BOOLEAN NOT NULL DEFAULT false,
    advance_tax_amount NUMERIC CHECK (advance_tax_amount IS NULL OR advance_tax_amount >= 0),
    self_assessment_tax_paid NUMERIC
        CHECK (self_assessment_tax_paid IS NULL OR self_assessment_tax_paid >= 0),

    -- Deductions and exemptions
    deduction_80c NUMERIC CHECK (deduction_80c IS NULL OR deduction_80c >= 0),
    deduction_80d NUMERIC CHECK (deduction_80d IS NULL OR deduction_80d >= 0),
    deduction_80e NUMERIC CHECK (deduction_80e IS NULL OR deduction_80e >= 0),
    deduction_80g NUMERIC CHECK (deduction_80g IS NULL OR deduction_80g >= 0),
    deduction_80tta_ttb NUMERIC CHECK (deduction_80tta_ttb IS NULL OR deduction_80tta_ttb >= 0),
    other_deductions NUMERIC CHECK (other_deductions IS NULL OR other_deductions >= 0),
    total_deductions NUMERIC CHECK (total_deductions IS NULL OR total_deductions >= 0),
    hra_exemption NUMERIC CHECK (hra_exemption IS NULL OR hra_exemption >= 0),
    lta_exemption NUMERIC CHECK (lta_exemption IS NULL OR lta_exemption >= 0),
    other_exemptions NUMERIC CHECK (other_exemptions IS NULL OR other_exemptions >= 0),
    total_exemptions NUMERIC CHECK (total_exemptions IS NULL OR total_exemptions >= 0),
    tax_saving_investments TEXT,

    -- Refund and bank details (masked account number only)
    refund_expected BOOLEAN NOT NULL DEFAULT false,
    refund_amount NUMERIC CHECK (refund_amount IS NULL OR refund_amount >= 0),
    bank_account_name TEXT,
    bank_account_number_masked TEXT,
    ifsc_code TEXT,

    -- Indicative computation captured at submission. Final computation is
    -- prepared and approved by the tax team, never by the public form.
    taxable_income NUMERIC CHECK (taxable_income IS NULL OR taxable_income >= 0),
    estimated_tax_liability NUMERIC
        CHECK (estimated_tax_liability IS NULL OR estimated_tax_liability >= 0),
    computation_notes TEXT,

    -- Administrator-controlled filing status. The public form can never set
    -- any of these fields.
    filing_status TEXT NOT NULL DEFAULT 'Application Received'
        CHECK (filing_status IN (
            'Application Received', 'Documents Pending', 'Under Review',
            'Return Prepared', 'Client Approval Pending',
            'Filed - Awaiting Verification', 'Filed & Verified',
            'On Hold', 'Cancelled')),
    filing_status_notes TEXT,
    acknowledgement_no TEXT,
    filed_at TIMESTAMPTZ,
    filed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    verified_at TIMESTAMPTZ,
    verification_method TEXT,
    filing_remarks TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS itr_filing_details_lead_idx
    ON public.itr_filing_details (loan_lead_id);
CREATE INDEX IF NOT EXISTS itr_filing_details_identity_idx
    ON public.itr_filing_details (identity_verification_status);
CREATE INDEX IF NOT EXISTS itr_filing_details_pan_idx
    ON public.itr_filing_details (pan_number);
CREATE INDEX IF NOT EXISTS itr_filing_details_ay_idx
    ON public.itr_filing_details (assessment_year);
CREATE INDEX IF NOT EXISTS itr_filing_details_filing_idx
    ON public.itr_filing_details (filing_status);
CREATE INDEX IF NOT EXISTS itr_filing_details_category_idx
    ON public.itr_filing_details (taxpayer_category);

DROP TRIGGER IF EXISTS update_itr_filing_details_modtime
    ON public.itr_filing_details;
CREATE TRIGGER update_itr_filing_details_modtime
    BEFORE UPDATE ON public.itr_filing_details
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. Declared income heads (1:N with loan_leads)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.itr_income_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_lead_id UUID NOT NULL REFERENCES public.loan_leads(id) ON DELETE CASCADE,
    income_head TEXT NOT NULL
        CHECK (income_head IN (
            'Salary', 'Business / Profession', 'House Property',
            'Capital Gains', 'Other Sources', 'Agricultural Income',
            'Foreign Income')),
    amount NUMERIC NOT NULL,
    details TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS itr_income_items_lead_idx
    ON public.itr_income_items (loan_lead_id);
CREATE INDEX IF NOT EXISTS itr_income_items_head_idx
    ON public.itr_income_items (income_head);

-- -----------------------------------------------------------------------------
-- 3. Declared tax credits (1:N with loan_leads)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.itr_tax_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_lead_id UUID NOT NULL REFERENCES public.loan_leads(id) ON DELETE CASCADE,
    payment_type TEXT NOT NULL
        CHECK (payment_type IN ('TDS', 'Advance Tax', 'Self-Assessment Tax')),
    deductor_or_bank TEXT,
    reference_no TEXT,
    amount NUMERIC NOT NULL CHECK (amount >= 0),
    financial_year TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS itr_tax_payments_lead_idx
    ON public.itr_tax_payments (loan_lead_id);
CREATE INDEX IF NOT EXISTS itr_tax_payments_type_idx
    ON public.itr_tax_payments (payment_type);

-- -----------------------------------------------------------------------------
-- 4. submit_itr_application
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_itr_application(
    p_payload JSONB,
    p_draft_id UUID,
    p_draft_token UUID
)
RETURNS SETOF public.api_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id UUID;
    v_ref TEXT;
    v_token UUID;

    v_personal JSONB := coalesce(p_payload->'personal', '{}'::JSONB);
    v_profile JSONB := coalesce(p_payload->'tax_profile', '{}'::JSONB);
    v_income JSONB := coalesce(p_payload->'income', '{}'::JSONB);
    v_filing JSONB := coalesce(p_payload->'filing', '{}'::JSONB);
    v_taxes JSONB := coalesce(p_payload->'taxes', '{}'::JSONB);
    v_deductions JSONB := coalesce(p_payload->'deductions', '{}'::JSONB);
    v_refund JSONB := coalesce(p_payload->'refund', '{}'::JSONB);
    v_address JSONB := coalesce(p_payload->'address', '{}'::JSONB);
    v_current JSONB;
    v_permanent JSONB;

    v_first TEXT := btrim(coalesce(v_personal->>'first_name', ''));
    v_middle TEXT := nullif(btrim(coalesce(v_personal->>'middle_name', '')), '');
    v_last TEXT := btrim(coalesce(v_personal->>'last_name', ''));
    v_full_name TEXT;
    v_dob DATE := nullif(v_personal->>'date_of_birth', '')::DATE;
    v_gender TEXT := nullif(btrim(coalesce(v_personal->>'gender', '')), '');
    v_mobile TEXT := regexp_replace(coalesce(v_personal->>'mobile', ''), '[^0-9]', '', 'g');
    v_email TEXT := nullif(lower(btrim(coalesce(v_personal->>'email', ''))), '');
    v_pan TEXT := upper(btrim(coalesce(v_personal->>'pan_number', '')));
    v_aadhaar TEXT := regexp_replace(coalesce(v_personal->>'aadhaar_number', ''), '[^0-9]', '', 'g');
    v_aadhaar_masked TEXT;
    v_aadhaar_method TEXT := nullif(btrim(coalesce(v_personal->>'aadhaar_verification_method', '')), '');
    v_age INTEGER;

    v_residential TEXT := btrim(coalesce(v_profile->>'residential_status', ''));
    v_ay TEXT := btrim(coalesce(v_profile->>'assessment_year', ''));
    v_fy TEXT := btrim(coalesce(v_profile->>'financial_year', ''));
    v_category TEXT := btrim(coalesce(v_profile->>'taxpayer_category', ''));
    v_return_type TEXT := btrim(coalesce(v_profile->>'return_type', ''));
    v_itr_form TEXT := nullif(btrim(coalesce(v_profile->>'itr_form_preference', '')), '');

    v_salary_flag BOOLEAN := coalesce((v_income->>'has_salary_income')::BOOLEAN, false);
    v_salary NUMERIC := nullif(v_income->>'salary_income', '')::NUMERIC;
    v_employers INTEGER := nullif(v_income->>'employer_count', '')::INTEGER;
    v_business_flag BOOLEAN := coalesce((v_income->>'has_business_income')::BOOLEAN, false);
    v_business NUMERIC := nullif(v_income->>'business_income', '')::NUMERIC;
    v_business_name TEXT := nullif(btrim(coalesce(v_income->>'business_name', '')), '');
    v_business_constitution TEXT := nullif(btrim(coalesce(v_income->>'business_constitution', '')), '');
    v_house_flag BOOLEAN := coalesce((v_income->>'has_house_property')::BOOLEAN, false);
    v_house NUMERIC := nullif(v_income->>'house_property_income', '')::NUMERIC;
    v_house_details TEXT := nullif(btrim(coalesce(v_income->>'house_property_details', '')), '');
    v_cg_flag BOOLEAN := coalesce((v_income->>'has_capital_gains')::BOOLEAN, false);
    v_cg NUMERIC := nullif(v_income->>'capital_gains_income', '')::NUMERIC;
    v_cg_type TEXT := nullif(btrim(coalesce(v_income->>'capital_gains_type', '')), '');
    v_other_flag BOOLEAN := coalesce((v_income->>'has_other_sources')::BOOLEAN, false);
    v_other NUMERIC := nullif(v_income->>'other_sources_income', '')::NUMERIC;
    v_agri_flag BOOLEAN := coalesce((v_income->>'has_agricultural_income')::BOOLEAN, false);
    v_agri NUMERIC := nullif(v_income->>'agricultural_income', '')::NUMERIC;
    v_foreign_flag BOOLEAN := coalesce((v_income->>'has_foreign_income')::BOOLEAN, false);
    v_foreign NUMERIC := nullif(v_income->>'foreign_income', '')::NUMERIC;
    v_foreign_details TEXT := nullif(btrim(coalesce(v_income->>'foreign_assets_details', '')), '');
    v_gti NUMERIC;

    v_prev_filed BOOLEAN := coalesce((v_filing->>'previously_filed_itr')::BOOLEAN, false);
    v_last_ay TEXT := nullif(btrim(coalesce(v_filing->>'last_filed_assessment_year', '')), '');
    v_last_ack TEXT := nullif(btrim(coalesce(v_filing->>'last_acknowledgement_no', '')), '');
    v_pending_notices TEXT := nullif(btrim(coalesce(v_filing->>'pending_notices', '')), '');
    v_history_notes TEXT := nullif(btrim(coalesce(v_filing->>'filing_history_notes', '')), '');
    v_regime TEXT := btrim(coalesce(v_filing->>'tax_regime', ''));

    v_tds_flag BOOLEAN := coalesce((v_taxes->>'tds_deducted')::BOOLEAN, false);
    v_tds NUMERIC := nullif(v_taxes->>'tds_amount', '')::NUMERIC;
    v_advance_flag BOOLEAN := coalesce((v_taxes->>'advance_tax_paid')::BOOLEAN, false);
    v_advance NUMERIC := nullif(v_taxes->>'advance_tax_amount', '')::NUMERIC;
    v_self_tax NUMERIC := nullif(v_taxes->>'self_assessment_tax_paid', '')::NUMERIC;

    v_80c NUMERIC := nullif(v_deductions->>'deduction_80c', '')::NUMERIC;
    v_80d NUMERIC := nullif(v_deductions->>'deduction_80d', '')::NUMERIC;
    v_80e NUMERIC := nullif(v_deductions->>'deduction_80e', '')::NUMERIC;
    v_80g NUMERIC := nullif(v_deductions->>'deduction_80g', '')::NUMERIC;
    v_80tta NUMERIC := nullif(v_deductions->>'deduction_80tta_ttb', '')::NUMERIC;
    v_other_ded NUMERIC := nullif(v_deductions->>'other_deductions', '')::NUMERIC;
    v_total_ded NUMERIC;
    v_hra NUMERIC := nullif(v_deductions->>'hra_exemption', '')::NUMERIC;
    v_lta NUMERIC := nullif(v_deductions->>'lta_exemption', '')::NUMERIC;
    v_other_exempt NUMERIC := nullif(v_deductions->>'other_exemptions', '')::NUMERIC;
    v_total_exempt NUMERIC;
    v_tax_saving TEXT := nullif(btrim(coalesce(v_deductions->>'tax_saving_investments', '')), '');

    v_refund_flag BOOLEAN := coalesce((v_refund->>'refund_expected')::BOOLEAN, false);
    v_refund_amount NUMERIC := nullif(v_refund->>'refund_amount', '')::NUMERIC;
    v_bank_name TEXT := nullif(btrim(coalesce(v_refund->>'bank_account_name', '')), '');
    v_bank_account TEXT := nullif(regexp_replace(coalesce(v_refund->>'bank_account_number', ''), '[^0-9]', '', 'g'), '');
    v_bank_masked TEXT;
    v_ifsc TEXT := upper(nullif(btrim(coalesce(v_refund->>'ifsc_code', '')), ''));

    v_same BOOLEAN := coalesce((v_address->>'same_as_current')::BOOLEAN, true);
    v_cur_line TEXT;
    v_cur_city TEXT;
    v_cur_state TEXT;
    v_cur_pin TEXT;
    v_per_line TEXT;
    v_per_city TEXT;
    v_per_state TEXT;
    v_per_pin TEXT;

    v_consent BOOLEAN := coalesce((p_payload->>'consent')::BOOLEAN, false);
    v_consent_version TEXT := coalesce(nullif(p_payload->>'consent_version', ''), '2026-11');
    v_source TEXT := nullif(btrim(coalesce(p_payload->>'source_page', '')), '');

    v_taxable NUMERIC;
    v_employment TEXT;
    v_applicant_type TEXT;
    v_message TEXT;
BEGIN
    -- ---- Payload shape -----------------------------------------------------
    IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'The application could not be submitted. Please try again.' USING ERRCODE = '22023';
    END IF;
    IF length(p_payload::text) > 250000 THEN
        RAISE EXCEPTION 'This application is too large to submit.' USING ERRCODE = '22023';
    END IF;

    -- ---- Applicant details -------------------------------------------------
    IF v_first = '' OR v_last = '' THEN
        RAISE EXCEPTION 'Please enter your first and last name.' USING ERRCODE = '22023';
    END IF;
    v_full_name := btrim(concat_ws(' ', v_first, v_middle, v_last));

    IF v_dob IS NULL THEN
        RAISE EXCEPTION 'Please enter your date of birth.' USING ERRCODE = '22023';
    END IF;
    v_age := extract(year FROM age((now() AT TIME ZONE 'Asia/Kolkata')::date, v_dob));
    IF v_age < 18 THEN
        RAISE EXCEPTION 'The applicant must be at least 18 years old.' USING ERRCODE = '22023';
    END IF;
    IF v_age > 100 THEN
        RAISE EXCEPTION 'Please enter a valid date of birth.' USING ERRCODE = '22023';
    END IF;

    IF v_mobile !~ '^[6-9][0-9]{9}$' THEN
        RAISE EXCEPTION 'Please enter a valid 10-digit Indian mobile number.' USING ERRCODE = '22023';
    END IF;
    IF v_email IS NULL OR v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
        RAISE EXCEPTION 'Please enter a valid email address.' USING ERRCODE = '22023';
    END IF;
    IF v_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' THEN
        RAISE EXCEPTION 'Please enter a valid PAN (e.g. ABCDE1234F).' USING ERRCODE = '22023';
    END IF;
    IF v_aadhaar <> '' AND length(v_aadhaar) <> 12 THEN
        RAISE EXCEPTION 'Please enter a valid 12-digit Aadhaar number.' USING ERRCODE = '22023';
    END IF;
    v_aadhaar_masked := CASE WHEN length(v_aadhaar) = 12
        THEN 'XXXX XXXX ' || right(v_aadhaar, 4)
        ELSE NULL END;
    IF v_aadhaar_method IS NOT NULL AND v_aadhaar_method NOT IN (
        'Aadhaar OTP on e-filing portal', 'DigiLocker',
        'Net banking / bank account EVC', 'Digital Signature Certificate (DSC)',
        'Not sure - advise me') THEN
        RAISE EXCEPTION 'Please select a valid Aadhaar / e-verification method.' USING ERRCODE = '22023';
    END IF;

    -- ---- Return profile ----------------------------------------------------
    IF v_residential NOT IN ('Resident', 'Non-Resident', 'Resident but Not Ordinarily Resident') THEN
        RAISE EXCEPTION 'Please select your residential status.' USING ERRCODE = '22023';
    END IF;
    IF v_ay NOT IN ('2026-27', '2025-26', '2024-25', '2023-24', '2022-23') THEN
        RAISE EXCEPTION 'Please select a valid assessment year.' USING ERRCODE = '22023';
    END IF;
    IF v_fy NOT IN ('2025-26', '2024-25', '2023-24', '2022-23', '2021-22') THEN
        RAISE EXCEPTION 'Please select a valid financial year.' USING ERRCODE = '22023';
    END IF;
    IF left(v_ay, 4)::INTEGER <> left(v_fy, 4)::INTEGER + 1
        OR right(v_ay, 2)::INTEGER <> (right(v_fy, 2)::INTEGER + 1) THEN
        RAISE EXCEPTION 'The assessment year must immediately follow the financial year.' USING ERRCODE = '22023';
    END IF;
    IF v_category NOT IN (
        'Salaried Individual', 'Business Owner', 'Self-Employed Professional',
        'Freelancer / Consultant', 'Partner in a Firm', 'Company Director',
        'HUF', 'Other') THEN
        RAISE EXCEPTION 'Please select a valid taxpayer category.' USING ERRCODE = '22023';
    END IF;
    IF v_return_type NOT IN ('Original Return', 'Revised Return', 'Belated Return', 'Updated Return (ITR-U)') THEN
        RAISE EXCEPTION 'Please select the return type.' USING ERRCODE = '22023';
    END IF;
    IF v_itr_form IS NOT NULL AND v_itr_form NOT IN ('ITR-1', 'ITR-2', 'ITR-3', 'ITR-4', 'Not sure - advise me') THEN
        RAISE EXCEPTION 'Please select a valid ITR form preference.' USING ERRCODE = '22023';
    END IF;

    -- ---- Income ------------------------------------------------------------
    IF NOT (v_salary_flag OR v_business_flag OR v_house_flag OR v_cg_flag OR
            v_other_flag OR v_agri_flag OR v_foreign_flag) THEN
        RAISE EXCEPTION 'Please select at least one income source.' USING ERRCODE = '22023';
    END IF;

    IF v_salary_flag THEN
        IF v_salary IS NULL OR v_salary < 0 THEN
            RAISE EXCEPTION 'Please enter your salary income.' USING ERRCODE = '22023';
        END IF;
    ELSE
        v_salary := NULL;
    END IF;
    IF v_employers IS NOT NULL AND v_employers < 0 THEN
        RAISE EXCEPTION 'Please enter a valid number of employers.' USING ERRCODE = '22023';
    END IF;

    IF v_business_flag THEN
        IF v_business_name IS NULL THEN
            RAISE EXCEPTION 'Please enter the business or profession name.' USING ERRCODE = '22023';
        END IF;
        IF v_business IS NULL OR v_business < 0 THEN
            RAISE EXCEPTION 'Please enter your business or professional income.' USING ERRCODE = '22023';
        END IF;
    ELSE
        v_business := NULL;
    END IF;

    IF v_house_flag THEN
        IF v_house IS NULL THEN
            RAISE EXCEPTION 'Please enter the house property income or loss.' USING ERRCODE = '22023';
        END IF;
    ELSE
        v_house := NULL;
    END IF;

    IF v_cg_flag THEN
        IF v_cg IS NULL OR v_cg < 0 THEN
            RAISE EXCEPTION 'Please enter your capital gains amount.' USING ERRCODE = '22023';
        END IF;
        IF v_cg_type IS NULL THEN
            RAISE EXCEPTION 'Please select the capital gains type.' USING ERRCODE = '22023';
        END IF;
    ELSE
        v_cg := NULL;
    END IF;

    IF v_other_flag AND (v_other IS NULL OR v_other < 0) THEN
        RAISE EXCEPTION 'Please enter your other-source income.' USING ERRCODE = '22023';
    END IF;
    IF NOT v_other_flag THEN v_other := NULL; END IF;

    IF v_agri_flag AND (v_agri IS NULL OR v_agri < 0) THEN
        RAISE EXCEPTION 'Please enter your agricultural income.' USING ERRCODE = '22023';
    END IF;
    IF NOT v_agri_flag THEN v_agri := NULL; END IF;

    IF v_foreign_flag AND (v_foreign IS NULL OR v_foreign < 0) THEN
        RAISE EXCEPTION 'Please enter your foreign income.' USING ERRCODE = '22023';
    END IF;
    IF NOT v_foreign_flag THEN v_foreign := NULL; END IF;

    v_gti := coalesce(v_salary, 0) + coalesce(v_business, 0) +
        coalesce(v_house, 0) + coalesce(v_cg, 0) +
        coalesce(v_other, 0) + coalesce(v_foreign, 0);
    IF v_gti < 0 THEN v_gti := 0; END IF;

    -- ---- Previous filing and regime ---------------------------------------
    IF v_regime NOT IN ('Old Regime', 'New Regime', 'Not sure - advise me') THEN
        RAISE EXCEPTION 'Please select your tax regime preference.' USING ERRCODE = '22023';
    END IF;
    IF v_prev_filed THEN
        IF v_last_ay IS NOT NULL AND v_last_ay !~ '^[0-9]{4}-[0-9]{2}$' THEN
            RAISE EXCEPTION 'Please enter a valid last-filed assessment year.' USING ERRCODE = '22023';
        END IF;
    ELSE
        v_last_ay := NULL;
        v_last_ack := NULL;
    END IF;

    -- ---- Taxes paid --------------------------------------------------------
    IF v_tds_flag AND (v_tds IS NULL OR v_tds < 0) THEN
        RAISE EXCEPTION 'Please enter the total TDS amount.' USING ERRCODE = '22023';
    END IF;
    IF NOT v_tds_flag THEN v_tds := NULL; END IF;
    IF v_advance_flag AND (v_advance IS NULL OR v_advance < 0) THEN
        RAISE EXCEPTION 'Please enter the advance tax paid.' USING ERRCODE = '22023';
    END IF;
    IF NOT v_advance_flag THEN v_advance := NULL; END IF;
    IF v_self_tax IS NOT NULL AND v_self_tax < 0 THEN
        RAISE EXCEPTION 'Please enter a valid self-assessment tax amount.' USING ERRCODE = '22023';
    END IF;

    -- ---- Deductions and exemptions ----------------------------------------
    IF coalesce(v_80c, 0) < 0 OR coalesce(v_80d, 0) < 0 OR coalesce(v_80e, 0) < 0 OR
       coalesce(v_80g, 0) < 0 OR coalesce(v_80tta, 0) < 0 OR coalesce(v_other_ded, 0) < 0 THEN
        RAISE EXCEPTION 'Deduction amounts cannot be negative.' USING ERRCODE = '22023';
    END IF;
    IF coalesce(v_hra, 0) < 0 OR coalesce(v_lta, 0) < 0 OR coalesce(v_other_exempt, 0) < 0 THEN
        RAISE EXCEPTION 'Exemption amounts cannot be negative.' USING ERRCODE = '22023';
    END IF;

    v_total_ded := coalesce(v_80c, 0) + coalesce(v_80d, 0) + coalesce(v_80e, 0) +
        coalesce(v_80g, 0) + coalesce(v_80tta, 0) + coalesce(v_other_ded, 0);
    v_total_exempt := coalesce(v_hra, 0) + coalesce(v_lta, 0) + coalesce(v_other_exempt, 0);
    v_taxable := greatest(v_gti - v_total_ded - v_total_exempt, 0);

    -- ---- Refund and bank details ------------------------------------------
    IF v_refund_amount IS NOT NULL AND v_refund_amount < 0 THEN
        RAISE EXCEPTION 'Please enter a valid expected refund amount.' USING ERRCODE = '22023';
    END IF;
    IF v_refund_flag THEN
        IF v_bank_name IS NULL OR v_bank_account IS NULL OR v_ifsc IS NULL THEN
            RAISE EXCEPTION 'Please complete the bank details for your expected refund.' USING ERRCODE = '22023';
        END IF;
    END IF;
    IF v_bank_account IS NOT NULL AND (length(v_bank_account) < 9 OR length(v_bank_account) > 18) THEN
        RAISE EXCEPTION 'Please enter a valid bank account number.' USING ERRCODE = '22023';
    END IF;
    IF v_ifsc IS NOT NULL AND v_ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$' THEN
        RAISE EXCEPTION 'Please enter a valid IFSC code (e.g. HDFC0001234).' USING ERRCODE = '22023';
    END IF;
    v_bank_masked := CASE
        WHEN v_bank_account IS NOT NULL AND length(v_bank_account) > 4
            THEN repeat('X', greatest(length(v_bank_account) - 4, 0)) || right(v_bank_account, 4)
        WHEN v_bank_account IS NOT NULL THEN v_bank_account
        ELSE NULL END;

    -- ---- Addresses ---------------------------------------------------------
    v_current := coalesce(v_address->'current', '{}'::JSONB);
    v_permanent := coalesce(v_address->'permanent', '{}'::JSONB);
    v_cur_line := nullif(btrim(coalesce(v_current->>'line', '')), '');
    v_cur_city := nullif(btrim(coalesce(v_current->>'city', '')), '');
    v_cur_state := nullif(btrim(coalesce(v_current->>'state', '')), '');
    v_cur_pin := nullif(btrim(coalesce(v_current->>'pincode', '')), '');
    IF v_cur_line IS NULL OR v_cur_city IS NULL OR v_cur_state IS NULL OR v_cur_pin IS NULL THEN
        RAISE EXCEPTION 'Please complete your current address.' USING ERRCODE = '22023';
    END IF;
    IF v_cur_pin !~ '^[0-9]{6}$' THEN
        RAISE EXCEPTION 'Please enter a valid 6-digit current-address PIN code.' USING ERRCODE = '22023';
    END IF;

    IF v_same THEN
        v_per_line := v_cur_line;
        v_per_city := v_cur_city;
        v_per_state := v_cur_state;
        v_per_pin := v_cur_pin;
    ELSE
        v_per_line := nullif(btrim(coalesce(v_permanent->>'line', '')), '');
        v_per_city := nullif(btrim(coalesce(v_permanent->>'city', '')), '');
        v_per_state := nullif(btrim(coalesce(v_permanent->>'state', '')), '');
        v_per_pin := nullif(btrim(coalesce(v_permanent->>'pincode', '')), '');
        IF v_per_line IS NULL OR v_per_city IS NULL OR v_per_state IS NULL OR v_per_pin IS NULL THEN
            RAISE EXCEPTION 'Please complete your permanent address.' USING ERRCODE = '22023';
        END IF;
        IF v_per_pin !~ '^[0-9]{6}$' THEN
            RAISE EXCEPTION 'Please enter a valid 6-digit permanent-address PIN code.' USING ERRCODE = '22023';
        END IF;
    END IF;

    -- ---- Consent -----------------------------------------------------------
    IF NOT v_consent THEN
        RAISE EXCEPTION 'Please accept the privacy notice and filing consent before submitting.' USING ERRCODE = '22023';
    END IF;

    -- ---- Derived values ----------------------------------------------------
    v_employment := CASE v_category
        WHEN 'Salaried Individual' THEN 'Salaried'
        WHEN 'Business Owner' THEN 'Self-employed'
        WHEN 'Self-Employed Professional' THEN 'Self-employed'
        WHEN 'Freelancer / Consultant' THEN 'Self-employed'
        WHEN 'Partner in a Firm' THEN 'Self-employed'
        WHEN 'Company Director' THEN 'Self-employed'
        ELSE 'Other'
    END;
    v_applicant_type := CASE WHEN v_residential = 'Non-Resident' THEN 'nri' ELSE 'resident' END;
    v_message := btrim(concat_ws(' | ',
        'AY ' || v_ay || ' (FY ' || v_fy || ')',
        'Category: ' || v_category,
        'Return: ' || v_return_type,
        'Residential status: ' || v_residential,
        'Gross total income: Rs. ' || to_char(v_gti, 'FM999999999990')
    ));

    -- ---- Create the lead ---------------------------------------------------
    INSERT INTO public.loan_leads (
        full_name, mobile, email, loan_type, loan_amount, message,
        applicant_type, residency_status, employment_type,
        consent_given, consent_at, consent_version, source_page
    ) VALUES (
        v_full_name, v_mobile, v_email, 'ITR Filing', greatest(v_gti, 0), v_message,
        v_applicant_type, v_residential, v_employment,
        true, now(), v_consent_version, v_source
    )
    RETURNING id, reference_no, access_token INTO v_id, v_ref, v_token;

    -- ---- Structured ITR details -------------------------------------------
    INSERT INTO public.itr_filing_details (
        loan_lead_id, first_name, middle_name, last_name, date_of_birth, gender,
        mobile, email, pan_number, aadhaar_masked, aadhaar_verification_method,
        residential_status,
        current_address_line, current_address_city, current_address_state, current_address_pincode,
        same_as_current,
        permanent_address_line, permanent_address_city, permanent_address_state, permanent_address_pincode,
        assessment_year, financial_year, taxpayer_category, return_type, itr_form_preference,
        has_salary_income, salary_income, employer_count,
        has_business_income, business_income, business_name, business_constitution,
        has_house_property, house_property_income, house_property_details,
        has_capital_gains, capital_gains_income, capital_gains_type,
        has_other_sources, other_sources_income,
        has_agricultural_income, agricultural_income,
        has_foreign_income, foreign_income, foreign_assets_details,
        gross_total_income,
        previously_filed_itr, last_filed_assessment_year, last_acknowledgement_no,
        pending_notices, filing_history_notes,
        tax_regime,
        tds_deducted, tds_amount, advance_tax_paid, advance_tax_amount, self_assessment_tax_paid,
        deduction_80c, deduction_80d, deduction_80e, deduction_80g,
        deduction_80tta_ttb, other_deductions, total_deductions,
        hra_exemption, lta_exemption, other_exemptions, total_exemptions,
        tax_saving_investments,
        refund_expected, refund_amount, bank_account_name, bank_account_number_masked, ifsc_code,
        taxable_income
    ) VALUES (
        v_id, v_first, v_middle, v_last, v_dob, v_gender,
        v_mobile, v_email, v_pan, v_aadhaar_masked, v_aadhaar_method,
        v_residential,
        v_cur_line, v_cur_city, v_cur_state, v_cur_pin,
        v_same,
        v_per_line, v_per_city, v_per_state, v_per_pin,
        v_ay, v_fy, v_category, v_return_type, v_itr_form,
        v_salary_flag, v_salary, v_employers,
        v_business_flag, v_business, v_business_name, v_business_constitution,
        v_house_flag, v_house, v_house_details,
        v_cg_flag, v_cg, v_cg_type,
        v_other_flag, v_other,
        v_agri_flag, v_agri,
        v_foreign_flag, v_foreign, v_foreign_details,
        v_gti,
        v_prev_filed, v_last_ay, v_last_ack,
        v_pending_notices, v_history_notes,
        v_regime,
        v_tds_flag, v_tds, v_advance_flag, v_advance, v_self_tax,
        v_80c, v_80d, v_80e, v_80g,
        v_80tta, v_other_ded, v_total_ded,
        v_hra, v_lta, v_other_exempt, v_total_exempt,
        v_tax_saving,
        v_refund_flag, v_refund_amount, v_bank_name, v_bank_masked, v_ifsc,
        v_taxable
    );

    -- ---- Declared income heads --------------------------------------------
    IF v_salary_flag AND coalesce(v_salary, 0) <> 0 THEN
        INSERT INTO public.itr_income_items (loan_lead_id, income_head, amount, details)
        VALUES (v_id, 'Salary', v_salary, 'Salary income declared by applicant');
    END IF;
    IF v_business_flag AND coalesce(v_business, 0) <> 0 THEN
        INSERT INTO public.itr_income_items (loan_lead_id, income_head, amount, details)
        VALUES (v_id, 'Business / Profession', v_business,
            nullif(concat_ws(' - ', v_business_name, v_business_constitution), ''));
    END IF;
    IF v_house_flag AND coalesce(v_house, 0) <> 0 THEN
        INSERT INTO public.itr_income_items (loan_lead_id, income_head, amount, details)
        VALUES (v_id, 'House Property', v_house, v_house_details);
    END IF;
    IF v_cg_flag AND coalesce(v_cg, 0) <> 0 THEN
        INSERT INTO public.itr_income_items (loan_lead_id, income_head, amount, details)
        VALUES (v_id, 'Capital Gains', v_cg, v_cg_type);
    END IF;
    IF v_other_flag AND coalesce(v_other, 0) <> 0 THEN
        INSERT INTO public.itr_income_items (loan_lead_id, income_head, amount, details)
        VALUES (v_id, 'Other Sources', v_other, 'Interest and other-source income');
    END IF;
    IF v_agri_flag AND coalesce(v_agri, 0) <> 0 THEN
        INSERT INTO public.itr_income_items (loan_lead_id, income_head, amount, details)
        VALUES (v_id, 'Agricultural Income', v_agri, 'Exempt agricultural income declared for rate purposes');
    END IF;
    IF v_foreign_flag AND coalesce(v_foreign, 0) <> 0 THEN
        INSERT INTO public.itr_income_items (loan_lead_id, income_head, amount, details)
        VALUES (v_id, 'Foreign Income', v_foreign, v_foreign_details);
    END IF;

    -- ---- Declared tax credits ---------------------------------------------
    IF v_tds_flag AND coalesce(v_tds, 0) > 0 THEN
        INSERT INTO public.itr_tax_payments (loan_lead_id, payment_type, amount, financial_year)
        VALUES (v_id, 'TDS', v_tds, v_fy);
    END IF;
    IF v_advance_flag AND coalesce(v_advance, 0) > 0 THEN
        INSERT INTO public.itr_tax_payments (loan_lead_id, payment_type, amount, financial_year)
        VALUES (v_id, 'Advance Tax', v_advance, v_fy);
    END IF;
    IF coalesce(v_self_tax, 0) > 0 THEN
        INSERT INTO public.itr_tax_payments (loan_lead_id, payment_type, amount, financial_year)
        VALUES (v_id, 'Self-Assessment Tax', v_self_tax, v_fy);
    END IF;

    -- ---- Consume the draft -------------------------------------------------
    IF p_draft_id IS NOT NULL AND p_draft_token IS NOT NULL THEN
        UPDATE public.home_loan_drafts
        SET status = 'submitted',
            submitted_lead_id = v_id
        WHERE id = p_draft_id
          AND draft_token = p_draft_token
          AND status = 'draft';
    END IF;

    RETURN QUERY SELECT gen_random_uuid(), jsonb_build_object(
        'id', v_id,
        'reference_no', v_ref,
        'access_token', v_token,
        'full_name', v_full_name,
        'loan_type', 'ITR Filing',
        'assessment_year', v_ay,
        'financial_year', v_fy,
        'gross_total_income', v_gti,
        'taxable_income', v_taxable,
        'filing_status', 'Application Received',
        'applicant_type', v_applicant_type
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Extra document types for ITR Filing applications
-- -----------------------------------------------------------------------------
-- The ITR checklist needs Form 16, Form 26AS, AIS/TIS, investment proofs, rent
-- receipts, capital gains statements, previous returns and tax challans. Widen
-- the CHECK on public.loan_documents.document_type and re-register
-- register_document() with the same allowed list.

DO $$
DECLARE
    v_constraint RECORD;
BEGIN
    FOR v_constraint IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'public.loan_documents'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%document_type%'
    LOOP
        EXECUTE format('ALTER TABLE public.loan_documents DROP CONSTRAINT %I', v_constraint.conname);
    END LOOP;
END $$;

ALTER TABLE public.loan_documents
    ADD CONSTRAINT loan_documents_document_type_check CHECK (document_type IN (
        'PAN Card', 'Aadhaar Card', 'Salary Slips', 'ITR', 'Bank Statement',
        'Property Documents', 'Business Proof', 'Vehicle Documents',
        'Photograph', 'Other',
        'Sanction Letter', 'Loan Statement', 'Outstanding Certificate',
        'Repayment History', 'Income Proof',
        'Title Chain', 'Property Tax Receipt', 'Approved Plans',
        'GST Returns', 'Financial Statements', 'Udyam Certificate',
        'Stock Statement', 'Debtors Statement', 'Creditors Statement',
        'Form 16', 'Form 26AS', 'AIS / TIS', 'Investment Proofs',
        'Rent Receipts', 'Capital Gains Statement', 'Previous ITR',
        'ITR Acknowledgement', 'Tax Payment Challan', 'Foreign Income Documents'
    ));

CREATE OR REPLACE FUNCTION public.register_document(
    p_lead_id UUID,
    p_access_token UUID,
    p_document_type TEXT,
    p_storage_file_id UUID
)
RETURNS SETOF public.api_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id UUID;
    v_file_id UUID;
    v_file_name TEXT;
    v_file_size BIGINT;
    v_mime_type TEXT;
    v_is_uploaded BOOLEAN;
    v_uploaded_by UUID;
    v_user_id TEXT;
    v_role TEXT;
    v_upload_source TEXT;
    v_count INTEGER;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.loan_leads
        WHERE id = p_lead_id AND access_token = p_access_token
    ) THEN
        RAISE EXCEPTION 'This document link is invalid or has expired.' USING ERRCODE = '28000';
    END IF;

    -- Hasura exposes the verified session variables as a JSON GUC. The file
    -- must belong to the anonymous (or admin) session that is calling us.
    v_user_id := nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-user-id';
    v_role := nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-role';
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Please start a secure upload session and try again.' USING ERRCODE = '28000';
    END IF;

    -- The public upload page normally runs as an anonymous customer. An
    -- administrator who is already signed in reuses that admin session, so
    -- record the upload source accurately.
    v_upload_source := CASE WHEN v_role = 'admin' THEN 'admin' ELSE 'customer' END;

    SELECT id, name, size, mime_type, is_uploaded, uploaded_by_user_id
    INTO v_file_id, v_file_name, v_file_size, v_mime_type, v_is_uploaded, v_uploaded_by
    FROM storage.files
    WHERE id = p_storage_file_id
      AND bucket_id = 'loan-documents';

    IF v_file_id IS NULL THEN
        RAISE EXCEPTION 'The uploaded file could not be found. Please try again.' USING ERRCODE = '22023';
    END IF;
    IF v_is_uploaded IS NOT TRUE THEN
        RAISE EXCEPTION 'The upload did not finish. Please try again.' USING ERRCODE = '22023';
    END IF;

    -- Nhost may not populate uploaded_by_user_id (deprecated column), so only
    -- enforce the match when an uploader was actually recorded.
    IF v_uploaded_by IS NOT NULL AND v_uploaded_by::text <> v_user_id THEN
        RAISE EXCEPTION 'This file does not belong to your upload session. Please try again.' USING ERRCODE = '28000';
    END IF;

    IF p_document_type IS NULL OR p_document_type NOT IN (
        'PAN Card', 'Aadhaar Card', 'Salary Slips', 'ITR', 'Bank Statement',
        'Property Documents', 'Business Proof', 'Vehicle Documents',
        'Photograph', 'Other',
        'Sanction Letter', 'Loan Statement', 'Outstanding Certificate',
        'Repayment History', 'Income Proof',
        'Title Chain', 'Property Tax Receipt', 'Approved Plans',
        'GST Returns', 'Financial Statements', 'Udyam Certificate',
        'Stock Statement', 'Debtors Statement', 'Creditors Statement',
        'Form 16', 'Form 26AS', 'AIS / TIS', 'Investment Proofs',
        'Rent Receipts', 'Capital Gains Statement', 'Previous ITR',
        'ITR Acknowledgement', 'Tax Payment Challan', 'Foreign Income Documents'
    ) THEN
        RAISE EXCEPTION 'Please choose a valid document type.' USING ERRCODE = '22023';
    END IF;

    IF v_file_name IS NULL OR btrim(v_file_name) = '' OR length(v_file_name) > 255 THEN
        RAISE EXCEPTION 'Please provide a valid file name.' USING ERRCODE = '22023';
    END IF;

    IF v_mime_type IS NULL OR v_mime_type NOT IN (
        'application/pdf', 'image/jpeg', 'image/png', 'image/webp'
    ) THEN
        RAISE EXCEPTION 'Only PDF, JPG, PNG or WEBP files are accepted.' USING ERRCODE = '22023';
    END IF;

    IF v_file_size IS NULL OR v_file_size <= 0 OR v_file_size > 5242880 THEN
        RAISE EXCEPTION 'Files must be 5 MB or smaller.' USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.loan_documents WHERE storage_file_id = p_storage_file_id
    ) THEN
        RAISE EXCEPTION 'This file has already been registered.' USING ERRCODE = '22023';
    END IF;

    SELECT count(*) INTO v_count
    FROM public.loan_documents
    WHERE loan_lead_id = p_lead_id;

    IF v_count >= 25 THEN
        RAISE EXCEPTION 'The maximum number of documents for this application has been reached.' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.loan_documents (
        loan_lead_id, document_type, storage_file_id, file_name,
        file_size, mime_type, uploaded_by, status
    ) VALUES (
        p_lead_id, p_document_type, p_storage_file_id, v_file_name,
        v_file_size, v_mime_type, v_upload_source, 'Pending'
    )
    RETURNING id INTO v_id;

    RETURN QUERY SELECT gen_random_uuid(), jsonb_build_object(
        'id', v_id,
        'document_type', p_document_type,
        'file_name', v_file_name,
        'status', 'Pending'
    );
END;
$$;

COMMIT;

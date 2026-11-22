-- =============================================================================
-- NHOST / HASURA MIGRATION: 011_loan_protection_insurance.sql
-- PROJECT: Dhanvi Finserv
--
-- Run this ONCE, after 010, in the Nhost dashboard:
--   Database -> SQL Editor -> paste -> Run
--
-- It adds the structured Loan Protection Insurance assistance system behind
-- loan-insurance-apply.html:
--
--   1. public.loan_insurance_details - applicant profile, existing loan,
--      coverage requirement, nominee and co-borrower, underwriting
--      information, insurance disclosures, and the administrator-controlled
--      insurer, proposal, quotation and policy fields.
--   2. submit_loan_insurance_application() - validate and create an insurance
--      assistance application (loan_leads + structured details) and consume
--      the shared draft.
--   3. Extra document types (Insurance Proposal Form, Medical Report,
--      Existing Policy, Insurer Quotation) added to
--      public.loan_documents.document_type and to register_document().
--   4. Re-asserts the widened loan_leads.loan_type and loan_amount constraints
--      so service applications can be stored without fake loan amounts.
--
-- DRAFT STORAGE
--   Save / resume is shared with the other application wizards: the page calls
--   the existing save_home_loan_draft() / get_home_loan_draft() against
--   public.home_loan_drafts. The draft payload is opaque JSONB, so no new draft
--   table or draft function is required. The loan account reference is removed
--   from drafts and must be re-entered on resume.
--
-- IMPORTANT
--   * Hasura permissions are the access-control layer, NOT Postgres RLS.
--   * Do not enable RLS on these tables.
--   * Every function returns SETOF public.api_result so Hasura can track it.
--   * Other service types are untouched: they keep using their own functions.
--   * This system never promises or records an insurance approval, coverage
--     or claim settlement by itself. A new enquiry starts at
--     'Enquiry Received' / 'Not Issued'. Only an administrator can record a
--     quotation, proposal or policy after the authorised insurer confirms it
--     and the policy document is verified.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Allow service applications on the shared loan_leads table
-- -----------------------------------------------------------------------------
-- Migrations 008 to 010 already widened these constraints. This block is
-- idempotent so 011 can be run safely even if the earlier migrations were
-- applied in a different order.

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
-- 1. Loan protection insurance details (1:1 with loan_leads)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.loan_insurance_details (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_lead_id UUID NOT NULL UNIQUE REFERENCES public.loan_leads(id) ON DELETE CASCADE,

    -- Applicant profile
    applicant_name TEXT NOT NULL,
    date_of_birth DATE NOT NULL,
    gender TEXT
        CHECK (gender IS NULL OR gender IN ('Male', 'Female', 'Other', 'Prefer not to say')),
    mobile TEXT NOT NULL,
    email TEXT,
    occupation TEXT NOT NULL,
    annual_income NUMERIC NOT NULL CHECK (annual_income >= 0),
    pan_number TEXT,
    address_line TEXT NOT NULL,
    address_city TEXT NOT NULL,
    address_district TEXT,
    address_state TEXT NOT NULL,
    address_pincode TEXT NOT NULL,

    -- Existing loan being protected
    loan_type TEXT NOT NULL
        CHECK (loan_type IN (
            'Home Loan', 'Home Loan Top-Up', 'Home Loan Takeover',
            'Loan Against Property', 'Business Loan', 'Personal Loan',
            'Vehicle Loan', 'Education Loan', 'Gold Loan',
            'Working Capital (CC/OD)', 'Other')),
    lender_name TEXT NOT NULL,
    loan_account_reference TEXT NOT NULL,
    outstanding_amount NUMERIC NOT NULL CHECK (outstanding_amount >= 0),
    emi_amount NUMERIC NOT NULL CHECK (emi_amount >= 0),
    remaining_tenure_months INTEGER NOT NULL
        CHECK (remaining_tenure_months >= 0 AND remaining_tenure_months <= 600),

    -- Coverage requirement
    coverage_requirement TEXT NOT NULL
        CHECK (coverage_requirement IN (
            'Loan Protection Cover', 'Term Life Cover',
            'Property / Fire Insurance', 'Loan Protection + Property',
            'Not sure - advise me')),
    desired_cover_amount NUMERIC NOT NULL CHECK (desired_cover_amount > 0),
    policy_tenure_years INTEGER NOT NULL
        CHECK (policy_tenure_years >= 1 AND policy_tenure_years <= 40),
    premium_budget NUMERIC CHECK (premium_budget IS NULL OR premium_budget >= 0),
    payment_frequency TEXT
        CHECK (payment_frequency IS NULL OR payment_frequency IN (
            'Monthly', 'Quarterly', 'Half-Yearly', 'Annual', 'Single Premium')),
    existing_insurance BOOLEAN NOT NULL DEFAULT false,
    existing_insurer TEXT,
    existing_cover_amount NUMERIC
        CHECK (existing_cover_amount IS NULL OR existing_cover_amount >= 0),
    existing_policy_expiry DATE,
    insurer_preference TEXT,

    -- Nominee
    nominee_name TEXT NOT NULL,
    nominee_relation TEXT NOT NULL
        CHECK (nominee_relation IN (
            'Spouse', 'Parent', 'Child', 'Sibling', 'Other')),
    nominee_date_of_birth DATE,
    nominee_mobile TEXT,

    -- Co-borrower
    co_borrower BOOLEAN NOT NULL DEFAULT false,
    co_borrower_name TEXT,
    co_borrower_relation TEXT
        CHECK (co_borrower_relation IS NULL OR co_borrower_relation IN (
            'Spouse', 'Parent', 'Child', 'Sibling', 'Other')),
    co_borrower_mobile TEXT,
    co_borrower_email TEXT,
    co_borrower_date_of_birth DATE,

    -- Underwriting information shared only with the authorised insurer
    height_cm INTEGER CHECK (height_cm IS NULL OR (height_cm >= 100 AND height_cm <= 250)),
    weight_kg NUMERIC CHECK (weight_kg IS NULL OR (weight_kg >= 25 AND weight_kg <= 300)),
    tobacco_use TEXT NOT NULL
        CHECK (tobacco_use IN ('No', 'Yes', 'Occasionally')),
    medical_conditions TEXT,
    medications TEXT,
    hospitalization_last_3_years BOOLEAN NOT NULL DEFAULT false,
    occupation_risk TEXT NOT NULL
        CHECK (occupation_risk IN (
            'Low risk (office / professional)',
            'Moderate risk (field / sales)',
            'High risk (manual / industrial)',
            'Not sure')),
    income_proof_type TEXT
        CHECK (income_proof_type IS NULL OR income_proof_type IN (
            'Salary slips', 'ITR / Form 16', 'Bank statement',
            'Business financials', 'Other')),
    medical_test_consent BOOLEAN NOT NULL DEFAULT false,
    underwriting_notes TEXT,

    -- Administrator-controlled insurer, proposal, quotation and policy
    -- records. The public form can never set any of these fields.
    proposal_status TEXT NOT NULL DEFAULT 'Enquiry Received'
        CHECK (proposal_status IN (
            'Enquiry Received', 'Documents Pending', 'Underwriting Review',
            'Submitted to Insurer', 'Quotation Received', 'Proposal Accepted',
            'Policy Issued', 'Declined', 'On Hold', 'Cancelled')),
    insurer_name TEXT,
    proposal_number TEXT,
    proposal_date DATE,
    quotation_reference TEXT,
    quotation_amount NUMERIC
        CHECK (quotation_amount IS NULL OR quotation_amount >= 0),
    quotation_date DATE,
    quotation_valid_until DATE,
    policy_status TEXT NOT NULL DEFAULT 'Not Issued'
        CHECK (policy_status IN (
            'Not Issued', 'Proposal Submitted', 'Underwriting', 'Approved',
            'Policy Issued', 'Declined', 'Lapsed', 'Cancelled')),
    policy_number TEXT,
    policy_start_date DATE,
    policy_end_date DATE,
    premium_amount NUMERIC
        CHECK (premium_amount IS NULL OR premium_amount >= 0),
    payment_mode TEXT,
    policy_remarks TEXT,
    status_notes TEXT,
    verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    verified_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS loan_insurance_details_lead_idx
    ON public.loan_insurance_details (loan_lead_id);
CREATE INDEX IF NOT EXISTS loan_insurance_details_status_idx
    ON public.loan_insurance_details (proposal_status);
CREATE INDEX IF NOT EXISTS loan_insurance_details_policy_idx
    ON public.loan_insurance_details (policy_status);
CREATE INDEX IF NOT EXISTS loan_insurance_details_insurer_idx
    ON public.loan_insurance_details (insurer_name);
CREATE INDEX IF NOT EXISTS loan_insurance_details_loan_type_idx
    ON public.loan_insurance_details (loan_type);
CREATE INDEX IF NOT EXISTS loan_insurance_details_state_idx
    ON public.loan_insurance_details (address_state);

DROP TRIGGER IF EXISTS update_loan_insurance_details_modtime
    ON public.loan_insurance_details;
CREATE TRIGGER update_loan_insurance_details_modtime
    BEFORE UPDATE ON public.loan_insurance_details
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. Submit a loan protection insurance assistance application
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_loan_insurance_application(
    p_payload JSONB,
    p_draft_id UUID DEFAULT NULL,
    p_draft_token UUID DEFAULT NULL
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
    v_loan JSONB := coalesce(p_payload->'loan', '{}'::JSONB);
    v_coverage JSONB := coalesce(p_payload->'coverage', '{}'::JSONB);
    v_nominee JSONB := coalesce(p_payload->'nominee', '{}'::JSONB);
    v_coborrower JSONB := coalesce(p_payload->'co_borrower', '{}'::JSONB);
    v_underwriting JSONB := coalesce(p_payload->'underwriting', '{}'::JSONB);
    v_declarations JSONB := coalesce(p_payload->'declarations', '{}'::JSONB);

    v_name TEXT := btrim(coalesce(v_personal->>'applicant_name', ''));
    v_dob DATE := nullif(v_personal->>'date_of_birth', '')::DATE;
    v_gender TEXT := nullif(btrim(coalesce(v_personal->>'gender', '')), '');
    v_mobile TEXT := regexp_replace(coalesce(v_personal->>'mobile', ''), '[^0-9]', '', 'g');
    v_email TEXT := nullif(lower(btrim(coalesce(v_personal->>'email', ''))), '');
    v_occupation TEXT := nullif(btrim(coalesce(v_personal->>'occupation', '')), '');
    v_income NUMERIC := nullif(v_personal->>'annual_income', '')::NUMERIC;
    v_pan TEXT := upper(nullif(btrim(coalesce(v_personal->>'pan_number', '')), ''));
    v_line TEXT := nullif(btrim(coalesce(v_personal->>'address_line', '')), '');
    v_city TEXT := nullif(btrim(coalesce(v_personal->>'address_city', '')), '');
    v_district TEXT := nullif(btrim(coalesce(v_personal->>'address_district', '')), '');
    v_state TEXT := nullif(btrim(coalesce(v_personal->>'address_state', '')), '');
    v_pin TEXT := regexp_replace(coalesce(v_personal->>'address_pincode', ''), '[^0-9]', '', 'g');

    v_loan_type TEXT := btrim(coalesce(v_loan->>'loan_type', ''));
    v_lender TEXT := nullif(btrim(coalesce(v_loan->>'lender_name', '')), '');
    v_loan_ref TEXT := nullif(btrim(coalesce(v_loan->>'loan_account_reference', '')), '');
    v_outstanding NUMERIC := nullif(v_loan->>'outstanding_amount', '')::NUMERIC;
    v_emi NUMERIC := nullif(v_loan->>'emi_amount', '')::NUMERIC;
    v_remaining INTEGER := nullif(v_loan->>'remaining_tenure_months', '')::INTEGER;

    v_coverage TEXT := btrim(coalesce(v_coverage->>'coverage_requirement', ''));
    v_cover_amount NUMERIC := nullif(v_coverage->>'desired_cover_amount', '')::NUMERIC;
    v_tenure INTEGER := nullif(v_coverage->>'policy_tenure_years', '')::INTEGER;
    v_budget NUMERIC := nullif(v_coverage->>'premium_budget', '')::NUMERIC;
    v_frequency TEXT := nullif(btrim(coalesce(v_coverage->>'payment_frequency', '')), '');
    v_existing BOOLEAN := coalesce((v_coverage->>'existing_insurance')::BOOLEAN, false);
    v_existing_insurer TEXT := nullif(btrim(coalesce(v_coverage->>'existing_insurer', '')), '');
    v_existing_cover NUMERIC := nullif(v_coverage->>'existing_cover_amount', '')::NUMERIC;
    v_existing_expiry DATE := nullif(v_coverage->>'existing_policy_expiry', '')::DATE;
    v_insurer_pref TEXT := nullif(btrim(coalesce(v_coverage->>'insurer_preference', '')), '');

    v_nominee_name TEXT := nullif(btrim(coalesce(v_nominee->>'nominee_name', '')), '');
    v_nominee_relation TEXT := btrim(coalesce(v_nominee->>'nominee_relation', ''));
    v_nominee_dob DATE := nullif(v_nominee->>'nominee_date_of_birth', '')::DATE;
    v_nominee_mobile TEXT := nullif(regexp_replace(coalesce(v_nominee->>'nominee_mobile', ''), '[^0-9]', '', 'g'), '');

    v_co_borrower BOOLEAN := coalesce((v_coborrower->>'co_borrower')::BOOLEAN, false);
    v_co_name TEXT := nullif(btrim(coalesce(v_coborrower->>'co_borrower_name', '')), '');
    v_co_relation TEXT := nullif(btrim(coalesce(v_coborrower->>'co_borrower_relation', '')), '');
    v_co_mobile TEXT := nullif(regexp_replace(coalesce(v_coborrower->>'co_borrower_mobile', ''), '[^0-9]', '', 'g'), '');
    v_co_email TEXT := nullif(lower(btrim(coalesce(v_coborrower->>'co_borrower_email', ''))), '');
    v_co_dob DATE := nullif(v_coborrower->>'co_borrower_date_of_birth', '')::DATE;

    v_height INTEGER := nullif(v_underwriting->>'height_cm', '')::INTEGER;
    v_weight NUMERIC := nullif(v_underwriting->>'weight_kg', '')::NUMERIC;
    v_tobacco TEXT := btrim(coalesce(v_underwriting->>'tobacco_use', ''));
    v_conditions TEXT := nullif(btrim(coalesce(v_underwriting->>'medical_conditions', '')), '');
    v_medications TEXT := nullif(btrim(coalesce(v_underwriting->>'medications', '')), '');
    v_hospitalization BOOLEAN := coalesce((v_underwriting->>'hospitalization_last_3_years')::BOOLEAN, false);
    v_occupation_risk TEXT := btrim(coalesce(v_underwriting->>'occupation_risk', ''));
    v_income_proof TEXT := nullif(btrim(coalesce(v_underwriting->>'income_proof_type', '')), '');
    v_medical_consent BOOLEAN := coalesce((v_underwriting->>'medical_test_consent')::BOOLEAN, false);
    v_underwriting_notes TEXT := nullif(btrim(coalesce(v_underwriting->>'underwriting_notes', '')), '');

    v_accuracy BOOLEAN := coalesce((v_declarations->>'accuracy')::BOOLEAN, false);
    v_authorisation BOOLEAN := coalesce((v_declarations->>'authorisation')::BOOLEAN, false);
    v_disclosure BOOLEAN := coalesce((v_declarations->>'insurance_disclosure')::BOOLEAN, false);
    v_consent BOOLEAN := coalesce((p_payload->>'consent')::BOOLEAN, false);
    v_consent_version TEXT := coalesce(nullif(p_payload->>'consent_version', ''), '2026-11');
    v_source TEXT := nullif(btrim(coalesce(p_payload->>'source_page', '')), '');

    v_age INTEGER;
    v_message TEXT;
BEGIN
    -- ---- Payload shape -----------------------------------------------------
    IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'The application could not be submitted. Please try again.' USING ERRCODE = '22023';
    END IF;
    IF length(p_payload::text) > 250000 THEN
        RAISE EXCEPTION 'This application is too large to submit.' USING ERRCODE = '22023';
    END IF;

    -- ---- Applicant profile -------------------------------------------------
    IF v_name = '' THEN
        RAISE EXCEPTION 'Please enter the applicant name.' USING ERRCODE = '22023';
    END IF;
    IF length(v_name) > 200 THEN
        RAISE EXCEPTION 'Please enter a shorter applicant name.' USING ERRCODE = '22023';
    END IF;
    IF v_dob IS NULL THEN
        RAISE EXCEPTION 'Please enter the applicant date of birth.' USING ERRCODE = '22023';
    END IF;
    v_age := extract(year FROM age((now() AT TIME ZONE 'Asia/Kolkata')::date, v_dob));
    IF v_age < 18 OR v_age > 75 THEN
        RAISE EXCEPTION 'The applicant must be between 18 and 75 years old. Insurers may apply stricter age limits.' USING ERRCODE = '22023';
    END IF;
    IF v_gender IS NOT NULL AND v_gender NOT IN (
        'Male', 'Female', 'Other', 'Prefer not to say') THEN
        RAISE EXCEPTION 'Please select a valid gender.' USING ERRCODE = '22023';
    END IF;
    IF v_mobile !~ '^[6-9][0-9]{9}$' THEN
        RAISE EXCEPTION 'Please enter a valid 10-digit Indian mobile number.' USING ERRCODE = '22023';
    END IF;
    IF v_email IS NULL OR v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
        RAISE EXCEPTION 'Please enter a valid email address.' USING ERRCODE = '22023';
    END IF;
    IF v_occupation IS NULL THEN
        RAISE EXCEPTION 'Please enter your occupation.' USING ERRCODE = '22023';
    END IF;
    IF v_income IS NULL OR v_income < 0 THEN
        RAISE EXCEPTION 'Please enter a valid annual income.' USING ERRCODE = '22023';
    END IF;
    IF v_pan IS NOT NULL AND v_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' THEN
        RAISE EXCEPTION 'Please enter a valid PAN (e.g. ABCDE1234F).' USING ERRCODE = '22023';
    END IF;
    IF v_line IS NULL OR v_city IS NULL OR v_state IS NULL THEN
        RAISE EXCEPTION 'Please enter the complete applicant address.' USING ERRCODE = '22023';
    END IF;
    IF v_pin !~ '^[0-9]{6}$' THEN
        RAISE EXCEPTION 'Please enter a valid 6-digit PIN code.' USING ERRCODE = '22023';
    END IF;

    -- ---- Existing loan -----------------------------------------------------
    IF v_loan_type IS NULL OR v_loan_type NOT IN (
        'Home Loan', 'Home Loan Top-Up', 'Home Loan Takeover',
        'Loan Against Property', 'Business Loan', 'Personal Loan',
        'Vehicle Loan', 'Education Loan', 'Gold Loan',
        'Working Capital (CC/OD)', 'Other') THEN
        RAISE EXCEPTION 'Please select a valid existing loan type.' USING ERRCODE = '22023';
    END IF;
    IF v_lender IS NULL THEN
        RAISE EXCEPTION 'Please enter the lender name.' USING ERRCODE = '22023';
    END IF;
    IF v_loan_ref IS NULL THEN
        RAISE EXCEPTION 'Please enter the loan account reference.' USING ERRCODE = '22023';
    END IF;
    IF v_outstanding IS NULL OR v_outstanding < 0 THEN
        RAISE EXCEPTION 'Please enter a valid outstanding loan amount.' USING ERRCODE = '22023';
    END IF;
    IF v_emi IS NULL OR v_emi < 0 THEN
        RAISE EXCEPTION 'Please enter a valid EMI amount.' USING ERRCODE = '22023';
    END IF;
    IF v_remaining IS NULL OR v_remaining < 0 OR v_remaining > 600 THEN
        RAISE EXCEPTION 'Please enter a valid remaining tenure in months.' USING ERRCODE = '22023';
    END IF;

    -- ---- Coverage requirement ---------------------------------------------
    IF v_coverage IS NULL OR v_coverage NOT IN (
        'Loan Protection Cover', 'Term Life Cover',
        'Property / Fire Insurance', 'Loan Protection + Property',
        'Not sure - advise me') THEN
        RAISE EXCEPTION 'Please select a valid coverage requirement.' USING ERRCODE = '22023';
    END IF;
    IF v_cover_amount IS NULL OR v_cover_amount <= 0 THEN
        RAISE EXCEPTION 'Please enter the desired cover amount.' USING ERRCODE = '22023';
    END IF;
    IF v_tenure IS NULL OR v_tenure < 1 OR v_tenure > 40 THEN
        RAISE EXCEPTION 'Please enter a policy tenure between 1 and 40 years.' USING ERRCODE = '22023';
    END IF;
    IF v_budget IS NOT NULL AND v_budget < 0 THEN
        RAISE EXCEPTION 'Please enter a valid premium budget.' USING ERRCODE = '22023';
    END IF;
    IF v_frequency IS NOT NULL AND v_frequency NOT IN (
        'Monthly', 'Quarterly', 'Half-Yearly', 'Annual', 'Single Premium') THEN
        RAISE EXCEPTION 'Please select a valid payment frequency.' USING ERRCODE = '22023';
    END IF;
    IF v_existing THEN
        IF v_existing_insurer IS NULL THEN
            RAISE EXCEPTION 'Please enter the existing insurer name.' USING ERRCODE = '22023';
        END IF;
        IF v_existing_cover IS NULL OR v_existing_cover < 0 THEN
            RAISE EXCEPTION 'Please enter the existing cover amount.' USING ERRCODE = '22023';
        END IF;
    END IF;

    -- ---- Nominee -----------------------------------------------------------
    IF v_nominee_name IS NULL THEN
        RAISE EXCEPTION 'Please enter the nominee name.' USING ERRCODE = '22023';
    END IF;
    IF v_nominee_relation IS NULL OR v_nominee_relation NOT IN ('Spouse', 'Parent', 'Child', 'Sibling', 'Other') THEN
        RAISE EXCEPTION 'Please select a valid nominee relationship.' USING ERRCODE = '22023';
    END IF;
    IF v_nominee_mobile IS NOT NULL AND v_nominee_mobile !~ '^[6-9][0-9]{9}$' THEN
        RAISE EXCEPTION 'Please enter a valid 10-digit nominee mobile number.' USING ERRCODE = '22023';
    END IF;

    -- ---- Co-borrower -------------------------------------------------------
    IF v_co_borrower THEN
        IF v_co_name IS NULL THEN
            RAISE EXCEPTION 'Please enter the co-borrower name.' USING ERRCODE = '22023';
        END IF;
        IF v_co_relation IS NULL OR v_co_relation NOT IN ('Spouse', 'Parent', 'Child', 'Sibling', 'Other') THEN
            RAISE EXCEPTION 'Please select a valid co-borrower relationship.' USING ERRCODE = '22023';
        END IF;
        IF v_co_mobile !~ '^[6-9][0-9]{9}$' THEN
            RAISE EXCEPTION 'Please enter a valid 10-digit co-borrower mobile number.' USING ERRCODE = '22023';
        END IF;
        IF v_co_email IS NOT NULL AND v_co_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
            RAISE EXCEPTION 'Please enter a valid co-borrower email address.' USING ERRCODE = '22023';
        END IF;
    END IF;

    -- ---- Underwriting information -----------------------------------------
    IF v_height IS NOT NULL AND (v_height < 100 OR v_height > 250) THEN
        RAISE EXCEPTION 'Please enter a valid height in centimetres.' USING ERRCODE = '22023';
    END IF;
    IF v_weight IS NOT NULL AND (v_weight < 25 OR v_weight > 300) THEN
        RAISE EXCEPTION 'Please enter a valid weight in kilograms.' USING ERRCODE = '22023';
    END IF;
    IF v_tobacco IS NULL OR v_tobacco NOT IN ('No', 'Yes', 'Occasionally') THEN
        RAISE EXCEPTION 'Please select your tobacco use status.' USING ERRCODE = '22023';
    END IF;
    IF v_occupation_risk IS NULL OR v_occupation_risk NOT IN (
        'Low risk (office / professional)',
        'Moderate risk (field / sales)',
        'High risk (manual / industrial)',
        'Not sure') THEN
        RAISE EXCEPTION 'Please select a valid occupation risk category.' USING ERRCODE = '22023';
    END IF;
    IF v_income_proof IS NOT NULL AND v_income_proof NOT IN (
        'Salary slips', 'ITR / Form 16', 'Bank statement',
        'Business financials', 'Other') THEN
        RAISE EXCEPTION 'Please select a valid income proof type.' USING ERRCODE = '22023';
    END IF;
    IF NOT v_medical_consent THEN
        RAISE EXCEPTION 'Please consent to medical tests or underwriting information requested by the insurer.' USING ERRCODE = '22023';
    END IF;

    -- ---- Declarations and consent -----------------------------------------
    IF NOT v_accuracy THEN
        RAISE EXCEPTION 'Please confirm that the information provided is true and complete.' USING ERRCODE = '22023';
    END IF;
    IF NOT v_authorisation THEN
        RAISE EXCEPTION 'Please authorise Dhanvi Finserv to share your enquiry with authorised insurers.' USING ERRCODE = '22023';
    END IF;
    IF NOT v_disclosure THEN
        RAISE EXCEPTION 'Please confirm that you understand insurance approval, coverage and claim settlement are decided by the insurer.' USING ERRCODE = '22023';
    END IF;
    IF NOT v_consent THEN
        RAISE EXCEPTION 'Please accept the privacy notice and insurance consent before submitting.' USING ERRCODE = '22023';
    END IF;

    v_message := left(
        'Insurance enquiry: ' || v_coverage ||
        ' | Cover: ' || v_cover_amount::TEXT ||
        ' | Loan: ' || v_loan_type ||
        ' | Lender: ' || v_lender ||
        CASE WHEN v_insurer_pref IS NOT NULL THEN ' | Preferred insurer: ' || v_insurer_pref ELSE '' END,
        1000
    );

    -- ---- Create the lead ---------------------------------------------------
    INSERT INTO public.loan_leads (
        full_name, mobile, email, loan_type, loan_amount, message,
        applicant_type, residency_status, employment_type,
        consent_given, consent_at, consent_version, source_page
    ) VALUES (
        v_name, v_mobile, v_email, 'Loan Protection Insurance', 0, v_message,
        'resident', 'Resident', 'Other',
        true, now(), v_consent_version, v_source
    )
    RETURNING id, reference_no, access_token INTO v_id, v_ref, v_token;

    -- ---- Structured insurance details -------------------------------------
    INSERT INTO public.loan_insurance_details (
        loan_lead_id, applicant_name, date_of_birth, gender, mobile, email,
        occupation, annual_income, pan_number,
        address_line, address_city, address_district, address_state, address_pincode,
        loan_type, lender_name, loan_account_reference,
        outstanding_amount, emi_amount, remaining_tenure_months,
        coverage_requirement, desired_cover_amount, policy_tenure_years,
        premium_budget, payment_frequency,
        existing_insurance, existing_insurer, existing_cover_amount,
        existing_policy_expiry, insurer_preference,
        nominee_name, nominee_relation, nominee_date_of_birth, nominee_mobile,
        co_borrower, co_borrower_name, co_borrower_relation,
        co_borrower_mobile, co_borrower_email, co_borrower_date_of_birth,
        height_cm, weight_kg, tobacco_use, medical_conditions, medications,
        hospitalization_last_3_years, occupation_risk, income_proof_type,
        medical_test_consent, underwriting_notes
    ) VALUES (
        v_id, v_name, v_dob, v_gender, v_mobile, v_email,
        v_occupation, v_income, v_pan,
        v_line, v_city, v_district, v_state, v_pin,
        v_loan_type, v_lender, v_loan_ref,
        v_outstanding, v_emi, v_remaining,
        v_coverage, v_cover_amount, v_tenure,
        v_budget, v_frequency,
        v_existing, v_existing_insurer, v_existing_cover,
        v_existing_expiry, v_insurer_pref,
        v_nominee_name, v_nominee_relation, v_nominee_dob, v_nominee_mobile,
        v_co_borrower, v_co_name, v_co_relation,
        v_co_mobile, v_co_email, v_co_dob,
        v_height, v_weight, v_tobacco, v_conditions, v_medications,
        v_hospitalization, v_occupation_risk, v_income_proof,
        v_medical_consent, v_underwriting_notes
    );

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
        'full_name', v_name,
        'loan_type', 'Loan Protection Insurance',
        'coverage_requirement', v_coverage,
        'desired_cover_amount', v_cover_amount,
        'proposal_status', 'Enquiry Received',
        'policy_status', 'Not Issued'
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 3. Extra document types for insurance applications
-- -----------------------------------------------------------------------------
-- The insurer decides the final document list. The wizard supports PAN,
-- Aadhaar, photograph, address proof, income proof, bank statement, loan
-- statement, sanction letter, medical report, existing policy, proposal form
-- and a general supporting document. Widen the CHECK on
-- public.loan_documents.document_type and re-register register_document() with
-- the same allowed list.

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
        'ITR Acknowledgement', 'Tax Payment Challan', 'Foreign Income Documents',
        'GST Certificate', 'Invoices', 'Purchase Bills', 'Rent Agreement / NOC',
        'Certificate of Incorporation', 'Partnership Deed', 'Board Resolution',
        'Authorisation Letter', 'Address Proof', 'Bank Proof',
        'Shop & Establishment Certificate', 'Electricity Bill',
        'Supporting Document',
        'Insurance Proposal Form', 'Medical Report', 'Existing Policy',
        'Insurer Quotation'
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
        'ITR Acknowledgement', 'Tax Payment Challan', 'Foreign Income Documents',
        'GST Certificate', 'Invoices', 'Purchase Bills', 'Rent Agreement / NOC',
        'Certificate of Incorporation', 'Partnership Deed', 'Board Resolution',
        'Authorisation Letter', 'Address Proof', 'Bank Proof',
        'Shop & Establishment Certificate', 'Electricity Bill',
        'Supporting Document',
        'Insurance Proposal Form', 'Medical Report', 'Existing Policy',
        'Insurer Quotation'
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

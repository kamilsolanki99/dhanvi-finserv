-- =============================================================================
-- NHOST / HASURA MIGRATION: 005_home_loan_topup_takeover.sql
-- PROJECT: Dhanvi Finserv
--
-- Run this ONCE, after 004, in the Nhost dashboard:
--   Database -> SQL Editor -> paste -> Run
--
-- It adds the structured application systems behind
-- home-loan-topup-apply.html and home-loan-takeover-apply.html:
--
--   1. public.home_loan_topup_details     - existing home loan + top-up request
--   2. public.home_loan_takeover_details  - existing loan + balance transfer plan
--
--   3. submit_home_loan_topup_application()     - validate and create a top-up
--      application (loan_leads + home_loan_topup_details + home_loan_emis +
--      loan_applicants) and consume the draft.
--   4. submit_home_loan_takeover_application()  - validate and create a
--      takeover application (loan_leads + home_loan_takeover_details +
--      loan_applicants) and consume the draft.
--   5. Extra document types ("Sanction Letter", "Loan Statement",
--      "Outstanding Certificate", "Repayment History", "Income Proof") added
--      to public.loan_documents.document_type and to register_document().
--
-- DRAFT STORAGE
--   Save / resume is shared with the Home Loan wizard: both new pages call the
--   existing save_home_loan_draft() / get_home_loan_draft() against
--   public.home_loan_drafts. The draft payload is opaque JSONB, so no new draft
--   table or draft function is required.
--
-- IMPORTANT
--   * Hasura permissions are the access-control layer, NOT Postgres RLS.
--   * Do not enable RLS on these tables.
--   * Every function returns SETOF public.api_result so Hasura can track it.
--   * Other loan types are untouched: they keep using submit_loan_application_v2.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Home Loan Top-Up details (1:1 with loan_leads)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.home_loan_topup_details (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_lead_id UUID NOT NULL UNIQUE REFERENCES public.loan_leads(id) ON DELETE CASCADE,

    -- Applicant identity
    first_name TEXT NOT NULL,
    middle_name TEXT,
    last_name TEXT NOT NULL,
    date_of_birth DATE NOT NULL,
    gender TEXT,
    marital_status TEXT,
    pan_number TEXT NOT NULL,
    aadhaar_masked TEXT,

    -- Identity verification (admin controlled)
    identity_verification_status TEXT NOT NULL DEFAULT 'Pending'
        CHECK (identity_verification_status IN ('Pending', 'Verified', 'Rejected')),
    identity_verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    identity_verified_at TIMESTAMPTZ,
    identity_notes TEXT,

    -- Employment and income
    employment_type TEXT NOT NULL
        CHECK (employment_type IN ('Salaried', 'Self-employed')),
    employer_name TEXT,
    business_name TEXT,
    designation TEXT,
    monthly_income NUMERIC NOT NULL CHECK (monthly_income > 0),
    annual_income NUMERIC CHECK (annual_income IS NULL OR annual_income > 0),
    work_experience_years NUMERIC CHECK (work_experience_years IS NULL OR work_experience_years >= 0),
    business_vintage_years NUMERIC CHECK (business_vintage_years IS NULL OR business_vintage_years >= 0),

    -- Existing home loan being topped up
    existing_lender_name TEXT NOT NULL,
    existing_lender_type TEXT
        CHECK (existing_lender_type IS NULL OR existing_lender_type IN ('Bank', 'NBFC', 'Housing Finance Company', 'Other')),
    loan_account_number TEXT,
    original_sanctioned_amount NUMERIC CHECK (original_sanctioned_amount IS NULL OR original_sanctioned_amount >= 0),
    current_outstanding NUMERIC CHECK (current_outstanding IS NULL OR current_outstanding >= 0),
    original_tenure_months INTEGER CHECK (original_tenure_months IS NULL OR (original_tenure_months >= 12 AND original_tenure_months <= 480)),
    remaining_tenure_months INTEGER CHECK (remaining_tenure_months IS NULL OR (remaining_tenure_months >= 0 AND remaining_tenure_months <= 480)),
    current_interest_rate NUMERIC CHECK (current_interest_rate IS NULL OR (current_interest_rate >= 0 AND current_interest_rate <= 40)),
    interest_type TEXT
        CHECK (interest_type IS NULL OR interest_type IN ('Floating', 'Fixed', 'Mixed')),
    current_emi NUMERIC CHECK (current_emi IS NULL OR current_emi >= 0),

    -- Top-up requirement
    topup_amount NUMERIC NOT NULL CHECK (topup_amount >= 50000),
    topup_purpose TEXT NOT NULL
        CHECK (topup_purpose IN ('Renovation', 'Extension', 'Education', 'Medical', 'Business', 'Personal')),

    -- Property
    property_address TEXT,
    property_city TEXT,
    property_state TEXT,
    property_pincode TEXT,
    property_type TEXT,
    property_market_value NUMERIC CHECK (property_market_value IS NULL OR property_market_value >= 0),
    ownership_type TEXT,

    -- Addresses
    current_address_line TEXT,
    current_address_city TEXT,
    current_address_state TEXT,
    current_address_pincode TEXT,
    same_as_current BOOLEAN NOT NULL DEFAULT false,
    permanent_address_line TEXT,
    permanent_address_city TEXT,
    permanent_address_state TEXT,
    permanent_address_pincode TEXT,

    -- Indicative figures captured at submission
    estimated_combined_emi NUMERIC CHECK (estimated_combined_emi IS NULL OR estimated_combined_emi >= 0),
    estimated_ltv NUMERIC CHECK (estimated_ltv IS NULL OR estimated_ltv >= 0),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS home_loan_topup_details_lead_idx
    ON public.home_loan_topup_details (loan_lead_id);
CREATE INDEX IF NOT EXISTS home_loan_topup_details_identity_idx
    ON public.home_loan_topup_details (identity_verification_status);
CREATE INDEX IF NOT EXISTS home_loan_topup_details_lender_idx
    ON public.home_loan_topup_details (existing_lender_name);

CREATE TRIGGER update_home_loan_topup_details_modtime
    BEFORE UPDATE ON public.home_loan_topup_details
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. Home Loan Takeover (balance transfer) details (1:1 with loan_leads)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.home_loan_takeover_details (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_lead_id UUID NOT NULL UNIQUE REFERENCES public.loan_leads(id) ON DELETE CASCADE,

    -- Applicant identity
    first_name TEXT NOT NULL,
    middle_name TEXT,
    last_name TEXT NOT NULL,
    date_of_birth DATE NOT NULL,
    gender TEXT,
    marital_status TEXT,
    pan_number TEXT NOT NULL,
    aadhaar_masked TEXT,

    -- Identity verification (admin controlled)
    identity_verification_status TEXT NOT NULL DEFAULT 'Pending'
        CHECK (identity_verification_status IN ('Pending', 'Verified', 'Rejected')),
    identity_verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    identity_verified_at TIMESTAMPTZ,
    identity_notes TEXT,

    -- Employment and income
    employment_type TEXT NOT NULL
        CHECK (employment_type IN ('Salaried', 'Self-employed')),
    employer_name TEXT,
    business_name TEXT,
    designation TEXT,
    monthly_income NUMERIC NOT NULL CHECK (monthly_income > 0),
    annual_income NUMERIC CHECK (annual_income IS NULL OR annual_income > 0),
    work_experience_years NUMERIC CHECK (work_experience_years IS NULL OR work_experience_years >= 0),
    business_vintage_years NUMERIC CHECK (business_vintage_years IS NULL OR business_vintage_years >= 0),

    -- Existing loan held with the old lender
    existing_lender_name TEXT NOT NULL,
    existing_lender_type TEXT
        CHECK (existing_lender_type IS NULL OR existing_lender_type IN ('Bank', 'NBFC', 'Housing Finance Company', 'Other')),
    loan_account_number TEXT,
    original_sanctioned_amount NUMERIC CHECK (original_sanctioned_amount IS NULL OR original_sanctioned_amount >= 0),
    current_outstanding_principal NUMERIC NOT NULL CHECK (current_outstanding_principal > 0),
    current_interest_rate NUMERIC CHECK (current_interest_rate IS NULL OR (current_interest_rate >= 0 AND current_interest_rate <= 40)),
    interest_type TEXT
        CHECK (interest_type IS NULL OR interest_type IN ('Floating', 'Fixed', 'Mixed')),
    current_emi NUMERIC CHECK (current_emi IS NULL OR current_emi >= 0),
    original_tenure_months INTEGER CHECK (original_tenure_months IS NULL OR (original_tenure_months >= 12 AND original_tenure_months <= 480)),
    remaining_tenure_months INTEGER CHECK (remaining_tenure_months IS NULL OR (remaining_tenure_months >= 0 AND remaining_tenure_months <= 480)),
    loan_start_date DATE,
    repayment_history TEXT
        CHECK (repayment_history IS NULL OR repayment_history IN ('Regular', 'Irregular', 'Overdue')),
    overdue_status TEXT
        CHECK (overdue_status IS NULL OR overdue_status IN ('None', '1-30 days', '31-60 days', '60+ days')),

    -- Transfer requirement
    expected_new_loan_amount NUMERIC NOT NULL CHECK (expected_new_loan_amount >= 100000),
    desired_interest_rate NUMERIC CHECK (desired_interest_rate IS NULL OR (desired_interest_rate >= 0 AND desired_interest_rate <= 40)),
    desired_tenure_months INTEGER NOT NULL CHECK (desired_tenure_months >= 12 AND desired_tenure_months <= 360),
    additional_topup_required BOOLEAN NOT NULL DEFAULT false,
    additional_topup_amount NUMERIC CHECK (additional_topup_amount IS NULL OR additional_topup_amount >= 0),
    additional_topup_purpose TEXT
        CHECK (additional_topup_purpose IS NULL OR additional_topup_purpose IN ('Renovation', 'Extension', 'Education', 'Medical', 'Business', 'Personal')),

    -- Property
    property_address TEXT,
    property_city TEXT,
    property_state TEXT,
    property_pincode TEXT,
    property_type TEXT,
    property_market_value NUMERIC CHECK (property_market_value IS NULL OR property_market_value >= 0),
    ownership_type TEXT,

    -- Addresses
    current_address_line TEXT,
    current_address_city TEXT,
    current_address_state TEXT,
    current_address_pincode TEXT,
    same_as_current BOOLEAN NOT NULL DEFAULT false,
    permanent_address_line TEXT,
    permanent_address_city TEXT,
    permanent_address_state TEXT,
    permanent_address_pincode TEXT,

    -- Indicative figures captured at submission
    estimated_savings NUMERIC,
    estimated_emi_difference NUMERIC,
    estimated_new_emi NUMERIC CHECK (estimated_new_emi IS NULL OR estimated_new_emi >= 0),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS home_loan_takeover_details_lead_idx
    ON public.home_loan_takeover_details (loan_lead_id);
CREATE INDEX IF NOT EXISTS home_loan_takeover_details_identity_idx
    ON public.home_loan_takeover_details (identity_verification_status);
CREATE INDEX IF NOT EXISTS home_loan_takeover_details_lender_idx
    ON public.home_loan_takeover_details (existing_lender_name);

CREATE TRIGGER update_home_loan_takeover_details_modtime
    BEFORE UPDATE ON public.home_loan_takeover_details
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. submit_home_loan_topup_application
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_home_loan_topup_application(
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
    v_employment JSONB := coalesce(p_payload->'employment', '{}'::JSONB);
    v_existing JSONB := coalesce(p_payload->'existing_loan', '{}'::JSONB);
    v_topup_data JSONB := coalesce(p_payload->'topup', '{}'::JSONB);
    v_property JSONB := coalesce(p_payload->'property', '{}'::JSONB);
    v_address JSONB := coalesce(p_payload->'address', '{}'::JSONB);
    v_current JSONB;
    v_permanent JSONB;
    v_emis JSONB := coalesce(p_payload->'emis', '[]'::JSONB);
    v_co JSONB := coalesce(p_payload->'co_applicants', '[]'::JSONB);
    v_guar JSONB := coalesce(p_payload->'guarantors', '[]'::JSONB);
    v_item JSONB;

    v_first TEXT := btrim(coalesce(v_personal->>'first_name', ''));
    v_middle TEXT := nullif(btrim(coalesce(v_personal->>'middle_name', '')), '');
    v_last TEXT := btrim(coalesce(v_personal->>'last_name', ''));
    v_full_name TEXT;
    v_dob DATE := nullif(v_personal->>'date_of_birth', '')::DATE;
    v_gender TEXT := nullif(btrim(coalesce(v_personal->>'gender', '')), '');
    v_marital TEXT := nullif(btrim(coalesce(v_personal->>'marital_status', '')), '');
    v_mobile TEXT := regexp_replace(coalesce(v_personal->>'mobile', ''), '[^0-9]', '', 'g');
    v_email TEXT := nullif(btrim(coalesce(v_personal->>'email', '')), '');
    v_pan TEXT := upper(btrim(coalesce(v_personal->>'pan_number', '')));
    v_aadhaar TEXT := regexp_replace(coalesce(v_personal->>'aadhaar_number', ''), '[^0-9]', '', 'g');
    v_aadhaar_masked TEXT;

    v_employment_type TEXT := btrim(coalesce(v_employment->>'employment_type', ''));
    v_employer TEXT := nullif(btrim(coalesce(v_employment->>'employer_name', '')), '');
    v_business TEXT := nullif(btrim(coalesce(v_employment->>'business_name', '')), '');
    v_designation TEXT := nullif(btrim(coalesce(v_employment->>'designation', '')), '');
    v_monthly NUMERIC := nullif(v_employment->>'monthly_income', '')::NUMERIC;
    v_annual NUMERIC := nullif(v_employment->>'annual_income', '')::NUMERIC;
    v_exp NUMERIC := nullif(v_employment->>'work_experience_years', '')::NUMERIC;
    v_vintage NUMERIC := nullif(v_employment->>'business_vintage_years', '')::NUMERIC;

    v_lender TEXT := nullif(btrim(coalesce(v_existing->>'lender_name', '')), '');
    v_lender_type TEXT := nullif(btrim(coalesce(v_existing->>'lender_type', '')), '');
    v_account TEXT := nullif(btrim(coalesce(v_existing->>'loan_account_number', '')), '');
    v_sanctioned NUMERIC := nullif(v_existing->>'sanctioned_amount', '')::NUMERIC;
    v_outstanding NUMERIC := nullif(v_existing->>'current_outstanding', '')::NUMERIC;
    v_orig_tenure INTEGER := nullif(v_existing->>'original_tenure_months', '')::INTEGER;
    v_remaining INTEGER := nullif(v_existing->>'remaining_tenure_months', '')::INTEGER;
    v_rate NUMERIC := nullif(v_existing->>'current_interest_rate', '')::NUMERIC;
    v_interest_type TEXT := nullif(btrim(coalesce(v_existing->>'interest_type', '')), '');
    v_emi NUMERIC := nullif(v_existing->>'current_emi', '')::NUMERIC;

    v_topup NUMERIC := nullif(v_topup_data->>'amount', '')::NUMERIC;
    v_purpose TEXT := btrim(coalesce(v_topup_data->>'purpose', ''));

    v_prop_type TEXT := nullif(btrim(coalesce(v_property->>'property_type', '')), '');
    v_prop_value NUMERIC := nullif(v_property->>'market_value', '')::NUMERIC;
    v_ownership TEXT := nullif(btrim(coalesce(v_property->>'ownership_type', '')), '');

    v_same BOOLEAN := coalesce((v_address->>'same_as_current')::BOOLEAN, false);
    v_cur_line TEXT;
    v_cur_city TEXT;
    v_cur_state TEXT;
    v_cur_pin TEXT;
    v_per_line TEXT;
    v_per_city TEXT;
    v_per_state TEXT;
    v_per_pin TEXT;

    v_consent BOOLEAN := coalesce((p_payload->>'consent')::BOOLEAN, false);
    v_consent_version TEXT := coalesce(nullif(p_payload->>'consent_version', ''), '2026-10');
    v_source TEXT := nullif(btrim(coalesce(p_payload->>'source_page', '')), '');

    v_item_mobile TEXT;
    v_item_email TEXT;
    v_age INTEGER;

    -- Indicative calculations
    v_combined_emi NUMERIC;
    v_ltv NUMERIC;
    v_topup_emi NUMERIC;
    v_calc_rate NUMERIC;
    v_calc_months INTEGER;
BEGIN
    -- ---- Payload shape -----------------------------------------------------
    IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'The application could not be submitted. Please try again.' USING ERRCODE = '22023';
    END IF;

    -- ---- Personal details --------------------------------------------------
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
    IF v_age > 70 THEN
        RAISE EXCEPTION 'The applicant age must be 70 years or below.' USING ERRCODE = '22023';
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

    -- ---- Employment --------------------------------------------------------
    IF v_employment_type NOT IN ('Salaried', 'Self-employed') THEN
        RAISE EXCEPTION 'Please select your employment type.' USING ERRCODE = '22023';
    END IF;
    IF v_employment_type = 'Salaried' AND v_employer IS NULL THEN
        RAISE EXCEPTION 'Please enter your employer name.' USING ERRCODE = '22023';
    END IF;
    IF v_employment_type = 'Self-employed' AND v_business IS NULL THEN
        RAISE EXCEPTION 'Please enter your business name.' USING ERRCODE = '22023';
    END IF;
    IF v_monthly IS NULL OR v_monthly <= 0 THEN
        RAISE EXCEPTION 'Please enter your monthly income.' USING ERRCODE = '22023';
    END IF;
    IF v_annual IS NULL OR v_annual <= 0 THEN
        v_annual := v_monthly * 12;
    END IF;

    -- ---- Existing home loan ------------------------------------------------
    IF v_lender IS NULL THEN
        RAISE EXCEPTION 'Please enter the bank or NBFC that holds your current home loan.' USING ERRCODE = '22023';
    END IF;
    IF v_lender_type IS NOT NULL AND v_lender_type NOT IN ('Bank', 'NBFC', 'Housing Finance Company', 'Other') THEN
        RAISE EXCEPTION 'Please select a valid lender type.' USING ERRCODE = '22023';
    END IF;
    IF v_sanctioned IS NOT NULL AND v_sanctioned < 0 THEN
        RAISE EXCEPTION 'Please enter a valid original sanctioned amount.' USING ERRCODE = '22023';
    END IF;
    IF v_outstanding IS NULL OR v_outstanding <= 0 THEN
        RAISE EXCEPTION 'Please enter your current outstanding balance.' USING ERRCODE = '22023';
    END IF;
    IF v_orig_tenure IS NOT NULL AND (v_orig_tenure < 12 OR v_orig_tenure > 480) THEN
        RAISE EXCEPTION 'The original tenure must be between 1 and 40 years.' USING ERRCODE = '22023';
    END IF;
    IF v_remaining IS NOT NULL AND (v_remaining < 0 OR v_remaining > 480) THEN
        RAISE EXCEPTION 'Please enter a valid remaining tenure.' USING ERRCODE = '22023';
    END IF;
    IF v_rate IS NOT NULL AND (v_rate < 0 OR v_rate > 40) THEN
        RAISE EXCEPTION 'Please enter a valid current interest rate.' USING ERRCODE = '22023';
    END IF;
    IF v_interest_type IS NOT NULL AND v_interest_type NOT IN ('Floating', 'Fixed', 'Mixed') THEN
        RAISE EXCEPTION 'Please select a valid interest type.' USING ERRCODE = '22023';
    END IF;
    IF v_emi IS NOT NULL AND v_emi < 0 THEN
        RAISE EXCEPTION 'Please enter a valid current EMI.' USING ERRCODE = '22023';
    END IF;

    -- ---- Top-up requirement ------------------------------------------------
    IF v_topup IS NULL OR v_topup < 50000 THEN
        RAISE EXCEPTION 'Please enter a top-up amount of at least ₹50,000.' USING ERRCODE = '22023';
    END IF;
    IF v_purpose NOT IN ('Renovation', 'Extension', 'Education', 'Medical', 'Business', 'Personal') THEN
        RAISE EXCEPTION 'Please select the purpose of the top-up.' USING ERRCODE = '22023';
    END IF;

    -- ---- Property ----------------------------------------------------------
    IF v_prop_value IS NOT NULL AND v_prop_value <= 0 THEN
        RAISE EXCEPTION 'Please enter a valid property market value.' USING ERRCODE = '22023';
    END IF;

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
    END IF;

    -- ---- Consent -----------------------------------------------------------
    IF NOT v_consent THEN
        RAISE EXCEPTION 'Please accept the privacy notice before submitting.' USING ERRCODE = '22023';
    END IF;

    -- ---- Child collection shapes ------------------------------------------
    IF jsonb_typeof(v_emis) <> 'array' THEN
        RAISE EXCEPTION 'Other running loans must be submitted as a list.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(v_emis) > 10 THEN
        RAISE EXCEPTION 'A maximum of 10 other running loans is allowed.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_co) <> 'array' THEN
        RAISE EXCEPTION 'Co-applicants must be submitted as a list.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(v_co) > 3 THEN
        RAISE EXCEPTION 'A maximum of 3 co-applicants is allowed.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_guar) <> 'array' THEN
        RAISE EXCEPTION 'Guarantors must be submitted as a list.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(v_guar) > 2 THEN
        RAISE EXCEPTION 'A maximum of 2 guarantors is allowed.' USING ERRCODE = '22023';
    END IF;

    -- ---- Indicative figures (stored for the advisor) -----------------------
    IF v_prop_value IS NOT NULL AND v_prop_value > 0 THEN
        v_ltv := round(((v_outstanding + v_topup) / v_prop_value) * 100, 2);
    END IF;

    v_calc_rate := coalesce(v_rate, 8.5) / 1200;
    v_calc_months := coalesce(nullif(v_remaining, 0), 240);
    v_topup_emi := v_topup * v_calc_rate * power(1 + v_calc_rate, v_calc_months)
        / (power(1 + v_calc_rate, v_calc_months) - 1);
    v_combined_emi := round(coalesce(v_emi, 0) + v_topup_emi, 2);

    -- ---- Create the lead ---------------------------------------------------
    INSERT INTO public.loan_leads (
        full_name, mobile, email, loan_type, loan_amount, message,
        applicant_type, employment_type, consent_given, consent_at,
        consent_version, source_page
    ) VALUES (
        v_full_name, v_mobile, v_email, 'Home Loan Top-Up', v_topup,
        btrim(concat_ws(' · ',
            'Existing lender: ' || v_lender,
            'Outstanding: ₹' || to_char(v_outstanding, 'FM999999999990'),
            'Top-up: ₹' || to_char(v_topup, 'FM999999999990'),
            'Purpose: ' || v_purpose
        )),
        'resident', v_employment_type, true, now(), v_consent_version, v_source
    )
    RETURNING id, reference_no, access_token INTO v_id, v_ref, v_token;

    -- ---- Structured top-up details -----------------------------------------
    INSERT INTO public.home_loan_topup_details (
        loan_lead_id, first_name, middle_name, last_name, date_of_birth,
        gender, marital_status, pan_number, aadhaar_masked,
        employment_type, employer_name, business_name, designation,
        monthly_income, annual_income, work_experience_years, business_vintage_years,
        existing_lender_name, existing_lender_type, loan_account_number,
        original_sanctioned_amount, current_outstanding,
        original_tenure_months, remaining_tenure_months,
        current_interest_rate, interest_type, current_emi,
        topup_amount, topup_purpose,
        property_address, property_city, property_state, property_pincode,
        property_type, property_market_value, ownership_type,
        current_address_line, current_address_city, current_address_state, current_address_pincode,
        same_as_current,
        permanent_address_line, permanent_address_city, permanent_address_state, permanent_address_pincode,
        estimated_combined_emi, estimated_ltv
    ) VALUES (
        v_id, v_first, v_middle, v_last, v_dob,
        v_gender, v_marital, v_pan, v_aadhaar_masked,
        v_employment_type,
        CASE WHEN v_employment_type = 'Salaried' THEN v_employer ELSE NULL END,
        CASE WHEN v_employment_type = 'Self-employed' THEN v_business ELSE NULL END,
        v_designation,
        v_monthly, v_annual, v_exp, v_vintage,
        v_lender, v_lender_type, v_account,
        v_sanctioned, v_outstanding,
        v_orig_tenure, v_remaining,
        v_rate, v_interest_type, v_emi,
        v_topup, v_purpose,
        nullif(btrim(coalesce(v_property->>'address', '')), ''),
        nullif(btrim(coalesce(v_property->>'city', '')), ''),
        nullif(btrim(coalesce(v_property->>'state', '')), ''),
        nullif(btrim(coalesce(v_property->>'pincode', '')), ''),
        v_prop_type, v_prop_value, v_ownership,
        v_cur_line, v_cur_city, v_cur_state, v_cur_pin,
        v_same,
        v_per_line, v_per_city, v_per_state, v_per_pin,
        v_combined_emi, v_ltv
    );

    -- ---- Other running loans / EMIs ----------------------------------------
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_emis) LOOP
        IF nullif(btrim(coalesce(v_item->>'bank_name', '')), '') IS NOT NULL THEN
            INSERT INTO public.home_loan_emis (
                loan_lead_id, bank_name, loan_type, outstanding_amount, monthly_emi
            ) VALUES (
                v_id,
                btrim(v_item->>'bank_name'),
                nullif(btrim(coalesce(v_item->>'loan_type', '')), ''),
                nullif(v_item->>'outstanding_amount', '')::NUMERIC,
                nullif(v_item->>'monthly_emi', '')::NUMERIC
            );
        END IF;
    END LOOP;

    -- ---- Co-applicants -----------------------------------------------------
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_co) LOOP
        IF btrim(coalesce(v_item->>'full_name', '')) = '' THEN
            RAISE EXCEPTION 'Please enter each co-applicant name.' USING ERRCODE = '22023';
        END IF;
        IF nullif(btrim(coalesce(v_item->>'relationship', '')), '') IS NULL THEN
            RAISE EXCEPTION 'Please select the relationship for each co-applicant.' USING ERRCODE = '22023';
        END IF;
        v_item_mobile := regexp_replace(coalesce(v_item->>'mobile', ''), '[^0-9]', '', 'g');
        IF v_item_mobile <> '' AND v_item_mobile !~ '^[6-9][0-9]{9}$' THEN
            RAISE EXCEPTION 'Please enter a valid 10-digit mobile number for each co-applicant.' USING ERRCODE = '22023';
        END IF;
        v_item_email := nullif(btrim(coalesce(v_item->>'email', '')), '');
        IF v_item_email IS NOT NULL AND v_item_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
            RAISE EXCEPTION 'Please enter a valid email address for each co-applicant.' USING ERRCODE = '22023';
        END IF;

        INSERT INTO public.loan_applicants (
            loan_lead_id, role, applicant_type, full_name, relationship, date_of_birth,
            email, mobile, employment_type, employer_name, monthly_income, income_currency
        ) VALUES (
            v_id, 'co_applicant', 'resident',
            btrim(v_item->>'full_name'),
            nullif(btrim(coalesce(v_item->>'relationship', '')), ''),
            nullif(v_item->>'date_of_birth', '')::DATE,
            v_item_email,
            nullif(v_item_mobile, ''),
            nullif(btrim(coalesce(v_item->>'employment_type', '')), ''),
            nullif(btrim(coalesce(v_item->>'employer_name', '')), ''),
            nullif(v_item->>'monthly_income', '')::NUMERIC,
            'INR'
        );
    END LOOP;

    -- ---- Guarantors --------------------------------------------------------
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_guar) LOOP
        IF btrim(coalesce(v_item->>'full_name', '')) = '' THEN
            RAISE EXCEPTION 'Please enter each guarantor name.' USING ERRCODE = '22023';
        END IF;
        IF nullif(btrim(coalesce(v_item->>'relationship', '')), '') IS NULL THEN
            RAISE EXCEPTION 'Please select the relationship for each guarantor.' USING ERRCODE = '22023';
        END IF;
        v_item_mobile := regexp_replace(coalesce(v_item->>'mobile', ''), '[^0-9]', '', 'g');
        IF v_item_mobile <> '' AND v_item_mobile !~ '^[6-9][0-9]{9}$' THEN
            RAISE EXCEPTION 'Please enter a valid 10-digit mobile number for each guarantor.' USING ERRCODE = '22023';
        END IF;
        v_item_email := nullif(btrim(coalesce(v_item->>'email', '')), '');
        IF v_item_email IS NOT NULL AND v_item_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
            RAISE EXCEPTION 'Please enter a valid email address for each guarantor.' USING ERRCODE = '22023';
        END IF;

        INSERT INTO public.loan_applicants (
            loan_lead_id, role, applicant_type, full_name, relationship, date_of_birth,
            email, mobile, employment_type, employer_name, monthly_income, income_currency
        ) VALUES (
            v_id, 'guarantor', 'resident',
            btrim(v_item->>'full_name'),
            nullif(btrim(coalesce(v_item->>'relationship', '')), ''),
            nullif(v_item->>'date_of_birth', '')::DATE,
            v_item_email,
            nullif(v_item_mobile, ''),
            nullif(btrim(coalesce(v_item->>'employment_type', '')), ''),
            nullif(btrim(coalesce(v_item->>'employer_name', '')), ''),
            nullif(v_item->>'monthly_income', '')::NUMERIC,
            'INR'
        );
    END LOOP;

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
        'loan_type', 'Home Loan Top-Up',
        'loan_amount', v_topup,
        'estimated_combined_emi', v_combined_emi,
        'estimated_ltv', v_ltv,
        'applicant_type', 'resident'
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. submit_home_loan_takeover_application
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_home_loan_takeover_application(
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
    v_employment JSONB := coalesce(p_payload->'employment', '{}'::JSONB);
    v_existing JSONB := coalesce(p_payload->'existing_loan', '{}'::JSONB);
    v_transfer JSONB := coalesce(p_payload->'transfer', '{}'::JSONB);
    v_property JSONB := coalesce(p_payload->'property', '{}'::JSONB);
    v_address JSONB := coalesce(p_payload->'address', '{}'::JSONB);
    v_current JSONB;
    v_permanent JSONB;
    v_co JSONB := coalesce(p_payload->'co_applicants', '[]'::JSONB);
    v_guar JSONB := coalesce(p_payload->'guarantors', '[]'::JSONB);
    v_item JSONB;

    v_first TEXT := btrim(coalesce(v_personal->>'first_name', ''));
    v_middle TEXT := nullif(btrim(coalesce(v_personal->>'middle_name', '')), '');
    v_last TEXT := btrim(coalesce(v_personal->>'last_name', ''));
    v_full_name TEXT;
    v_dob DATE := nullif(v_personal->>'date_of_birth', '')::DATE;
    v_gender TEXT := nullif(btrim(coalesce(v_personal->>'gender', '')), '');
    v_marital TEXT := nullif(btrim(coalesce(v_personal->>'marital_status', '')), '');
    v_mobile TEXT := regexp_replace(coalesce(v_personal->>'mobile', ''), '[^0-9]', '', 'g');
    v_email TEXT := nullif(btrim(coalesce(v_personal->>'email', '')), '');
    v_pan TEXT := upper(btrim(coalesce(v_personal->>'pan_number', '')));
    v_aadhaar TEXT := regexp_replace(coalesce(v_personal->>'aadhaar_number', ''), '[^0-9]', '', 'g');
    v_aadhaar_masked TEXT;

    v_employment_type TEXT := btrim(coalesce(v_employment->>'employment_type', ''));
    v_employer TEXT := nullif(btrim(coalesce(v_employment->>'employer_name', '')), '');
    v_business TEXT := nullif(btrim(coalesce(v_employment->>'business_name', '')), '');
    v_designation TEXT := nullif(btrim(coalesce(v_employment->>'designation', '')), '');
    v_monthly NUMERIC := nullif(v_employment->>'monthly_income', '')::NUMERIC;
    v_annual NUMERIC := nullif(v_employment->>'annual_income', '')::NUMERIC;
    v_exp NUMERIC := nullif(v_employment->>'work_experience_years', '')::NUMERIC;
    v_vintage NUMERIC := nullif(v_employment->>'business_vintage_years', '')::NUMERIC;

    v_lender TEXT := nullif(btrim(coalesce(v_existing->>'lender_name', '')), '');
    v_lender_type TEXT := nullif(btrim(coalesce(v_existing->>'lender_type', '')), '');
    v_account TEXT := nullif(btrim(coalesce(v_existing->>'loan_account_number', '')), '');
    v_sanctioned NUMERIC := nullif(v_existing->>'original_sanctioned_amount', '')::NUMERIC;
    v_outstanding NUMERIC := nullif(v_existing->>'current_outstanding_principal', '')::NUMERIC;
    v_rate NUMERIC := nullif(v_existing->>'current_interest_rate', '')::NUMERIC;
    v_interest_type TEXT := nullif(btrim(coalesce(v_existing->>'interest_type', '')), '');
    v_emi NUMERIC := nullif(v_existing->>'current_emi', '')::NUMERIC;
    v_orig_tenure INTEGER := nullif(v_existing->>'original_tenure_months', '')::INTEGER;
    v_remaining INTEGER := nullif(v_existing->>'remaining_tenure_months', '')::INTEGER;
    v_start_date DATE := nullif(v_existing->>'loan_start_date', '')::DATE;
    v_repayment TEXT := nullif(btrim(coalesce(v_existing->>'repayment_history', '')), '');
    v_overdue TEXT := nullif(btrim(coalesce(v_existing->>'overdue_status', '')), '');

    v_new_amount NUMERIC := nullif(v_transfer->>'expected_new_loan_amount', '')::NUMERIC;
    v_desired_rate NUMERIC := nullif(v_transfer->>'desired_interest_rate', '')::NUMERIC;
    v_desired_tenure INTEGER := nullif(v_transfer->>'desired_tenure_months', '')::INTEGER;
    v_topup_required BOOLEAN := coalesce((v_transfer->>'additional_topup_required')::BOOLEAN, false);
    v_topup_amount NUMERIC := nullif(v_transfer->>'additional_topup_amount', '')::NUMERIC;
    v_topup_purpose TEXT := nullif(btrim(coalesce(v_transfer->>'additional_topup_purpose', '')), '');

    v_prop_type TEXT := nullif(btrim(coalesce(v_property->>'property_type', '')), '');
    v_prop_value NUMERIC := nullif(v_property->>'market_value', '')::NUMERIC;
    v_ownership TEXT := nullif(btrim(coalesce(v_property->>'ownership_type', '')), '');

    v_same BOOLEAN := coalesce((v_address->>'same_as_current')::BOOLEAN, false);
    v_cur_line TEXT;
    v_cur_city TEXT;
    v_cur_state TEXT;
    v_cur_pin TEXT;
    v_per_line TEXT;
    v_per_city TEXT;
    v_per_state TEXT;
    v_per_pin TEXT;

    v_consent BOOLEAN := coalesce((p_payload->>'consent')::BOOLEAN, false);
    v_consent_version TEXT := coalesce(nullif(p_payload->>'consent_version', ''), '2026-10');
    v_source TEXT := nullif(btrim(coalesce(p_payload->>'source_page', '')), '');

    v_item_mobile TEXT;
    v_item_email TEXT;
    v_age INTEGER;

    -- Indicative figures
    v_effective_rate NUMERIC;
    v_new_emi NUMERIC;
    v_emi_diff NUMERIC;
    v_savings NUMERIC;
    v_old_total NUMERIC;
    v_new_total NUMERIC;
    v_calc_rate NUMERIC;
BEGIN
    -- ---- Payload shape -----------------------------------------------------
    IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'The application could not be submitted. Please try again.' USING ERRCODE = '22023';
    END IF;

    -- ---- Personal details --------------------------------------------------
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
    IF v_age > 70 THEN
        RAISE EXCEPTION 'The applicant age must be 70 years or below.' USING ERRCODE = '22023';
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

    -- ---- Employment --------------------------------------------------------
    IF v_employment_type NOT IN ('Salaried', 'Self-employed') THEN
        RAISE EXCEPTION 'Please select your employment type.' USING ERRCODE = '22023';
    END IF;
    IF v_employment_type = 'Salaried' AND v_employer IS NULL THEN
        RAISE EXCEPTION 'Please enter your employer name.' USING ERRCODE = '22023';
    END IF;
    IF v_employment_type = 'Self-employed' AND v_business IS NULL THEN
        RAISE EXCEPTION 'Please enter your business name.' USING ERRCODE = '22023';
    END IF;
    IF v_monthly IS NULL OR v_monthly <= 0 THEN
        RAISE EXCEPTION 'Please enter your monthly income.' USING ERRCODE = '22023';
    END IF;
    IF v_annual IS NULL OR v_annual <= 0 THEN
        v_annual := v_monthly * 12;
    END IF;

    -- ---- Existing loan -----------------------------------------------------
    IF v_lender IS NULL THEN
        RAISE EXCEPTION 'Please enter the bank or NBFC that holds your current loan.' USING ERRCODE = '22023';
    END IF;
    IF v_lender_type IS NOT NULL AND v_lender_type NOT IN ('Bank', 'NBFC', 'Housing Finance Company', 'Other') THEN
        RAISE EXCEPTION 'Please select a valid lender type.' USING ERRCODE = '22023';
    END IF;
    IF v_sanctioned IS NOT NULL AND v_sanctioned < 0 THEN
        RAISE EXCEPTION 'Please enter a valid original sanctioned amount.' USING ERRCODE = '22023';
    END IF;
    IF v_outstanding IS NULL OR v_outstanding <= 0 THEN
        RAISE EXCEPTION 'Please enter your current outstanding principal.' USING ERRCODE = '22023';
    END IF;
    IF v_rate IS NOT NULL AND (v_rate < 0 OR v_rate > 40) THEN
        RAISE EXCEPTION 'Please enter a valid current interest rate.' USING ERRCODE = '22023';
    END IF;
    IF v_interest_type IS NOT NULL AND v_interest_type NOT IN ('Floating', 'Fixed', 'Mixed') THEN
        RAISE EXCEPTION 'Please select a valid interest type.' USING ERRCODE = '22023';
    END IF;
    IF v_emi IS NOT NULL AND v_emi < 0 THEN
        RAISE EXCEPTION 'Please enter a valid existing EMI.' USING ERRCODE = '22023';
    END IF;
    IF v_orig_tenure IS NOT NULL AND (v_orig_tenure < 12 OR v_orig_tenure > 480) THEN
        RAISE EXCEPTION 'The original tenure must be between 1 and 40 years.' USING ERRCODE = '22023';
    END IF;
    IF v_remaining IS NOT NULL AND (v_remaining < 0 OR v_remaining > 480) THEN
        RAISE EXCEPTION 'Please enter a valid remaining tenure.' USING ERRCODE = '22023';
    END IF;
    IF v_repayment IS NOT NULL AND v_repayment NOT IN ('Regular', 'Irregular', 'Overdue') THEN
        RAISE EXCEPTION 'Please select a valid repayment history.' USING ERRCODE = '22023';
    END IF;
    IF v_overdue IS NOT NULL AND v_overdue NOT IN ('None', '1-30 days', '31-60 days', '60+ days') THEN
        RAISE EXCEPTION 'Please select a valid overdue status.' USING ERRCODE = '22023';
    END IF;

    -- ---- Transfer requirement ---------------------------------------------
    IF v_new_amount IS NULL OR v_new_amount < 100000 THEN
        RAISE EXCEPTION 'Please enter an expected loan amount of at least ₹1,00,000.' USING ERRCODE = '22023';
    END IF;
    IF v_desired_rate IS NOT NULL AND (v_desired_rate < 0 OR v_desired_rate > 40) THEN
        RAISE EXCEPTION 'Please enter a valid desired interest rate.' USING ERRCODE = '22023';
    END IF;
    IF v_desired_tenure IS NULL OR v_desired_tenure < 12 OR v_desired_tenure > 360 THEN
        RAISE EXCEPTION 'Please choose a desired tenure between 1 and 30 years.' USING ERRCODE = '22023';
    END IF;
    IF v_topup_required THEN
        IF v_topup_amount IS NULL OR v_topup_amount < 50000 THEN
            RAISE EXCEPTION 'Please enter an additional top-up amount of at least ₹50,000.' USING ERRCODE = '22023';
        END IF;
        IF v_topup_purpose NOT IN ('Renovation', 'Extension', 'Education', 'Medical', 'Business', 'Personal') THEN
            RAISE EXCEPTION 'Please select the purpose of the additional top-up.' USING ERRCODE = '22023';
        END IF;
    ELSE
        v_topup_amount := NULL;
        v_topup_purpose := NULL;
    END IF;

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
    END IF;

    -- ---- Consent -----------------------------------------------------------
    IF NOT v_consent THEN
        RAISE EXCEPTION 'Please accept the privacy notice before submitting.' USING ERRCODE = '22023';
    END IF;

    -- ---- Child collection shapes ------------------------------------------
    IF jsonb_typeof(v_co) <> 'array' THEN
        RAISE EXCEPTION 'Co-applicants must be submitted as a list.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(v_co) > 3 THEN
        RAISE EXCEPTION 'A maximum of 3 co-applicants is allowed.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_guar) <> 'array' THEN
        RAISE EXCEPTION 'Guarantors must be submitted as a list.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(v_guar) > 2 THEN
        RAISE EXCEPTION 'A maximum of 2 guarantors is allowed.' USING ERRCODE = '22023';
    END IF;

    -- ---- Indicative savings / EMI comparison -------------------------------
    v_effective_rate := coalesce(v_desired_rate, greatest(coalesce(v_rate, 8.5) - 0.5, 1));
    v_calc_rate := v_effective_rate / 1200;
    IF v_calc_rate > 0 THEN
        v_new_emi := v_new_amount * v_calc_rate * power(1 + v_calc_rate, v_desired_tenure)
            / (power(1 + v_calc_rate, v_desired_tenure) - 1);
    ELSE
        v_new_emi := v_new_amount / v_desired_tenure;
    END IF;
    v_new_emi := round(v_new_emi, 2);

    IF v_emi IS NOT NULL AND v_emi > 0 THEN
        v_emi_diff := round(v_new_emi - v_emi, 2);
    END IF;

    IF v_emi IS NOT NULL AND v_emi > 0 AND v_remaining IS NOT NULL AND v_remaining > 0 THEN
        v_old_total := v_emi * v_remaining;
        v_new_total := v_new_emi * v_desired_tenure;
        v_savings := round(v_old_total - v_new_total, 2);
    END IF;

    -- ---- Create the lead ---------------------------------------------------
    INSERT INTO public.loan_leads (
        full_name, mobile, email, loan_type, loan_amount, message,
        applicant_type, employment_type, consent_given, consent_at,
        consent_version, source_page
    ) VALUES (
        v_full_name, v_mobile, v_email, 'Home Loan Takeover', v_new_amount,
        btrim(concat_ws(' · ',
            'Existing lender: ' || v_lender,
            'Outstanding: ₹' || to_char(v_outstanding, 'FM999999999990'),
            'Current rate: ' || coalesce(to_char(v_rate, 'FM990.00'), 'not provided') || '%',
            'Desired tenure: ' || v_desired_tenure || ' months',
            CASE WHEN v_topup_required
                THEN 'Additional top-up: ₹' || to_char(v_topup_amount, 'FM999999999990') || ' (' || v_topup_purpose || ')'
                ELSE 'No additional top-up' END
        )),
        'resident', v_employment_type, true, now(), v_consent_version, v_source
    )
    RETURNING id, reference_no, access_token INTO v_id, v_ref, v_token;

    -- ---- Structured takeover details ---------------------------------------
    INSERT INTO public.home_loan_takeover_details (
        loan_lead_id, first_name, middle_name, last_name, date_of_birth,
        gender, marital_status, pan_number, aadhaar_masked,
        employment_type, employer_name, business_name, designation,
        monthly_income, annual_income, work_experience_years, business_vintage_years,
        existing_lender_name, existing_lender_type, loan_account_number,
        original_sanctioned_amount, current_outstanding_principal,
        current_interest_rate, interest_type, current_emi,
        original_tenure_months, remaining_tenure_months, loan_start_date,
        repayment_history, overdue_status,
        expected_new_loan_amount, desired_interest_rate, desired_tenure_months,
        additional_topup_required, additional_topup_amount, additional_topup_purpose,
        property_address, property_city, property_state, property_pincode,
        property_type, property_market_value, ownership_type,
        current_address_line, current_address_city, current_address_state, current_address_pincode,
        same_as_current,
        permanent_address_line, permanent_address_city, permanent_address_state, permanent_address_pincode,
        estimated_savings, estimated_emi_difference, estimated_new_emi
    ) VALUES (
        v_id, v_first, v_middle, v_last, v_dob,
        v_gender, v_marital, v_pan, v_aadhaar_masked,
        v_employment_type,
        CASE WHEN v_employment_type = 'Salaried' THEN v_employer ELSE NULL END,
        CASE WHEN v_employment_type = 'Self-employed' THEN v_business ELSE NULL END,
        v_designation,
        v_monthly, v_annual, v_exp, v_vintage,
        v_lender, v_lender_type, v_account,
        v_sanctioned, v_outstanding,
        v_rate, v_interest_type, v_emi,
        v_orig_tenure, v_remaining, v_start_date,
        v_repayment, v_overdue,
        v_new_amount, v_desired_rate, v_desired_tenure,
        v_topup_required, v_topup_amount, v_topup_purpose,
        nullif(btrim(coalesce(v_property->>'address', '')), ''),
        nullif(btrim(coalesce(v_property->>'city', '')), ''),
        nullif(btrim(coalesce(v_property->>'state', '')), ''),
        nullif(btrim(coalesce(v_property->>'pincode', '')), ''),
        v_prop_type, v_prop_value, v_ownership,
        v_cur_line, v_cur_city, v_cur_state, v_cur_pin,
        v_same,
        v_per_line, v_per_city, v_per_state, v_per_pin,
        v_savings, v_emi_diff, v_new_emi
    );

    -- ---- Co-applicants -----------------------------------------------------
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_co) LOOP
        IF btrim(coalesce(v_item->>'full_name', '')) = '' THEN
            RAISE EXCEPTION 'Please enter each co-applicant name.' USING ERRCODE = '22023';
        END IF;
        IF nullif(btrim(coalesce(v_item->>'relationship', '')), '') IS NULL THEN
            RAISE EXCEPTION 'Please select the relationship for each co-applicant.' USING ERRCODE = '22023';
        END IF;
        v_item_mobile := regexp_replace(coalesce(v_item->>'mobile', ''), '[^0-9]', '', 'g');
        IF v_item_mobile <> '' AND v_item_mobile !~ '^[6-9][0-9]{9}$' THEN
            RAISE EXCEPTION 'Please enter a valid 10-digit mobile number for each co-applicant.' USING ERRCODE = '22023';
        END IF;
        v_item_email := nullif(btrim(coalesce(v_item->>'email', '')), '');
        IF v_item_email IS NOT NULL AND v_item_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
            RAISE EXCEPTION 'Please enter a valid email address for each co-applicant.' USING ERRCODE = '22023';
        END IF;

        INSERT INTO public.loan_applicants (
            loan_lead_id, role, applicant_type, full_name, relationship, date_of_birth,
            email, mobile, employment_type, employer_name, monthly_income, income_currency
        ) VALUES (
            v_id, 'co_applicant', 'resident',
            btrim(v_item->>'full_name'),
            nullif(btrim(coalesce(v_item->>'relationship', '')), ''),
            nullif(v_item->>'date_of_birth', '')::DATE,
            v_item_email,
            nullif(v_item_mobile, ''),
            nullif(btrim(coalesce(v_item->>'employment_type', '')), ''),
            nullif(btrim(coalesce(v_item->>'employer_name', '')), ''),
            nullif(v_item->>'monthly_income', '')::NUMERIC,
            'INR'
        );
    END LOOP;

    -- ---- Guarantors --------------------------------------------------------
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_guar) LOOP
        IF btrim(coalesce(v_item->>'full_name', '')) = '' THEN
            RAISE EXCEPTION 'Please enter each guarantor name.' USING ERRCODE = '22023';
        END IF;
        IF nullif(btrim(coalesce(v_item->>'relationship', '')), '') IS NULL THEN
            RAISE EXCEPTION 'Please select the relationship for each guarantor.' USING ERRCODE = '22023';
        END IF;
        v_item_mobile := regexp_replace(coalesce(v_item->>'mobile', ''), '[^0-9]', '', 'g');
        IF v_item_mobile <> '' AND v_item_mobile !~ '^[6-9][0-9]{9}$' THEN
            RAISE EXCEPTION 'Please enter a valid 10-digit mobile number for each guarantor.' USING ERRCODE = '22023';
        END IF;
        v_item_email := nullif(btrim(coalesce(v_item->>'email', '')), '');
        IF v_item_email IS NOT NULL AND v_item_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
            RAISE EXCEPTION 'Please enter a valid email address for each guarantor.' USING ERRCODE = '22023';
        END IF;

        INSERT INTO public.loan_applicants (
            loan_lead_id, role, applicant_type, full_name, relationship, date_of_birth,
            email, mobile, employment_type, employer_name, monthly_income, income_currency
        ) VALUES (
            v_id, 'guarantor', 'resident',
            btrim(v_item->>'full_name'),
            nullif(btrim(coalesce(v_item->>'relationship', '')), ''),
            nullif(v_item->>'date_of_birth', '')::DATE,
            v_item_email,
            nullif(v_item_mobile, ''),
            nullif(btrim(coalesce(v_item->>'employment_type', '')), ''),
            nullif(btrim(coalesce(v_item->>'employer_name', '')), ''),
            nullif(v_item->>'monthly_income', '')::NUMERIC,
            'INR'
        );
    END LOOP;

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
        'loan_type', 'Home Loan Takeover',
        'loan_amount', v_new_amount,
        'estimated_new_emi', v_new_emi,
        'estimated_emi_difference', v_emi_diff,
        'estimated_savings', v_savings,
        'applicant_type', 'resident'
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Extra document types for existing-loan applications
-- -----------------------------------------------------------------------------
-- The top-up and takeover checklists need sanction letters, loan statements,
-- outstanding certificates, repayment history and general income proof. The
-- original list in 001 did not include these, so widen the CHECK on
-- public.loan_documents.document_type and re-register register_document() with
-- the same allowed list (the body is otherwise identical to migration 002).

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
        'Repayment History', 'Income Proof'
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
        'Repayment History', 'Income Proof'
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

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================

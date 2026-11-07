-- =============================================================================
-- NHOST / HASURA MIGRATION: 004_home_loan_application.sql
-- PROJECT: Dhanvi Finserv
--
-- Run this once in the Nhost dashboard:
--   Database -> SQL Editor -> paste -> Run
--
-- It adds the structured Home Loan application system behind
-- home-loan-apply.html:
--
--   1. public.home_loan_details   - one structured row per Home Loan lead
--      (personal, employment, address, property and loan requirement data).
--   2. public.home_loan_emis      - the applicant's existing EMI obligations.
--   3. public.home_loan_drafts    - server-side save/resume drafts.
--
--   4. save_home_loan_draft()          - create/update a resumable draft.
--   5. get_home_loan_draft()           - load a draft by its secret token.
--   6. submit_home_loan_application()  - validate and create the real
--      application (loan_leads + home_loan_details + home_loan_emis +
--      loan_applicants) and consume the draft.
--
-- IMPORTANT
--   * Hasura permissions are the access-control layer, NOT Postgres RLS.
--   * Do not enable RLS on these tables.
--   * Every function returns SETOF public.api_result so Hasura can track it.
--   * Other loan types are untouched: they keep using submit_loan_application_v2.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Structured Home Loan details (1:1 with loan_leads)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.home_loan_details (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_lead_id UUID NOT NULL UNIQUE REFERENCES public.loan_leads(id) ON DELETE CASCADE,

    -- Personal details ------------------------------------------------------
    first_name TEXT NOT NULL,
    middle_name TEXT,
    last_name TEXT NOT NULL,
    date_of_birth DATE NOT NULL,
    gender TEXT,
    marital_status TEXT,
    pan_number TEXT NOT NULL,
    aadhaar_masked TEXT,
    pan_verified BOOLEAN NOT NULL DEFAULT false,

    -- Identity verification (administrator driven) -------------------------
    identity_verification_status TEXT NOT NULL DEFAULT 'Pending'
        CHECK (identity_verification_status IN ('Pending', 'Verified', 'Rejected')),
    identity_verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    identity_verified_at TIMESTAMPTZ,
    identity_notes TEXT,

    -- Employment ------------------------------------------------------------
    employment_type TEXT NOT NULL
        CHECK (employment_type IN ('Salaried', 'Self-employed')),
    employer_name TEXT,
    business_name TEXT,
    designation TEXT,
    monthly_income NUMERIC NOT NULL CHECK (monthly_income > 0),
    annual_income NUMERIC CHECK (annual_income IS NULL OR annual_income > 0),
    work_experience_years NUMERIC CHECK (work_experience_years IS NULL OR work_experience_years >= 0),
    business_vintage_years NUMERIC CHECK (business_vintage_years IS NULL OR business_vintage_years >= 0),

    -- Current address -------------------------------------------------------
    current_address_line TEXT,
    current_address_city TEXT,
    current_address_state TEXT,
    current_address_pincode TEXT,

    -- Permanent address -----------------------------------------------------
    same_as_current BOOLEAN NOT NULL DEFAULT false,
    permanent_address_line TEXT,
    permanent_address_city TEXT,
    permanent_address_state TEXT,
    permanent_address_pincode TEXT,

    -- Property --------------------------------------------------------------
    property_purpose TEXT NOT NULL
        CHECK (property_purpose IN ('Purchase', 'Construction', 'Resale', 'Plot + Construction')),
    property_address TEXT,
    property_city TEXT,
    property_state TEXT,
    property_pincode TEXT,
    property_type TEXT,
    builder_seller_name TEXT,
    property_value NUMERIC CHECK (property_value IS NULL OR property_value >= 0),
    agreement_value NUMERIC CHECK (agreement_value IS NULL OR agreement_value >= 0),
    ownership_type TEXT,

    -- Loan requirement ------------------------------------------------------
    required_loan_amount NUMERIC NOT NULL CHECK (required_loan_amount >= 10000),
    down_payment NUMERIC CHECK (down_payment IS NULL OR down_payment >= 0),
    tenure_months INTEGER CHECK (tenure_months IS NULL OR (tenure_months >= 12 AND tenure_months <= 360)),
    preferred_emi NUMERIC CHECK (preferred_emi IS NULL OR preferred_emi >= 0),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS home_loan_details_lead_idx
    ON public.home_loan_details (loan_lead_id);
CREATE INDEX IF NOT EXISTS home_loan_details_identity_idx
    ON public.home_loan_details (identity_verification_status);

-- -----------------------------------------------------------------------------
-- 2. Existing EMI obligations
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.home_loan_emis (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_lead_id UUID NOT NULL REFERENCES public.loan_leads(id) ON DELETE CASCADE,
    bank_name TEXT NOT NULL,
    loan_type TEXT,
    outstanding_amount NUMERIC CHECK (outstanding_amount IS NULL OR outstanding_amount >= 0),
    monthly_emi NUMERIC CHECK (monthly_emi IS NULL OR monthly_emi >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS home_loan_emis_lead_idx
    ON public.home_loan_emis (loan_lead_id);

-- -----------------------------------------------------------------------------
-- 3. Server-side drafts (save / resume)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.home_loan_drafts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    draft_token UUID NOT NULL DEFAULT gen_random_uuid(),
    reference TEXT NOT NULL DEFAULT public.next_reference('DFD'),
    full_name TEXT,
    mobile TEXT,
    email TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::JSONB,
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'submitted', 'expired')),
    submitted_lead_id UUID REFERENCES public.loan_leads(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS home_loan_drafts_token_key
    ON public.home_loan_drafts (draft_token);
CREATE UNIQUE INDEX IF NOT EXISTS home_loan_drafts_reference_key
    ON public.home_loan_drafts (reference);
CREATE INDEX IF NOT EXISTS home_loan_drafts_updated_at_idx
    ON public.home_loan_drafts (updated_at DESC);

-- -----------------------------------------------------------------------------
-- 4. updated_at triggers
-- -----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS update_home_loan_details_modtime ON public.home_loan_details;
CREATE TRIGGER update_home_loan_details_modtime
    BEFORE UPDATE ON public.home_loan_details
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

DROP TRIGGER IF EXISTS update_home_loan_drafts_modtime ON public.home_loan_drafts;
CREATE TRIGGER update_home_loan_drafts_modtime
    BEFORE UPDATE ON public.home_loan_drafts
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 5. save_home_loan_draft - create or update a resumable draft
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.save_home_loan_draft(
    p_draft_id UUID,
    p_draft_token UUID,
    p_payload JSONB
)
RETURNS SETOF public.api_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id UUID;
    v_token UUID;
    v_full_name TEXT;
    v_mobile TEXT;
    v_email TEXT;
    v_personal JSONB;
BEGIN
    IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'The draft could not be saved. Please try again.' USING ERRCODE = '22023';
    END IF;
    IF length(p_payload::text) > 200000 THEN
        RAISE EXCEPTION 'This draft is too large to save.' USING ERRCODE = '22023';
    END IF;

    v_personal := coalesce(p_payload->'personal', '{}'::JSONB);
    v_full_name := nullif(btrim(concat_ws(' ',
        nullif(btrim(coalesce(v_personal->>'first_name', '')), ''),
        nullif(btrim(coalesce(v_personal->>'middle_name', '')), ''),
        nullif(btrim(coalesce(v_personal->>'last_name', '')), '')
    )), '');
    v_mobile := nullif(regexp_replace(coalesce(v_personal->>'mobile', ''), '[^0-9]', '', 'g'), '');
    v_email := nullif(lower(btrim(coalesce(v_personal->>'email', ''))), '');

    IF p_draft_id IS NULL THEN
        INSERT INTO public.home_loan_drafts (payload, full_name, mobile, email)
        VALUES (p_payload, v_full_name, v_mobile, v_email)
        RETURNING id, draft_token INTO v_id, v_token;
    ELSE
        IF p_draft_token IS NULL THEN
            RAISE EXCEPTION 'This draft link is invalid or has expired.' USING ERRCODE = '28000';
        END IF;

        UPDATE public.home_loan_drafts
        SET payload = p_payload,
            full_name = v_full_name,
            mobile = v_mobile,
            email = v_email
        WHERE id = p_draft_id
          AND draft_token = p_draft_token
          AND status = 'draft'
        RETURNING id, draft_token INTO v_id, v_token;

        IF v_id IS NULL THEN
            RAISE EXCEPTION 'This draft link is invalid or has expired.' USING ERRCODE = '28000';
        END IF;
    END IF;

    RETURN QUERY SELECT gen_random_uuid(), jsonb_build_object(
        'draft_id', v_id,
        'draft_token', v_token,
        'full_name', v_full_name
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 6. get_home_loan_draft - load a draft by its secret token
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_home_loan_draft(
    p_draft_id UUID,
    p_draft_token UUID
)
RETURNS SETOF public.api_result
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.home_loan_drafts%ROWTYPE;
BEGIN
    IF p_draft_id IS NULL OR p_draft_token IS NULL THEN
        RAISE EXCEPTION 'This draft link is invalid or has expired.' USING ERRCODE = '28000';
    END IF;

    SELECT * INTO v_row
    FROM public.home_loan_drafts
    WHERE id = p_draft_id
      AND draft_token = p_draft_token
      AND status = 'draft';

    IF v_row.id IS NULL THEN
        RAISE EXCEPTION 'This draft link is invalid or has expired.' USING ERRCODE = '28000';
    END IF;

    RETURN QUERY SELECT gen_random_uuid(), jsonb_build_object(
        'draft_id', v_row.id,
        'draft_token', v_row.draft_token,
        'reference', v_row.reference,
        'payload', v_row.payload,
        'updated_at', v_row.updated_at
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 7. submit_home_loan_application
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_home_loan_application(
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
    v_address JSONB := coalesce(p_payload->'address', '{}'::JSONB);
    v_current JSONB;
    v_permanent JSONB;
    v_property JSONB := coalesce(p_payload->'property', '{}'::JSONB);
    v_loan JSONB := coalesce(p_payload->'loan', '{}'::JSONB);
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

    v_same BOOLEAN := coalesce((v_address->>'same_as_current')::BOOLEAN, false);
    v_cur_line TEXT;
    v_cur_city TEXT;
    v_cur_state TEXT;
    v_cur_pin TEXT;
    v_per_line TEXT;
    v_per_city TEXT;
    v_per_state TEXT;
    v_per_pin TEXT;

    v_purpose TEXT := btrim(coalesce(v_property->>'purpose', ''));
    v_prop_type TEXT := nullif(btrim(coalesce(v_property->>'property_type', '')), '');
    v_builder TEXT := nullif(btrim(coalesce(v_property->>'builder_seller_name', '')), '');
    v_prop_value NUMERIC := nullif(v_property->>'property_value', '')::NUMERIC;
    v_agreement NUMERIC := nullif(v_property->>'agreement_value', '')::NUMERIC;
    v_ownership TEXT := nullif(btrim(coalesce(v_property->>'ownership_type', '')), '');

    v_required NUMERIC := nullif(v_loan->>'required_amount', '')::NUMERIC;
    v_down NUMERIC := nullif(v_loan->>'down_payment', '')::NUMERIC;
    v_tenure INTEGER := nullif(v_loan->>'tenure_months', '')::INTEGER;
    v_pref_emi NUMERIC := nullif(v_loan->>'preferred_emi', '')::NUMERIC;

    v_consent BOOLEAN := coalesce((p_payload->>'consent')::BOOLEAN, false);
    v_consent_version TEXT := coalesce(nullif(p_payload->>'consent_version', ''), '2026-10');
    v_source TEXT := nullif(btrim(coalesce(p_payload->>'source_page', '')), '');

    v_item_type TEXT;
    v_item_mobile TEXT;
    v_item_email TEXT;
    v_age INTEGER;
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

    -- ---- Property ----------------------------------------------------------
    IF v_purpose NOT IN ('Purchase', 'Construction', 'Resale', 'Plot + Construction') THEN
        RAISE EXCEPTION 'Please select a valid property purpose.' USING ERRCODE = '22023';
    END IF;
    IF v_prop_value IS NULL OR v_prop_value <= 0 THEN
        RAISE EXCEPTION 'Please enter the property value.' USING ERRCODE = '22023';
    END IF;
    IF v_agreement IS NOT NULL AND v_agreement < 0 THEN
        RAISE EXCEPTION 'Please enter a valid agreement value.' USING ERRCODE = '22023';
    END IF;

    -- ---- Loan requirement --------------------------------------------------
    IF v_required IS NULL OR v_required < 100000 THEN
        RAISE EXCEPTION 'Please enter a required loan amount of at least ₹1,00,000.' USING ERRCODE = '22023';
    END IF;
    IF v_required > v_prop_value THEN
        RAISE EXCEPTION 'The required loan amount cannot be more than the property value.' USING ERRCODE = '22023';
    END IF;
    IF v_down IS NULL OR v_down < 0 THEN
        v_down := greatest(v_prop_value - v_required, 0);
    END IF;
    IF v_tenure IS NULL OR v_tenure < 12 OR v_tenure > 360 THEN
        RAISE EXCEPTION 'Please choose a tenure between 1 and 30 years.' USING ERRCODE = '22023';
    END IF;

    -- ---- Consent -----------------------------------------------------------
    IF NOT v_consent THEN
        RAISE EXCEPTION 'Please accept the privacy notice before submitting.' USING ERRCODE = '22023';
    END IF;

    -- ---- Child collection shapes ------------------------------------------
    IF jsonb_typeof(v_emis) <> 'array' THEN
        RAISE EXCEPTION 'Existing EMIs must be submitted as a list.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(v_emis) > 10 THEN
        RAISE EXCEPTION 'A maximum of 10 existing EMIs is allowed.' USING ERRCODE = '22023';
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

    -- ---- Create the lead ---------------------------------------------------
    INSERT INTO public.loan_leads (
        full_name, mobile, email, loan_type, loan_amount, message,
        applicant_type, employment_type, consent_given, consent_at,
        consent_version, source_page
    ) VALUES (
        v_full_name, v_mobile, v_email, 'Home Loan', v_required,
        btrim(concat_ws(' · ',
            'Property: ' || v_purpose,
            'Property value: ₹' || to_char(v_prop_value, 'FM999999999990'),
            'Down payment: ₹' || to_char(coalesce(v_down, 0), 'FM999999999990'),
            'Tenure: ' || v_tenure || ' months'
        )),
        'resident', v_employment_type, true, now(), v_consent_version, v_source
    )
    RETURNING id, reference_no, access_token INTO v_id, v_ref, v_token;

    -- ---- Structured Home Loan details --------------------------------------
    INSERT INTO public.home_loan_details (
        loan_lead_id, first_name, middle_name, last_name, date_of_birth,
        gender, marital_status, pan_number, aadhaar_masked,
        employment_type, employer_name, business_name, designation,
        monthly_income, annual_income, work_experience_years, business_vintage_years,
        current_address_line, current_address_city, current_address_state, current_address_pincode,
        same_as_current,
        permanent_address_line, permanent_address_city, permanent_address_state, permanent_address_pincode,
        property_purpose, property_address, property_city, property_state, property_pincode,
        property_type, builder_seller_name, property_value, agreement_value, ownership_type,
        required_loan_amount, down_payment, tenure_months, preferred_emi
    ) VALUES (
        v_id, v_first, v_middle, v_last, v_dob,
        v_gender, v_marital, v_pan, v_aadhaar_masked,
        v_employment_type,
        CASE WHEN v_employment_type = 'Salaried' THEN v_employer ELSE NULL END,
        CASE WHEN v_employment_type = 'Self-employed' THEN v_business ELSE NULL END,
        v_designation,
        v_monthly, v_annual, v_exp, v_vintage,
        v_cur_line, v_cur_city, v_cur_state, v_cur_pin,
        v_same,
        v_per_line, v_per_city, v_per_state, v_per_pin,
        v_purpose,
        nullif(btrim(coalesce(v_property->>'address', '')), ''),
        nullif(btrim(coalesce(v_property->>'city', '')), ''),
        nullif(btrim(coalesce(v_property->>'state', '')), ''),
        nullif(btrim(coalesce(v_property->>'pincode', '')), ''),
        v_prop_type, v_builder, v_prop_value, v_agreement, v_ownership,
        v_required, v_down, v_tenure, v_pref_emi
    );

    -- ---- Existing EMIs -----------------------------------------------------
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
        'loan_type', 'Home Loan',
        'loan_amount', v_required,
        'applicant_type', 'resident'
    );
END;
$$;

COMMIT;

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================

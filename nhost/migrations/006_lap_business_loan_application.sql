-- =============================================================================
-- NHOST / HASURA MIGRATION: 006_lap_business_loan_application.sql
-- PROJECT: Dhanvi Finserv
--
-- Run this ONCE, after 005, in the Nhost dashboard:
--   Database -> SQL Editor -> paste -> Run
--
-- It adds the structured application systems behind
-- loan-against-property-apply.html and business-loan-apply.html:
--
--   1. public.lap_details              - collateral property + income + LAP need
--   2. public.business_loan_details    - business entity + financials + need
--
--   3. submit_lap_application()            - validate and create a Loan Against
--      Property application (loan_leads + lap_details + home_loan_emis +
--      loan_applicants) and consume the draft.
--   4. submit_business_loan_application()  - validate and create a Business Loan
--      application (loan_leads + business_loan_details + home_loan_emis +
--      loan_applicants) and consume the draft.
--   5. Extra document types ("Title Chain", "Property Tax Receipt",
--      "Approved Plans", "GST Returns", "Financial Statements",
--      "Udyam Certificate") added to public.loan_documents.document_type and
--      to register_document().
--
-- DRAFT STORAGE
--   Save / resume is shared with the Home Loan wizard: both new pages call the
--   existing save_home_loan_draft() / get_home_loan_draft() against
--   public.home_loan_drafts. The draft payload is opaque JSONB, so no new draft
--   table or draft function is required.
--
-- SHARED CHILD TABLES
--   Existing / other running loans are stored in public.home_loan_emis (free
--   text loan_type) and co-applicants / guarantors in public.loan_applicants,
--   exactly like migrations 004 and 005. No new child tables are needed.
--
-- IMPORTANT
--   * Hasura permissions are the access-control layer, NOT Postgres RLS.
--   * Do not enable RLS on these tables.
--   * Every function returns SETOF public.api_result so Hasura can track it.
--   * Other loan types are untouched: they keep using submit_loan_application_v2.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Loan Against Property details (1:1 with loan_leads)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.lap_details (
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

    -- Business financials (self-employed only)
    business_constitution TEXT
        CHECK (business_constitution IS NULL OR business_constitution IN
            ('Proprietorship', 'Partnership', 'LLP', 'Private Limited')),
    business_turnover NUMERIC CHECK (business_turnover IS NULL OR business_turnover >= 0),
    business_net_profit NUMERIC,
    itr_filed BOOLEAN,

    -- Collateral property
    property_category TEXT
        CHECK (property_category IS NULL OR property_category IN ('Residential', 'Commercial')),
    property_type TEXT,
    property_address TEXT,
    property_city TEXT,
    property_state TEXT,
    property_pincode TEXT,
    property_ownership_type TEXT,
    property_co_owners TEXT,
    property_usage TEXT,
    property_market_value NUMERIC CHECK (property_market_value IS NULL OR property_market_value >= 0),
    property_purchase_value NUMERIC CHECK (property_purchase_value IS NULL OR property_purchase_value >= 0),
    property_area_sqft NUMERIC CHECK (property_area_sqft IS NULL OR property_area_sqft > 0),
    property_age_years NUMERIC CHECK (property_age_years IS NULL OR property_age_years >= 0),

    -- Loan requirement
    required_amount NUMERIC NOT NULL CHECK (required_amount >= 100000),
    lap_purpose TEXT NOT NULL
        CHECK (lap_purpose IN ('Business', 'Working Capital', 'Education', 'Medical', 'Debt Consolidation', 'Personal')),
    preferred_tenure_months INTEGER
        CHECK (preferred_tenure_months IS NULL OR (preferred_tenure_months >= 12 AND preferred_tenure_months <= 360)),
    preferred_emi NUMERIC CHECK (preferred_emi IS NULL OR preferred_emi >= 0),

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
    estimated_emi NUMERIC CHECK (estimated_emi IS NULL OR estimated_emi >= 0),
    estimated_ltv NUMERIC CHECK (estimated_ltv IS NULL OR estimated_ltv >= 0),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lap_details_lead_idx
    ON public.lap_details (loan_lead_id);
CREATE INDEX IF NOT EXISTS lap_details_identity_idx
    ON public.lap_details (identity_verification_status);
CREATE INDEX IF NOT EXISTS lap_details_property_category_idx
    ON public.lap_details (property_category);

CREATE TRIGGER update_lap_details_modtime
    BEFORE UPDATE ON public.lap_details
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. Business Loan details (1:1 with loan_leads)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.business_loan_details (
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
    applicant_role TEXT
        CHECK (applicant_role IS NULL OR applicant_role IN
            ('Proprietor', 'Partner', 'Director', 'Authorised Signatory')),

    -- Identity verification (admin controlled)
    identity_verification_status TEXT NOT NULL DEFAULT 'Pending'
        CHECK (identity_verification_status IN ('Pending', 'Verified', 'Rejected')),
    identity_verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    identity_verified_at TIMESTAMPTZ,
    identity_notes TEXT,

    -- Business entity
    business_name TEXT NOT NULL,
    business_constitution TEXT NOT NULL
        CHECK (business_constitution IN ('Proprietorship', 'Partnership', 'LLP', 'Private Limited')),
    industry TEXT,
    nature_of_business TEXT,
    establishment_date DATE,
    partner_director_count INTEGER CHECK (partner_director_count IS NULL OR partner_director_count >= 0),
    business_ownership TEXT,

    -- Registrations
    gstin TEXT,
    business_pan TEXT,
    udyam_number TEXT,

    -- Registered / operating address
    registered_address_line TEXT,
    registered_address_city TEXT,
    registered_address_state TEXT,
    registered_address_pincode TEXT,
    operating_same_as_registered BOOLEAN NOT NULL DEFAULT true,
    operating_address_line TEXT,
    operating_address_city TEXT,
    operating_address_state TEXT,
    operating_address_pincode TEXT,

    -- Financials
    annual_turnover NUMERIC CHECK (annual_turnover IS NULL OR annual_turnover >= 0),
    monthly_sales NUMERIC CHECK (monthly_sales IS NULL OR monthly_sales >= 0),
    net_profit NUMERIC,
    existing_liabilities NUMERIC CHECK (existing_liabilities IS NULL OR existing_liabilities >= 0),

    -- Banking
    primary_bank_name TEXT,
    banking_years NUMERIC CHECK (banking_years IS NULL OR banking_years >= 0),
    avg_monthly_bank_balance NUMERIC CHECK (avg_monthly_bank_balance IS NULL OR avg_monthly_bank_balance >= 0),

    -- Loan requirement
    required_amount NUMERIC NOT NULL CHECK (required_amount >= 50000),
    loan_purpose TEXT NOT NULL
        CHECK (loan_purpose IN ('Working Capital', 'Business Expansion', 'Equipment Purchase',
            'Inventory', 'Marketing', 'Debt Consolidation', 'Other')),
    preferred_tenure_months INTEGER
        CHECK (preferred_tenure_months IS NULL OR (preferred_tenure_months >= 6 AND preferred_tenure_months <= 240)),
    preferred_emi NUMERIC CHECK (preferred_emi IS NULL OR preferred_emi >= 0),

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
    estimated_emi NUMERIC CHECK (estimated_emi IS NULL OR estimated_emi >= 0),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS business_loan_details_lead_idx
    ON public.business_loan_details (loan_lead_id);
CREATE INDEX IF NOT EXISTS business_loan_details_identity_idx
    ON public.business_loan_details (identity_verification_status);
CREATE INDEX IF NOT EXISTS business_loan_details_constitution_idx
    ON public.business_loan_details (business_constitution);
CREATE INDEX IF NOT EXISTS business_loan_details_gstin_idx
    ON public.business_loan_details (gstin);

CREATE TRIGGER update_business_loan_details_modtime
    BEFORE UPDATE ON public.business_loan_details
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. submit_lap_application
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_lap_application(
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
    v_business_finance JSONB := coalesce(p_payload->'business_finance', '{}'::JSONB);
    v_property JSONB := coalesce(p_payload->'property', '{}'::JSONB);
    v_requirement JSONB := coalesce(p_payload->'requirement', '{}'::JSONB);
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

    v_constitution TEXT := nullif(btrim(coalesce(v_business_finance->>'constitution', '')), '');
    v_turnover NUMERIC := nullif(v_business_finance->>'turnover', '')::NUMERIC;
    v_profit NUMERIC := nullif(v_business_finance->>'net_profit', '')::NUMERIC;
    v_itr_filed BOOLEAN := coalesce((v_business_finance->>'itr_filed')::BOOLEAN, false);

    v_prop_category TEXT := nullif(btrim(coalesce(v_property->>'category', '')), '');
    v_prop_type TEXT := nullif(btrim(coalesce(v_property->>'property_type', '')), '');
    v_prop_ownership TEXT := nullif(btrim(coalesce(v_property->>'ownership_type', '')), '');
    v_prop_co_owners TEXT := nullif(btrim(coalesce(v_property->>'co_owners', '')), '');
    v_prop_usage TEXT := nullif(btrim(coalesce(v_property->>'usage', '')), '');
    v_prop_value NUMERIC := nullif(v_property->>'market_value', '')::NUMERIC;
    v_prop_purchase NUMERIC := nullif(v_property->>'purchase_value', '')::NUMERIC;
    v_prop_area NUMERIC := nullif(v_property->>'area_sqft', '')::NUMERIC;
    v_prop_age NUMERIC := nullif(v_property->>'age_years', '')::NUMERIC;

    v_amount NUMERIC := nullif(v_requirement->>'amount', '')::NUMERIC;
    v_purpose TEXT := btrim(coalesce(v_requirement->>'purpose', ''));
    v_tenure INTEGER := nullif(v_requirement->>'tenure_months', '')::INTEGER;
    v_pref_emi NUMERIC := nullif(v_requirement->>'preferred_emi', '')::NUMERIC;

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
    v_emi NUMERIC;
    v_ltv NUMERIC;
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

    -- ---- Business financials (self-employed only) --------------------------
    IF v_employment_type = 'Self-employed' THEN
        IF v_constitution IS NOT NULL AND v_constitution NOT IN
            ('Proprietorship', 'Partnership', 'LLP', 'Private Limited') THEN
            RAISE EXCEPTION 'Please select a valid business constitution.' USING ERRCODE = '22023';
        END IF;
        IF v_turnover IS NOT NULL AND v_turnover < 0 THEN
            RAISE EXCEPTION 'Please enter a valid annual turnover.' USING ERRCODE = '22023';
        END IF;
    ELSE
        v_constitution := NULL;
        v_turnover := NULL;
        v_profit := NULL;
        v_itr_filed := NULL;
    END IF;

    -- ---- Collateral property ----------------------------------------------
    IF v_prop_category IS NOT NULL AND v_prop_category NOT IN ('Residential', 'Commercial') THEN
        RAISE EXCEPTION 'Please select whether the property is residential or commercial.' USING ERRCODE = '22023';
    END IF;
    IF v_prop_value IS NULL OR v_prop_value <= 0 THEN
        RAISE EXCEPTION 'Please enter the current market value of the property.' USING ERRCODE = '22023';
    END IF;
    IF v_prop_purchase IS NOT NULL AND v_prop_purchase < 0 THEN
        RAISE EXCEPTION 'Please enter a valid property purchase value.' USING ERRCODE = '22023';
    END IF;
    IF v_prop_area IS NOT NULL AND v_prop_area <= 0 THEN
        RAISE EXCEPTION 'Please enter a valid property area.' USING ERRCODE = '22023';
    END IF;
    IF v_prop_age IS NOT NULL AND v_prop_age < 0 THEN
        RAISE EXCEPTION 'Please enter a valid property age.' USING ERRCODE = '22023';
    END IF;

    -- ---- Requirement -------------------------------------------------------
    IF v_amount IS NULL OR v_amount < 100000 THEN
        RAISE EXCEPTION 'Please enter a LAP amount of at least ₹1,00,000.' USING ERRCODE = '22023';
    END IF;
    IF v_purpose NOT IN ('Business', 'Working Capital', 'Education', 'Medical', 'Debt Consolidation', 'Personal') THEN
        RAISE EXCEPTION 'Please select the purpose of the loan.' USING ERRCODE = '22023';
    END IF;
    IF v_tenure IS NOT NULL AND (v_tenure < 12 OR v_tenure > 360) THEN
        RAISE EXCEPTION 'The preferred tenure must be between 1 and 30 years.' USING ERRCODE = '22023';
    END IF;
    IF v_pref_emi IS NOT NULL AND v_pref_emi < 0 THEN
        RAISE EXCEPTION 'Please enter a valid preferred EMI.' USING ERRCODE = '22023';
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
        RAISE EXCEPTION 'Existing loans must be submitted as a list.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(v_emis) > 10 THEN
        RAISE EXCEPTION 'A maximum of 10 existing loans is allowed.' USING ERRCODE = '22023';
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
    v_calc_rate := 10.5 / 1200;
    v_calc_months := coalesce(v_tenure, 180);
    v_emi := round(v_amount * v_calc_rate * power(1 + v_calc_rate, v_calc_months)
        / (power(1 + v_calc_rate, v_calc_months) - 1), 2);
    IF v_prop_value > 0 THEN
        v_ltv := round((v_amount / v_prop_value) * 100, 2);
    END IF;

    -- ---- Create the lead ---------------------------------------------------
    INSERT INTO public.loan_leads (
        full_name, mobile, email, loan_type, loan_amount, message,
        applicant_type, employment_type, consent_given, consent_at,
        consent_version, source_page
    ) VALUES (
        v_full_name, v_mobile, v_email, 'Loan Against Property', v_amount,
        btrim(concat_ws(' · ',
            CASE WHEN v_prop_category IS NOT NULL THEN v_prop_category || ' property' ELSE 'Property' END || ': ₹'
                || to_char(v_prop_value, 'FM999999999990'),
            'Required: ₹' || to_char(v_amount, 'FM999999999990'),
            'Purpose: ' || v_purpose,
            'Tenure: ' || coalesce(v_tenure, 180) || ' months'
        )),
        'resident', v_employment_type, true, now(), v_consent_version, v_source
    )
    RETURNING id, reference_no, access_token INTO v_id, v_ref, v_token;

    -- ---- Structured LAP details --------------------------------------------
    INSERT INTO public.lap_details (
        loan_lead_id, first_name, middle_name, last_name, date_of_birth,
        gender, marital_status, pan_number, aadhaar_masked,
        employment_type, employer_name, business_name, designation,
        monthly_income, annual_income, work_experience_years, business_vintage_years,
        business_constitution, business_turnover, business_net_profit, itr_filed,
        property_category, property_type, property_address, property_city,
        property_state, property_pincode, property_ownership_type,
        property_co_owners, property_usage, property_market_value,
        property_purchase_value, property_area_sqft, property_age_years,
        required_amount, lap_purpose, preferred_tenure_months, preferred_emi,
        current_address_line, current_address_city, current_address_state, current_address_pincode,
        same_as_current,
        permanent_address_line, permanent_address_city, permanent_address_state, permanent_address_pincode,
        estimated_emi, estimated_ltv
    ) VALUES (
        v_id, v_first, v_middle, v_last, v_dob,
        v_gender, v_marital, v_pan, v_aadhaar_masked,
        v_employment_type,
        CASE WHEN v_employment_type = 'Salaried' THEN v_employer ELSE NULL END,
        CASE WHEN v_employment_type = 'Self-employed' THEN v_business ELSE NULL END,
        v_designation,
        v_monthly, v_annual, v_exp, v_vintage,
        v_constitution, v_turnover, v_profit, v_itr_filed,
        v_prop_category, v_prop_type,
        nullif(btrim(coalesce(v_property->>'address', '')), ''),
        nullif(btrim(coalesce(v_property->>'city', '')), ''),
        nullif(btrim(coalesce(v_property->>'state', '')), ''),
        nullif(btrim(coalesce(v_property->>'pincode', '')), ''),
        v_prop_ownership, v_prop_co_owners, v_prop_usage, v_prop_value,
        v_prop_purchase, v_prop_area, v_prop_age,
        v_amount, v_purpose, v_tenure, v_pref_emi,
        v_cur_line, v_cur_city, v_cur_state, v_cur_pin,
        v_same,
        v_per_line, v_per_city, v_per_state, v_per_pin,
        v_emi, v_ltv
    );

    -- ---- Existing / other running loans ------------------------------------
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
        'loan_type', 'Loan Against Property',
        'loan_amount', v_amount,
        'estimated_emi', v_emi,
        'estimated_ltv', v_ltv,
        'applicant_type', 'resident'
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. submit_business_loan_application
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_business_loan_application(
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
    v_business JSONB := coalesce(p_payload->'business', '{}'::JSONB);
    v_registered JSONB := coalesce(p_payload->'registered_address', '{}'::JSONB);
    v_operating JSONB := coalesce(p_payload->'operating_address', '{}'::JSONB);
    v_finance JSONB := coalesce(p_payload->'finance', '{}'::JSONB);
    v_banking JSONB := coalesce(p_payload->'banking', '{}'::JSONB);
    v_requirement JSONB := coalesce(p_payload->'requirement', '{}'::JSONB);
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
    v_role TEXT := nullif(btrim(coalesce(v_personal->>'applicant_role', '')), '');

    v_biz_name TEXT := nullif(btrim(coalesce(v_business->>'name', '')), '');
    v_constitution TEXT := btrim(coalesce(v_business->>'constitution', ''));
    v_industry TEXT := nullif(btrim(coalesce(v_business->>'industry', '')), '');
    v_nature TEXT := nullif(btrim(coalesce(v_business->>'nature_of_business', '')), '');
    v_established DATE := nullif(v_business->>'establishment_date', '')::DATE;
    v_partners INTEGER := nullif(v_business->>'partner_director_count', '')::INTEGER;
    v_ownership TEXT := nullif(btrim(coalesce(v_business->>'ownership', '')), '');
    v_gstin TEXT := upper(nullif(btrim(coalesce(v_business->>'gstin', '')), ''));
    v_biz_pan TEXT := upper(nullif(btrim(coalesce(v_business->>'business_pan', '')), ''));
    v_udyam TEXT := nullif(btrim(coalesce(v_business->>'udyam_number', '')), '');

    v_reg_line TEXT := nullif(btrim(coalesce(v_registered->>'line', '')), '');
    v_reg_city TEXT := nullif(btrim(coalesce(v_registered->>'city', '')), '');
    v_reg_state TEXT := nullif(btrim(coalesce(v_registered->>'state', '')), '');
    v_reg_pin TEXT := nullif(btrim(coalesce(v_registered->>'pincode', '')), '');
    v_op_same BOOLEAN := coalesce((v_business->>'operating_same_as_registered')::BOOLEAN, true);
    v_op_line TEXT;
    v_op_city TEXT;
    v_op_state TEXT;
    v_op_pin TEXT;

    v_turnover NUMERIC := nullif(v_finance->>'annual_turnover', '')::NUMERIC;
    v_monthly_sales NUMERIC := nullif(v_finance->>'monthly_sales', '')::NUMERIC;
    v_profit NUMERIC := nullif(v_finance->>'net_profit', '')::NUMERIC;
    v_liabilities NUMERIC := nullif(v_finance->>'existing_liabilities', '')::NUMERIC;

    v_bank TEXT := nullif(btrim(coalesce(v_banking->>'primary_bank_name', '')), '');
    v_banking_years NUMERIC := nullif(v_banking->>'banking_years', '')::NUMERIC;
    v_avg_balance NUMERIC := nullif(v_banking->>'avg_monthly_balance', '')::NUMERIC;

    v_amount NUMERIC := nullif(v_requirement->>'amount', '')::NUMERIC;
    v_purpose TEXT := btrim(coalesce(v_requirement->>'purpose', ''));
    v_tenure INTEGER := nullif(v_requirement->>'tenure_months', '')::INTEGER;
    v_pref_emi NUMERIC := nullif(v_requirement->>'preferred_emi', '')::NUMERIC;

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
    v_emi NUMERIC;
    v_calc_rate NUMERIC;
    v_calc_months INTEGER;
BEGIN
    -- ---- Payload shape -----------------------------------------------------
    IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'The application could not be submitted. Please try again.' USING ERRCODE = '22023';
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
    IF v_age > 75 THEN
        RAISE EXCEPTION 'The applicant age must be 75 years or below.' USING ERRCODE = '22023';
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

    IF v_role IS NOT NULL AND v_role NOT IN ('Proprietor', 'Partner', 'Director', 'Authorised Signatory') THEN
        RAISE EXCEPTION 'Please select your role in the business.' USING ERRCODE = '22023';
    END IF;

    -- ---- Business entity ---------------------------------------------------
    IF v_biz_name IS NULL THEN
        RAISE EXCEPTION 'Please enter your business name.' USING ERRCODE = '22023';
    END IF;
    IF v_constitution NOT IN ('Proprietorship', 'Partnership', 'LLP', 'Private Limited') THEN
        RAISE EXCEPTION 'Please select your business constitution.' USING ERRCODE = '22023';
    END IF;
    IF v_established IS NOT NULL AND v_established > (now() AT TIME ZONE 'Asia/Kolkata')::date THEN
        RAISE EXCEPTION 'The establishment date cannot be in the future.' USING ERRCODE = '22023';
    END IF;
    IF v_partners IS NOT NULL AND v_partners < 0 THEN
        RAISE EXCEPTION 'Please enter a valid number of partners or directors.' USING ERRCODE = '22023';
    END IF;
    IF v_gstin IS NOT NULL AND v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$' THEN
        RAISE EXCEPTION 'Please enter a valid 15-character GSTIN.' USING ERRCODE = '22023';
    END IF;
    IF v_biz_pan IS NOT NULL AND v_biz_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' THEN
        RAISE EXCEPTION 'Please enter a valid business PAN.' USING ERRCODE = '22023';
    END IF;

    -- Registered address
    IF v_reg_line IS NULL OR v_reg_city IS NULL OR v_reg_state IS NULL OR v_reg_pin IS NULL THEN
        RAISE EXCEPTION 'Please complete the registered business address.' USING ERRCODE = '22023';
    END IF;
    IF v_op_same THEN
        v_op_line := v_reg_line;
        v_op_city := v_reg_city;
        v_op_state := v_reg_state;
        v_op_pin := v_reg_pin;
    ELSE
        v_op_line := nullif(btrim(coalesce(v_operating->>'line', '')), '');
        v_op_city := nullif(btrim(coalesce(v_operating->>'city', '')), '');
        v_op_state := nullif(btrim(coalesce(v_operating->>'state', '')), '');
        v_op_pin := nullif(btrim(coalesce(v_operating->>'pincode', '')), '');
        IF v_op_line IS NULL OR v_op_city IS NULL OR v_op_state IS NULL OR v_op_pin IS NULL THEN
            RAISE EXCEPTION 'Please complete the operating business address.' USING ERRCODE = '22023';
        END IF;
    END IF;

    -- ---- Financials --------------------------------------------------------
    IF v_turnover IS NULL OR v_turnover <= 0 THEN
        RAISE EXCEPTION 'Please enter your annual business turnover.' USING ERRCODE = '22023';
    END IF;
    IF v_monthly_sales IS NOT NULL AND v_monthly_sales < 0 THEN
        RAISE EXCEPTION 'Please enter a valid monthly sales figure.' USING ERRCODE = '22023';
    END IF;
    IF v_liabilities IS NOT NULL AND v_liabilities < 0 THEN
        RAISE EXCEPTION 'Please enter a valid existing liabilities figure.' USING ERRCODE = '22023';
    END IF;
    IF v_banking_years IS NOT NULL AND v_banking_years < 0 THEN
        RAISE EXCEPTION 'Please enter a valid banking relationship duration.' USING ERRCODE = '22023';
    END IF;

    -- ---- Requirement -------------------------------------------------------
    IF v_amount IS NULL OR v_amount < 50000 THEN
        RAISE EXCEPTION 'Please enter a business loan amount of at least ₹50,000.' USING ERRCODE = '22023';
    END IF;
    IF v_purpose NOT IN ('Working Capital', 'Business Expansion', 'Equipment Purchase',
        'Inventory', 'Marketing', 'Debt Consolidation', 'Other') THEN
        RAISE EXCEPTION 'Please select the purpose of the loan.' USING ERRCODE = '22023';
    END IF;
    IF v_tenure IS NOT NULL AND (v_tenure < 6 OR v_tenure > 240) THEN
        RAISE EXCEPTION 'The preferred tenure must be between 6 months and 20 years.' USING ERRCODE = '22023';
    END IF;
    IF v_pref_emi IS NOT NULL AND v_pref_emi < 0 THEN
        RAISE EXCEPTION 'Please enter a valid preferred EMI.' USING ERRCODE = '22023';
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
        RAISE EXCEPTION 'Existing business loans must be submitted as a list.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(v_emis) > 10 THEN
        RAISE EXCEPTION 'A maximum of 10 existing business loans is allowed.' USING ERRCODE = '22023';
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
    v_calc_rate := 15.0 / 1200;
    v_calc_months := coalesce(v_tenure, 36);
    v_emi := round(v_amount * v_calc_rate * power(1 + v_calc_rate, v_calc_months)
        / (power(1 + v_calc_rate, v_calc_months) - 1), 2);

    -- ---- Create the lead ---------------------------------------------------
    INSERT INTO public.loan_leads (
        full_name, mobile, email, loan_type, loan_amount, message,
        applicant_type, employment_type, consent_given, consent_at,
        consent_version, source_page
    ) VALUES (
        v_full_name, v_mobile, v_email, 'Business Loan', v_amount,
        btrim(concat_ws(' · ',
            'Business: ' || v_biz_name || ' (' || v_constitution || ')',
            'Turnover: ₹' || to_char(v_turnover, 'FM999999999990'),
            'Required: ₹' || to_char(v_amount, 'FM999999999990'),
            'Purpose: ' || v_purpose,
            'Tenure: ' || coalesce(v_tenure, 36) || ' months'
        )),
        'resident', 'Self-employed', true, now(), v_consent_version, v_source
    )
    RETURNING id, reference_no, access_token INTO v_id, v_ref, v_token;

    -- ---- Structured business loan details ----------------------------------
    INSERT INTO public.business_loan_details (
        loan_lead_id, first_name, middle_name, last_name, date_of_birth,
        gender, marital_status, pan_number, aadhaar_masked, applicant_role,
        business_name, business_constitution, industry, nature_of_business,
        establishment_date, partner_director_count, business_ownership,
        gstin, business_pan, udyam_number,
        registered_address_line, registered_address_city, registered_address_state, registered_address_pincode,
        operating_same_as_registered,
        operating_address_line, operating_address_city, operating_address_state, operating_address_pincode,
        annual_turnover, monthly_sales, net_profit, existing_liabilities,
        primary_bank_name, banking_years, avg_monthly_bank_balance,
        required_amount, loan_purpose, preferred_tenure_months, preferred_emi,
        current_address_line, current_address_city, current_address_state, current_address_pincode,
        same_as_current,
        permanent_address_line, permanent_address_city, permanent_address_state, permanent_address_pincode,
        estimated_emi
    ) VALUES (
        v_id, v_first, v_middle, v_last, v_dob,
        v_gender, v_marital, v_pan, v_aadhaar_masked, v_role,
        v_biz_name, v_constitution, v_industry, v_nature,
        v_established, v_partners, v_ownership,
        v_gstin, v_biz_pan, v_udyam,
        v_reg_line, v_reg_city, v_reg_state, v_reg_pin,
        v_op_same,
        v_op_line, v_op_city, v_op_state, v_op_pin,
        v_turnover, v_monthly_sales, v_profit, v_liabilities,
        v_bank, v_banking_years, v_avg_balance,
        v_amount, v_purpose, v_tenure, v_pref_emi,
        v_cur_line, v_cur_city, v_cur_state, v_cur_pin,
        v_same,
        v_per_line, v_per_city, v_per_state, v_per_pin,
        v_emi
    );

    -- ---- Existing business loans / EMIs ------------------------------------
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
        'loan_type', 'Business Loan',
        'loan_amount', v_amount,
        'estimated_emi', v_emi,
        'applicant_type', 'resident'
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Extra document types for LAP and Business Loan applications
-- -----------------------------------------------------------------------------
-- The LAP checklist needs title-chain, property tax receipt and approved plan
-- documents; the Business Loan checklist needs GST returns, financial
-- statements and the Udyam certificate. The list in 001/005 did not include
-- these, so widen the CHECK on public.loan_documents.document_type and
-- re-register register_document() with the same allowed list.

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
        'GST Returns', 'Financial Statements', 'Udyam Certificate'
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
        'GST Returns', 'Financial Statements', 'Udyam Certificate'
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

-- =============================================================================
-- NHOST / HASURA MIGRATION: 007_working_capital_cc_od.sql
-- PROJECT: Dhanvi Finserv
--
-- Run this ONCE, after 006, in the Nhost dashboard:
--   Database -> SQL Editor -> paste -> Run
--
-- It adds the structured Cash Credit (CC) / Overdraft (OD) application system
-- behind working-capital-apply.html:
--
--   1. public.working_capital_details     - applicant, business, financials,
--      existing CC/OD position and the requested facility.
--   2. public.working_capital_facilities  - additional existing bank
--      facilities declared by the applicant (1:N with the lead).
--   3. submit_working_capital_application() - validate and create a Working
--      Capital application (loan_leads + working_capital_details +
--      working_capital_facilities + loan_applicants) and consume the draft.
--   4. Extra document types ("Stock Statement", "Debtors Statement",
--      "Creditors Statement") added to public.loan_documents.document_type
--      and to register_document().
--
-- DRAFT STORAGE
--   Save / resume is shared with the other application wizards: the page calls
--   the existing save_home_loan_draft() / get_home_loan_draft() against
--   public.home_loan_drafts. The draft payload is opaque JSONB, so no new draft
--   table or draft function is required.
--
-- SHARED CHILD TABLES
--   Co-applicants and guarantors are stored in public.loan_applicants, exactly
--   like migrations 004, 005 and 006. No duplicate applicant infrastructure.
--
-- IMPORTANT
--   * Hasura permissions are the access-control layer, NOT Postgres RLS.
--   * Do not enable RLS on these tables.
--   * Every function returns SETOF public.api_result so Hasura can track it.
--   * Other loan types are untouched: they keep using their own functions.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Working Capital (CC / OD) details (1:1 with loan_leads)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.working_capital_details (
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
        CHECK (business_constitution IN
            ('Proprietorship', 'Partnership', 'LLP', 'Private Limited',
             'Public Limited', 'HUF', 'Other')),
    industry TEXT,
    nature_of_business TEXT,
    establishment_date DATE,
    business_vintage_years NUMERIC
        CHECK (business_vintage_years IS NULL OR business_vintage_years >= 0),
    partner_director_count INTEGER
        CHECK (partner_director_count IS NULL OR partner_director_count >= 0),
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
    annual_profit NUMERIC,
    receivables NUMERIC CHECK (receivables IS NULL OR receivables >= 0),
    inventory NUMERIC CHECK (inventory IS NULL OR inventory >= 0),
    creditors NUMERIC CHECK (creditors IS NULL OR creditors >= 0),
    existing_liabilities NUMERIC CHECK (existing_liabilities IS NULL OR existing_liabilities >= 0),

    -- Banking relationship
    primary_bank_name TEXT,
    banking_years NUMERIC CHECK (banking_years IS NULL OR banking_years >= 0),
    avg_monthly_bank_balance NUMERIC
        CHECK (avg_monthly_bank_balance IS NULL OR avg_monthly_bank_balance >= 0),

    -- Existing CC / OD position
    existing_facility_type TEXT
        CHECK (existing_facility_type IS NULL OR existing_facility_type IN
            ('Cash Credit', 'Overdraft', 'Both', 'None')),
    existing_bank_name TEXT,
    existing_account_number_masked TEXT,
    existing_limit_amount NUMERIC
        CHECK (existing_limit_amount IS NULL OR existing_limit_amount >= 0),
    current_utilisation NUMERIC
        CHECK (current_utilisation IS NULL OR current_utilisation >= 0),
    existing_outstanding NUMERIC
        CHECK (existing_outstanding IS NULL OR existing_outstanding >= 0),

    -- Requested facility
    facility_request_type TEXT NOT NULL
        CHECK (facility_request_type IN
            ('New CC/OD Facility', 'Enhancement', 'Renewal', 'Takeover')),
    proposed_limit NUMERIC NOT NULL CHECK (proposed_limit >= 50000),
    business_purpose TEXT NOT NULL
        CHECK (business_purpose IN
            ('Working Capital Gap', 'Inventory', 'Receivables',
             'Business Expansion', 'Equipment', 'Other')),
    security_type TEXT
        CHECK (security_type IS NULL OR security_type IN
            ('Hypothecation of Stock & Debtors', 'Property Collateral',
             'FD / Security Deposit', 'Unsecured', 'Other')),
    security_details TEXT,
    collateral_value NUMERIC
        CHECK (collateral_value IS NULL OR collateral_value >= 0),
    preferred_tenure_months INTEGER
        CHECK (preferred_tenure_months IS NULL OR
            (preferred_tenure_months >= 6 AND preferred_tenure_months <= 60)),

    -- Indicative figure captured at submission (12% p.a. on full utilisation)
    estimated_monthly_interest NUMERIC
        CHECK (estimated_monthly_interest IS NULL OR estimated_monthly_interest >= 0),

    -- Personal addresses
    current_address_line TEXT,
    current_address_city TEXT,
    current_address_state TEXT,
    current_address_pincode TEXT,
    same_as_current BOOLEAN NOT NULL DEFAULT false,
    permanent_address_line TEXT,
    permanent_address_city TEXT,
    permanent_address_state TEXT,
    permanent_address_pincode TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS working_capital_details_lead_idx
    ON public.working_capital_details (loan_lead_id);
CREATE INDEX IF NOT EXISTS working_capital_details_identity_idx
    ON public.working_capital_details (identity_verification_status);
CREATE INDEX IF NOT EXISTS working_capital_details_constitution_idx
    ON public.working_capital_details (business_constitution);
CREATE INDEX IF NOT EXISTS working_capital_details_gstin_idx
    ON public.working_capital_details (gstin);
CREATE INDEX IF NOT EXISTS working_capital_details_request_idx
    ON public.working_capital_details (facility_request_type);

DROP TRIGGER IF EXISTS update_working_capital_details_modtime
    ON public.working_capital_details;
CREATE TRIGGER update_working_capital_details_modtime
    BEFORE UPDATE ON public.working_capital_details
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. Additional existing bank facilities (1:N with loan_leads)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.working_capital_facilities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_lead_id UUID NOT NULL REFERENCES public.loan_leads(id) ON DELETE CASCADE,

    bank_name TEXT NOT NULL,
    facility_type TEXT
        CHECK (facility_type IS NULL OR facility_type IN
            ('Cash Credit', 'Overdraft', 'WCDL', 'Term Loan', 'Other')),
    account_number_masked TEXT,
    sanctioned_limit NUMERIC
        CHECK (sanctioned_limit IS NULL OR sanctioned_limit >= 0),
    current_utilisation NUMERIC
        CHECK (current_utilisation IS NULL OR current_utilisation >= 0),
    outstanding_amount NUMERIC
        CHECK (outstanding_amount IS NULL OR outstanding_amount >= 0),
    interest_rate NUMERIC
        CHECK (interest_rate IS NULL OR (interest_rate >= 0 AND interest_rate <= 50)),
    renewal_date DATE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS working_capital_facilities_lead_idx
    ON public.working_capital_facilities (loan_lead_id);
CREATE INDEX IF NOT EXISTS working_capital_facilities_bank_idx
    ON public.working_capital_facilities (bank_name);

DROP TRIGGER IF EXISTS update_working_capital_facilities_modtime
    ON public.working_capital_facilities;
CREATE TRIGGER update_working_capital_facilities_modtime
    BEFORE UPDATE ON public.working_capital_facilities
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. submit_working_capital_application
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_working_capital_application(
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
    v_existing JSONB := coalesce(p_payload->'existing', '{}'::JSONB);
    v_requirement JSONB := coalesce(p_payload->'requirement', '{}'::JSONB);
    v_address JSONB := coalesce(p_payload->'address', '{}'::JSONB);
    v_current JSONB;
    v_permanent JSONB;
    v_facilities JSONB := coalesce(p_payload->'facilities', '[]'::JSONB);
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
    v_vintage NUMERIC := nullif(v_business->>'business_vintage_years', '')::NUMERIC;
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
    v_profit NUMERIC := nullif(v_finance->>'annual_profit', '')::NUMERIC;
    v_receivables NUMERIC := nullif(v_finance->>'receivables', '')::NUMERIC;
    v_inventory NUMERIC := nullif(v_finance->>'inventory', '')::NUMERIC;
    v_creditors NUMERIC := nullif(v_finance->>'creditors', '')::NUMERIC;
    v_liabilities NUMERIC := nullif(v_finance->>'existing_liabilities', '')::NUMERIC;

    v_bank TEXT := nullif(btrim(coalesce(v_banking->>'primary_bank_name', '')), '');
    v_banking_years NUMERIC := nullif(v_banking->>'banking_years', '')::NUMERIC;
    v_avg_balance NUMERIC := nullif(v_banking->>'avg_monthly_balance', '')::NUMERIC;

    v_existing_type TEXT := nullif(btrim(coalesce(v_existing->>'facility_type', '')), '');
    v_existing_bank TEXT := nullif(btrim(coalesce(v_existing->>'bank_name', '')), '');
    v_existing_account TEXT := nullif(btrim(coalesce(v_existing->>'account_number', '')), '');
    v_existing_account_masked TEXT;
    v_existing_limit NUMERIC := nullif(v_existing->>'limit_amount', '')::NUMERIC;
    v_existing_utilisation NUMERIC := nullif(v_existing->>'current_utilisation', '')::NUMERIC;
    v_existing_outstanding NUMERIC := nullif(v_existing->>'outstanding', '')::NUMERIC;

    v_request_type TEXT := btrim(coalesce(v_requirement->>'request_type', ''));
    v_proposed NUMERIC := nullif(v_requirement->>'proposed_limit', '')::NUMERIC;
    v_purpose TEXT := btrim(coalesce(v_requirement->>'purpose', ''));
    v_security_type TEXT := nullif(btrim(coalesce(v_requirement->>'security_type', '')), '');
    v_security_details TEXT := nullif(btrim(coalesce(v_requirement->>'security_details', '')), '');
    v_collateral_value NUMERIC := nullif(v_requirement->>'collateral_value', '')::NUMERIC;
    v_tenure INTEGER := nullif(v_requirement->>'preferred_tenure_months', '')::INTEGER;

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
    v_consent_version TEXT := coalesce(nullif(p_payload->>'consent_version', ''), '2026-11');
    v_source TEXT := nullif(btrim(coalesce(p_payload->>'source_page', '')), '');

    v_item_mobile TEXT;
    v_item_email TEXT;
    v_age INTEGER;

    -- Indicative calculation (12% p.a. on the full proposed limit)
    v_estimated_interest NUMERIC;
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

    IF v_role IS NOT NULL AND v_role NOT IN ('Proprietor', 'Partner', 'Director', 'Authorised Signatory') THEN
        RAISE EXCEPTION 'Please select your role in the business.' USING ERRCODE = '22023';
    END IF;

    -- ---- Business entity ---------------------------------------------------
    IF v_biz_name IS NULL THEN
        RAISE EXCEPTION 'Please enter your business name.' USING ERRCODE = '22023';
    END IF;
    IF v_constitution NOT IN ('Proprietorship', 'Partnership', 'LLP', 'Private Limited',
        'Public Limited', 'HUF', 'Other') THEN
        RAISE EXCEPTION 'Please select your business constitution.' USING ERRCODE = '22023';
    END IF;
    IF v_established IS NOT NULL AND v_established > (now() AT TIME ZONE 'Asia/Kolkata')::date THEN
        RAISE EXCEPTION 'The establishment date cannot be in the future.' USING ERRCODE = '22023';
    END IF;
    IF v_vintage IS NOT NULL AND v_vintage < 0 THEN
        RAISE EXCEPTION 'Please enter a valid business vintage.' USING ERRCODE = '22023';
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

    -- Registered / operating business address
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
    IF v_receivables IS NOT NULL AND v_receivables < 0 THEN
        RAISE EXCEPTION 'Please enter a valid receivables figure.' USING ERRCODE = '22023';
    END IF;
    IF v_inventory IS NOT NULL AND v_inventory < 0 THEN
        RAISE EXCEPTION 'Please enter a valid inventory figure.' USING ERRCODE = '22023';
    END IF;
    IF v_creditors IS NOT NULL AND v_creditors < 0 THEN
        RAISE EXCEPTION 'Please enter a valid creditors figure.' USING ERRCODE = '22023';
    END IF;
    IF v_liabilities IS NOT NULL AND v_liabilities < 0 THEN
        RAISE EXCEPTION 'Please enter a valid existing liabilities figure.' USING ERRCODE = '22023';
    END IF;
    IF v_banking_years IS NOT NULL AND v_banking_years < 0 THEN
        RAISE EXCEPTION 'Please enter a valid banking relationship duration.' USING ERRCODE = '22023';
    END IF;
    IF v_avg_balance IS NOT NULL AND v_avg_balance < 0 THEN
        RAISE EXCEPTION 'Please enter a valid average bank balance.' USING ERRCODE = '22023';
    END IF;

    -- ---- Existing CC / OD position ----------------------------------------
    IF v_existing_type IS NOT NULL AND v_existing_type NOT IN
        ('Cash Credit', 'Overdraft', 'Both', 'None') THEN
        RAISE EXCEPTION 'Please select the type of existing CC/OD facility.' USING ERRCODE = '22023';
    END IF;
    IF v_existing_type IS NOT NULL AND v_existing_type <> 'None' THEN
        IF v_existing_bank IS NULL THEN
            RAISE EXCEPTION 'Please enter the bank holding your existing CC/OD facility.' USING ERRCODE = '22023';
        END IF;
        IF v_existing_limit IS NULL OR v_existing_limit <= 0 THEN
            RAISE EXCEPTION 'Please enter the sanctioned limit of your existing CC/OD facility.' USING ERRCODE = '22023';
        END IF;
    END IF;
    IF v_existing_limit IS NOT NULL AND v_existing_limit < 0 THEN
        RAISE EXCEPTION 'Please enter a valid existing sanctioned limit.' USING ERRCODE = '22023';
    END IF;
    IF v_existing_utilisation IS NOT NULL AND v_existing_utilisation < 0 THEN
        RAISE EXCEPTION 'Please enter a valid current utilisation amount.' USING ERRCODE = '22023';
    END IF;
    IF v_existing_outstanding IS NOT NULL AND v_existing_outstanding < 0 THEN
        RAISE EXCEPTION 'Please enter a valid existing outstanding amount.' USING ERRCODE = '22023';
    END IF;
    v_existing_account_masked := CASE
        WHEN v_existing_account IS NOT NULL AND length(v_existing_account) > 4
            THEN repeat('X', greatest(length(v_existing_account) - 4, 0)) || right(v_existing_account, 4)
        WHEN v_existing_account IS NOT NULL THEN v_existing_account
        ELSE NULL END;

    -- ---- Requested facility ------------------------------------------------
    IF v_request_type NOT IN ('New CC/OD Facility', 'Enhancement', 'Renewal', 'Takeover') THEN
        RAISE EXCEPTION 'Please select the type of CC/OD request.' USING ERRCODE = '22023';
    END IF;
    IF v_proposed IS NULL OR v_proposed < 50000 THEN
        RAISE EXCEPTION 'Please enter a proposed CC/OD limit of at least Rs. 50,000.' USING ERRCODE = '22023';
    END IF;
    IF v_purpose NOT IN ('Working Capital Gap', 'Inventory', 'Receivables',
        'Business Expansion', 'Equipment', 'Other') THEN
        RAISE EXCEPTION 'Please select the business purpose for the facility.' USING ERRCODE = '22023';
    END IF;
    IF v_security_type IS NOT NULL AND v_security_type NOT IN
        ('Hypothecation of Stock & Debtors', 'Property Collateral',
         'FD / Security Deposit', 'Unsecured', 'Other') THEN
        RAISE EXCEPTION 'Please select a valid security type.' USING ERRCODE = '22023';
    END IF;
    IF v_security_type = 'Property Collateral'
        AND (v_collateral_value IS NULL OR v_collateral_value <= 0) THEN
        RAISE EXCEPTION 'Please enter the estimated collateral value.' USING ERRCODE = '22023';
    END IF;
    IF v_security_type IS NOT NULL AND v_security_type <> 'Unsecured'
        AND v_security_details IS NULL THEN
        RAISE EXCEPTION 'Please describe the security offered for the facility.' USING ERRCODE = '22023';
    END IF;
    IF v_collateral_value IS NOT NULL AND v_collateral_value < 0 THEN
        RAISE EXCEPTION 'Please enter a valid collateral value.' USING ERRCODE = '22023';
    END IF;
    IF v_tenure IS NOT NULL AND (v_tenure < 6 OR v_tenure > 60) THEN
        RAISE EXCEPTION 'The preferred tenure must be between 6 and 60 months.' USING ERRCODE = '22023';
    END IF;

    -- ---- Personal addresses ------------------------------------------------
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
    IF jsonb_typeof(v_facilities) <> 'array' THEN
        RAISE EXCEPTION 'Existing bank facilities must be submitted as a list.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(v_facilities) > 10 THEN
        RAISE EXCEPTION 'A maximum of 10 existing bank facilities is allowed.' USING ERRCODE = '22023';
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

    -- ---- Indicative figure -------------------------------------------------
    v_estimated_interest := round(v_proposed * 0.12 / 12, 2);

    -- ---- Create the lead ---------------------------------------------------
    INSERT INTO public.loan_leads (
        full_name, mobile, email, loan_type, loan_amount, message,
        applicant_type, employment_type, consent_given, consent_at,
        consent_version, source_page
    ) VALUES (
        v_full_name, v_mobile, v_email, 'Working Capital (CC/OD)', v_proposed,
        btrim(concat_ws(' | ',
            'Business: ' || v_biz_name || ' (' || v_constitution || ')',
            'Turnover: Rs. ' || to_char(v_turnover, 'FM999999999990'),
            'Request: ' || v_request_type,
            'Proposed limit: Rs. ' || to_char(v_proposed, 'FM999999999990'),
            'Purpose: ' || v_purpose
        )),
        'resident', 'Self-employed', true, now(), v_consent_version, v_source
    )
    RETURNING id, reference_no, access_token INTO v_id, v_ref, v_token;

    -- ---- Structured Working Capital details --------------------------------
    INSERT INTO public.working_capital_details (
        loan_lead_id, first_name, middle_name, last_name, date_of_birth,
        gender, marital_status, pan_number, aadhaar_masked, applicant_role,
        business_name, business_constitution, industry, nature_of_business,
        establishment_date, business_vintage_years, partner_director_count,
        business_ownership, gstin, business_pan, udyam_number,
        registered_address_line, registered_address_city, registered_address_state, registered_address_pincode,
        operating_same_as_registered,
        operating_address_line, operating_address_city, operating_address_state, operating_address_pincode,
        annual_turnover, monthly_sales, annual_profit, receivables, inventory,
        creditors, existing_liabilities,
        primary_bank_name, banking_years, avg_monthly_bank_balance,
        existing_facility_type, existing_bank_name, existing_account_number_masked,
        existing_limit_amount, current_utilisation, existing_outstanding,
        facility_request_type, proposed_limit, business_purpose,
        security_type, security_details, collateral_value, preferred_tenure_months,
        estimated_monthly_interest,
        current_address_line, current_address_city, current_address_state, current_address_pincode,
        same_as_current,
        permanent_address_line, permanent_address_city, permanent_address_state, permanent_address_pincode
    ) VALUES (
        v_id, v_first, v_middle, v_last, v_dob,
        v_gender, v_marital, v_pan, v_aadhaar_masked, v_role,
        v_biz_name, v_constitution, v_industry, v_nature,
        v_established, v_vintage, v_partners,
        v_ownership, v_gstin, v_biz_pan, v_udyam,
        v_reg_line, v_reg_city, v_reg_state, v_reg_pin,
        v_op_same,
        v_op_line, v_op_city, v_op_state, v_op_pin,
        v_turnover, v_monthly_sales, v_profit, v_receivables, v_inventory,
        v_creditors, v_liabilities,
        v_bank, v_banking_years, v_avg_balance,
        v_existing_type, v_existing_bank, v_existing_account_masked,
        v_existing_limit, v_existing_utilisation, v_existing_outstanding,
        v_request_type, v_proposed, v_purpose,
        v_security_type, v_security_details, v_collateral_value, v_tenure,
        v_estimated_interest,
        v_cur_line, v_cur_city, v_cur_state, v_cur_pin,
        v_same,
        v_per_line, v_per_city, v_per_state, v_per_pin
    );

    -- ---- Additional existing bank facilities -------------------------------
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_facilities) LOOP
        IF btrim(coalesce(v_item->>'bank_name', '')) = '' THEN
            RAISE EXCEPTION 'Please enter the bank name for each existing facility.' USING ERRCODE = '22023';
        END IF;
        IF nullif(v_item->>'sanctioned_limit', '') IS NOT NULL
            AND (v_item->>'sanctioned_limit')::NUMERIC < 0 THEN
            RAISE EXCEPTION 'Please enter a valid sanctioned limit for each facility.' USING ERRCODE = '22023';
        END IF;
        IF nullif(v_item->>'current_utilisation', '') IS NOT NULL
            AND (v_item->>'current_utilisation')::NUMERIC < 0 THEN
            RAISE EXCEPTION 'Please enter a valid utilisation amount for each facility.' USING ERRCODE = '22023';
        END IF;
        IF nullif(v_item->>'outstanding_amount', '') IS NOT NULL
            AND (v_item->>'outstanding_amount')::NUMERIC < 0 THEN
            RAISE EXCEPTION 'Please enter a valid outstanding amount for each facility.' USING ERRCODE = '22023';
        END IF;
        IF nullif(v_item->>'interest_rate', '') IS NOT NULL
            AND ((v_item->>'interest_rate')::NUMERIC < 0 OR (v_item->>'interest_rate')::NUMERIC > 50) THEN
            RAISE EXCEPTION 'Please enter a valid interest rate for each facility.' USING ERRCODE = '22023';
        END IF;

        INSERT INTO public.working_capital_facilities (
            loan_lead_id, bank_name, facility_type, account_number_masked,
            sanctioned_limit, current_utilisation, outstanding_amount,
            interest_rate, renewal_date
        ) VALUES (
            v_id,
            btrim(v_item->>'bank_name'),
            nullif(btrim(coalesce(v_item->>'facility_type', '')), ''),
            CASE WHEN length(btrim(coalesce(v_item->>'account_number', ''))) > 4
                THEN repeat('X', greatest(length(btrim(v_item->>'account_number')) - 4, 0))
                     || right(btrim(v_item->>'account_number'), 4)
                ELSE nullif(btrim(coalesce(v_item->>'account_number', '')), '') END,
            nullif(v_item->>'sanctioned_limit', '')::NUMERIC,
            nullif(v_item->>'current_utilisation', '')::NUMERIC,
            nullif(v_item->>'outstanding_amount', '')::NUMERIC,
            nullif(v_item->>'interest_rate', '')::NUMERIC,
            nullif(v_item->>'renewal_date', '')::DATE
        );
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
        'loan_type', 'Working Capital (CC/OD)',
        'loan_amount', v_proposed,
        'estimated_monthly_interest', v_estimated_interest,
        'applicant_type', 'resident'
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Extra document types for Working Capital applications
-- -----------------------------------------------------------------------------
-- The CC/OD checklist needs stock, debtors and creditors statements. The list
-- in 001/005/006 did not include these, so widen the CHECK on
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
        'Stock Statement', 'Debtors Statement', 'Creditors Statement'
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
        'Stock Statement', 'Debtors Statement', 'Creditors Statement'
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

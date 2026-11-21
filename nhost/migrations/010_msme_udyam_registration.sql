-- =============================================================================
-- NHOST / HASURA MIGRATION: 010_msme_udyam_registration.sql
-- PROJECT: Dhanvi Finserv
--
-- Run this ONCE, after 009, in the Nhost dashboard:
--   Database -> SQL Editor -> paste -> Run
--
-- It adds the structured MSME / Udyam & Gumasta assistance system behind
-- msme-apply.html:
--
--   1. public.msme_registration_details - applicant, PAN/Aadhaar reference,
--      applicant and business addresses, business name, constitution,
--      activity, NIC code, commencement, investment, turnover, employees,
--      existing Udyam / Shop & Establishment / business registration numbers,
--      the selected service and the administrator-controlled submission,
--      certificate and verification fields.
--   2. public.msme_promoters            - proprietor / partner / director /
--      designated partner details (1:N with the lead).
--   3. public.msme_registrations        - one row per registration requested
--      (Udyam, Udyam update, Gumasta / Shop & Establishment or business
--      registration), used for the admin submission and certificate tracking.
--   4. submit_msme_application()        - validate and create an MSME assistance
--      application (loan_leads + details + promoters + registration rows) and
--      consume the shared draft.
--   5. Extra document types (Shop & Establishment Certificate, Electricity
--      Bill, Supporting Document) added to public.loan_documents.document_type
--      and to register_document().
--   6. Re-asserts the widened loan_leads.loan_type and loan_amount constraints
--      so service applications can be stored without fake loan amounts.
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
--   * Other service types are untouched: they keep using their own functions.
--   * An MSME, Udyam or Gumasta registration is never marked as complete by
--     this migration or by the wizard. Submission status starts at
--     'Application Received' and only an administrator can move it to
--     'Approved & Verified' after the actual government portal action and the
--     certificate / acknowledgement is verified.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Allow service applications on the shared loan_leads table
-- -----------------------------------------------------------------------------
-- Migrations 008 and 009 already widened these constraints. This block is
-- idempotent so 010 can be run safely even if the earlier migrations were
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
-- 1. MSME / Udyam / Gumasta details (1:1 with loan_leads)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.msme_registration_details (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_lead_id UUID NOT NULL UNIQUE REFERENCES public.loan_leads(id) ON DELETE CASCADE,

    -- Applicant identity
    applicant_name TEXT NOT NULL,
    designation TEXT,
    mobile TEXT NOT NULL,
    email TEXT,
    pan_number TEXT NOT NULL,
    aadhaar_masked TEXT,
    aadhaar_verification_method TEXT
        CHECK (aadhaar_verification_method IS NULL OR aadhaar_verification_method IN (
            'Aadhaar authentication at Udyam portal',
            'PAN-based registration',
            'Not applicable / exempt',
            'Not sure - advise me')),

    -- Administrator-controlled identity verification
    identity_verification_status TEXT NOT NULL DEFAULT 'Pending'
        CHECK (identity_verification_status IN ('Pending', 'Verified', 'Rejected')),
    identity_verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    identity_verified_at TIMESTAMPTZ,
    identity_notes TEXT,

    -- Applicant address
    address_line TEXT NOT NULL,
    address_city TEXT NOT NULL,
    address_district TEXT,
    address_state TEXT NOT NULL,
    address_pincode TEXT NOT NULL,

    -- Business profile
    business_name TEXT NOT NULL,
    trade_name TEXT,
    constitution TEXT NOT NULL
        CHECK (constitution IN (
            'Proprietorship', 'Partnership', 'LLP', 'Private Limited Company',
            'Public Limited Company', 'One Person Company', 'HUF',
            'Trust / Society', 'Other')),
    enterprise_category TEXT
        CHECK (enterprise_category IS NULL OR enterprise_category IN (
            'Micro', 'Small', 'Medium', 'Not sure - assess')),
    business_activity TEXT NOT NULL,
    nic_code TEXT NOT NULL,
    nic_description TEXT,
    commencement_date DATE NOT NULL,
    employee_count INTEGER NOT NULL CHECK (employee_count >= 0),
    plant_machinery_investment NUMERIC NOT NULL
        CHECK (plant_machinery_investment >= 0),
    annual_turnover NUMERIC NOT NULL CHECK (annual_turnover >= 0),
    gstin TEXT,
    existing_registrations TEXT,

    -- Business / establishment address
    business_address_same_as_applicant BOOLEAN NOT NULL DEFAULT false,
    business_address_line TEXT,
    business_address_city TEXT,
    business_address_district TEXT,
    business_address_state TEXT,
    business_address_pincode TEXT,

    -- Service requirement
    service_type TEXT NOT NULL
        CHECK (service_type IN (
            'New Udyam Registration', 'Udyam Update / Amendment',
            'Gumasta / Shop & Establishment',
            'Business Registration Assistance',
            'Udyam & Gumasta Package')),
    existing_udyam_number TEXT,
    udyam_update_reason TEXT
        CHECK (udyam_update_reason IS NULL OR udyam_update_reason IN (
            'Change in business activity', 'Change in address',
            'Change in ownership / constitution',
            'Change in investment or turnover', 'Change in employee count',
            'Correction of details', 'Other')),
    udyam_update_details TEXT,

    -- Gumasta / Shop & Establishment requirement
    existing_shop_number TEXT,
    gumasta_establishment_type TEXT
        CHECK (gumasta_establishment_type IS NULL OR gumasta_establishment_type IN (
            'Shop', 'Commercial Establishment', 'Residential Hotel',
            'Restaurant / Eating House', 'Theatre', 'Other')),
    gumasta_premises_ownership TEXT
        CHECK (gumasta_premises_ownership IS NULL OR gumasta_premises_ownership IN (
            'Owned', 'Rented', 'Leased', 'Other')),
    gumasta_premises_landlord_name TEXT,
    gumasta_premises_landlord_mobile TEXT,

    -- Other business registration assistance
    business_registration_type TEXT
        CHECK (business_registration_type IS NULL OR business_registration_type IN (
            'Company', 'LLP', 'Partnership', 'Proprietorship',
            'Society / Trust', 'Other')),
    business_registration_state TEXT,
    business_registration_details TEXT,

    -- Administrator-controlled submission and certificate status. The public
    -- form can never set any of these fields.
    submission_status TEXT NOT NULL DEFAULT 'Application Received'
        CHECK (submission_status IN (
            'Application Received', 'Documents Pending', 'Under Review',
            'Submitted to Portal', 'Awaiting Government Approval',
            'Approved & Verified', 'Rejected', 'On Hold', 'Cancelled')),
    submission_status_notes TEXT,
    submitted_at DATE,
    submitted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    approved_at DATE,
    verified_at TIMESTAMPTZ,
    verification_method TEXT,
    certificate_number TEXT,
    portal_reference TEXT,
    registration_remarks TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS msme_registration_details_lead_idx
    ON public.msme_registration_details (loan_lead_id);
CREATE INDEX IF NOT EXISTS msme_registration_details_identity_idx
    ON public.msme_registration_details (identity_verification_status);
CREATE INDEX IF NOT EXISTS msme_registration_details_pan_idx
    ON public.msme_registration_details (pan_number);
CREATE INDEX IF NOT EXISTS msme_registration_details_service_idx
    ON public.msme_registration_details (service_type);
CREATE INDEX IF NOT EXISTS msme_registration_details_status_idx
    ON public.msme_registration_details (submission_status);
CREATE INDEX IF NOT EXISTS msme_registration_details_udyam_idx
    ON public.msme_registration_details (existing_udyam_number);
CREATE INDEX IF NOT EXISTS msme_registration_details_state_idx
    ON public.msme_registration_details (address_state);

DROP TRIGGER IF EXISTS update_msme_registration_details_modtime
    ON public.msme_registration_details;
CREATE TRIGGER update_msme_registration_details_modtime
    BEFORE UPDATE ON public.msme_registration_details
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. Proprietor / partner / director details (1:N with loan_leads)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.msme_promoters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_lead_id UUID NOT NULL REFERENCES public.loan_leads(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL CHECK (sort_order >= 1),
    full_name TEXT NOT NULL,
    designation TEXT NOT NULL
        CHECK (designation IN (
            'Proprietor', 'Partner', 'Designated Partner', 'Director',
            'Karta', 'Trustee', 'Authorised Signatory', 'Other')),
    pan_number TEXT,
    aadhaar_masked TEXT,
    din TEXT,
    mobile TEXT,
    email TEXT,
    shareholding_percent NUMERIC
        CHECK (shareholding_percent IS NULL OR
               (shareholding_percent >= 0 AND shareholding_percent <= 100)),
    is_primary BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (loan_lead_id, sort_order)
);

CREATE INDEX IF NOT EXISTS msme_promoters_lead_idx
    ON public.msme_promoters (loan_lead_id);
CREATE INDEX IF NOT EXISTS msme_promoters_name_idx
    ON public.msme_promoters (full_name);
CREATE INDEX IF NOT EXISTS msme_promoters_pan_idx
    ON public.msme_promoters (pan_number);

DROP TRIGGER IF EXISTS update_msme_promoters_modtime
    ON public.msme_promoters;
CREATE TRIGGER update_msme_promoters_modtime
    BEFORE UPDATE ON public.msme_promoters
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. Registration rows requested by the application (1:N with loan_leads)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.msme_registrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_lead_id UUID NOT NULL REFERENCES public.loan_leads(id) ON DELETE CASCADE,
    registration_type TEXT NOT NULL
        CHECK (registration_type IN (
            'Udyam Registration', 'Udyam Update',
            'Gumasta / Shop & Establishment', 'Business Registration', 'Other')),
    application_number TEXT,
    status TEXT NOT NULL DEFAULT 'Application Received'
        CHECK (status IN (
            'Application Received', 'Documents Pending', 'Under Review',
            'Submitted to Portal', 'Awaiting Government Approval',
            'Approved & Verified', 'Rejected', 'On Hold', 'Cancelled')),
    submitted_at DATE,
    approved_at DATE,
    certificate_number TEXT,
    valid_until DATE,
    portal_reference TEXT,
    remarks TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS msme_registrations_lead_idx
    ON public.msme_registrations (loan_lead_id);
CREATE INDEX IF NOT EXISTS msme_registrations_type_idx
    ON public.msme_registrations (registration_type);
CREATE INDEX IF NOT EXISTS msme_registrations_status_idx
    ON public.msme_registrations (status);

DROP TRIGGER IF EXISTS update_msme_registrations_modtime
    ON public.msme_registrations;
CREATE TRIGGER update_msme_registrations_modtime
    BEFORE UPDATE ON public.msme_registrations
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 4. Submit an MSME / Udyam / Gumasta application
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_msme_application(
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
    v_address JSONB := coalesce(p_payload->'address', '{}'::JSONB);
    v_business JSONB := coalesce(p_payload->'business', '{}'::JSONB);
    v_service JSONB := coalesce(p_payload->'service', '{}'::JSONB);
    v_promoters JSONB := coalesce(p_payload->'promoters', '[]'::JSONB);
    v_declarations JSONB := coalesce(p_payload->'declarations', '{}'::JSONB);

    v_name TEXT := btrim(coalesce(v_personal->>'applicant_name', ''));
    v_designation TEXT := nullif(btrim(coalesce(v_personal->>'designation', '')), '');
    v_mobile TEXT := regexp_replace(coalesce(v_personal->>'mobile', ''), '[^0-9]', '', 'g');
    v_email TEXT := nullif(lower(btrim(coalesce(v_personal->>'email', ''))), '');
    v_pan TEXT := upper(btrim(coalesce(v_personal->>'pan_number', '')));
    v_aadhaar TEXT := regexp_replace(coalesce(v_personal->>'aadhaar_number', ''), '[^0-9]', '', 'g');
    v_aadhaar_masked TEXT;
    v_aadhaar_method TEXT := nullif(btrim(coalesce(v_personal->>'aadhaar_verification_method', '')), '');

    v_line TEXT := nullif(btrim(coalesce(v_address->>'line', '')), '');
    v_city TEXT := nullif(btrim(coalesce(v_address->>'city', '')), '');
    v_district TEXT := nullif(btrim(coalesce(v_address->>'district', '')), '');
    v_state TEXT := nullif(btrim(coalesce(v_address->>'state', '')), '');
    v_pin TEXT := regexp_replace(coalesce(v_address->>'pincode', ''), '[^0-9]', '', 'g');

    v_business_name TEXT := nullif(btrim(coalesce(v_business->>'business_name', '')), '');
    v_trade_name TEXT := nullif(btrim(coalesce(v_business->>'trade_name', '')), '');
    v_constitution TEXT := btrim(coalesce(v_business->>'constitution', ''));
    v_enterprise_category TEXT := nullif(btrim(coalesce(v_business->>'enterprise_category', '')), '');
    v_activity TEXT := nullif(btrim(coalesce(v_business->>'business_activity', '')), '');
    v_nic TEXT := nullif(btrim(coalesce(v_business->>'nic_code', '')), '');
    v_nic_description TEXT := nullif(btrim(coalesce(v_business->>'nic_description', '')), '');
    v_commencement DATE := nullif(v_business->>'commencement_date', '')::DATE;
    v_employees INTEGER := nullif(v_business->>'employee_count', '')::INTEGER;
    v_investment NUMERIC := nullif(v_business->>'plant_machinery_investment', '')::NUMERIC;
    v_turnover NUMERIC := nullif(v_business->>'annual_turnover', '')::NUMERIC;
    v_gstin TEXT := upper(nullif(btrim(coalesce(v_business->>'gstin', '')), ''));
    v_existing_regs TEXT := nullif(btrim(coalesce(v_business->>'existing_registrations', '')), '');

    v_business_same BOOLEAN := coalesce((v_business->>'business_address_same_as_applicant')::BOOLEAN, false);
    v_business_line TEXT := nullif(btrim(coalesce(v_business->>'business_address_line', '')), '');
    v_business_city TEXT := nullif(btrim(coalesce(v_business->>'business_address_city', '')), '');
    v_business_district TEXT := nullif(btrim(coalesce(v_business->>'business_address_district', '')), '');
    v_business_state TEXT := nullif(btrim(coalesce(v_business->>'business_address_state', '')), '');
    v_business_pin TEXT := regexp_replace(coalesce(v_business->>'business_address_pincode', ''), '[^0-9]', '', 'g');

    v_service_type TEXT := btrim(coalesce(v_service->>'service_type', ''));
    v_existing_udyam TEXT := upper(nullif(btrim(coalesce(v_service->>'existing_udyam_number', '')), ''));
    v_update_reason TEXT := nullif(btrim(coalesce(v_service->>'udyam_update_reason', '')), '');
    v_update_details TEXT := nullif(btrim(coalesce(v_service->>'udyam_update_details', '')), '');
    v_existing_shop TEXT := nullif(btrim(coalesce(v_service->>'existing_shop_number', '')), '');
    v_gumasta_type TEXT := nullif(btrim(coalesce(v_service->>'gumasta_establishment_type', '')), '');
    v_gumasta_ownership TEXT := nullif(btrim(coalesce(v_service->>'gumasta_premises_ownership', '')), '');
    v_landlord_name TEXT := nullif(btrim(coalesce(v_service->>'gumasta_premises_landlord_name', '')), '');
    v_landlord_mobile TEXT := nullif(regexp_replace(coalesce(v_service->>'gumasta_premises_landlord_mobile', ''), '[^0-9]', '', 'g'), '');
    v_business_reg_type TEXT := nullif(btrim(coalesce(v_service->>'business_registration_type', '')), '');
    v_business_reg_state TEXT := nullif(btrim(coalesce(v_service->>'business_registration_state', '')), '');
    v_business_reg_details TEXT := nullif(btrim(coalesce(v_service->>'business_registration_details', '')), '');

    v_accuracy BOOLEAN := coalesce((v_declarations->>'accuracy')::BOOLEAN, false);
    v_authorisation BOOLEAN := coalesce((v_declarations->>'authorisation')::BOOLEAN, false);
    v_consent BOOLEAN := coalesce((p_payload->>'consent')::BOOLEAN, false);
    v_consent_version TEXT := coalesce(nullif(p_payload->>'consent_version', ''), '2026-11');
    v_source TEXT := nullif(btrim(coalesce(p_payload->>'source_page', '')), '');

    v_promoter JSONB;
    v_promoter_index INTEGER := 0;
    v_promoter_name TEXT;
    v_promoter_designation TEXT;
    v_promoter_pan TEXT;
    v_promoter_aadhaar TEXT;
    v_promoter_aadhaar_masked TEXT;
    v_promoter_din TEXT;
    v_promoter_mobile TEXT;
    v_promoter_email TEXT;
    v_promoter_share NUMERIC;

    v_message TEXT;
BEGIN
    -- ---- Payload shape -----------------------------------------------------
    IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
        RAISE EXCEPTION 'The application could not be submitted. Please try again.' USING ERRCODE = '22023';
    END IF;
    IF length(p_payload::text) > 250000 THEN
        RAISE EXCEPTION 'This application is too large to submit.' USING ERRCODE = '22023';
    END IF;

    -- ---- Applicant identity ------------------------------------------------
    IF v_name = '' THEN
        RAISE EXCEPTION 'Please enter the applicant name.' USING ERRCODE = '22023';
    END IF;
    IF length(v_name) > 200 THEN
        RAISE EXCEPTION 'Please enter a shorter applicant name.' USING ERRCODE = '22023';
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
    IF v_aadhaar <> '' AND v_aadhaar !~ '^[0-9]{12}$' THEN
        RAISE EXCEPTION 'Please enter a valid 12-digit Aadhaar number.' USING ERRCODE = '22023';
    END IF;
    v_aadhaar_masked := CASE WHEN length(v_aadhaar) = 12
        THEN 'XXXX XXXX ' || right(v_aadhaar, 4)
        ELSE NULL END;
    IF v_aadhaar_method IS NOT NULL AND v_aadhaar_method NOT IN (
        'Aadhaar authentication at Udyam portal',
        'PAN-based registration',
        'Not applicable / exempt',
        'Not sure - advise me') THEN
        RAISE EXCEPTION 'Please choose a valid Aadhaar verification method.' USING ERRCODE = '22023';
    END IF;

    -- ---- Applicant address -------------------------------------------------
    IF v_line IS NULL OR v_city IS NULL OR v_state IS NULL THEN
        RAISE EXCEPTION 'Please enter the complete applicant address.' USING ERRCODE = '22023';
    END IF;
    IF v_pin !~ '^[0-9]{6}$' THEN
        RAISE EXCEPTION 'Please enter a valid 6-digit PIN code.' USING ERRCODE = '22023';
    END IF;

    -- ---- Business profile --------------------------------------------------
    IF v_business_name IS NULL THEN
        RAISE EXCEPTION 'Please enter the legal business name.' USING ERRCODE = '22023';
    END IF;
    IF v_constitution NOT IN (
        'Proprietorship', 'Partnership', 'LLP', 'Private Limited Company',
        'Public Limited Company', 'One Person Company', 'HUF',
        'Trust / Society', 'Other') THEN
        RAISE EXCEPTION 'Please select a valid constitution of business.' USING ERRCODE = '22023';
    END IF;
    IF v_enterprise_category IS NOT NULL AND v_enterprise_category NOT IN (
        'Micro', 'Small', 'Medium', 'Not sure - assess') THEN
        RAISE EXCEPTION 'Please select a valid enterprise category.' USING ERRCODE = '22023';
    END IF;
    IF v_activity IS NULL THEN
        RAISE EXCEPTION 'Please describe your main business activity.' USING ERRCODE = '22023';
    END IF;
    IF v_nic IS NULL OR v_nic !~ '^[0-9]{2,8}$' THEN
        RAISE EXCEPTION 'Please enter a valid NIC activity code.' USING ERRCODE = '22023';
    END IF;
    IF v_commencement IS NULL THEN
        RAISE EXCEPTION 'Please enter the date of commencement of business.' USING ERRCODE = '22023';
    END IF;
    IF v_commencement > (now() AT TIME ZONE 'Asia/Kolkata')::date THEN
        RAISE EXCEPTION 'Date of commencement cannot be in the future.' USING ERRCODE = '22023';
    END IF;
    IF v_investment IS NULL OR v_investment < 0 THEN
        RAISE EXCEPTION 'Please enter a valid plant and machinery investment.' USING ERRCODE = '22023';
    END IF;
    IF v_turnover IS NULL OR v_turnover < 0 THEN
        RAISE EXCEPTION 'Please enter a valid annual turnover.' USING ERRCODE = '22023';
    END IF;
    IF v_employees IS NULL OR v_employees < 0 THEN
        RAISE EXCEPTION 'Please enter a valid employee count.' USING ERRCODE = '22023';
    END IF;
    IF v_gstin IS NOT NULL AND v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' THEN
        RAISE EXCEPTION 'Please enter a valid 15-character GSTIN.' USING ERRCODE = '22023';
    END IF;

    IF v_business_same THEN
        v_business_line := v_line;
        v_business_city := v_city;
        v_business_district := v_district;
        v_business_state := v_state;
        v_business_pin := v_pin;
    END IF;
    IF v_business_line IS NULL OR v_business_city IS NULL OR v_business_state IS NULL THEN
        RAISE EXCEPTION 'Please enter the complete business or establishment address.' USING ERRCODE = '22023';
    END IF;
    IF v_business_pin !~ '^[0-9]{6}$' THEN
        RAISE EXCEPTION 'Please enter a valid 6-digit business address PIN code.' USING ERRCODE = '22023';
    END IF;

    -- ---- Service requirement ----------------------------------------------
    IF v_service_type NOT IN (
        'New Udyam Registration', 'Udyam Update / Amendment',
        'Gumasta / Shop & Establishment',
        'Business Registration Assistance',
        'Udyam & Gumasta Package') THEN
        RAISE EXCEPTION 'Please select a valid MSME service.' USING ERRCODE = '22023';
    END IF;
    IF v_existing_udyam IS NOT NULL AND
       v_existing_udyam !~ '^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$' THEN
        RAISE EXCEPTION 'Please enter a valid Udyam registration number (e.g. UDYAM-GJ-03-0001234).' USING ERRCODE = '22023';
    END IF;
    IF v_service_type = 'Udyam Update / Amendment' THEN
        IF v_existing_udyam IS NULL THEN
            RAISE EXCEPTION 'Please enter the existing Udyam registration number being updated.' USING ERRCODE = '22023';
        END IF;
        IF v_update_reason IS NULL THEN
            RAISE EXCEPTION 'Please select the reason for the Udyam update.' USING ERRCODE = '22023';
        END IF;
        IF v_update_details IS NULL THEN
            RAISE EXCEPTION 'Please describe the Udyam details that need to be updated.' USING ERRCODE = '22023';
        END IF;
    END IF;
    IF v_update_reason IS NOT NULL AND v_update_reason NOT IN (
        'Change in business activity', 'Change in address',
        'Change in ownership / constitution',
        'Change in investment or turnover', 'Change in employee count',
        'Correction of details', 'Other') THEN
        RAISE EXCEPTION 'Please select a valid Udyam update reason.' USING ERRCODE = '22023';
    END IF;

    IF v_service_type IN (
        'Gumasta / Shop & Establishment', 'Udyam & Gumasta Package') THEN
        IF v_gumasta_type IS NULL THEN
            RAISE EXCEPTION 'Please select the establishment type for Gumasta.' USING ERRCODE = '22023';
        END IF;
        IF v_gumasta_ownership IS NULL THEN
            RAISE EXCEPTION 'Please select the premises ownership for Gumasta.' USING ERRCODE = '22023';
        END IF;
        IF v_gumasta_type NOT IN (
            'Shop', 'Commercial Establishment', 'Residential Hotel',
            'Restaurant / Eating House', 'Theatre', 'Other') THEN
            RAISE EXCEPTION 'Please select a valid establishment type.' USING ERRCODE = '22023';
        END IF;
        IF v_gumasta_ownership NOT IN ('Owned', 'Rented', 'Leased', 'Other') THEN
            RAISE EXCEPTION 'Please select a valid premises ownership.' USING ERRCODE = '22023';
        END IF;
        IF v_gumasta_ownership IN ('Rented', 'Leased') THEN
            IF v_landlord_name IS NULL THEN
                RAISE EXCEPTION 'Please enter the landlord or owner name for the rented premises.' USING ERRCODE = '22023';
            END IF;
            IF v_landlord_mobile !~ '^[6-9][0-9]{9}$' THEN
                RAISE EXCEPTION 'Please enter a valid 10-digit landlord mobile number.' USING ERRCODE = '22023';
            END IF;
        END IF;
    END IF;

    IF v_service_type = 'Business Registration Assistance' THEN
        IF v_business_reg_type IS NULL THEN
            RAISE EXCEPTION 'Please select the business registration type required.' USING ERRCODE = '22023';
        END IF;
        IF v_business_reg_type NOT IN (
            'Company', 'LLP', 'Partnership', 'Proprietorship',
            'Society / Trust', 'Other') THEN
            RAISE EXCEPTION 'Please select a valid business registration type.' USING ERRCODE = '22023';
        END IF;
        IF v_business_reg_state IS NULL THEN
            RAISE EXCEPTION 'Please enter the state for the business registration.' USING ERRCODE = '22023';
        END IF;
        IF v_business_reg_details IS NULL THEN
            RAISE EXCEPTION 'Please describe the business registration assistance required.' USING ERRCODE = '22023';
        END IF;
    END IF;

    -- ---- Promoters / partners / directors ----------------------------------
    IF jsonb_typeof(v_promoters) <> 'array' THEN
        RAISE EXCEPTION 'Please provide the proprietor, partner or director details.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(v_promoters) < 1 THEN
        RAISE EXCEPTION 'Please add at least one proprietor, partner or director.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(v_promoters) > 10 THEN
        RAISE EXCEPTION 'Please provide no more than 10 promoters, partners or directors.' USING ERRCODE = '22023';
    END IF;

    -- ---- Declarations and consent -----------------------------------------
    IF NOT v_accuracy THEN
        RAISE EXCEPTION 'Please confirm that the information provided is true and complete.' USING ERRCODE = '22023';
    END IF;
    IF NOT v_authorisation THEN
        RAISE EXCEPTION 'Please authorise Dhanvi Finserv to prepare and submit your MSME, Udyam or Gumasta application.' USING ERRCODE = '22023';
    END IF;
    IF NOT v_consent THEN
        RAISE EXCEPTION 'Please accept the privacy notice and MSME consent before submitting.' USING ERRCODE = '22023';
    END IF;

    v_message := left(
        'MSME service: ' || v_service_type ||
        ' | Constitution: ' || v_constitution ||
        CASE WHEN v_nic IS NOT NULL THEN ' | NIC: ' || v_nic ELSE '' END ||
        CASE WHEN v_existing_udyam IS NOT NULL THEN ' | Udyam: ' || v_existing_udyam ELSE '' END,
        1000
    );

    -- ---- Create the lead ---------------------------------------------------
    INSERT INTO public.loan_leads (
        full_name, mobile, email, loan_type, loan_amount, message,
        applicant_type, residency_status, employment_type,
        consent_given, consent_at, consent_version, source_page
    ) VALUES (
        v_name, v_mobile, v_email, 'MSME / Udyam Registration', 0, v_message,
        'resident', 'Resident', 'Business Owner',
        true, now(), v_consent_version, v_source
    )
    RETURNING id, reference_no, access_token INTO v_id, v_ref, v_token;

    -- ---- Structured MSME details ------------------------------------------
    INSERT INTO public.msme_registration_details (
        loan_lead_id, applicant_name, designation, mobile, email, pan_number,
        aadhaar_masked, aadhaar_verification_method,
        address_line, address_city, address_district, address_state, address_pincode,
        business_name, trade_name, constitution, enterprise_category,
        business_activity, nic_code, nic_description, commencement_date,
        employee_count, plant_machinery_investment, annual_turnover,
        gstin, existing_registrations,
        business_address_same_as_applicant, business_address_line,
        business_address_city, business_address_district,
        business_address_state, business_address_pincode,
        service_type, existing_udyam_number, udyam_update_reason,
        udyam_update_details,
        existing_shop_number, gumasta_establishment_type,
        gumasta_premises_ownership, gumasta_premises_landlord_name,
        gumasta_premises_landlord_mobile,
        business_registration_type, business_registration_state,
        business_registration_details
    ) VALUES (
        v_id, v_name, v_designation, v_mobile, v_email, v_pan,
        v_aadhaar_masked, v_aadhaar_method,
        v_line, v_city, v_district, v_state, v_pin,
        v_business_name, v_trade_name, v_constitution, v_enterprise_category,
        v_activity, v_nic, v_nic_description, v_commencement,
        v_employees, v_investment, v_turnover,
        v_gstin, v_existing_regs,
        v_business_same, v_business_line,
        v_business_city, v_business_district,
        v_business_state, v_business_pin,
        v_service_type, v_existing_udyam, v_update_reason,
        v_update_details,
        v_existing_shop, v_gumasta_type,
        v_gumasta_ownership, v_landlord_name,
        v_landlord_mobile,
        v_business_reg_type, v_business_reg_state,
        v_business_reg_details
    );

    -- ---- Promoters / partners / directors ----------------------------------
    FOR v_promoter IN SELECT * FROM jsonb_array_elements(v_promoters)
    LOOP
        v_promoter_index := v_promoter_index + 1;

        v_promoter_name := nullif(btrim(coalesce(v_promoter->>'full_name', '')), '');
        v_promoter_designation := btrim(coalesce(v_promoter->>'designation', ''));
        v_promoter_pan := upper(nullif(btrim(coalesce(v_promoter->>'pan_number', '')), ''));
        v_promoter_aadhaar := regexp_replace(coalesce(v_promoter->>'aadhaar_number', ''), '[^0-9]', '', 'g');
        v_promoter_aadhaar_masked := CASE WHEN length(v_promoter_aadhaar) = 12
            THEN 'XXXX XXXX ' || right(v_promoter_aadhaar, 4)
            ELSE NULL END;
        v_promoter_din := nullif(btrim(coalesce(v_promoter->>'din', '')), '');
        v_promoter_mobile := nullif(regexp_replace(coalesce(v_promoter->>'mobile', ''), '[^0-9]', '', 'g'), '');
        v_promoter_email := nullif(lower(btrim(coalesce(v_promoter->>'email', ''))), '');
        v_promoter_share := nullif(v_promoter->>'shareholding_percent', '')::NUMERIC;

        IF v_promoter_name IS NULL THEN
            RAISE EXCEPTION 'Please enter the name for every proprietor, partner or director.' USING ERRCODE = '22023';
        END IF;
        IF v_promoter_designation NOT IN (
            'Proprietor', 'Partner', 'Designated Partner', 'Director',
            'Karta', 'Trustee', 'Authorised Signatory', 'Other') THEN
            RAISE EXCEPTION 'Please select a valid designation for every promoter, partner or director.' USING ERRCODE = '22023';
        END IF;
        IF v_promoter_pan IS NOT NULL AND v_promoter_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' THEN
            RAISE EXCEPTION 'Please enter a valid PAN for every promoter, partner or director.' USING ERRCODE = '22023';
        END IF;
        IF v_promoter_aadhaar <> '' AND v_promoter_aadhaar !~ '^[0-9]{12}$' THEN
            RAISE EXCEPTION 'Please enter a valid 12-digit Aadhaar number for every promoter.' USING ERRCODE = '22023';
        END IF;
        IF v_promoter_din IS NOT NULL AND v_promoter_din !~ '^[0-9]{8}$' THEN
            RAISE EXCEPTION 'Please enter a valid 8-digit DIN.' USING ERRCODE = '22023';
        END IF;
        IF v_promoter_mobile <> '' AND v_promoter_mobile !~ '^[6-9][0-9]{9}$' THEN
            RAISE EXCEPTION 'Please enter a valid 10-digit mobile number for every promoter.' USING ERRCODE = '22023';
        END IF;
        IF v_promoter_email IS NOT NULL AND v_promoter_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
            RAISE EXCEPTION 'Please enter a valid email address for every promoter.' USING ERRCODE = '22023';
        END IF;
        IF v_promoter_share IS NOT NULL AND (v_promoter_share < 0 OR v_promoter_share > 100) THEN
            RAISE EXCEPTION 'Shareholding must be between 0 and 100 percent.' USING ERRCODE = '22023';
        END IF;

        INSERT INTO public.msme_promoters (
            loan_lead_id, sort_order, full_name, designation, pan_number,
            aadhaar_masked, din, mobile, email, shareholding_percent, is_primary
        ) VALUES (
            v_id, v_promoter_index, v_promoter_name, v_promoter_designation,
            v_promoter_pan, v_promoter_aadhaar_masked, v_promoter_din,
            v_promoter_mobile, v_promoter_email, v_promoter_share,
            v_promoter_index = 1
        );
    END LOOP;

    -- ---- Registration rows requested --------------------------------------
    IF v_service_type IN ('New Udyam Registration', 'Udyam & Gumasta Package') THEN
        INSERT INTO public.msme_registrations (
            loan_lead_id, registration_type, status
        ) VALUES (
            v_id, 'Udyam Registration', 'Application Received'
        );
    END IF;
    IF v_service_type = 'Udyam Update / Amendment' THEN
        INSERT INTO public.msme_registrations (
            loan_lead_id, registration_type, status
        ) VALUES (
            v_id, 'Udyam Update', 'Application Received'
        );
    END IF;
    IF v_service_type IN ('Gumasta / Shop & Establishment', 'Udyam & Gumasta Package') THEN
        INSERT INTO public.msme_registrations (
            loan_lead_id, registration_type, status
        ) VALUES (
            v_id, 'Gumasta / Shop & Establishment', 'Application Received'
        );
    END IF;
    IF v_service_type = 'Business Registration Assistance' THEN
        INSERT INTO public.msme_registrations (
            loan_lead_id, registration_type, status
        ) VALUES (
            v_id, 'Business Registration', 'Application Received'
        );
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
        'full_name', v_name,
        'loan_type', 'MSME / Udyam Registration',
        'service_type', v_service_type,
        'constitution', v_constitution,
        'nic_code', v_nic,
        'existing_udyam_number', v_existing_udyam,
        'submission_status', 'Application Received'
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Extra document types for MSME / Udyam / Gumasta applications
-- -----------------------------------------------------------------------------
-- The MSME checklist needs a Shop & Establishment certificate, an electricity
-- bill and general supporting documents in addition to PAN, Aadhaar,
-- photograph, address proof, business proof, Udyam certificate, incorporation
-- or partnership documents, board resolution and authorisation letter. Widen
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
        'ITR Acknowledgement', 'Tax Payment Challan', 'Foreign Income Documents',
        'GST Certificate', 'Invoices', 'Purchase Bills', 'Rent Agreement / NOC',
        'Certificate of Incorporation', 'Partnership Deed', 'Board Resolution',
        'Authorisation Letter', 'Address Proof', 'Bank Proof',
        'Shop & Establishment Certificate', 'Electricity Bill',
        'Supporting Document'
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
        'Supporting Document'
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

-- =============================================================================
-- NHOST / HASURA MIGRATION: 012_credit_health_cibil.sql
-- PROJECT: Dhanvi Finserv
--
-- Run this ONCE, after 011, in the Nhost dashboard:
--   Database -> SQL Editor -> paste -> Run
--
-- It adds the structured Credit Health / CIBIL advisory system behind
-- credit-health-apply.html:
--
--   1. public.credit_health_details - applicant profile, the advisory service
--      requested, bureau preference, current credit profile, overdue and
--      settlement history, bureau consent, and the administrator-controlled
--      bureau, report, score and analysis fields.
--   2. public.credit_accounts       - the loans and credit facilities the
--      applicant discloses (1:N with the lead).
--   3. public.credit_enquiries      - recent credit enquiries the applicant
--      discloses (1:N with the lead).
--   4. submit_credit_health_application() - validate and create a credit
--      health advisory application (loan_leads + details + accounts +
--      enquiries) and consume the shared draft.
--   5. Extra document types (Credit Report, Credit Card Statement, Bureau
--      Correspondence, No Dues Certificate, Settlement Letter) added to
--      public.loan_documents.document_type and to register_document().
--   6. Re-asserts the widened loan_leads.loan_type and loan_amount constraints
--      so service applications can be stored without fake loan amounts.
--
-- DRAFT STORAGE
--   Save / resume is shared with the other application wizards: the page calls
--   the existing save_home_loan_draft() / get_home_loan_draft() against
--   public.home_loan_drafts. The draft payload is opaque JSONB, so no new draft
--   table or draft function is required. PAN and account last-4 references are
--   removed from drafts and must be re-entered on resume.
--
-- BUREAU INTEGRATION
--   This migration does not call or fake a credit bureau API. A live bureau
--   integration must only be enabled after written authorisation, credentials,
--   consent capture and the applicable compliance checks are in place. Until
--   then an administrator records the bureau reference and report received date
--   only after the authorised bureau has actually supplied the report.
--
-- IMPORTANT
--   * Hasura permissions are the access-control layer, NOT Postgres RLS.
--   * Do not enable RLS on these tables.
--   * Every function returns SETOF public.api_result so Hasura can track it.
--   * Other service types are untouched: they keep using their own functions.
--   * The public wizard never sets report_status, bureau_name, bureau_reference,
--     report dates, credit_score, score_date, score_band, analysis, remarks,
--     follow-up or verification fields. A new enquiry starts at
--     'Enquiry Received'.
--   * Dhanvi Finserv never guarantees a score increase or a loan approval. The
--     bureau, lender and their policies decide those outcomes.
--   * Full credit reports are not stored in the database or exposed through
--     public URLs or ordinary logs. The private loan-documents bucket holds any
--     uploaded report, and only a bureau reference and summary are recorded here.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Allow service applications on the shared loan_leads table
-- -----------------------------------------------------------------------------
-- Migrations 008 to 011 already widened these constraints. This block is
-- idempotent so 012 can be run safely even if the earlier migrations were
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
-- 1. Credit health details (1:1 with loan_leads)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.credit_health_details (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_lead_id UUID NOT NULL UNIQUE REFERENCES public.loan_leads(id) ON DELETE CASCADE,

    -- Applicant profile
    applicant_name TEXT NOT NULL,
    date_of_birth DATE NOT NULL,
    gender TEXT
        CHECK (gender IS NULL OR gender IN ('Male', 'Female', 'Other', 'Prefer not to say')),
    mobile TEXT NOT NULL,
    email TEXT NOT NULL,
    pan_number TEXT NOT NULL,
    occupation TEXT NOT NULL
        CHECK (occupation IN (
            'Salaried', 'Self-employed professional', 'Business owner',
            'Retired', 'Student', 'Homemaker', 'Other')),
    annual_income NUMERIC NOT NULL CHECK (annual_income >= 0),
    address_line TEXT NOT NULL,
    address_city TEXT NOT NULL,
    address_district TEXT,
    address_state TEXT NOT NULL,
    address_pincode TEXT NOT NULL,

    -- Advisory requirement
    service_type TEXT NOT NULL
        CHECK (service_type IN (
            'Credit Score Enquiry', 'Credit Report Assistance',
            'Credit Report Review', 'Credit Profile Analysis',
            'Credit Improvement Guidance', 'Loan Eligibility Assessment')),
    bureau_preference TEXT NOT NULL
        CHECK (bureau_preference IN (
            'CIBIL', 'Experian', 'CRIF High Mark', 'Equifax',
            'Any authorised bureau')),
    needs_report_help BOOLEAN NOT NULL DEFAULT false,
    needs_profile_analysis BOOLEAN NOT NULL DEFAULT false,
    needs_improvement_guidance BOOLEAN NOT NULL DEFAULT false,
    needs_eligibility_assessment BOOLEAN NOT NULL DEFAULT false,
    current_score INTEGER
        CHECK (current_score IS NULL OR (current_score >= 300 AND current_score <= 900)),
    current_score_date DATE,
    score_source TEXT
        CHECK (score_source IS NULL OR score_source IN (
            'Self-check', 'Bank / lender communication',
            'Existing credit report', 'Not sure')),
    target_loan_type TEXT
        CHECK (target_loan_type IS NULL OR target_loan_type IN (
            'Home Loan', 'Home Loan Top-Up', 'Home Loan Takeover',
            'Loan Against Property', 'Business Loan', 'Personal Loan',
            'Vehicle Loan', 'Education Loan', 'Gold Loan',
            'Working Capital (CC/OD)', 'Credit Card', 'Not sure',
            'No immediate loan')),
    target_loan_amount NUMERIC
        CHECK (target_loan_amount IS NULL OR target_loan_amount >= 0),
    target_lender TEXT,
    target_timeline TEXT
        CHECK (target_timeline IS NULL OR target_timeline IN (
            'Immediately', 'Within 30 days', '1-3 months', '3-6 months',
            'Just exploring')),
    concerns TEXT,

    -- Existing credit profile
    profile_status TEXT NOT NULL
        CHECK (profile_status IN (
            'No credit history', 'Accounts in good standing',
            'Some late payments', 'Overdue accounts',
            'Settled or written-off accounts', 'Not sure')),
    running_loans_count INTEGER NOT NULL DEFAULT 0
        CHECK (running_loans_count >= 0 AND running_loans_count <= 50),
    total_outstanding NUMERIC
        CHECK (total_outstanding IS NULL OR total_outstanding >= 0),
    total_emi NUMERIC
        CHECK (total_emi IS NULL OR total_emi >= 0),
    overdue_accounts TEXT NOT NULL
        CHECK (overdue_accounts IN ('Yes', 'No', 'Not sure')),
    overdue_details TEXT,
    settlement_history TEXT NOT NULL
        CHECK (settlement_history IN ('Yes', 'No', 'Not sure')),
    settlement_details TEXT,
    existing_report_available BOOLEAN NOT NULL DEFAULT false,
    existing_report_date DATE,
    existing_report_source TEXT
        CHECK (existing_report_source IS NULL OR existing_report_source IN (
            'CIBIL direct', 'Other bureau direct', 'Bank / lender',
            'Credit app / portal', 'Not sure')),

    -- Consent and declarations captured with the application
    bureau_consent BOOLEAN NOT NULL DEFAULT false,
    bureau_consent_at TIMESTAMPTZ,
    bureau_consent_version TEXT,
    accuracy_declaration BOOLEAN NOT NULL DEFAULT false,
    no_guarantee_declaration BOOLEAN NOT NULL DEFAULT false,

    -- Administrator-controlled bureau, report, score and analysis record.
    -- The public form can never set any of these fields.
    report_status TEXT NOT NULL DEFAULT 'Enquiry Received'
        CHECK (report_status IN (
            'Enquiry Received', 'Consent Received', 'Documents Pending',
            'Bureau Request Sent', 'Report Received', 'Analysis In Progress',
            'Analysis Shared', 'Closed', 'On Hold', 'Cancelled')),
    bureau_name TEXT
        CHECK (bureau_name IS NULL OR bureau_name IN (
            'CIBIL', 'Experian', 'CRIF High Mark', 'Equifax',
            'Other authorised bureau')),
    bureau_reference TEXT,
    bureau_request_sent_at DATE,
    report_received_date DATE,
    credit_score INTEGER
        CHECK (credit_score IS NULL OR (credit_score >= 300 AND credit_score <= 900)),
    score_date DATE,
    score_band TEXT
        CHECK (score_band IS NULL OR score_band IN (
            'Poor', 'Fair', 'Good', 'Very Good', 'Excellent',
            'Not disclosed', 'Bureau-specific')),
    report_summary TEXT,
    analysis_summary TEXT,
    improvement_plan TEXT,
    eligibility_assessment TEXT,
    analysis_shared_date DATE,
    admin_remarks TEXT,
    follow_up_date DATE,
    status_notes TEXT,
    verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    verified_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS credit_health_details_lead_idx
    ON public.credit_health_details (loan_lead_id);
CREATE INDEX IF NOT EXISTS credit_health_details_status_idx
    ON public.credit_health_details (report_status);
CREATE INDEX IF NOT EXISTS credit_health_details_service_idx
    ON public.credit_health_details (service_type);
CREATE INDEX IF NOT EXISTS credit_health_details_bureau_idx
    ON public.credit_health_details (bureau_name);
CREATE INDEX IF NOT EXISTS credit_health_details_score_idx
    ON public.credit_health_details (credit_score);
CREATE INDEX IF NOT EXISTS credit_health_details_followup_idx
    ON public.credit_health_details (follow_up_date);
CREATE INDEX IF NOT EXISTS credit_health_details_state_idx
    ON public.credit_health_details (address_state);

DROP TRIGGER IF EXISTS update_credit_health_details_modtime
    ON public.credit_health_details;
CREATE TRIGGER update_credit_health_details_modtime
    BEFORE UPDATE ON public.credit_health_details
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. Disclosed credit accounts (1:N with loan_leads)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.credit_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_lead_id UUID NOT NULL REFERENCES public.loan_leads(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL CHECK (sort_order >= 1),
    account_type TEXT NOT NULL
        CHECK (account_type IN (
            'Home Loan', 'Home Loan Top-Up', 'Home Loan Takeover',
            'Loan Against Property', 'Business Loan', 'Personal Loan',
            'Vehicle Loan', 'Education Loan', 'Gold Loan',
            'Credit Card', 'Consumer Durable Loan',
            'Working Capital (CC/OD)', 'Other')),
    lender_name TEXT NOT NULL,
    account_reference_last4 TEXT
        CHECK (account_reference_last4 IS NULL OR account_reference_last4 ~ '^[A-Z0-9]{4}$'),
    account_status TEXT NOT NULL
        CHECK (account_status IN (
            'Active', 'Closed', 'Overdue', 'Settled', 'Written Off',
            'Restructured', 'Not sure')),
    outstanding_amount NUMERIC
        CHECK (outstanding_amount IS NULL OR outstanding_amount >= 0),
    emi_amount NUMERIC
        CHECK (emi_amount IS NULL OR emi_amount >= 0),
    overdue_amount NUMERIC
        CHECK (overdue_amount IS NULL OR overdue_amount >= 0),
    days_past_due INTEGER
        CHECK (days_past_due IS NULL OR (days_past_due >= 0 AND days_past_due <= 999)),
    opened_date DATE,
    closed_date DATE,
    settled_amount NUMERIC
        CHECK (settled_amount IS NULL OR settled_amount >= 0),
    remarks TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (loan_lead_id, sort_order)
);

CREATE INDEX IF NOT EXISTS credit_accounts_lead_idx
    ON public.credit_accounts (loan_lead_id);
CREATE INDEX IF NOT EXISTS credit_accounts_type_idx
    ON public.credit_accounts (account_type);
CREATE INDEX IF NOT EXISTS credit_accounts_status_idx
    ON public.credit_accounts (account_status);

DROP TRIGGER IF EXISTS update_credit_accounts_modtime
    ON public.credit_accounts;
CREATE TRIGGER update_credit_accounts_modtime
    BEFORE UPDATE ON public.credit_accounts
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. Disclosed credit enquiries (1:N with loan_leads)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.credit_enquiries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_lead_id UUID NOT NULL REFERENCES public.loan_leads(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL CHECK (sort_order >= 1),
    bureau TEXT NOT NULL
        CHECK (bureau IN (
            'CIBIL', 'Experian', 'CRIF High Mark', 'Equifax',
            'Multiple bureaus', 'Not sure')),
    institution_name TEXT NOT NULL,
    enquiry_date DATE NOT NULL,
    purpose TEXT NOT NULL
        CHECK (purpose IN (
            'Loan application', 'Credit card application',
            'Existing customer review', 'Background / employment check',
            'Other', 'Not sure')),
    status TEXT NOT NULL
        CHECK (status IN ('Approved', 'Rejected', 'Pending', 'Not sure')),
    remarks TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (loan_lead_id, sort_order)
);

CREATE INDEX IF NOT EXISTS credit_enquiries_lead_idx
    ON public.credit_enquiries (loan_lead_id);
CREATE INDEX IF NOT EXISTS credit_enquiries_date_idx
    ON public.credit_enquiries (enquiry_date);
CREATE INDEX IF NOT EXISTS credit_enquiries_bureau_idx
    ON public.credit_enquiries (bureau);

DROP TRIGGER IF EXISTS update_credit_enquiries_modtime
    ON public.credit_enquiries;
CREATE TRIGGER update_credit_enquiries_modtime
    BEFORE UPDATE ON public.credit_enquiries
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 4. Submit a credit health / CIBIL advisory application
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_credit_health_application(
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
    v_requirement JSONB := coalesce(p_payload->'requirement', '{}'::JSONB);
    v_profile JSONB := coalesce(p_payload->'credit_profile', '{}'::JSONB);
    v_accounts JSONB := coalesce(p_payload->'accounts', '[]'::JSONB);
    v_enquiries JSONB := coalesce(p_payload->'enquiries', '[]'::JSONB);
    v_declarations JSONB := coalesce(p_payload->'declarations', '{}'::JSONB);

    v_name TEXT := btrim(coalesce(v_personal->>'applicant_name', ''));
    v_dob DATE := nullif(v_personal->>'date_of_birth', '')::DATE;
    v_gender TEXT := nullif(btrim(coalesce(v_personal->>'gender', '')), '');
    v_mobile TEXT := regexp_replace(coalesce(v_personal->>'mobile', ''), '[^0-9]', '', 'g');
    v_email TEXT := nullif(lower(btrim(coalesce(v_personal->>'email', ''))), '');
    v_pan TEXT := upper(nullif(btrim(coalesce(v_personal->>'pan_number', '')), ''));
    v_occupation TEXT := btrim(coalesce(v_personal->>'occupation', ''));
    v_income NUMERIC := nullif(v_personal->>'annual_income', '')::NUMERIC;
    v_line TEXT := nullif(btrim(coalesce(v_personal->>'address_line', '')), '');
    v_city TEXT := nullif(btrim(coalesce(v_personal->>'address_city', '')), '');
    v_district TEXT := nullif(btrim(coalesce(v_personal->>'address_district', '')), '');
    v_state TEXT := nullif(btrim(coalesce(v_personal->>'address_state', '')), '');
    v_pin TEXT := regexp_replace(coalesce(v_personal->>'address_pincode', ''), '[^0-9]', '', 'g');

    v_service TEXT := btrim(coalesce(v_requirement->>'service_type', ''));
    v_bureau_pref TEXT := btrim(coalesce(v_requirement->>'bureau_preference', ''));
    v_needs_report BOOLEAN := coalesce((v_requirement->>'needs_report_help')::BOOLEAN, false);
    v_needs_analysis BOOLEAN := coalesce((v_requirement->>'needs_profile_analysis')::BOOLEAN, false);
    v_needs_guidance BOOLEAN := coalesce((v_requirement->>'needs_improvement_guidance')::BOOLEAN, false);
    v_needs_eligibility BOOLEAN := coalesce((v_requirement->>'needs_eligibility_assessment')::BOOLEAN, false);
    v_current_score INTEGER := nullif(v_requirement->>'current_score', '')::INTEGER;
    v_current_score_date DATE := nullif(v_requirement->>'current_score_date', '')::DATE;
    v_score_source TEXT := nullif(btrim(coalesce(v_requirement->>'score_source', '')), '');
    v_target_loan_type TEXT := nullif(btrim(coalesce(v_requirement->>'target_loan_type', '')), '');
    v_target_amount NUMERIC := nullif(v_requirement->>'target_loan_amount', '')::NUMERIC;
    v_target_lender TEXT := nullif(btrim(coalesce(v_requirement->>'target_lender', '')), '');
    v_target_timeline TEXT := nullif(btrim(coalesce(v_requirement->>'target_timeline', '')), '');
    v_concerns TEXT := nullif(btrim(coalesce(v_requirement->>'concerns', '')), '');

    v_profile_status TEXT := btrim(coalesce(v_profile->>'profile_status', ''));
    v_running_count INTEGER := coalesce(nullif(v_profile->>'running_loans_count', '')::INTEGER, 0);
    v_total_outstanding NUMERIC := nullif(v_profile->>'total_outstanding', '')::NUMERIC;
    v_total_emi NUMERIC := nullif(v_profile->>'total_emi', '')::NUMERIC;
    v_overdue TEXT := btrim(coalesce(v_profile->>'overdue_accounts', ''));
    v_overdue_details TEXT := nullif(btrim(coalesce(v_profile->>'overdue_details', '')), '');
    v_settlement TEXT := btrim(coalesce(v_profile->>'settlement_history', ''));
    v_settlement_details TEXT := nullif(btrim(coalesce(v_profile->>'settlement_details', '')), '');
    v_existing_report BOOLEAN := coalesce((v_profile->>'existing_report_available')::BOOLEAN, false);
    v_existing_report_date DATE := nullif(v_profile->>'existing_report_date', '')::DATE;
    v_existing_report_source TEXT := nullif(btrim(coalesce(v_profile->>'existing_report_source', '')), '');

    v_accuracy BOOLEAN := coalesce((v_declarations->>'accuracy')::BOOLEAN, false);
    v_bureau_consent BOOLEAN := coalesce((v_declarations->>'bureau_authorisation')::BOOLEAN, false);
    v_no_guarantee BOOLEAN := coalesce((v_declarations->>'no_guarantee')::BOOLEAN, false);
    v_consent BOOLEAN := coalesce((p_payload->>'consent')::BOOLEAN, false);
    v_consent_version TEXT := coalesce(nullif(p_payload->>'consent_version', ''), '2026-11');
    v_source TEXT := nullif(btrim(coalesce(p_payload->>'source_page', '')), '');

    v_account JSONB;
    v_account_index INTEGER := 0;
    v_account_type TEXT;
    v_lender TEXT;
    v_account_ref TEXT;
    v_account_status TEXT;
    v_account_outstanding NUMERIC;
    v_account_emi NUMERIC;
    v_account_overdue NUMERIC;
    v_account_dpd INTEGER;
    v_account_opened DATE;
    v_account_closed DATE;
    v_account_settled NUMERIC;
    v_account_remarks TEXT;

    v_enquiry JSONB;
    v_enquiry_index INTEGER := 0;
    v_enquiry_bureau TEXT;
    v_enquiry_institution TEXT;
    v_enquiry_date DATE;
    v_enquiry_purpose TEXT;
    v_enquiry_status TEXT;
    v_enquiry_remarks TEXT;

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
    IF v_age < 18 OR v_age > 100 THEN
        RAISE EXCEPTION 'The applicant must be at least 18 years old.' USING ERRCODE = '22023';
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
    IF v_pan IS NULL OR v_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' THEN
        RAISE EXCEPTION 'Please enter a valid PAN (e.g. ABCDE1234F).' USING ERRCODE = '22023';
    END IF;
    IF v_occupation NOT IN (
        'Salaried', 'Self-employed professional', 'Business owner',
        'Retired', 'Student', 'Homemaker', 'Other') THEN
        RAISE EXCEPTION 'Please select a valid occupation.' USING ERRCODE = '22023';
    END IF;
    IF v_income IS NULL OR v_income < 0 THEN
        RAISE EXCEPTION 'Please enter a valid annual income.' USING ERRCODE = '22023';
    END IF;
    IF v_line IS NULL OR v_city IS NULL OR v_state IS NULL THEN
        RAISE EXCEPTION 'Please enter the complete applicant address.' USING ERRCODE = '22023';
    END IF;
    IF v_pin !~ '^[0-9]{6}$' THEN
        RAISE EXCEPTION 'Please enter a valid 6-digit PIN code.' USING ERRCODE = '22023';
    END IF;

    -- ---- Advisory requirement ---------------------------------------------
    IF v_service NOT IN (
        'Credit Score Enquiry', 'Credit Report Assistance',
        'Credit Report Review', 'Credit Profile Analysis',
        'Credit Improvement Guidance', 'Loan Eligibility Assessment') THEN
        RAISE EXCEPTION 'Please select a valid credit advisory service.' USING ERRCODE = '22023';
    END IF;
    IF v_bureau_pref NOT IN (
        'CIBIL', 'Experian', 'CRIF High Mark', 'Equifax',
        'Any authorised bureau') THEN
        RAISE EXCEPTION 'Please select a valid credit bureau preference.' USING ERRCODE = '22023';
    END IF;
    IF v_current_score IS NOT NULL AND (v_current_score < 300 OR v_current_score > 900) THEN
        RAISE EXCEPTION 'A credit score must be between 300 and 900, or left blank.' USING ERRCODE = '22023';
    END IF;
    IF v_current_score_date IS NOT NULL AND v_current_score_date > (now() AT TIME ZONE 'Asia/Kolkata')::date THEN
        RAISE EXCEPTION 'The score date cannot be in the future.' USING ERRCODE = '22023';
    END IF;
    IF v_score_source IS NOT NULL AND v_score_source NOT IN (
        'Self-check', 'Bank / lender communication',
        'Existing credit report', 'Not sure') THEN
        RAISE EXCEPTION 'Please select a valid score source.' USING ERRCODE = '22023';
    END IF;
    IF v_target_loan_type IS NOT NULL AND v_target_loan_type NOT IN (
        'Home Loan', 'Home Loan Top-Up', 'Home Loan Takeover',
        'Loan Against Property', 'Business Loan', 'Personal Loan',
        'Vehicle Loan', 'Education Loan', 'Gold Loan',
        'Working Capital (CC/OD)', 'Credit Card', 'Not sure',
        'No immediate loan') THEN
        RAISE EXCEPTION 'Please select a valid target loan type.' USING ERRCODE = '22023';
    END IF;
    IF v_target_amount IS NOT NULL AND v_target_amount < 0 THEN
        RAISE EXCEPTION 'The target loan amount cannot be negative.' USING ERRCODE = '22023';
    END IF;
    IF v_target_timeline IS NOT NULL AND v_target_timeline NOT IN (
        'Immediately', 'Within 30 days', '1-3 months', '3-6 months',
        'Just exploring') THEN
        RAISE EXCEPTION 'Please select a valid timeline.' USING ERRCODE = '22023';
    END IF;

    -- ---- Existing credit profile ------------------------------------------
    IF v_profile_status NOT IN (
        'No credit history', 'Accounts in good standing',
        'Some late payments', 'Overdue accounts',
        'Settled or written-off accounts', 'Not sure') THEN
        RAISE EXCEPTION 'Please select a valid credit profile status.' USING ERRCODE = '22023';
    END IF;
    IF v_running_count < 0 OR v_running_count > 50 THEN
        RAISE EXCEPTION 'The number of running loans must be between 0 and 50.' USING ERRCODE = '22023';
    END IF;
    IF v_total_outstanding IS NOT NULL AND v_total_outstanding < 0 THEN
        RAISE EXCEPTION 'The total outstanding amount cannot be negative.' USING ERRCODE = '22023';
    END IF;
    IF v_total_emi IS NOT NULL AND v_total_emi < 0 THEN
        RAISE EXCEPTION 'The total EMI cannot be negative.' USING ERRCODE = '22023';
    END IF;
    IF v_overdue NOT IN ('Yes', 'No', 'Not sure') THEN
        RAISE EXCEPTION 'Please confirm whether any account is overdue.' USING ERRCODE = '22023';
    END IF;
    IF v_overdue = 'Yes' AND v_overdue_details IS NULL THEN
        RAISE EXCEPTION 'Please describe the overdue accounts.' USING ERRCODE = '22023';
    END IF;
    IF v_settlement NOT IN ('Yes', 'No', 'Not sure') THEN
        RAISE EXCEPTION 'Please confirm whether there is a settlement or write-off history.' USING ERRCODE = '22023';
    END IF;
    IF v_settlement = 'Yes' AND v_settlement_details IS NULL THEN
        RAISE EXCEPTION 'Please describe the settlement or write-off history.' USING ERRCODE = '22023';
    END IF;
    IF v_existing_report THEN
        IF v_existing_report_date IS NULL THEN
            RAISE EXCEPTION 'Please enter the date of your existing credit report.' USING ERRCODE = '22023';
        END IF;
        IF v_existing_report_date > (now() AT TIME ZONE 'Asia/Kolkata')::date THEN
            RAISE EXCEPTION 'The existing credit report date cannot be in the future.' USING ERRCODE = '22023';
        END IF;
    END IF;
    IF v_existing_report_source IS NOT NULL AND v_existing_report_source NOT IN (
        'CIBIL direct', 'Other bureau direct', 'Bank / lender',
        'Credit app / portal', 'Not sure') THEN
        RAISE EXCEPTION 'Please select a valid existing report source.' USING ERRCODE = '22023';
    END IF;

    -- ---- Disclosed accounts -----------------------------------------------
    IF jsonb_typeof(v_accounts) <> 'array' THEN
        RAISE EXCEPTION 'Please provide the credit account details in the expected format.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(v_accounts) > 20 THEN
        RAISE EXCEPTION 'Please provide no more than 20 credit accounts.' USING ERRCODE = '22023';
    END IF;

    FOR v_account IN SELECT * FROM jsonb_array_elements(v_accounts)
    LOOP
        v_account_index := v_account_index + 1;

        v_account_type := btrim(coalesce(v_account->>'account_type', ''));
        v_lender := nullif(btrim(coalesce(v_account->>'lender_name', '')), '');
        v_account_ref := upper(regexp_replace(coalesce(v_account->>'account_reference_last4', ''), '[^A-Za-z0-9]', '', 'g'));
        v_account_status := btrim(coalesce(v_account->>'account_status', ''));
        v_account_outstanding := nullif(v_account->>'outstanding_amount', '')::NUMERIC;
        v_account_emi := nullif(v_account->>'emi_amount', '')::NUMERIC;
        v_account_overdue := nullif(v_account->>'overdue_amount', '')::NUMERIC;
        v_account_dpd := nullif(v_account->>'days_past_due', '')::INTEGER;
        v_account_opened := nullif(v_account->>'opened_date', '')::DATE;
        v_account_closed := nullif(v_account->>'closed_date', '')::DATE;
        v_account_settled := nullif(v_account->>'settled_amount', '')::NUMERIC;
        v_account_remarks := nullif(btrim(coalesce(v_account->>'remarks', '')), '');

        IF v_account_type NOT IN (
            'Home Loan', 'Home Loan Top-Up', 'Home Loan Takeover',
            'Loan Against Property', 'Business Loan', 'Personal Loan',
            'Vehicle Loan', 'Education Loan', 'Gold Loan',
            'Credit Card', 'Consumer Durable Loan',
            'Working Capital (CC/OD)', 'Other') THEN
            RAISE EXCEPTION 'Please select a valid account type for every credit account.' USING ERRCODE = '22023';
        END IF;
        IF v_lender IS NULL THEN
            RAISE EXCEPTION 'Please enter the lender name for every credit account.' USING ERRCODE = '22023';
        END IF;
        IF v_account_ref <> '' AND v_account_ref !~ '^[A-Z0-9]{4}$' THEN
            RAISE EXCEPTION 'Enter only the last 4 letters or digits of each account reference.' USING ERRCODE = '22023';
        END IF;
        IF v_account_status NOT IN (
            'Active', 'Closed', 'Overdue', 'Settled', 'Written Off',
            'Restructured', 'Not sure') THEN
            RAISE EXCEPTION 'Please select a valid status for every credit account.' USING ERRCODE = '22023';
        END IF;
        IF v_account_outstanding IS NOT NULL AND v_account_outstanding < 0 THEN
            RAISE EXCEPTION 'The outstanding amount cannot be negative.' USING ERRCODE = '22023';
        END IF;
        IF v_account_emi IS NOT NULL AND v_account_emi < 0 THEN
            RAISE EXCEPTION 'The EMI amount cannot be negative.' USING ERRCODE = '22023';
        END IF;
        IF v_account_overdue IS NOT NULL AND v_account_overdue < 0 THEN
            RAISE EXCEPTION 'The overdue amount cannot be negative.' USING ERRCODE = '22023';
        END IF;
        IF v_account_dpd IS NOT NULL AND (v_account_dpd < 0 OR v_account_dpd > 999) THEN
            RAISE EXCEPTION 'Days past due must be between 0 and 999.' USING ERRCODE = '22023';
        END IF;
        IF v_account_opened IS NOT NULL AND v_account_opened > (now() AT TIME ZONE 'Asia/Kolkata')::date THEN
            RAISE EXCEPTION 'An account opening date cannot be in the future.' USING ERRCODE = '22023';
        END IF;
        IF v_account_closed IS NOT NULL AND v_account_closed > (now() AT TIME ZONE 'Asia/Kolkata')::date THEN
            RAISE EXCEPTION 'An account closure date cannot be in the future.' USING ERRCODE = '22023';
        END IF;
        IF v_account_opened IS NOT NULL AND v_account_closed IS NOT NULL AND v_account_closed < v_account_opened THEN
            RAISE EXCEPTION 'An account closure date cannot be before its opening date.' USING ERRCODE = '22023';
        END IF;
        IF v_account_settled IS NOT NULL AND v_account_settled < 0 THEN
            RAISE EXCEPTION 'The settled amount cannot be negative.' USING ERRCODE = '22023';
        END IF;

        v_accounts := jsonb_set(
            v_accounts,
            ARRAY[(v_account_index - 1)::TEXT],
            v_account || jsonb_build_object('account_reference_last4', nullif(v_account_ref, '')),
            true
        );
    END LOOP;

    -- ---- Disclosed enquiries ----------------------------------------------
    IF jsonb_typeof(v_enquiries) <> 'array' THEN
        RAISE EXCEPTION 'Please provide the credit enquiry details in the expected format.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(v_enquiries) > 20 THEN
        RAISE EXCEPTION 'Please provide no more than 20 credit enquiries.' USING ERRCODE = '22023';
    END IF;

    FOR v_enquiry IN SELECT * FROM jsonb_array_elements(v_enquiries)
    LOOP
        v_enquiry_index := v_enquiry_index + 1;

        v_enquiry_bureau := btrim(coalesce(v_enquiry->>'bureau', ''));
        v_enquiry_institution := nullif(btrim(coalesce(v_enquiry->>'institution_name', '')), '');
        v_enquiry_date := nullif(v_enquiry->>'enquiry_date', '')::DATE;
        v_enquiry_purpose := btrim(coalesce(v_enquiry->>'purpose', ''));
        v_enquiry_status := btrim(coalesce(v_enquiry->>'status', ''));
        v_enquiry_remarks := nullif(btrim(coalesce(v_enquiry->>'remarks', '')), '');

        IF v_enquiry_bureau NOT IN (
            'CIBIL', 'Experian', 'CRIF High Mark', 'Equifax',
            'Multiple bureaus', 'Not sure') THEN
            RAISE EXCEPTION 'Please select a valid bureau for every credit enquiry.' USING ERRCODE = '22023';
        END IF;
        IF v_enquiry_institution IS NULL THEN
            RAISE EXCEPTION 'Please enter the institution name for every credit enquiry.' USING ERRCODE = '22023';
        END IF;
        IF v_enquiry_date IS NULL THEN
            RAISE EXCEPTION 'Please enter the date for every credit enquiry.' USING ERRCODE = '22023';
        END IF;
        IF v_enquiry_date > (now() AT TIME ZONE 'Asia/Kolkata')::date THEN
            RAISE EXCEPTION 'A credit enquiry date cannot be in the future.' USING ERRCODE = '22023';
        END IF;
        IF v_enquiry_purpose NOT IN (
            'Loan application', 'Credit card application',
            'Existing customer review', 'Background / employment check',
            'Other', 'Not sure') THEN
            RAISE EXCEPTION 'Please select a valid purpose for every credit enquiry.' USING ERRCODE = '22023';
        END IF;
        IF v_enquiry_status NOT IN ('Approved', 'Rejected', 'Pending', 'Not sure') THEN
            RAISE EXCEPTION 'Please select a valid status for every credit enquiry.' USING ERRCODE = '22023';
        END IF;
    END LOOP;

    -- ---- Declarations and consent -----------------------------------------
    IF NOT v_accuracy THEN
        RAISE EXCEPTION 'Please confirm that the information provided is true and complete.' USING ERRCODE = '22023';
    END IF;
    IF NOT v_bureau_consent THEN
        RAISE EXCEPTION 'Please authorise Dhanvi Finserv and the selected bureau to obtain or review your credit report.' USING ERRCODE = '22023';
    END IF;
    IF NOT v_no_guarantee THEN
        RAISE EXCEPTION 'Please confirm that you understand no score increase or loan approval is guaranteed.' USING ERRCODE = '22023';
    END IF;
    IF NOT v_consent THEN
        RAISE EXCEPTION 'Please accept the privacy notice and credit advisory consent before submitting.' USING ERRCODE = '22023';
    END IF;

    v_message := left(
        'Credit health service: ' || v_service ||
        ' | Bureau: ' || v_bureau_pref ||
        ' | Profile: ' || v_profile_status ||
        ' | Running loans: ' || v_running_count::TEXT ||
        CASE WHEN v_current_score IS NOT NULL THEN ' | Self-reported score: ' || v_current_score::TEXT ELSE '' END ||
        CASE WHEN v_target_loan_type IS NOT NULL THEN ' | Target: ' || v_target_loan_type ELSE '' END,
        1000
    );

    -- ---- Create the lead ---------------------------------------------------
    INSERT INTO public.loan_leads (
        full_name, mobile, email, loan_type, loan_amount, message,
        applicant_type, residency_status, employment_type,
        consent_given, consent_at, consent_version, source_page
    ) VALUES (
        v_name, v_mobile, v_email, 'Credit Health / CIBIL Advisory', 0, v_message,
        'resident', 'Resident', v_occupation,
        true, now(), v_consent_version, v_source
    )
    RETURNING id, reference_no, access_token INTO v_id, v_ref, v_token;

    -- ---- Structured credit health details ---------------------------------
    INSERT INTO public.credit_health_details (
        loan_lead_id, applicant_name, date_of_birth, gender, mobile, email,
        pan_number, occupation, annual_income,
        address_line, address_city, address_district, address_state, address_pincode,
        service_type, bureau_preference,
        needs_report_help, needs_profile_analysis, needs_improvement_guidance,
        needs_eligibility_assessment,
        current_score, current_score_date, score_source,
        target_loan_type, target_loan_amount, target_lender, target_timeline, concerns,
        profile_status, running_loans_count, total_outstanding, total_emi,
        overdue_accounts, overdue_details, settlement_history, settlement_details,
        existing_report_available, existing_report_date, existing_report_source,
        bureau_consent, bureau_consent_at, bureau_consent_version,
        accuracy_declaration, no_guarantee_declaration
    ) VALUES (
        v_id, v_name, v_dob, v_gender, v_mobile, v_email,
        v_pan, v_occupation, v_income,
        v_line, v_city, v_district, v_state, v_pin,
        v_service, v_bureau_pref,
        v_needs_report, v_needs_analysis, v_needs_guidance,
        v_needs_eligibility,
        v_current_score, v_current_score_date, v_score_source,
        v_target_loan_type, v_target_amount, v_target_lender, v_target_timeline, v_concerns,
        v_profile_status, v_running_count, v_total_outstanding, v_total_emi,
        v_overdue, v_overdue_details, v_settlement, v_settlement_details,
        v_existing_report, v_existing_report_date, v_existing_report_source,
        true, now(), v_consent_version,
        true, true
    );

    -- ---- Disclosed credit accounts ----------------------------------------
    FOR v_account IN SELECT * FROM jsonb_array_elements(v_accounts)
    LOOP
        INSERT INTO public.credit_accounts (
            loan_lead_id, sort_order, account_type, lender_name,
            account_reference_last4, account_status, outstanding_amount,
            emi_amount, overdue_amount, days_past_due, opened_date, closed_date,
            settled_amount, remarks
        ) VALUES (
            v_id,
            coalesce(nullif(v_account->>'sort_order', '')::INTEGER,
                (SELECT count(*) + 1 FROM public.credit_accounts WHERE loan_lead_id = v_id)),
            btrim(coalesce(v_account->>'account_type', '')),
            btrim(coalesce(v_account->>'lender_name', '')),
            nullif(upper(regexp_replace(coalesce(v_account->>'account_reference_last4', ''), '[^A-Za-z0-9]', '', 'g')), ''),
            btrim(coalesce(v_account->>'account_status', '')),
            nullif(v_account->>'outstanding_amount', '')::NUMERIC,
            nullif(v_account->>'emi_amount', '')::NUMERIC,
            nullif(v_account->>'overdue_amount', '')::NUMERIC,
            nullif(v_account->>'days_past_due', '')::INTEGER,
            nullif(v_account->>'opened_date', '')::DATE,
            nullif(v_account->>'closed_date', '')::DATE,
            nullif(v_account->>'settled_amount', '')::NUMERIC,
            nullif(btrim(coalesce(v_account->>'remarks', '')), '')
        );
    END LOOP;

    -- ---- Disclosed credit enquiries ---------------------------------------
    FOR v_enquiry IN SELECT * FROM jsonb_array_elements(v_enquiries)
    LOOP
        INSERT INTO public.credit_enquiries (
            loan_lead_id, sort_order, bureau, institution_name, enquiry_date,
            purpose, status, remarks
        ) VALUES (
            v_id,
            coalesce(nullif(v_enquiry->>'sort_order', '')::INTEGER,
                (SELECT count(*) + 1 FROM public.credit_enquiries WHERE loan_lead_id = v_id)),
            btrim(coalesce(v_enquiry->>'bureau', '')),
            btrim(coalesce(v_enquiry->>'institution_name', '')),
            nullif(v_enquiry->>'enquiry_date', '')::DATE,
            btrim(coalesce(v_enquiry->>'purpose', '')),
            btrim(coalesce(v_enquiry->>'status', '')),
            nullif(btrim(coalesce(v_enquiry->>'remarks', '')), '')
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
        'full_name', v_name,
        'loan_type', 'Credit Health / CIBIL Advisory',
        'service_type', v_service,
        'bureau_preference', v_bureau_pref,
        'profile_status', v_profile_status,
        'report_status', 'Enquiry Received',
        'current_score', v_current_score
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Extra document types for credit health applications
-- -----------------------------------------------------------------------------
-- The checklist needs the credit report, a credit card statement, bureau
-- correspondence, a no-dues certificate and a settlement letter in addition to
-- the identity, income and loan documents already supported. Widen the CHECK
-- on public.loan_documents.document_type and re-register register_document()
-- with the same allowed list.

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
        'Insurer Quotation',
        'Credit Report', 'Credit Card Statement', 'Bureau Correspondence',
        'No Dues Certificate', 'Settlement Letter'
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
        'Insurer Quotation',
        'Credit Report', 'Credit Card Statement', 'Bureau Correspondence',
        'No Dues Certificate', 'Settlement Letter'
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

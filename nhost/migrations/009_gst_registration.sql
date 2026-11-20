-- =============================================================================
-- NHOST / HASURA MIGRATION: 009_gst_registration.sql
-- PROJECT: Dhanvi Finserv
--
-- Run this ONCE, after 008, in the Nhost dashboard:
--   Database -> SQL Editor -> paste -> Run
--
-- It adds the structured GST Registration & Filing assistance system behind
-- gst-apply.html:
--
--   1. public.gst_registration_details - applicant, PAN/Aadhaar reference,
--      business address, constitution, business activity, commencement,
--      turnover, GSTIN, service type, registration type, filing frequency,
--      return period, previous filing status, sales/purchases, tax liability,
--      authorised signatory, bank details and the administrator-controlled
--      filing / payment / verification fields.
--   2. public.gst_return_filings        - one row per return period declared
--      for filing or compliance assistance (1:N with the lead), used for the
--      admin return tracking list.
--   3. submit_gst_application()         - validate and create a GST assistance
--      application (loan_leads + gst_registration_details + return rows) and
--      consume the shared draft.
--   4. Extra document types (GST Certificate, Invoices, Purchase Bills, Rent
--      Agreement / NOC, Certificate of Incorporation, Partnership Deed, Board
--      Resolution, Authorisation Letter, Address Proof, Bank Proof) added to
--      public.loan_documents.document_type and to register_document().
--   5. Re-asserts the widened loan_leads.loan_type and loan_amount constraints
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
--   * A GST return or registration is never marked as filed by this migration
--     or by the wizard. Filing status starts at 'Application Received' and only
--     an administrator can move it to 'Filed & Verified' after actual portal
--     submission and ARN / acknowledgement verification.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Allow service applications on the shared loan_leads table
-- -----------------------------------------------------------------------------
-- Migration 008 already widened these constraints. This block is idempotent so
-- 009 can be run safely even if 008 was applied in a different order.

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
-- 1. GST Registration & Filing details (1:1 with loan_leads)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.gst_registration_details (
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
            'Aadhaar authentication at GST portal',
            'Non-Aadhaar / physical verification',
            'Not applicable / exempt',
            'Not sure - advise me')),

    -- Administrator-controlled identity verification
    identity_verification_status TEXT NOT NULL DEFAULT 'Pending'
        CHECK (identity_verification_status IN ('Pending', 'Verified', 'Rejected')),
    identity_verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    identity_verified_at TIMESTAMPTZ,
    identity_notes TEXT,

    -- Principal place of business / applicant address
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
            'Public Limited Company', 'HUF', 'Trust / Society', 'Other')),
    business_nature TEXT NOT NULL
        CHECK (business_nature IN ('Goods', 'Services', 'Both Goods and Services')),
    business_activity TEXT NOT NULL,
    nic_code TEXT,
    commencement_date DATE,
    annual_turnover NUMERIC CHECK (annual_turnover IS NULL OR annual_turnover >= 0),
    employee_count INTEGER CHECK (employee_count IS NULL OR employee_count >= 0),
    gstin TEXT,
    existing_registrations TEXT,

    -- Service requirement
    service_type TEXT NOT NULL
        CHECK (service_type IN (
            'New GST Registration', 'GST Return Filing', 'GST Amendment',
            'GST Cancellation', 'GST Compliance Assistance')),
    registration_type TEXT
        CHECK (registration_type IS NULL OR registration_type IN (
            'Regular', 'Composition', 'Voluntary', 'Not sure - advise me')),
    filing_frequency TEXT
        CHECK (filing_frequency IS NULL OR filing_frequency IN (
            'Monthly', 'Quarterly (QRMP)', 'Composition - Quarterly',
            'Annual', 'Not applicable')),
    return_period TEXT,
    financial_year TEXT,
    return_type_preference TEXT
        CHECK (return_type_preference IS NULL OR return_type_preference IN (
            'GSTR-1', 'GSTR-3B', 'GSTR-9', 'GSTR-9C', 'CMP-08', 'GSTR-4',
            'Multiple / all applicable', 'Not sure - advise me')),
    previous_filing_status TEXT
        CHECK (previous_filing_status IS NULL OR previous_filing_status IN (
            'All returns filed', 'Some returns pending',
            'No returns filed', 'Not registered yet')),
    last_return_filed_on DATE,
    pending_returns INTEGER CHECK (pending_returns IS NULL OR pending_returns >= 0),
    amendment_type TEXT
        CHECK (amendment_type IS NULL OR amendment_type IN (
            'Core amendment', 'Non-core amendment', 'Not applicable')),
    amendment_details TEXT,
    cancellation_reason TEXT,
    cancellation_effective_date DATE,
    compliance_areas TEXT,

    -- Declared sales, purchases, input tax credit and tax position
    sales_taxable NUMERIC CHECK (sales_taxable IS NULL OR sales_taxable >= 0),
    sales_exempt NUMERIC CHECK (sales_exempt IS NULL OR sales_exempt >= 0),
    sales_zero_rated NUMERIC CHECK (sales_zero_rated IS NULL OR sales_zero_rated >= 0),
    purchases NUMERIC CHECK (purchases IS NULL OR purchases >= 0),
    itc_claimed NUMERIC CHECK (itc_claimed IS NULL OR itc_claimed >= 0),
    tax_liability NUMERIC CHECK (tax_liability IS NULL OR tax_liability >= 0),
    tax_paid NUMERIC CHECK (tax_paid IS NULL OR tax_paid >= 0),
    late_fee_interest NUMERIC CHECK (late_fee_interest IS NULL OR late_fee_interest >= 0),
    net_tax_payable NUMERIC,
    invoice_count INTEGER CHECK (invoice_count IS NULL OR invoice_count >= 0),
    purchase_invoice_count INTEGER
        CHECK (purchase_invoice_count IS NULL OR purchase_invoice_count >= 0),

    -- Authorised signatory
    signatory_name TEXT NOT NULL,
    signatory_designation TEXT NOT NULL,
    signatory_pan TEXT,
    signatory_din TEXT,
    signatory_mobile TEXT,
    signatory_email TEXT,
    signatory_address TEXT,
    partner_count INTEGER CHECK (partner_count IS NULL OR partner_count >= 0),
    director_count INTEGER CHECK (director_count IS NULL OR director_count >= 0),

    -- Bank details (masked account number only)
    bank_name TEXT,
    bank_account_number_masked TEXT,
    bank_ifsc TEXT,
    bank_branch TEXT,
    bank_account_type TEXT
        CHECK (bank_account_type IS NULL OR bank_account_type IN (
            'Current', 'Savings', 'Cash Credit / OD', 'Other')),

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

    -- Administrator-controlled payment tracking
    payment_status TEXT NOT NULL DEFAULT 'Not Applicable'
        CHECK (payment_status IN (
            'Not Applicable', 'Pending', 'Paid', 'Partially Paid', 'Refund Due')),
    payment_reference TEXT,
    payment_amount NUMERIC CHECK (payment_amount IS NULL OR payment_amount >= 0),
    payment_date DATE,
    payment_notes TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gst_registration_details_lead_idx
    ON public.gst_registration_details (loan_lead_id);
CREATE INDEX IF NOT EXISTS gst_registration_details_identity_idx
    ON public.gst_registration_details (identity_verification_status);
CREATE INDEX IF NOT EXISTS gst_registration_details_pan_idx
    ON public.gst_registration_details (pan_number);
CREATE INDEX IF NOT EXISTS gst_registration_details_gstin_idx
    ON public.gst_registration_details (gstin);
CREATE INDEX IF NOT EXISTS gst_registration_details_service_idx
    ON public.gst_registration_details (service_type);
CREATE INDEX IF NOT EXISTS gst_registration_details_filing_idx
    ON public.gst_registration_details (filing_status);
CREATE INDEX IF NOT EXISTS gst_registration_details_return_period_idx
    ON public.gst_registration_details (return_period);
CREATE INDEX IF NOT EXISTS gst_registration_details_state_idx
    ON public.gst_registration_details (address_state);

DROP TRIGGER IF EXISTS update_gst_registration_details_modtime
    ON public.gst_registration_details;
CREATE TRIGGER update_gst_registration_details_modtime
    BEFORE UPDATE ON public.gst_registration_details
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. Declared return periods (1:N with loan_leads)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.gst_return_filings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_lead_id UUID NOT NULL REFERENCES public.loan_leads(id) ON DELETE CASCADE,
    return_type TEXT NOT NULL
        CHECK (return_type IN (
            'GSTR-1', 'GSTR-3B', 'GSTR-9', 'GSTR-9C', 'CMP-08', 'GSTR-4', 'Other')),
    return_period TEXT NOT NULL,
    financial_year TEXT,
    filing_status TEXT NOT NULL DEFAULT 'Pending'
        CHECK (filing_status IN (
            'Pending', 'Prepared', 'Client Approval Pending',
            'Filed - Awaiting Verification', 'Filed & Verified',
            'Late Filed', 'Not Applicable')),
    arn TEXT,
    filed_at DATE,
    tax_payable NUMERIC CHECK (tax_payable IS NULL OR tax_payable >= 0),
    tax_paid NUMERIC CHECK (tax_paid IS NULL OR tax_paid >= 0),
    late_fee NUMERIC CHECK (late_fee IS NULL OR late_fee >= 0),
    interest NUMERIC CHECK (interest IS NULL OR interest >= 0),
    remarks TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS gst_return_filings_lead_idx
    ON public.gst_return_filings (loan_lead_id);
CREATE INDEX IF NOT EXISTS gst_return_filings_period_idx
    ON public.gst_return_filings (return_period);
CREATE INDEX IF NOT EXISTS gst_return_filings_status_idx
    ON public.gst_return_filings (filing_status);

DROP TRIGGER IF EXISTS update_gst_return_filings_modtime
    ON public.gst_return_filings;
CREATE TRIGGER update_gst_return_filings_modtime
    BEFORE UPDATE ON public.gst_return_filings
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. Submit a GST Registration & Filing application
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_gst_application(
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
    v_financials JSONB := coalesce(p_payload->'financials', '{}'::JSONB);
    v_signatory JSONB := coalesce(p_payload->'signatory', '{}'::JSONB);
    v_bank JSONB := coalesce(p_payload->'bank', '{}'::JSONB);
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
    v_nature TEXT := btrim(coalesce(v_business->>'business_nature', ''));
    v_activity TEXT := nullif(btrim(coalesce(v_business->>'business_activity', '')), '');
    v_nic TEXT := nullif(btrim(coalesce(v_business->>'nic_code', '')), '');
    v_commencement DATE := nullif(v_business->>'commencement_date', '')::DATE;
    v_turnover NUMERIC := nullif(v_business->>'annual_turnover', '')::NUMERIC;
    v_employees INTEGER := nullif(v_business->>'employee_count', '')::INTEGER;
    v_gstin TEXT := upper(nullif(btrim(coalesce(v_business->>'gstin', '')), ''));
    v_existing_regs TEXT := nullif(btrim(coalesce(v_business->>'existing_registrations', '')), '');

    v_service_type TEXT := btrim(coalesce(v_service->>'service_type', ''));
    v_reg_type TEXT := nullif(btrim(coalesce(v_service->>'registration_type', '')), '');
    v_frequency TEXT := nullif(btrim(coalesce(v_service->>'filing_frequency', '')), '');
    v_return_period TEXT := nullif(btrim(coalesce(v_service->>'return_period', '')), '');
    v_fy TEXT := nullif(btrim(coalesce(v_service->>'financial_year', '')), '');
    v_return_type TEXT := nullif(btrim(coalesce(v_service->>'return_type_preference', '')), '');
    v_prev_status TEXT := nullif(btrim(coalesce(v_service->>'previous_filing_status', '')), '');
    v_last_filed DATE := nullif(v_service->>'last_return_filed_on', '')::DATE;
    v_pending INTEGER := nullif(v_service->>'pending_returns', '')::INTEGER;
    v_amendment_type TEXT := nullif(btrim(coalesce(v_service->>'amendment_type', '')), '');
    v_amendment_details TEXT := nullif(btrim(coalesce(v_service->>'amendment_details', '')), '');
    v_cancel_reason TEXT := nullif(btrim(coalesce(v_service->>'cancellation_reason', '')), '');
    v_cancel_date DATE := nullif(v_service->>'cancellation_effective_date', '')::DATE;
    v_compliance_areas TEXT := nullif(btrim(coalesce(v_service->>'compliance_areas', '')), '');

    v_sales_taxable NUMERIC := nullif(v_financials->>'sales_taxable', '')::NUMERIC;
    v_sales_exempt NUMERIC := nullif(v_financials->>'sales_exempt', '')::NUMERIC;
    v_sales_zero NUMERIC := nullif(v_financials->>'sales_zero_rated', '')::NUMERIC;
    v_purchases NUMERIC := nullif(v_financials->>'purchases', '')::NUMERIC;
    v_itc NUMERIC := nullif(v_financials->>'itc_claimed', '')::NUMERIC;
    v_liability NUMERIC := nullif(v_financials->>'tax_liability', '')::NUMERIC;
    v_tax_paid NUMERIC := nullif(v_financials->>'tax_paid', '')::NUMERIC;
    v_late_fee NUMERIC := nullif(v_financials->>'late_fee_interest', '')::NUMERIC;
    v_invoice_count INTEGER := nullif(v_financials->>'invoice_count', '')::INTEGER;
    v_purchase_invoice_count INTEGER := nullif(v_financials->>'purchase_invoice_count', '')::INTEGER;
    v_net_tax NUMERIC;

    v_sig_name TEXT := nullif(btrim(coalesce(v_signatory->>'signatory_name', '')), '');
    v_sig_designation TEXT := nullif(btrim(coalesce(v_signatory->>'signatory_designation', '')), '');
    v_sig_pan TEXT := upper(nullif(btrim(coalesce(v_signatory->>'signatory_pan', '')), ''));
    v_sig_din TEXT := nullif(btrim(coalesce(v_signatory->>'signatory_din', '')), '');
    v_sig_mobile TEXT := nullif(regexp_replace(coalesce(v_signatory->>'signatory_mobile', ''), '[^0-9]', '', 'g'), '');
    v_sig_email TEXT := nullif(lower(btrim(coalesce(v_signatory->>'signatory_email', ''))), '');
    v_sig_address TEXT := nullif(btrim(coalesce(v_signatory->>'signatory_address', '')), '');
    v_partners INTEGER := nullif(v_signatory->>'partner_count', '')::INTEGER;
    v_directors INTEGER := nullif(v_signatory->>'director_count', '')::INTEGER;

    v_bank_name TEXT := nullif(btrim(coalesce(v_bank->>'bank_name', '')), '');
    v_bank_account TEXT := nullif(regexp_replace(coalesce(v_bank->>'bank_account_number', ''), '[^0-9]', '', 'g'), '');
    v_bank_masked TEXT;
    v_bank_ifsc TEXT := upper(nullif(btrim(coalesce(v_bank->>'bank_ifsc', '')), ''));
    v_bank_branch TEXT := nullif(btrim(coalesce(v_bank->>'bank_branch', '')), '');
    v_bank_type TEXT := nullif(btrim(coalesce(v_bank->>'bank_account_type', '')), '');

    v_accuracy BOOLEAN := coalesce((v_declarations->>'accuracy')::BOOLEAN, false);
    v_authorisation BOOLEAN := coalesce((v_declarations->>'authorisation')::BOOLEAN, false);
    v_consent BOOLEAN := coalesce((p_payload->>'consent')::BOOLEAN, false);
    v_consent_version TEXT := coalesce(nullif(p_payload->>'consent_version', ''), '2026-11');
    v_source TEXT := nullif(btrim(coalesce(p_payload->>'source_page', '')), '');

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
        RAISE EXCEPTION 'Please enter the applicant or authorised signatory name.' USING ERRCODE = '22023';
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
        'Aadhaar authentication at GST portal',
        'Non-Aadhaar / physical verification',
        'Not applicable / exempt',
        'Not sure - advise me') THEN
        RAISE EXCEPTION 'Please choose a valid Aadhaar verification method.' USING ERRCODE = '22023';
    END IF;

    -- ---- Address -----------------------------------------------------------
    IF v_line IS NULL OR v_city IS NULL OR v_state IS NULL THEN
        RAISE EXCEPTION 'Please enter the complete principal place of business address.' USING ERRCODE = '22023';
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
        'Public Limited Company', 'HUF', 'Trust / Society', 'Other') THEN
        RAISE EXCEPTION 'Please select a valid constitution of business.' USING ERRCODE = '22023';
    END IF;
    IF v_nature NOT IN ('Goods', 'Services', 'Both Goods and Services') THEN
        RAISE EXCEPTION 'Please select whether you supply goods, services or both.' USING ERRCODE = '22023';
    END IF;
    IF v_activity IS NULL THEN
        RAISE EXCEPTION 'Please describe your main business activity.' USING ERRCODE = '22023';
    END IF;
    IF v_turnover IS NOT NULL AND v_turnover < 0 THEN
        RAISE EXCEPTION 'Annual turnover cannot be negative.' USING ERRCODE = '22023';
    END IF;
    IF v_employees IS NOT NULL AND v_employees < 0 THEN
        RAISE EXCEPTION 'Please enter a valid employee count.' USING ERRCODE = '22023';
    END IF;
    IF v_commencement IS NOT NULL AND v_commencement > (now() AT TIME ZONE 'Asia/Kolkata')::date THEN
        RAISE EXCEPTION 'Date of commencement cannot be in the future.' USING ERRCODE = '22023';
    END IF;
    IF v_gstin IS NOT NULL AND v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' THEN
        RAISE EXCEPTION 'Please enter a valid 15-character GSTIN.' USING ERRCODE = '22023';
    END IF;

    -- ---- Service requirement ----------------------------------------------
    IF v_service_type NOT IN (
        'New GST Registration', 'GST Return Filing', 'GST Amendment',
        'GST Cancellation', 'GST Compliance Assistance') THEN
        RAISE EXCEPTION 'Please select a valid GST service.' USING ERRCODE = '22023';
    END IF;
    IF v_service_type = 'New GST Registration' AND v_commencement IS NULL THEN
        RAISE EXCEPTION 'Please enter the date of commencement of business.' USING ERRCODE = '22023';
    END IF;
    IF v_service_type = 'New GST Registration' AND v_aadhaar_method IS NULL THEN
        RAISE EXCEPTION 'Please select the Aadhaar authentication method for the new registration.' USING ERRCODE = '22023';
    END IF;
    IF v_service_type = 'New GST Registration' AND v_reg_type IS NULL THEN
        RAISE EXCEPTION 'Please select the registration type for the new registration.' USING ERRCODE = '22023';
    END IF;
    IF v_service_type <> 'New GST Registration' AND v_gstin IS NULL THEN
        RAISE EXCEPTION 'Please enter the existing GSTIN for this service.' USING ERRCODE = '22023';
    END IF;
    IF v_reg_type IS NOT NULL AND v_reg_type NOT IN (
        'Regular', 'Composition', 'Voluntary', 'Not sure - advise me') THEN
        RAISE EXCEPTION 'Please select a valid registration type.' USING ERRCODE = '22023';
    END IF;
    IF v_frequency IS NOT NULL AND v_frequency NOT IN (
        'Monthly', 'Quarterly (QRMP)', 'Composition - Quarterly',
        'Annual', 'Not applicable') THEN
        RAISE EXCEPTION 'Please select a valid filing frequency.' USING ERRCODE = '22023';
    END IF;
    IF v_return_period IS NOT NULL AND v_return_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
        RAISE EXCEPTION 'Please select a valid return period.' USING ERRCODE = '22023';
    END IF;
    IF v_service_type = 'GST Return Filing' AND v_return_period IS NULL THEN
        RAISE EXCEPTION 'Please select the return period being filed.' USING ERRCODE = '22023';
    END IF;
    IF v_service_type = 'GST Return Filing' AND v_frequency IS NULL THEN
        RAISE EXCEPTION 'Please select the GST filing frequency.' USING ERRCODE = '22023';
    END IF;
    IF v_service_type = 'GST Return Filing' AND v_return_type IS NULL THEN
        RAISE EXCEPTION 'Please select the return type being filed.' USING ERRCODE = '22023';
    END IF;
    IF v_service_type = 'GST Return Filing' AND v_prev_status IS NULL THEN
        RAISE EXCEPTION 'Please select the previous filing status.' USING ERRCODE = '22023';
    END IF;
    IF v_fy IS NOT NULL AND v_fy !~ '^[0-9]{4}-[0-9]{2}$' THEN
        RAISE EXCEPTION 'Please select a valid financial year.' USING ERRCODE = '22023';
    END IF;
    IF v_return_type IS NOT NULL AND v_return_type NOT IN (
        'GSTR-1', 'GSTR-3B', 'GSTR-9', 'GSTR-9C', 'CMP-08', 'GSTR-4',
        'Multiple / all applicable', 'Not sure - advise me') THEN
        RAISE EXCEPTION 'Please select a valid return type.' USING ERRCODE = '22023';
    END IF;
    IF v_prev_status IS NOT NULL AND v_prev_status NOT IN (
        'All returns filed', 'Some returns pending',
        'No returns filed', 'Not registered yet') THEN
        RAISE EXCEPTION 'Please select a valid previous filing status.' USING ERRCODE = '22023';
    END IF;
    IF v_pending IS NOT NULL AND v_pending < 0 THEN
        RAISE EXCEPTION 'Pending returns cannot be negative.' USING ERRCODE = '22023';
    END IF;
    IF v_amendment_type IS NOT NULL AND v_amendment_type NOT IN (
        'Core amendment', 'Non-core amendment', 'Not applicable') THEN
        RAISE EXCEPTION 'Please select a valid amendment type.' USING ERRCODE = '22023';
    END IF;
    IF v_service_type = 'GST Amendment' AND v_amendment_details IS NULL THEN
        RAISE EXCEPTION 'Please describe the amendment required.' USING ERRCODE = '22023';
    END IF;
    IF v_service_type = 'GST Cancellation' AND v_cancel_reason IS NULL THEN
        RAISE EXCEPTION 'Please provide the reason for cancellation.' USING ERRCODE = '22023';
    END IF;

    -- ---- Financial position ------------------------------------------------
    IF v_sales_taxable IS NOT NULL AND v_sales_taxable < 0 THEN
        RAISE EXCEPTION 'Taxable sales cannot be negative.' USING ERRCODE = '22023';
    END IF;
    IF v_sales_exempt IS NOT NULL AND v_sales_exempt < 0 THEN
        RAISE EXCEPTION 'Exempt sales cannot be negative.' USING ERRCODE = '22023';
    END IF;
    IF v_sales_zero IS NOT NULL AND v_sales_zero < 0 THEN
        RAISE EXCEPTION 'Zero-rated sales cannot be negative.' USING ERRCODE = '22023';
    END IF;
    IF v_purchases IS NOT NULL AND v_purchases < 0 THEN
        RAISE EXCEPTION 'Purchases cannot be negative.' USING ERRCODE = '22023';
    END IF;
    IF v_itc IS NOT NULL AND v_itc < 0 THEN
        RAISE EXCEPTION 'Input tax credit cannot be negative.' USING ERRCODE = '22023';
    END IF;
    IF v_liability IS NOT NULL AND v_liability < 0 THEN
        RAISE EXCEPTION 'Tax liability cannot be negative.' USING ERRCODE = '22023';
    END IF;
    IF v_tax_paid IS NOT NULL AND v_tax_paid < 0 THEN
        RAISE EXCEPTION 'Tax paid cannot be negative.' USING ERRCODE = '22023';
    END IF;
    IF v_late_fee IS NOT NULL AND v_late_fee < 0 THEN
        RAISE EXCEPTION 'Late fee and interest cannot be negative.' USING ERRCODE = '22023';
    END IF;
    IF v_invoice_count IS NOT NULL AND v_invoice_count < 0 THEN
        RAISE EXCEPTION 'Invoice count cannot be negative.' USING ERRCODE = '22023';
    END IF;
    IF v_purchase_invoice_count IS NOT NULL AND v_purchase_invoice_count < 0 THEN
        RAISE EXCEPTION 'Purchase invoice count cannot be negative.' USING ERRCODE = '22023';
    END IF;
    v_net_tax := coalesce(v_liability, 0) + coalesce(v_late_fee, 0) - coalesce(v_tax_paid, 0);

    -- ---- Authorised signatory ---------------------------------------------
    IF v_sig_name IS NULL OR v_sig_designation IS NULL THEN
        RAISE EXCEPTION 'Please enter the authorised signatory name and designation.' USING ERRCODE = '22023';
    END IF;
    IF v_sig_pan IS NOT NULL AND v_sig_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' THEN
        RAISE EXCEPTION 'Please enter a valid authorised signatory PAN.' USING ERRCODE = '22023';
    END IF;
    IF v_sig_mobile <> '' AND v_sig_mobile !~ '^[6-9][0-9]{9}$' THEN
        RAISE EXCEPTION 'Please enter a valid authorised signatory mobile number.' USING ERRCODE = '22023';
    END IF;
    IF v_sig_email IS NOT NULL AND v_sig_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
        RAISE EXCEPTION 'Please enter a valid authorised signatory email address.' USING ERRCODE = '22023';
    END IF;
    IF v_partners IS NOT NULL AND v_partners < 0 THEN
        RAISE EXCEPTION 'Partner count cannot be negative.' USING ERRCODE = '22023';
    END IF;
    IF v_directors IS NOT NULL AND v_directors < 0 THEN
        RAISE EXCEPTION 'Director count cannot be negative.' USING ERRCODE = '22023';
    END IF;

    -- ---- Bank details ------------------------------------------------------
    IF v_bank_name IS NULL THEN
        RAISE EXCEPTION 'Please enter the bank name.' USING ERRCODE = '22023';
    END IF;
    IF v_bank_account IS NULL OR v_bank_account !~ '^[0-9]{6,18}$' THEN
        RAISE EXCEPTION 'Please enter a valid 6-18 digit bank account number.' USING ERRCODE = '22023';
    END IF;
    v_bank_masked := repeat('X', length(v_bank_account) - 4) || right(v_bank_account, 4);
    IF v_bank_ifsc IS NULL OR v_bank_ifsc !~ '^[A-Z]{4}0[A-Z0-9]{6}$' THEN
        RAISE EXCEPTION 'Please enter a valid 11-character IFSC code.' USING ERRCODE = '22023';
    END IF;
    IF v_bank_type IS NOT NULL AND v_bank_type NOT IN (
        'Current', 'Savings', 'Cash Credit / OD', 'Other') THEN
        RAISE EXCEPTION 'Please select a valid bank account type.' USING ERRCODE = '22023';
    END IF;

    -- ---- Declarations and consent -----------------------------------------
    IF NOT v_accuracy THEN
        RAISE EXCEPTION 'Please confirm that the information provided is true and complete.' USING ERRCODE = '22023';
    END IF;
    IF NOT v_authorisation THEN
        RAISE EXCEPTION 'Please authorise Dhanvi Finserv to prepare and file your GST application or return.' USING ERRCODE = '22023';
    END IF;
    IF NOT v_consent THEN
        RAISE EXCEPTION 'Please accept the privacy notice and GST consent before submitting.' USING ERRCODE = '22023';
    END IF;

    v_message := left(
        'GST service: ' || v_service_type ||
        CASE WHEN v_return_period IS NOT NULL THEN ' | Return period: ' || v_return_period ELSE '' END ||
        CASE WHEN v_gstin IS NOT NULL THEN ' | GSTIN: ' || v_gstin ELSE '' END ||
        CASE WHEN v_activity IS NOT NULL THEN ' | Activity: ' || v_activity ELSE '' END,
        1000
    );

    -- ---- Create the lead ---------------------------------------------------
    INSERT INTO public.loan_leads (
        full_name, mobile, email, loan_type, loan_amount, message,
        applicant_type, residency_status, employment_type,
        consent_given, consent_at, consent_version, source_page
    ) VALUES (
        v_name, v_mobile, v_email, 'GST Registration & Filing',
        greatest(coalesce(v_turnover, 0), 0), v_message,
        'resident', 'Resident', 'Business Owner',
        true, now(), v_consent_version, v_source
    )
    RETURNING id, reference_no, access_token INTO v_id, v_ref, v_token;

    -- ---- Structured GST details -------------------------------------------
    INSERT INTO public.gst_registration_details (
        loan_lead_id, applicant_name, designation, mobile, email, pan_number,
        aadhaar_masked, aadhaar_verification_method,
        address_line, address_city, address_district, address_state, address_pincode,
        business_name, trade_name, constitution, business_nature, business_activity,
        nic_code, commencement_date, annual_turnover, employee_count, gstin,
        existing_registrations,
        service_type, registration_type, filing_frequency, return_period,
        financial_year, return_type_preference, previous_filing_status,
        last_return_filed_on, pending_returns, amendment_type, amendment_details,
        cancellation_reason, cancellation_effective_date, compliance_areas,
        sales_taxable, sales_exempt, sales_zero_rated, purchases, itc_claimed,
        tax_liability, tax_paid, late_fee_interest, net_tax_payable,
        invoice_count, purchase_invoice_count,
        signatory_name, signatory_designation, signatory_pan, signatory_din,
        signatory_mobile, signatory_email, signatory_address,
        partner_count, director_count,
        bank_name, bank_account_number_masked, bank_ifsc, bank_branch, bank_account_type
    ) VALUES (
        v_id, v_name, v_designation, v_mobile, v_email, v_pan,
        v_aadhaar_masked, v_aadhaar_method,
        v_line, v_city, v_district, v_state, v_pin,
        v_business_name, v_trade_name, v_constitution, v_nature, v_activity,
        v_nic, v_commencement, v_turnover, v_employees, v_gstin,
        v_existing_regs,
        v_service_type, v_reg_type, v_frequency, v_return_period,
        v_fy, v_return_type, v_prev_status,
        v_last_filed, v_pending, v_amendment_type, v_amendment_details,
        v_cancel_reason, v_cancel_date, v_compliance_areas,
        v_sales_taxable, v_sales_exempt, v_sales_zero, v_purchases, v_itc,
        v_liability, v_tax_paid, v_late_fee, v_net_tax,
        v_invoice_count, v_purchase_invoice_count,
        v_sig_name, v_sig_designation, v_sig_pan, v_sig_din,
        v_sig_mobile, v_sig_email, v_sig_address,
        v_partners, v_directors,
        v_bank_name, v_bank_masked, v_bank_ifsc, v_bank_branch, v_bank_type
    );

    -- ---- Declared return period -------------------------------------------
    IF v_return_period IS NOT NULL AND v_service_type IN (
        'GST Return Filing', 'GST Compliance Assistance') THEN
        INSERT INTO public.gst_return_filings (
            loan_lead_id, return_type, return_period, financial_year,
            filing_status, tax_payable, tax_paid, late_fee, remarks
        ) VALUES (
            v_id,
            CASE
                WHEN v_return_type IN ('GSTR-1', 'GSTR-3B', 'GSTR-9', 'GSTR-9C', 'CMP-08', 'GSTR-4')
                    THEN v_return_type
                ELSE 'Other'
            END,
            v_return_period, v_fy, 'Pending',
            greatest(v_net_tax, 0), v_tax_paid, v_late_fee,
            NULL
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
        'loan_type', 'GST Registration & Filing',
        'service_type', v_service_type,
        'gstin', v_gstin,
        'return_period', v_return_period,
        'filing_status', 'Application Received',
        'payment_status', 'Not Applicable'
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. Extra document types for GST Registration & Filing applications
-- -----------------------------------------------------------------------------
-- The GST checklist needs a GST certificate, invoices, purchase bills, rent
-- agreement / NOC, incorporation or partnership documents, board resolution,
-- authorisation letter, address proof and bank proof. Widen the CHECK on
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
        'Authorisation Letter', 'Address Proof', 'Bank Proof'
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
        'Authorisation Letter', 'Address Proof', 'Bank Proof'
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

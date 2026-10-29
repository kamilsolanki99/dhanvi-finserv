-- =============================================================================
-- NHOST / HASURA MIGRATION: 001_init.sql
-- PROJECT: Dhanvi Finserv
--
-- Run this file once in the Nhost dashboard:
--   Database -> SQL Editor -> paste -> Run
--
-- It creates:
--   1. The business tables used by the public website and admin panel.
--   2. Server-side validated RPCs exposed through Hasura custom functions.
--   3. The private "loan-documents" storage bucket.
--   4. The custom Hasura role name "admin" in auth.roles.
--
-- IMPORTANT
--   * This project uses Hasura permissions, NOT Postgres RLS.
--   * Do not enable RLS on these tables. Hasura decides who may read/write.
--   * The public website only reaches the database through the functions below.
--   * Every function that the website calls returns SETOF public.api_result so
--     Hasura can track it as a custom function.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- -----------------------------------------------------------------------------
-- 0. Helpers
-- -----------------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS public.df_reference_seq START WITH 1;

-- Human-readable references, e.g. DF-2026-00001, CB-2026-00002
CREATE OR REPLACE FUNCTION public.next_reference(p_prefix TEXT)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN p_prefix || '-' || to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY') || '-' ||
           lpad(nextval('public.df_reference_seq')::text, 5, '0');
END;
$$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

-- Hasura custom functions must return SETOF a tracked table. This table is
-- never populated by the application; it only carries JSON payloads back to
-- the browser. It is tracked in Hasura and given SELECT permission per role.
CREATE TABLE IF NOT EXISTS public.api_result (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payload JSONB NOT NULL DEFAULT '{}'::JSONB
);

-- -----------------------------------------------------------------------------
-- 1. Admin profiles
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.admin_profiles (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin')),
    full_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 2. Loan leads
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.loan_leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reference_no TEXT NOT NULL DEFAULT public.next_reference('DF'),
    access_token UUID NOT NULL DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    full_name TEXT NOT NULL,
    mobile TEXT NOT NULL,
    email TEXT,
    loan_type TEXT NOT NULL CHECK (loan_type IN (
        'Home Loan', 'Home Loan Top-Up', 'Home Loan Takeover',
        'Loan Against Property', 'Education Loan', 'Vehicle Loan',
        'Business Loan', 'Personal Loan'
    )),
    loan_amount NUMERIC NOT NULL CHECK (loan_amount >= 10000),
    message TEXT,
    status TEXT NOT NULL DEFAULT 'New' CHECK (status IN (
        'New', 'Contacted', 'In Progress', 'Pending', 'Under Review',
        'Documents Pending', 'Approved', 'Rejected', 'Closed'
    )),
    admin_notes TEXT,
    applicant_type TEXT NOT NULL DEFAULT 'resident'
        CHECK (applicant_type IN ('resident', 'nri')),
    country_of_residence TEXT,
    residency_status TEXT,
    employment_type TEXT,
    consent_given BOOLEAN NOT NULL DEFAULT false,
    consent_at TIMESTAMPTZ,
    consent_version TEXT,
    source_page TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS loan_leads_reference_no_key
    ON public.loan_leads (reference_no);
CREATE UNIQUE INDEX IF NOT EXISTS loan_leads_access_token_key
    ON public.loan_leads (access_token);
CREATE INDEX IF NOT EXISTS loan_leads_created_at_idx
    ON public.loan_leads (created_at DESC);
CREATE INDEX IF NOT EXISTS loan_leads_status_idx
    ON public.loan_leads (status);

-- -----------------------------------------------------------------------------
-- 3. Co-applicants and guarantors
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.loan_applicants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_lead_id UUID NOT NULL REFERENCES public.loan_leads(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('co_applicant', 'guarantor')),
    applicant_type TEXT NOT NULL DEFAULT 'resident'
        CHECK (applicant_type IN ('resident', 'nri')),
    full_name TEXT NOT NULL,
    relationship TEXT,
    date_of_birth DATE,
    email TEXT,
    mobile TEXT,
    country_code TEXT,
    country_of_residence TEXT,
    residency_status TEXT,
    employment_type TEXT,
    employer_name TEXT,
    monthly_income NUMERIC,
    income_currency TEXT DEFAULT 'INR',
    address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS loan_applicants_lead_idx
    ON public.loan_applicants (loan_lead_id);

-- -----------------------------------------------------------------------------
-- 4. Callback scheduling
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.callback_bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reference_no TEXT NOT NULL DEFAULT public.next_reference('CB'),
    loan_lead_id UUID REFERENCES public.loan_leads(id) ON DELETE SET NULL,
    application_reference TEXT,
    full_name TEXT NOT NULL,
    mobile TEXT NOT NULL,
    email TEXT,
    preferred_date DATE NOT NULL,
    preferred_slot TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'Pending'
        CHECK (status IN ('Pending', 'Confirmed', 'Completed', 'Cancelled', 'Rescheduled')),
    admin_notes TEXT,
    rescheduled_to_date DATE,
    rescheduled_to_slot TEXT,
    consent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS callback_bookings_reference_no_key
    ON public.callback_bookings (reference_no);
-- One active booking per slot. Cancelled bookings free the slot again.
CREATE UNIQUE INDEX IF NOT EXISTS callback_bookings_active_slot_key
    ON public.callback_bookings (preferred_date, preferred_slot)
    WHERE status IN ('Pending', 'Confirmed', 'Rescheduled');
CREATE INDEX IF NOT EXISTS callback_bookings_date_idx
    ON public.callback_bookings (preferred_date);
CREATE INDEX IF NOT EXISTS callback_bookings_status_idx
    ON public.callback_bookings (status);

-- -----------------------------------------------------------------------------
-- 5. Post-disbursal support requests
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.post_disbursal_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reference_no TEXT NOT NULL DEFAULT public.next_reference('PS'),
    loan_lead_id UUID REFERENCES public.loan_leads(id) ON DELETE SET NULL,
    loan_reference_no TEXT,
    full_name TEXT NOT NULL,
    mobile TEXT NOT NULL,
    email TEXT,
    request_type TEXT NOT NULL CHECK (request_type IN (
        'Repayment schedule', 'Foreclosure', 'Part payment',
        'Balance transfer / takeover', 'Top-up', 'Annual loan review', 'Other'
    )),
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'New'
        CHECK (status IN ('New', 'In Progress', 'Awaiting Customer', 'Resolved', 'Closed')),
    admin_notes TEXT,
    resolved_at TIMESTAMPTZ,
    consent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS post_disbursal_requests_reference_no_key
    ON public.post_disbursal_requests (reference_no);
CREATE INDEX IF NOT EXISTS post_disbursal_requests_status_idx
    ON public.post_disbursal_requests (status);

-- -----------------------------------------------------------------------------
-- 6. Complaint ticketing
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.complaints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_no TEXT NOT NULL DEFAULT public.next_reference('CMP'),
    loan_lead_id UUID REFERENCES public.loan_leads(id) ON DELETE SET NULL,
    full_name TEXT NOT NULL,
    mobile TEXT NOT NULL,
    email TEXT,
    category TEXT NOT NULL CHECK (category IN (
        'Loan application', 'Documentation', 'Interest rate or charges',
        'Disbursement delay', 'Staff conduct', 'Post-disbursal support',
        'Data privacy', 'Other'
    )),
    loan_reference_no TEXT,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Open'
        CHECK (status IN ('Open', 'Acknowledged', 'In Progress', 'Resolved', 'Closed')),
    resolution_details TEXT,
    consent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS complaints_ticket_no_key
    ON public.complaints (ticket_no);
CREATE INDEX IF NOT EXISTS complaints_status_idx
    ON public.complaints (status);

-- -----------------------------------------------------------------------------
-- 7. Documents (metadata only; files live in Nhost Storage)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.loan_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_lead_id UUID REFERENCES public.loan_leads(id) ON DELETE CASCADE,
    document_type TEXT NOT NULL CHECK (document_type IN (
        'PAN Card', 'Aadhaar Card', 'Salary Slips', 'ITR', 'Bank Statement',
        'Property Documents', 'Business Proof', 'Vehicle Documents',
        'Photograph', 'Other'
    )),
    -- Nhost Storage file UUID. The file itself is in the private bucket.
    storage_file_id UUID UNIQUE,
    file_name TEXT CHECK (file_name IS NULL OR length(file_name) <= 255),
    file_size BIGINT CHECK (file_size IS NULL OR (file_size > 0 AND file_size <= 5242880)),
    mime_type TEXT CHECK (mime_type IS NULL OR mime_type IN (
        'application/pdf', 'image/jpeg', 'image/png', 'image/webp'
    )),
    status TEXT NOT NULL DEFAULT 'Pending'
        CHECK (status IN ('Pending', 'Verified', 'Rejected')),
    verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    verification_date TIMESTAMPTZ,
    notes TEXT,
    uploaded_by TEXT NOT NULL DEFAULT 'admin'
        CHECK (uploaded_by IN ('customer', 'admin')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS loan_documents_lead_idx
    ON public.loan_documents (loan_lead_id);
CREATE INDEX IF NOT EXISTS loan_documents_status_idx
    ON public.loan_documents (status);

-- -----------------------------------------------------------------------------
-- 8. Follow-ups
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.loan_followups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_lead_id UUID REFERENCES public.loan_leads(id) ON DELETE CASCADE,
    scheduled_at TIMESTAMPTZ NOT NULL,
    interaction_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'Pending'
        CHECK (status IN ('Pending', 'Completed', 'Cancelled')),
    notes TEXT,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS loan_followups_scheduled_idx
    ON public.loan_followups (scheduled_at);

-- -----------------------------------------------------------------------------
-- 9. updated_at triggers
-- -----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS update_loan_leads_modtime ON public.loan_leads;
CREATE TRIGGER update_loan_leads_modtime
    BEFORE UPDATE ON public.loan_leads
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

DROP TRIGGER IF EXISTS update_admin_profiles_modtime ON public.admin_profiles;
CREATE TRIGGER update_admin_profiles_modtime
    BEFORE UPDATE ON public.admin_profiles
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

DROP TRIGGER IF EXISTS update_loan_documents_modtime ON public.loan_documents;
CREATE TRIGGER update_loan_documents_modtime
    BEFORE UPDATE ON public.loan_documents
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

DROP TRIGGER IF EXISTS update_callback_bookings_modtime ON public.callback_bookings;
CREATE TRIGGER update_callback_bookings_modtime
    BEFORE UPDATE ON public.callback_bookings
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

DROP TRIGGER IF EXISTS update_post_disbursal_requests_modtime ON public.post_disbursal_requests;
CREATE TRIGGER update_post_disbursal_requests_modtime
    BEFORE UPDATE ON public.post_disbursal_requests
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

DROP TRIGGER IF EXISTS update_complaints_modtime ON public.complaints;
CREATE TRIGGER update_complaints_modtime
    BEFORE UPDATE ON public.complaints
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 10. Private storage bucket
-- -----------------------------------------------------------------------------

-- Nhost Storage bucket columns: id, download_expiration (seconds),
-- min_upload_file_size, max_upload_file_size, cache_control,
-- presigned_urls_enabled. There is no public/name column.
INSERT INTO storage.buckets (
    id, max_upload_file_size, min_upload_file_size,
    presigned_urls_enabled, download_expiration, cache_control
) VALUES (
    'loan-documents', 5242880, 1, true, 60, 'private, max-age=0'
)
ON CONFLICT (id) DO UPDATE
SET max_upload_file_size = EXCLUDED.max_upload_file_size,
    min_upload_file_size = EXCLUDED.min_upload_file_size,
    presigned_urls_enabled = EXCLUDED.presigned_urls_enabled,
    download_expiration = EXCLUDED.download_expiration,
    cache_control = EXCLUDED.cache_control;

-- -----------------------------------------------------------------------------
-- 11. Public submission functions
-- -----------------------------------------------------------------------------

-- 11.1 Loan application with NRI / co-applicant / guarantor support
CREATE OR REPLACE FUNCTION public.submit_loan_application_v2(p_payload JSONB)
RETURNS SETOF public.api_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id UUID;
    v_ref TEXT;
    v_token UUID;
    v_full_name TEXT := btrim(coalesce(p_payload->>'full_name', ''));
    v_mobile_raw TEXT := btrim(coalesce(p_payload->>'mobile', ''));
    v_mobile TEXT;
    v_email TEXT := nullif(btrim(coalesce(p_payload->>'email', '')), '');
    v_loan_type TEXT := btrim(coalesce(p_payload->>'loan_type', ''));
    v_loan_amount NUMERIC := nullif(p_payload->>'loan_amount', '')::NUMERIC;
    v_message TEXT := nullif(btrim(coalesce(p_payload->>'message', '')), '');
    v_applicant_type TEXT := coalesce(nullif(p_payload->>'applicant_type', ''), 'resident');
    v_country TEXT := nullif(btrim(coalesce(p_payload->>'country_of_residence', '')), '');
    v_residency TEXT := nullif(btrim(coalesce(p_payload->>'residency_status', '')), '');
    v_employment TEXT := nullif(btrim(coalesce(p_payload->>'employment_type', '')), '');
    v_consent BOOLEAN := coalesce((p_payload->>'consent')::BOOLEAN, false);
    v_consent_version TEXT := coalesce(nullif(p_payload->>'consent_version', ''), '2026-10');
    v_source TEXT := nullif(btrim(coalesce(p_payload->>'source_page', '')), '');
    v_co JSONB := coalesce(p_payload->'co_applicants', '[]'::JSONB);
    v_guar JSONB := coalesce(p_payload->'guarantors', '[]'::JSONB);
    v_item JSONB;
    v_item_type TEXT;
    v_item_mobile TEXT;
    v_item_email TEXT;
BEGIN
    IF v_full_name = '' THEN
        RAISE EXCEPTION 'Please enter the primary applicant name.' USING ERRCODE = '22023';
    END IF;
    IF v_loan_type NOT IN (
        'Home Loan', 'Home Loan Top-Up', 'Home Loan Takeover',
        'Loan Against Property', 'Education Loan', 'Vehicle Loan',
        'Business Loan', 'Personal Loan'
    ) THEN
        RAISE EXCEPTION 'Please select a valid loan type.' USING ERRCODE = '22023';
    END IF;
    IF v_loan_amount IS NULL OR v_loan_amount < 10000 THEN
        RAISE EXCEPTION 'Please enter a loan amount of at least 10,000.' USING ERRCODE = '22023';
    END IF;
    IF v_email IS NULL THEN
        RAISE EXCEPTION 'Please enter your email address.' USING ERRCODE = '22023';
    END IF;
    IF v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
        RAISE EXCEPTION 'Please enter a valid email address.' USING ERRCODE = '22023';
    END IF;
    IF NOT v_consent THEN
        RAISE EXCEPTION 'Please accept the privacy notice before submitting.' USING ERRCODE = '22023';
    END IF;

    IF v_applicant_type NOT IN ('resident', 'nri') THEN
        v_applicant_type := 'resident';
    END IF;

    v_mobile := regexp_replace(v_mobile_raw, '[^0-9]', '', 'g');

    IF v_applicant_type = 'nri' THEN
        IF length(v_mobile) < 8 OR length(v_mobile) > 15 THEN
            RAISE EXCEPTION 'Please enter a valid international phone number.' USING ERRCODE = '22023';
        END IF;
        IF v_country IS NULL OR v_residency IS NULL OR v_employment IS NULL THEN
            RAISE EXCEPTION 'Country, residency status and employment type are required for NRI applicants.' USING ERRCODE = '22023';
        END IF;
        IF v_residency NOT IN ('NRI', 'PIO', 'OCI', 'Foreign national') THEN
            RAISE EXCEPTION 'Please select a valid residency status.' USING ERRCODE = '22023';
        END IF;
        IF v_employment NOT IN ('Salaried', 'Self-employed / business', 'Professional', 'Retired', 'Other') THEN
            RAISE EXCEPTION 'Please select a valid employment type.' USING ERRCODE = '22023';
        END IF;
    ELSE
        IF v_mobile !~ '^[6-9][0-9]{9}$' THEN
            RAISE EXCEPTION 'Please enter a valid 10-digit Indian mobile number.' USING ERRCODE = '22023';
        END IF;
        v_country := NULL;
        v_residency := NULL;
        v_employment := NULL;
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

    INSERT INTO public.loan_leads (
        full_name, mobile, email, loan_type, loan_amount, message,
        applicant_type, country_of_residence, residency_status, employment_type,
        consent_given, consent_at, consent_version, source_page
    ) VALUES (
        v_full_name, v_mobile, v_email, v_loan_type, v_loan_amount, v_message,
        v_applicant_type, v_country, v_residency, v_employment,
        true, now(), v_consent_version, v_source
    )
    RETURNING id, reference_no, access_token INTO v_id, v_ref, v_token;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_co) LOOP
        v_item_type := CASE WHEN v_item->>'applicant_type' = 'nri' THEN 'nri' ELSE 'resident' END;
        v_item_mobile := regexp_replace(coalesce(v_item->>'mobile', ''), '[^0-9]', '', 'g');
        v_item_email := nullif(btrim(coalesce(v_item->>'email', '')), '');

        IF btrim(coalesce(v_item->>'full_name', '')) = '' THEN
            RAISE EXCEPTION 'Please enter each co-applicant name.' USING ERRCODE = '22023';
        END IF;
        IF nullif(btrim(coalesce(v_item->>'relationship', '')), '') IS NULL THEN
            RAISE EXCEPTION 'Please select the relationship for each co-applicant.' USING ERRCODE = '22023';
        END IF;
        IF v_item_type = 'nri' THEN
            IF length(v_item_mobile) < 8 OR length(v_item_mobile) > 15 THEN
                RAISE EXCEPTION 'Please enter a valid international phone number for each NRI co-applicant.' USING ERRCODE = '22023';
            END IF;
            IF nullif(btrim(coalesce(v_item->>'country_of_residence', '')), '') IS NULL
               OR nullif(btrim(coalesce(v_item->>'residency_status', '')), '') IS NULL THEN
                RAISE EXCEPTION 'Country and residency status are required for NRI co-applicants.' USING ERRCODE = '22023';
            END IF;
        ELSE
            IF v_item_mobile !~ '^[6-9][0-9]{9}$' THEN
                RAISE EXCEPTION 'Please enter a valid 10-digit Indian mobile number for each co-applicant.' USING ERRCODE = '22023';
            END IF;
        END IF;
        IF nullif(btrim(coalesce(v_item->>'employment_type', '')), '') IS NULL THEN
            RAISE EXCEPTION 'Please select the employment type for each co-applicant.' USING ERRCODE = '22023';
        END IF;
        IF nullif(v_item->>'monthly_income', '') IS NULL OR (v_item->>'monthly_income')::NUMERIC <= 0 THEN
            RAISE EXCEPTION 'Please enter the monthly income for each co-applicant.' USING ERRCODE = '22023';
        END IF;
        IF v_item_email IS NOT NULL AND v_item_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
            RAISE EXCEPTION 'Please enter a valid email address for each co-applicant.' USING ERRCODE = '22023';
        END IF;

        INSERT INTO public.loan_applicants (
            loan_lead_id, role, applicant_type, full_name, relationship, date_of_birth,
            email, mobile, country_code, country_of_residence, residency_status,
            employment_type, employer_name, monthly_income, income_currency
        ) VALUES (
            v_id, 'co_applicant', v_item_type,
            btrim(v_item->>'full_name'),
            nullif(btrim(coalesce(v_item->>'relationship', '')), ''),
            nullif(v_item->>'date_of_birth', '')::DATE,
            v_item_email,
            nullif(btrim(coalesce(v_item->>'mobile', '')), ''),
            nullif(btrim(coalesce(v_item->>'country_code', '')), ''),
            nullif(btrim(coalesce(v_item->>'country_of_residence', '')), ''),
            nullif(btrim(coalesce(v_item->>'residency_status', '')), ''),
            nullif(btrim(coalesce(v_item->>'employment_type', '')), ''),
            nullif(btrim(coalesce(v_item->>'employer_name', '')), ''),
            (v_item->>'monthly_income')::NUMERIC,
            coalesce(nullif(v_item->>'income_currency', ''), 'INR')
        );
    END LOOP;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_guar) LOOP
        v_item_type := CASE WHEN v_item->>'applicant_type' = 'nri' THEN 'nri' ELSE 'resident' END;
        v_item_mobile := regexp_replace(coalesce(v_item->>'mobile', ''), '[^0-9]', '', 'g');
        v_item_email := nullif(btrim(coalesce(v_item->>'email', '')), '');

        IF btrim(coalesce(v_item->>'full_name', '')) = '' THEN
            RAISE EXCEPTION 'Please enter each guarantor name.' USING ERRCODE = '22023';
        END IF;
        IF nullif(btrim(coalesce(v_item->>'relationship', '')), '') IS NULL THEN
            RAISE EXCEPTION 'Please select the relationship for each guarantor.' USING ERRCODE = '22023';
        END IF;
        IF v_item_type = 'nri' THEN
            IF length(v_item_mobile) < 8 OR length(v_item_mobile) > 15 THEN
                RAISE EXCEPTION 'Please enter a valid international phone number for each NRI guarantor.' USING ERRCODE = '22023';
            END IF;
            IF nullif(btrim(coalesce(v_item->>'country_of_residence', '')), '') IS NULL
               OR nullif(btrim(coalesce(v_item->>'residency_status', '')), '') IS NULL THEN
                RAISE EXCEPTION 'Country and residency status are required for NRI guarantors.' USING ERRCODE = '22023';
            END IF;
        ELSE
            IF v_item_mobile !~ '^[6-9][0-9]{9}$' THEN
                RAISE EXCEPTION 'Please enter a valid 10-digit Indian mobile number for each guarantor.' USING ERRCODE = '22023';
            END IF;
        END IF;
        IF nullif(btrim(coalesce(v_item->>'employment_type', '')), '') IS NULL THEN
            RAISE EXCEPTION 'Please select the employment type for each guarantor.' USING ERRCODE = '22023';
        END IF;
        IF nullif(v_item->>'monthly_income', '') IS NULL OR (v_item->>'monthly_income')::NUMERIC <= 0 THEN
            RAISE EXCEPTION 'Please enter the monthly income for each guarantor.' USING ERRCODE = '22023';
        END IF;
        IF v_item_email IS NOT NULL AND v_item_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
            RAISE EXCEPTION 'Please enter a valid email address for each guarantor.' USING ERRCODE = '22023';
        END IF;

        INSERT INTO public.loan_applicants (
            loan_lead_id, role, applicant_type, full_name, relationship, date_of_birth,
            email, mobile, country_code, country_of_residence, residency_status,
            employment_type, employer_name, monthly_income, income_currency
        ) VALUES (
            v_id, 'guarantor', v_item_type,
            btrim(v_item->>'full_name'),
            nullif(btrim(coalesce(v_item->>'relationship', '')), ''),
            nullif(v_item->>'date_of_birth', '')::DATE,
            v_item_email,
            nullif(btrim(coalesce(v_item->>'mobile', '')), ''),
            nullif(btrim(coalesce(v_item->>'country_code', '')), ''),
            nullif(btrim(coalesce(v_item->>'country_of_residence', '')), ''),
            nullif(btrim(coalesce(v_item->>'residency_status', '')), ''),
            nullif(btrim(coalesce(v_item->>'employment_type', '')), ''),
            nullif(btrim(coalesce(v_item->>'employer_name', '')), ''),
            (v_item->>'monthly_income')::NUMERIC,
            coalesce(nullif(v_item->>'income_currency', ''), 'INR')
        );
    END LOOP;

    RETURN QUERY SELECT gen_random_uuid(), jsonb_build_object(
        'id', v_id,
        'reference_no', v_ref,
        'access_token', v_token,
        'full_name', v_full_name,
        'loan_type', v_loan_type,
        'loan_amount', v_loan_amount,
        'applicant_type', v_applicant_type
    );
END;
$$;

-- 11.2 Callback booking
CREATE OR REPLACE FUNCTION public.book_callback(
    p_full_name TEXT,
    p_mobile TEXT,
    p_email TEXT,
    p_date DATE,
    p_slot TEXT,
    p_notes TEXT,
    p_application_reference TEXT,
    p_consent BOOLEAN
)
RETURNS SETOF public.api_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id UUID;
    v_ref TEXT;
    v_mobile TEXT := regexp_replace(coalesce(p_mobile, ''), '[^0-9]', '', 'g');
    v_email TEXT := nullif(btrim(coalesce(p_email, '')), '');
BEGIN
    IF btrim(coalesce(p_full_name, '')) = '' THEN
        RAISE EXCEPTION 'Please enter your name.' USING ERRCODE = '22023';
    END IF;
    IF v_mobile !~ '^[6-9][0-9]{9}$' THEN
        RAISE EXCEPTION 'Please enter a valid 10-digit Indian mobile number.' USING ERRCODE = '22023';
    END IF;
    IF v_email IS NOT NULL AND v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
        RAISE EXCEPTION 'Please enter a valid email address.' USING ERRCODE = '22023';
    END IF;
    IF p_date IS NULL THEN
        RAISE EXCEPTION 'Please choose a callback date.' USING ERRCODE = '22023';
    END IF;
    IF p_date < (now() AT TIME ZONE 'Asia/Kolkata')::date + 1 THEN
        RAISE EXCEPTION 'Callback date must be at least one day in advance.' USING ERRCODE = '22023';
    END IF;
    IF p_date > (now() AT TIME ZONE 'Asia/Kolkata')::date + 45 THEN
        RAISE EXCEPTION 'Callbacks can be booked up to 45 days in advance.' USING ERRCODE = '22023';
    END IF;
    IF extract(isodow FROM p_date) = 7 THEN
        RAISE EXCEPTION 'Callbacks are not available on Sundays.' USING ERRCODE = '22023';
    END IF;
    IF p_slot IS NULL OR p_slot NOT IN (
        '10:00', '10:30', '11:00', '11:30', '12:00', '12:30',
        '14:00', '14:30', '15:00', '15:30', '16:00', '16:30',
        '17:00', '17:30'
    ) THEN
        RAISE EXCEPTION 'Please choose a valid callback slot.' USING ERRCODE = '22023';
    END IF;
    IF coalesce(p_consent, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'Please accept the privacy notice before scheduling a callback.' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.callback_bookings (
        full_name, mobile, email, preferred_date, preferred_slot,
        notes, application_reference, consent_at
    ) VALUES (
        btrim(p_full_name), v_mobile, v_email, p_date, p_slot,
        nullif(btrim(coalesce(p_notes, '')), ''),
        nullif(btrim(coalesce(p_application_reference, '')), ''),
        now()
    )
    RETURNING id, reference_no INTO v_id, v_ref;

    RETURN QUERY SELECT gen_random_uuid(), jsonb_build_object(
        'id', v_id,
        'reference_no', v_ref,
        'preferred_date', p_date,
        'preferred_slot', p_slot
    );
EXCEPTION
    WHEN unique_violation THEN
        RAISE EXCEPTION 'That slot has just been booked. Please choose another time.'
            USING ERRCODE = '23505';
END;
$$;

-- 11.3 Slot availability (no personal data returned)
CREATE OR REPLACE FUNCTION public.get_booked_callback_slots(p_date DATE)
RETURNS SETOF public.api_result
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT gen_random_uuid(), jsonb_build_object('slot', cb.preferred_slot)
    FROM public.callback_bookings cb
    WHERE cb.preferred_date = p_date
      AND cb.status IN ('Pending', 'Confirmed', 'Rescheduled');
$$;

-- 11.4 Post-disbursal request
CREATE OR REPLACE FUNCTION public.submit_post_disbursal_request(
    p_full_name TEXT,
    p_mobile TEXT,
    p_email TEXT,
    p_loan_reference_no TEXT,
    p_request_type TEXT,
    p_description TEXT,
    p_consent BOOLEAN
)
RETURNS SETOF public.api_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id UUID;
    v_ref TEXT;
    v_mobile TEXT := regexp_replace(coalesce(p_mobile, ''), '[^0-9]', '', 'g');
    v_email TEXT := nullif(btrim(coalesce(p_email, '')), '');
BEGIN
    IF btrim(coalesce(p_full_name, '')) = '' THEN
        RAISE EXCEPTION 'Please enter your name.' USING ERRCODE = '22023';
    END IF;
    IF length(v_mobile) < 10 OR length(v_mobile) > 15 THEN
        RAISE EXCEPTION 'Please enter a valid contact number.' USING ERRCODE = '22023';
    END IF;
    IF v_email IS NOT NULL AND v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
        RAISE EXCEPTION 'Please enter a valid email address.' USING ERRCODE = '22023';
    END IF;
    IF btrim(coalesce(p_loan_reference_no, '')) = '' THEN
        RAISE EXCEPTION 'Please enter your loan account or application reference.' USING ERRCODE = '22023';
    END IF;
    IF p_request_type IS NULL OR p_request_type NOT IN (
        'Repayment schedule', 'Foreclosure', 'Part payment',
        'Balance transfer / takeover', 'Top-up', 'Annual loan review', 'Other'
    ) THEN
        RAISE EXCEPTION 'Please choose a valid request type.' USING ERRCODE = '22023';
    END IF;
    IF length(btrim(coalesce(p_description, ''))) < 10 THEN
        RAISE EXCEPTION 'Please describe your request in at least 10 characters.' USING ERRCODE = '22023';
    END IF;
    IF coalesce(p_consent, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'Please accept the privacy notice before submitting.' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.post_disbursal_requests (
        loan_reference_no, full_name, mobile, email, request_type, description, consent_at
    ) VALUES (
        nullif(btrim(coalesce(p_loan_reference_no, '')), ''),
        btrim(p_full_name), v_mobile, v_email, p_request_type, btrim(p_description), now()
    )
    RETURNING id, reference_no INTO v_id, v_ref;

    RETURN QUERY SELECT gen_random_uuid(), jsonb_build_object(
        'id', v_id,
        'reference_no', v_ref,
        'request_type', p_request_type
    );
END;
$$;

-- 11.5 Complaint ticket
CREATE OR REPLACE FUNCTION public.submit_complaint(
    p_full_name TEXT,
    p_mobile TEXT,
    p_email TEXT,
    p_category TEXT,
    p_loan_reference_no TEXT,
    p_description TEXT,
    p_consent BOOLEAN
)
RETURNS SETOF public.api_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id UUID;
    v_ticket TEXT;
    v_mobile TEXT := regexp_replace(coalesce(p_mobile, ''), '[^0-9]', '', 'g');
    v_email TEXT := nullif(btrim(coalesce(p_email, '')), '');
BEGIN
    IF btrim(coalesce(p_full_name, '')) = '' THEN
        RAISE EXCEPTION 'Please enter your name.' USING ERRCODE = '22023';
    END IF;
    IF length(v_mobile) < 10 OR length(v_mobile) > 15 THEN
        RAISE EXCEPTION 'Please enter a valid contact number.' USING ERRCODE = '22023';
    END IF;
    IF v_email IS NOT NULL AND v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
        RAISE EXCEPTION 'Please enter a valid email address.' USING ERRCODE = '22023';
    END IF;
    IF p_category IS NULL OR p_category NOT IN (
        'Loan application', 'Documentation', 'Interest rate or charges',
        'Disbursement delay', 'Staff conduct', 'Post-disbursal support',
        'Data privacy', 'Other'
    ) THEN
        RAISE EXCEPTION 'Please choose a valid complaint category.' USING ERRCODE = '22023';
    END IF;
    IF length(btrim(coalesce(p_description, ''))) < 20 THEN
        RAISE EXCEPTION 'Please describe the complaint in at least 20 characters.' USING ERRCODE = '22023';
    END IF;
    IF coalesce(p_consent, false) IS NOT TRUE THEN
        RAISE EXCEPTION 'Please accept the privacy notice before submitting.' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.complaints (
        loan_reference_no, full_name, mobile, email, category, description, consent_at
    ) VALUES (
        nullif(btrim(coalesce(p_loan_reference_no, '')), ''),
        btrim(p_full_name), v_mobile, v_email, p_category, btrim(p_description), now()
    )
    RETURNING id, ticket_no INTO v_id, v_ticket;

    RETURN QUERY SELECT gen_random_uuid(), jsonb_build_object(
        'id', v_id,
        'ticket_no', v_ticket,
        'category', p_category
    );
END;
$$;

-- 11.6 Customer application lookup (reference + mobile + email)
CREATE OR REPLACE FUNCTION public.lookup_application(
    p_reference TEXT,
    p_mobile TEXT,
    p_email TEXT
)
RETURNS SETOF public.api_result
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.loan_leads%ROWTYPE;
    v_digits TEXT := right(regexp_replace(coalesce(p_mobile, ''), '[^0-9]', '', 'g'), 10);
BEGIN
    IF btrim(coalesce(p_reference, '')) = ''
       OR length(v_digits) < 10
       OR btrim(coalesce(p_email, '')) = '' THEN
        RAISE EXCEPTION 'Enter your application reference, registered mobile number and email address.' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_row
    FROM public.loan_leads
    WHERE upper(reference_no) = upper(btrim(p_reference))
      AND right(regexp_replace(mobile, '[^0-9]', '', 'g'), 10) = v_digits
      AND lower(coalesce(email, '')) = lower(btrim(p_email))
    LIMIT 1;

    IF v_row.id IS NULL THEN
        RAISE EXCEPTION 'No application matched those details. Please check and try again.' USING ERRCODE = 'P0002';
    END IF;

    RETURN QUERY SELECT gen_random_uuid(), jsonb_build_object(
        'id', v_row.id,
        'reference_no', v_row.reference_no,
        'access_token', v_row.access_token,
        'full_name', v_row.full_name,
        'loan_type', v_row.loan_type,
        'loan_amount', v_row.loan_amount,
        'status', v_row.status
    );
END;
$$;

-- 11.7 Application summary by link token
CREATE OR REPLACE FUNCTION public.get_application_by_token(
    p_lead_id UUID,
    p_access_token UUID
)
RETURNS SETOF public.api_result
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row public.loan_leads%ROWTYPE;
BEGIN
    SELECT * INTO v_row
    FROM public.loan_leads
    WHERE id = p_lead_id AND access_token = p_access_token;

    IF v_row.id IS NULL THEN
        RAISE EXCEPTION 'This document link is invalid or has expired.' USING ERRCODE = '28000';
    END IF;

    RETURN QUERY SELECT gen_random_uuid(), jsonb_build_object(
        'id', v_row.id,
        'reference_no', v_row.reference_no,
        'full_name', v_row.full_name,
        'loan_type', v_row.loan_type,
        'loan_amount', v_row.loan_amount,
        'status', v_row.status
    );
END;
$$;

-- 11.8 Register an uploaded Nhost Storage file
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
        'Photograph', 'Other'
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

-- 11.9 Customer-visible document status list
CREATE OR REPLACE FUNCTION public.get_application_documents(
    p_lead_id UUID,
    p_access_token UUID
)
RETURNS SETOF public.api_result
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.loan_leads
        WHERE id = p_lead_id AND access_token = p_access_token
    ) THEN
        RAISE EXCEPTION 'This document link is invalid or has expired.' USING ERRCODE = '28000';
    END IF;

    RETURN QUERY
    SELECT gen_random_uuid(), jsonb_build_object(
        'document_type', d.document_type,
        'file_name', d.file_name,
        'status', d.status,
        'created_at', d.created_at
    )
    FROM public.loan_documents d
    WHERE d.loan_lead_id = p_lead_id
    ORDER BY d.created_at DESC;
END;
$$;

-- -----------------------------------------------------------------------------
-- 12. Role seed
-- -----------------------------------------------------------------------------

-- Nhost seeds user, anonymous and me. Add the custom admin role. The admin
-- user itself is created in the Nhost dashboard and assigned this role with
-- the SQL shown in nhost/README.md.
INSERT INTO auth.roles (role) VALUES ('admin')
ON CONFLICT (role) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 13. Postgres grants
-- -----------------------------------------------------------------------------
-- Hasura connects with its own database role and enforces access through
-- Hasura permissions. The only Postgres grant needed here is on the function
-- return table; function EXECUTE is granted to PUBLIC by default.
GRANT SELECT ON public.api_result TO PUBLIC;

COMMIT;

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================

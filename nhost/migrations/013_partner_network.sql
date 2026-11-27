-- =============================================================================
-- NHOST / HASURA MIGRATION: 013_partner_network.sql
-- PROJECT: Dhanvi Finserv
--
-- Run this ONCE, after 012, in the Nhost dashboard:
--   Database -> SQL Editor -> paste -> Run
--
-- It adds the DSA Partner Network behind partner-apply.html, partner-login.html
-- and partner-portal.html:
--
--   1. public.partner_application_details - one structured onboarding
--      application per lead: applicant and firm profile, office address,
--      PAN and business registration, partner type, experience, products,
--      expected leads, preferred locations, bank / DSA associations,
--      declarations and the administrator-controlled review fields.
--   2. public.partner_profiles          - the provisioned partner account
--      linked to an auth user, with a partner code and activation status.
--   3. public.partner_documents         - a mirror of public.loan_documents
--      for partner applications, kept in sync by a trigger so the existing
--      private upload and verification path is reused.
--   4. public.partner_verifications     - PAN, business registration, address,
--      photograph, bank / DSA association and overall verification records.
--   5. public.partner_agreements        - agreement status, dates, reference,
--      commission terms and the signed agreement document.
--   6. public.partner_lead_assignments  - customer leads assigned to a partner.
--   7. public.partner_commissions       - commission records per assignment.
--   8. public.partner_followups         - partner follow-up scheduling.
--
--   9. submit_partner_application()     - public onboarding RPC.
--  10. review_partner_application()     - administrator approval / rejection.
--  11. provision_partner_login()        - link an auth user, grant the partner
--      role and activate the partner profile after a signed agreement.
--  12. update_partner_lead_status()     - the only write a partner can make:
--      progress on an assigned lead, limited to Contacted, Documents Pending
--      and Submitted to Lender.
--
--  13. Business Registration and Onboarding Document added to
--      public.loan_documents.document_type and register_document().
--  14. The custom Hasura role "partner" seeded in auth.roles.
--  15. Row-level security enabled on all eight partner tables as
--      defence-in-depth behind the Hasura permissions.
--
-- DRAFT STORAGE
--   Save / resume is shared with the other wizards: partner-apply.html uses
--   save_home_loan_draft() / get_home_loan_draft() against the existing
--   public.home_loan_drafts table. PAN and the business registration number
--   are removed from drafts and must be re-entered on resume.
--
-- ACCESS CONTROL
--   Hasura permissions remain the primary API boundary. Partner rows use a
--   row filter on partner_profiles.user_id = X-Hasura-User-Id. The RLS
--   policies below repeat that rule for any direct, non-owner database
--   connection. Partners never query public.loan_leads directly.
--
-- IMPORTANT
--   * Every function returns SETOF public.api_result so Hasura can track it.
--   * The public application never sets application_status beyond
--     'Application Received', never assigns an executive, never verifies a
--     document, never records an agreement or commission, and never sees
--     another partner's data.
--   * Only an administrator can approve or reject an application, verify a
--     document, record an agreement, provision a login, assign a lead or
--     approve / pay a commission.
--   * Approval requires the required documents and verification rows to be
--     Verified and an assigned executive. Profile activation requires a
--     signed, effective agreement.
--   * Dhanvi Finserv does not guarantee lead volume, loan approval, sanction,
--     disbursal or commission. The lender decides the credit outcome and the
--     agreement governs commission.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. Allow service applications on the shared loan_leads table
-- -----------------------------------------------------------------------------
-- Migration 012 already widened these constraints. This block is idempotent
-- and keeps 013 safe if it is applied to a database where 012 was skipped.

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
-- 1. Partner application details (1:1 with loan_leads)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.partner_application_details (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_lead_id UUID NOT NULL UNIQUE REFERENCES public.loan_leads(id) ON DELETE CASCADE,

    -- Applicant and firm profile
    applicant_name TEXT NOT NULL,
    mobile TEXT NOT NULL,
    email TEXT NOT NULL,
    applicant_city TEXT NOT NULL,
    applicant_state TEXT NOT NULL,
    pan_number TEXT NOT NULL,
    firm_name TEXT NOT NULL,
    partner_type TEXT NOT NULL
        CHECK (partner_type IN (
            'Individual / Referral Partner',
            'Chartered Accountant / Tax Consultant',
            'Property Consultant / Broker',
            'Insurance Advisor',
            'Financial Services Company',
            'Bank / NBFC Relationship',
            'Other')),
    office_address TEXT NOT NULL,
    office_city TEXT NOT NULL,
    office_state TEXT NOT NULL,
    office_pincode TEXT NOT NULL,
    business_registration_type TEXT NOT NULL
        CHECK (business_registration_type IN (
            'Proprietorship', 'Partnership', 'LLP', 'Private Limited',
            'Public Limited', 'Society / Trust', 'Not registered')),
    business_registration_number TEXT,
    gst_number TEXT,

    -- Experience and network
    years_experience INTEGER NOT NULL DEFAULT 0
        CHECK (years_experience >= 0 AND years_experience <= 60),
    financial_services_experience TEXT NOT NULL
        CHECK (financial_services_experience IN (
            'None', 'Less than 1 year', '1-3 years', '3-5 years',
            '5-10 years', 'More than 10 years')),
    existing_dsa_associations TEXT,
    bank_associations TEXT,
    products TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    expected_leads_per_month INTEGER NOT NULL DEFAULT 0
        CHECK (expected_leads_per_month >= 0 AND expected_leads_per_month <= 1000),
    preferred_locations TEXT,
    referral_source TEXT,
    additional_notes TEXT,

    -- Declarations captured with the application
    accuracy_declaration BOOLEAN NOT NULL DEFAULT false,
    commission_declaration BOOLEAN NOT NULL DEFAULT false,
    no_guarantee_declaration BOOLEAN NOT NULL DEFAULT false,

    -- Administrator-controlled review record. The public form can never set
    -- any of these fields.
    application_status TEXT NOT NULL DEFAULT 'Application Received'
        CHECK (application_status IN (
            'Application Received', 'Under Review', 'Documents Pending',
            'Verification In Progress', 'Approved', 'Rejected',
            'On Hold', 'Withdrawn')),
    assigned_executive_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    admin_remarks TEXT,
    rejection_reason TEXT,
    status_notes TEXT,
    reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS partner_application_details_lead_idx
    ON public.partner_application_details (loan_lead_id);
CREATE INDEX IF NOT EXISTS partner_application_details_status_idx
    ON public.partner_application_details (application_status);
CREATE INDEX IF NOT EXISTS partner_application_details_type_idx
    ON public.partner_application_details (partner_type);
CREATE INDEX IF NOT EXISTS partner_application_details_city_idx
    ON public.partner_application_details (applicant_city);
CREATE INDEX IF NOT EXISTS partner_application_details_state_idx
    ON public.partner_application_details (applicant_state);
CREATE INDEX IF NOT EXISTS partner_application_details_exec_idx
    ON public.partner_application_details (assigned_executive_id);

DROP TRIGGER IF EXISTS update_partner_application_details_modtime
    ON public.partner_application_details;
CREATE TRIGGER update_partner_application_details_modtime
    BEFORE UPDATE ON public.partner_application_details
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. Provisioned partner profiles (1:1 with loan_leads and auth.users)
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.partner_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_lead_id UUID NOT NULL UNIQUE REFERENCES public.loan_leads(id) ON DELETE CASCADE,
    user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
    partner_code TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    firm_name TEXT,
    partner_type TEXT,
    status TEXT NOT NULL DEFAULT 'Pending Agreement'
        CHECK (status IN ('Pending Agreement', 'Active', 'Suspended', 'Inactive')),
    onboarding_completed BOOLEAN NOT NULL DEFAULT false,
    activated_at TIMESTAMPTZ,
    suspended_at TIMESTAMPTZ,
    suspension_reason TEXT,
    admin_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS partner_profiles_lead_idx
    ON public.partner_profiles (loan_lead_id);
CREATE INDEX IF NOT EXISTS partner_profiles_user_idx
    ON public.partner_profiles (user_id);
CREATE INDEX IF NOT EXISTS partner_profiles_status_idx
    ON public.partner_profiles (status);

DROP TRIGGER IF EXISTS update_partner_profiles_modtime
    ON public.partner_profiles;
CREATE TRIGGER update_partner_profiles_modtime
    BEFORE UPDATE ON public.partner_profiles
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. Partner documents (mirror of loan_documents)
-- -----------------------------------------------------------------------------
-- Files stay in the private loan-documents bucket and are registered through
-- register_document(). The trigger below copies the metadata and verification
-- state so the admin Documents module remains the single verification path and
-- partners never query loan_leads or loan_documents directly.

CREATE TABLE IF NOT EXISTS public.partner_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_lead_id UUID NOT NULL REFERENCES public.loan_leads(id) ON DELETE CASCADE,
    loan_document_id UUID NOT NULL UNIQUE REFERENCES public.loan_documents(id) ON DELETE CASCADE,
    document_type TEXT NOT NULL,
    storage_file_id UUID UNIQUE,
    file_name TEXT,
    file_size BIGINT,
    mime_type TEXT,
    status TEXT NOT NULL DEFAULT 'Pending'
        CHECK (status IN ('Pending', 'Verified', 'Rejected')),
    verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    verification_date TIMESTAMPTZ,
    notes TEXT,
    uploaded_by TEXT NOT NULL DEFAULT 'customer'
        CHECK (uploaded_by IN ('customer', 'admin')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS partner_documents_lead_idx
    ON public.partner_documents (partner_lead_id);
CREATE INDEX IF NOT EXISTS partner_documents_type_idx
    ON public.partner_documents (document_type);
CREATE INDEX IF NOT EXISTS partner_documents_status_idx
    ON public.partner_documents (status);

DROP TRIGGER IF EXISTS update_partner_documents_modtime
    ON public.partner_documents;
CREATE TRIGGER update_partner_documents_modtime
    BEFORE UPDATE ON public.partner_documents
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 4. Partner verification records
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.partner_verifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_lead_id UUID NOT NULL REFERENCES public.loan_leads(id) ON DELETE CASCADE,
    verification_type TEXT NOT NULL
        CHECK (verification_type IN (
            'PAN Verification', 'Business Registration Verification',
            'Address Verification', 'Photograph Verification',
            'Bank / DSA Association Verification', 'Overall Review')),
    status TEXT NOT NULL DEFAULT 'Pending'
        CHECK (status IN ('Pending', 'In Progress', 'Verified', 'Failed', 'Not Applicable')),
    reference_no TEXT,
    findings TEXT,
    remarks TEXT,
    verified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (partner_lead_id, verification_type)
);

CREATE INDEX IF NOT EXISTS partner_verifications_lead_idx
    ON public.partner_verifications (partner_lead_id);
CREATE INDEX IF NOT EXISTS partner_verifications_type_idx
    ON public.partner_verifications (verification_type);
CREATE INDEX IF NOT EXISTS partner_verifications_status_idx
    ON public.partner_verifications (status);

DROP TRIGGER IF EXISTS update_partner_verifications_modtime
    ON public.partner_verifications;
CREATE TRIGGER update_partner_verifications_modtime
    BEFORE UPDATE ON public.partner_verifications
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 5. Partner agreements
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.partner_agreements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_lead_id UUID NOT NULL REFERENCES public.loan_leads(id) ON DELETE CASCADE,
    agreement_type TEXT NOT NULL DEFAULT 'DSA Agreement'
        CHECK (agreement_type IN (
            'DSA Agreement', 'Referral Agreement', 'Sub-DSA Agreement',
            'Commission Addendum')),
    agreement_status TEXT NOT NULL DEFAULT 'Not Started'
        CHECK (agreement_status IN (
            'Not Started', 'Draft', 'Sent for Signature', 'Signed',
            'Active', 'Expired', 'Terminated')),
    agreement_reference TEXT,
    effective_from DATE,
    effective_to DATE,
    signed_date DATE,
    document_storage_file_id UUID REFERENCES storage.files(id) ON DELETE SET NULL,
    document_name TEXT,
    commission_terms TEXT,
    admin_remarks TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT partner_agreements_dates_check CHECK (
        effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from
    )
);

CREATE INDEX IF NOT EXISTS partner_agreements_lead_idx
    ON public.partner_agreements (partner_lead_id);
CREATE INDEX IF NOT EXISTS partner_agreements_status_idx
    ON public.partner_agreements (agreement_status);
CREATE INDEX IF NOT EXISTS partner_agreements_effective_idx
    ON public.partner_agreements (effective_from, effective_to);

DROP TRIGGER IF EXISTS update_partner_agreements_modtime
    ON public.partner_agreements;
CREATE TRIGGER update_partner_agreements_modtime
    BEFORE UPDATE ON public.partner_agreements
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 6. Partner lead assignments
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.partner_lead_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_profile_id UUID NOT NULL REFERENCES public.partner_profiles(id) ON DELETE CASCADE,
    loan_lead_id UUID REFERENCES public.loan_leads(id) ON DELETE SET NULL,
    assignment_reference TEXT NOT NULL DEFAULT public.next_reference('PA'),
    customer_name TEXT NOT NULL,
    customer_mobile TEXT NOT NULL,
    customer_email TEXT,
    product_type TEXT NOT NULL,
    requested_amount NUMERIC CHECK (requested_amount IS NULL OR requested_amount >= 0),
    customer_city TEXT,
    customer_state TEXT,
    lender_name TEXT,
    lender_reference TEXT,
    status TEXT NOT NULL DEFAULT 'Assigned'
        CHECK (status IN (
            'Assigned', 'Contacted', 'Documents Pending',
            'Submitted to Lender', 'Sanctioned', 'Disbursed',
            'Rejected', 'Closed')),
    status_notes TEXT,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_contacted_at TIMESTAMPTZ,
    submitted_at TIMESTAMPTZ,
    sanctioned_amount NUMERIC CHECK (sanctioned_amount IS NULL OR sanctioned_amount >= 0),
    disbursed_amount NUMERIC CHECK (disbursed_amount IS NULL OR disbursed_amount >= 0),
    disbursed_date DATE,
    admin_remarks TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS partner_lead_assignments_partner_idx
    ON public.partner_lead_assignments (partner_profile_id);
CREATE INDEX IF NOT EXISTS partner_lead_assignments_lead_idx
    ON public.partner_lead_assignments (loan_lead_id);
CREATE INDEX IF NOT EXISTS partner_lead_assignments_status_idx
    ON public.partner_lead_assignments (status);
CREATE INDEX IF NOT EXISTS partner_lead_assignments_assigned_idx
    ON public.partner_lead_assignments (assigned_at DESC);

DROP TRIGGER IF EXISTS update_partner_lead_assignments_modtime
    ON public.partner_lead_assignments;
CREATE TRIGGER update_partner_lead_assignments_modtime
    BEFORE UPDATE ON public.partner_lead_assignments
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 7. Partner commissions
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.partner_commissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_profile_id UUID NOT NULL REFERENCES public.partner_profiles(id) ON DELETE CASCADE,
    lead_assignment_id UUID REFERENCES public.partner_lead_assignments(id) ON DELETE SET NULL,
    loan_lead_id UUID REFERENCES public.loan_leads(id) ON DELETE SET NULL,
    commission_type TEXT NOT NULL DEFAULT 'DSA Commission'
        CHECK (commission_type IN (
            'Referral Fee', 'DSA Commission', 'Trail Commission',
            'Processing Fee Share', 'Other')),
    basis_amount NUMERIC CHECK (basis_amount IS NULL OR basis_amount >= 0),
    rate_percent NUMERIC CHECK (rate_percent IS NULL OR (rate_percent >= 0 AND rate_percent <= 100)),
    commission_amount NUMERIC NOT NULL CHECK (commission_amount >= 0),
    tds_amount NUMERIC NOT NULL DEFAULT 0 CHECK (tds_amount >= 0),
    net_payable NUMERIC CHECK (net_payable IS NULL OR net_payable >= 0),
    status TEXT NOT NULL DEFAULT 'Pending'
        CHECK (status IN (
            'Pending', 'Approved', 'Invoiced', 'Paid', 'On Hold', 'Cancelled')),
    invoice_no TEXT,
    invoice_date DATE,
    approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    paid_at TIMESTAMPTZ,
    payment_reference TEXT,
    remarks TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS partner_commissions_partner_idx
    ON public.partner_commissions (partner_profile_id);
CREATE INDEX IF NOT EXISTS partner_commissions_assignment_idx
    ON public.partner_commissions (lead_assignment_id);
CREATE INDEX IF NOT EXISTS partner_commissions_lead_idx
    ON public.partner_commissions (loan_lead_id);
CREATE INDEX IF NOT EXISTS partner_commissions_status_idx
    ON public.partner_commissions (status);
CREATE INDEX IF NOT EXISTS partner_commissions_paid_idx
    ON public.partner_commissions (paid_at);

DROP TRIGGER IF EXISTS update_partner_commissions_modtime
    ON public.partner_commissions;
CREATE TRIGGER update_partner_commissions_modtime
    BEFORE UPDATE ON public.partner_commissions
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 8. Partner follow-ups
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.partner_followups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    partner_lead_id UUID REFERENCES public.loan_leads(id) ON DELETE CASCADE,
    partner_profile_id UUID REFERENCES public.partner_profiles(id) ON DELETE CASCADE,
    lead_assignment_id UUID REFERENCES public.partner_lead_assignments(id) ON DELETE SET NULL,
    scheduled_at TIMESTAMPTZ NOT NULL,
    interaction_type TEXT NOT NULL DEFAULT 'Phone call'
        CHECK (interaction_type IN (
            'Phone call', 'WhatsApp', 'Email', 'Office meeting',
            'Video call', 'Document review', 'Other')),
    status TEXT NOT NULL DEFAULT 'Pending'
        CHECK (status IN ('Pending', 'Completed', 'Cancelled')),
    notes TEXT,
    completed_at TIMESTAMPTZ,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT partner_followups_owner_check CHECK (
        partner_lead_id IS NOT NULL OR partner_profile_id IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS partner_followups_partner_idx
    ON public.partner_followups (partner_profile_id);
CREATE INDEX IF NOT EXISTS partner_followups_lead_idx
    ON public.partner_followups (partner_lead_id);
CREATE INDEX IF NOT EXISTS partner_followups_scheduled_idx
    ON public.partner_followups (scheduled_at);
CREATE INDEX IF NOT EXISTS partner_followups_status_idx
    ON public.partner_followups (status);

DROP TRIGGER IF EXISTS update_partner_followups_modtime
    ON public.partner_followups;
CREATE TRIGGER update_partner_followups_modtime
    BEFORE UPDATE ON public.partner_followups
    FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 9. Mirror loan_documents into partner_documents
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.sync_partner_document()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        DELETE FROM public.partner_documents WHERE loan_document_id = OLD.id;
        RETURN OLD;
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.loan_leads l
        JOIN public.partner_application_details p ON p.loan_lead_id = l.id
        WHERE l.id = NEW.loan_lead_id
          AND l.loan_type = 'DSA Partner Network'
    ) THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.partner_documents (
        partner_lead_id, loan_document_id, document_type, storage_file_id,
        file_name, file_size, mime_type, status, verified_by,
        verification_date, notes, uploaded_by
    ) VALUES (
        NEW.loan_lead_id, NEW.id, NEW.document_type, NEW.storage_file_id,
        NEW.file_name, NEW.file_size, NEW.mime_type, NEW.status, NEW.verified_by,
        NEW.verification_date, NEW.notes, NEW.uploaded_by
    )
    ON CONFLICT (loan_document_id) DO UPDATE SET
        document_type = EXCLUDED.document_type,
        storage_file_id = EXCLUDED.storage_file_id,
        file_name = EXCLUDED.file_name,
        file_size = EXCLUDED.file_size,
        mime_type = EXCLUDED.mime_type,
        status = EXCLUDED.status,
        verified_by = EXCLUDED.verified_by,
        verification_date = EXCLUDED.verification_date,
        notes = EXCLUDED.notes,
        uploaded_by = EXCLUDED.uploaded_by;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS mirror_partner_document ON public.loan_documents;
CREATE TRIGGER mirror_partner_document
    AFTER INSERT OR UPDATE OR DELETE ON public.loan_documents
    FOR EACH ROW EXECUTE PROCEDURE public.sync_partner_document();

-- -----------------------------------------------------------------------------
-- 10. Enforce the partner approval requirements at the table level
-- -----------------------------------------------------------------------------
-- This protects against a direct GraphQL update that bypasses the review RPC.
-- Approval needs an assigned executive, every required document Verified and
-- every required verification Verified. Rejection needs a written reason.

CREATE OR REPLACE FUNCTION public.validate_partner_application_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_registration_type TEXT;
BEGIN
    IF NEW.application_status = 'Approved'
       AND (OLD.application_status IS DISTINCT FROM 'Approved') THEN
        IF NEW.assigned_executive_id IS NULL THEN
            RAISE EXCEPTION 'Assign an executive before approving this partner application.' USING ERRCODE = '22023';
        END IF;

        SELECT business_registration_type
        INTO v_registration_type
        FROM public.partner_application_details
        WHERE id = NEW.id;

        IF NOT EXISTS (
            SELECT 1 FROM public.partner_documents
            WHERE partner_lead_id = NEW.loan_lead_id
              AND document_type = 'PAN Card'
              AND status = 'Verified'
        ) THEN
            RAISE EXCEPTION 'Verify the partner PAN Card before approval.' USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM public.partner_documents
            WHERE partner_lead_id = NEW.loan_lead_id
              AND document_type = 'Address Proof'
              AND status = 'Verified'
        ) THEN
            RAISE EXCEPTION 'Verify the partner Address Proof before approval.' USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM public.partner_documents
            WHERE partner_lead_id = NEW.loan_lead_id
              AND document_type = 'Photograph'
              AND status = 'Verified'
        ) THEN
            RAISE EXCEPTION 'Verify the partner Photograph before approval.' USING ERRCODE = '22023';
        END IF;
        IF v_registration_type IS DISTINCT FROM 'Not registered'
           AND NOT EXISTS (
                SELECT 1 FROM public.partner_documents
                WHERE partner_lead_id = NEW.loan_lead_id
                  AND document_type = 'Business Registration'
                  AND status = 'Verified'
           ) THEN
            RAISE EXCEPTION 'Verify the Business Registration document before approval.' USING ERRCODE = '22023';
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM public.partner_verifications
            WHERE partner_lead_id = NEW.loan_lead_id
              AND verification_type = 'PAN Verification'
              AND status = 'Verified'
        ) THEN
            RAISE EXCEPTION 'Record a Verified PAN verification before approval.' USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM public.partner_verifications
            WHERE partner_lead_id = NEW.loan_lead_id
              AND verification_type = 'Address Verification'
              AND status = 'Verified'
        ) THEN
            RAISE EXCEPTION 'Record a Verified address verification before approval.' USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM public.partner_verifications
            WHERE partner_lead_id = NEW.loan_lead_id
              AND verification_type = 'Photograph Verification'
              AND status = 'Verified'
        ) THEN
            RAISE EXCEPTION 'Record a Verified photograph verification before approval.' USING ERRCODE = '22023';
        END IF;
        IF v_registration_type IS DISTINCT FROM 'Not registered'
           AND NOT EXISTS (
                SELECT 1 FROM public.partner_verifications
                WHERE partner_lead_id = NEW.loan_lead_id
                  AND verification_type = 'Business Registration Verification'
                  AND status = 'Verified'
           ) THEN
            RAISE EXCEPTION 'Record a Verified business registration verification before approval.' USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM public.partner_verifications
            WHERE partner_lead_id = NEW.loan_lead_id
              AND verification_type = 'Overall Review'
              AND status = 'Verified'
        ) THEN
            RAISE EXCEPTION 'Complete the overall partner review before approval.' USING ERRCODE = '22023';
        END IF;
    END IF;

    IF NEW.application_status = 'Rejected'
       AND (OLD.application_status IS DISTINCT FROM 'Rejected')
       AND nullif(btrim(coalesce(NEW.rejection_reason, '')), '') IS NULL THEN
        RAISE EXCEPTION 'Enter the rejection reason before rejecting this partner application.' USING ERRCODE = '22023';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_partner_application_status
    ON public.partner_application_details;
CREATE TRIGGER validate_partner_application_status
    BEFORE UPDATE ON public.partner_application_details
    FOR EACH ROW EXECUTE PROCEDURE public.validate_partner_application_status();

-- -----------------------------------------------------------------------------
-- 11. Submit a partner application
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_partner_application(
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
    v_business JSONB := coalesce(p_payload->'business', '{}'::JSONB);
    v_network JSONB := coalesce(p_payload->'network', '{}'::JSONB);
    v_declarations JSONB := coalesce(p_payload->'declarations', '{}'::JSONB);

    v_name TEXT := btrim(coalesce(v_personal->>'full_name', ''));
    v_mobile TEXT := regexp_replace(coalesce(v_personal->>'mobile', ''), '[^0-9]', '', 'g');
    v_email TEXT := nullif(lower(btrim(coalesce(v_personal->>'email', ''))), '');
    v_city TEXT := nullif(btrim(coalesce(v_personal->>'city', '')), '');
    v_state TEXT := nullif(btrim(coalesce(v_personal->>'state', '')), '');
    v_pan TEXT := upper(nullif(btrim(coalesce(v_personal->>'pan_number', '')), ''));

    v_firm TEXT := nullif(btrim(coalesce(v_business->>'firm_name', '')), '');
    v_partner_type TEXT := btrim(coalesce(v_business->>'partner_type', ''));
    v_office_line TEXT := nullif(btrim(coalesce(v_business->>'office_address', '')), '');
    v_office_city TEXT := nullif(btrim(coalesce(v_business->>'office_city', '')), '');
    v_office_state TEXT := nullif(btrim(coalesce(v_business->>'office_state', '')), '');
    v_office_pin TEXT := regexp_replace(coalesce(v_business->>'office_pincode', ''), '[^0-9]', '', 'g');
    v_reg_type TEXT := btrim(coalesce(v_business->>'business_registration_type', ''));
    v_reg_number TEXT := nullif(btrim(coalesce(v_business->>'business_registration_number', '')), '');
    v_gst TEXT := upper(nullif(btrim(coalesce(v_business->>'gst_number', '')), ''));
    v_years INTEGER := coalesce(nullif(v_business->>'years_experience', '')::INTEGER, 0);
    v_fin_exp TEXT := btrim(coalesce(v_business->>'financial_services_experience', ''));
    v_dsa_assoc TEXT := nullif(btrim(coalesce(v_business->>'existing_dsa_associations', '')), '');
    v_bank_assoc TEXT := nullif(btrim(coalesce(v_business->>'bank_associations', '')), '');

    v_products JSONB := coalesce(v_network->'products', '[]'::JSONB);
    v_expected_leads INTEGER := coalesce(nullif(v_network->>'expected_leads_per_month', '')::INTEGER, 0);
    v_locations TEXT := nullif(btrim(coalesce(v_network->>'preferred_locations', '')), '');
    v_referral_source TEXT := nullif(btrim(coalesce(v_network->>'referral_source', '')), '');
    v_notes TEXT := nullif(btrim(coalesce(v_network->>'additional_notes', '')), '');

    v_accuracy BOOLEAN := coalesce((v_declarations->>'accuracy')::BOOLEAN, false);
    v_commission_terms BOOLEAN := coalesce((v_declarations->>'commission_terms')::BOOLEAN, false);
    v_no_guarantee BOOLEAN := coalesce((v_declarations->>'no_guarantee')::BOOLEAN, false);
    v_consent BOOLEAN := coalesce((p_payload->>'consent')::BOOLEAN, false);
    v_consent_version TEXT := coalesce(nullif(p_payload->>'consent_version', ''), '2026-11');
    v_source TEXT := nullif(btrim(coalesce(p_payload->>'source_page', '')), '');

    v_product TEXT;
    v_products_array TEXT[] := ARRAY[]::TEXT[];
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
        RAISE EXCEPTION 'Please enter your full name.' USING ERRCODE = '22023';
    END IF;
    IF length(v_name) > 200 THEN
        RAISE EXCEPTION 'Please enter a shorter full name.' USING ERRCODE = '22023';
    END IF;
    IF v_mobile !~ '^[6-9][0-9]{9}$' THEN
        RAISE EXCEPTION 'Please enter a valid 10-digit Indian mobile number.' USING ERRCODE = '22023';
    END IF;
    IF v_email IS NULL OR v_email !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN
        RAISE EXCEPTION 'Please enter a valid email address.' USING ERRCODE = '22023';
    END IF;
    IF v_city IS NULL OR v_state IS NULL THEN
        RAISE EXCEPTION 'Please enter your city and state.' USING ERRCODE = '22023';
    END IF;
    IF v_pan IS NULL OR v_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' THEN
        RAISE EXCEPTION 'Please enter a valid PAN (e.g. ABCDE1234F).' USING ERRCODE = '22023';
    END IF;

    -- ---- Business profile --------------------------------------------------
    IF v_firm IS NULL THEN
        RAISE EXCEPTION 'Please enter your business or firm name.' USING ERRCODE = '22023';
    END IF;
    IF v_partner_type NOT IN (
        'Individual / Referral Partner',
        'Chartered Accountant / Tax Consultant',
        'Property Consultant / Broker',
        'Insurance Advisor',
        'Financial Services Company',
        'Bank / NBFC Relationship',
        'Other') THEN
        RAISE EXCEPTION 'Please select a valid partner type.' USING ERRCODE = '22023';
    END IF;
    IF v_office_line IS NULL OR v_office_city IS NULL OR v_office_state IS NULL THEN
        RAISE EXCEPTION 'Please enter the complete office address.' USING ERRCODE = '22023';
    END IF;
    IF v_office_pin !~ '^[0-9]{6}$' THEN
        RAISE EXCEPTION 'Please enter a valid 6-digit office PIN code.' USING ERRCODE = '22023';
    END IF;
    IF v_reg_type NOT IN (
        'Proprietorship', 'Partnership', 'LLP', 'Private Limited',
        'Public Limited', 'Society / Trust', 'Not registered') THEN
        RAISE EXCEPTION 'Please select a valid business registration type.' USING ERRCODE = '22023';
    END IF;
    IF v_reg_type <> 'Not registered' AND v_reg_number IS NULL THEN
        RAISE EXCEPTION 'Please enter the business registration number.' USING ERRCODE = '22023';
    END IF;
    IF v_gst IS NOT NULL AND v_gst !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' THEN
        RAISE EXCEPTION 'Please enter a valid 15-character GSTIN or leave it blank.' USING ERRCODE = '22023';
    END IF;
    IF v_years < 0 OR v_years > 60 THEN
        RAISE EXCEPTION 'Years of experience must be between 0 and 60.' USING ERRCODE = '22023';
    END IF;
    IF v_fin_exp NOT IN (
        'None', 'Less than 1 year', '1-3 years', '3-5 years',
        '5-10 years', 'More than 10 years') THEN
        RAISE EXCEPTION 'Please select your financial services experience.' USING ERRCODE = '22023';
    END IF;

    -- ---- Products and expected network ------------------------------------
    IF jsonb_typeof(v_products) <> 'array' THEN
        RAISE EXCEPTION 'Please select the products you want to refer in the expected format.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(v_products) < 1 THEN
        RAISE EXCEPTION 'Please select at least one product you want to refer.' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(v_products) > 14 THEN
        RAISE EXCEPTION 'Please select a valid combination of products.' USING ERRCODE = '22023';
    END IF;

    FOR v_product IN SELECT value FROM jsonb_array_elements_text(v_products)
    LOOP
        IF v_product NOT IN (
            'Home Loan', 'Loan Against Property', 'Business Loan',
            'Working Capital (CC/OD)', 'Personal Loan', 'Vehicle Loan',
            'Education Loan', 'Gold Loan', 'Loan Protection Insurance',
            'Credit Health / CIBIL Advisory', 'ITR Filing',
            'GST Registration & Filing', 'MSME / Udyam Registration',
            'All products') THEN
            RAISE EXCEPTION 'Please select valid products.' USING ERRCODE = '22023';
        END IF;
        IF NOT (v_product = ANY (v_products_array)) THEN
            v_products_array := array_append(v_products_array, v_product);
        END IF;
    END LOOP;

    IF v_expected_leads < 0 OR v_expected_leads > 1000 THEN
        RAISE EXCEPTION 'Expected leads per month must be between 0 and 1000.' USING ERRCODE = '22023';
    END IF;

    -- ---- Declarations and consent -----------------------------------------
    IF NOT v_accuracy THEN
        RAISE EXCEPTION 'Please confirm that the information provided is true and complete.' USING ERRCODE = '22023';
    END IF;
    IF NOT v_commission_terms THEN
        RAISE EXCEPTION 'Please confirm that you understand commission is governed by the signed partner agreement and actual disbursal.' USING ERRCODE = '22023';
    END IF;
    IF NOT v_no_guarantee THEN
        RAISE EXCEPTION 'Please confirm that you understand no lead volume, approval or commission is guaranteed.' USING ERRCODE = '22023';
    END IF;
    IF NOT v_consent THEN
        RAISE EXCEPTION 'Please accept the privacy notice and partner terms before submitting.' USING ERRCODE = '22023';
    END IF;

    v_message := left(
        'Partner application: ' || v_partner_type ||
        ' | Firm: ' || v_firm ||
        ' | Experience: ' || v_years::TEXT || ' years' ||
        ' | Products: ' || array_to_string(v_products_array, ', ') ||
        ' | Expected leads/month: ' || v_expected_leads::TEXT,
        1000
    );

    -- ---- Create the lead ---------------------------------------------------
    INSERT INTO public.loan_leads (
        full_name, mobile, email, loan_type, loan_amount, message,
        applicant_type, residency_status, employment_type,
        consent_given, consent_at, consent_version, source_page
    ) VALUES (
        v_name, v_mobile, v_email, 'DSA Partner Network', 0, v_message,
        'resident', 'Resident', 'Self-employed',
        true, now(), v_consent_version, v_source
    )
    RETURNING id, reference_no, access_token INTO v_id, v_ref, v_token;

    -- ---- Structured partner application -----------------------------------
    INSERT INTO public.partner_application_details (
        loan_lead_id, applicant_name, mobile, email, applicant_city,
        applicant_state, pan_number, firm_name, partner_type,
        office_address, office_city, office_state, office_pincode,
        business_registration_type, business_registration_number, gst_number,
        years_experience, financial_services_experience,
        existing_dsa_associations, bank_associations,
        products, expected_leads_per_month, preferred_locations,
        referral_source, additional_notes,
        accuracy_declaration, commission_declaration, no_guarantee_declaration
    ) VALUES (
        v_id, v_name, v_mobile, v_email, v_city,
        v_state, v_pan, v_firm, v_partner_type,
        v_office_line, v_office_city, v_office_state, v_office_pin,
        v_reg_type, v_reg_number, v_gst,
        v_years, v_fin_exp,
        v_dsa_assoc, v_bank_assoc,
        v_products_array, v_expected_leads, v_locations,
        v_referral_source, v_notes,
        true, true, true
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
        'loan_type', 'DSA Partner Network',
        'partner_type', v_partner_type,
        'firm_name', v_firm,
        'application_status', 'Application Received',
        'products', to_jsonb(v_products_array),
        'expected_leads_per_month', v_expected_leads
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 12. Review a partner application (administrator only)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.review_partner_application(
    p_lead_id UUID,
    p_action TEXT,
    p_assigned_executive_id UUID DEFAULT NULL,
    p_remarks TEXT DEFAULT NULL
)
RETURNS SETOF public.api_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_role TEXT := nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-role';
    v_admin_id UUID := (nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-user-id')::UUID;
    v_details RECORD;
    v_registration_type TEXT;
    v_lead_status TEXT;
    v_remarks TEXT := nullif(btrim(coalesce(p_remarks, '')), '');
    v_ref TEXT;
    v_current_status TEXT;
BEGIN
    IF v_role IS DISTINCT FROM 'admin' THEN
        RAISE EXCEPTION 'Only an administrator can review a partner application.' USING ERRCODE = '42501';
    END IF;
    IF v_admin_id IS NULL THEN
        RAISE EXCEPTION 'The administrator session could not be verified.' USING ERRCODE = '42501';
    END IF;
    IF p_action NOT IN (
        'Under Review', 'Documents Pending', 'Verification In Progress',
        'Approved', 'Rejected', 'On Hold') THEN
        RAISE EXCEPTION 'Please select a valid review action.' USING ERRCODE = '22023';
    END IF;
    IF p_action = 'Rejected' AND v_remarks IS NULL THEN
        RAISE EXCEPTION 'Enter the rejection reason before rejecting this application.' USING ERRCODE = '22023';
    END IF;
    IF p_assigned_executive_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_assigned_executive_id) THEN
        RAISE EXCEPTION 'The selected executive account does not exist.' USING ERRCODE = '22023';
    END IF;

    SELECT d.*, l.reference_no
    INTO v_details
    FROM public.partner_application_details d
    JOIN public.loan_leads l ON l.id = d.loan_lead_id
    WHERE d.loan_lead_id = p_lead_id;

    IF v_details.id IS NULL THEN
        RAISE EXCEPTION 'This partner application could not be found.' USING ERRCODE = '22023';
    END IF;

    v_current_status := v_details.application_status;
    v_ref := v_details.reference_no;
    v_registration_type := v_details.business_registration_type;

    IF p_action = 'Approved' THEN
        IF p_assigned_executive_id IS NULL AND v_details.assigned_executive_id IS NULL THEN
            RAISE EXCEPTION 'Assign an executive before approving this partner application.' USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM public.partner_documents
            WHERE partner_lead_id = p_lead_id
              AND document_type = 'PAN Card' AND status = 'Verified'
        ) THEN
            RAISE EXCEPTION 'Verify the partner PAN Card before approval.' USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM public.partner_documents
            WHERE partner_lead_id = p_lead_id
              AND document_type = 'Address Proof' AND status = 'Verified'
        ) THEN
            RAISE EXCEPTION 'Verify the partner Address Proof before approval.' USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM public.partner_documents
            WHERE partner_lead_id = p_lead_id
              AND document_type = 'Photograph' AND status = 'Verified'
        ) THEN
            RAISE EXCEPTION 'Verify the partner Photograph before approval.' USING ERRCODE = '22023';
        END IF;
        IF v_registration_type IS DISTINCT FROM 'Not registered'
           AND NOT EXISTS (
                SELECT 1 FROM public.partner_documents
                WHERE partner_lead_id = p_lead_id
                  AND document_type = 'Business Registration' AND status = 'Verified'
           ) THEN
            RAISE EXCEPTION 'Verify the Business Registration document before approval.' USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM public.partner_verifications
            WHERE partner_lead_id = p_lead_id
              AND verification_type = 'PAN Verification' AND status = 'Verified'
        ) THEN
            RAISE EXCEPTION 'Record a Verified PAN verification before approval.' USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM public.partner_verifications
            WHERE partner_lead_id = p_lead_id
              AND verification_type = 'Address Verification' AND status = 'Verified'
        ) THEN
            RAISE EXCEPTION 'Record a Verified address verification before approval.' USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM public.partner_verifications
            WHERE partner_lead_id = p_lead_id
              AND verification_type = 'Photograph Verification' AND status = 'Verified'
        ) THEN
            RAISE EXCEPTION 'Record a Verified photograph verification before approval.' USING ERRCODE = '22023';
        END IF;
        IF v_registration_type IS DISTINCT FROM 'Not registered'
           AND NOT EXISTS (
                SELECT 1 FROM public.partner_verifications
                WHERE partner_lead_id = p_lead_id
                  AND verification_type = 'Business Registration Verification'
                  AND status = 'Verified'
           ) THEN
            RAISE EXCEPTION 'Record a Verified business registration verification before approval.' USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM public.partner_verifications
            WHERE partner_lead_id = p_lead_id
              AND verification_type = 'Overall Review' AND status = 'Verified'
        ) THEN
            RAISE EXCEPTION 'Complete the overall partner review before approval.' USING ERRCODE = '22023';
        END IF;
    END IF;

    UPDATE public.partner_application_details
    SET application_status = p_action,
        assigned_executive_id = coalesce(p_assigned_executive_id, assigned_executive_id),
        rejection_reason = CASE WHEN p_action = 'Rejected' THEN v_remarks ELSE nullif(btrim(coalesce(rejection_reason, '')), '') END,
        status_notes = coalesce(v_remarks, status_notes),
        reviewed_by = v_admin_id,
        reviewed_at = now()
    WHERE loan_lead_id = p_lead_id;

    v_lead_status := CASE p_action
        WHEN 'Under Review' THEN 'Under Review'
        WHEN 'Documents Pending' THEN 'Documents Pending'
        WHEN 'Verification In Progress' THEN 'In Progress'
        WHEN 'Approved' THEN 'Approved'
        WHEN 'Rejected' THEN 'Rejected'
        ELSE 'Pending'
    END;

    UPDATE public.loan_leads
    SET status = v_lead_status,
        admin_notes = coalesce(v_remarks, admin_notes)
    WHERE id = p_lead_id;

    RETURN QUERY SELECT gen_random_uuid(), jsonb_build_object(
        'id', p_lead_id,
        'reference_no', v_ref,
        'previous_status', v_current_status,
        'application_status', p_action,
        'assigned_executive_id', coalesce(p_assigned_executive_id, v_details.assigned_executive_id),
        'reviewed_at', now()
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 13. Provision a partner login (administrator only)
-- -----------------------------------------------------------------------------
-- The auth user is created by an administrator in the Nhost dashboard. This
-- function links that user to the approved partner, grants the partner role and
-- activates the profile. It requires a signed, effective agreement.

CREATE OR REPLACE FUNCTION public.provision_partner_login(
    p_lead_id UUID,
    p_user_id UUID
)
RETURNS SETOF public.api_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_role TEXT := nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-role';
    v_details RECORD;
    v_profile RECORD;
    v_email TEXT;
    v_default_role TEXT;
    v_partner_code TEXT;
    v_agreement RECORD;
BEGIN
    IF v_role IS DISTINCT FROM 'admin' THEN
        RAISE EXCEPTION 'Only an administrator can provision a partner login.' USING ERRCODE = '42501';
    END IF;
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'Select the auth user to provision.' USING ERRCODE = '22023';
    END IF;

    SELECT d.*, l.reference_no
    INTO v_details
    FROM public.partner_application_details d
    JOIN public.loan_leads l ON l.id = d.loan_lead_id
    WHERE d.loan_lead_id = p_lead_id;

    IF v_details.id IS NULL THEN
        RAISE EXCEPTION 'This partner application could not be found.' USING ERRCODE = '22023';
    END IF;
    IF v_details.application_status IS DISTINCT FROM 'Approved' THEN
        RAISE EXCEPTION 'Approve the partner application before provisioning a login.' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_agreement
    FROM public.partner_agreements
    WHERE partner_lead_id = p_lead_id
      AND agreement_status IN ('Signed', 'Active')
      AND signed_date IS NOT NULL
      AND effective_from IS NOT NULL
      AND effective_from <= (now() AT TIME ZONE 'Asia/Kolkata')::date
    ORDER BY effective_from DESC
    LIMIT 1;

    IF v_agreement.id IS NULL THEN
        RAISE EXCEPTION 'Record a signed and effective partner agreement before provisioning a login.' USING ERRCODE = '22023';
    END IF;

    SELECT lower(email) INTO v_email FROM auth.users WHERE id = p_user_id;
    IF v_email IS NULL THEN
        RAISE EXCEPTION 'The selected auth user could not be found.' USING ERRCODE = '22023';
    END IF;
    IF v_email IS DISTINCT FROM v_details.email THEN
        RAISE EXCEPTION 'The auth user email must match the approved partner email.' USING ERRCODE = '22023';
    END IF;

    SELECT default_role INTO v_default_role FROM auth.users WHERE id = p_user_id;
    IF v_default_role = 'admin' THEN
        RAISE EXCEPTION 'An administrator account cannot be converted into a partner login.' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_profile
    FROM public.partner_profiles
    WHERE loan_lead_id = p_lead_id OR user_id = p_user_id
    LIMIT 1;

    IF v_profile.id IS NOT NULL
       AND v_profile.loan_lead_id IS DISTINCT FROM p_lead_id THEN
        RAISE EXCEPTION 'This auth user is already linked to another partner profile.' USING ERRCODE = '22023';
    END IF;

    INSERT INTO auth.roles (role) VALUES ('partner')
    ON CONFLICT (role) DO NOTHING;

    INSERT INTO auth.user_roles (user_id, role) VALUES (p_user_id, 'partner')
    ON CONFLICT DO NOTHING;

    UPDATE auth.users SET default_role = 'partner' WHERE id = p_user_id;

    v_partner_code := coalesce(v_profile.partner_code, public.next_reference('DP'));

    INSERT INTO public.partner_profiles (
        loan_lead_id, user_id, partner_code, display_name, firm_name,
        partner_type, status, onboarding_completed, activated_at
    ) VALUES (
        p_lead_id, p_user_id, v_partner_code, v_details.applicant_name,
        v_details.firm_name, v_details.partner_type, 'Active', true, now()
    )
    ON CONFLICT (loan_lead_id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        status = 'Active',
        onboarding_completed = true,
        activated_at = coalesce(public.partner_profiles.activated_at, now()),
        suspended_at = NULL,
        suspension_reason = NULL
    RETURNING partner_code INTO v_partner_code;

    RETURN QUERY SELECT gen_random_uuid(), jsonb_build_object(
        'partner_profile_id', (SELECT id FROM public.partner_profiles WHERE loan_lead_id = p_lead_id),
        'partner_code', v_partner_code,
        'email', v_email,
        'status', 'Active',
        'agreement_status', v_agreement.agreement_status
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 14. Update an assigned lead's progress (partner only)
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.update_partner_lead_status(
    p_assignment_id UUID,
    p_status TEXT,
    p_notes TEXT DEFAULT NULL
)
RETURNS SETOF public.api_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_role TEXT := nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-role';
    v_user_id TEXT := nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-user-id';
    v_profile_id UUID;
    v_assignment RECORD;
    v_notes TEXT := nullif(btrim(coalesce(p_notes, '')), '');
BEGIN
    IF v_role IS DISTINCT FROM 'partner' THEN
        RAISE EXCEPTION 'Only a provisioned partner can update an assigned lead.' USING ERRCODE = '42501';
    END IF;
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'The partner session could not be verified.' USING ERRCODE = '42501';
    END IF;
    IF p_status NOT IN ('Contacted', 'Documents Pending', 'Submitted to Lender') THEN
        RAISE EXCEPTION 'Partners may only set Contacted, Documents Pending or Submitted to Lender.' USING ERRCODE = '22023';
    END IF;

    SELECT id INTO v_profile_id
    FROM public.partner_profiles
    WHERE user_id::text = v_user_id
      AND status = 'Active';

    IF v_profile_id IS NULL THEN
        RAISE EXCEPTION 'Your partner account is not active. Please contact Dhanvi Finserv.' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_assignment
    FROM public.partner_lead_assignments
    WHERE id = p_assignment_id
      AND partner_profile_id = v_profile_id;

    IF v_assignment.id IS NULL THEN
        RAISE EXCEPTION 'This lead assignment could not be found.' USING ERRCODE = '22023';
    END IF;
    IF v_assignment.status IN ('Sanctioned', 'Disbursed', 'Rejected', 'Closed') THEN
        RAISE EXCEPTION 'This lead is closed for partner updates. Please contact your executive.' USING ERRCODE = '22023';
    END IF;

    UPDATE public.partner_lead_assignments
    SET status = p_status,
        status_notes = coalesce(v_notes, status_notes),
        last_contacted_at = CASE WHEN p_status = 'Contacted' THEN now() ELSE last_contacted_at END,
        submitted_at = CASE WHEN p_status = 'Submitted to Lender' THEN now() ELSE submitted_at END
    WHERE id = p_assignment_id;

    RETURN QUERY SELECT gen_random_uuid(), jsonb_build_object(
        'assignment_id', p_assignment_id,
        'status', p_status,
        'updated_at', now()
    );
END;
$$;

-- -----------------------------------------------------------------------------
-- 15. Extra document types for partner applications
-- -----------------------------------------------------------------------------
-- Widen the CHECK on public.loan_documents.document_type and re-register
-- register_document() with the same allowed list, adding Business Registration
-- and Onboarding Document.

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
        'No Dues Certificate', 'Settlement Letter',
        'Business Registration', 'Onboarding Document'
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

    v_user_id := nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-user-id';
    v_role := nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-role';
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Please start a secure upload session and try again.' USING ERRCODE = '28000';
    END IF;

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
        'No Dues Certificate', 'Settlement Letter',
        'Business Registration', 'Onboarding Document'
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

-- -----------------------------------------------------------------------------
-- 16. Partner role seed
-- -----------------------------------------------------------------------------

INSERT INTO auth.roles (role) VALUES ('partner')
ON CONFLICT (role) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 17. Row-level security (defence-in-depth)
-- -----------------------------------------------------------------------------
-- Hasura row filters are still the primary boundary. These policies repeat the
-- rule for any direct non-owner database connection: administrators see
-- everything, a partner sees only rows belonging to their own profile.
--
-- RLS is enabled, not forced, so SECURITY DEFINER functions and the table
-- owner keep working. Do not grant a partner direct insert/update/delete on
-- any table; lead progress goes through update_partner_lead_status().

ALTER TABLE public.partner_application_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_lead_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_followups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS partner_application_admin_all ON public.partner_application_details;
CREATE POLICY partner_application_admin_all ON public.partner_application_details
    FOR ALL TO PUBLIC
    USING (coalesce(nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-role', '') = 'admin')
    WITH CHECK (coalesce(nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-role', '') = 'admin');

DROP POLICY IF EXISTS partner_application_select_own ON public.partner_application_details;
CREATE POLICY partner_application_select_own ON public.partner_application_details
    FOR SELECT TO PUBLIC
    USING (EXISTS (
        SELECT 1 FROM public.partner_profiles p
        WHERE p.loan_lead_id = partner_application_details.loan_lead_id
          AND p.user_id::text = coalesce(nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-user-id', '')
    ));

DROP POLICY IF EXISTS partner_profiles_admin_all ON public.partner_profiles;
CREATE POLICY partner_profiles_admin_all ON public.partner_profiles
    FOR ALL TO PUBLIC
    USING (coalesce(nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-role', '') = 'admin')
    WITH CHECK (coalesce(nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-role', '') = 'admin');

DROP POLICY IF EXISTS partner_profiles_select_own ON public.partner_profiles;
CREATE POLICY partner_profiles_select_own ON public.partner_profiles
    FOR SELECT TO PUBLIC
    USING (user_id::text = coalesce(nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-user-id', ''));

DROP POLICY IF EXISTS partner_documents_admin_all ON public.partner_documents;
CREATE POLICY partner_documents_admin_all ON public.partner_documents
    FOR ALL TO PUBLIC
    USING (coalesce(nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-role', '') = 'admin')
    WITH CHECK (coalesce(nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-role', '') = 'admin');

DROP POLICY IF EXISTS partner_documents_select_own ON public.partner_documents;
CREATE POLICY partner_documents_select_own ON public.partner_documents
    FOR SELECT TO PUBLIC
    USING (EXISTS (
        SELECT 1 FROM public.partner_profiles p
        WHERE p.loan_lead_id = partner_documents.partner_lead_id
          AND p.user_id::text = coalesce(nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-user-id', '')
    ));

DROP POLICY IF EXISTS partner_verifications_admin_all ON public.partner_verifications;
CREATE POLICY partner_verifications_admin_all ON public.partner_verifications
    FOR ALL TO PUBLIC
    USING (coalesce(nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-role', '') = 'admin')
    WITH CHECK (coalesce(nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-role', '') = 'admin');

DROP POLICY IF EXISTS partner_verifications_select_own ON public.partner_verifications;
CREATE POLICY partner_verifications_select_own ON public.partner_verifications
    FOR SELECT TO PUBLIC
    USING (EXISTS (
        SELECT 1 FROM public.partner_profiles p
        WHERE p.loan_lead_id = partner_verifications.partner_lead_id
          AND p.user_id::text = coalesce(nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-user-id', '')
    ));

DROP POLICY IF EXISTS partner_agreements_admin_all ON public.partner_agreements;
CREATE POLICY partner_agreements_admin_all ON public.partner_agreements
    FOR ALL TO PUBLIC
    USING (coalesce(nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-role', '') = 'admin')
    WITH CHECK (coalesce(nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-role', '') = 'admin');

DROP POLICY IF EXISTS partner_agreements_select_own ON public.partner_agreements;
CREATE POLICY partner_agreements_select_own ON public.partner_agreements
    FOR SELECT TO PUBLIC
    USING (EXISTS (
        SELECT 1 FROM public.partner_profiles p
        WHERE p.loan_lead_id = partner_agreements.partner_lead_id
          AND p.user_id::text = coalesce(nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-user-id', '')
    ));

DROP POLICY IF EXISTS partner_assignments_admin_all ON public.partner_lead_assignments;
CREATE POLICY partner_assignments_admin_all ON public.partner_lead_assignments
    FOR ALL TO PUBLIC
    USING (coalesce(nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-role', '') = 'admin')
    WITH CHECK (coalesce(nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-role', '') = 'admin');

DROP POLICY IF EXISTS partner_assignments_select_own ON public.partner_lead_assignments;
CREATE POLICY partner_assignments_select_own ON public.partner_lead_assignments
    FOR SELECT TO PUBLIC
    USING (EXISTS (
        SELECT 1 FROM public.partner_profiles p
        WHERE p.id = partner_lead_assignments.partner_profile_id
          AND p.user_id::text = coalesce(nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-user-id', '')
    ));

DROP POLICY IF EXISTS partner_commissions_admin_all ON public.partner_commissions;
CREATE POLICY partner_commissions_admin_all ON public.partner_commissions
    FOR ALL TO PUBLIC
    USING (coalesce(nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-role', '') = 'admin')
    WITH CHECK (coalesce(nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-role', '') = 'admin');

DROP POLICY IF EXISTS partner_commissions_select_own ON public.partner_commissions;
CREATE POLICY partner_commissions_select_own ON public.partner_commissions
    FOR SELECT TO PUBLIC
    USING (EXISTS (
        SELECT 1 FROM public.partner_profiles p
        WHERE p.id = partner_commissions.partner_profile_id
          AND p.user_id::text = coalesce(nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-user-id', '')
    ));

DROP POLICY IF EXISTS partner_followups_admin_all ON public.partner_followups;
CREATE POLICY partner_followups_admin_all ON public.partner_followups
    FOR ALL TO PUBLIC
    USING (coalesce(nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-role', '') = 'admin')
    WITH CHECK (coalesce(nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-role', '') = 'admin');

DROP POLICY IF EXISTS partner_followups_select_own ON public.partner_followups;
CREATE POLICY partner_followups_select_own ON public.partner_followups
    FOR SELECT TO PUBLIC
    USING (EXISTS (
        SELECT 1 FROM public.partner_profiles p
        WHERE (p.loan_lead_id = partner_followups.partner_lead_id
               OR p.id = partner_followups.partner_profile_id)
          AND p.user_id::text = coalesce(nullif(current_setting('hasura.user', true), '')::JSONB->>'x-hasura-user-id', '')
    ));

COMMIT;

-- =============================================================================
-- END OF MIGRATION
-- =============================================================================

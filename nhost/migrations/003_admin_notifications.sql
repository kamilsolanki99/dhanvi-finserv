-- =============================================================================
-- NHOST / HASURA MIGRATION: 003_admin_notifications.sql
-- PROJECT: Dhanvi Finserv
--
-- Run this file once in the Nhost dashboard:
--   Database -> SQL Editor -> paste -> Run
--
-- It creates:
--   1. public.admin_notifications - the persisted notification inbox.
--   2. Indexes for the feed, unread counts and per-admin delivery.
--   3. A read-state trigger that records read_at / read_by.
--   4. SECURITY DEFINER notification triggers on the business tables.
--
-- DESIGN NOTES
--   * Every real business event creates one notification row per admin in
--     public.admin_profiles. This keeps read/delete state private to each
--     administrator. If no admin profile exists yet, one shared row
--     (recipient_user_id = NULL) is written so the event is not lost.
--   * Triggers are SECURITY DEFINER so the public RPCs can create
--     notifications even though the browser roles have no INSERT permission
--     on admin_notifications.
--   * Hasura permissions, not Postgres RLS, control access. Do not enable RLS.
--   * dedupe_key is unique (NULLs are allowed and never conflict), which makes
--     the triggers safe to retry without creating duplicate notifications.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Notification inbox
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.admin_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- NULL means a shared notification visible to every admin. The triggers
    -- normally write one row per admin instead, so read/delete state is
    -- private to that administrator.
    recipient_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'system' CHECK (type IN (
        'lead', 'callback', 'document', 'followup', 'support', 'complaint', 'system'
    )),
    title TEXT NOT NULL,
    message TEXT,
    entity_type TEXT,
    entity_id UUID,
    action_url TEXT,
    is_read BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at TIMESTAMPTZ,
    read_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    dedupe_key TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS admin_notifications_created_at_idx
    ON public.admin_notifications (created_at DESC);

CREATE INDEX IF NOT EXISTS admin_notifications_unread_idx
    ON public.admin_notifications (created_at DESC)
    WHERE is_read = false;

CREATE INDEX IF NOT EXISTS admin_notifications_recipient_idx
    ON public.admin_notifications (recipient_user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS admin_notifications_dedupe_key
    ON public.admin_notifications (dedupe_key);

COMMENT ON TABLE public.admin_notifications IS
    'Admin notification inbox. Rows are created by SECURITY DEFINER triggers on business tables.';
COMMENT ON COLUMN public.admin_notifications.recipient_user_id IS
    'Target admin (auth.users.id). NULL is a shared notification visible to all admins.';
COMMENT ON COLUMN public.admin_notifications.dedupe_key IS
    'Unique event key used by the triggers to prevent duplicate notifications.';

-- -----------------------------------------------------------------------------
-- 2. Read-state trigger
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_admin_notification_read_state()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_hasura_user TEXT;
    v_hasura_session TEXT;
    v_claims JSONB;
    v_session JSONB;
    v_user_id UUID;
BEGIN
    IF NEW.is_read IS DISTINCT FROM OLD.is_read THEN
        IF NEW.is_read THEN
            NEW.read_at := now();

            -- Hasura exposes the verified JWT claims in the hasura.user
            -- setting. Nhost puts the Hasura claims under the
            -- https://hasura.io/jwt/claims namespace, while other setups use
            -- flat claims. Accept both, then fall back to hasura.session
            -- (available on newer Hasura versions). Never trust a
            -- client-supplied read_by.
            BEGIN
                v_hasura_user := NULLIF(current_setting('hasura.user', true), '');
                v_hasura_session := NULLIF(current_setting('hasura.session', true), '');

                IF v_hasura_user IS NOT NULL THEN
                    v_claims := v_hasura_user::JSONB;
                    v_user_id := COALESCE(
                        NULLIF(v_claims -> 'https://hasura.io/jwt/claims' ->> 'x-hasura-user-id', ''),
                        NULLIF(v_claims ->> 'x-hasura-user-id', ''),
                        NULLIF(v_claims -> 'session_variables' ->> 'x-hasura-user-id', ''),
                        NULLIF(v_claims -> 'claims' ->> 'x-hasura-user-id', '')
                    )::UUID;
                END IF;

                IF v_user_id IS NULL AND v_hasura_session IS NOT NULL THEN
                    v_session := v_hasura_session::JSONB;
                    v_user_id := COALESCE(
                        NULLIF(v_session -> 'session_variables' ->> 'x-hasura-user-id', ''),
                        NULLIF(v_session ->> 'x-hasura-user-id', ''),
                        NULLIF(v_session -> 'user' -> 'https://hasura.io/jwt/claims' ->> 'x-hasura-user-id', '')
                    )::UUID;
                END IF;
            EXCEPTION WHEN OTHERS THEN
                v_user_id := NULL;
            END;

            NEW.read_by := v_user_id;
        ELSE
            NEW.read_at := NULL;
            NEW.read_by := NULL;
        END IF;
    ELSE
        -- Preserve the audit fields when is_read did not change.
        NEW.read_at := OLD.read_at;
        NEW.read_by := OLD.read_by;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS set_admin_notification_read_state ON public.admin_notifications;
CREATE TRIGGER set_admin_notification_read_state
    BEFORE UPDATE OF is_read ON public.admin_notifications
    FOR EACH ROW EXECUTE PROCEDURE public.set_admin_notification_read_state();

-- -----------------------------------------------------------------------------
-- 3. Business-event notification triggers
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.notify_admin_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row JSONB;
    v_type TEXT;
    v_title TEXT;
    v_message TEXT;
    v_entity_type TEXT;
    v_entity_id UUID;
    v_action_url TEXT;
    v_dedupe_key TEXT;
    v_metadata JSONB := '{}'::JSONB;
    v_lead_id UUID;
    v_lead_name TEXT;
    v_reference TEXT;
    v_lead_label TEXT;
BEGIN
    v_row := to_jsonb(NEW);
    v_entity_type := TG_TABLE_NAME;

    IF TG_TABLE_NAME = 'loan_leads' THEN
        IF TG_OP <> 'INSERT' THEN
            RETURN NEW;
        END IF;

        v_type := 'lead';
        v_title := 'New loan application';
        v_reference := COALESCE(v_row ->> 'reference_no', '');
        v_message := COALESCE(v_row ->> 'full_name', 'A customer') ||
            ' submitted a ' || COALESCE(v_row ->> 'loan_type', 'loan') ||
            ' application' ||
            CASE WHEN v_reference = '' THEN '' ELSE ' (' || v_reference || ')' END || '.';
        v_action_url := 'admin-applications.html';
        v_entity_id := (v_row ->> 'id')::UUID;
        v_dedupe_key := 'lead:' || v_entity_id::TEXT;
        v_metadata := jsonb_build_object(
            'reference_no', v_row ->> 'reference_no',
            'loan_type', v_row ->> 'loan_type',
            'loan_amount', v_row -> 'loan_amount',
            'status', v_row ->> 'status'
        );

    ELSIF TG_TABLE_NAME = 'callback_bookings' THEN
        IF TG_OP <> 'INSERT' THEN
            RETURN NEW;
        END IF;

        v_type := 'callback';
        v_title := 'New callback request';
        v_reference := COALESCE(v_row ->> 'reference_no', '');
        v_message := COALESCE(v_row ->> 'full_name', 'A customer') ||
            ' requested a callback on ' ||
            to_char((v_row ->> 'preferred_date')::DATE, 'DD Mon YYYY') ||
            ' at ' || COALESCE(v_row ->> 'preferred_slot', 'the selected slot') ||
            CASE WHEN v_reference = '' THEN '' ELSE ' (' || v_reference || ')' END || '.';
        v_action_url := 'admin-callbacks.html';
        v_entity_id := (v_row ->> 'id')::UUID;
        v_dedupe_key := 'callback:' || v_entity_id::TEXT;
        v_metadata := jsonb_build_object(
            'reference_no', v_row ->> 'reference_no',
            'preferred_date', v_row ->> 'preferred_date',
            'preferred_slot', v_row ->> 'preferred_slot',
            'status', v_row ->> 'status'
        );

    ELSIF TG_TABLE_NAME = 'post_disbursal_requests' THEN
        IF TG_OP <> 'INSERT' THEN
            RETURN NEW;
        END IF;

        v_type := 'support';
        v_title := 'New post-disbursal request';
        v_reference := COALESCE(v_row ->> 'reference_no', '');
        v_message := COALESCE(v_row ->> 'full_name', 'A customer') ||
            ' submitted a ' || COALESCE(v_row ->> 'request_type', 'support') ||
            ' request' ||
            CASE WHEN v_reference = '' THEN '' ELSE ' (' || v_reference || ')' END || '.';
        v_action_url := 'admin-support.html';
        v_entity_id := (v_row ->> 'id')::UUID;
        v_dedupe_key := 'support:' || v_entity_id::TEXT;
        v_metadata := jsonb_build_object(
            'reference_no', v_row ->> 'reference_no',
            'request_type', v_row ->> 'request_type',
            'status', v_row ->> 'status'
        );

    ELSIF TG_TABLE_NAME = 'complaints' THEN
        IF TG_OP <> 'INSERT' THEN
            RETURN NEW;
        END IF;

        v_type := 'complaint';
        v_title := 'New complaint received';
        v_reference := COALESCE(v_row ->> 'ticket_no', '');
        v_message := COALESCE(v_row ->> 'full_name', 'A customer') ||
            ' raised a ' || COALESCE(v_row ->> 'category', 'support') ||
            ' complaint' ||
            CASE WHEN v_reference = '' THEN '' ELSE ' (' || v_reference || ')' END || '.';
        v_action_url := 'admin-complaints.html';
        v_entity_id := (v_row ->> 'id')::UUID;
        v_dedupe_key := 'complaint:' || v_entity_id::TEXT;
        v_metadata := jsonb_build_object(
            'ticket_no', v_row ->> 'ticket_no',
            'category', v_row ->> 'category',
            'status', v_row ->> 'status'
        );

    ELSIF TG_TABLE_NAME = 'loan_documents' THEN
        v_lead_id := NULLIF(v_row ->> 'loan_lead_id', '')::UUID;
        IF v_lead_id IS NOT NULL THEN
            SELECT l.full_name, l.reference_no
              INTO v_lead_name, v_reference
              FROM public.loan_leads l
             WHERE l.id = v_lead_id;
        END IF;

        v_lead_label := COALESCE(v_lead_name, 'a customer') ||
            CASE WHEN v_reference IS NULL OR v_reference = ''
                 THEN '' ELSE ' (' || v_reference || ')' END;

        IF TG_OP = 'INSERT' THEN
            v_type := 'document';
            v_title := 'New document uploaded';
            v_message := COALESCE(v_row ->> 'document_type', 'A document') ||
                ' was uploaded for ' || v_lead_label || '.';
            v_action_url := 'admin-documents.html';
            v_entity_id := (v_row ->> 'id')::UUID;
            v_dedupe_key := 'document-upload:' || v_entity_id::TEXT;
            v_metadata := jsonb_build_object(
                'document_type', v_row ->> 'document_type',
                'file_name', v_row ->> 'file_name',
                'status', v_row ->> 'status',
                'reference_no', v_reference
            );

        ELSIF TG_OP = 'UPDATE' THEN
            IF NEW.status IS NOT DISTINCT FROM OLD.status
               OR NEW.status NOT IN ('Verified', 'Rejected') THEN
                RETURN NEW;
            END IF;

            v_type := 'document';
            v_title := CASE NEW.status
                WHEN 'Verified' THEN 'Document verified'
                ELSE 'Document rejected'
            END;
            v_message := COALESCE(v_row ->> 'document_type', 'A document') ||
                ' for ' || v_lead_label ||
                CASE NEW.status
                    WHEN 'Verified' THEN ' has been verified.'
                    ELSE ' was rejected and needs to be re-uploaded.'
                END;
            v_action_url := 'admin-documents.html';
            v_entity_id := NEW.id;
            -- Include the transaction id so a document can be verified again
            -- after a rejection. The same status repeated in one transaction
            -- is still deduplicated, while a later legitimate transition is
            -- delivered as a new notification.
            v_dedupe_key := 'document-status:' || NEW.id::TEXT || ':' ||
                NEW.status || ':' || txid_current()::TEXT;
            v_metadata := jsonb_build_object(
                'document_type', v_row ->> 'document_type',
                'file_name', v_row ->> 'file_name',
                'status', NEW.status,
                'reference_no', v_reference
            );
        ELSE
            RETURN NEW;
        END IF;

    ELSIF TG_TABLE_NAME = 'loan_followups' THEN
        IF TG_OP <> 'INSERT' THEN
            RETURN NEW;
        END IF;

        v_lead_id := NULLIF(v_row ->> 'loan_lead_id', '')::UUID;
        IF v_lead_id IS NOT NULL THEN
            SELECT l.full_name, l.reference_no
              INTO v_lead_name, v_reference
              FROM public.loan_leads l
             WHERE l.id = v_lead_id;
        END IF;

        v_type := 'followup';
        v_title := 'Follow-up scheduled';
        v_message := COALESCE(v_row ->> 'interaction_type', 'A') ||
            ' follow-up was scheduled with ' ||
            COALESCE(v_lead_name, 'a customer') ||
            ' for ' ||
            to_char(
                (v_row ->> 'scheduled_at')::TIMESTAMPTZ AT TIME ZONE 'Asia/Kolkata',
                'DD Mon YYYY, HH12:MI AM'
            ) || '.';
        v_action_url := 'admin-followups.html';
        v_entity_id := (v_row ->> 'id')::UUID;
        v_dedupe_key := 'followup:' || v_entity_id::TEXT;
        v_metadata := jsonb_build_object(
            'interaction_type', v_row ->> 'interaction_type',
            'scheduled_at', v_row ->> 'scheduled_at',
            'status', v_row ->> 'status',
            'reference_no', v_reference
        );
    END IF;

    IF v_type IS NULL OR v_title IS NULL THEN
        RETURN NEW;
    END IF;

    -- Deliver one private copy to every admin. Read and delete actions then
    -- affect only that administrator's inbox. If the project has no admin
    -- profile yet, keep the event as a shared row instead of dropping it.
    --
    -- Notification delivery must never roll back the business event (a lead,
    -- callback or document upload). Log a warning and let the original write
    -- commit if the inbox insert fails.
    BEGIN
        IF EXISTS (SELECT 1 FROM public.admin_profiles WHERE role = 'admin') THEN
            INSERT INTO public.admin_notifications (
                recipient_user_id, type, title, message, entity_type, entity_id,
                action_url, dedupe_key, metadata
            )
            SELECT
                ap.user_id, v_type, v_title, v_message, v_entity_type, v_entity_id,
                v_action_url, v_dedupe_key || ':' || ap.user_id::TEXT, v_metadata
            FROM public.admin_profiles ap
            WHERE ap.role = 'admin'
            ON CONFLICT (dedupe_key) DO NOTHING;
        ELSE
            INSERT INTO public.admin_notifications (
                recipient_user_id, type, title, message, entity_type, entity_id,
                action_url, dedupe_key, metadata
            ) VALUES (
                NULL, v_type, v_title, v_message, v_entity_type, v_entity_id,
                v_action_url, v_dedupe_key, v_metadata
            )
            ON CONFLICT (dedupe_key) DO NOTHING;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'Dhanvi notification could not be created for % %: %',
            v_entity_type, v_entity_id, SQLERRM;
    END;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS notify_admin_new_lead ON public.loan_leads;
CREATE TRIGGER notify_admin_new_lead
    AFTER INSERT ON public.loan_leads
    FOR EACH ROW EXECUTE PROCEDURE public.notify_admin_event();

DROP TRIGGER IF EXISTS notify_admin_new_callback ON public.callback_bookings;
CREATE TRIGGER notify_admin_new_callback
    AFTER INSERT ON public.callback_bookings
    FOR EACH ROW EXECUTE PROCEDURE public.notify_admin_event();

DROP TRIGGER IF EXISTS notify_admin_new_post_disbursal ON public.post_disbursal_requests;
CREATE TRIGGER notify_admin_new_post_disbursal
    AFTER INSERT ON public.post_disbursal_requests
    FOR EACH ROW EXECUTE PROCEDURE public.notify_admin_event();

DROP TRIGGER IF EXISTS notify_admin_new_complaint ON public.complaints;
CREATE TRIGGER notify_admin_new_complaint
    AFTER INSERT ON public.complaints
    FOR EACH ROW EXECUTE PROCEDURE public.notify_admin_event();

DROP TRIGGER IF EXISTS notify_admin_new_document ON public.loan_documents;
CREATE TRIGGER notify_admin_new_document
    AFTER INSERT ON public.loan_documents
    FOR EACH ROW EXECUTE PROCEDURE public.notify_admin_event();

DROP TRIGGER IF EXISTS notify_admin_document_status ON public.loan_documents;
CREATE TRIGGER notify_admin_document_status
    AFTER UPDATE OF status ON public.loan_documents
    FOR EACH ROW EXECUTE PROCEDURE public.notify_admin_event();

DROP TRIGGER IF EXISTS notify_admin_new_followup ON public.loan_followups;
CREATE TRIGGER notify_admin_new_followup
    AFTER INSERT ON public.loan_followups
    FOR EACH ROW EXECUTE PROCEDURE public.notify_admin_event();

COMMIT;

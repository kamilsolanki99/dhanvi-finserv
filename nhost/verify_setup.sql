-- =============================================================================
-- Dhanvi Finserv - Nhost setup verification
--
-- Read-only. Run this in Nhost Dashboard -> Database -> SQL Editor.
-- It returns one JSON report. Paste the whole result back for review.
--
-- The report checks:
--   * all 10 business tables (including admin_notifications)
--   * every column in those tables
--   * all 9 callable API functions plus the 4 helpers
--   * all 6 updated_at triggers, the 7 notification triggers and the
--     notification read-state trigger
--   * all named indexes (including the notification indexes)
--   * the private loan-documents bucket and its settings
--   * the custom admin auth role
--   * the reference sequence
--   * the api_result SELECT grant
--   * that Postgres RLS is still disabled
-- =============================================================================

WITH expected_tables(name) AS (
    VALUES
        ('admin_profiles'),
        ('admin_notifications'),
        ('api_result'),
        ('callback_bookings'),
        ('complaints'),
        ('loan_applicants'),
        ('loan_documents'),
        ('loan_followups'),
        ('loan_leads'),
        ('post_disbursal_requests')
),
expected_functions(name, signature) AS (
    VALUES
        ('next_reference', 'public.next_reference(text)'),
        ('set_updated_at', 'public.set_updated_at()'),
        ('submit_loan_application_v2', 'public.submit_loan_application_v2(jsonb)'),
        ('book_callback', 'public.book_callback(text,text,text,date,text,text,text,boolean)'),
        ('get_booked_callback_slots', 'public.get_booked_callback_slots(date)'),
        ('submit_post_disbursal_request', 'public.submit_post_disbursal_request(text,text,text,text,text,text,boolean)'),
        ('submit_complaint', 'public.submit_complaint(text,text,text,text,text,text,boolean)'),
        ('lookup_application', 'public.lookup_application(text,text,text)'),
        ('get_application_by_token', 'public.get_application_by_token(uuid,uuid)'),
        ('register_document', 'public.register_document(uuid,uuid,text,uuid)'),
        ('get_application_documents', 'public.get_application_documents(uuid,uuid)'),
        ('set_admin_notification_read_state', 'public.set_admin_notification_read_state()'),
        ('notify_admin_event', 'public.notify_admin_event()')
),
expected_triggers(trigger_name, table_name) AS (
    VALUES
        ('update_loan_leads_modtime', 'loan_leads'),
        ('update_admin_profiles_modtime', 'admin_profiles'),
        ('update_loan_documents_modtime', 'loan_documents'),
        ('update_callback_bookings_modtime', 'callback_bookings'),
        ('update_post_disbursal_requests_modtime', 'post_disbursal_requests'),
        ('update_complaints_modtime', 'complaints'),
        ('notify_admin_new_lead', 'loan_leads'),
        ('notify_admin_new_callback', 'callback_bookings'),
        ('notify_admin_new_post_disbursal', 'post_disbursal_requests'),
        ('notify_admin_new_complaint', 'complaints'),
        ('notify_admin_new_document', 'loan_documents'),
        ('notify_admin_document_status', 'loan_documents'),
        ('notify_admin_new_followup', 'loan_followups'),
        ('set_admin_notification_read_state', 'admin_notifications')
),
expected_indexes(name) AS (
    VALUES
        ('loan_leads_reference_no_key'),
        ('loan_leads_access_token_key'),
        ('loan_leads_created_at_idx'),
        ('loan_leads_status_idx'),
        ('loan_applicants_lead_idx'),
        ('callback_bookings_reference_no_key'),
        ('callback_bookings_active_slot_key'),
        ('callback_bookings_date_idx'),
        ('callback_bookings_status_idx'),
        ('post_disbursal_requests_reference_no_key'),
        ('post_disbursal_requests_status_idx'),
        ('complaints_ticket_no_key'),
        ('complaints_status_idx'),
        ('loan_documents_lead_idx'),
        ('loan_documents_status_idx'),
        ('loan_followups_scheduled_idx'),
        ('admin_notifications_created_at_idx'),
        ('admin_notifications_unread_idx'),
        ('admin_notifications_recipient_idx'),
        ('admin_notifications_dedupe_key')
)
SELECT jsonb_pretty(jsonb_build_object(
    'tables', (
        SELECT jsonb_object_agg(
            e.name,
            CASE WHEN to_regclass('public.' || e.name) IS NULL THEN 'MISSING' ELSE 'OK' END
        )
        FROM expected_tables e
    ),
    'columns', (
        SELECT jsonb_object_agg(c.table_name, c.columns)
        FROM (
            SELECT table_name, jsonb_agg(column_name ORDER BY ordinal_position) AS columns
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name IN (SELECT name FROM expected_tables)
            GROUP BY table_name
        ) c
    ),
    'functions', (
        SELECT jsonb_object_agg(
            e.name,
            CASE WHEN to_regprocedure(e.signature) IS NULL THEN 'MISSING' ELSE 'OK' END
        )
        FROM expected_functions e
    ),
    'function_details', (
        SELECT jsonb_agg(jsonb_build_object(
            'name', p.proname,
            'arguments', pg_get_function_identity_arguments(p.oid),
            'returns', pg_get_function_result(p.oid),
            'volatility', CASE p.provolatile
                WHEN 'v' THEN 'VOLATILE'
                WHEN 's' THEN 'STABLE'
                WHEN 'i' THEN 'IMMUTABLE'
            END,
            'security_definer', p.prosecdef,
            'config', p.proconfig
        ) ORDER BY p.proname)
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN (SELECT name FROM expected_functions)
    ),
    'triggers', (
        SELECT jsonb_object_agg(
            e.trigger_name,
            CASE WHEN EXISTS (
                SELECT 1
                FROM pg_trigger t
                JOIN pg_class c ON c.oid = t.tgrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                  AND c.relname = e.table_name
                  AND t.tgname = e.trigger_name
                  AND NOT t.tgisinternal
            ) THEN 'OK' ELSE 'MISSING' END
        )
        FROM expected_triggers e
    ),
    'indexes', (
        SELECT jsonb_object_agg(
            e.name,
            CASE WHEN to_regclass('public.' || e.name) IS NULL THEN 'MISSING' ELSE 'OK' END
        )
        FROM expected_indexes e
    ),
    'bucket', COALESCE((
        SELECT jsonb_build_object(
            'id', b.id,
            'min_upload_file_size', b.min_upload_file_size,
            'max_upload_file_size', b.max_upload_file_size,
            'presigned_urls_enabled', b.presigned_urls_enabled,
            'download_expiration', b.download_expiration,
            'cache_control', b.cache_control
        )
        FROM storage.buckets b
        WHERE b.id = 'loan-documents'
    ), '{"status":"MISSING"}'::jsonb),
    'admin_role', EXISTS (
        SELECT 1 FROM auth.roles WHERE role = 'admin'
    ),
    'reference_sequence', to_regclass('public.df_reference_seq') IS NOT NULL,
    'api_result_grants', (
        SELECT COALESCE(
            jsonb_agg(
                jsonb_build_object('grantee', g.grantee, 'privilege', g.privilege_type)
                ORDER BY g.grantee, g.privilege_type
            ),
            '[]'::jsonb
        )
        FROM information_schema.role_table_grants g
        WHERE g.table_schema = 'public'
          AND g.table_name = 'api_result'
    ),
    'rls_enabled', (
        SELECT jsonb_object_agg(c.relname, c.relrowsecurity)
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname IN (SELECT name FROM expected_tables)
    )
)) AS verification_report;

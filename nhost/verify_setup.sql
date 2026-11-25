-- =============================================================================
-- Dhanvi Finserv - Nhost setup verification
--
-- Read-only. Run this in Nhost Dashboard -> Database -> SQL Editor.
-- It returns one JSON report. Paste the whole result back for review.
--
-- The report checks:
--   * all 31 tracked tables (including admin_notifications and the twenty-one
--     structured service / loan tables added by migrations 004 to 012)
--   * every column in those tables
--   * all 26 tracked functions (including the helpers)
--   * all 24 updated_at triggers, the 7 notification triggers and the
--     notification read-state trigger
--   * all named indexes (including the notification, Home Loan, Top-Up /
--     Takeover, LAP, Business Loan, Working Capital, ITR Filing, GST
--     Registration & Filing, MSME / Udyam, Loan Protection Insurance and
--     Credit Health / CIBIL indexes)
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
        ('post_disbursal_requests'),
        ('home_loan_details'),
        ('home_loan_emis'),
        ('home_loan_drafts'),
        ('home_loan_topup_details'),
        ('home_loan_takeover_details'),
        ('lap_details'),
        ('business_loan_details'),
        ('working_capital_details'),
        ('working_capital_facilities'),
        ('itr_filing_details'),
        ('itr_income_items'),
        ('itr_tax_payments'),
        ('gst_registration_details'),
        ('gst_return_filings'),
        ('msme_registration_details'),
        ('msme_promoters'),
        ('msme_registrations'),
        ('loan_insurance_details'),
        ('credit_health_details'),
        ('credit_accounts'),
        ('credit_enquiries')
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
        ('save_home_loan_draft', 'public.save_home_loan_draft(uuid,uuid,jsonb)'),
        ('get_home_loan_draft', 'public.get_home_loan_draft(uuid,uuid)'),
        ('submit_home_loan_application', 'public.submit_home_loan_application(jsonb,uuid,uuid)'),
        ('submit_home_loan_topup_application', 'public.submit_home_loan_topup_application(jsonb,uuid,uuid)'),
        ('submit_home_loan_takeover_application', 'public.submit_home_loan_takeover_application(jsonb,uuid,uuid)'),
        ('submit_lap_application', 'public.submit_lap_application(jsonb,uuid,uuid)'),
        ('submit_business_loan_application', 'public.submit_business_loan_application(jsonb,uuid,uuid)'),
        ('submit_working_capital_application', 'public.submit_working_capital_application(jsonb,uuid,uuid)'),
        ('submit_itr_application', 'public.submit_itr_application(jsonb,uuid,uuid)'),
        ('submit_gst_application', 'public.submit_gst_application(jsonb,uuid,uuid)'),
        ('submit_msme_application', 'public.submit_msme_application(jsonb,uuid,uuid)'),
        ('submit_loan_insurance_application', 'public.submit_loan_insurance_application(jsonb,uuid,uuid)'),
        ('submit_credit_health_application', 'public.submit_credit_health_application(jsonb,uuid,uuid)'),
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
        ('update_home_loan_details_modtime', 'home_loan_details'),
        ('update_home_loan_drafts_modtime', 'home_loan_drafts'),
        ('update_home_loan_topup_details_modtime', 'home_loan_topup_details'),
        ('update_home_loan_takeover_details_modtime', 'home_loan_takeover_details'),
        ('update_lap_details_modtime', 'lap_details'),
        ('update_business_loan_details_modtime', 'business_loan_details'),
        ('update_working_capital_details_modtime', 'working_capital_details'),
        ('update_working_capital_facilities_modtime', 'working_capital_facilities'),
        ('update_itr_filing_details_modtime', 'itr_filing_details'),
        ('update_gst_registration_details_modtime', 'gst_registration_details'),
        ('update_gst_return_filings_modtime', 'gst_return_filings'),
        ('update_msme_registration_details_modtime', 'msme_registration_details'),
        ('update_msme_promoters_modtime', 'msme_promoters'),
        ('update_msme_registrations_modtime', 'msme_registrations'),
        ('update_loan_insurance_details_modtime', 'loan_insurance_details'),
        ('update_credit_health_details_modtime', 'credit_health_details'),
        ('update_credit_accounts_modtime', 'credit_accounts'),
        ('update_credit_enquiries_modtime', 'credit_enquiries'),
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
        ('admin_notifications_dedupe_key'),
        ('home_loan_details_lead_idx'),
        ('home_loan_details_identity_idx'),
        ('home_loan_emis_lead_idx'),
        ('home_loan_drafts_token_key'),
        ('home_loan_drafts_reference_key'),
        ('home_loan_drafts_updated_at_idx'),
        ('home_loan_topup_details_lead_idx'),
        ('home_loan_topup_details_identity_idx'),
        ('home_loan_topup_details_lender_idx'),
        ('home_loan_takeover_details_lead_idx'),
        ('home_loan_takeover_details_identity_idx'),
        ('home_loan_takeover_details_lender_idx'),
        ('lap_details_lead_idx'),
        ('lap_details_identity_idx'),
        ('lap_details_property_category_idx'),
        ('business_loan_details_lead_idx'),
        ('business_loan_details_identity_idx'),
        ('business_loan_details_constitution_idx'),
        ('business_loan_details_gstin_idx'),
        ('working_capital_details_lead_idx'),
        ('working_capital_details_identity_idx'),
        ('working_capital_details_constitution_idx'),
        ('working_capital_details_gstin_idx'),
        ('working_capital_details_request_idx'),
        ('working_capital_facilities_lead_idx'),
        ('working_capital_facilities_bank_idx'),
        ('itr_filing_details_lead_idx'),
        ('itr_filing_details_identity_idx'),
        ('itr_filing_details_pan_idx'),
        ('itr_filing_details_ay_idx'),
        ('itr_filing_details_filing_idx'),
        ('itr_filing_details_category_idx'),
        ('itr_income_items_lead_idx'),
        ('itr_income_items_head_idx'),
        ('itr_tax_payments_lead_idx'),
        ('itr_tax_payments_type_idx'),
        ('gst_registration_details_lead_idx'),
        ('gst_registration_details_identity_idx'),
        ('gst_registration_details_pan_idx'),
        ('gst_registration_details_gstin_idx'),
        ('gst_registration_details_service_idx'),
        ('gst_registration_details_filing_idx'),
        ('gst_registration_details_return_period_idx'),
        ('gst_registration_details_state_idx'),
        ('gst_return_filings_lead_idx'),
        ('gst_return_filings_period_idx'),
        ('gst_return_filings_status_idx'),
        ('msme_registration_details_lead_idx'),
        ('msme_registration_details_identity_idx'),
        ('msme_registration_details_pan_idx'),
        ('msme_registration_details_service_idx'),
        ('msme_registration_details_status_idx'),
        ('msme_registration_details_udyam_idx'),
        ('msme_registration_details_state_idx'),
        ('msme_promoters_lead_idx'),
        ('msme_promoters_name_idx'),
        ('msme_promoters_pan_idx'),
        ('msme_registrations_lead_idx'),
        ('msme_registrations_type_idx'),
        ('msme_registrations_status_idx'),
        ('loan_insurance_details_lead_idx'),
        ('loan_insurance_details_status_idx'),
        ('loan_insurance_details_policy_idx'),
        ('loan_insurance_details_insurer_idx'),
        ('loan_insurance_details_loan_type_idx'),
        ('loan_insurance_details_state_idx'),
        ('credit_health_details_lead_idx'),
        ('credit_health_details_status_idx'),
        ('credit_health_details_service_idx'),
        ('credit_health_details_bureau_idx'),
        ('credit_health_details_score_idx'),
        ('credit_health_details_followup_idx'),
        ('credit_health_details_state_idx'),
        ('credit_accounts_lead_idx'),
        ('credit_accounts_type_idx'),
        ('credit_accounts_status_idx'),
        ('credit_enquiries_lead_idx'),
        ('credit_enquiries_date_idx'),
        ('credit_enquiries_bureau_idx')
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

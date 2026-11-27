/**
 * Dhanvi Finserv - Partner Network Administration
 *
 * Depends on: js/nhost-client.js, js/admin-layout.js
 *
 * Covers partner onboarding applications, document and verification checks,
 * agreements, login provisioning, partner profiles, lead assignments,
 * commissions and follow-ups. Every value is read from Hasura; there is no
 * mock data and no optimistic "success" without a database response.
 */
(function (window, document) {
    'use strict';

    var B = window.DhanviBackend;

    var VERIFICATION_TYPES = [
        'PAN Verification',
        'Business Registration Verification',
        'Address Verification',
        'Photograph Verification',
        'Bank / DSA Association Verification',
        'Overall Review'
    ];

    var APPLICATION_ACTIONS = [
        'Under Review',
        'Documents Pending',
        'Verification In Progress',
        'Approved',
        'Rejected',
        'On Hold'
    ];

    var MAIN_QUERY = [
        'query AdminPartnerNetwork {',
        '  partner_application_details(order_by: {created_at: desc}) {',
        '    id loan_lead_id applicant_name mobile email applicant_city applicant_state pan_number',
        '    firm_name partner_type office_address office_city office_state office_pincode',
        '    business_registration_type business_registration_number gst_number',
        '    years_experience financial_services_experience existing_dsa_associations bank_associations',
        '    products expected_leads_per_month preferred_locations referral_source additional_notes',
        '    accuracy_declaration commission_declaration no_guarantee_declaration',
        '    application_status assigned_executive_id admin_remarks rejection_reason status_notes',
        '    reviewed_by reviewed_at created_at updated_at',
        '  }',
        '  partner_profiles(order_by: {created_at: desc}) {',
        '    id loan_lead_id user_id partner_code display_name firm_name partner_type status',
        '    onboarding_completed activated_at suspended_at suspension_reason admin_notes created_at updated_at',
        '  }',
        '  partner_verifications(order_by: {verification_type: asc}) {',
        '    id partner_lead_id verification_type status reference_no findings remarks',
        '    verified_by verified_at created_at updated_at',
        '  }',
        '  partner_agreements(order_by: {created_at: desc}) {',
        '    id partner_lead_id agreement_type agreement_status agreement_reference',
        '    effective_from effective_to signed_date document_name commission_terms',
        '    admin_remarks created_at updated_at',
        '  }',
        '  partner_lead_assignments(order_by: {assigned_at: desc}) {',
        '    id partner_profile_id loan_lead_id assignment_reference customer_name customer_mobile',
        '    customer_email product_type requested_amount customer_city customer_state',
        '    lender_name lender_reference status status_notes assigned_at last_contacted_at',
        '    submitted_at sanctioned_amount disbursed_amount disbursed_date admin_remarks created_at updated_at',
        '  }',
        '  partner_commissions(order_by: {created_at: desc}) {',
        '    id partner_profile_id lead_assignment_id loan_lead_id commission_type basis_amount',
        '    rate_percent commission_amount tds_amount net_payable status invoice_no invoice_date',
        '    approved_by approved_at paid_at payment_reference remarks created_at updated_at',
        '  }',
        '  partner_followups(order_by: {scheduled_at: asc}) {',
        '    id partner_lead_id partner_profile_id lead_assignment_id scheduled_at interaction_type',
        '    status notes completed_at created_by created_at updated_at',
        '  }',
        '  loan_leads(where: {loan_type: {_eq: "DSA Partner Network"}}) {',
        '    id reference_no status created_at',
        '  }',
        '  admin_profiles { user_id role full_name }',
        '}'
    ].join('\n');

    var DOCUMENTS_QUERY = [
        'query PartnerDocuments($leadIds: [uuid!]!) {',
        '  loan_documents(where: {loan_lead_id: {_in: $leadIds}}, order_by: {created_at: desc}) {',
        '    id loan_lead_id document_type status file_name notes verification_date created_at',
        '  }',
        '}'
    ].join('\n');

    var state = {
        loaded: false,
        loading: false,
        error: null,
        applications: [],
        profiles: [],
        verifications: [],
        agreements: [],
        assignments: [],
        commissions: [],
        followups: [],
        leads: [],
        admins: [],
        documents: [],
        currentReviewLeadId: null,
        currentPartnerId: null,
        currentLeadId: null,
        currentCommissionId: null,
        currentFollowupId: null,
        reviewAutoOpened: false
    };

    /* ------------------------------------------------------------------ *
     * Helpers
     * ------------------------------------------------------------------ */

    function el(id) { return document.getElementById(id); }

    function esc(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function prettyDate(value) {
        if (!value) { return '—'; }
        var date = new Date(value);
        return isNaN(date.getTime()) ? esc(value)
            : date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    }

    function prettyDateTime(value) {
        if (!value) { return '—'; }
        var date = new Date(value);
        return isNaN(date.getTime()) ? esc(value)
            : date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) +
              ', ' + date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    }

    function money(value) {
        if (value === null || value === undefined || value === '') { return '—'; }
        var number = Number(value);
        return isNaN(number) ? '—' : '\u20B9' + number.toLocaleString('en-IN', { maximumFractionDigits: 2 });
    }

    function numOrNull(value) {
        var text = String(value === null || value === undefined ? '' : value).trim();
        if (text === '') { return null; }
        var number = Number(text);
        return isNaN(number) ? null : number;
    }

    function textOrNull(value) {
        var text = String(value === null || value === undefined ? '' : value).trim();
        return text === '' ? null : text;
    }

    function localTodayIso() {
        var now = new Date();
        return now.getFullYear() + '-' +
            String(now.getMonth() + 1).padStart(2, '0') + '-' +
            String(now.getDate()).padStart(2, '0');
    }

    function isUuid(value) {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
    }

    function badgeClass(status) {
        switch (status) {
            case 'Approved':
            case 'Active':
            case 'Sanctioned':
            case 'Paid':
            case 'Verified':
            case 'Completed':
                return 'badge-approved';
            case 'Under Review':
            case 'Verification In Progress':
            case 'Contacted':
            case 'Submitted to Lender':
            case 'Invoiced':
            case 'Sent for Signature':
            case 'Signed':
            case 'In Progress':
                return 'badge-progress';
            case 'Documents Pending':
            case 'Pending Agreement':
            case 'Pending':
            case 'On Hold':
            case 'Not Started':
            case 'Draft':
                return 'badge-pending';
            case 'Rejected':
            case 'Suspended':
            case 'Cancelled':
            case 'Failed':
            case 'Expired':
            case 'Terminated':
                return 'badge-rejected';
            case 'Withdrawn':
            case 'Inactive':
            case 'Closed':
            case 'Not Applicable':
                return 'badge-closed';
            case 'Assigned':
                return 'badge-new';
            case 'Disbursed':
                return 'badge-verified';
            default:
                return 'badge-pending';
        }
    }

    function badge(status) {
        var value = status === null || status === undefined || status === '' ? 'Unknown' : String(status);
        return '<span class="badge-status ' + badgeClass(value) + '">' + esc(value) + '</span>';
    }

    function detailRow(label, value) {
        var display = (value === null || value === undefined || value === '') ? '—' : value;
        return '<div class="detail-row"><span class="detail-label">' + esc(label) + '</span>' +
            '<span class="detail-value">' + display + '</span></div>';
    }

    function subHeading(title) {
        return '<h6 class="partner-subhead">' + esc(title) + '</h6>';
    }

    function emptyRow(colspan, message, icon) {
        return '<tr><td colspan="' + colspan + '"><div class="empty-state">' +
            '<i class="fa ' + (icon || 'fa-inbox') + '"></i><strong>Nothing to show</strong>' +
            esc(message) + '</div></td></tr>';
    }

    function loadingRow(colspan, message) {
        return '<tr><td colspan="' + colspan + '" class="loading-state">' +
            '<i class="fa fa-circle-o-notch fa-spin"></i>' + esc(message) + '</td></tr>';
    }

    function errorRow(colspan, message) {
        return '<tr><td colspan="' + colspan + '"><div class="empty-state">' +
            '<i class="fa fa-exclamation-triangle"></i><strong>Could not load</strong>' +
            esc(message) + '</div></td></tr>';
    }

    function backend() { return window.DhanviBackend; }

    function currentAdminId() {
        var admin = window.DhanviAdmin && window.DhanviAdmin.user;
        return admin ? admin.id : null;
    }

    function showPageAlert(type, message) {
        var box = el('partnersAlert');
        if (box) {
            box.className = 'admin-alert show admin-alert-' + (type === 'error' ? 'error' : (type === 'success' ? 'success' : 'warning'));
            box.textContent = message;
        }
        if (window.DhanviNotify) {
            window.DhanviNotify.show({ type: type === 'warning' ? 'warning' : type, message: message, context: 'partnersPageAlert' });
        }
    }

    function hidePageAlert() {
        var box = el('partnersAlert');
        if (box) { box.className = 'admin-alert'; box.textContent = ''; }
        if (window.DhanviNotify && window.DhanviNotify.dismissContext) {
            window.DhanviNotify.dismissContext('partnersPageAlert');
        }
    }

    function showModalAlert(modalId, type, message) {
        var box = el(modalId + 'Alert');
        if (box) {
            box.className = 'admin-alert show admin-alert-' + (type === 'error' ? 'error' : 'success');
            box.textContent = message;
        }
        if (window.DhanviNotify) {
            window.DhanviNotify.show({ type: type, message: message, context: modalId + 'Alert' });
        }
    }

    function hideModalAlert(modalId) {
        var box = el(modalId + 'Alert');
        if (box) { box.className = 'admin-alert'; box.textContent = ''; }
        if (window.DhanviNotify && window.DhanviNotify.dismissContext) {
            window.DhanviNotify.dismissContext(modalId + 'Alert');
        }
    }

    function setBusy(button, busy, label) {
        if (!button) { return; }
        button.disabled = busy;
        button.textContent = busy ? 'Saving…' : label;
    }

    /* ------------------------------------------------------------------ *
     * Lookups
     * ------------------------------------------------------------------ */

    function applicationByLead(leadId) {
        for (var i = 0; i < state.applications.length; i += 1) {
            if (state.applications[i].loan_lead_id === leadId) { return state.applications[i]; }
        }
        return null;
    }

    function profileByLead(leadId) {
        for (var i = 0; i < state.profiles.length; i += 1) {
            if (state.profiles[i].loan_lead_id === leadId) { return state.profiles[i]; }
        }
        return null;
    }

    function profileById(id) {
        for (var i = 0; i < state.profiles.length; i += 1) {
            if (state.profiles[i].id === id) { return state.profiles[i]; }
        }
        return null;
    }

    function leadById(id) {
        for (var i = 0; i < state.leads.length; i += 1) {
            if (state.leads[i].id === id) { return state.leads[i]; }
        }
        return null;
    }

    function assignmentById(id) {
        for (var i = 0; i < state.assignments.length; i += 1) {
            if (state.assignments[i].id === id) { return state.assignments[i]; }
        }
        return null;
    }

    function verificationFor(leadId, type) {
        for (var i = 0; i < state.verifications.length; i += 1) {
            if (state.verifications[i].partner_lead_id === leadId &&
                state.verifications[i].verification_type === type) {
                return state.verifications[i];
            }
        }
        return null;
    }

    function latestAgreement(leadId) {
        var rows = state.agreements.filter(function (row) { return row.partner_lead_id === leadId; });
        rows.sort(function (a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); });
        return rows.length ? rows[0] : null;
    }

    function adminName(userId) {
        if (!userId) { return '—'; }
        for (var i = 0; i < state.admins.length; i += 1) {
            if (state.admins[i].user_id === userId) {
                return state.admins[i].full_name || state.admins[i].user_id;
            }
        }
        return userId;
    }

    function partnerLabel(profile) {
        if (!profile) { return '—'; }
        return (profile.display_name || 'Partner') + (profile.partner_code ? ' (' + profile.partner_code + ')' : '');
    }

    function documentsForLead(leadId) {
        return state.documents.filter(function (doc) { return doc.loan_lead_id === leadId; });
    }

    /* ------------------------------------------------------------------ *
     * Load
     * ------------------------------------------------------------------ */

    function setLoadingState() {
        ['applicationsBody', 'partnersBody', 'leadsBody', 'commissionsBody', 'followupsBody'].forEach(function (id) {
            var body = el(id);
            if (body && !body.getAttribute('data-rendered')) {
                body.innerHTML = loadingRow(8, 'Loading partner records…');
            }
        });
    }

    async function loadAll(silent) {
        if (state.loading) { return; }
        state.loading = true;
        if (!silent) {
            hidePageAlert();
            setLoadingState();
            renderAll();
        }

        try {
            var data = await backend().adminGql(MAIN_QUERY);
            state.applications = (data && data.partner_application_details) || [];
            state.profiles = (data && data.partner_profiles) || [];
            state.verifications = (data && data.partner_verifications) || [];
            state.agreements = (data && data.partner_agreements) || [];
            state.assignments = (data && data.partner_lead_assignments) || [];
            state.commissions = (data && data.partner_commissions) || [];
            state.followups = (data && data.partner_followups) || [];
            state.leads = (data && data.loan_leads) || [];
            state.admins = (data && data.admin_profiles) || [];
            state.error = null;
            state.loaded = true;

            var leadIds = [];
            state.applications.forEach(function (app) {
                if (app.loan_lead_id && leadIds.indexOf(app.loan_lead_id) === -1) {
                    leadIds.push(app.loan_lead_id);
                }
            });

            state.documents = [];
            if (leadIds.length) {
                try {
                    var docs = await backend().adminGql(DOCUMENTS_QUERY, { leadIds: leadIds });
                    state.documents = (docs && docs.loan_documents) || [];
                } catch (docError) {
                    console.warn('Partner document query failed:', docError);
                }
            }
        } catch (error) {
            console.error('Partner network load failed:', error);
            state.error = error;
            state.loaded = true;
            var message = String((error && error.message) || error || '');
            if (/field 'partner_(application_details|profiles|verifications|agreements|lead_assignments|commissions|followups)' not found/i.test(message)) {
                showPageAlert('warning', 'The Partner Network tables are not available in Hasura yet. Apply migration 013, then track the eight partner tables and four partner functions with admin access.');
            } else {
                showPageAlert('error', 'The partner records could not be loaded. ' + (backend().errorMessage ? backend().errorMessage(error) : message));
            }
        } finally {
            state.loading = false;
            renderAll();
            openReviewFromQuery();
        }
    }

    function openReviewFromQuery() {
        if (state.reviewAutoOpened || !state.loaded) { return; }
        var params;
        try { params = new URLSearchParams(window.location.search); } catch (err) { return; }
        var leadId = params.get('lead');
        if (!leadId) { return; }
        if (!applicationByLead(leadId)) { return; }
        state.reviewAutoOpened = true;
        switchTab('applications');
        openReview(leadId);
    }

    /* ------------------------------------------------------------------ *
     * Tabs
     * ------------------------------------------------------------------ */

    function switchTab(tab) {
        Array.prototype.forEach.call(document.querySelectorAll('.admin-tab'), function (button) {
            button.classList.toggle('active', button.getAttribute('data-tab') === tab);
        });
        Array.prototype.forEach.call(document.querySelectorAll('.tab-panel'), function (panel) {
            panel.classList.toggle('active', panel.id === 'tab-' + tab);
        });
        if (tab === 'applications') { renderApplications(); }
        if (tab === 'partners') { renderPartners(); }
        if (tab === 'leads') { renderLeads(); }
        if (tab === 'commissions') { renderCommissions(); }
        if (tab === 'followups') { renderFollowups(); }
    }

    /* ------------------------------------------------------------------ *
     * Stats and rendering
     * ------------------------------------------------------------------ */

    function renderStats() {
        var pendingReview = state.applications.filter(function (app) {
            return ['Application Received', 'Under Review', 'Documents Pending', 'Verification In Progress', 'On Hold'].indexOf(app.application_status) !== -1;
        }).length;
        var activePartners = state.profiles.filter(function (profile) { return profile.status === 'Active'; }).length;
        var openLeads = state.assignments.filter(function (row) {
            return ['Assigned', 'Contacted', 'Documents Pending', 'Submitted to Lender'].indexOf(row.status) !== -1;
        }).length;
        var commissionPending = state.commissions.reduce(function (total, row) {
            if (['Pending', 'Approved', 'Invoiced', 'On Hold'].indexOf(row.status) === -1) { return total; }
            var net = row.net_payable !== null && row.net_payable !== undefined
                ? Number(row.net_payable) : (Number(row.commission_amount) || 0) - (Number(row.tds_amount) || 0);
            return total + (isNaN(net) ? 0 : net);
        }, 0);

        setText('statPendingReview', state.loading ? '…' : String(pendingReview));
        setText('statActivePartners', state.loading ? '…' : String(activePartners));
        setText('statOpenLeads', state.loading ? '…' : String(openLeads));
        setText('statCommissionPending', state.loading ? '…' : money(commissionPending));
    }

    function setText(id, value) {
        var node = el(id);
        if (node) { node.textContent = value; }
    }

    function renderAll() {
        renderStats();
        renderApplications();
        renderPartners();
        renderLeads();
        renderCommissions();
        renderFollowups();
        renderPartnerFilters();
    }

    function renderApplications() {
        var body = el('applicationsBody');
        if (!body) { return; }
        body.setAttribute('data-rendered', '1');

        var search = (el('applicationSearch') && el('applicationSearch').value || '').toLowerCase();
        var status = el('applicationStatusFilter') ? el('applicationStatusFilter').value : '';
        var rows = state.applications.filter(function (app) {
            var lead = leadById(app.loan_lead_id) || {};
            var text = [app.applicant_name, app.firm_name, app.partner_type, app.mobile, app.email, app.applicant_city, lead.reference_no].join(' ').toLowerCase();
            return (!search || text.indexOf(search) !== -1) &&
                (!status || app.application_status === status);
        });

        if (!state.loaded) {
            body.innerHTML = loadingRow(8, 'Loading partner applications…');
            return;
        }
        if (state.error) {
            body.innerHTML = errorRow(8, 'The partner applications could not be loaded.');
            return;
        }
        if (!rows.length) {
            body.innerHTML = emptyRow(8, 'No partner applications match this view.', 'fa-handshake-o');
            return;
        }

        body.innerHTML = rows.map(function (app) {
            var lead = leadById(app.loan_lead_id) || {};
            var profile = profileByLead(app.loan_lead_id);
            var profileCell = profile
                ? '<span class="mono">' + esc(profile.partner_code || '—') + '</span><div class="muted">' + esc(profile.status) + '</div>'
                : '<span class="muted">Not provisioned</span>';
            return '<tr>' +
                '<td class="mono">' + esc(lead.reference_no || '—') + '</td>' +
                '<td><strong>' + esc(app.applicant_name || '—') + '</strong><div class="muted">' + esc(app.mobile || '') + '</div></td>' +
                '<td>' + esc(app.firm_name || '—') + '<div class="muted">' + esc(app.partner_type || '') + '</div></td>' +
                '<td>' + esc([app.applicant_city, app.applicant_state].filter(Boolean).join(', ') || '—') + '</td>' +
                '<td>' + badge(app.application_status) + '</td>' +
                '<td>' + profileCell + '</td>' +
                '<td>' + prettyDate(app.created_at) + '</td>' +
                '<td class="row-actions"><button type="button" class="btn-action btn-view" data-review="' + esc(app.loan_lead_id) + '">Review</button></td>' +
                '</tr>';
        }).join('');
    }

    function renderPartners() {
        var body = el('partnersBody');
        if (!body) { return; }
        body.setAttribute('data-rendered', '1');

        var search = (el('partnerSearch') && el('partnerSearch').value || '').toLowerCase();
        var status = el('partnerStatusFilter') ? el('partnerStatusFilter').value : '';
        var rows = state.profiles.filter(function (profile) {
            var text = [profile.display_name, profile.firm_name, profile.partner_code, profile.partner_type].join(' ').toLowerCase();
            return (!search || text.indexOf(search) !== -1) && (!status || profile.status === status);
        });

        if (!state.loaded) {
            body.innerHTML = loadingRow(8, 'Loading partner profiles…');
            return;
        }
        if (state.error) {
            body.innerHTML = errorRow(8, 'The partner profiles could not be loaded.');
            return;
        }
        if (!rows.length) {
            body.innerHTML = emptyRow(8, 'No provisioned partner profiles match this view.', 'fa-users');
            return;
        }

        body.innerHTML = rows.map(function (profile) {
            var assignments = state.assignments.filter(function (row) { return row.partner_profile_id === profile.id; });
            var sanctioned = assignments.filter(function (row) { return row.status === 'Sanctioned'; }).length;
            var disbursed = assignments.filter(function (row) { return row.status === 'Disbursed'; }).length;
            var paid = state.commissions.filter(function (row) {
                return row.partner_profile_id === profile.id && row.status === 'Paid';
            }).reduce(function (total, row) {
                var net = row.net_payable !== null && row.net_payable !== undefined
                    ? Number(row.net_payable) : (Number(row.commission_amount) || 0) - (Number(row.tds_amount) || 0);
                return total + (isNaN(net) ? 0 : net);
            }, 0);

            return '<tr>' +
                '<td class="mono">' + esc(profile.partner_code || '—') + '</td>' +
                '<td><strong>' + esc(profile.display_name || '—') + '</strong><div class="muted">' + esc(profile.firm_name || '') + '</div></td>' +
                '<td>' + esc(profile.partner_type || '—') + '</td>' +
                '<td>' + badge(profile.status) + '</td>' +
                '<td>' + assignments.length + '</td>' +
                '<td>' + sanctioned + '</td>' +
                '<td>' + disbursed + '</td>' +
                '<td>' + money(paid) + '</td>' +
                '<td>' + prettyDate(profile.activated_at) + '</td>' +
                '<td class="row-actions"><button type="button" class="btn-action btn-view" data-partner="' + esc(profile.id) + '">Manage</button></td>' +
                '</tr>';
        }).join('');
    }

    function renderPartnerFilters() {
        var options = ['<option value="">All partners</option>'].concat(state.profiles.map(function (profile) {
            return '<option value="' + esc(profile.id) + '">' + esc(partnerLabel(profile)) + '</option>';
        })).join('');

        ['leadPartnerFilter', 'commissionPartnerFilter'].forEach(function (id) {
            var select = el(id);
            if (!select) { return; }
            var current = select.value;
            select.innerHTML = options;
            if (current) { select.value = current; }
        });
    }

    function renderLeads() {
        var body = el('leadsBody');
        if (!body) { return; }
        body.setAttribute('data-rendered', '1');

        var search = (el('leadSearch') && el('leadSearch').value || '').toLowerCase();
        var status = el('leadStatusFilter') ? el('leadStatusFilter').value : '';
        var partnerId = el('leadPartnerFilter') ? el('leadPartnerFilter').value : '';
        var rows = state.assignments.filter(function (row) {
            var profile = profileById(row.partner_profile_id) || {};
            var text = [row.assignment_reference, row.customer_name, row.customer_mobile, row.product_type, profile.display_name, profile.partner_code].join(' ').toLowerCase();
            return (!search || text.indexOf(search) !== -1) &&
                (!status || row.status === status) &&
                (!partnerId || row.partner_profile_id === partnerId);
        });

        if (!state.loaded) {
            body.innerHTML = loadingRow(9, 'Loading assigned leads…');
            return;
        }
        if (state.error) {
            body.innerHTML = errorRow(9, 'Assigned leads could not be loaded.');
            return;
        }
        if (!rows.length) {
            body.innerHTML = emptyRow(9, 'No partner leads match this view. Use “Assign lead” to record a new assignment.', 'fa-users');
            return;
        }

        body.innerHTML = rows.map(function (row) {
            var profile = profileById(row.partner_profile_id);
            return '<tr>' +
                '<td class="mono">' + esc(row.assignment_reference || '—') + '</td>' +
                '<td>' + esc(partnerLabel(profile)) + '</td>' +
                '<td><strong>' + esc(row.customer_name || '—') + '</strong><div class="muted">' + esc(row.customer_mobile || '') + '</div></td>' +
                '<td>' + esc(row.product_type || '—') + '</td>' +
                '<td>' + money(row.requested_amount) + '</td>' +
                '<td>' + badge(row.status) + '</td>' +
                '<td>' + esc(row.lender_name || '—') + '</td>' +
                '<td>' + prettyDate(row.assigned_at) + '</td>' +
                '<td class="row-actions"><button type="button" class="btn-action btn-view" data-lead="' + esc(row.id) + '">Update</button></td>' +
                '</tr>';
        }).join('');
    }

    function renderCommissions() {
        var body = el('commissionsBody');
        if (!body) { return; }
        body.setAttribute('data-rendered', '1');

        var status = el('commissionStatusFilter') ? el('commissionStatusFilter').value : '';
        var partnerId = el('commissionPartnerFilter') ? el('commissionPartnerFilter').value : '';
        var rows = state.commissions.filter(function (row) {
            return (!status || row.status === status) &&
                (!partnerId || row.partner_profile_id === partnerId);
        });

        if (!state.loaded) {
            body.innerHTML = loadingRow(10, 'Loading commission records…');
            return;
        }
        if (state.error) {
            body.innerHTML = errorRow(10, 'Commission records could not be loaded.');
            return;
        }
        if (!rows.length) {
            body.innerHTML = emptyRow(10, 'No commission records match this view. Add a commission only after the related disbursal and agreement check.', 'fa-inr');
            return;
        }

        body.innerHTML = rows.map(function (row) {
            var profile = profileById(row.partner_profile_id);
            var assignment = assignmentById(row.lead_assignment_id) || {};
            var rate = row.rate_percent === null || row.rate_percent === undefined ? '—' : esc(String(row.rate_percent)) + '%';
            var net = row.net_payable !== null && row.net_payable !== undefined
                ? Number(row.net_payable) : (Number(row.commission_amount) || 0) - (Number(row.tds_amount) || 0);
            return '<tr>' +
                '<td>' + prettyDate(row.created_at) + '</td>' +
                '<td>' + esc(partnerLabel(profile)) + '</td>' +
                '<td class="mono">' + esc(assignment.assignment_reference || '—') + '</td>' +
                '<td>' + esc(row.commission_type || '—') + '</td>' +
                '<td>' + money(row.basis_amount) + '</td>' +
                '<td>' + rate + '</td>' +
                '<td>' + money(row.commission_amount) + '</td>' +
                '<td>' + money(row.tds_amount) + '</td>' +
                '<td><strong>' + money(net) + '</strong></td>' +
                '<td>' + badge(row.status) + '</td>' +
                '<td class="row-actions"><button type="button" class="btn-action btn-view" data-commission="' + esc(row.id) + '">Edit</button></td>' +
                '</tr>';
        }).join('');
    }

    function renderFollowups() {
        var body = el('followupsBody');
        if (!body) { return; }
        body.setAttribute('data-rendered', '1');

        var search = (el('followupSearch') && el('followupSearch').value || '').toLowerCase();
        var status = el('followupStatusFilter') ? el('followupStatusFilter').value : '';
        var rows = state.followups.filter(function (row) {
            var profile = profileById(row.partner_profile_id) || {};
            var assignment = assignmentById(row.lead_assignment_id) || {};
            var text = [row.interaction_type, row.notes, profile.display_name, profile.partner_code, assignment.assignment_reference].join(' ').toLowerCase();
            return (!search || text.indexOf(search) !== -1) && (!status || row.status === status);
        });

        if (!state.loaded) {
            body.innerHTML = loadingRow(8, 'Loading partner follow-ups…');
            return;
        }
        if (state.error) {
            body.innerHTML = errorRow(8, 'Partner follow-ups could not be loaded.');
            return;
        }
        if (!rows.length) {
            body.innerHTML = emptyRow(8, 'No partner follow-ups match this view.', 'fa-calendar-check-o');
            return;
        }

        body.innerHTML = rows.map(function (row) {
            var profile = profileById(row.partner_profile_id);
            var assignment = assignmentById(row.lead_assignment_id);
            var actions = '<button type="button" class="btn-action btn-view" data-followup="' + esc(row.id) + '">Edit</button>';
            if (row.status === 'Pending') {
                actions += ' <button type="button" class="btn-action btn-complete" data-followup-complete="' + esc(row.id) + '">Complete</button>' +
                    ' <button type="button" class="btn-action btn-cancel" data-followup-cancel="' + esc(row.id) + '">Cancel</button>';
            }
            return '<tr>' +
                '<td>' + prettyDateTime(row.scheduled_at) + '</td>' +
                '<td>' + esc(partnerLabel(profile)) + '</td>' +
                '<td class="mono">' + esc(assignment ? assignment.assignment_reference : '—') + '</td>' +
                '<td>' + esc(row.interaction_type || '—') + '</td>' +
                '<td>' + badge(row.status) + '</td>' +
                '<td>' + esc(row.notes || '—') + '</td>' +
                '<td>' + prettyDateTime(row.completed_at) + '</td>' +
                '<td class="row-actions">' + actions + '</td>' +
                '</tr>';
        }).join('');
    }

    /* ------------------------------------------------------------------ *
     * Review modal
     * ------------------------------------------------------------------ */

    function openReview(leadId) {
        var app = applicationByLead(leadId);
        if (!app) {
            showPageAlert('error', 'That partner application could not be found. Refresh the page and try again.');
            return;
        }

        state.currentReviewLeadId = leadId;
        hideModalAlert('reviewModal');

        renderReviewHeader(app);
        renderReviewDecision(app);
        renderReviewDetails(app);
        renderReviewDocuments(app);
        renderReviewVerifications(app);
        renderReviewAgreement(app);
        renderReviewProfile(app);

        if (window.jQuery) { window.jQuery('#reviewModal').modal('show'); }
    }

    function renderReviewHeader(app) {
        var lead = leadById(app.loan_lead_id) || {};
        setText('reviewTitle', app.applicant_name || 'Partner application');
        setText('reviewReference', lead.reference_no || '—');
        var badgeBox = el('reviewStatusBadge');
        if (badgeBox) { badgeBox.innerHTML = badge(app.application_status); }
    }

    function reviewReadiness(app, prospectiveExecutiveId) {
        var registered = app.business_registration_type && app.business_registration_type !== 'Not registered';
        var requiredDocs = ['PAN Card', 'Address Proof', 'Photograph']
            .concat(registered ? ['Business Registration'] : []);
        var requiredVerifications = ['PAN Verification', 'Address Verification', 'Photograph Verification', 'Overall Review']
            .concat(registered ? ['Business Registration Verification'] : []);
        var docs = documentsForLead(app.loan_lead_id);
        var items = [];

        requiredDocs.forEach(function (type) {
            var found = docs.filter(function (doc) {
                return doc.document_type === type && doc.status === 'Verified';
            });
            items.push({ label: type + ' document verified', ok: found.length > 0 });
        });
        requiredVerifications.forEach(function (type) {
            var row = verificationFor(app.loan_lead_id, type);
            items.push({ label: type + ' completed', ok: !!row && row.status === 'Verified' });
        });
        items.push({
            label: 'Executive assigned',
            ok: !!(app.assigned_executive_id || prospectiveExecutiveId)
        });

        return {
            items: items,
            ready: items.every(function (item) { return item.ok; })
        };
    }

    function readinessHtml(app, prospectiveExecutiveId) {
        var result = reviewReadiness(app, prospectiveExecutiveId);
        var items = result.items.map(function (item) {
            return '<li class="' + (item.ok ? 'ok' : 'missing') + '">' +
                '<i class="fa ' + (item.ok ? 'fa-check-circle' : 'fa-times-circle') + '"></i> ' +
                esc(item.label) + '</li>';
        }).join('');
        return '<ul class="readiness-list">' + items + '</ul>' +
            '<p class="admin-note" style="margin:8px 0 0;">' +
            (result.ready
                ? 'All recorded checks are complete. The database trigger still validates them again when approval is saved.'
                : 'Approval is blocked until every required item is complete. Verification records are saved below; documents are verified in the Documents module.') +
            '</p>';
    }

    function renderReviewDetails(app) {
        var box = el('reviewDetails');
        if (!box) { return; }
        var lead = leadById(app.loan_lead_id) || {};
        var office = [app.office_address, app.office_city, app.office_state, app.office_pincode].filter(Boolean).join(', ');
        var products = Array.isArray(app.products) ? app.products.join(', ') : '';
        var readiness = readinessHtml(app, el('reviewExecutive') ? el('reviewExecutive').value : null);

        var html = '';
        html += subHeading('Applicant');
        html += detailRow('Reference', esc(lead.reference_no || '—'));
        html += detailRow('Applicant name', esc(app.applicant_name || '—'));
        html += detailRow('Mobile', esc(app.mobile || '—'));
        html += detailRow('Email', esc(app.email || '—'));
        html += detailRow('City / state', esc([app.applicant_city, app.applicant_state].filter(Boolean).join(', ') || '—'));
        html += detailRow('PAN', '<span class="mono">' + esc(app.pan_number || '—') + '</span>');
        html += detailRow('Application status', badge(app.application_status));
        html += detailRow('Submitted', prettyDateTime(app.created_at));
        html += detailRow('Reviewed by', esc(adminName(app.reviewed_by)));
        html += detailRow('Reviewed on', prettyDateTime(app.reviewed_at));

        html += subHeading('Firm and office');
        html += detailRow('Firm name', esc(app.firm_name || '—'));
        html += detailRow('Partner type', esc(app.partner_type || '—'));
        html += detailRow('Office address', esc(office || '—'));
        html += detailRow('Business registration', esc(app.business_registration_type || '—'));
        html += detailRow('Registration number', '<span class="mono">' + esc(app.business_registration_number || '—') + '</span>');
        html += detailRow('GSTIN', '<span class="mono">' + esc(app.gst_number || '—') + '</span>');
        html += detailRow('Years of experience', app.years_experience === null || app.years_experience === undefined ? '—' : esc(String(app.years_experience)));
        html += detailRow('Financial services experience', esc(app.financial_services_experience || '—'));
        html += detailRow('Existing DSA associations', esc(app.existing_dsa_associations || '—'));
        html += detailRow('Bank / NBFC relationships', esc(app.bank_associations || '—'));

        html += subHeading('Referral network');
        html += detailRow('Products', esc(products || '—'));
        html += detailRow('Expected referrals / month', app.expected_leads_per_month === null || app.expected_leads_per_month === undefined ? '—' : esc(String(app.expected_leads_per_month)));
        html += detailRow('Preferred locations', esc(app.preferred_locations || '—'));
        html += detailRow('Referral source', esc(app.referral_source || '—'));
        html += detailRow('Additional notes', esc(app.additional_notes || '—'));

        html += subHeading('Declarations');
        html += detailRow('Accuracy', app.accuracy_declaration ? 'Accepted' : 'Not accepted');
        html += detailRow('Commission terms', app.commission_declaration ? 'Accepted' : 'Not accepted');
        html += detailRow('No guarantee', app.no_guarantee_declaration ? 'Accepted' : 'Not accepted');

        html += subHeading('Approval readiness');
        html += readiness;

        if (app.admin_remarks || app.status_notes || app.rejection_reason) {
            html += subHeading('Administrator record');
            if (app.admin_remarks) { html += detailRow('Remarks', esc(app.admin_remarks)); }
            if (app.status_notes) { html += detailRow('Status notes', esc(app.status_notes)); }
            if (app.rejection_reason) { html += detailRow('Rejection reason', esc(app.rejection_reason)); }
        }

        box.innerHTML = html;
    }

    function renderReviewDocuments(app) {
        var body = el('reviewDocumentsBody');
        if (!body) { return; }
        var docs = documentsForLead(app.loan_lead_id);
        var count = el('reviewDocumentsCount');
        if (count) {
            count.textContent = docs.length
                ? docs.length + ' document' + (docs.length === 1 ? '' : 's') + ' recorded for this partner application.'
                : 'No documents have been recorded yet.';
        }

        if (!docs.length) {
            body.innerHTML = emptyRow(4, 'No documents recorded. Upload and verification happen in the Documents module.', 'fa-folder-open');
            return;
        }

        body.innerHTML = docs.map(function (doc) {
            var notes = [doc.verification_date ? 'Verified ' + prettyDate(doc.verification_date) : '', doc.notes].filter(Boolean).join(' · ');
            return '<tr>' +
                '<td><strong>' + esc(doc.document_type || '—') + '</strong></td>' +
                '<td>' + esc(doc.file_name || '—') + '</td>' +
                '<td>' + badge(doc.status) + '</td>' +
                '<td>' + esc(notes || '—') + '</td>' +
                '</tr>';
        }).join('');
    }

    function renderReviewVerifications(app) {
        var body = el('reviewVerificationsBody');
        if (!body) { return; }
        var registered = app.business_registration_type && app.business_registration_type !== 'Not registered';

        body.innerHTML = VERIFICATION_TYPES.map(function (type) {
            var existing = verificationFor(app.loan_lead_id, type) || {};
            var required = type !== 'Business Registration Verification' || registered;
            var status = existing.status || 'Pending';
            var options = ['Pending', 'In Progress', 'Verified', 'Failed', 'Not Applicable'].map(function (value) {
                return '<option value="' + value + '"' + (value === status ? ' selected' : '') + '>' + value + '</option>';
            }).join('');

            return '<tr data-verification-type="' + esc(type) + '" data-verification-id="' + esc(existing.id || '') + '">' +
                '<td><strong>' + esc(type) + '</strong><div class="muted">' + (required ? 'Required' : 'Optional') + '</div></td>' +
                '<td><select class="form-control input-sm ver-status">' + options + '</select></td>' +
                '<td><input type="text" class="form-control input-sm ver-ref" maxlength="120" value="' + esc(existing.reference_no || '') + '" placeholder="Reference"></td>' +
                '<td><input type="text" class="form-control input-sm ver-findings" maxlength="500" value="' + esc(existing.findings || '') + '" placeholder="Findings"></td>' +
                '<td><input type="text" class="form-control input-sm ver-remarks" maxlength="500" value="' + esc(existing.remarks || '') + '" placeholder="Remarks"></td>' +
                '<td><button type="button" class="btn-action btn-view btn-save-verification">Save</button></td>' +
                '</tr>';
        }).join('');
    }

    function setValue(id, value) {
        var node = el(id);
        if (node) { node.value = value === null || value === undefined ? '' : value; }
    }

    function renderReviewAgreement(app) {
        var agreement = latestAgreement(app.loan_lead_id) || {};
        setValue('reviewAgreementId', agreement.id || '');
        setValue('reviewAgreementType', agreement.agreement_type || 'DSA Agreement');
        setValue('reviewAgreementStatus', agreement.agreement_status || 'Draft');
        setValue('reviewAgreementReference', agreement.agreement_reference || '');
        setValue('reviewSignedDate', agreement.signed_date || '');
        setValue('reviewEffectiveFrom', agreement.effective_from || '');
        setValue('reviewEffectiveTo', agreement.effective_to || '');
        setValue('reviewDocumentName', agreement.document_name || '');
        setValue('reviewCommissionTerms', agreement.commission_terms || '');
        setValue('reviewAgreementRemarks', agreement.admin_remarks || '');

        var history = state.agreements.filter(function (row) { return row.partner_lead_id === app.loan_lead_id; });
        var historyBox = el('reviewAgreementHistory');
        if (historyBox) {
            historyBox.innerHTML = history.length
                ? '<p class="admin-note" style="margin:0 0 8px;">' + history.length + ' agreement record' + (history.length === 1 ? '' : 's') + ' on file. The latest record is edited above.</p>' +
                  history.map(function (row) {
                      return '<div class="detail-row"><span class="detail-label">' + esc(row.agreement_type || 'Agreement') + '</span>' +
                          '<span class="detail-value">' + badge(row.agreement_status) + ' · ' + esc(row.agreement_reference || 'No reference') +
                          ' · signed ' + prettyDate(row.signed_date) + '</span></div>';
                  }).join('')
                : '<p class="admin-note" style="margin:0;">No agreement has been recorded yet.</p>';
        }

        var note = el('reviewAgreementNote');
        if (note) {
            note.textContent = agreement.agreement_status === 'Signed' || agreement.agreement_status === 'Active'
                ? 'This agreement can satisfy the provisioning check if it has a signed date and an effective-from date that is today or earlier.'
                : 'A login can be provisioned only after the agreement status is Signed or Active, with a signed date and an effective-from date that has arrived.';
        }
    }

    function renderReviewDecision(app) {
        var executive = el('reviewExecutive');
        if (executive) {
            var options = ['<option value="">Select executive</option>'];
            state.admins.filter(function (admin) { return admin.role === 'admin'; }).forEach(function (admin) {
                options.push('<option value="' + esc(admin.user_id) + '">' +
                    esc(admin.full_name || admin.user_id) + '</option>');
            });
            executive.innerHTML = options.join('');
            executive.value = app.assigned_executive_id || '';
        }

        var action = el('reviewAction');
        if (action) {
            action.value = APPLICATION_ACTIONS.indexOf(app.application_status) !== -1
                ? app.application_status : 'Under Review';
        }

        var remarks = el('reviewRemarks');
        if (remarks) {
            remarks.value = app.status_notes || app.admin_remarks || app.rejection_reason || '';
        }

        updateReviewReadiness();
    }

    function updateReviewReadiness() {
        var app = applicationByLead(state.currentReviewLeadId);
        var box = el('reviewDecisionReadiness');
        if (!app || !box) { return; }
        var executiveId = el('reviewExecutive') ? el('reviewExecutive').value : null;
        box.innerHTML = readinessHtml(app, executiveId);
    }

    function renderReviewProfile(app) {
        var box = el('reviewProfileSummary');
        var profile = profileByLead(app.loan_lead_id);
        if (box) {
            if (!profile) {
                box.innerHTML = '<p class="admin-note" style="margin:0;">No partner profile has been provisioned for this application. Create the auth user in Nhost first, then enter the user UUID below. Provisioning requires approval and a signed, effective agreement.</p>';
            } else {
                box.innerHTML =
                    detailRow('Partner code', '<span class="mono">' + esc(profile.partner_code || '—') + '</span>') +
                    detailRow('Account status', badge(profile.status)) +
                    detailRow('Auth user ID', '<span class="mono">' + esc(profile.user_id || '—') + '</span>') +
                    detailRow('Onboarding completed', profile.onboarding_completed ? 'Yes' : 'No') +
                    detailRow('Activated on', prettyDateTime(profile.activated_at)) +
                    detailRow('Suspended on', prettyDateTime(profile.suspended_at)) +
                    detailRow('Suspension reason', esc(profile.suspension_reason || '—')) +
                    detailRow('Administrator notes', esc(profile.admin_notes || '—'));
            }
        }

        var input = el('reviewProvisionUserId');
        if (input) { input.value = profile && profile.user_id ? profile.user_id : ''; }
        var button = el('reviewProvisionBtn');
        if (button) {
            button.textContent = profile ? 'Relink / re-provision login' : 'Provision partner login';
        }
    }

    async function saveReviewDecision() {
        var leadId = state.currentReviewLeadId;
        var app = applicationByLead(leadId);
        if (!app) { return; }

        var action = el('reviewAction') ? el('reviewAction').value : '';
        var executiveId = el('reviewExecutive') ? el('reviewExecutive').value || null : null;
        var remarks = el('reviewRemarks') ? el('reviewRemarks').value.trim() : '';

        if (!action) {
            showModalAlert('reviewModal', 'error', 'Select a review action.');
            return;
        }
        if (action === 'Rejected' && !remarks) {
            showModalAlert('reviewModal', 'error', 'Enter the rejection reason before rejecting this application.');
            return;
        }
        if (action === 'Approved') {
            var readiness = reviewReadiness(app, executiveId);
            if (!readiness.ready) {
                showModalAlert('reviewModal', 'error', 'Complete every required document, verification and the executive assignment before approval.');
                return;
            }
        }

        var button = el('reviewSaveDecisionBtn');
        setBusy(button, true, 'Save review decision');
        hideModalAlert('reviewModal');
        try {
            await backend().adminRpc('review_partner_application', {
                p_lead_id: leadId,
                p_action: action,
                p_assigned_executive_id: executiveId,
                p_remarks: remarks || null
            });
            await loadAll(true);
            openReview(leadId);
            showModalAlert('reviewModal', 'success', 'Partner application status updated to ' + action + '.');
        } catch (error) {
            console.error('Partner review failed:', error);
            showModalAlert('reviewModal', 'error', backend().errorMessage ? backend().errorMessage(error) : 'The review decision could not be saved.');
        } finally {
            setBusy(button, false, 'Save review decision');
        }
    }

    async function saveVerification(button) {
        var leadId = state.currentReviewLeadId;
        var row = button.closest('tr');
        if (!leadId || !row) { return; }

        var type = row.getAttribute('data-verification-type');
        var id = row.getAttribute('data-verification-id');
        var status = row.querySelector('.ver-status').value;
        var reference = textOrNull(row.querySelector('.ver-ref').value);
        var findings = textOrNull(row.querySelector('.ver-findings').value);
        var remarks = textOrNull(row.querySelector('.ver-remarks').value);
        var adminId = currentAdminId();
        var decided = status === 'Verified' || status === 'Failed';
        var verifiedAt = decided ? new Date().toISOString() : null;

        setBusy(button, true, 'Save');
        hideModalAlert('reviewModal');
        try {
            if (id) {
                await backend().adminGql(
                    'mutation UpdatePartnerVerification($id: uuid!, $status: String!, $reference: String, $findings: String, $remarks: String, $verifiedBy: uuid, $verifiedAt: timestamptz) {' +
                    '  update_partner_verifications_by_pk(pk_columns: {id: $id}, _set: {' +
                    '    status: $status, reference_no: $reference, findings: $findings, remarks: $remarks,' +
                    '    verified_by: $verifiedBy, verified_at: $verifiedAt' +
                    '  }) { id }' +
                    '}',
                    { id: id, status: status, reference: reference, findings: findings, remarks: remarks, verifiedBy: decided ? adminId : null, verifiedAt: verifiedAt }
                );
                var existing = null;
                state.verifications.forEach(function (item) { if (item.id === id) { existing = item; } });
                if (existing) {
                    existing.status = status;
                    existing.reference_no = reference;
                    existing.findings = findings;
                    existing.remarks = remarks;
                    existing.verified_by = decided ? adminId : null;
                    existing.verified_at = verifiedAt;
                }
            } else {
                var result = await backend().adminGql(
                    'mutation InsertPartnerVerification($object: partner_verifications_insert_input!) {' +
                    '  insert_partner_verifications_one(object: $object) { id }' +
                    '}',
                    {
                        object: {
                            partner_lead_id: leadId,
                            verification_type: type,
                            status: status,
                            reference_no: reference,
                            findings: findings,
                            remarks: remarks,
                            verified_by: decided ? adminId : null,
                            verified_at: verifiedAt
                        }
                    }
                );
                var inserted = result && result.insert_partner_verifications_one;
                state.verifications.push({
                    id: inserted ? inserted.id : '',
                    partner_lead_id: leadId,
                    verification_type: type,
                    status: status,
                    reference_no: reference,
                    findings: findings,
                    remarks: remarks,
                    verified_by: decided ? adminId : null,
                    verified_at: verifiedAt
                });
            }

            renderReviewVerifications(applicationByLead(leadId));
            updateReviewReadiness();
            showModalAlert('reviewModal', 'success', type + ' saved as ' + status + '.');
        } catch (error) {
            console.error('Partner verification save failed:', error);
            showModalAlert('reviewModal', 'error', backend().errorMessage ? backend().errorMessage(error) : 'The verification record could not be saved.');
        } finally {
            setBusy(button, false, 'Save');
        }
    }

    async function saveAgreement() {
        var leadId = state.currentReviewLeadId;
        if (!leadId) { return; }

        var id = el('reviewAgreementId') ? el('reviewAgreementId').value : '';
        var type = el('reviewAgreementType') ? el('reviewAgreementType').value : 'DSA Agreement';
        var status = el('reviewAgreementStatus') ? el('reviewAgreementStatus').value : 'Draft';
        var reference = textOrNull(el('reviewAgreementReference').value);
        var signedDate = el('reviewSignedDate').value || null;
        var effectiveFrom = el('reviewEffectiveFrom').value || null;
        var effectiveTo = el('reviewEffectiveTo').value || null;
        var documentName = textOrNull(el('reviewDocumentName').value);
        var commissionTerms = textOrNull(el('reviewCommissionTerms').value);
        var remarks = textOrNull(el('reviewAgreementRemarks').value);

        if ((status === 'Signed' || status === 'Active') && (!signedDate || !effectiveFrom)) {
            showModalAlert('reviewModal', 'error', 'A signed or active agreement requires the signed date and the effective-from date.');
            return;
        }
        if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) {
            showModalAlert('reviewModal', 'error', 'The effective-to date cannot be earlier than the effective-from date.');
            return;
        }

        var button = el('reviewSaveAgreementBtn');
        setBusy(button, true, 'Save agreement');
        hideModalAlert('reviewModal');
        try {
            if (id) {
                await backend().adminGql(
                    'mutation UpdatePartnerAgreement($id: uuid!, $type: String!, $status: String!, $reference: String, $signedDate: date, $effectiveFrom: date, $effectiveTo: date, $documentName: String, $commissionTerms: String, $remarks: String) {' +
                    '  update_partner_agreements_by_pk(pk_columns: {id: $id}, _set: {' +
                    '    agreement_type: $type, agreement_status: $status, agreement_reference: $reference,' +
                    '    signed_date: $signedDate, effective_from: $effectiveFrom, effective_to: $effectiveTo,' +
                    '    document_name: $documentName, commission_terms: $commissionTerms, admin_remarks: $remarks' +
                    '  }) { id }' +
                    '}',
                    {
                        id: id, type: type, status: status, reference: reference,
                        signedDate: signedDate, effectiveFrom: effectiveFrom, effectiveTo: effectiveTo,
                        documentName: documentName, commissionTerms: commissionTerms, remarks: remarks
                    }
                );
                state.agreements.forEach(function (row) {
                    if (row.id === id) {
                        row.agreement_type = type;
                        row.agreement_status = status;
                        row.agreement_reference = reference;
                        row.signed_date = signedDate;
                        row.effective_from = effectiveFrom;
                        row.effective_to = effectiveTo;
                        row.document_name = documentName;
                        row.commission_terms = commissionTerms;
                        row.admin_remarks = remarks;
                    }
                });
            } else {
                var result = await backend().adminGql(
                    'mutation InsertPartnerAgreement($object: partner_agreements_insert_input!) {' +
                    '  insert_partner_agreements_one(object: $object) { id }' +
                    '}',
                    {
                        object: {
                            partner_lead_id: leadId,
                            agreement_type: type,
                            agreement_status: status,
                            agreement_reference: reference,
                            signed_date: signedDate,
                            effective_from: effectiveFrom,
                            effective_to: effectiveTo,
                            document_name: documentName,
                            commission_terms: commissionTerms,
                            admin_remarks: remarks
                        }
                    }
                );
                var inserted = result && result.insert_partner_agreements_one;
                state.agreements.push({
                    id: inserted ? inserted.id : '',
                    partner_lead_id: leadId,
                    agreement_type: type,
                    agreement_status: status,
                    agreement_reference: reference,
                    signed_date: signedDate,
                    effective_from: effectiveFrom,
                    effective_to: effectiveTo,
                    document_name: documentName,
                    commission_terms: commissionTerms,
                    admin_remarks: remarks,
                    created_at: new Date().toISOString()
                });
            }

            renderReviewAgreement(applicationByLead(leadId));
            renderReviewProfile(applicationByLead(leadId));
            showModalAlert('reviewModal', 'success', 'Partner agreement record saved.');
        } catch (error) {
            console.error('Partner agreement save failed:', error);
            showModalAlert('reviewModal', 'error', backend().errorMessage ? backend().errorMessage(error) : 'The agreement could not be saved.');
        } finally {
            setBusy(button, false, 'Save agreement');
        }
    }

    async function provisionLogin() {
        var leadId = state.currentReviewLeadId;
        var userId = el('reviewProvisionUserId') ? el('reviewProvisionUserId').value.trim() : '';
        if (!leadId) { return; }
        if (!isUuid(userId)) {
            showModalAlert('reviewModal', 'error', 'Enter the auth user UUID created in Nhost for this partner.');
            return;
        }

        var button = el('reviewProvisionBtn');
        setBusy(button, true, 'Provision partner login');
        hideModalAlert('reviewModal');
        try {
            var result = await backend().adminRpc('provision_partner_login', {
                p_lead_id: leadId,
                p_user_id: userId
            });
            await loadAll(true);
            openReview(leadId);
            showModalAlert('reviewModal', 'success', 'Partner login provisioned' +
                (result && result.partner_code ? ' with code ' + result.partner_code : '') +
                '. The partner can now sign in if the auth account is active.');
        } catch (error) {
            console.error('Partner login provisioning failed:', error);
            showModalAlert('reviewModal', 'error', backend().errorMessage ? backend().errorMessage(error) : 'The partner login could not be provisioned.');
        } finally {
            setBusy(button, false, 'Provision partner login');
        }
    }

    /* ------------------------------------------------------------------ *
     * Partner profile modal
     * ------------------------------------------------------------------ */

    function openPartner(profileId) {
        var profile = profileById(profileId);
        if (!profile) { return; }
        state.currentPartnerId = profileId;
        hideModalAlert('partnerModal');

        var assignments = state.assignments.filter(function (row) { return row.partner_profile_id === profileId; });
        var commissions = state.commissions.filter(function (row) { return row.partner_profile_id === profileId; });
        var paid = commissions.filter(function (row) { return row.status === 'Paid'; }).reduce(function (total, row) {
            var net = row.net_payable !== null && row.net_payable !== undefined
                ? Number(row.net_payable) : (Number(row.commission_amount) || 0) - (Number(row.tds_amount) || 0);
            return total + (isNaN(net) ? 0 : net);
        }, 0);

        var details = el('partnerDetails');
        if (details) {
            details.innerHTML =
                detailRow('Partner code', '<span class="mono">' + esc(profile.partner_code || '—') + '</span>') +
                detailRow('Display name', esc(profile.display_name || '—')) +
                detailRow('Firm name', esc(profile.firm_name || '—')) +
                detailRow('Partner type', esc(profile.partner_type || '—')) +
                detailRow('Auth user ID', '<span class="mono">' + esc(profile.user_id || '—') + '</span>') +
                detailRow('Onboarding completed', profile.onboarding_completed ? 'Yes' : 'No') +
                detailRow('Activated on', prettyDateTime(profile.activated_at)) +
                detailRow('Suspended on', prettyDateTime(profile.suspended_at)) +
                detailRow('Suspension reason', esc(profile.suspension_reason || '—')) +
                detailRow('Administrator notes', esc(profile.admin_notes || '—')) +
                detailRow('Leads assigned', String(assignments.length)) +
                detailRow('Sanctioned', String(assignments.filter(function (row) { return row.status === 'Sanctioned'; }).length)) +
                detailRow('Disbursed', String(assignments.filter(function (row) { return row.status === 'Disbursed'; }).length)) +
                detailRow('Commission paid (net)', money(paid));
        }

        setValue('partnerStatus', profile.status || 'Pending Agreement');
        setValue('partnerSuspensionReason', profile.suspension_reason || '');
        setValue('partnerAdminNotes', profile.admin_notes || '');
        if (window.jQuery) { window.jQuery('#partnerModal').modal('show'); }
    }

    async function savePartnerStatus() {
        var profile = profileById(state.currentPartnerId);
        if (!profile) { return; }

        var status = el('partnerStatus') ? el('partnerStatus').value : '';
        var reason = textOrNull(el('partnerSuspensionReason').value);
        var notes = textOrNull(el('partnerAdminNotes').value);
        if (status === 'Suspended' && !reason) {
            showModalAlert('partnerModal', 'error', 'Enter the suspension reason before suspending this partner.');
            return;
        }
        if (status === 'Active') {
            var agreement = latestAgreement(profile.loan_lead_id);
            var agreementValid = agreement &&
                (agreement.agreement_status === 'Signed' || agreement.agreement_status === 'Active') &&
                !!agreement.signed_date &&
                !!agreement.effective_from &&
                agreement.effective_from <= localTodayIso();
            if (!agreementValid) {
                showModalAlert('partnerModal', 'error', 'An active partner requires a signed agreement with an effective-from date that has arrived. Record the agreement in the application review first.');
                return;
            }
        }

        var now = new Date().toISOString();
        var changes = {
            status: status,
            suspension_reason: reason,
            admin_notes: notes
        };
        if (status === 'Active') {
            changes.activated_at = profile.activated_at || now;
            changes.suspended_at = null;
            changes.suspension_reason = null;
        }
        if (status === 'Suspended') {
            changes.suspended_at = now;
        }

        var button = el('partnerSaveBtn');
        setBusy(button, true, 'Save partner status');
        hideModalAlert('partnerModal');
        try {
            await backend().adminGql(
                'mutation UpdatePartnerProfile($id: uuid!, $changes: partner_profiles_set_input!) {' +
                '  update_partner_profiles_by_pk(pk_columns: {id: $id}, _set: $changes) { id }' +
                '}',
                { id: profile.id, changes: changes }
            );
            Object.keys(changes).forEach(function (key) { profile[key] = changes[key]; });
            renderPartners();
            openPartner(profile.id);
            showModalAlert('partnerModal', 'success', 'Partner profile status updated to ' + status + '.');
        } catch (error) {
            console.error('Partner profile update failed:', error);
            showModalAlert('partnerModal', 'error', backend().errorMessage ? backend().errorMessage(error) : 'The partner profile could not be updated.');
        } finally {
            setBusy(button, false, 'Save partner status');
        }
    }

    /* ------------------------------------------------------------------ *
     * Lead assignment modal
     * ------------------------------------------------------------------ */

    function populatePartnerSelect(selectId, selectedId) {
        var select = el(selectId);
        if (!select) { return; }
        select.innerHTML = ['<option value="">Select partner</option>'].concat(state.profiles.map(function (profile) {
            return '<option value="' + esc(profile.id) + '">' + esc(partnerLabel(profile)) + '</option>';
        })).join('');
        select.value = selectedId || '';
    }

    function populateAssignmentSelect(selectId, partnerId, selectedId) {
        var select = el(selectId);
        if (!select) { return; }
        var rows = state.assignments.filter(function (row) {
            return !partnerId || row.partner_profile_id === partnerId;
        });
        select.innerHTML = ['<option value="">Not linked to an assignment</option>'].concat(rows.map(function (row) {
            return '<option value="' + esc(row.id) + '">' + esc(row.assignment_reference || 'Lead') + ' · ' + esc(row.customer_name || '') + '</option>';
        })).join('');
        select.value = selectedId || '';
    }

    function openLeadModal(assignmentId) {
        var row = assignmentId ? assignmentById(assignmentId) : null;
        state.currentLeadId = assignmentId || null;
        hideModalAlert('leadModal');

        setValue('leadId', row ? row.id : '');
        setValue('leadReferenceDisplay', row ? row.assignment_reference : 'Generated automatically');
        populatePartnerSelect('leadPartner', row ? row.partner_profile_id : '');
        setValue('leadCustomerName', row ? row.customer_name : '');
        setValue('leadCustomerMobile', row ? row.customer_mobile : '');
        setValue('leadCustomerEmail', row ? row.customer_email : '');
        setValue('leadProduct', row ? row.product_type : '');
        setValue('leadAmount', row && row.requested_amount !== null && row.requested_amount !== undefined ? row.requested_amount : '');
        setValue('leadCity', row ? row.customer_city : '');
        setValue('leadState', row ? row.customer_state : '');
        setValue('leadLenderName', row ? row.lender_name : '');
        setValue('leadLenderReference', row ? row.lender_reference : '');
        setValue('leadStatus', row ? row.status : 'Assigned');
        setValue('leadSanctionedAmount', row && row.sanctioned_amount !== null && row.sanctioned_amount !== undefined ? row.sanctioned_amount : '');
        setValue('leadDisbursedAmount', row && row.disbursed_amount !== null && row.disbursed_amount !== undefined ? row.disbursed_amount : '');
        setValue('leadDisbursedDate', row ? row.disbursed_date : '');
        setValue('leadStatusNotes', row ? row.status_notes : '');
        setValue('leadAdminRemarks', row ? row.admin_remarks : '');

        var title = el('leadModalTitle');
        if (title) { title.textContent = row ? 'Update assigned lead' : 'Assign a lead to a partner'; }
        if (window.jQuery) { window.jQuery('#leadModal').modal('show'); }
    }

    async function saveLead() {
        var id = el('leadId') ? el('leadId').value : '';
        var partnerId = el('leadPartner') ? el('leadPartner').value : '';
        var customerName = textOrNull(el('leadCustomerName').value);
        var customerMobile = String(el('leadCustomerMobile').value || '').replace(/[^0-9]/g, '');
        var customerEmail = textOrNull(el('leadCustomerEmail').value);
        var product = textOrNull(el('leadProduct').value);
        var amount = numOrNull(el('leadAmount').value);
        var city = textOrNull(el('leadCity').value);
        var stateName = textOrNull(el('leadState').value);
        var lender = textOrNull(el('leadLenderName').value);
        var lenderRef = textOrNull(el('leadLenderReference').value);
        var status = el('leadStatus') ? el('leadStatus').value : 'Assigned';
        var sanctioned = numOrNull(el('leadSanctionedAmount').value);
        var disbursed = numOrNull(el('leadDisbursedAmount').value);
        var disbursedDate = el('leadDisbursedDate').value || null;
        var notes = textOrNull(el('leadStatusNotes').value);
        var remarks = textOrNull(el('leadAdminRemarks').value);

        if (!partnerId) {
            showModalAlert('leadModal', 'error', 'Select the partner who will receive this lead.');
            return;
        }
        if (!customerName) {
            showModalAlert('leadModal', 'error', 'Enter the customer name.');
            return;
        }
        if (!/^[6-9][0-9]{9}$/.test(customerMobile)) {
            showModalAlert('leadModal', 'error', 'Enter a valid 10-digit Indian customer mobile number.');
            return;
        }
        if (!product) {
            showModalAlert('leadModal', 'error', 'Enter the product or service for this lead.');
            return;
        }
        if (status === 'Sanctioned' && (sanctioned === null || sanctioned < 0)) {
            showModalAlert('leadModal', 'error', 'Enter the sanctioned amount before marking the lead Sanctioned.');
            return;
        }
        if (status === 'Disbursed' && (disbursed === null || disbursed < 0 || !disbursedDate)) {
            showModalAlert('leadModal', 'error', 'Enter the disbursed amount and disbursement date before marking the lead Disbursed.');
            return;
        }

        var object = {
            partner_profile_id: partnerId,
            customer_name: customerName,
            customer_mobile: customerMobile,
            customer_email: customerEmail,
            product_type: product,
            requested_amount: amount,
            customer_city: city,
            customer_state: stateName,
            lender_name: lender,
            lender_reference: lenderRef,
            status: status,
            status_notes: notes,
            sanctioned_amount: sanctioned,
            disbursed_amount: disbursed,
            disbursed_date: disbursedDate,
            admin_remarks: remarks
        };

        var button = el('leadSaveBtn');
        setBusy(button, true, 'Save lead');
        hideModalAlert('leadModal');
        try {
            if (id) {
                await backend().adminGql(
                    'mutation UpdatePartnerLead($id: uuid!, $changes: partner_lead_assignments_set_input!) {' +
                    '  update_partner_lead_assignments_by_pk(pk_columns: {id: $id}, _set: $changes) { id }' +
                    '}',
                    { id: id, changes: object }
                );
            } else {
                await backend().adminGql(
                    'mutation InsertPartnerLead($object: partner_lead_assignments_insert_input!) {' +
                    '  insert_partner_lead_assignments_one(object: $object) { id }' +
                    '}',
                    { object: object }
                );
            }
            if (window.jQuery) { window.jQuery('#leadModal').modal('hide'); }
            await loadAll(true);
            switchTab('leads');
            showPageAlert('success', id ? 'Assigned lead updated.' : 'Lead assigned to the partner.');
        } catch (error) {
            console.error('Partner lead save failed:', error);
            showModalAlert('leadModal', 'error', backend().errorMessage ? backend().errorMessage(error) : 'The lead could not be saved.');
        } finally {
            setBusy(button, false, 'Save lead');
        }
    }

    /* ------------------------------------------------------------------ *
     * Commission modal
     * ------------------------------------------------------------------ */

    function updateCommissionNet() {
        var amount = numOrNull(el('commissionAmount') ? el('commissionAmount').value : '') || 0;
        var tds = numOrNull(el('commissionTds') ? el('commissionTds').value : '') || 0;
        var net = Math.max(0, amount - tds);
        setValue('commissionNet', net.toFixed(2));
    }

    function openCommissionModal(commissionId) {
        var row = commissionId ? state.commissions.filter(function (item) { return item.id === commissionId; })[0] : null;
        state.currentCommissionId = commissionId || null;
        hideModalAlert('commissionModal');

        setValue('commissionId', row ? row.id : '');
        populatePartnerSelect('commissionPartner', row ? row.partner_profile_id : '');
        populateAssignmentSelect('commissionAssignment', row ? row.partner_profile_id : '', row ? row.lead_assignment_id : '');
        setValue('commissionType', row ? row.commission_type : 'DSA Commission');
        setValue('commissionBasis', row && row.basis_amount !== null && row.basis_amount !== undefined ? row.basis_amount : '');
        setValue('commissionRate', row && row.rate_percent !== null && row.rate_percent !== undefined ? row.rate_percent : '');
        setValue('commissionAmount', row && row.commission_amount !== null && row.commission_amount !== undefined ? row.commission_amount : '');
        setValue('commissionTds', row && row.tds_amount !== null && row.tds_amount !== undefined ? row.tds_amount : 0);
        setValue('commissionStatus', row ? row.status : 'Pending');
        setValue('commissionInvoiceNo', row ? row.invoice_no : '');
        setValue('commissionInvoiceDate', row ? row.invoice_date : '');
        setValue('commissionPaymentReference', row ? row.payment_reference : '');
        setValue('commissionRemarks', row ? row.remarks : '');
        updateCommissionNet();

        var title = el('commissionModalTitle');
        if (title) { title.textContent = row ? 'Edit commission record' : 'Add commission record'; }
        if (window.jQuery) { window.jQuery('#commissionModal').modal('show'); }
    }

    async function saveCommission() {
        var id = el('commissionId') ? el('commissionId').value : '';
        var partnerId = el('commissionPartner') ? el('commissionPartner').value : '';
        var assignmentId = el('commissionAssignment') ? el('commissionAssignment').value : '';
        var type = el('commissionType') ? el('commissionType').value : 'DSA Commission';
        var basis = numOrNull(el('commissionBasis').value);
        var rate = numOrNull(el('commissionRate').value);
        var amount = numOrNull(el('commissionAmount').value);
        var tds = numOrNull(el('commissionTds').value) || 0;
        var status = el('commissionStatus') ? el('commissionStatus').value : 'Pending';
        var invoiceNo = textOrNull(el('commissionInvoiceNo').value);
        var invoiceDate = el('commissionInvoiceDate').value || null;
        var paymentReference = textOrNull(el('commissionPaymentReference').value);
        var remarks = textOrNull(el('commissionRemarks').value);

        if (!partnerId) {
            showModalAlert('commissionModal', 'error', 'Select the partner for this commission.');
            return;
        }
        if (amount === null || amount < 0) {
            showModalAlert('commissionModal', 'error', 'Enter a valid commission amount.');
            return;
        }
        if (tds < 0 || tds > amount) {
            showModalAlert('commissionModal', 'error', 'TDS cannot be negative or greater than the commission amount.');
            return;
        }
        if (status === 'Paid' && !paymentReference) {
            showModalAlert('commissionModal', 'error', 'Enter the payment reference before marking a commission Paid.');
            return;
        }

        var assignment = assignmentById(assignmentId);
        var existing = id ? state.commissions.filter(function (item) { return item.id === id; })[0] : null;
        var now = new Date().toISOString();
        var approved = ['Approved', 'Invoiced', 'Paid'].indexOf(status) !== -1;
        var object = {
            partner_profile_id: partnerId,
            lead_assignment_id: assignmentId || null,
            loan_lead_id: assignment ? assignment.loan_lead_id : null,
            commission_type: type,
            basis_amount: basis,
            rate_percent: rate,
            commission_amount: amount,
            tds_amount: tds,
            net_payable: Math.max(0, amount - tds),
            status: status,
            invoice_no: invoiceNo,
            invoice_date: invoiceDate,
            payment_reference: paymentReference,
            remarks: remarks,
            approved_by: approved ? ((existing && existing.approved_by) || currentAdminId()) : (existing ? existing.approved_by : null),
            approved_at: approved ? ((existing && existing.approved_at) || now) : (existing ? existing.approved_at : null),
            paid_at: status === 'Paid' ? ((existing && existing.paid_at) || now) : (existing ? existing.paid_at : null)
        };

        var button = el('commissionSaveBtn');
        setBusy(button, true, 'Save commission');
        hideModalAlert('commissionModal');
        try {
            if (id) {
                await backend().adminGql(
                    'mutation UpdatePartnerCommission($id: uuid!, $changes: partner_commissions_set_input!) {' +
                    '  update_partner_commissions_by_pk(pk_columns: {id: $id}, _set: $changes) { id }' +
                    '}',
                    { id: id, changes: object }
                );
            } else {
                await backend().adminGql(
                    'mutation InsertPartnerCommission($object: partner_commissions_insert_input!) {' +
                    '  insert_partner_commissions_one(object: $object) { id }' +
                    '}',
                    { object: object }
                );
            }
            if (window.jQuery) { window.jQuery('#commissionModal').modal('hide'); }
            await loadAll(true);
            switchTab('commissions');
            showPageAlert('success', id ? 'Commission record updated.' : 'Commission record added.');
        } catch (error) {
            console.error('Partner commission save failed:', error);
            showModalAlert('commissionModal', 'error', backend().errorMessage ? backend().errorMessage(error) : 'The commission record could not be saved.');
        } finally {
            setBusy(button, false, 'Save commission');
        }
    }

    /* ------------------------------------------------------------------ *
     * Follow-up modal
     * ------------------------------------------------------------------ */

    function toLocalDateTimeInput(value) {
        if (!value) { return ''; }
        var date = new Date(value);
        if (isNaN(date.getTime())) { return ''; }
        return date.getFullYear() + '-' +
            String(date.getMonth() + 1).padStart(2, '0') + '-' +
            String(date.getDate()).padStart(2, '0') + 'T' +
            String(date.getHours()).padStart(2, '0') + ':' +
            String(date.getMinutes()).padStart(2, '0');
    }

    function openFollowupModal(followupId) {
        var row = followupId ? state.followups.filter(function (item) { return item.id === followupId; })[0] : null;
        state.currentFollowupId = followupId || null;
        hideModalAlert('followupModal');

        setValue('followupId', row ? row.id : '');
        populatePartnerSelect('followupPartner', row ? row.partner_profile_id : '');
        populateAssignmentSelect('followupAssignment', row ? row.partner_profile_id : '', row ? row.lead_assignment_id : '');
        setValue('followupScheduled', row ? toLocalDateTimeInput(row.scheduled_at) : '');
        setValue('followupType', row ? row.interaction_type : 'Phone call');
        setValue('followupStatus', row ? row.status : 'Pending');
        setValue('followupNotes', row ? row.notes : '');

        var title = el('followupModalTitle');
        if (title) { title.textContent = row ? 'Edit partner follow-up' : 'Schedule partner follow-up'; }
        if (window.jQuery) { window.jQuery('#followupModal').modal('show'); }
    }

    async function saveFollowup() {
        var id = el('followupId') ? el('followupId').value : '';
        var partnerId = el('followupPartner') ? el('followupPartner').value : '';
        var assignmentId = el('followupAssignment') ? el('followupAssignment').value : '';
        var scheduled = el('followupScheduled') ? el('followupScheduled').value : '';
        var type = el('followupType') ? el('followupType').value : 'Phone call';
        var status = el('followupStatus') ? el('followupStatus').value : 'Pending';
        var notes = textOrNull(el('followupNotes').value);

        if (!partnerId) {
            showModalAlert('followupModal', 'error', 'Select the partner for this follow-up.');
            return;
        }
        if (!scheduled) {
            showModalAlert('followupModal', 'error', 'Select the follow-up date and time.');
            return;
        }

        var scheduledIso;
        try {
            scheduledIso = new Date(scheduled).toISOString();
        } catch (error) {
            showModalAlert('followupModal', 'error', 'Enter a valid follow-up date and time.');
            return;
        }

        var existing = id ? state.followups.filter(function (item) { return item.id === id; })[0] : null;
        var object = {
            partner_profile_id: partnerId,
            lead_assignment_id: assignmentId || null,
            scheduled_at: scheduledIso,
            interaction_type: type,
            status: status,
            notes: notes,
            completed_at: status === 'Completed'
                ? ((existing && existing.completed_at) || new Date().toISOString())
                : null
        };

        var button = el('followupSaveBtn');
        setBusy(button, true, 'Save follow-up');
        hideModalAlert('followupModal');
        try {
            if (id) {
                await backend().adminGql(
                    'mutation UpdatePartnerFollowup($id: uuid!, $changes: partner_followups_set_input!) {' +
                    '  update_partner_followups_by_pk(pk_columns: {id: $id}, _set: $changes) { id }' +
                    '}',
                    { id: id, changes: object }
                );
            } else {
                object.created_by = currentAdminId();
                await backend().adminGql(
                    'mutation InsertPartnerFollowup($object: partner_followups_insert_input!) {' +
                    '  insert_partner_followups_one(object: $object) { id }' +
                    '}',
                    { object: object }
                );
            }
            if (window.jQuery) { window.jQuery('#followupModal').modal('hide'); }
            await loadAll(true);
            switchTab('followups');
            showPageAlert('success', id ? 'Partner follow-up updated.' : 'Partner follow-up scheduled.');
        } catch (error) {
            console.error('Partner follow-up save failed:', error);
            showModalAlert('followupModal', 'error', backend().errorMessage ? backend().errorMessage(error) : 'The follow-up could not be saved.');
        } finally {
            setBusy(button, false, 'Save follow-up');
        }
    }

    async function setFollowupStatus(id, status) {
        var row = state.followups.filter(function (item) { return item.id === id; })[0];
        if (!row) { return; }
        try {
            await backend().adminGql(
                'mutation CompletePartnerFollowup($id: uuid!, $status: String!, $completedAt: timestamptz) {' +
                '  update_partner_followups_by_pk(pk_columns: {id: $id}, _set: {status: $status, completed_at: $completedAt}) { id }' +
                '}',
                { id: id, status: status, completedAt: status === 'Completed' ? new Date().toISOString() : null }
            );
            await loadAll(true);
            switchTab('followups');
            showPageAlert('success', 'Partner follow-up marked ' + status + '.');
        } catch (error) {
            console.error('Partner follow-up status update failed:', error);
            showPageAlert('error', backend().errorMessage ? backend().errorMessage(error) : 'The follow-up status could not be updated.');
        }
    }

    /* ------------------------------------------------------------------ *
     * Event bindings
     * ------------------------------------------------------------------ */

    function bindReviewModal() {
        if (el('reviewSaveDecisionBtn')) {
            el('reviewSaveDecisionBtn').addEventListener('click', saveReviewDecision);
        }
        if (el('reviewSaveAgreementBtn')) {
            el('reviewSaveAgreementBtn').addEventListener('click', saveAgreement);
        }
        if (el('reviewProvisionBtn')) {
            el('reviewProvisionBtn').addEventListener('click', provisionLogin);
        }
        if (el('reviewVerificationsBody')) {
            el('reviewVerificationsBody').addEventListener('click', function (event) {
                var button = event.target.closest('button.btn-save-verification');
                if (button) { saveVerification(button); }
            });
        }
        if (el('reviewExecutive')) {
            el('reviewExecutive').addEventListener('change', updateReviewReadiness);
        }
        if (el('reviewAction')) {
            el('reviewAction').addEventListener('change', function () {
                var remarks = el('reviewRemarks');
                if (!remarks) { return; }
                var rejected = el('reviewAction').value === 'Rejected';
                remarks.placeholder = rejected
                    ? 'Rejection reason (required)'
                    : 'Review notes, document follow-up, approval conditions, etc.';
            });
        }
    }

    function bindPartnerModal() {
        if (el('partnerSaveBtn')) {
            el('partnerSaveBtn').addEventListener('click', savePartnerStatus);
        }
    }

    function bindLeadModal() {
        if (el('leadSaveBtn')) {
            el('leadSaveBtn').addEventListener('click', saveLead);
        }
        if (el('leadsBody')) {
            el('leadsBody').addEventListener('click', function (event) {
                var button = event.target.closest('button[data-lead]');
                if (button) { openLeadModal(button.getAttribute('data-lead')); }
            });
        }
    }

    function bindCommissionModal() {
        if (el('commissionSaveBtn')) {
            el('commissionSaveBtn').addEventListener('click', saveCommission);
        }
        if (el('commissionPartner')) {
            el('commissionPartner').addEventListener('change', function () {
                populateAssignmentSelect('commissionAssignment', el('commissionPartner').value, '');
            });
        }
        ['commissionAmount', 'commissionTds'].forEach(function (id) {
            if (el(id)) { el(id).addEventListener('input', updateCommissionNet); }
        });
        if (el('commissionsBody')) {
            el('commissionsBody').addEventListener('click', function (event) {
                var button = event.target.closest('button[data-commission]');
                if (button) { openCommissionModal(button.getAttribute('data-commission')); }
            });
        }
    }

    function bindFollowupModal() {
        if (el('followupSaveBtn')) {
            el('followupSaveBtn').addEventListener('click', saveFollowup);
        }
        if (el('followupPartner')) {
            el('followupPartner').addEventListener('change', function () {
                populateAssignmentSelect('followupAssignment', el('followupPartner').value, '');
            });
        }
        if (el('followupsBody')) {
            el('followupsBody').addEventListener('click', function (event) {
                var edit = event.target.closest('button[data-followup]');
                if (edit) { openFollowupModal(edit.getAttribute('data-followup')); return; }
                var complete = event.target.closest('button[data-followup-complete]');
                if (complete) { setFollowupStatus(complete.getAttribute('data-followup-complete'), 'Completed'); return; }
                var cancel = event.target.closest('button[data-followup-cancel]');
                if (cancel) { setFollowupStatus(cancel.getAttribute('data-followup-cancel'), 'Cancelled'); }
            });
        }
    }


    /* ------------------------------------------------------------------ *
     * Boot
     * ------------------------------------------------------------------ */

    window.DhanviAdminReady.then(function () {
        loadAll(false);

        Array.prototype.forEach.call(document.querySelectorAll('.admin-tab'), function (button) {
            button.addEventListener('click', function () { switchTab(button.getAttribute('data-tab')); });
        });

        ['applicationSearch', 'applicationStatusFilter'].forEach(function (id) {
            if (el(id)) { el(id).addEventListener('input', renderApplications); }
            if (el(id)) { el(id).addEventListener('change', renderApplications); }
        });
        ['partnerSearch', 'partnerStatusFilter'].forEach(function (id) {
            if (el(id)) { el(id).addEventListener('input', renderPartners); }
            if (el(id)) { el(id).addEventListener('change', renderPartners); }
        });
        ['leadSearch', 'leadStatusFilter', 'leadPartnerFilter'].forEach(function (id) {
            if (el(id)) { el(id).addEventListener('input', renderLeads); }
            if (el(id)) { el(id).addEventListener('change', renderLeads); }
        });
        ['commissionStatusFilter', 'commissionPartnerFilter'].forEach(function (id) {
            if (el(id)) { el(id).addEventListener('change', renderCommissions); }
        });
        ['followupStatusFilter', 'followupSearch'].forEach(function (id) {
            if (el(id)) { el(id).addEventListener('input', renderFollowups); }
            if (el(id)) { el(id).addEventListener('change', renderFollowups); }
        });

        if (el('applicationsBody')) {
            el('applicationsBody').addEventListener('click', function (event) {
                var button = event.target.closest('button[data-review]');
                if (button) { openReview(button.getAttribute('data-review')); }
            });
        }
        if (el('partnersBody')) {
            el('partnersBody').addEventListener('click', function (event) {
                var button = event.target.closest('button[data-partner]');
                if (button) { openPartner(button.getAttribute('data-partner')); }
            });
        }

        bindReviewModal();
        bindPartnerModal();
        bindLeadModal();
        bindCommissionModal();
        bindFollowupModal();

        if (el('refreshPartnersBtn')) {
            el('refreshPartnersBtn').addEventListener('click', function () { loadAll(false); });
        }
        if (el('addLeadBtn')) {
            el('addLeadBtn').addEventListener('click', function () { openLeadModal(null); });
        }
        if (el('addCommissionBtn')) {
            el('addCommissionBtn').addEventListener('click', function () { openCommissionModal(null); });
        }
        if (el('addFollowupBtn')) {
            el('addFollowupBtn').addEventListener('click', function () { openFollowupModal(null); });
        }
        if (el('sidebarToggle')) {
            el('sidebarToggle').addEventListener('click', function () {
                el('adminSidebar').classList.toggle('open');
                el('sidebarOverlay').classList.toggle('show');
            });
        }
        if (el('sidebarOverlay')) {
            el('sidebarOverlay').addEventListener('click', function () {
                el('adminSidebar').classList.remove('open');
                el('sidebarOverlay').classList.remove('show');
            });
        }
    });
})(window, document);

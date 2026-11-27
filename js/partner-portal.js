/**
 * Dhanvi Finserv - Partner Portal
 *
 * Depends on: js/nhost-client.js, js/public-api.js
 *
 * Access
 *   The portal is available only to an authenticated user who holds the
 *   "partner" role and whose public.partner_profiles row is Active. Every
 *   query uses the partner role; Hasura row filters and Postgres RLS limit
 *   the result to the signed-in partner's own profile and records.
 *
 * Writes
 *   The only write is update_partner_lead_status(), which lets a partner move
 *   an open assigned lead to Contacted, Documents Pending or Submitted to
 *   Lender. Sanction, disbursal, rejection, closure, commissions, agreements
 *   and documents remain administrator-controlled.
 *
 * No fake data
 *   Every value rendered here comes from Hasura. Empty states and errors are
 *   shown explicitly instead of placeholder records.
 */
(function (window, document) {
    'use strict';

    var D = window.Dhanvi;
    var B = window.DhanviBackend;

    var ALLOWED_LEAD_STATUSES = ['Contacted', 'Documents Pending', 'Submitted to Lender'];
    var OPEN_LEAD_STATUSES = ['Assigned', 'Contacted', 'Documents Pending', 'Submitted to Lender'];

    var SECTION_TITLES = {
        dashboard: 'Dashboard',
        profile: 'My Profile',
        documents: 'Documents',
        agreement: 'Agreement',
        leads: 'Assigned Leads',
        commissions: 'Commissions',
        followups: 'Follow-ups'
    };

    var PROFILE_QUERY =
        'query PartnerProfile($userId: uuid!) {' +
        '  partner_profiles(where: {user_id: {_eq: $userId}}, limit: 1) {' +
        '    id loan_lead_id user_id partner_code display_name firm_name partner_type' +
        '    status onboarding_completed activated_at suspended_at suspension_reason created_at' +
        '  }' +
        '}';

    var APPLICATION_QUERY =
        'query PartnerApplication($leadId: uuid!) {' +
        '  partner_application_details(where: {loan_lead_id: {_eq: $leadId}}, limit: 1) {' +
        '    applicant_name mobile email applicant_city applicant_state pan_number' +
        '    firm_name partner_type office_address office_city office_state office_pincode' +
        '    business_registration_type business_registration_number gst_number' +
        '    years_experience financial_services_experience existing_dsa_associations' +
        '    bank_associations products expected_leads_per_month preferred_locations' +
        '    referral_source additional_notes application_status admin_remarks' +
        '    rejection_reason status_notes reviewed_at created_at updated_at' +
        '  }' +
        '}';

    var DOCUMENTS_QUERY =
        'query PartnerDocuments($leadId: uuid!) {' +
        '  partner_documents(where: {partner_lead_id: {_eq: $leadId}}, order_by: {created_at: desc}) {' +
        '    id document_type file_name file_size mime_type status verification_date' +
        '    notes uploaded_by created_at' +
        '  }' +
        '}';

    var AGREEMENTS_QUERY =
        'query PartnerAgreements($leadId: uuid!) {' +
        '  partner_agreements(where: {partner_lead_id: {_eq: $leadId}}, order_by: {created_at: desc}) {' +
        '    id agreement_type agreement_status agreement_reference effective_from effective_to' +
        '    signed_date document_name commission_terms admin_remarks created_at' +
        '  }' +
        '}';

    var VERIFICATIONS_QUERY =
        'query PartnerVerifications($leadId: uuid!) {' +
        '  partner_verifications(where: {partner_lead_id: {_eq: $leadId}}, order_by: {verification_type: asc}) {' +
        '    id verification_type status reference_no findings remarks verified_at updated_at' +
        '  }' +
        '}';

    var ASSIGNMENTS_QUERY =
        'query PartnerAssignments($profileId: uuid!) {' +
        '  partner_lead_assignments(where: {partner_profile_id: {_eq: $profileId}}, order_by: {assigned_at: desc}) {' +
        '    id assignment_reference customer_name customer_mobile customer_email' +
        '    product_type requested_amount customer_city customer_state' +
        '    lender_name lender_reference status status_notes assigned_at' +
        '    last_contacted_at submitted_at sanctioned_amount disbursed_amount' +
        '    disbursed_date admin_remarks updated_at' +
        '  }' +
        '}';

    var COMMISSIONS_QUERY =
        'query PartnerCommissions($profileId: uuid!) {' +
        '  partner_commissions(where: {partner_profile_id: {_eq: $profileId}}, order_by: {created_at: desc}) {' +
        '    id lead_assignment_id commission_type basis_amount rate_percent' +
        '    commission_amount tds_amount net_payable status invoice_no invoice_date' +
        '    approved_at paid_at payment_reference remarks created_at' +
        '  }' +
        '}';

    var FOLLOWUPS_QUERY =
        'query PartnerFollowups($profileId: uuid!, $leadId: uuid!) {' +
        '  partner_followups(' +
        '    where: {_or: [{partner_profile_id: {_eq: $profileId}}, {partner_lead_id: {_eq: $leadId}}]},' +
        '    order_by: {scheduled_at: asc}' +
        '  ) {' +
        '    id scheduled_at interaction_type status notes completed_at' +
        '    lead_assignment_id partner_lead_id created_at' +
        '  }' +
        '}';

    var state = {
        user: null,
        profile: null,
        dashboardLoading: false,
        application: { loaded: false, loading: false, data: null, error: null },
        documents: { loaded: false, loading: false, data: [], error: null },
        agreements: { loaded: false, loading: false, data: [], error: null },
        verifications: { loaded: false, loading: false, data: [], error: null },
        assignments: { loaded: false, loading: false, data: [], error: null },
        commissions: { loaded: false, loading: false, data: [], error: null },
        followups: { loaded: false, loading: false, data: [], error: null }
    };

    var leadModalBusy = false;

    /* ------------------------------------------------------------------ *
     * Small helpers
     * ------------------------------------------------------------------ */

    function el(id) { return document.getElementById(id); }

    function escape(value) {
        if (D && typeof D.escapeHtml === 'function') { return D.escapeHtml(value); }
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function text(value) {
        return value === null || value === undefined || value === '' ? '\u2014' : escape(value);
    }

    function formatDate(value) {
        if (!value) { return '\u2014'; }
        var date = new Date(value);
        if (isNaN(date.getTime())) { return escape(value); }
        return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    }

    function formatDateTime(value) {
        if (!value) { return '\u2014'; }
        var date = new Date(value);
        if (isNaN(date.getTime())) { return escape(value); }
        return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) +
            ', ' + date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
    }

    function formatMoney(value) {
        if (value === null || value === undefined || value === '') { return '\u2014'; }
        var number = Number(value);
        if (isNaN(number)) { return '\u2014'; }
        return '\u20B9' + number.toLocaleString('en-IN', { maximumFractionDigits: 2 });
    }

    function formatFileSize(bytes) {
        var size = Number(bytes);
        if (!size || isNaN(size) || size <= 0) { return ''; }
        if (size < 1024) { return size + ' B'; }
        if (size < 1048576) { return (size / 1024).toFixed(0) + ' KB'; }
        return (size / 1048576).toFixed(1) + ' MB';
    }

    function maskNumber(value) {
        var raw = String(value || '').toUpperCase();
        if (!raw) { return '\u2014'; }
        if (raw.length <= 4) { return '****'; }
        return raw.slice(0, 2) + '******' + raw.slice(-2);
    }

    function netCommission(row) {
        if (row.net_payable !== null && row.net_payable !== undefined) { return Number(row.net_payable) || 0; }
        return (Number(row.commission_amount) || 0) - (Number(row.tds_amount) || 0);
    }

    function sumCommission(rows, statuses) {
        return (rows || []).reduce(function (total, row) {
            if (statuses.indexOf(row.status) === -1) { return total; }
            return total + netCommission(row);
        }, 0);
    }

    var BADGE_CLASSES = {
        'Assigned': 'blue',
        'Contacted': 'blue',
        'Documents Pending': 'orange',
        'Submitted to Lender': 'purple',
        'Sanctioned': 'teal',
        'Disbursed': 'green',
        'Rejected': 'red',
        'Closed': 'gray',
        'Application Received': 'blue',
        'Under Review': 'purple',
        'Verification In Progress': 'teal',
        'Approved': 'green',
        'On Hold': 'orange',
        'Withdrawn': 'gray',
        'Pending': 'orange',
        'Verified': 'green',
        'Failed': 'red',
        'In Progress': 'blue',
        'Not Applicable': 'gray',
        'Not Started': 'gray',
        'Draft': 'gray',
        'Sent for Signature': 'blue',
        'Signed': 'teal',
        'Active': 'green',
        'Expired': 'orange',
        'Terminated': 'red',
        'Invoiced': 'purple',
        'Paid': 'green',
        'Cancelled': 'red'
    };

    function badge(status) {
        var value = status === null || status === undefined || status === '' ? 'Unknown' : String(status);
        var cls = BADGE_CLASSES[value] || 'gray';
        return '<span class="pp-badge ' + cls + '">' + escape(value) + '</span>';
    }

    function detailRow(label, valueHtml) {
        return '<div class="pp-detail-row"><span>' + escape(label) + '</span><span>' +
            (valueHtml === null || valueHtml === undefined || valueHtml === '' ? '\u2014' : valueHtml) +
            '</span></div>';
    }

    function emptyRow(colspan, message, icon) {
        return '<tr><td colspan="' + colspan + '"><div class="pp-empty">' +
            '<i class="fa ' + (icon || 'fa-inbox') + '"></i><p>' + escape(message) + '</p></div></td></tr>';
    }

    function errorRow(colspan) {
        return '<tr><td colspan="' + colspan + '"><div class="pp-empty">' +
            '<i class="fa fa-exclamation-triangle"></i>' +
            '<p>This section could not be loaded. Please refresh the page or contact your Dhanvi Finserv executive.</p>' +
            '</div></td></tr>';
    }

    function loadingRow(colspan, message) {
        return '<tr><td colspan="' + colspan + '"><div class="pp-loading">' +
            '<span class="pp-spinner"></span> ' + escape(message) + '</div></td></tr>';
    }

    function showAlert(type, message) {
        var box = el('portalAlert');
        if (!box) { return; }
        box.className = 'pp-alert show ' + type;
        box.textContent = message;
        try { box.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (err) { /* ignore */ }
    }

    function hideAlert() {
        var box = el('portalAlert');
        if (box) { box.className = 'pp-alert'; box.textContent = ''; }
    }

    function statusMessage(status) {
        if (status === 'Pending Agreement') {
            return 'Your application is approved, but the partner agreement is not yet signed and effective. The portal opens after login provisioning. Please contact the partner desk.';
        }
        if (status === 'Suspended') {
            return 'Your partner account is suspended. Please contact the partner desk for assistance.';
        }
        if (status === 'Inactive') {
            return 'Your partner account is inactive. Please contact the partner desk for assistance.';
        }
        return 'Your partner account is not active. Please contact the partner desk.';
    }

    /* ------------------------------------------------------------------ *
     * Access gate
     * ------------------------------------------------------------------ */

    function redirectToLogin(message) {
        if (message) {
            try { window.sessionStorage.setItem('dhanviPartnerLoginMessage', message); } catch (err) { /* ignore */ }
        }
        window.location.replace('partner-login.html');
    }

    function deny(title, message) {
        var loading = el('gateLoading');
        var denied = el('gateDenied');
        if (loading) { loading.style.display = 'none'; }
        if (denied) { denied.style.display = 'block'; }
        if (el('gateTitle')) { el('gateTitle').textContent = title || 'Access unavailable'; }
        if (el('gateMessage')) { el('gateMessage').textContent = message || 'Your partner access could not be verified.'; }
    }

    function showPortal() {
        var gate = el('portalGate');
        if (gate) { gate.style.display = 'none'; }
    }

    async function boot() {
        if (!D || !B) {
            deny('Service unavailable', 'The secure partner service could not be loaded. Please refresh the page or contact the partner desk.');
            return;
        }

        var nhost = B.getClient();
        if (!nhost) {
            deny('Service not configured', 'The secure partner service is not configured. Please contact the partner desk.');
            return;
        }

        var session = nhost.getUserSession();
        if (!session || !session.user) {
            redirectToLogin();
            return;
        }

        var user;
        try {
            var response = await nhost.auth.getUser();
            user = response && response.body;
        } catch (err) {
            console.warn('Partner session validation failed:', err);
            await B.signOut();
            redirectToLogin('Your session has expired. Please sign in again.');
            return;
        }

        if (!user || user.isAnonymous) {
            await B.signOut();
            redirectToLogin('Please sign in with a provisioned partner account.');
            return;
        }

        if (!Array.isArray(user.roles) || user.roles.indexOf('partner') === -1) {
            await B.signOut();
            redirectToLogin('Access denied. This account does not have partner access.');
            return;
        }

        state.user = user;

        var profile;
        try {
            var data = await B.partnerGql(PROFILE_QUERY, { userId: user.id });
            var rows = data && data.partner_profiles ? data.partner_profiles : [];
            profile = rows.length ? rows[0] : null;
        } catch (err) {
            console.error('Partner profile lookup failed:', err);
            deny('Profile unavailable', 'The portal could not load your partner profile. Please refresh the page or contact the partner desk.');
            return;
        }

        if (!profile) {
            deny('No partner profile', 'This account is not linked to a partner profile. Partner logins are provisioned only after approval and a signed agreement. Please contact the partner desk.');
            return;
        }

        if (profile.status !== 'Active') {
            deny('Account not active', statusMessage(profile.status));
            return;
        }

        state.profile = profile;
        hydrateHeader();
        showPortal();
        bindNavigation();
        bindLeadModal();
        bindLogout();

        loadApplication();
        loadDashboard();
    }

    function hydrateHeader() {
        var profile = state.profile || {};
        var name = profile.display_name || (state.user && state.user.email) || 'Partner';
        var code = profile.partner_code || '\u2014';
        var initials = name.split(/\s+/).filter(Boolean).map(function (part) {
            return part.charAt(0);
        }).join('').toUpperCase().substring(0, 2) || 'DP';

        if (el('sidebarPartnerCode')) { el('sidebarPartnerCode').textContent = 'Partner code ' + code; }
        if (el('topbarAvatar')) { el('topbarAvatar').textContent = initials; }
        if (el('topbarName')) { el('topbarName').textContent = name; }
        if (el('topbarCode')) { el('topbarCode').textContent = 'Code ' + code; }
        if (el('welcomeName')) { el('welcomeName').textContent = name; }
        if (el('welcomeCode')) { el('welcomeCode').textContent = 'Partner code: ' + code; }
        if (el('welcomeStatus')) { el('welcomeStatus').textContent = 'Status: ' + (profile.status || '\u2014'); }
        if (el('welcomeSince')) {
            el('welcomeSince').textContent = 'Active since: ' + formatDate(profile.activated_at || profile.created_at);
        }
        setPageTitle('dashboard');
    }

    function setPageTitle(section) {
        if (el('pageTitle')) { el('pageTitle').textContent = SECTION_TITLES[section] || 'Dashboard'; }
    }

    /* ------------------------------------------------------------------ *
     * Navigation
     * ------------------------------------------------------------------ */

    function closeSidebar() {
        var sidebar = el('portalSidebar');
        var overlay = el('sidebarOverlay');
        if (sidebar) { sidebar.classList.remove('open'); }
        if (overlay) { overlay.classList.remove('show'); }
    }

    function openSidebar() {
        var sidebar = el('portalSidebar');
        var overlay = el('sidebarOverlay');
        if (sidebar) { sidebar.classList.add('open'); }
        if (overlay) { overlay.classList.add('show'); }
    }

    function bindNavigation() {
        Array.prototype.forEach.call(document.querySelectorAll('.pp-sidebar-nav a[data-section]'), function (link) {
            link.addEventListener('click', function () {
                showSection(link.getAttribute('data-section'));
            });
        });

        Array.prototype.forEach.call(document.querySelectorAll('[data-goto]'), function (button) {
            button.addEventListener('click', function () {
                showSection(button.getAttribute('data-goto'));
            });
        });

        var toggle = el('sidebarToggle');
        if (toggle) { toggle.addEventListener('click', openSidebar); }

        var overlay = el('sidebarOverlay');
        if (overlay) { overlay.addEventListener('click', closeSidebar); }
    }

    function showSection(section) {
        if (!SECTION_TITLES[section]) { return; }

        Array.prototype.forEach.call(document.querySelectorAll('.pp-section'), function (node) {
            node.classList.toggle('active', node.id === 'section-' + section);
        });
        Array.prototype.forEach.call(document.querySelectorAll('.pp-sidebar-nav a[data-section]'), function (link) {
            link.classList.toggle('active', link.getAttribute('data-section') === section);
        });

        setPageTitle(section);
        closeSidebar();
        hideAlert();

        if (section === 'dashboard') { loadDashboard(); }
        if (section === 'profile') {
            renderProfile();
            if (!state.application.loaded) { loadApplication(); } else { renderApplication(); }
            if (!state.verifications.loaded) { loadVerifications(); } else { renderVerifications(); }
        }
        if (section === 'documents') {
            if (!state.documents.loaded) { loadDocuments(); } else { renderDocuments(); }
        }
        if (section === 'agreement') {
            if (!state.agreements.loaded) { loadAgreements(); } else { renderAgreements(); }
        }
        if (section === 'leads') {
            if (!state.assignments.loaded) { loadAssignments(); } else { renderLeads(); }
        }
        if (section === 'commissions') {
            if (!state.commissions.loaded) { loadCommissions(); } else { renderCommissions(); }
        }
        if (section === 'followups') {
            if (!state.followups.loaded) { loadFollowups(); } else { renderFollowups(); }
        }

        try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (err) { window.scrollTo(0, 0); }
    }

    function bindLogout() {
        function logout() {
            B.signOut().catch(function (err) {
                console.warn('Partner sign-out request failed:', err);
            }).then(function () {
                window.location.href = 'partner-login.html';
            });
        }
        if (el('topbarLogout')) { el('topbarLogout').addEventListener('click', logout); }
        if (el('sidebarLogout')) { el('sidebarLogout').addEventListener('click', logout); }
    }

    /* ------------------------------------------------------------------ *
     * Data loading
     * ------------------------------------------------------------------ */

    function loadApplication() {
        var resource = state.application;
        if (resource.loading) { return Promise.resolve(); }
        resource.loading = true;
        renderApplication();
        renderProfile();

        return B.partnerGql(APPLICATION_QUERY, { leadId: state.profile.loan_lead_id })
            .then(function (data) {
                var rows = data && data.partner_application_details ? data.partner_application_details : [];
                resource.data = rows.length ? rows[0] : null;
                resource.error = null;
            })
            .catch(function (err) {
                resource.error = err;
                console.error('Partner application query failed:', err);
            })
            .then(function () {
                resource.loading = false;
                resource.loaded = true;
                renderApplication();
                renderProfile();
            });
    }

    function loadDocuments() {
        var resource = state.documents;
        if (resource.loading) { return Promise.resolve(); }
        resource.loading = true;
        renderDocuments();

        return B.partnerGql(DOCUMENTS_QUERY, { leadId: state.profile.loan_lead_id })
            .then(function (data) {
                resource.data = (data && data.partner_documents) || [];
                resource.error = null;
            })
            .catch(function (err) {
                resource.error = err;
                console.error('Partner documents query failed:', err);
            })
            .then(function () {
                resource.loading = false;
                resource.loaded = true;
                renderDocuments();
                renderDashboard();
            });
    }

    function loadAgreements() {
        var resource = state.agreements;
        if (resource.loading) { return Promise.resolve(); }
        resource.loading = true;
        renderAgreements();

        return B.partnerGql(AGREEMENTS_QUERY, { leadId: state.profile.loan_lead_id })
            .then(function (data) {
                resource.data = (data && data.partner_agreements) || [];
                resource.error = null;
            })
            .catch(function (err) {
                resource.error = err;
                console.error('Partner agreements query failed:', err);
            })
            .then(function () {
                resource.loading = false;
                resource.loaded = true;
                renderAgreements();
            });
    }

    function loadVerifications() {
        var resource = state.verifications;
        if (resource.loading) { return Promise.resolve(); }
        resource.loading = true;
        renderVerifications();

        return B.partnerGql(VERIFICATIONS_QUERY, { leadId: state.profile.loan_lead_id })
            .then(function (data) {
                resource.data = (data && data.partner_verifications) || [];
                resource.error = null;
            })
            .catch(function (err) {
                resource.error = err;
                console.error('Partner verifications query failed:', err);
            })
            .then(function () {
                resource.loading = false;
                resource.loaded = true;
                renderVerifications();
            });
    }

    function loadAssignments() {
        var resource = state.assignments;
        if (resource.loading) { return Promise.resolve(); }
        resource.loading = true;
        renderLeads();
        renderDashboard();

        return B.partnerGql(ASSIGNMENTS_QUERY, { profileId: state.profile.id })
            .then(function (data) {
                resource.data = (data && data.partner_lead_assignments) || [];
                resource.error = null;
            })
            .catch(function (err) {
                resource.error = err;
                console.error('Partner assignments query failed:', err);
            })
            .then(function () {
                resource.loading = false;
                resource.loaded = true;
                renderLeads();
                renderDashboard();
            });
    }

    function loadCommissions() {
        var resource = state.commissions;
        if (resource.loading) { return Promise.resolve(); }
        resource.loading = true;
        renderCommissions();
        renderDashboard();

        return B.partnerGql(COMMISSIONS_QUERY, { profileId: state.profile.id })
            .then(function (data) {
                resource.data = (data && data.partner_commissions) || [];
                resource.error = null;
            })
            .catch(function (err) {
                resource.error = err;
                console.error('Partner commissions query failed:', err);
            })
            .then(function () {
                resource.loading = false;
                resource.loaded = true;
                renderCommissions();
                renderDashboard();
            });
    }

    function loadFollowups() {
        var resource = state.followups;
        if (resource.loading) { return Promise.resolve(); }
        resource.loading = true;
        renderFollowups();
        renderDashboard();

        return B.partnerGql(FOLLOWUPS_QUERY, {
            profileId: state.profile.id,
            leadId: state.profile.loan_lead_id
        })
            .then(function (data) {
                resource.data = (data && data.partner_followups) || [];
                resource.error = null;
            })
            .catch(function (err) {
                resource.error = err;
                console.error('Partner follow-ups query failed:', err);
            })
            .then(function () {
                resource.loading = false;
                resource.loaded = true;
                renderFollowups();
                renderDashboard();
            });
    }

    function loadDashboard() {
        if (state.dashboardLoading) { return; }
        state.dashboardLoading = true;
        renderDashboard();

        var jobs = [];
        if (!state.assignments.loaded) { jobs.push(loadAssignments()); }
        if (!state.commissions.loaded) { jobs.push(loadCommissions()); }
        if (!state.followups.loaded) { jobs.push(loadFollowups()); }
        if (!state.documents.loaded) { jobs.push(loadDocuments()); }

        Promise.allSettled(jobs).then(function () {
            state.dashboardLoading = false;
            renderDashboard();
        });
    }

    /* ------------------------------------------------------------------ *
     * Dashboard
     * ------------------------------------------------------------------ */

    function renderDashboard() {
        var assignments = state.assignments.data || [];
        var commissions = state.commissions.data || [];
        var followups = state.followups.data || [];
        var documents = state.documents.data || [];

        var activeStatuses = ['Contacted', 'Documents Pending', 'Submitted to Lender'];
        var activeCount = assignments.filter(function (row) {
            return activeStatuses.indexOf(row.status) !== -1;
        }).length;
        var sanctioned = assignments.filter(function (row) { return row.status === 'Sanctioned'; }).length;
        var disbursed = assignments.filter(function (row) { return row.status === 'Disbursed'; }).length;
        var pendingCommission = sumCommission(commissions, ['Pending', 'Approved', 'Invoiced', 'On Hold']);
        var paidCommission = sumCommission(commissions, ['Paid']);
        var pendingFollowups = followups.filter(function (row) { return row.status === 'Pending'; }).length;
        var pendingDocs = documents.filter(function (row) { return row.status === 'Pending'; }).length;

        setText('dashAssigned', state.assignments.loading ? '\u2026' : String(assignments.length));
        setText('dashActive', state.assignments.loading ? '\u2026' : String(activeCount));
        setText('dashSanctioned', state.assignments.loading ? '\u2026' : String(sanctioned));
        setText('dashDisbursed', state.assignments.loading ? '\u2026' : String(disbursed));
        setText('dashCommissionPending', state.commissions.loading ? '\u2026' : formatMoney(pendingCommission));
        setText('dashCommissionPaid', state.commissions.loading ? '\u2026' : formatMoney(paidCommission));
        setText('dashFollowups', state.followups.loading ? '\u2026' : String(pendingFollowups));
        setText('dashDocsPending', state.documents.loading ? '\u2026' : String(pendingDocs));

        renderRecentLeads(assignments);
        renderUpcomingFollowups(followups);
    }

    function setText(id, value) {
        if (el(id)) { el(id).textContent = value; }
    }

    function renderRecentLeads(assignments) {
        var body = el('recentLeadsBody');
        if (!body) { return; }

        if (state.assignments.loading && !state.assignments.loaded) {
            body.innerHTML = loadingRow(4, 'Loading leads...');
            return;
        }
        if (state.assignments.error) {
            body.innerHTML = errorRow(4);
            return;
        }
        if (!assignments.length) {
            body.innerHTML = emptyRow(4, 'No leads have been assigned yet. Lead allocation depends on customer location, product fit and lender requirements.', 'fa-users');
            return;
        }

        body.innerHTML = assignments.slice(0, 5).map(function (row) {
            return '<tr>' +
                '<td class="pp-strong pp-nowrap">' + escape(row.assignment_reference || '\u2014') + '</td>' +
                '<td>' + escape(row.customer_name || '\u2014') + '<div class="pp-muted">' + escape(row.customer_city || '') + '</div></td>' +
                '<td>' + escape(row.product_type || '\u2014') + '</td>' +
                '<td>' + badge(row.status) + '</td>' +
                '</tr>';
        }).join('');
    }

    function renderUpcomingFollowups(followups) {
        var body = el('upcomingFollowupsBody');
        if (!body) { return; }

        if (state.followups.loading && !state.followups.loaded) {
            body.innerHTML = loadingRow(3, 'Loading follow-ups...');
            return;
        }
        if (state.followups.error) {
            body.innerHTML = errorRow(3);
            return;
        }

        var pending = followups.filter(function (row) { return row.status === 'Pending'; });
        if (!pending.length) {
            body.innerHTML = emptyRow(3, 'No follow-ups are scheduled right now.', 'fa-calendar-check-o');
            return;
        }

        body.innerHTML = pending.slice(0, 5).map(function (row) {
            return '<tr>' +
                '<td class="pp-nowrap">' + formatDateTime(row.scheduled_at) + '</td>' +
                '<td>' + escape(row.interaction_type || '\u2014') + '</td>' +
                '<td>' + badge(row.status) + '</td>' +
                '</tr>';
        }).join('');
    }

    /* ------------------------------------------------------------------ *
     * Profile and application
     * ------------------------------------------------------------------ */

    function renderProfile() {
        var box = el('profileDetails');
        if (!box || !state.profile) { return; }

        var profile = state.profile;
        var application = state.application.data;
        var email = (application && application.email) || (state.user && state.user.email) || '';
        var mobile = (application && application.mobile) || '';

        box.innerHTML =
            detailRow('Display name', escape(profile.display_name || '\u2014')) +
            detailRow('Partner code', escape(profile.partner_code || '\u2014')) +
            detailRow('Partner type', text(profile.partner_type)) +
            detailRow('Firm name', text(profile.firm_name)) +
            detailRow('Account status', badge(profile.status)) +
            detailRow('Onboarding completed', profile.onboarding_completed ? 'Yes' : 'No') +
            detailRow('Activated on', formatDate(profile.activated_at)) +
            detailRow('Partner since', formatDate(profile.created_at)) +
            detailRow('Email', text(email)) +
            detailRow('Mobile', text(mobile));
    }

    function renderApplication() {
        var box = el('applicationDetails');
        if (!box) { return; }

        if (state.application.loading && !state.application.loaded) {
            box.innerHTML = '<div class="pp-loading"><span class="pp-spinner"></span> Loading application...</div>';
            return;
        }
        if (state.application.error) {
            box.innerHTML = '<div class="pp-empty"><i class="fa fa-exclamation-triangle"></i><p>Your onboarding application could not be loaded. Please refresh the page or contact your executive.</p></div>';
            return;
        }

        var app = state.application.data;
        if (!app) {
            box.innerHTML = '<div class="pp-empty"><i class="fa fa-folder-open"></i><p>No onboarding application is recorded for this partner profile.</p></div>';
            return;
        }

        var address = [app.office_address, app.office_city, app.office_state, app.office_pincode]
            .filter(Boolean).join(', ');
        var products = Array.isArray(app.products) ? app.products.join(', ') : '';
        var notes = [app.status_notes, app.admin_remarks].filter(Boolean).join(' | ');

        box.innerHTML =
            detailRow('Applicant name', text(app.applicant_name)) +
            detailRow('Application status', badge(app.application_status)) +
            detailRow('Mobile', text(app.mobile)) +
            detailRow('Email', text(app.email)) +
            detailRow('City / state', escape([app.applicant_city, app.applicant_state].filter(Boolean).join(', ') || '\u2014')) +
            detailRow('PAN', escape(maskNumber(app.pan_number))) +
            detailRow('Firm name', text(app.firm_name)) +
            detailRow('Partner type', text(app.partner_type)) +
            detailRow('Office address', text(address)) +
            detailRow('Business registration', text(app.business_registration_type)) +
            detailRow('Registration number', escape(maskNumber(app.business_registration_number))) +
            detailRow('GSTIN', escape(maskNumber(app.gst_number))) +
            detailRow('Years of experience', app.years_experience === null || app.years_experience === undefined ? '\u2014' : escape(String(app.years_experience))) +
            detailRow('Financial services experience', text(app.financial_services_experience)) +
            detailRow('Existing DSA / bank associations', text(app.existing_dsa_associations)) +
            detailRow('Bank / NBFC relationships', text(app.bank_associations)) +
            detailRow('Products', text(products)) +
            detailRow('Expected referrals / month', app.expected_leads_per_month === null || app.expected_leads_per_month === undefined ? '\u2014' : escape(String(app.expected_leads_per_month))) +
            detailRow('Preferred locations', text(app.preferred_locations)) +
            detailRow('Referral source', text(app.referral_source)) +
            detailRow('Additional notes', text(app.additional_notes)) +
            detailRow('Reviewed on', formatDate(app.reviewed_at)) +
            detailRow('Status notes', text(notes)) +
            detailRow('Rejection reason', text(app.rejection_reason));
    }

    function renderVerifications() {
        var body = el('verificationBody');
        if (!body) { return; }

        if (state.verifications.loading && !state.verifications.loaded) {
            body.innerHTML = loadingRow(5, 'Loading verification records...');
            return;
        }
        if (state.verifications.error) {
            body.innerHTML = errorRow(5);
            return;
        }
        if (!state.verifications.data.length) {
            body.innerHTML = emptyRow(5, 'No verification records have been recorded yet.', 'fa-shield');
            return;
        }

        body.innerHTML = state.verifications.data.map(function (row) {
            var remarks = [row.findings, row.remarks].filter(Boolean).join(' | ');
            return '<tr>' +
                '<td class="pp-strong">' + escape(row.verification_type || '\u2014') + '</td>' +
                '<td>' + badge(row.status) + '</td>' +
                '<td>' + text(row.reference_no) + '</td>' +
                '<td class="pp-nowrap">' + formatDate(row.verified_at) + '</td>' +
                '<td>' + text(remarks) + '</td>' +
                '</tr>';
        }).join('');
    }

    /* ------------------------------------------------------------------ *
     * Documents
     * ------------------------------------------------------------------ */

    function renderDocuments() {
        var body = el('documentsBody');
        if (!body) { return; }

        var countEl = el('documentsCount');
        if (countEl) {
            countEl.textContent = state.documents.loaded
                ? state.documents.data.length + ' document' + (state.documents.data.length === 1 ? '' : 's') + ' recorded against your partner application.'
                : 'Documents uploaded against your partner application.';
        }

        if (state.documents.loading && !state.documents.loaded) {
            body.innerHTML = loadingRow(5, 'Loading documents...');
            return;
        }
        if (state.documents.error) {
            body.innerHTML = errorRow(5);
            return;
        }
        if (!state.documents.data.length) {
            body.innerHTML = emptyRow(5, 'No documents have been recorded yet. Upload documents only through the private link provided by the partner desk.', 'fa-folder-open');
            return;
        }

        body.innerHTML = state.documents.data.map(function (row) {
            var size = formatFileSize(row.file_size);
            var file = (row.file_name || '\u2014') + (size ? ' (' + size + ')' : '');
            var notes = [row.verification_date ? 'Verified on ' + formatDate(row.verification_date) : '', row.notes]
                .filter(Boolean).join(' | ');
            return '<tr>' +
                '<td class="pp-strong">' + escape(row.document_type || '\u2014') + '</td>' +
                '<td>' + escape(file) + '</td>' +
                '<td>' + badge(row.status) + '</td>' +
                '<td class="pp-nowrap">' + formatDate(row.created_at) + '</td>' +
                '<td>' + text(notes) + '</td>' +
                '</tr>';
        }).join('');
    }

    /* ------------------------------------------------------------------ *
     * Agreement
     * ------------------------------------------------------------------ */

    function renderAgreements() {
        var box = el('agreementContent');
        if (!box) { return; }

        if (state.agreements.loading && !state.agreements.loaded) {
            box.innerHTML = '<div class="pp-loading"><span class="pp-spinner"></span> Loading agreement...</div>';
            return;
        }
        if (state.agreements.error) {
            box.innerHTML = '<div class="pp-empty"><i class="fa fa-exclamation-triangle"></i><p>The agreement record could not be loaded. Please refresh the page or contact your executive.</p></div>';
            return;
        }
        if (!state.agreements.data.length) {
            box.innerHTML = '<div class="pp-empty"><i class="fa fa-file-text-o"></i><p>No agreement has been recorded yet. A partner login is provisioned only after a signed and effective agreement. Please contact your executive.</p></div>';
            return;
        }

        box.innerHTML = state.agreements.data.map(function (row, index) {
            var terms = row.commission_terms
                ? '<p style="white-space:pre-line;margin:0;font-size:13px;line-height:1.7;">' + escape(row.commission_terms) + '</p>'
                : '<p style="margin:0;font-size:13px;color:#8a97a8;">No commission terms have been recorded on this agreement.</p>';
            return (index > 0 ? '<hr style="border-color:#edf0f5;margin:24px 0;">' : '') +
                '<div class="pp-detail-grid">' +
                detailRow('Agreement type', text(row.agreement_type)) +
                detailRow('Status', badge(row.agreement_status)) +
                detailRow('Reference', text(row.agreement_reference)) +
                detailRow('Document', text(row.document_name)) +
                detailRow('Signed on', formatDate(row.signed_date)) +
                detailRow('Effective from', formatDate(row.effective_from)) +
                detailRow('Effective to', formatDate(row.effective_to)) +
                detailRow('Recorded on', formatDate(row.created_at)) +
                '</div>' +
                '<h3 class="pp-subhead">Commission terms</h3>' +
                terms +
                (row.admin_remarks ? '<h3 class="pp-subhead">Remarks</h3><p style="font-size:13px;line-height:1.7;margin:0;">' + escape(row.admin_remarks) + '</p>' : '');
        }).join('');
    }

    /* ------------------------------------------------------------------ *
     * Leads
     * ------------------------------------------------------------------ */

    function renderLeads() {
        var body = el('leadsBody');
        if (!body) { return; }

        var filter = el('leadStatusFilter') ? el('leadStatusFilter').value : '';
        var rows = (state.assignments.data || []).filter(function (row) {
            return !filter || row.status === filter;
        });

        if (el('leadsCount')) {
            el('leadsCount').textContent = state.assignments.loaded
                ? rows.length + ' lead' + (rows.length === 1 ? '' : 's') + ' shown' +
                    (filter ? ' with status ' + filter : '') + '.'
                : 'Customer files assigned to your partner profile.';
        }

        if (state.assignments.loading && !state.assignments.loaded) {
            body.innerHTML = loadingRow(8, 'Loading leads...');
            return;
        }
        if (state.assignments.error) {
            body.innerHTML = errorRow(8);
            return;
        }
        if (!rows.length) {
            body.innerHTML = emptyRow(8, filter
                ? 'No assigned leads match this status.'
                : 'No leads have been assigned yet. Lead allocation depends on customer location, product fit and lender requirements.', 'fa-users');
            return;
        }

        body.innerHTML = rows.map(function (row) {
            var canUpdate = OPEN_LEAD_STATUSES.indexOf(row.status) !== -1;
            var action = canUpdate
                ? '<button type="button" class="pp-btn pp-btn-outline pp-btn-sm" data-assignment="' + escape(row.id) + '">Update status</button>'
                : '<span class="pp-muted">Managed by Dhanvi</span>';
            return '<tr>' +
                '<td class="pp-strong pp-nowrap">' + escape(row.assignment_reference || '\u2014') + '</td>' +
                '<td>' + escape(row.customer_name || '\u2014') +
                    '<div class="pp-muted">' + escape(row.customer_mobile || '') + '</div></td>' +
                '<td>' + escape(row.product_type || '\u2014') + '</td>' +
                '<td class="pp-nowrap">' + formatMoney(row.requested_amount) + '</td>' +
                '<td>' + text(row.lender_name) + '</td>' +
                '<td>' + badge(row.status) + '</td>' +
                '<td class="pp-nowrap">' + formatDate(row.assigned_at) + '</td>' +
                '<td>' + action + '</td>' +
                '</tr>';
        }).join('');
    }

    /* ------------------------------------------------------------------ *
     * Commissions
     * ------------------------------------------------------------------ */

    function renderCommissions() {
        var body = el('commissionsBody');
        if (!body) { return; }

        var rows = state.commissions.data || [];
        setText('commissionPendingTotal', state.commissions.loading ? '\u2026' : formatMoney(sumCommission(rows, ['Pending', 'On Hold'])));
        setText('commissionApprovedTotal', state.commissions.loading ? '\u2026' : formatMoney(sumCommission(rows, ['Approved', 'Invoiced'])));
        setText('commissionPaidTotal', state.commissions.loading ? '\u2026' : formatMoney(sumCommission(rows, ['Paid'])));

        if (state.commissions.loading && !state.commissions.loaded) {
            body.innerHTML = loadingRow(9, 'Loading commissions...');
            return;
        }
        if (state.commissions.error) {
            body.innerHTML = errorRow(9);
            return;
        }
        if (!rows.length) {
            body.innerHTML = emptyRow(9, 'No commission records have been created yet. A commission is recorded only after the related disbursal and agreement check.', 'fa-inr');
            return;
        }

        body.innerHTML = rows.map(function (row) {
            var rate = row.rate_percent === null || row.rate_percent === undefined ? '\u2014' : escape(String(row.rate_percent)) + '%';
            var payment = row.payment_reference || (row.paid_at ? formatDate(row.paid_at) : '\u2014');
            return '<tr>' +
                '<td class="pp-nowrap">' + formatDate(row.created_at) + '</td>' +
                '<td>' + escape(row.commission_type || '\u2014') + '</td>' +
                '<td class="pp-nowrap">' + formatMoney(row.basis_amount) + '</td>' +
                '<td class="pp-nowrap">' + rate + '</td>' +
                '<td class="pp-nowrap">' + formatMoney(row.commission_amount) + '</td>' +
                '<td class="pp-nowrap">' + formatMoney(row.tds_amount) + '</td>' +
                '<td class="pp-nowrap pp-strong">' + formatMoney(netCommission(row)) + '</td>' +
                '<td>' + badge(row.status) + '</td>' +
                '<td>' + escape(payment) + '</td>' +
                '</tr>';
        }).join('');
    }

    /* ------------------------------------------------------------------ *
     * Follow-ups
     * ------------------------------------------------------------------ */

    function renderFollowups() {
        var body = el('followupsBody');
        if (!body) { return; }

        if (state.followups.loading && !state.followups.loaded) {
            body.innerHTML = loadingRow(5, 'Loading follow-ups...');
            return;
        }
        if (state.followups.error) {
            body.innerHTML = errorRow(5);
            return;
        }
        if (!state.followups.data.length) {
            body.innerHTML = emptyRow(5, 'No follow-ups are scheduled right now.', 'fa-calendar-check-o');
            return;
        }

        body.innerHTML = state.followups.data.map(function (row) {
            return '<tr>' +
                '<td class="pp-nowrap">' + formatDateTime(row.scheduled_at) + '</td>' +
                '<td>' + escape(row.interaction_type || '\u2014') + '</td>' +
                '<td>' + badge(row.status) + '</td>' +
                '<td>' + text(row.notes) + '</td>' +
                '<td class="pp-nowrap">' + formatDateTime(row.completed_at) + '</td>' +
                '</tr>';
        }).join('');
    }

    /* ------------------------------------------------------------------ *
     * Lead status modal
     * ------------------------------------------------------------------ */

    function findAssignment(id) {
        var rows = state.assignments.data || [];
        for (var i = 0; i < rows.length; i += 1) {
            if (rows[i].id === id) { return rows[i]; }
        }
        return null;
    }

    function defaultNextStatus(status) {
        if (status === 'Assigned') { return 'Contacted'; }
        if (status === 'Contacted') { return 'Documents Pending'; }
        if (status === 'Documents Pending') { return 'Submitted to Lender'; }
        return 'Submitted to Lender';
    }

    function openLeadModal(id) {
        var assignment = findAssignment(id);
        if (!assignment) { return; }

        if (el('leadAssignmentId')) { el('leadAssignmentId').value = assignment.id; }
        if (el('leadModalSubtitle')) {
            el('leadModalSubtitle').textContent =
                (assignment.assignment_reference || 'Lead') + ' - ' + (assignment.customer_name || 'Customer');
        }
        if (el('leadStatusSelect')) { el('leadStatusSelect').value = defaultNextStatus(assignment.status); }
        if (el('leadStatusNotes')) { el('leadStatusNotes').value = ''; }
        hideModalError();
        if (el('leadModal')) { el('leadModal').classList.add('show'); }
    }

    function closeLeadModal() {
        if (el('leadModal')) { el('leadModal').classList.remove('show'); }
        hideModalError();
    }

    function showModalError(message) {
        var box = el('leadModalError');
        if (!box) { return; }
        box.textContent = message;
        box.classList.add('show');
    }

    function hideModalError() {
        var box = el('leadModalError');
        if (!box) { return; }
        box.textContent = '';
        box.classList.remove('show');
    }

    function setLeadSaveBusy(busy) {
        var button = el('leadModalSave');
        if (!button) { return; }
        button.disabled = busy;
        button.innerHTML = busy
            ? '<span class="pp-spinner" style="width:14px;height:14px;border-width:2px;border-top-color:#fff;"></span> Saving...'
            : 'Save update';
    }

    function saveLeadStatus() {
        if (leadModalBusy) { return; }

        var id = el('leadAssignmentId') ? el('leadAssignmentId').value : '';
        var status = el('leadStatusSelect') ? el('leadStatusSelect').value : '';
        var notes = el('leadStatusNotes') ? String(el('leadStatusNotes').value || '').trim() : '';

        if (!id) { showModalError('The lead could not be identified. Please refresh the page.'); return; }
        if (ALLOWED_LEAD_STATUSES.indexOf(status) === -1) {
            showModalError('Select Contacted, Documents Pending or Submitted to Lender.');
            return;
        }

        leadModalBusy = true;
        hideModalError();
        setLeadSaveBusy(true);

        B.partnerRpc('update_partner_lead_status', {
            p_assignment_id: id,
            p_status: status,
            p_notes: notes || null
        }).then(function () {
            closeLeadModal();
            showAlert('success', 'Lead progress updated to ' + status + '. The Dhanvi Finserv team can see the update.');
            return loadAssignments();
        }).catch(function (err) {
            console.error('Partner lead status update failed:', err);
            showModalError(B.errorMessage(err));
        }).then(function () {
            leadModalBusy = false;
            setLeadSaveBusy(false);
        });
    }

    function bindLeadModal() {
        var body = el('leadsBody');
        if (body) {
            body.addEventListener('click', function (event) {
                var button = event.target.closest('button[data-assignment]');
                if (!button) { return; }
                openLeadModal(button.getAttribute('data-assignment'));
            });
        }

        var filter = el('leadStatusFilter');
        if (filter) { filter.addEventListener('change', renderLeads); }

        if (el('leadModalClose')) { el('leadModalClose').addEventListener('click', closeLeadModal); }
        if (el('leadModalCancel')) { el('leadModalCancel').addEventListener('click', closeLeadModal); }
        if (el('leadModalSave')) { el('leadModalSave').addEventListener('click', saveLeadStatus); }

        var modal = el('leadModal');
        if (modal) {
            modal.addEventListener('click', function (event) {
                if (event.target === modal) { closeLeadModal(); }
            });
        }

        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') { closeLeadModal(); }
        });
    }

    /* ------------------------------------------------------------------ *
     * Boot
     * ------------------------------------------------------------------ */

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})(window, document);

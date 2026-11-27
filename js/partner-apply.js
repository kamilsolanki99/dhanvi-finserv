/**
 * Dhanvi Finserv - DSA Partner Network onboarding wizard.
 *
 * Depends on: js/nhost-client.js, js/public-api.js
 *
 * Flow
 *   1    applicant profile, contact, city, state and PAN
 *   2    firm, office address, business registration, GST, experience
 *   3    products, expected monthly referrals, locations and notes
 *   4    conditional document checklist
 *   5    review and mandatory accuracy / commission / no-guarantee / consent
 *        declarations
 *
 * Save / resume
 *   A server-side draft is created through save_home_loan_draft() (shared with
 *   the other application wizards) as soon as the first step validates, and
 *   refreshed on every step change. The draft id + secret token are kept in
 *   localStorage so the applicant can resume in the same browser, and
 *   "Save & continue later" also shows a resume link. Submitting promotes the
 *   draft into a real partner onboarding application through
 *   submit_partner_application().
 *
 * IMPORTANT
 *   Submitting this wizard does NOT approve the applicant as a partner, assign
 *   leads, create an agreement or provision a login. Those are administrator
 *   steps. PAN and the business registration number are intentionally removed
 *   from drafts and must be re-entered on resume.
 */
(function (window, document) {
    'use strict';

    var D = window.Dhanvi;
    var form = document.getElementById('partnerApplicationForm');
    if (!D || !form) { return; }

    var DRAFT_KEY = 'dhanviPartnerDraft';
    var TOTAL_STEPS = 5;
    var CONSENT_VERSION = '2026-11';

    var alertBox = document.getElementById('applicationAlert');
    var draftBar = document.getElementById('draftBar');
    var draftBarText = document.getElementById('draftBarText');
    var successBox = document.getElementById('applicationSuccess');
    var stepper = document.getElementById('partnerStepper');
    var steps = Array.prototype.slice.call(form.querySelectorAll('.cp-step'));
    var prevBtn = document.getElementById('prevBtn');
    var nextBtn = document.getElementById('nextBtn');
    var submitBtn = document.getElementById('submitBtn');
    var saveDraftBtn = document.getElementById('saveDraftBtn');
    var progressText = document.getElementById('progressText');
    var checklistBox = document.getElementById('partnerDocChecklist');
    var reviewBox = document.getElementById('partnerReviewSummary');

    var current = 0;
    var maxStep = 0;
    var draftId = null;
    var draftToken = null;

    var STATES = ['Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry'];

    var PARTNER_TYPES = ['Individual / Referral Partner', 'Chartered Accountant / Tax Consultant', 'Property Consultant / Broker', 'Insurance Advisor', 'Financial Services Company', 'Bank / NBFC Relationship', 'Other'];
    var REGISTRATION_TYPES = ['Proprietorship', 'Partnership', 'LLP', 'Private Limited', 'Public Limited', 'Society / Trust', 'Not registered'];
    var FINANCIAL_EXPERIENCE = ['None', 'Less than 1 year', '1-3 years', '3-5 years', '5-10 years', 'More than 10 years'];
    var PRODUCTS = ['Home Loan', 'Loan Against Property', 'Business Loan', 'Working Capital (CC/OD)', 'Personal Loan', 'Vehicle Loan', 'Education Loan', 'Gold Loan', 'Loan Protection Insurance', 'Credit Health / CIBIL Advisory', 'ITR Filing', 'GST Registration & Filing', 'MSME / Udyam Registration', 'All products'];

    var PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
    var MOBILE_RE = /^[6-9][0-9]{9}$/;
    var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    var PIN_RE = /^[0-9]{6}$/;
    var GST_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
    var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    /* ------------------------------------------------------------------ *
     * Small helpers
     * ------------------------------------------------------------------ */

    function el(id) { return document.getElementById(id); }

    function value(id) {
        var field = el(id);
        return field ? String(field.value || '').trim() : '';
    }

    function checked(id) {
        var field = el(id);
        return !!(field && field.checked);
    }

    function numOrNull(raw) {
        var text = String(raw === null || raw === undefined ? '' : raw).trim();
        if (text === '') { return null; }
        var number = Number(text);
        return isNaN(number) ? null : number;
    }

    function todayIso() {
        var now = new Date();
        var month = String(now.getMonth() + 1);
        var day = String(now.getDate());
        if (month.length < 2) { month = '0' + month; }
        if (day.length < 2) { day = '0' + day; }
        return now.getFullYear() + '-' + month + '-' + day;
    }

    function addIfUnique(list, item) {
        if (list.indexOf(item) === -1) { list.push(item); }
    }

    function setSelectValue(id, next) {
        var select = el(id);
        if (!select) { return; }
        var text = next === null || next === undefined ? '' : String(next);
        select.value = text;
        if (text && select.value !== text) {
            var option = document.createElement('option');
            option.value = text;
            option.textContent = text;
            select.appendChild(option);
            select.value = text;
        }
    }

    function maskPan(pan) {
        var text = String(pan || '').toUpperCase();
        if (!text) { return ''; }
        if (text.length <= 4) { return '****'; }
        return text.slice(0, 2) + '******' + text.slice(-2);
    }

    /* ------------------------------------------------------------------ *
     * Static options and conditional behaviour
     * ------------------------------------------------------------------ */

    function fillStateSelect(id) {
        var select = el(id);
        if (!select) { return; }
        select.innerHTML = '<option value="">Select state</option>' + STATES.map(function (state) {
            return '<option value="' + D.escapeHtml(state) + '">' + D.escapeHtml(state) + '</option>';
        }).join('');
    }

    function initOptions() {
        fillStateSelect('partnerState');
        fillStateSelect('partnerOfficeState');
    }

    function syncRegistration() {
        var type = value('partnerRegistrationType');
        var registered = type !== '' && type !== 'Not registered';
        var block = el('partnerRegistrationNumberBlock');
        if (block) { block.classList.toggle('cp-hidden', !registered); }
        if (!registered && el('partnerRegistrationNumber')) {
            el('partnerRegistrationNumber').value = '';
        }
    }

    /* ------------------------------------------------------------------ *
     * Document checklist
     * ------------------------------------------------------------------ */

    function buildChecklist() {
        var registrationType = value('partnerRegistrationType');
        var gst = value('partnerGst').toUpperCase();
        var registered = registrationType !== '' && registrationType !== 'Not registered';

        var identity = ['PAN Card', 'Address Proof', 'Photograph'];
        var business = [];
        if (registered) { addIfUnique(business, 'Business Registration'); }
        addIfUnique(business, 'Business Proof');
        if (gst) { addIfUnique(business, 'GST Certificate'); }
        if (registrationType === 'Partnership' || registrationType === 'LLP') {
            addIfUnique(business, 'Partnership Deed');
        }
        if (registrationType === 'Private Limited' || registrationType === 'Public Limited') {
            addIfUnique(business, 'Certificate of Incorporation');
        }
        if (registered) { addIfUnique(business, 'Authorisation Letter'); }
        addIfUnique(business, 'Bank Proof');

        var onboarding = ['Onboarding Document', 'Other'];

        return [
            { title: 'Identity & KYC', items: identity },
            { title: 'Business & registration', items: business },
            { title: 'Onboarding', items: onboarding }
        ].filter(function (group) { return group.items.length > 0; });
    }

    function renderChecklist() {
        if (!checklistBox) { return; }
        checklistBox.innerHTML = buildChecklist().map(function (group) {
            return '<div class="cp-checklist-group">' +
                '<h4>' + D.escapeHtml(group.title) + '</h4>' +
                group.items.map(function (item) {
                    return '<div class="cp-check-item"><i class="fa fa-check-circle"></i><span>' +
                        D.escapeHtml(item) + '</span></div>';
                }).join('') +
                '</div>';
        }).join('');
    }

    /* ------------------------------------------------------------------ *
     * Payload
     * ------------------------------------------------------------------ */

    function selectedProducts() {
        var inputs = form.querySelectorAll('input[name="partnerProducts"]:checked');
        return Array.prototype.map.call(inputs, function (input) { return input.value; });
    }

    function buildPayload() {
        return {
            personal: {
                full_name: value('partnerFullName'),
                mobile: D.digits(value('partnerMobile')),
                email: value('partnerEmail'),
                city: value('partnerCity'),
                state: value('partnerState'),
                pan_number: value('partnerPan').toUpperCase()
            },
            business: {
                firm_name: value('partnerFirmName'),
                partner_type: value('partnerType'),
                office_address: value('partnerOfficeAddress'),
                office_city: value('partnerOfficeCity'),
                office_state: value('partnerOfficeState'),
                office_pincode: D.digits(value('partnerOfficePincode')),
                business_registration_type: value('partnerRegistrationType'),
                business_registration_number: value('partnerRegistrationNumber'),
                gst_number: value('partnerGst').toUpperCase(),
                years_experience: numOrNull(value('partnerYearsExperience')),
                financial_services_experience: value('partnerFinancialExperience'),
                existing_dsa_associations: value('partnerExistingDsa'),
                bank_associations: value('partnerBankAssociations')
            },
            network: {
                products: selectedProducts(),
                expected_leads_per_month: numOrNull(value('partnerExpectedLeads')),
                preferred_locations: value('partnerPreferredLocations'),
                referral_source: value('partnerReferralSource'),
                additional_notes: value('partnerAdditionalNotes')
            },
            declarations: {
                accuracy: checked('partnerAccuracyDeclaration'),
                commission_terms: checked('partnerCommissionDeclaration'),
                no_guarantee: checked('partnerNoGuaranteeDeclaration')
            },
            consent: checked('partnerApplicationConsent'),
            consent_version: CONSENT_VERSION,
            source_page: 'partner-apply.html'
        };
    }

    function draftSafePayload() {
        var payload = buildPayload();
        if (payload.personal) { payload.personal.pan_number = ''; }
        if (payload.business) { payload.business.business_registration_number = ''; }
        return payload;
    }

    /* ------------------------------------------------------------------ *
     * Review
     * ------------------------------------------------------------------ */

    function reviewRow(label, shown) {
        var text = (shown === null || shown === undefined || shown === '') ? '\u2014' : shown;
        return '<div class="cp-review-row"><span>' + D.escapeHtml(label) + '</span><span>' +
            D.escapeHtml(String(text)) + '</span></div>';
    }

    function renderReview() {
        var payload = buildPayload();
        var personal = payload.personal;
        var business = payload.business;
        var network = payload.network;
        var blocks = [];

        blocks.push({
            step: 0,
            title: 'Applicant & contact',
            rows: [
                reviewRow('Full name', personal.full_name),
                reviewRow('Mobile', personal.mobile),
                reviewRow('Email', personal.email),
                reviewRow('City', personal.city),
                reviewRow('State', personal.state),
                reviewRow('PAN', maskPan(personal.pan_number))
            ]
        });

        blocks.push({
            step: 1,
            title: 'Business & experience',
            rows: [
                reviewRow('Firm name', business.firm_name),
                reviewRow('Partner type', business.partner_type),
                reviewRow('Office address', [business.office_address, business.office_city, business.office_state, business.office_pincode].filter(Boolean).join(', ')),
                reviewRow('Business registration', business.business_registration_type),
                reviewRow('Registration number', business.business_registration_number),
                reviewRow('GSTIN', business.gst_number),
                reviewRow('Years of experience', business.years_experience),
                reviewRow('Financial services experience', business.financial_services_experience),
                reviewRow('Existing DSA / bank associations', business.existing_dsa_associations),
                reviewRow('Bank / NBFC relationships', business.bank_associations)
            ]
        });

        blocks.push({
            step: 2,
            title: 'Products & expected referrals',
            rows: [
                reviewRow('Products', network.products.join(', ')),
                reviewRow('Expected referrals per month', network.expected_leads_per_month),
                reviewRow('Preferred locations', network.preferred_locations),
                reviewRow('Referral source', network.referral_source),
                reviewRow('Additional notes', network.additional_notes)
            ]
        });

        blocks.push({
            step: 3,
            title: 'Document checklist',
            rows: buildChecklist().map(function (group) {
                return reviewRow(group.title, group.items.join(', '));
            })
        });

        reviewBox.innerHTML =
            '<div class="cp-info-box"><strong>This is an onboarding application</strong><p>Submitting this form does not approve you as a partner, appoint you as an agent, assign any lead, create an agreement or provision a login. Approval, document verification, agreement signing and login provisioning are separate steps. No lead volume, loan approval, disbursal or commission is guaranteed.</p></div>' +
            blocks.map(function (block) {
                return '<div class="cp-review-block">' +
                    '<h4><span>' + D.escapeHtml(block.title) + '</span>' +
                    '<button type="button" data-goto="' + block.step + '">Edit</button></h4>' +
                    block.rows.join('') +
                    '</div>';
            }).join('');
    }

    reviewBox.addEventListener('click', function (event) {
        var button = event.target.closest('button[data-goto]');
        if (!button) { return; }
        var index = Number(button.getAttribute('data-goto'));
        if (!isNaN(index)) { showStep(index, true); }
    });

    /* ------------------------------------------------------------------ *
     * Validation
     * ------------------------------------------------------------------ */

    function requireField(id, message) {
        var field = el(id);
        if (!field || !String(field.value || '').trim()) {
            D.setFieldError(field, message);
            return false;
        }
        return true;
    }

    function validateStep(index) {
        var ok = true;

        if (index === 0) {
            if (!requireField('partnerFullName', 'Enter the applicant name.')) { ok = false; }
            if (!MOBILE_RE.test(D.digits(value('partnerMobile')))) {
                D.setFieldError(el('partnerMobile'), 'Enter a valid 10-digit Indian mobile number.');
                ok = false;
            }
            if (!EMAIL_RE.test(value('partnerEmail'))) {
                D.setFieldError(el('partnerEmail'), 'Enter a valid email address.');
                ok = false;
            }
            if (!requireField('partnerCity', 'Enter the city or town.')) { ok = false; }
            if (!requireField('partnerState', 'Select the state.')) { ok = false; }
            var pan = value('partnerPan').toUpperCase();
            if (!pan) {
                D.setFieldError(el('partnerPan'), 'Enter the PAN.');
                ok = false;
            } else if (!PAN_RE.test(pan)) {
                D.setFieldError(el('partnerPan'), 'Enter a valid PAN (e.g. ABCDE1234F).');
                ok = false;
            }
        }

        if (index === 1) {
            if (!requireField('partnerFirmName', 'Enter the business or firm name.')) { ok = false; }
            if (!requireField('partnerType', 'Select the partner type.')) { ok = false; }
            if (!requireField('partnerOfficeAddress', 'Enter the office address.')) { ok = false; }
            if (!requireField('partnerOfficeCity', 'Enter the office city or town.')) { ok = false; }
            if (!requireField('partnerOfficeState', 'Select the office state.')) { ok = false; }
            if (!PIN_RE.test(D.digits(value('partnerOfficePincode')))) {
                D.setFieldError(el('partnerOfficePincode'), 'Enter a valid 6-digit office PIN code.');
                ok = false;
            }
            if (!requireField('partnerRegistrationType', 'Select the business registration type.')) {
                ok = false;
            } else if (value('partnerRegistrationType') !== 'Not registered') {
                if (!requireField('partnerRegistrationNumber', 'Enter the business registration number.')) { ok = false; }
            }
            var gst = value('partnerGst').toUpperCase();
            if (gst && !GST_RE.test(gst)) {
                D.setFieldError(el('partnerGst'), 'Enter a valid 15-character GSTIN or leave it blank.');
                ok = false;
            }
            var years = value('partnerYearsExperience');
            if (years === '' || isNaN(Number(years)) || Math.floor(Number(years)) !== Number(years) ||
                Number(years) < 0 || Number(years) > 60) {
                D.setFieldError(el('partnerYearsExperience'), 'Enter a whole number of years between 0 and 60.');
                ok = false;
            }
            if (!requireField('partnerFinancialExperience', 'Select the financial services experience.')) { ok = false; }
        }

        if (index === 2) {
            var products = selectedProducts();
            if (!products.length) {
                D.showAlert(alertBox, 'warning', 'Select at least one product you want to refer.', 'Product required');
                var firstProduct = form.querySelector('input[name="partnerProducts"]');
                if (firstProduct) { firstProduct.focus(); }
                ok = false;
            }
            var leads = value('partnerExpectedLeads');
            if (leads === '' || isNaN(Number(leads)) || Math.floor(Number(leads)) !== Number(leads) ||
                Number(leads) < 0 || Number(leads) > 1000) {
                D.setFieldError(el('partnerExpectedLeads'), 'Enter a whole number between 0 and 1000.');
                ok = false;
            }
        }

        return ok;
    }

    function focusFirstError() {
        var first = form.querySelector('.is-invalid');
        if (first) {
            first.scrollIntoView({ behavior: 'smooth', block: 'center' });
            try { first.focus({ preventScroll: true }); } catch (err) { first.focus(); }
        }
    }

    /* ------------------------------------------------------------------ *
     * Step navigation
     * ------------------------------------------------------------------ */

    function renderStepper() {
        Array.prototype.forEach.call(stepper.querySelectorAll('.cp-stepper-item'), function (item, index) {
            item.classList.toggle('is-active', index === current);
            item.classList.toggle('is-complete', index < current || (index <= maxStep && index !== current));
        });
    }

    function showStep(index, scroll) {
        current = Math.max(0, Math.min(TOTAL_STEPS - 1, index));
        maxStep = Math.max(maxStep, current);
        steps.forEach(function (step, stepIndex) {
            step.classList.toggle('is-active', stepIndex === current);
        });
        renderStepper();
        prevBtn.classList.toggle('cp-hidden', current === 0);
        nextBtn.classList.toggle('cp-hidden', current === TOTAL_STEPS - 1);
        submitBtn.classList.toggle('cp-hidden', current !== TOTAL_STEPS - 1);
        progressText.textContent = 'Step ' + (current + 1) + ' of ' + TOTAL_STEPS;

        if (current === 3) { renderChecklist(); }
        if (current === TOTAL_STEPS - 1) { renderReview(); }
        if (scroll) { form.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    }

    stepper.addEventListener('click', function (event) {
        var item = event.target.closest('.cp-stepper-item');
        if (!item) { return; }
        var index = Number(item.getAttribute('data-step'));
        if (index <= maxStep) { showStep(index, true); }
    });

    /* ------------------------------------------------------------------ *
     * Draft save / resume
     * ------------------------------------------------------------------ */

    function readStoredDraft() {
        try {
            var raw = window.localStorage.getItem(DRAFT_KEY);
            if (!raw) { return null; }
            var parsed = JSON.parse(raw);
            if (!parsed || !parsed.id || !parsed.token) { return null; }
            return parsed;
        } catch (err) {
            return null;
        }
    }

    function storeDraft(id, token) {
        try {
            window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ id: id, token: token, at: Date.now() }));
        } catch (err) { /* ignore quota / privacy errors */ }
    }

    function clearStoredDraft() {
        try { window.localStorage.removeItem(DRAFT_KEY); } catch (err) { /* ignore */ }
    }

    function resumeLink() {
        return window.location.origin + window.location.pathname + '#draft=' +
            encodeURIComponent(draftId) + '&token=' + encodeURIComponent(draftToken);
    }

    async function saveDraft() {
        var payload = draftSafePayload();
        var result = await D.rpc('save_home_loan_draft', {
            p_payload: payload,
            p_draft_id: draftId,
            p_draft_token: draftToken
        });
        if (result && result.draft_id) {
            draftId = result.draft_id;
            draftToken = result.draft_token;
            storeDraft(draftId, draftToken);
        }
        return result;
    }

    saveDraftBtn.addEventListener('click', async function () {
        D.hideAlert(alertBox);
        D.setLoading(saveDraftBtn, true, 'Saving\u2026');
        try {
            await saveDraft();
            if (draftBar) {
                draftBar.classList.remove('cp-hidden');
                draftBarText.innerHTML = 'Draft saved. Resume any time with this link: <code>' +
                    D.escapeHtml(resumeLink()) + '</code>. For your security, PAN and the business registration number are not stored in drafts; re-enter them when you resume.';
            }
            D.showAlert(alertBox, 'success',
                'Your partner application has been saved. Bookmark this page or keep the resume link to continue later. PAN and the business registration number are not stored in drafts and must be re-entered when you resume.',
                'Draft saved');
        } catch (err) {
            console.error('Partner draft save failed:', err);
            D.showAlert(alertBox, 'error', D.friendlyError(err), 'Draft not saved');
        } finally {
            D.setLoading(saveDraftBtn, false);
        }
    });

    async function loadDraft(id, token) {
        var result = await D.rpc('get_home_loan_draft', { p_draft_id: id, p_draft_token: token });
        if (!result || !result.payload) {
            throw new Error('This draft is no longer available.');
        }
        applyPayload(result.payload);
        draftId = result.draft_id;
        draftToken = result.draft_token;
        storeDraft(draftId, draftToken);
        if (draftBar) {
            draftBar.classList.remove('cp-hidden');
            draftBarText.innerHTML = 'Draft restored. Resume link: <code>' +
                D.escapeHtml(resumeLink()) + '</code>. PAN and the business registration number are not stored in drafts; please re-enter them.';
        }
    }

    function applyPayload(payload) {
        var personal = payload.personal || {};
        var business = payload.business || {};
        var network = payload.network || {};
        var declarations = payload.declarations || {};

        el('partnerFullName').value = personal.full_name || '';
        el('partnerMobile').value = personal.mobile || '';
        el('partnerEmail').value = personal.email || '';
        el('partnerCity').value = personal.city || '';
        setSelectValue('partnerState', personal.state || '');
        el('partnerPan').value = personal.pan_number || '';

        el('partnerFirmName').value = business.firm_name || '';
        el('partnerType').value = business.partner_type || '';
        el('partnerOfficeAddress').value = business.office_address || '';
        el('partnerOfficeCity').value = business.office_city || '';
        setSelectValue('partnerOfficeState', business.office_state || '');
        el('partnerOfficePincode').value = business.office_pincode || '';
        el('partnerRegistrationType').value = business.business_registration_type || '';
        el('partnerRegistrationNumber').value = business.business_registration_number || '';
        el('partnerGst').value = business.gst_number || '';
        el('partnerYearsExperience').value = business.years_experience !== null && business.years_experience !== undefined ? business.years_experience : 0;
        el('partnerFinancialExperience').value = business.financial_services_experience || '';
        el('partnerExistingDsa').value = business.existing_dsa_associations || '';
        el('partnerBankAssociations').value = business.bank_associations || '';

        var products = Array.isArray(network.products) ? network.products : [];
        Array.prototype.forEach.call(form.querySelectorAll('input[name="partnerProducts"]'), function (input) {
            input.checked = products.indexOf(input.value) !== -1;
        });
        el('partnerExpectedLeads').value = network.expected_leads_per_month !== null && network.expected_leads_per_month !== undefined ? network.expected_leads_per_month : 0;
        el('partnerPreferredLocations').value = network.preferred_locations || '';
        el('partnerReferralSource').value = network.referral_source || '';
        el('partnerAdditionalNotes').value = network.additional_notes || '';

        el('partnerAccuracyDeclaration').checked = !!declarations.accuracy;
        el('partnerCommissionDeclaration').checked = !!declarations.commission_terms;
        el('partnerNoGuaranteeDeclaration').checked = !!declarations.no_guarantee;
        el('partnerApplicationConsent').checked = !!payload.consent;

        syncRegistration();
        renderChecklist();
    }

    function parseHashDraft() {
        var hash = window.location.hash.replace(/^#/, '');
        if (!hash) { return null; }
        var params = new URLSearchParams(hash);
        var id = params.get('draft');
        var token = params.get('token');
        if (id && token && UUID_RE.test(id) && UUID_RE.test(token)) {
            return { id: id, token: token };
        }
        return null;
    }

    function discardDraft() {
        clearStoredDraft();
        draftId = null;
        draftToken = null;
        form.reset();
        if (draftBar) { draftBar.classList.add('cp-hidden'); }
        D.clearErrors(form);
        D.hideAlert(alertBox);
        maxStep = 0;
        syncRegistration();
        renderChecklist();
        showStep(0, true);
    }

    el('discardDraftBtn').addEventListener('click', function () {
        discardDraft();
        D.notify('info', 'Started fresh', 'Your saved draft has been discarded on this device.');
    });

    el('resumeDraftBtn').addEventListener('click', async function () {
        var stored = readStoredDraft();
        if (!stored) {
            D.notify('warning', 'Draft unavailable', 'There is no draft saved on this device.');
            return;
        }
        D.setLoading(el('resumeDraftBtn'), true, 'Loading\u2026');
        try {
            await loadDraft(stored.id, stored.token);
            showStep(0, true);
            D.notify('success', 'Draft restored', 'Your previously saved answers have been loaded.');
        } catch (err) {
            clearStoredDraft();
            D.notify('error', 'Draft could not be loaded', D.friendlyError(err));
        } finally {
            D.setLoading(el('resumeDraftBtn'), false);
        }
    });

    async function initDraft() {
        var fromHash = parseHashDraft();
        if (fromHash) {
            try {
                await loadDraft(fromHash.id, fromHash.token);
                D.notify('success', 'Draft restored', 'Your saved partner application has been loaded.');
                return;
            } catch (err) {
                console.warn('Failed to resume partner draft from link:', err);
                D.showAlert(alertBox, 'warning',
                    'The resume link could not be loaded. ' + D.friendlyError(err),
                    'Draft unavailable');
            }
        }
        if (readStoredDraft() && draftBar) {
            draftBar.classList.remove('cp-hidden');
            draftBarText.textContent = 'We found a saved draft of your partner application on this device.';
        }
    }

    /* ------------------------------------------------------------------ *
     * Step buttons
     * ------------------------------------------------------------------ */

    nextBtn.addEventListener('click', function () {
        D.hideAlert(alertBox);
        D.clearErrors(steps[current]);
        if (!validateStep(current)) {
            focusFirstError();
            return;
        }
        saveDraft().catch(function (err) {
            console.warn('Background partner draft save failed:', err);
        });
        showStep(current + 1, true);
    });

    prevBtn.addEventListener('click', function () {
        D.hideAlert(alertBox);
        if (current === 0) { return; }
        showStep(current - 1, true);
    });

    /* ------------------------------------------------------------------ *
     * Submit
     * ------------------------------------------------------------------ */

    form.addEventListener('submit', async function (event) {
        event.preventDefault();
        D.hideAlert(alertBox);
        D.clearErrors(form);

        for (var i = 0; i < TOTAL_STEPS - 1; i += 1) {
            if (!validateStep(i)) {
                showStep(i, true);
                focusFirstError();
                return;
            }
        }

        if (!checked('partnerAccuracyDeclaration')) {
            D.showAlert(alertBox, 'warning',
                'Please confirm that the information and documents provided are true and complete, and authorise the verification checks.',
                'Declaration required');
            el('partnerAccuracyDeclaration').focus();
            return;
        }
        if (!checked('partnerCommissionDeclaration')) {
            D.showAlert(alertBox, 'warning',
                'Please confirm that you understand commission is governed by the signed agreement and actual disbursal.',
                'Commission declaration required');
            el('partnerCommissionDeclaration').focus();
            return;
        }
        if (!checked('partnerNoGuaranteeDeclaration')) {
            D.showAlert(alertBox, 'warning',
                'Please confirm that you understand no lead volume, loan approval, disbursal or commission is guaranteed.',
                'No-guarantee confirmation required');
            el('partnerNoGuaranteeDeclaration').focus();
            return;
        }
        if (!checked('partnerApplicationConsent')) {
            D.showAlert(alertBox, 'warning',
                'Please accept the privacy notice and partner application consent before submitting.',
                'Consent required');
            el('partnerApplicationConsent').focus();
            return;
        }

        var payload = buildPayload();
        D.setLoading(submitBtn, true, 'Submitting application\u2026');
        try {
            var result = await D.rpc('submit_partner_application', {
                p_payload: payload,
                p_draft_id: draftId,
                p_draft_token: draftToken
            });
            clearStoredDraft();
            showSuccess(result);
        } catch (err) {
            console.error('Partner submission failed:', err);
            D.showAlert(alertBox, 'error', D.friendlyError(err), 'Application not submitted');
        } finally {
            D.setLoading(submitBtn, false);
        }
    });

    function showSuccess(result) {
        form.classList.add('cp-hidden');
        if (draftBar) { draftBar.classList.add('cp-hidden'); }
        successBox.classList.add('show');
        el('successReference').textContent = result.reference_no || '\u2014';
        var link = el('uploadDocsLink');
        if (link) {
            link.href = 'upload-documents.html#id=' + encodeURIComponent(result.id) +
                '&token=' + encodeURIComponent(result.access_token) +
                '&ref=' + encodeURIComponent(result.reference_no);
        }
        D.showAlert(alertBox, 'success',
            'Your partner application has been received. Reference: ' +
            (result.reference_no || '\u2014') + '. This is not an approval or a partner appointment, and no lead volume or commission is guaranteed.',
            'Application submitted');
        successBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    el('resetFormBtn').addEventListener('click', function () {
        discardDraft();
        successBox.classList.remove('show');
        form.classList.remove('cp-hidden');
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    /* ------------------------------------------------------------------ *
     * Live bindings
     * ------------------------------------------------------------------ */

    form.addEventListener('input', function (event) {
        if (event.target.classList.contains('form-control')) {
            D.clearFieldError(event.target);
        }
        if (event.target.id === 'partnerPan') {
            event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
        }
        if (event.target.id === 'partnerGst') {
            event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 15);
        }
        if (event.target.id === 'partnerMobile') {
            event.target.value = D.digits(event.target.value).slice(0, 10);
        }
        if (event.target.id === 'partnerOfficePincode') {
            event.target.value = D.digits(event.target.value).slice(0, 6);
        }
    });

    form.addEventListener('change', function (event) {
        if (event.target.classList.contains('form-control')) {
            D.clearFieldError(event.target);
        }
        if (event.target.id === 'partnerRegistrationType') {
            syncRegistration();
            renderChecklist();
        }
        if (event.target.id === 'partnerGst') {
            renderChecklist();
        }
    });

    /* ------------------------------------------------------------------ *
     * Boot
     * ------------------------------------------------------------------ */

    function boot() {
        initOptions();
        syncRegistration();
        renderChecklist();
        showStep(0, false);
        initDraft();
    }

    boot();
})(window, document);

/**
 * Dhanvi Finserv - multi-step MSME / Udyam & Gumasta assistance wizard.
 *
 * Depends on: js/nhost-client.js, js/public-api.js
 *
 * Flow
 *   1    applicant / authorised person, PAN, Aadhaar reference, address
 *   2    business name, constitution, activity, NIC, commencement, addresses
 *   3    investment, turnover, employees, GSTIN and indicative classification
 *   4    service type and conditional Udyam update / Gumasta / business
 *        registration fields
 *   5    proprietor / partner / director details (repeatable)
 *   6    conditional document checklist
 *   7    review and mandatory declarations / consent
 *
 * Save / resume
 *   A server-side draft is created through save_home_loan_draft() (shared with
 *   the other application wizards) as soon as the first step validates, and
 *   refreshed on every step change. The draft id + secret token are kept in
 *   localStorage so the applicant can resume in the same browser, and
 *   "Save & continue later" also shows a resume link. Submitting promotes the
 *   draft into a real MSME assistance request through submit_msme_application().
 *
 * IMPORTANT
 *   Submitting this wizard does NOT register an enterprise, update Udyam or
 *   issue a Gumasta / Shop & Establishment licence. The submission status is
 *   controlled by the administrator and can only be set to "Approved &
 *   Verified" after the actual government portal action and certificate /
 *   acknowledgement verification.
 */
(function (window, document) {
    'use strict';

    var D = window.Dhanvi;
    var form = document.getElementById('msmeApplicationForm');
    if (!form || !D) { return; }

    var DRAFT_KEY = 'dhanviMsmeDraft';
    var TOTAL_STEPS = 7;

    var alertBox = document.getElementById('applicationAlert');
    var draftBar = document.getElementById('draftBar');
    var draftBarText = document.getElementById('draftBarText');
    var successBox = document.getElementById('applicationSuccess');
    var stepper = document.getElementById('msmeStepper');
    var steps = Array.prototype.slice.call(form.querySelectorAll('.cp-step'));
    var prevBtn = document.getElementById('prevBtn');
    var nextBtn = document.getElementById('nextBtn');
    var submitBtn = document.getElementById('submitBtn');
    var saveDraftBtn = document.getElementById('saveDraftBtn');
    var progressText = document.getElementById('progressText');
    var promoterContainer = document.getElementById('msmePromoters');

    var current = 0;
    var maxStep = 0;
    var draftId = null;
    var draftToken = null;

    var STATES = ['Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry'];
    var PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
    var GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
    var UDYAM_RE = /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/;
    var MOBILE_RE = /^[6-9][0-9]{9}$/;
    var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    var PIN_RE = /^[0-9]{6}$/;
    var PROMOTER_DESIGNATIONS = ['Proprietor', 'Partner', 'Designated Partner', 'Director', 'Karta', 'Trustee', 'Authorised Signatory', 'Other'];
    var MAX_PROMOTERS = 10;

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

    function money(amount) {
        var number = Number(amount);
        if (isNaN(number)) { return '\u2014'; }
        return '\u20B9' + number.toLocaleString('en-IN');
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

    function fullAddress(line, city, district, state, pincode) {
        return [line, city, district, state, pincode].filter(Boolean).join(', ');
    }

    function optionList(options, selected) {
        return options.map(function (option) {
            return '<option value="' + D.escapeHtml(option) + '"' +
                (option === selected ? ' selected' : '') + '>' +
                D.escapeHtml(option) + '</option>';
        }).join('');
    }

    /* ------------------------------------------------------------------ *
     * Static options
     * ------------------------------------------------------------------ */

    function stateOptions() {
        return '<option value="">Select state</option>' + STATES.map(function (state) {
            return '<option value="' + D.escapeHtml(state) + '">' + D.escapeHtml(state) + '</option>';
        }).join('');
    }

    function initOptions() {
        ['msmeAddressState', 'msmeBusinessAddressState', 'msmeBusinessRegistrationState'].forEach(function (id) {
            var select = el(id);
            if (select) { select.innerHTML = stateOptions(); }
        });
    }

    /* ------------------------------------------------------------------ *
     * Conditional behaviour
     * ------------------------------------------------------------------ */

    function syncBusinessAddress() {
        var same = checked('msmeBusinessSameAsApplicant');
        var block = el('msmeBusinessAddressBlock');
        if (block) { block.classList.toggle('cp-hidden', same); }
    }

    function syncLandlord() {
        var ownership = value('msmeGumastaPremisesOwnership');
        var required = ownership === 'Rented' || ownership === 'Leased';
        ['msmeLandlordBlock', 'msmeLandlordMobileBlock'].forEach(function (id) {
            var block = el(id);
            if (block) { block.classList.toggle('cp-hidden', !required); }
        });
        if (!required) {
            if (el('msmeGumastaLandlordName')) { el('msmeGumastaLandlordName').value = ''; }
            if (el('msmeGumastaLandlordMobile')) { el('msmeGumastaLandlordMobile').value = ''; }
        }
    }

    function syncServiceBlocks() {
        var service = value('msmeServiceType');
        var update = service === 'Udyam Update / Amendment';
        var gumasta = service === 'Gumasta / Shop & Establishment' ||
            service === 'Udyam & Gumasta Package';
        var businessRegistration = service === 'Business Registration Assistance';

        el('msmeUdyamUpdateBlock').classList.toggle('cp-hidden', !update);
        el('msmeGumastaBlock').classList.toggle('cp-hidden', !gumasta);
        el('msmeBusinessRegistrationBlock').classList.toggle('cp-hidden', !businessRegistration);

        if (!update) {
            if (el('msmeExistingUdyam')) { el('msmeExistingUdyam').value = ''; }
            if (el('msmeUdyamUpdateReason')) { el('msmeUdyamUpdateReason').value = ''; }
            if (el('msmeUdyamUpdateDetails')) { el('msmeUdyamUpdateDetails').value = ''; }
        }
        if (!gumasta) {
            ['msmeExistingShopNumber', 'msmeGumastaEstablishmentType',
             'msmeGumastaPremisesOwnership', 'msmeGumastaLandlordName',
             'msmeGumastaLandlordMobile'].forEach(function (id) {
                if (el(id)) { el(id).value = ''; }
            });
        }
        if (!businessRegistration) {
            ['msmeBusinessRegistrationType', 'msmeBusinessRegistrationState',
             'msmeBusinessRegistrationDetails'].forEach(function (id) {
                if (el(id)) { el(id).value = ''; }
            });
        }
        syncLandlord();
    }

    function indicativeCategory(investment, turnover) {
        if (investment === null || turnover === null) { return null; }
        var crore = 10000000;
        if (investment <= 2.5 * crore && turnover <= 10 * crore) { return 'Micro'; }
        if (investment <= 25 * crore && turnover <= 100 * crore) { return 'Small'; }
        if (investment <= 125 * crore && turnover <= 500 * crore) { return 'Medium'; }
        return 'Above the Medium thresholds';
    }

    function updateEnterpriseEstimate() {
        var box = el('msmeEnterpriseEstimate');
        if (!box) { return; }
        var investment = numOrNull(value('msmePlantInvestment'));
        var turnover = numOrNull(value('msmeAnnualTurnover'));
        var category = indicativeCategory(investment, turnover);
        var message;
        if (category === null) {
            message = 'Enter the plant and machinery investment and annual turnover to see an indicative classification. The final Micro, Small or Medium category is determined by the Udyam portal.';
        } else if (category === 'Above the Medium thresholds') {
            message = 'Based on the figures entered, the enterprise is above the usual Medium thresholds. We will review the applicable category and eligibility before applying. This is not a final classification.';
        } else {
            message = 'Indicative category: ' + category + '. This is based only on the investment and turnover entered. The final Micro, Small or Medium category is determined by the Udyam portal on the basis of the prescribed criteria and your verified records.';
        }
        box.innerHTML = '<strong>Indicative enterprise category</strong><p>' + D.escapeHtml(message) + '</p>';
    }

    /* ------------------------------------------------------------------ *
     * Promoters / partners / directors
     * ------------------------------------------------------------------ */

    function promoterRowHtml(data) {
        var d = data || {};
        return '<div class="cp-promoter-row" style="border:1px solid #e3e8ef;border-radius:10px;padding:18px;margin-bottom:16px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap;">' +
                '<h4 class="cp-promoter-title" style="margin:0;font-size:16px;">Promoter 1 <span class="cp-promoter-primary" style="font-size:11px;color:#15549a;font-weight:600;text-transform:uppercase;letter-spacing:.04em;">Primary</span></h4>' +
                '<button type="button" class="cp-btn cp-btn-outline cp-btn-sm remove-promoter"><i class="fa fa-trash-o"></i> Remove</button>' +
            '</div>' +
            '<div class="cp-grid">' +
                '<div class="cp-col-4"><div class="cp-field"><label>Full name <span class="cp-req">*</span></label>' +
                    '<input type="text" class="form-control promoter-name" data-field="full_name" autocomplete="name" value="' + D.escapeHtml(d.full_name || '') + '" placeholder="Full name as on PAN"></div></div>' +
                '<div class="cp-col-4"><div class="cp-field"><label>Designation <span class="cp-req">*</span></label>' +
                    '<select class="form-control promoter-designation" data-field="designation"><option value="">Select designation</option>' +
                    optionList(PROMOTER_DESIGNATIONS, d.designation || '') + '</select></div></div>' +
                '<div class="cp-col-4"><div class="cp-field"><label>PAN</label>' +
                    '<input type="text" class="form-control promoter-pan" data-field="pan_number" maxlength="10" style="text-transform:uppercase;" value="' + D.escapeHtml(d.pan_number || '') + '" placeholder="e.g. ABCDE1234F"></div></div>' +
                '<div class="cp-col-4"><div class="cp-field"><label>Aadhaar (optional)</label>' +
                    '<input type="text" class="form-control promoter-aadhaar" data-field="aadhaar_number" inputmode="numeric" maxlength="12" value="' + D.escapeHtml(d.aadhaar_number || '') + '" placeholder="12 digits"></div></div>' +
                '<div class="cp-col-4"><div class="cp-field"><label>DIN (directors only)</label>' +
                    '<input type="text" class="form-control promoter-din" data-field="din" maxlength="8" value="' + D.escapeHtml(d.din || '') + '" placeholder="8-digit DIN"></div></div>' +
                '<div class="cp-col-4"><div class="cp-field"><label>Shareholding (%)</label>' +
                    '<input type="number" class="form-control promoter-share" data-field="shareholding_percent" min="0" max="100" step="0.01" value="' + D.escapeHtml(d.shareholding_percent !== null && d.shareholding_percent !== undefined ? d.shareholding_percent : '') + '" placeholder="Optional"></div></div>' +
                '<div class="cp-col-4"><div class="cp-field"><label>Mobile</label>' +
                    '<input type="tel" class="form-control promoter-mobile" data-field="mobile" inputmode="numeric" maxlength="10" value="' + D.escapeHtml(d.mobile || '') + '" placeholder="10-digit mobile"></div></div>' +
                '<div class="cp-col-4"><div class="cp-field"><label>Email</label>' +
                    '<input type="email" class="form-control promoter-email" data-field="email" value="' + D.escapeHtml(d.email || '') + '" placeholder="Optional"></div></div>' +
            '</div>' +
        '</div>';
    }

    function refreshPromoters() {
        var rows = Array.prototype.slice.call(promoterContainer.querySelectorAll('.cp-promoter-row'));
        rows.forEach(function (row, index) {
            var title = row.querySelector('.cp-promoter-title');
            var badge = row.querySelector('.cp-promoter-primary');
            if (title) {
                title.innerHTML = 'Promoter ' + (index + 1) +
                    (index === 0
                        ? ' <span class="cp-promoter-primary" style="font-size:11px;color:#15549a;font-weight:600;text-transform:uppercase;letter-spacing:.04em;">Primary</span>'
                        : '');
            }
            if (badge && index !== 0) { badge.remove(); }
        });
        var addBtn = el('addPromoterBtn');
        if (addBtn) { addBtn.classList.toggle('cp-hidden', rows.length >= MAX_PROMOTERS); }
    }

    function addPromoterRow(data) {
        var rows = promoterContainer.querySelectorAll('.cp-promoter-row');
        if (rows.length >= MAX_PROMOTERS) {
            D.notify('info', 'Limit reached', 'You can add up to ' + MAX_PROMOTERS + ' promoters, partners or directors.');
            return;
        }
        promoterContainer.insertAdjacentHTML('beforeend', promoterRowHtml(data || {}));
        refreshPromoters();
    }

    function renderPromoters(list) {
        promoterContainer.innerHTML = '';
        if (Array.isArray(list) && list.length) {
            list.slice(0, MAX_PROMOTERS).forEach(function (item) {
                promoterContainer.insertAdjacentHTML('beforeend', promoterRowHtml(item || {}));
            });
        } else {
            promoterContainer.insertAdjacentHTML('beforeend', promoterRowHtml({}));
        }
        refreshPromoters();
    }

    function getPromoterRows() {
        return Array.prototype.slice.call(promoterContainer.querySelectorAll('.cp-promoter-row')).map(function (row) {
            function field(name) {
                var input = row.querySelector('[data-field="' + name + '"]');
                return input ? String(input.value || '').trim() : '';
            }
            return {
                full_name: field('full_name'),
                designation: field('designation'),
                pan_number: field('pan_number').toUpperCase(),
                aadhaar_number: D.digits(field('aadhaar_number')),
                din: field('din'),
                mobile: D.digits(field('mobile')),
                email: field('email'),
                shareholding_percent: numOrNull(field('shareholding_percent'))
            };
        });
    }

    function syncPrimaryPromoterFromApplicant() {
        var first = promoterContainer.querySelector('.cp-promoter-row');
        if (!first) { return; }
        var nameInput = first.querySelector('[data-field="full_name"]');
        var designationInput = first.querySelector('[data-field="designation"]');
        if (nameInput && !nameInput.value.trim() && value('msmeApplicantName')) {
            nameInput.value = value('msmeApplicantName');
        }
        if (designationInput && !designationInput.value && value('msmeDesignation')) {
            var match = PROMOTER_DESIGNATIONS.filter(function (item) {
                return item.toLowerCase() === value('msmeDesignation').toLowerCase();
            })[0];
            if (match) { designationInput.value = match; }
        }
    }

    function validatePromoters() {
        var rows = Array.prototype.slice.call(promoterContainer.querySelectorAll('.cp-promoter-row'));
        var ok = true;
        if (!rows.length) {
            D.showAlert(alertBox, 'warning', 'Add at least one proprietor, partner or director.', 'Promoter required');
            return false;
        }

        rows.forEach(function (row, index) {
            function field(name) { return row.querySelector('[data-field="' + name + '"]'); }
            var nameInput = field('full_name');
            var designationInput = field('designation');
            var panInput = field('pan_number');
            var aadhaarInput = field('aadhaar_number');
            var dinInput = field('din');
            var mobileInput = field('mobile');
            var emailInput = field('email');
            var shareInput = field('shareholding_percent');

            if (!nameInput.value.trim()) {
                D.setFieldError(nameInput, 'Enter the full name for promoter ' + (index + 1) + '.');
                ok = false;
            }
            if (!designationInput.value) {
                D.setFieldError(designationInput, 'Select the designation for promoter ' + (index + 1) + '.');
                ok = false;
            }
            var pan = panInput.value.trim().toUpperCase();
            if (pan && !PAN_RE.test(pan)) {
                D.setFieldError(panInput, 'Enter a valid PAN (e.g. ABCDE1234F).');
                ok = false;
            }
            var aadhaar = D.digits(aadhaarInput.value);
            if (aadhaar && aadhaar.length !== 12) {
                D.setFieldError(aadhaarInput, 'Enter a valid 12-digit Aadhaar number.');
                ok = false;
            }
            var din = dinInput.value.trim();
            if (din && !/^[0-9]{8}$/.test(din)) {
                D.setFieldError(dinInput, 'Enter a valid 8-digit DIN.');
                ok = false;
            }
            var mobile = D.digits(mobileInput.value);
            if (mobile && !MOBILE_RE.test(mobile)) {
                D.setFieldError(mobileInput, 'Enter a valid 10-digit mobile number.');
                ok = false;
            }
            var email = emailInput.value.trim();
            if (email && !EMAIL_RE.test(email)) {
                D.setFieldError(emailInput, 'Enter a valid email address.');
                ok = false;
            }
            var share = numOrNull(shareInput.value);
            if (share !== null && (share < 0 || share > 100)) {
                D.setFieldError(shareInput, 'Shareholding must be between 0 and 100 percent.');
                ok = false;
            }
        });

        return ok;
    }

    /* ------------------------------------------------------------------ *
     * Document checklist
     * ------------------------------------------------------------------ */

    function buildChecklist() {
        var service = value('msmeServiceType');
        var constitution = value('msmeConstitution');
        var ownership = value('msmeGumastaPremisesOwnership');
        var includesGumasta = service === 'Gumasta / Shop & Establishment' ||
            service === 'Udyam & Gumasta Package';
        var includesUdyam = service === 'New Udyam Registration' ||
            service === 'Udyam Update / Amendment' ||
            service === 'Udyam & Gumasta Package';

        var identity = ['PAN Card', 'Aadhaar Card', 'Photograph', 'Address Proof', 'Business Proof'];
        var registration = [];
        var premises = [];

        if (constitution === 'Private Limited Company' ||
            constitution === 'Public Limited Company' ||
            constitution === 'One Person Company') {
            addIfUnique(registration, 'Certificate of Incorporation');
            addIfUnique(registration, 'Board Resolution');
        }
        if (constitution === 'Partnership' || constitution === 'LLP') {
            addIfUnique(registration, 'Partnership Deed');
            addIfUnique(registration, 'Authorisation Letter');
        }
        if (constitution === 'Trust / Society') {
            addIfUnique(registration, 'Other');
        }
        if (service === 'Udyam Update / Amendment') {
            addIfUnique(registration, 'Udyam Certificate');
        }
        if (includesGumasta) {
            if (value('msmeExistingShopNumber')) {
                addIfUnique(registration, 'Shop & Establishment Certificate');
            }
            if (ownership === 'Rented' || ownership === 'Leased') {
                addIfUnique(premises, 'Rent Agreement / NOC');
                addIfUnique(premises, 'Electricity Bill');
            } else if (ownership === 'Owned') {
                addIfUnique(premises, 'Property Tax Receipt');
                addIfUnique(premises, 'Electricity Bill');
            } else {
                addIfUnique(premises, 'Address Proof');
            }
        }
        if (service === 'Business Registration Assistance') {
            addIfUnique(registration, 'Supporting Document');
        }
        if (value('msmeGstin')) {
            addIfUnique(registration, 'GST Certificate');
        }
        if (includesUdyam && service === 'New Udyam Registration') {
            addIfUnique(registration, 'Supporting Document');
        }

        var groups = [
            { title: 'Identity & business', items: identity },
            { title: 'Constitution & registration', items: registration },
            { title: 'Premises & supporting', items: premises }
        ];
        var seen = {};
        return groups.map(function (group) {
            return {
                title: group.title,
                items: group.items.filter(function (item) {
                    if (seen[item]) { return false; }
                    seen[item] = true;
                    return true;
                })
            };
        }).filter(function (group) { return group.items.length > 0; });
    }

    function renderChecklist() {
        var groups = buildChecklist();
        el('msmeDocChecklist').innerHTML = groups.map(function (group) {
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
        var address = payload.address;
        var business = payload.business;
        var service = payload.service;
        var promoters = payload.promoters;
        var blocks = [];

        blocks.push({
            step: 0,
            title: 'Applicant & address',
            rows: [
                reviewRow('Applicant', personal.applicant_name),
                reviewRow('Designation', personal.designation),
                reviewRow('Mobile', personal.mobile),
                reviewRow('Email', personal.email),
                reviewRow('PAN', personal.pan_number),
                reviewRow('Aadhaar', personal.aadhaar_number
                    ? 'XXXX XXXX ' + personal.aadhaar_number.slice(-4)
                    : 'Not provided'),
                reviewRow('Aadhaar verification', personal.aadhaar_verification_method),
                reviewRow('Address', fullAddress(address.line, address.city, address.district, address.state, address.pincode))
            ]
        });

        blocks.push({
            step: 1,
            title: 'Business profile',
            rows: [
                reviewRow('Legal business name', business.business_name),
                reviewRow('Trade name', business.trade_name),
                reviewRow('Constitution', business.constitution),
                reviewRow('Enterprise category', business.enterprise_category),
                reviewRow('Main activity', business.business_activity),
                reviewRow('NIC code', business.nic_code),
                reviewRow('NIC description', business.nic_description),
                reviewRow('Date of commencement', business.commencement_date),
                reviewRow('Business address', fullAddress(
                    business.business_address_line, business.business_address_city,
                    business.business_address_district, business.business_address_state,
                    business.business_address_pincode
                ))
            ]
        });

        blocks.push({
            step: 2,
            title: 'Enterprise classification',
            rows: [
                reviewRow('Plant & machinery investment', business.plant_machinery_investment !== null ? money(business.plant_machinery_investment) : '\u2014'),
                reviewRow('Annual turnover', business.annual_turnover !== null ? money(business.annual_turnover) : '\u2014'),
                reviewRow('Employees', business.employee_count !== null ? String(business.employee_count) : '\u2014'),
                reviewRow('Indicative category', indicativeCategory(
                    business.plant_machinery_investment, business.annual_turnover
                ) || 'Not enough information'),
                reviewRow('GSTIN', business.gstin),
                reviewRow('Other registrations', business.existing_registrations)
            ]
        });

        var serviceRows = [reviewRow('Service required', service.service_type)];
        if (service.service_type === 'Udyam Update / Amendment') {
            serviceRows.push(reviewRow('Existing Udyam number', service.existing_udyam_number));
            serviceRows.push(reviewRow('Update reason', service.udyam_update_reason));
            serviceRows.push(reviewRow('Update details', service.udyam_update_details));
        }
        if (service.service_type === 'Gumasta / Shop & Establishment' ||
            service.service_type === 'Udyam & Gumasta Package') {
            serviceRows.push(reviewRow('Existing Shop & Establishment number', service.existing_shop_number));
            serviceRows.push(reviewRow('Establishment type', service.gumasta_establishment_type));
            serviceRows.push(reviewRow('Premises ownership', service.gumasta_premises_ownership));
            serviceRows.push(reviewRow('Landlord / owner', service.gumasta_premises_landlord_name));
            serviceRows.push(reviewRow('Landlord mobile', service.gumasta_premises_landlord_mobile));
        }
        if (service.service_type === 'Business Registration Assistance') {
            serviceRows.push(reviewRow('Registration type', service.business_registration_type));
            serviceRows.push(reviewRow('State', service.business_registration_state));
            serviceRows.push(reviewRow('Assistance required', service.business_registration_details));
        }
        blocks.push({ step: 3, title: 'Service requirement', rows: serviceRows });

        var promoterRows = promoters.length
            ? promoters.map(function (promoter, index) {
                return reviewRow(
                    'Promoter ' + (index + 1),
                    [promoter.full_name, promoter.designation,
                     promoter.pan_number ? 'PAN ' + promoter.pan_number : '',
                     promoter.shareholding_percent !== null ? promoter.shareholding_percent + '%' : '']
                        .filter(Boolean).join(' \u00b7 ')
                );
            })
            : [reviewRow('Promoters', 'None added')];
        blocks.push({ step: 4, title: 'Proprietor, partner & director details', rows: promoterRows });

        var checklist = buildChecklist();
        blocks.push({
            step: 5,
            title: 'Document checklist',
            rows: checklist.map(function (group) {
                return reviewRow(group.title, group.items.join(', '));
            })
        });

        el('msmeReviewSummary').innerHTML =
            '<div class="cp-info-box"><strong>This is an assistance request</strong><p>Submitting this form does not register your enterprise, update Udyam, issue a Gumasta licence or complete any government registration. Those actions happen only after document verification, your approval and actual action on the relevant government portal.</p></div>' +
            blocks.map(function (block) {
                return '<div class="cp-review-block">' +
                    '<h4><span>' + D.escapeHtml(block.title) + '</span>' +
                    '<button type="button" data-goto="' + block.step + '">Edit</button></h4>' +
                    block.rows.join('') +
                    '</div>';
            }).join('');
    }

    el('msmeReviewSummary').addEventListener('click', function (event) {
        var button = event.target.closest('button[data-goto]');
        if (!button) { return; }
        var index = Number(button.getAttribute('data-goto'));
        if (!isNaN(index)) { showStep(index, true); }
    });

    /* ------------------------------------------------------------------ *
     * Payload
     * ------------------------------------------------------------------ */

    function buildPayload() {
        var sameAddress = checked('msmeBusinessSameAsApplicant');
        return {
            personal: {
                applicant_name: value('msmeApplicantName'),
                designation: value('msmeDesignation'),
                mobile: D.digits(value('msmeMobile')),
                email: value('msmeEmail'),
                pan_number: value('msmePan').toUpperCase(),
                aadhaar_number: D.digits(value('msmeAadhaar')),
                aadhaar_verification_method: value('msmeAadhaarMethod')
            },
            address: {
                line: value('msmeAddressLine'),
                city: value('msmeAddressCity'),
                district: value('msmeAddressDistrict'),
                state: value('msmeAddressState'),
                pincode: D.digits(value('msmeAddressPincode'))
            },
            business: {
                business_name: value('msmeBusinessName'),
                trade_name: value('msmeTradeName'),
                constitution: value('msmeConstitution'),
                enterprise_category: value('msmeEnterpriseCategory'),
                business_activity: value('msmeBusinessActivity'),
                nic_code: value('msmeNicCode'),
                nic_description: value('msmeNicDescription'),
                commencement_date: value('msmeCommencementDate'),
                employee_count: numOrNull(value('msmeEmployeeCount')),
                plant_machinery_investment: numOrNull(value('msmePlantInvestment')),
                annual_turnover: numOrNull(value('msmeAnnualTurnover')),
                gstin: value('msmeGstin').toUpperCase(),
                existing_registrations: value('msmeExistingRegistrations'),
                business_address_same_as_applicant: sameAddress,
                business_address_line: sameAddress ? value('msmeAddressLine') : value('msmeBusinessAddressLine'),
                business_address_city: sameAddress ? value('msmeAddressCity') : value('msmeBusinessAddressCity'),
                business_address_district: sameAddress ? value('msmeAddressDistrict') : value('msmeBusinessAddressDistrict'),
                business_address_state: sameAddress ? value('msmeAddressState') : value('msmeBusinessAddressState'),
                business_address_pincode: sameAddress ? D.digits(value('msmeAddressPincode')) : D.digits(value('msmeBusinessAddressPincode'))
            },
            service: {
                service_type: value('msmeServiceType'),
                existing_udyam_number: value('msmeExistingUdyam').toUpperCase(),
                udyam_update_reason: value('msmeUdyamUpdateReason'),
                udyam_update_details: value('msmeUdyamUpdateDetails'),
                existing_shop_number: value('msmeExistingShopNumber'),
                gumasta_establishment_type: value('msmeGumastaEstablishmentType'),
                gumasta_premises_ownership: value('msmeGumastaPremisesOwnership'),
                gumasta_premises_landlord_name: value('msmeGumastaLandlordName'),
                gumasta_premises_landlord_mobile: D.digits(value('msmeGumastaLandlordMobile')),
                business_registration_type: value('msmeBusinessRegistrationType'),
                business_registration_state: value('msmeBusinessRegistrationState'),
                business_registration_details: value('msmeBusinessRegistrationDetails')
            },
            promoters: getPromoterRows(),
            declarations: {
                accuracy: checked('msmeAccuracyDeclaration'),
                authorisation: checked('msmeAuthorisationDeclaration')
            },
            consent: checked('msmeApplicationConsent'),
            consent_version: '2026-11',
            source_page: 'msme-apply.html'
        };
    }

    function draftSafePayload() {
        var payload = buildPayload();
        if (payload.personal) { payload.personal.aadhaar_number = ''; }
        if (Array.isArray(payload.promoters)) {
            payload.promoters.forEach(function (promoter) {
                promoter.aadhaar_number = '';
            });
        }
        return payload;
    }

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

    function validateAmount(id, label) {
        var raw = value(id);
        if (raw === '') { return true; }
        var number = Number(raw);
        if (isNaN(number) || number < 0) {
            D.setFieldError(el(id), label + ' cannot be negative.');
            return false;
        }
        return true;
    }

    function validateCount(id, label) {
        var raw = value(id);
        if (raw === '') { return true; }
        var number = Number(raw);
        if (isNaN(number) || number < 0 || Math.floor(number) !== number) {
            D.setFieldError(el(id), label + ' must be a whole number of zero or more.');
            return false;
        }
        return true;
    }

    function validateStep(index) {
        var ok = true;

        if (index === 0) {
            if (!requireField('msmeApplicantName', 'Enter the applicant name.')) { ok = false; }
            if (!MOBILE_RE.test(D.digits(value('msmeMobile')))) {
                D.setFieldError(el('msmeMobile'), 'Enter a valid 10-digit Indian mobile number.');
                ok = false;
            }
            if (!EMAIL_RE.test(value('msmeEmail'))) {
                D.setFieldError(el('msmeEmail'), 'Enter a valid email address.');
                ok = false;
            }
            if (!PAN_RE.test(value('msmePan').toUpperCase())) {
                D.setFieldError(el('msmePan'), 'Enter a valid PAN (e.g. ABCDE1234F).');
                ok = false;
            }
            var aadhaar = D.digits(value('msmeAadhaar'));
            if (aadhaar && aadhaar.length !== 12) {
                D.setFieldError(el('msmeAadhaar'), 'Enter a valid 12-digit Aadhaar number.');
                ok = false;
            }
            if (aadhaar && !value('msmeAadhaarMethod')) {
                D.setFieldError(el('msmeAadhaarMethod'), 'Select the Aadhaar verification method.');
                ok = false;
            }
            if (!requireField('msmeAddressLine', 'Enter the applicant address.')) { ok = false; }
            if (!requireField('msmeAddressCity', 'Enter the city or town.')) { ok = false; }
            if (!requireField('msmeAddressState', 'Select the state.')) { ok = false; }
            if (!PIN_RE.test(D.digits(value('msmeAddressPincode')))) {
                D.setFieldError(el('msmeAddressPincode'), 'Enter a valid 6-digit PIN code.');
                ok = false;
            }
        }

        if (index === 1) {
            if (!requireField('msmeBusinessName', 'Enter the legal business name.')) { ok = false; }
            if (!requireField('msmeConstitution', 'Select the constitution of business.')) { ok = false; }
            if (!requireField('msmeBusinessActivity', 'Describe the main business activity.')) { ok = false; }
            if (!requireField('msmeNicCode', 'Enter the NIC activity code.')) { ok = false; }
            var nic = value('msmeNicCode');
            if (nic && !/^[0-9]{2,8}$/.test(nic)) {
                D.setFieldError(el('msmeNicCode'), 'Enter a valid numeric NIC activity code.');
                ok = false;
            }
            if (!requireField('msmeCommencementDate', 'Enter the date of commencement of business.')) { ok = false; }
            var commencement = value('msmeCommencementDate');
            if (commencement) {
                var date = new Date(commencement + 'T00:00:00');
                var today = new Date();
                today.setHours(0, 0, 0, 0);
                if (!isNaN(date.getTime()) && date > today) {
                    D.setFieldError(el('msmeCommencementDate'), 'Date of commencement cannot be in the future.');
                    ok = false;
                }
            }
            if (!checked('msmeBusinessSameAsApplicant')) {
                if (!requireField('msmeBusinessAddressLine', 'Enter the business or establishment address.')) { ok = false; }
                if (!requireField('msmeBusinessAddressCity', 'Enter the business city or town.')) { ok = false; }
                if (!requireField('msmeBusinessAddressState', 'Select the business state.')) { ok = false; }
                if (!PIN_RE.test(D.digits(value('msmeBusinessAddressPincode')))) {
                    D.setFieldError(el('msmeBusinessAddressPincode'), 'Enter a valid 6-digit business PIN code.');
                    ok = false;
                }
            }
        }

        if (index === 2) {
            if (!requireField('msmePlantInvestment', 'Enter the plant and machinery investment.')) { ok = false; }
            if (!requireField('msmeAnnualTurnover', 'Enter the annual turnover.')) { ok = false; }
            if (!requireField('msmeEmployeeCount', 'Enter the number of employees.')) { ok = false; }
            if (!validateAmount('msmePlantInvestment', 'Plant and machinery investment')) { ok = false; }
            if (!validateAmount('msmeAnnualTurnover', 'Annual turnover')) { ok = false; }
            if (!validateCount('msmeEmployeeCount', 'Employee count')) { ok = false; }
            var gstin = value('msmeGstin').toUpperCase();
            if (gstin && !GSTIN_RE.test(gstin)) {
                D.setFieldError(el('msmeGstin'), 'Enter a valid 15-character GSTIN.');
                ok = false;
            }
        }

        if (index === 3) {
            var service = value('msmeServiceType');
            if (!service) {
                D.setFieldError(el('msmeServiceType'), 'Select the MSME service required.');
                ok = false;
            }
            if (service === 'Udyam Update / Amendment') {
                var udyam = value('msmeExistingUdyam').toUpperCase();
                if (!UDYAM_RE.test(udyam)) {
                    D.setFieldError(el('msmeExistingUdyam'), 'Enter a valid Udyam number (e.g. UDYAM-GJ-03-0001234).');
                    ok = false;
                }
                if (!requireField('msmeUdyamUpdateReason', 'Select the reason for the Udyam update.')) { ok = false; }
                if (!requireField('msmeUdyamUpdateDetails', 'Describe what needs to be updated.')) { ok = false; }
            }
            if (service === 'Gumasta / Shop & Establishment' ||
                service === 'Udyam & Gumasta Package') {
                if (!requireField('msmeGumastaEstablishmentType', 'Select the establishment type.')) { ok = false; }
                if (!requireField('msmeGumastaPremisesOwnership', 'Select the premises ownership.')) { ok = false; }
                var ownership = value('msmeGumastaPremisesOwnership');
                if (ownership === 'Rented' || ownership === 'Leased') {
                    if (!requireField('msmeGumastaLandlordName', 'Enter the landlord or owner name.')) { ok = false; }
                    if (!MOBILE_RE.test(D.digits(value('msmeGumastaLandlordMobile')))) {
                        D.setFieldError(el('msmeGumastaLandlordMobile'), 'Enter a valid 10-digit landlord mobile number.');
                        ok = false;
                    }
                }
            }
            if (service === 'Business Registration Assistance') {
                if (!requireField('msmeBusinessRegistrationType', 'Select the business registration type.')) { ok = false; }
                if (!requireField('msmeBusinessRegistrationState', 'Select the registration state.')) { ok = false; }
                if (!requireField('msmeBusinessRegistrationDetails', 'Describe the business registration assistance required.')) { ok = false; }
            }
        }

        if (index === 4) {
            if (!validatePromoters()) { ok = false; }
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

        if (current === 4) { syncPrimaryPromoterFromApplicant(); }
        if (current === 5) { renderChecklist(); }
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
     * Promoter events
     * ------------------------------------------------------------------ */

    el('addPromoterBtn').addEventListener('click', function () {
        addPromoterRow({});
    });

    promoterContainer.addEventListener('click', function (event) {
        var button = event.target.closest('.remove-promoter');
        if (!button) { return; }
        var rows = promoterContainer.querySelectorAll('.cp-promoter-row');
        if (rows.length <= 1) {
            D.notify('info', 'At least one promoter required', 'Keep one proprietor, partner or director on the application.');
            return;
        }
        var row = button.closest('.cp-promoter-row');
        if (row) { row.remove(); }
        refreshPromoters();
    });

    promoterContainer.addEventListener('input', function (event) {
        if (event.target.classList.contains('form-control')) {
            D.clearFieldError(event.target);
        }
    });

    promoterContainer.addEventListener('change', function (event) {
        if (event.target.classList.contains('form-control')) {
            D.clearFieldError(event.target);
        }
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
                    D.escapeHtml(resumeLink()) + '</code>. For your security, Aadhaar numbers are not stored in drafts; re-enter them when you resume.';
            }
            D.showAlert(alertBox, 'success',
                'Your MSME application has been saved. Bookmark this page or keep the resume link to continue later. Aadhaar numbers are not stored in drafts and must be re-entered when you resume.',
                'Draft saved');
        } catch (err) {
            console.error('MSME draft save failed:', err);
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
                D.escapeHtml(resumeLink()) + '</code>. Aadhaar numbers are not stored in drafts; please re-enter them if applicable.';
        }
    }

    function applyPayload(payload) {
        var personal = payload.personal || {};
        var address = payload.address || {};
        var business = payload.business || {};
        var service = payload.service || {};

        el('msmeApplicantName').value = personal.applicant_name || '';
        el('msmeDesignation').value = personal.designation || '';
        el('msmeMobile').value = personal.mobile || '';
        el('msmeEmail').value = personal.email || '';
        el('msmePan').value = personal.pan_number || '';
        el('msmeAadhaar').value = personal.aadhaar_number || '';
        el('msmeAadhaarMethod').value = personal.aadhaar_verification_method || '';

        el('msmeAddressLine').value = address.line || '';
        el('msmeAddressCity').value = address.city || '';
        el('msmeAddressDistrict').value = address.district || '';
        setSelectValue('msmeAddressState', address.state || '');
        el('msmeAddressPincode').value = address.pincode || '';

        el('msmeBusinessName').value = business.business_name || '';
        el('msmeTradeName').value = business.trade_name || '';
        el('msmeConstitution').value = business.constitution || '';
        el('msmeEnterpriseCategory').value = business.enterprise_category || '';
        el('msmeBusinessActivity').value = business.business_activity || '';
        el('msmeNicCode').value = business.nic_code || '';
        el('msmeNicDescription').value = business.nic_description || '';
        el('msmeCommencementDate').value = business.commencement_date || '';
        el('msmeBusinessSameAsApplicant').checked = !!business.business_address_same_as_applicant;
        el('msmeBusinessAddressLine').value = business.business_address_line || '';
        el('msmeBusinessAddressCity').value = business.business_address_city || '';
        el('msmeBusinessAddressDistrict').value = business.business_address_district || '';
        setSelectValue('msmeBusinessAddressState', business.business_address_state || '');
        el('msmeBusinessAddressPincode').value = business.business_address_pincode || '';

        el('msmePlantInvestment').value = business.plant_machinery_investment !== null && business.plant_machinery_investment !== undefined ? business.plant_machinery_investment : '';
        el('msmeAnnualTurnover').value = business.annual_turnover !== null && business.annual_turnover !== undefined ? business.annual_turnover : '';
        el('msmeEmployeeCount').value = business.employee_count !== null && business.employee_count !== undefined ? business.employee_count : '';
        el('msmeGstin').value = business.gstin || '';
        el('msmeExistingRegistrations').value = business.existing_registrations || '';

        el('msmeServiceType').value = service.service_type || '';
        el('msmeExistingUdyam').value = service.existing_udyam_number || '';
        el('msmeUdyamUpdateReason').value = service.udyam_update_reason || '';
        el('msmeUdyamUpdateDetails').value = service.udyam_update_details || '';
        el('msmeExistingShopNumber').value = service.existing_shop_number || '';
        el('msmeGumastaEstablishmentType').value = service.gumasta_establishment_type || '';
        el('msmeGumastaPremisesOwnership').value = service.gumasta_premises_ownership || '';
        el('msmeGumastaLandlordName').value = service.gumasta_premises_landlord_name || '';
        el('msmeGumastaLandlordMobile').value = service.gumasta_premises_landlord_mobile || '';
        el('msmeBusinessRegistrationType').value = service.business_registration_type || '';
        setSelectValue('msmeBusinessRegistrationState', service.business_registration_state || '');
        el('msmeBusinessRegistrationDetails').value = service.business_registration_details || '';

        renderPromoters(payload.promoters || []);

        syncBusinessAddress();
        syncServiceBlocks();
        updateEnterpriseEstimate();
    }

    function parseHashDraft() {
        var hash = window.location.hash.replace(/^#/, '');
        if (!hash) { return null; }
        var params = new URLSearchParams(hash);
        var id = params.get('draft');
        var token = params.get('token');
        var uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (id && token && uuid.test(id) && uuid.test(token)) {
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
        renderPromoters([]);
        syncBusinessAddress();
        syncServiceBlocks();
        updateEnterpriseEstimate();
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
                D.notify('success', 'Draft restored', 'Your saved MSME application has been loaded.');
                return;
            } catch (err) {
                console.warn('Failed to resume MSME draft from link:', err);
                D.showAlert(alertBox, 'warning',
                    'The resume link could not be loaded. ' + D.friendlyError(err),
                    'Draft unavailable');
            }
        }
        if (readStoredDraft() && draftBar) {
            draftBar.classList.remove('cp-hidden');
            draftBarText.textContent = 'We found a saved draft of your MSME application on this device.';
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
            console.warn('Background MSME draft save failed:', err);
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

        if (!checked('msmeAccuracyDeclaration')) {
            D.showAlert(alertBox, 'warning',
                'Please confirm that the information provided is true and complete.',
                'Declaration required');
            el('msmeAccuracyDeclaration').focus();
            return;
        }
        if (!checked('msmeAuthorisationDeclaration')) {
            D.showAlert(alertBox, 'warning',
                'Please authorise Dhanvi Finserv to prepare and submit your MSME, Udyam or Gumasta application.',
                'Authorisation required');
            el('msmeAuthorisationDeclaration').focus();
            return;
        }
        if (!checked('msmeApplicationConsent')) {
            D.showAlert(alertBox, 'warning',
                'Please accept the privacy notice and MSME consent before submitting.',
                'Consent required');
            el('msmeApplicationConsent').focus();
            return;
        }

        var payload = buildPayload();
        D.setLoading(submitBtn, true, 'Submitting application\u2026');
        try {
            var result = await D.rpc('submit_msme_application', {
                p_payload: payload,
                p_draft_id: draftId,
                p_draft_token: draftToken
            });
            clearStoredDraft();
            showSuccess(result);
        } catch (err) {
            console.error('MSME submission failed:', err);
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
            'Your MSME assistance request has been received. Reference: ' +
            (result.reference_no || '\u2014') + '. This is not a completed government registration or an issued certificate.',
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
        if (event.target.id === 'msmePlantInvestment' || event.target.id === 'msmeAnnualTurnover') {
            updateEnterpriseEstimate();
        }
    });

    form.addEventListener('change', function (event) {
        if (event.target.classList.contains('form-control')) {
            D.clearFieldError(event.target);
        }
        if (event.target.id === 'msmeBusinessSameAsApplicant') { syncBusinessAddress(); }
        if (event.target.id === 'msmeServiceType') { syncServiceBlocks(); }
        if (event.target.id === 'msmeGumastaPremisesOwnership') { syncLandlord(); }
    });

    /* ------------------------------------------------------------------ *
     * Boot
     * ------------------------------------------------------------------ */

    function boot() {
        initOptions();
        renderPromoters([]);
        syncBusinessAddress();
        syncServiceBlocks();
        updateEnterpriseEstimate();
        showStep(0, false);
        initDraft();
    }

    boot();
})(window, document);

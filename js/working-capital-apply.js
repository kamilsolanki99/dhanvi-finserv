/**
 * Dhanvi Finserv - multi-step Working Capital (CC/OD) application wizard.
 *
 * Depends on: js/nhost-client.js, js/public-api.js
 *
 * Flow
 *   1    applicant details and personal addresses
 *   2    business entity, constitution and registrations
 *   3    registered / operating business addresses
 *   4    financials and banking relationship
 *   5    existing CC/OD position and additional bank facilities
 *   6    requested facility (new / enhancement / renewal / takeover)
 *   7    co-applicants and guarantors
 *   8    conditional document checklist, review and consent
 *
 * Save / resume
 *   A server-side draft is created through save_home_loan_draft() (shared with
 *   the Home Loan wizard) as soon as the first step validates, and refreshed
 *   on every step change. The draft id + secret token are kept in localStorage
 *   so the applicant can resume in the same browser, and "Save & continue
 *   later" also shows a resume link. Submitting promotes the draft into a real
 *   Working Capital application through submit_working_capital_application().
 */
(function (window, document) {
    'use strict';

    var D = window.Dhanvi;
    var form = document.getElementById('workingCapitalForm');
    if (!form || !D) { return; }

    var DRAFT_KEY = 'dhanviWorkingCapitalDraft';
    var TOTAL_STEPS = 8;

    var alertBox = document.getElementById('applicationAlert');
    var draftBar = document.getElementById('draftBar');
    var draftBarText = document.getElementById('draftBarText');
    var successBox = document.getElementById('applicationSuccess');
    var stepper = document.getElementById('wcStepper');
    var steps = Array.prototype.slice.call(form.querySelectorAll('.cp-step'));
    var prevBtn = document.getElementById('prevBtn');
    var nextBtn = document.getElementById('nextBtn');
    var submitBtn = document.getElementById('submitBtn');
    var saveDraftBtn = document.getElementById('saveDraftBtn');
    var progressText = document.getElementById('progressText');

    var facilityList = document.getElementById('wcFacilityList');
    var facilityPlaceholder = document.getElementById('wcFacilityPlaceholder');
    var addFacilityBtn = document.getElementById('wcAddFacility');
    var coList = document.getElementById('wcCoApplicantList');
    var guarList = document.getElementById('wcGuarantorList');
    var addCoBtn = document.getElementById('wcAddCoApplicant');
    var addGuarBtn = document.getElementById('wcAddGuarantor');

    var current = 0;
    var maxStep = 0;
    var draftId = null;
    var draftToken = null;
    var coSeq = 0;
    var guarSeq = 0;
    var facilitySeq = 0;
    var MAX_CO = 3;
    var MAX_GUAR = 2;
    var MAX_FACILITIES = 10;

    var STATES = ['Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry'];
    var RELATIONSHIPS = ['Spouse', 'Parent', 'Sibling', 'Son', 'Daughter', 'Business partner', 'Friend', 'Other'];
    var EMPLOYMENT = ['Salaried', 'Self-employed / business', 'Professional', 'Retired', 'Other'];
    var FACILITY_TYPES = ['Cash Credit', 'Overdraft', 'WCDL', 'Term Loan', 'Other'];
    var CONSTITUTIONS = ['Proprietorship', 'Partnership', 'LLP', 'Private Limited', 'Public Limited', 'HUF', 'Other'];
    var PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
    var GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

    /* ------------------------------------------------------------------ *
     * Small helpers
     * ------------------------------------------------------------------ */

    function el(id) { return document.getElementById(id); }
    function optionList(values) {
        return values.map(function (v) {
            return '<option value="' + D.escapeHtml(v) + '">' + D.escapeHtml(v) + '</option>';
        }).join('');
    }
    function numOrNull(value) {
        var raw = String(value === null || value === undefined ? '' : value).trim();
        if (raw === '') { return null; }
        var n = Number(raw);
        return isNaN(n) ? null : n;
    }
    function money(value) {
        var n = Number(value);
        if (isNaN(n)) { return '\u2014'; }
        return '\u20B9' + n.toLocaleString('en-IN');
    }
    function isoDate(date) {
        var m = String(date.getMonth() + 1).padStart(2, '0');
        var d = String(date.getDate()).padStart(2, '0');
        return date.getFullYear() + '-' + m + '-' + d;
    }
    function fullName() {
        return [el('wcFirstName').value, el('wcMiddleName').value, el('wcLastName').value]
            .map(function (v) { return v.trim(); })
            .filter(Boolean).join(' ');
    }
    function ageFrom(dobValue) {
        if (!dobValue) { return null; }
        var dob = new Date(dobValue);
        if (isNaN(dob.getTime())) { return null; }
        var today = new Date();
        var age = today.getFullYear() - dob.getFullYear();
        var m = today.getMonth() - dob.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < dob.getDate())) { age -= 1; }
        return age;
    }
    function copyFields(map) {
        map.forEach(function (pair) {
            var from = el(pair[0]);
            var to = el(pair[1]);
            if (from && to) { to.value = from.value; }
        });
    }

    /* ------------------------------------------------------------------ *
     * Static option lists
     * ------------------------------------------------------------------ */

    function initOptions() {
        ['wcRegisteredState', 'wcOperatingState', 'wcCurrentState', 'wcPermanentState'].forEach(function (id) {
            var select = el(id);
            if (!select) { return; }
            select.innerHTML = '<option value="">Select state</option>' + optionList(STATES);
        });

        var dob = el('wcDob');
        var today = new Date();
        var min = new Date(today.getFullYear() - 70, today.getMonth(), today.getDate());
        var max = new Date(today.getFullYear() - 18, today.getMonth(), today.getDate());
        dob.setAttribute('min', isoDate(min));
        dob.setAttribute('max', isoDate(max));

        var established = el('wcEstablishmentDate');
        if (established) { established.setAttribute('max', D.todayISO(0)); }
    }

    /* ------------------------------------------------------------------ *
     * Existing bank facility rows
     * ------------------------------------------------------------------ */

    function facilityTemplate(seq) {
        var prefix = 'wcFacility' + seq;
        return '' +
            '<div class="cp-applicant" data-facility="' + prefix + '">' +
                '<div class="cp-applicant-head">' +
                    '<h4>Existing facility</h4>' +
                    '<button type="button" class="cp-remove" data-remove-facility><i class="fa fa-trash-o"></i> Remove</button>' +
                '</div>' +
                '<div class="cp-grid">' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Bank">Bank / NBFC <span class="cp-req">*</span></label>' +
                        '<input type="text" class="form-control" id="' + prefix + 'Bank" data-field="bank_name" placeholder="e.g. ICICI Bank">' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Type">Facility type</label>' +
                        '<select class="form-control" id="' + prefix + 'Type" data-field="facility_type">' +
                            '<option value="">Select facility type</option>' + optionList(FACILITY_TYPES) +
                        '</select>' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Account">Account number</label>' +
                        '<input type="text" class="form-control" id="' + prefix + 'Account" data-field="account_number" placeholder="CC / OD / loan account number">' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Limit">Sanctioned limit (&#8377;)</label>' +
                        '<input type="number" class="form-control" id="' + prefix + 'Limit" data-field="sanctioned_limit" min="0" step="1000" placeholder="e.g. 2000000">' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Utilisation">Current utilisation (&#8377;)</label>' +
                        '<input type="number" class="form-control" id="' + prefix + 'Utilisation" data-field="current_utilisation" min="0" step="1000" placeholder="e.g. 1200000">' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Outstanding">Outstanding (&#8377;)</label>' +
                        '<input type="number" class="form-control" id="' + prefix + 'Outstanding" data-field="outstanding_amount" min="0" step="1000" placeholder="e.g. 1200000">' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Rate">Interest rate (% p.a.)</label>' +
                        '<input type="number" class="form-control" id="' + prefix + 'Rate" data-field="interest_rate" min="0" max="50" step="0.1" placeholder="e.g. 10.5">' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Renewal">Renewal date</label>' +
                        '<input type="date" class="form-control" id="' + prefix + 'Renewal" data-field="renewal_date">' +
                    '</div></div>' +
                '</div>' +
            '</div>';
    }

    function updateFacilityState() {
        var count = facilityList.querySelectorAll('[data-facility]').length;
        facilityPlaceholder.classList.toggle('cp-hidden', count > 0);
        addFacilityBtn.disabled = count >= MAX_FACILITIES;
        addFacilityBtn.innerHTML = '<i class="fa fa-plus"></i> Add existing facility' +
            (count >= MAX_FACILITIES ? ' (max ' + MAX_FACILITIES + ')' : '');
    }

    addFacilityBtn.addEventListener('click', function () {
        if (facilityList.querySelectorAll('[data-facility]').length >= MAX_FACILITIES) { return; }
        facilitySeq += 1;
        facilityList.insertAdjacentHTML('beforeend', facilityTemplate(facilitySeq));
        updateFacilityState();
        facilityList.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    facilityList.addEventListener('click', function (event) {
        var removeBtn = event.target.closest('[data-remove-facility]');
        if (!removeBtn) { return; }
        var card = removeBtn.closest('[data-facility]');
        if (card) { card.remove(); }
        updateFacilityState();
    });

    function collectFacilities() {
        return Array.prototype.map.call(facilityList.querySelectorAll('[data-facility]'), function (card) {
            var data = {};
            Array.prototype.forEach.call(card.querySelectorAll('[data-field]'), function (input) {
                data[input.getAttribute('data-field')] = input.value.trim();
            });
            return {
                bank_name: data.bank_name,
                facility_type: data.facility_type || '',
                account_number: data.account_number,
                sanctioned_limit: numOrNull(data.sanctioned_limit),
                current_utilisation: numOrNull(data.current_utilisation),
                outstanding_amount: numOrNull(data.outstanding_amount),
                interest_rate: numOrNull(data.interest_rate),
                renewal_date: data.renewal_date || ''
            };
        }).filter(function (facility) {
            return facility.bank_name !== '' || facility.sanctioned_limit !== null ||
                facility.current_utilisation !== null || facility.outstanding_amount !== null;
        });
    }

    /* ------------------------------------------------------------------ *
     * Co-applicant / guarantor cards
     * ------------------------------------------------------------------ */

    function applicantTemplate(role, index, seq) {
        var isCo = role === 'co_applicant';
        var prefix = (isCo ? 'wcCo' : 'wcGuar') + seq;
        var title = (isCo ? 'Co-applicant ' : 'Guarantor ') + index;

        return '' +
            '<div class="cp-applicant" data-role="' + role + '" data-prefix="' + prefix + '">' +
                '<div class="cp-applicant-head">' +
                    '<h4>' + title + '</h4>' +
                    '<button type="button" class="cp-remove" data-remove="' + role + '"><i class="fa fa-trash-o"></i> Remove</button>' +
                '</div>' +
                '<div class="cp-grid">' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Name">Full name <span class="cp-req">*</span></label>' +
                        '<input type="text" class="form-control" id="' + prefix + 'Name" data-field="full_name" placeholder="Enter full name">' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Relationship">Relationship <span class="cp-req">*</span></label>' +
                        '<select class="form-control" id="' + prefix + 'Relationship" data-field="relationship">' +
                            '<option value="">Select relationship</option>' + optionList(RELATIONSHIPS) +
                        '</select>' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Dob">Date of birth</label>' +
                        '<input type="date" class="form-control" id="' + prefix + 'Dob" data-field="date_of_birth">' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Mobile">Mobile number</label>' +
                        '<input type="tel" class="form-control" id="' + prefix + 'Mobile" data-field="mobile" maxlength="10" placeholder="10-digit mobile">' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Email">Email</label>' +
                        '<input type="email" class="form-control" id="' + prefix + 'Email" data-field="email" placeholder="Optional">' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Employment">Employment type</label>' +
                        '<select class="form-control" id="' + prefix + 'Employment" data-field="employment_type">' +
                            '<option value="">Select employment</option>' + optionList(EMPLOYMENT) +
                        '</select>' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Employer">Employer / business name</label>' +
                        '<input type="text" class="form-control" id="' + prefix + 'Employer" data-field="employer_name" placeholder="Optional">' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Income">Monthly income (&#8377;)</label>' +
                        '<input type="number" class="form-control" id="' + prefix + 'Income" data-field="monthly_income" min="0" step="1000" placeholder="e.g. 60000">' +
                    '</div></div>' +
                '</div>' +
            '</div>';
    }

    function updateAddButtons() {
        var co = coList.querySelectorAll('.cp-applicant').length;
        var guar = guarList.querySelectorAll('.cp-applicant').length;
        addCoBtn.disabled = co >= MAX_CO;
        addCoBtn.innerHTML = '<i class="fa fa-plus"></i> Add co-applicant' + (co >= MAX_CO ? ' (max ' + MAX_CO + ')' : '');
        addGuarBtn.disabled = guar >= MAX_GUAR;
        addGuarBtn.innerHTML = '<i class="fa fa-plus"></i> Add guarantor' + (guar >= MAX_GUAR ? ' (max ' + MAX_GUAR + ')' : '');
    }

    function renumber(container, role) {
        Array.prototype.forEach.call(container.querySelectorAll('.cp-applicant'), function (card, index) {
            var heading = card.querySelector('.cp-applicant-head h4');
            if (heading) {
                heading.textContent = (role === 'co_applicant' ? 'Co-applicant ' : 'Guarantor ') + (index + 1);
            }
        });
    }

    addCoBtn.addEventListener('click', function () {
        if (coList.querySelectorAll('.cp-applicant').length >= MAX_CO) { return; }
        coSeq += 1;
        coList.insertAdjacentHTML('beforeend', applicantTemplate('co_applicant', coList.querySelectorAll('.cp-applicant').length + 1, coSeq));
        updateAddButtons();
        coList.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    addGuarBtn.addEventListener('click', function () {
        if (guarList.querySelectorAll('.cp-applicant').length >= MAX_GUAR) { return; }
        guarSeq += 1;
        guarList.insertAdjacentHTML('beforeend', applicantTemplate('guarantor', guarList.querySelectorAll('.cp-applicant').length + 1, guarSeq));
        updateAddButtons();
        guarList.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    [coList, guarList].forEach(function (container) {
        container.addEventListener('click', function (event) {
            var removeBtn = event.target.closest('[data-remove]');
            if (!removeBtn) { return; }
            var card = removeBtn.closest('.cp-applicant');
            if (!card) { return; }
            var role = card.getAttribute('data-role');
            card.remove();
            renumber(container, role);
            updateAddButtons();
        });
    });

    function collectApplicant(card) {
        var data = {};
        Array.prototype.forEach.call(card.querySelectorAll('[data-field]'), function (input) {
            data[input.getAttribute('data-field')] = input.value.trim();
        });
        return data;
    }

    function validateApplicantCard(card) {
        var ok = true;
        var name = card.querySelector('[data-field="full_name"]');
        var relationship = card.querySelector('[data-field="relationship"]');
        var mobile = card.querySelector('[data-field="mobile"]');
        var email = card.querySelector('[data-field="email"]');

        if (!name.value.trim()) {
            D.setFieldError(name, 'Enter the full name.');
            ok = false;
        }
        if (!relationship.value) {
            D.setFieldError(relationship, 'Select a relationship.');
            ok = false;
        }
        if (mobile.value.trim() && !D.isIndianMobile(mobile.value)) {
            D.setFieldError(mobile, 'Enter a valid 10-digit Indian mobile number.');
            ok = false;
        }
        if (email.value.trim() && !D.isEmail(email.value)) {
            D.setFieldError(email, 'Enter a valid email address.');
            ok = false;
        }
        return ok;
    }

    /* ------------------------------------------------------------------ *
     * Conditional behaviour
     * ------------------------------------------------------------------ */

    function syncOperatingAddress() {
        var same = el('wcOperatingSameAsRegistered').checked;
        el('wcOperatingAddressBlock').classList.toggle('cp-hidden', same);
        if (same) {
            copyFields([
                ['wcRegisteredAddressLine', 'wcOperatingAddressLine'],
                ['wcRegisteredCity', 'wcOperatingCity'],
                ['wcRegisteredState', 'wcOperatingState'],
                ['wcRegisteredPincode', 'wcOperatingPincode']
            ]);
        }
    }

    function syncPermanentAddress() {
        var same = el('wcSameAsCurrent').checked;
        el('wcPermanentAddressBlock').classList.toggle('cp-hidden', same);
        if (same) {
            copyFields([
                ['wcCurrentAddressLine', 'wcPermanentAddressLine'],
                ['wcCurrentCity', 'wcPermanentCity'],
                ['wcCurrentState', 'wcPermanentState'],
                ['wcCurrentPincode', 'wcPermanentPincode']
            ]);
        }
    }

    function syncExistingFacility() {
        var type = el('wcExistingFacilityType').value;
        var hasFacility = type !== '' && type !== 'None';
        el('wcExistingDetails').classList.toggle('cp-hidden', !hasFacility);
        if (!hasFacility) {
            ['wcExistingBankName', 'wcExistingAccountNumber', 'wcExistingLimit',
             'wcCurrentUtilisation', 'wcExistingOutstanding'].forEach(function (id) {
                el(id).value = '';
                D.clearFieldError(el(id));
            });
        }
    }

    function syncSecurity() {
        var type = el('wcSecurityType').value;
        var needsCollateral = type === 'Property Collateral';
        el('wcCollateralField').classList.toggle('cp-hidden', !needsCollateral);
        if (!needsCollateral) {
            el('wcCollateralValue').value = '';
            D.clearFieldError(el('wcCollateralValue'));
        }
    }

    function updateInterestEstimate() {
        var proposed = numOrNull(el('wcProposedLimit').value);
        var box = el('wcInterestEstimate');
        if (!proposed || proposed <= 0) {
            box.textContent = 'Enter the proposed limit to see an indicative monthly interest at 12% p.a. on full utilisation. Final pricing is set by the lender.';
            return;
        }
        var monthly = proposed * 0.12 / 12;
        box.innerHTML = 'Indicative monthly interest: <strong>' + money(Math.round(monthly)) +
            '</strong> at 12% p.a. on full utilisation of ' + money(proposed) +
            '. Actual rate, drawing power and interest are decided by your lender.';
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
        steps.forEach(function (step, i) {
            step.classList.toggle('is-active', i === current);
        });
        maxStep = Math.max(maxStep, current);
        renderStepper();

        prevBtn.classList.toggle('cp-hidden', current === 0);
        nextBtn.classList.toggle('cp-hidden', current === TOTAL_STEPS - 1);
        submitBtn.classList.toggle('cp-hidden', current !== TOTAL_STEPS - 1);
        progressText.textContent = 'Step ' + (current + 1) + ' of ' + TOTAL_STEPS;

        if (current === TOTAL_STEPS - 1) {
            renderChecklist();
            renderReview();
        }
        if (scroll) {
            form.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    stepper.addEventListener('click', function (event) {
        var item = event.target.closest('.cp-stepper-item');
        if (!item) { return; }
        var index = Number(item.getAttribute('data-step'));
        if (index <= maxStep) { showStep(index, true); }
    });

    /* ------------------------------------------------------------------ *
     * Validation
     * ------------------------------------------------------------------ */

    function validateStep(index) {
        var ok = true;

        if (index === 0) {
            var first = el('wcFirstName'), last = el('wcLastName'), dob = el('wcDob');
            var mobile = el('wcMobile'), email = el('wcEmail'), pan = el('wcPan');
            var aadhaar = el('wcAadhaar'), role = el('wcApplicantRole');

            if (!first.value.trim()) { D.setFieldError(first, 'Enter your first name.'); ok = false; }
            if (!last.value.trim()) { D.setFieldError(last, 'Enter your last name.'); ok = false; }
            if (!dob.value) {
                D.setFieldError(dob, 'Enter your date of birth.');
                ok = false;
            } else {
                var age = ageFrom(dob.value);
                if (age === null || age < 18) {
                    D.setFieldError(dob, 'The applicant must be at least 18 years old.');
                    ok = false;
                } else if (age > 70) {
                    D.setFieldError(dob, 'The applicant age must be 70 years or below.');
                    ok = false;
                }
            }
            if (!mobile.value.trim()) {
                D.setFieldError(mobile, 'Enter your mobile number.');
                ok = false;
            } else if (!D.isIndianMobile(mobile.value)) {
                D.setFieldError(mobile, 'Enter a valid 10-digit Indian mobile number.');
                ok = false;
            }
            if (!D.isEmail(email.value)) { D.setFieldError(email, 'Enter a valid email address.'); ok = false; }
            if (!PAN_RE.test(pan.value.trim().toUpperCase())) {
                D.setFieldError(pan, 'Enter a valid PAN (e.g. ABCDE1234F).');
                ok = false;
            }
            var aadhaarDigits = D.digits(aadhaar.value);
            if (aadhaarDigits && aadhaarDigits.length !== 12) {
                D.setFieldError(aadhaar, 'Enter a valid 12-digit Aadhaar number.');
                ok = false;
            }
            if (!role.value) { D.setFieldError(role, 'Select your role in the business.'); ok = false; }

            [['wcCurrentAddressLine', 'Enter your current address.'],
             ['wcCurrentCity', 'Enter your city.'],
             ['wcCurrentState', 'Select your state.'],
             ['wcCurrentPincode', 'Enter your 6-digit PIN code.']].forEach(function (pair) {
                var field = el(pair[0]);
                if (!field.value.trim()) { D.setFieldError(field, pair[1]); ok = false; }
            });
            var curPin = el('wcCurrentPincode');
            if (curPin.value.trim() && !/^[0-9]{6}$/.test(curPin.value.trim())) {
                D.setFieldError(curPin, 'Enter a valid 6-digit PIN code.');
                ok = false;
            }
            if (!el('wcSameAsCurrent').checked) {
                [['wcPermanentAddressLine', 'Enter your permanent address.'],
                 ['wcPermanentCity', 'Enter your city.'],
                 ['wcPermanentState', 'Select your state.'],
                 ['wcPermanentPincode', 'Enter your 6-digit PIN code.']].forEach(function (pair) {
                    var field = el(pair[0]);
                    if (!field.value.trim()) { D.setFieldError(field, pair[1]); ok = false; }
                });
                var perPin = el('wcPermanentPincode');
                if (perPin.value.trim() && !/^[0-9]{6}$/.test(perPin.value.trim())) {
                    D.setFieldError(perPin, 'Enter a valid 6-digit PIN code.');
                    ok = false;
                }
            }
        }

        if (index === 1) {
            var businessName = el('wcBusinessName');
            var constitution = el('wcBusinessConstitution');
            var established = el('wcEstablishmentDate');
            var vintage = el('wcBusinessVintage');
            var partners = el('wcPartnerDirectorCount');

            if (!businessName.value.trim()) { D.setFieldError(businessName, 'Enter your business name.'); ok = false; }
            if (!constitution.value) {
                D.setFieldError(constitution, 'Select your business constitution.');
                ok = false;
            } else if (CONSTITUTIONS.indexOf(constitution.value) === -1) {
                D.setFieldError(constitution, 'Select a valid business constitution.');
                ok = false;
            }
            if (established.value && established.value > D.todayISO(0)) {
                D.setFieldError(established, 'The establishment date cannot be in the future.');
                ok = false;
            }
            if (vintage.value && Number(vintage.value) < 0) {
                D.setFieldError(vintage, 'Enter a valid business vintage.');
                ok = false;
            }
            if (partners.value && Number(partners.value) < 0) {
                D.setFieldError(partners, 'Enter a valid number of partners or directors.');
                ok = false;
            }
            var gstin = el('wcGstin');
            if (gstin.value.trim() && !GSTIN_RE.test(gstin.value.trim().toUpperCase())) {
                D.setFieldError(gstin, 'Enter a valid 15-character GSTIN (e.g. 22ABCDE1234F1Z5).');
                ok = false;
            }
            var businessPan = el('wcBusinessPan');
            if (businessPan.value.trim() && !PAN_RE.test(businessPan.value.trim().toUpperCase())) {
                D.setFieldError(businessPan, 'Enter a valid business PAN (e.g. ABCDE1234F).');
                ok = false;
            }
        }

        if (index === 2) {
            [['wcRegisteredAddressLine', 'Enter your registered address.'],
             ['wcRegisteredCity', 'Enter your registered city.'],
             ['wcRegisteredState', 'Select your registered state.'],
             ['wcRegisteredPincode', 'Enter your 6-digit PIN code.']].forEach(function (pair) {
                var field = el(pair[0]);
                if (!field.value.trim()) { D.setFieldError(field, pair[1]); ok = false; }
            });
            var regPin = el('wcRegisteredPincode');
            if (regPin.value.trim() && !/^[0-9]{6}$/.test(regPin.value.trim())) {
                D.setFieldError(regPin, 'Enter a valid 6-digit PIN code.');
                ok = false;
            }
            if (!el('wcOperatingSameAsRegistered').checked) {
                [['wcOperatingAddressLine', 'Enter your operating address.'],
                 ['wcOperatingCity', 'Enter your operating city.'],
                 ['wcOperatingState', 'Select your operating state.'],
                 ['wcOperatingPincode', 'Enter your 6-digit PIN code.']].forEach(function (pair) {
                    var field = el(pair[0]);
                    if (!field.value.trim()) { D.setFieldError(field, pair[1]); ok = false; }
                });
                var opPin = el('wcOperatingPincode');
                if (opPin.value.trim() && !/^[0-9]{6}$/.test(opPin.value.trim())) {
                    D.setFieldError(opPin, 'Enter a valid 6-digit PIN code.');
                    ok = false;
                }
            }
        }

        if (index === 3) {
            var turnover = el('wcAnnualTurnover');
            if (!turnover.value || Number(turnover.value) <= 0) {
                D.setFieldError(turnover, 'Enter your annual business turnover.');
                ok = false;
            }
            [['wcMonthlySales', 'Enter a valid monthly sales figure.'],
             ['wcReceivables', 'Enter a valid receivables figure.'],
             ['wcInventory', 'Enter a valid inventory figure.'],
             ['wcCreditors', 'Enter a valid creditors figure.'],
             ['wcExistingLiabilities', 'Enter a valid existing liabilities figure.'],
             ['wcAvgMonthlyBalance', 'Enter a valid average bank balance.']].forEach(function (pair) {
                var field = el(pair[0]);
                if (field.value && Number(field.value) < 0) {
                    D.setFieldError(field, pair[1]);
                    ok = false;
                }
            });
            var bankingYears = el('wcBankingYears');
            if (bankingYears.value && (Number(bankingYears.value) < 0 || Number(bankingYears.value) > 60)) {
                D.setFieldError(bankingYears, 'Enter a banking relationship between 0 and 60 years.');
                ok = false;
            }
        }

        if (index === 4) {
            var existingType = el('wcExistingFacilityType');
            if (!existingType.value) {
                D.setFieldError(existingType, 'Select your existing facility type, or choose None.');
                ok = false;
            }
            if (existingType.value && existingType.value !== 'None') {
                var existingBank = el('wcExistingBankName');
                var existingLimit = el('wcExistingLimit');
                if (!existingBank.value.trim()) {
                    D.setFieldError(existingBank, 'Enter the bank holding your existing CC/OD facility.');
                    ok = false;
                }
                if (!existingLimit.value || Number(existingLimit.value) <= 0) {
                    D.setFieldError(existingLimit, 'Enter the sanctioned limit of your existing facility.');
                    ok = false;
                }
                [['wcCurrentUtilisation', 'Enter a valid current utilisation amount.'],
                 ['wcExistingOutstanding', 'Enter a valid outstanding amount.']].forEach(function (pair) {
                    var field = el(pair[0]);
                    if (field.value && Number(field.value) < 0) {
                        D.setFieldError(field, pair[1]);
                        ok = false;
                    }
                });
            }
            Array.prototype.forEach.call(facilityList.querySelectorAll('[data-facility]'), function (card) {
                var bank = card.querySelector('[data-field="bank_name"]');
                var limit = card.querySelector('[data-field="sanctioned_limit"]');
                var utilisation = card.querySelector('[data-field="current_utilisation"]');
                var outstanding = card.querySelector('[data-field="outstanding_amount"]');
                var rate = card.querySelector('[data-field="interest_rate"]');

                if (!bank.value.trim()) { D.setFieldError(bank, 'Enter the bank or NBFC name.'); ok = false; }
                [limit, utilisation, outstanding].forEach(function (field) {
                    if (field.value && Number(field.value) < 0) {
                        D.setFieldError(field, 'Enter a valid amount.');
                        ok = false;
                    }
                });
                if (rate.value && (Number(rate.value) < 0 || Number(rate.value) > 50)) {
                    D.setFieldError(rate, 'Enter a rate between 0 and 50% p.a.');
                    ok = false;
                }
            });
        }

        if (index === 5) {
            var requestType = el('wcRequestType');
            var proposed = el('wcProposedLimit');
            var purpose = el('wcBusinessPurpose');
            var securityType = el('wcSecurityType');
            var collateral = el('wcCollateralValue');
            var securityDetails = el('wcSecurityDetails');
            var tenure = el('wcPreferredTenure');

            if (!requestType.value) { D.setFieldError(requestType, 'Select the type of CC/OD request.'); ok = false; }
            if (!proposed.value || Number(proposed.value) < 50000) {
                D.setFieldError(proposed, 'Enter a proposed limit of at least \u20B950,000.');
                ok = false;
            }
            if (!purpose.value) { D.setFieldError(purpose, 'Select the business purpose.'); ok = false; }
            if (securityType.value === 'Property Collateral' && (!collateral.value || Number(collateral.value) <= 0)) {
                D.setFieldError(collateral, 'Enter the estimated collateral value.');
                ok = false;
            }
            if (securityType.value && securityType.value !== 'Unsecured' && !securityDetails.value.trim()) {
                D.setFieldError(securityDetails, 'Describe the security offered for the facility.');
                ok = false;
            }
            if (tenure.value) {
                var months = Number(tenure.value);
                if (months < 6 || months > 60) {
                    D.setFieldError(tenure, 'The preferred tenure must be between 6 and 60 months.');
                    ok = false;
                }
            }
        }

        if (index === 6) {
            Array.prototype.forEach.call(coList.querySelectorAll('.cp-applicant'), function (card) {
                if (!validateApplicantCard(card)) { ok = false; }
            });
            Array.prototype.forEach.call(guarList.querySelectorAll('.cp-applicant'), function (card) {
                if (!validateApplicantCard(card)) { ok = false; }
            });
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
     * Payload
     * ------------------------------------------------------------------ */

    function buildPayload() {
        var hasExisting = el('wcExistingFacilityType').value !== '' &&
            el('wcExistingFacilityType').value !== 'None';
        var securityType = el('wcSecurityType').value;

        return {
            personal: {
                first_name: el('wcFirstName').value.trim(),
                middle_name: el('wcMiddleName').value.trim(),
                last_name: el('wcLastName').value.trim(),
                date_of_birth: el('wcDob').value || '',
                gender: el('wcGender').value,
                marital_status: el('wcMaritalStatus').value,
                mobile: el('wcMobile').value.trim(),
                email: el('wcEmail').value.trim(),
                pan_number: el('wcPan').value.trim().toUpperCase(),
                aadhaar_number: D.digits(el('wcAadhaar').value),
                applicant_role: el('wcApplicantRole').value
            },
            business: {
                name: el('wcBusinessName').value.trim(),
                constitution: el('wcBusinessConstitution').value,
                industry: el('wcIndustry').value.trim(),
                nature_of_business: el('wcNatureOfBusiness').value.trim(),
                establishment_date: el('wcEstablishmentDate').value || '',
                business_vintage_years: numOrNull(el('wcBusinessVintage').value),
                partner_director_count: numOrNull(el('wcPartnerDirectorCount').value),
                ownership: el('wcBusinessOwnership').value.trim(),
                gstin: el('wcGstin').value.trim().toUpperCase(),
                business_pan: el('wcBusinessPan').value.trim().toUpperCase(),
                udyam_number: el('wcUdyamNumber').value.trim(),
                operating_same_as_registered: el('wcOperatingSameAsRegistered').checked
            },
            registered_address: {
                line: el('wcRegisteredAddressLine').value.trim(),
                city: el('wcRegisteredCity').value.trim(),
                state: el('wcRegisteredState').value,
                pincode: el('wcRegisteredPincode').value.trim()
            },
            operating_address: {
                line: el('wcOperatingAddressLine').value.trim(),
                city: el('wcOperatingCity').value.trim(),
                state: el('wcOperatingState').value,
                pincode: el('wcOperatingPincode').value.trim()
            },
            finance: {
                annual_turnover: numOrNull(el('wcAnnualTurnover').value),
                monthly_sales: numOrNull(el('wcMonthlySales').value),
                annual_profit: numOrNull(el('wcAnnualProfit').value),
                receivables: numOrNull(el('wcReceivables').value),
                inventory: numOrNull(el('wcInventory').value),
                creditors: numOrNull(el('wcCreditors').value),
                existing_liabilities: numOrNull(el('wcExistingLiabilities').value)
            },
            banking: {
                primary_bank_name: el('wcPrimaryBankName').value.trim(),
                banking_years: numOrNull(el('wcBankingYears').value),
                avg_monthly_balance: numOrNull(el('wcAvgMonthlyBalance').value)
            },
            existing: hasExisting ? {
                facility_type: el('wcExistingFacilityType').value,
                bank_name: el('wcExistingBankName').value.trim(),
                account_number: el('wcExistingAccountNumber').value.trim(),
                limit_amount: numOrNull(el('wcExistingLimit').value),
                current_utilisation: numOrNull(el('wcCurrentUtilisation').value),
                outstanding: numOrNull(el('wcExistingOutstanding').value)
            } : {
                facility_type: el('wcExistingFacilityType').value || 'None'
            },
            requirement: {
                request_type: el('wcRequestType').value,
                proposed_limit: numOrNull(el('wcProposedLimit').value),
                purpose: el('wcBusinessPurpose').value,
                security_type: securityType,
                security_details: el('wcSecurityDetails').value.trim(),
                collateral_value: securityType === 'Property Collateral'
                    ? numOrNull(el('wcCollateralValue').value) : null,
                preferred_tenure_months: numOrNull(el('wcPreferredTenure').value)
            },
            address: {
                current: {
                    line: el('wcCurrentAddressLine').value.trim(),
                    city: el('wcCurrentCity').value.trim(),
                    state: el('wcCurrentState').value,
                    pincode: el('wcCurrentPincode').value.trim()
                },
                same_as_current: el('wcSameAsCurrent').checked,
                permanent: {
                    line: el('wcPermanentAddressLine').value.trim(),
                    city: el('wcPermanentCity').value.trim(),
                    state: el('wcPermanentState').value,
                    pincode: el('wcPermanentPincode').value.trim()
                }
            },
            facilities: collectFacilities(),
            co_applicants: Array.prototype.map.call(coList.querySelectorAll('.cp-applicant'), collectApplicant),
            guarantors: Array.prototype.map.call(guarList.querySelectorAll('.cp-applicant'), collectApplicant),
            consent: true,
            consent_version: D.CONSENT_VERSION,
            source_page: window.location.pathname
        };
    }

    /* ------------------------------------------------------------------ *
     * Document checklist + review
     * ------------------------------------------------------------------ */

    function checklistGroups() {
        var payload = buildPayload();
        var hasGstin = !!payload.business.gstin;
        var hasUdyam = !!payload.business.udyam_number;
        var hasExisting = payload.existing.facility_type &&
            payload.existing.facility_type !== 'None';
        var isTakeover = payload.requirement.request_type === 'Takeover';
        var isProperty = payload.requirement.security_type === 'Property Collateral';

        var groups = [];

        groups.push({
            title: 'Identity & address',
            items: [
                { label: 'PAN card (mandatory)', required: true },
                { label: 'Aadhaar card (identity verification)', required: true },
                { label: 'Passport-size photograph', required: true },
                { label: 'Utility bill or rent agreement as address proof', required: false }
            ]
        });

        groups.push({
            title: 'Business proof & registrations',
            items: [
                { label: 'Business registration certificate / proof of constitution', required: true },
                { label: 'GST returns - last 4 quarters', required: hasGstin },
                { label: 'Udyam certificate', required: hasUdyam },
                { label: 'Shop & establishment or trade licence', required: false }
            ]
        });

        groups.push({
            title: 'Financial documents',
            items: [
                { label: 'ITR - last 2 years', required: true },
                { label: 'Audited balance sheet and profit & loss - last 2 years', required: true },
                { label: 'Bank statement - last 12 months', required: true },
                { label: 'Stock statement (latest)', required: true },
                { label: 'Debtors and creditors statement (latest)', required: true }
            ]
        });

        if (hasExisting) {
            groups.push({
                title: 'Existing facility documents',
                items: [
                    { label: 'Existing CC/OD sanction letter', required: true },
                    { label: 'Latest CC/OD account statement', required: true },
                    { label: 'Renewal or foreclosure statement', required: isTakeover }
                ]
            });
        }

        if (isProperty) {
            groups.push({
                title: 'Collateral documents',
                items: [
                    { label: 'Property ownership documents', required: true },
                    { label: 'Title chain and property tax receipt', required: true },
                    { label: 'Latest property valuation report', required: false }
                ]
            });
        }

        return groups;
    }

    function renderChecklist() {
        var container = el('wcDocChecklist');
        var groups = checklistGroups();
        container.innerHTML = groups.map(function (group) {
            var items = group.items.map(function (item) {
                return '<div class="cp-check-item' + (item.required ? '' : ' is-optional') + '">' +
                    '<i class="fa fa-' + (item.required ? 'check-circle' : 'circle-o') + '"></i>' +
                    '<span>' + D.escapeHtml(item.label) + (item.required ? '' : ' (optional)') + '</span></div>';
            }).join('');
            return '<div class="cp-checklist-group"><h4>' + D.escapeHtml(group.title) + '</h4>' + items + '</div>';
        }).join('');
    }

    function reviewRow(label, value) {
        return '<div class="cp-review-row"><span>' + D.escapeHtml(label) + '</span><span>' +
            D.escapeHtml(value || '\u2014') + '</span></div>';
    }

    function renderReview() {
        var p = buildPayload();
        var blocks = [];

        blocks.push({
            step: 0,
            title: 'Applicant & personal addresses',
            rows: [
                reviewRow('Name', fullName() || '\u2014'),
                reviewRow('Date of birth', p.personal.date_of_birth),
                reviewRow('Mobile', p.personal.mobile),
                reviewRow('Email', p.personal.email),
                reviewRow('PAN', p.personal.pan_number),
                reviewRow('Aadhaar', p.personal.aadhaar_number ? ('XXXX XXXX ' + p.personal.aadhaar_number.slice(-4)) : 'Not provided'),
                reviewRow('Role in business', p.personal.applicant_role),
                reviewRow('Current address', [p.address.current.line, p.address.current.city, p.address.current.state, p.address.current.pincode].filter(Boolean).join(', ')),
                reviewRow('Permanent address', p.address.same_as_current
                    ? 'Same as current'
                    : [p.address.permanent.line, p.address.permanent.city, p.address.permanent.state, p.address.permanent.pincode].filter(Boolean).join(', '))
            ]
        });

        blocks.push({
            step: 1,
            title: 'Business entity',
            rows: [
                reviewRow('Business name', p.business.name),
                reviewRow('Constitution', p.business.constitution),
                reviewRow('Industry', p.business.industry),
                reviewRow('Nature of business', p.business.nature_of_business),
                reviewRow('Established', p.business.establishment_date),
                reviewRow('Business vintage', p.business.business_vintage_years !== null ? (p.business.business_vintage_years + ' years') : ''),
                reviewRow('Partners / directors', p.business.partner_director_count !== null ? String(p.business.partner_director_count) : ''),
                reviewRow('Business ownership', p.business.ownership),
                reviewRow('GSTIN', p.business.gstin),
                reviewRow('Business PAN', p.business.business_pan),
                reviewRow('Udyam number', p.business.udyam_number)
            ]
        });

        blocks.push({
            step: 2,
            title: 'Business addresses',
            rows: [
                reviewRow('Registered', [p.registered_address.line, p.registered_address.city, p.registered_address.state, p.registered_address.pincode].filter(Boolean).join(', ')),
                reviewRow('Operating', p.business.operating_same_as_registered
                    ? 'Same as registered'
                    : [p.operating_address.line, p.operating_address.city, p.operating_address.state, p.operating_address.pincode].filter(Boolean).join(', '))
            ]
        });

        blocks.push({
            step: 3,
            title: 'Financials & banking',
            rows: [
                reviewRow('Annual turnover', money(p.finance.annual_turnover)),
                reviewRow('Average monthly sales', p.finance.monthly_sales !== null ? money(p.finance.monthly_sales) : '\u2014'),
                reviewRow('Annual net profit', p.finance.annual_profit !== null ? money(p.finance.annual_profit) : '\u2014'),
                reviewRow('Receivables', p.finance.receivables !== null ? money(p.finance.receivables) : '\u2014'),
                reviewRow('Inventory / stock', p.finance.inventory !== null ? money(p.finance.inventory) : '\u2014'),
                reviewRow('Creditors', p.finance.creditors !== null ? money(p.finance.creditors) : '\u2014'),
                reviewRow('Existing liabilities', p.finance.existing_liabilities !== null ? money(p.finance.existing_liabilities) : '\u2014'),
                reviewRow('Primary bank', p.banking.primary_bank_name),
                reviewRow('Banking relationship', p.banking.banking_years !== null ? (p.banking.banking_years + ' years') : '\u2014'),
                reviewRow('Avg monthly balance', p.banking.avg_monthly_balance !== null ? money(p.banking.avg_monthly_balance) : '\u2014')
            ]
        });

        var existingRows = [];
        if (p.existing.facility_type && p.existing.facility_type !== 'None') {
            existingRows.push(reviewRow('Existing facility', p.existing.facility_type));
            existingRows.push(reviewRow('Bank / NBFC', p.existing.bank_name));
            existingRows.push(reviewRow('Sanctioned limit', p.existing.limit_amount !== null ? money(p.existing.limit_amount) : '\u2014'));
            existingRows.push(reviewRow('Current utilisation', p.existing.current_utilisation !== null ? money(p.existing.current_utilisation) : '\u2014'));
            existingRows.push(reviewRow('Outstanding', p.existing.outstanding !== null ? money(p.existing.outstanding) : '\u2014'));
        } else {
            existingRows.push(reviewRow('Existing CC/OD', 'None declared'));
        }
        p.facilities.forEach(function (facility, index) {
            existingRows.push(reviewRow('Other facility ' + (index + 1),
                (facility.bank_name || '') +
                (facility.facility_type ? ' - ' + facility.facility_type : '') +
                (facility.sanctioned_limit !== null ? ' - ' + money(facility.sanctioned_limit) : '')));
        });
        blocks.push({ step: 4, title: 'Existing CC/OD position', rows: existingRows });

        blocks.push({
            step: 5,
            title: 'Requested facility',
            rows: [
                reviewRow('Request type', p.requirement.request_type),
                reviewRow('Proposed limit', money(p.requirement.proposed_limit)),
                reviewRow('Business purpose', p.requirement.purpose),
                reviewRow('Security / collateral', p.requirement.security_type),
                reviewRow('Collateral value', p.requirement.collateral_value !== null ? money(p.requirement.collateral_value) : '\u2014'),
                reviewRow('Security details', p.requirement.security_details),
                reviewRow('Preferred tenure', p.requirement.preferred_tenure_months ? (p.requirement.preferred_tenure_months + ' months') : '\u2014'),
                reviewRow('Indicative monthly interest', money(Math.round(p.requirement.proposed_limit * 0.12 / 12)))
            ]
        });

        var applicantRows = [];
        if (p.co_applicants.length) {
            p.co_applicants.forEach(function (a) {
                applicantRows.push(reviewRow('Co-applicant', a.full_name + (a.relationship ? ' (' + a.relationship + ')' : '')));
            });
        }
        if (p.guarantors.length) {
            p.guarantors.forEach(function (a) {
                applicantRows.push(reviewRow('Guarantor', a.full_name + (a.relationship ? ' (' + a.relationship + ')' : '')));
            });
        }
        if (!applicantRows.length) { applicantRows.push(reviewRow('Applicants', 'None added')); }
        blocks.push({ step: 6, title: 'Co-applicants & guarantors', rows: applicantRows });

        el('wcReviewSummary').innerHTML = blocks.map(function (block) {
            var rows = Array.isArray(block.rows) ? block.rows.join('') : block.rows;
            return '<div class="cp-review-block">' +
                '<h4><span>' + D.escapeHtml(block.title) + '</span>' +
                '<button type="button" data-goto="' + block.step + '">Edit</button></h4>' +
                rows + '</div>';
        }).join('');
    }

    el('wcReviewSummary').addEventListener('click', function (event) {
        var btn = event.target.closest('[data-goto]');
        if (!btn) { return; }
        showStep(Number(btn.getAttribute('data-goto')), true);
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
        return window.location.origin + window.location.pathname + '#draft=' + encodeURIComponent(draftId) + '&token=' + encodeURIComponent(draftToken);
    }

    async function saveDraft(silent) {
        var payload = buildPayload();
        var params = { p_payload: payload, p_draft_id: draftId, p_draft_token: draftToken };
        var result = await D.rpc('save_home_loan_draft', params);
        if (result && result.draft_id) {
            draftId = result.draft_id;
            draftToken = result.draft_token;
            storeDraft(draftId, draftToken);
        }
        return result;
    }

    saveDraftBtn.addEventListener('click', async function () {
        D.hideAlert(alertBox);
        D.setLoading(saveDraftBtn, true, 'Saving…');
        try {
            await saveDraft(false);
            if (draftBar) {
                draftBar.classList.remove('cp-hidden');
                draftBarText.innerHTML = 'Draft saved. Resume any time with this link: <code>' + D.escapeHtml(resumeLink()) + '</code>';
            }
            D.showAlert(alertBox, 'success',
                'Your application has been saved. Bookmark this page or keep the resume link to continue later.',
                'Draft saved');
        } catch (err) {
            console.error('Draft save failed:', err);
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
            draftBarText.innerHTML = 'Draft restored. Resume link: <code>' + D.escapeHtml(resumeLink()) + '</code>';
        }
    }

    function applyPayload(payload) {
        var personal = payload.personal || {};
        var business = payload.business || {};
        var registered = payload.registered_address || {};
        var operating = payload.operating_address || {};
        var finance = payload.finance || {};
        var banking = payload.banking || {};
        var existing = payload.existing || {};
        var requirement = payload.requirement || {};
        var address = payload.address || {};

        el('wcFirstName').value = personal.first_name || '';
        el('wcMiddleName').value = personal.middle_name || '';
        el('wcLastName').value = personal.last_name || '';
        el('wcDob').value = personal.date_of_birth || '';
        el('wcGender').value = personal.gender || '';
        el('wcMaritalStatus').value = personal.marital_status || '';
        el('wcMobile').value = personal.mobile || '';
        el('wcEmail').value = personal.email || '';
        el('wcPan').value = personal.pan_number || '';
        el('wcAadhaar').value = personal.aadhaar_number || '';
        el('wcApplicantRole').value = personal.applicant_role || '';

        el('wcBusinessName').value = business.name || '';
        el('wcBusinessConstitution').value = business.constitution || '';
        el('wcIndustry').value = business.industry || '';
        el('wcNatureOfBusiness').value = business.nature_of_business || '';
        el('wcEstablishmentDate').value = business.establishment_date || '';
        el('wcBusinessVintage').value = business.business_vintage_years || '';
        el('wcPartnerDirectorCount').value = business.partner_director_count || '';
        el('wcBusinessOwnership').value = business.ownership || '';
        el('wcGstin').value = business.gstin || '';
        el('wcBusinessPan').value = business.business_pan || '';
        el('wcUdyamNumber').value = business.udyam_number || '';

        el('wcRegisteredAddressLine').value = registered.line || '';
        el('wcRegisteredCity').value = registered.city || '';
        el('wcRegisteredState').value = registered.state || '';
        el('wcRegisteredPincode').value = registered.pincode || '';

        el('wcOperatingSameAsRegistered').checked = business.operating_same_as_registered !== false;
        el('wcOperatingAddressLine').value = operating.line || '';
        el('wcOperatingCity').value = operating.city || '';
        el('wcOperatingState').value = operating.state || '';
        el('wcOperatingPincode').value = operating.pincode || '';

        el('wcAnnualTurnover').value = finance.annual_turnover || '';
        el('wcMonthlySales').value = finance.monthly_sales || '';
        el('wcAnnualProfit').value = finance.annual_profit || '';
        el('wcReceivables').value = finance.receivables || '';
        el('wcInventory').value = finance.inventory || '';
        el('wcCreditors').value = finance.creditors || '';
        el('wcExistingLiabilities').value = finance.existing_liabilities || '';

        el('wcPrimaryBankName').value = banking.primary_bank_name || '';
        el('wcBankingYears').value = banking.banking_years || '';
        el('wcAvgMonthlyBalance').value = banking.avg_monthly_balance || '';

        el('wcExistingFacilityType').value = existing.facility_type || '';
        el('wcExistingBankName').value = existing.bank_name || '';
        el('wcExistingAccountNumber').value = existing.account_number || '';
        el('wcExistingLimit').value = existing.limit_amount || '';
        el('wcCurrentUtilisation').value = existing.current_utilisation || '';
        el('wcExistingOutstanding').value = existing.outstanding || '';

        el('wcRequestType').value = requirement.request_type || '';
        el('wcProposedLimit').value = requirement.proposed_limit || '';
        el('wcBusinessPurpose').value = requirement.purpose || '';
        el('wcSecurityType').value = requirement.security_type || '';
        el('wcSecurityDetails').value = requirement.security_details || '';
        el('wcCollateralValue').value = requirement.collateral_value || '';
        if (requirement.preferred_tenure_months) {
            el('wcPreferredTenure').value = String(requirement.preferred_tenure_months);
        }

        facilityList.innerHTML = '';
        (Array.isArray(payload.facilities) ? payload.facilities : []).forEach(function (facility) {
            facilitySeq += 1;
            facilityList.insertAdjacentHTML('beforeend', facilityTemplate(facilitySeq));
            var card = facilityList.lastElementChild;
            ['bank_name', 'facility_type', 'account_number', 'sanctioned_limit',
             'current_utilisation', 'outstanding_amount', 'interest_rate', 'renewal_date']
                .forEach(function (key) {
                    var field = card.querySelector('[data-field="' + key + '"]');
                    if (field) { field.value = facility[key] || ''; }
                });
        });
        updateFacilityState();

        var currentAddr = address.current || {};
        el('wcCurrentAddressLine').value = currentAddr.line || '';
        el('wcCurrentCity').value = currentAddr.city || '';
        el('wcCurrentState').value = currentAddr.state || '';
        el('wcCurrentPincode').value = currentAddr.pincode || '';

        var permanentAddr = address.permanent || {};
        el('wcSameAsCurrent').checked = !!address.same_as_current;
        el('wcPermanentAddressLine').value = permanentAddr.line || '';
        el('wcPermanentCity').value = permanentAddr.city || '';
        el('wcPermanentState').value = permanentAddr.state || '';
        el('wcPermanentPincode').value = permanentAddr.pincode || '';

        coList.innerHTML = '';
        (Array.isArray(payload.co_applicants) ? payload.co_applicants : []).forEach(function (a) {
            coSeq += 1;
            coList.insertAdjacentHTML('beforeend', applicantTemplate('co_applicant', coList.querySelectorAll('.cp-applicant').length + 1, coSeq));
            fillApplicant(coList.lastElementChild, a);
        });
        guarList.innerHTML = '';
        (Array.isArray(payload.guarantors) ? payload.guarantors : []).forEach(function (a) {
            guarSeq += 1;
            guarList.insertAdjacentHTML('beforeend', applicantTemplate('guarantor', guarList.querySelectorAll('.cp-applicant').length + 1, guarSeq));
            fillApplicant(guarList.lastElementChild, a);
        });
        updateAddButtons();

        syncOperatingAddress();
        syncPermanentAddress();
        syncExistingFacility();
        syncSecurity();
        updateInterestEstimate();
    }

    function fillApplicant(card, data) {
        ['full_name', 'relationship', 'date_of_birth', 'mobile', 'email', 'employment_type', 'employer_name', 'monthly_income']
            .forEach(function (key) {
                var field = card.querySelector('[data-field="' + key + '"]');
                if (field) { field.value = data[key] || ''; }
            });
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
        facilityList.innerHTML = '';
        coList.innerHTML = '';
        guarList.innerHTML = '';
        updateFacilityState();
        updateAddButtons();
        syncOperatingAddress();
        syncPermanentAddress();
        syncExistingFacility();
        syncSecurity();
        updateInterestEstimate();
        if (draftBar) { draftBar.classList.add('cp-hidden'); }
        D.clearErrors(form);
        D.hideAlert(alertBox);
        maxStep = 0;
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
        D.setLoading(el('resumeDraftBtn'), true, 'Loading…');
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
                D.notify('success', 'Draft restored', 'Your saved working capital application has been loaded.');
                return;
            } catch (err) {
                console.warn('Failed to resume draft from link:', err);
                D.showAlert(alertBox, 'warning',
                    'The resume link could not be loaded. ' + D.friendlyError(err),
                    'Draft unavailable');
            }
        }
        if (readStoredDraft() && draftBar) {
            draftBar.classList.remove('cp-hidden');
            draftBarText.textContent = 'We found a saved draft of your working capital application on this device.';
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
        // Best-effort save so a refresh or revisit keeps the progress.
        saveDraft(true).catch(function (err) { console.warn('Background draft save failed:', err); });
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

        for (var i = 0; i < TOTAL_STEPS - 1; i++) {
            if (!validateStep(i)) {
                showStep(i, true);
                focusFirstError();
                return;
            }
        }

        var consent = el('wcApplicationConsent');
        if (!consent.checked) {
            D.showAlert(alertBox, 'warning',
                'Please accept the privacy notice and confirm your details before submitting.',
                'Consent required');
            consent.focus();
            return;
        }

        var payload = buildPayload();
        D.setLoading(submitBtn, true, 'Submitting application…');
        try {
            var result = await D.rpc('submit_working_capital_application', {
                p_payload: payload,
                p_draft_id: draftId,
                p_draft_token: draftToken
            });
            clearStoredDraft();
            showSuccess(result);
        } catch (err) {
            console.error('Working capital submission failed:', err);
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
            // Keep the secret token in the URL fragment so it never reaches the
            // static server or Referer logs.
            link.href = 'upload-documents.html#id=' + encodeURIComponent(result.id) +
                '&token=' + encodeURIComponent(result.access_token) +
                '&ref=' + encodeURIComponent(result.reference_no);
        }
        D.showAlert(alertBox, 'success',
            'Your working capital application has been received. Reference: ' + (result.reference_no || '\u2014') + '.',
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
        if (event.target.id === 'wcProposedLimit') { updateInterestEstimate(); }
    });

    form.addEventListener('change', function (event) {
        if (event.target.classList.contains('form-control')) {
            D.clearFieldError(event.target);
        }
        if (event.target.id === 'wcOperatingSameAsRegistered') { syncOperatingAddress(); }
        if (event.target.id === 'wcSameAsCurrent') { syncPermanentAddress(); }
        if (event.target.id === 'wcExistingFacilityType') { syncExistingFacility(); }
        if (event.target.id === 'wcSecurityType') { syncSecurity(); }
        if (event.target.id === 'wcProposedLimit') { updateInterestEstimate(); }
        if (['wcRegisteredAddressLine', 'wcRegisteredCity', 'wcRegisteredState', 'wcRegisteredPincode'].indexOf(event.target.id) !== -1
            && el('wcOperatingSameAsRegistered').checked) { syncOperatingAddress(); }
        if (['wcCurrentAddressLine', 'wcCurrentCity', 'wcCurrentState', 'wcCurrentPincode'].indexOf(event.target.id) !== -1
            && el('wcSameAsCurrent').checked) { syncPermanentAddress(); }
    });

    /* ------------------------------------------------------------------ *
     * Boot
     * ------------------------------------------------------------------ */

    function boot() {
        initOptions();
        updateFacilityState();
        updateAddButtons();
        syncOperatingAddress();
        syncPermanentAddress();
        syncExistingFacility();
        syncSecurity();
        updateInterestEstimate();
        showStep(0, false);
        initDraft();
    }

    boot();
})(window, document);

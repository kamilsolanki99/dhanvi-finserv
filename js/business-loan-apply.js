/**
 * Dhanvi Finserv - multi-step Business Loan application wizard.
 *
 * Depends on: js/nhost-client.js, js/public-api.js
 *
 * Flow
 *   1-7  collect applicant, business entity, registered / operating address,
 *        financials, existing business loans, loan requirement and
 *        co-applicant / guarantor details
 *   8    conditional document checklist, review and consent
 *
 * Save / resume
 *   A server-side draft is created through save_home_loan_draft() (shared with
 *   the Home Loan wizard) as soon as the first step validates, and refreshed
 *   on every step change. The draft id + secret token are kept in localStorage
 *   so the applicant can resume in the same browser, and "Save & continue
 *   later" also shows a resume link. Submitting promotes the draft into a real
 *   Business Loan application through submit_business_loan_application().
 */
(function (window, document) {
    'use strict';

    var D = window.Dhanvi;
    var form = document.getElementById('businessLoanForm');
    if (!form || !D) { return; }

    var DRAFT_KEY = 'dhanviBusinessLoanDraft';
    var TOTAL_STEPS = 8;

    var alertBox = document.getElementById('applicationAlert');
    var draftBar = document.getElementById('draftBar');
    var draftBarText = document.getElementById('draftBarText');
    var successBox = document.getElementById('applicationSuccess');
    var stepper = document.getElementById('blStepper');
    var steps = Array.prototype.slice.call(form.querySelectorAll('.cp-step'));
    var prevBtn = document.getElementById('prevBtn');
    var nextBtn = document.getElementById('nextBtn');
    var submitBtn = document.getElementById('submitBtn');
    var saveDraftBtn = document.getElementById('saveDraftBtn');
    var progressText = document.getElementById('progressText');

    var emiList = document.getElementById('blEmiList');
    var emiPlaceholder = document.getElementById('blEmiPlaceholder');
    var addEmiBtn = document.getElementById('blAddEmi');
    var coList = document.getElementById('blCoApplicantList');
    var guarList = document.getElementById('blGuarantorList');
    var addCoBtn = document.getElementById('blAddCoApplicant');
    var addGuarBtn = document.getElementById('blAddGuarantor');

    var current = 0;
    var maxStep = 0;
    var draftId = null;
    var draftToken = null;
    var coSeq = 0;
    var guarSeq = 0;
    var emiSeq = 0;
    var MAX_CO = 3;
    var MAX_GUAR = 2;
    var MAX_EMI = 10;

    var STATES = ['Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry'];
    var RELATIONSHIPS = ['Spouse', 'Parent', 'Sibling', 'Son', 'Daughter', 'Business partner', 'Friend', 'Other'];
    var EMPLOYMENT = ['Salaried', 'Self-employed / business', 'Professional', 'Retired', 'Other'];
    var EMI_LOAN_TYPES = ['Business Loan', 'Working Capital', 'Term Loan', 'Machinery Loan', 'Vehicle Loan', 'Personal Loan', 'Credit Card', 'Other'];
    var CONSTITUTIONS = ['Proprietorship', 'Partnership', 'LLP', 'Private Limited'];
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
        return [el('blFirstName').value, el('blMiddleName').value, el('blLastName').value]
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
        ['blRegisteredState', 'blOperatingState', 'blCurrentState', 'blPermanentState'].forEach(function (id) {
            var select = el(id);
            if (!select) { return; }
            select.innerHTML = '<option value="">Select state</option>' + optionList(STATES);
        });

        var tenure = el('blRepaymentTenure');
        var options = '';
        for (var months = 6; months <= 240; months += 6) {
            var label = months + ' months';
            if (months % 12 === 0) {
                var years = months / 12;
                label += ' (' + years + (years === 1 ? ' year' : ' years') + ')';
            }
            options += '<option value="' + months + '"' + (months === 36 ? ' selected' : '') + '>' + label + '</option>';
        }
        tenure.innerHTML = options;

        var dob = el('blDob');
        var today = new Date();
        var min = new Date(today.getFullYear() - 75, today.getMonth(), today.getDate());
        var max = new Date(today.getFullYear() - 18, today.getMonth(), today.getDate());
        dob.setAttribute('min', isoDate(min));
        dob.setAttribute('max', isoDate(max));

        var established = el('blEstablishmentDate');
        if (established) { established.setAttribute('max', D.todayISO(0)); }
    }

    /* ------------------------------------------------------------------ *
     * Existing business loan rows
     * ------------------------------------------------------------------ */

    function emiTemplate(seq) {
        var prefix = 'blEmi' + seq;
        return '' +
            '<div class="cp-applicant" data-emi="' + prefix + '">' +
                '<div class="cp-applicant-head">' +
                    '<h4>Existing loan</h4>' +
                    '<button type="button" class="cp-remove" data-remove-emi><i class="fa fa-trash-o"></i> Remove</button>' +
                '</div>' +
                '<div class="cp-grid">' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Bank">Bank / lender <span class="cp-req">*</span></label>' +
                        '<input type="text" class="form-control" id="' + prefix + 'Bank" data-field="bank_name" placeholder="e.g. HDFC Bank">' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Type">Loan type</label>' +
                        '<select class="form-control" id="' + prefix + 'Type" data-field="loan_type">' +
                            '<option value="">Select loan type</option>' + optionList(EMI_LOAN_TYPES) +
                        '</select>' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Outstanding">Outstanding (&#8377;)</label>' +
                        '<input type="number" class="form-control" id="' + prefix + 'Outstanding" data-field="outstanding_amount" min="0" step="1000" placeholder="e.g. 800000">' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Emi">Monthly EMI (&#8377;)</label>' +
                        '<input type="number" class="form-control" id="' + prefix + 'Emi" data-field="monthly_emi" min="0" step="100" placeholder="e.g. 18000">' +
                    '</div></div>' +
                '</div>' +
            '</div>';
    }

    function updateEmiState() {
        var count = emiList.querySelectorAll('[data-emi]').length;
        emiPlaceholder.classList.toggle('cp-hidden', count > 0);
        addEmiBtn.disabled = count >= MAX_EMI;
        addEmiBtn.innerHTML = '<i class="fa fa-plus"></i> Add existing loan' + (count >= MAX_EMI ? ' (max ' + MAX_EMI + ')' : '');
    }

    addEmiBtn.addEventListener('click', function () {
        if (emiList.querySelectorAll('[data-emi]').length >= MAX_EMI) { return; }
        emiSeq += 1;
        emiList.insertAdjacentHTML('beforeend', emiTemplate(emiSeq));
        updateEmiState();
        emiList.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    emiList.addEventListener('click', function (event) {
        var removeBtn = event.target.closest('[data-remove-emi]');
        if (!removeBtn) { return; }
        var card = removeBtn.closest('[data-emi]');
        if (card) { card.remove(); }
        updateEmiState();
    });

    function collectEmis() {
        return Array.prototype.map.call(emiList.querySelectorAll('[data-emi]'), function (card) {
            var data = {};
            Array.prototype.forEach.call(card.querySelectorAll('[data-field]'), function (input) {
                data[input.getAttribute('data-field')] = input.value.trim();
            });
            return {
                bank_name: data.bank_name,
                loan_type: data.loan_type || '',
                outstanding_amount: numOrNull(data.outstanding_amount),
                monthly_emi: numOrNull(data.monthly_emi)
            };
        }).filter(function (emi) { return emi.bank_name !== ''; });
    }

    /* ------------------------------------------------------------------ *
     * Co-applicant / guarantor cards
     * ------------------------------------------------------------------ */

    function applicantTemplate(role, index, seq) {
        var isCo = role === 'co_applicant';
        var prefix = (isCo ? 'blCo' : 'blGuar') + seq;
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

    function syncConstitution() {
        var constitution = el('blBusinessConstitution').value;
        var isProprietorship = constitution === 'Proprietorship';
        var isMultiOwner = constitution === 'Partnership' || constitution === 'LLP' || constitution === 'Private Limited';
        el('blBusinessOwnershipField').classList.toggle('cp-hidden', !isProprietorship);
        el('blPartnerDirectorField').classList.toggle('cp-hidden', !isMultiOwner);
    }

    function syncOperatingAddress() {
        var same = el('blOperatingSameAsRegistered').checked;
        el('blOperatingAddressBlock').classList.toggle('cp-hidden', same);
        if (same) {
            copyFields([
                ['blRegisteredAddressLine', 'blOperatingAddressLine'],
                ['blRegisteredCity', 'blOperatingCity'],
                ['blRegisteredState', 'blOperatingState'],
                ['blRegisteredPincode', 'blOperatingPincode']
            ]);
        }
    }

    function syncPermanentAddress() {
        var same = el('blSameAsCurrent').checked;
        el('blPermanentAddressBlock').classList.toggle('cp-hidden', same);
        if (same) {
            copyFields([
                ['blCurrentAddressLine', 'blPermanentAddressLine'],
                ['blCurrentCity', 'blPermanentCity'],
                ['blCurrentState', 'blPermanentState'],
                ['blCurrentPincode', 'blPermanentPincode']
            ]);
        }
    }

    function updateEmiEstimate() {
        var principal = numOrNull(el('blRequiredAmount').value);
        var months = numOrNull(el('blRepaymentTenure').value);
        var box = el('blEmiEstimate');
        if (!principal || !months) {
            box.textContent = 'Enter the loan amount and tenure to see an indicative EMI at 15% p.a.';
            return;
        }
        var rate = 15 / 12 / 100;
        var emi = principal * rate * Math.pow(1 + rate, months) / (Math.pow(1 + rate, months) - 1);
        box.innerHTML = 'Approximate EMI: <strong>' + money(Math.round(emi)) + '</strong> per month ' +
            '(indicative at 15% p.a. for ' + months + ' months). Actual rate and EMI are decided by your lender.';
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
            var first = el('blFirstName'), last = el('blLastName'), dob = el('blDob');
            var mobile = el('blMobile'), email = el('blEmail'), pan = el('blPan'), aadhaar = el('blAadhaar');

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
                } else if (age > 75) {
                    D.setFieldError(dob, 'The applicant age must be 75 years or below.');
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
        }

        if (index === 1) {
            var businessName = el('blBusinessName');
            var constitution = el('blBusinessConstitution');
            var established = el('blEstablishmentDate');

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
            var gstin = el('blGstin');
            if (gstin.value.trim() && !GSTIN_RE.test(gstin.value.trim().toUpperCase())) {
                D.setFieldError(gstin, 'Enter a valid 15-character GSTIN (e.g. 22ABCDE1234F1Z5).');
                ok = false;
            }
            var businessPan = el('blBusinessPan');
            if (businessPan.value.trim() && !PAN_RE.test(businessPan.value.trim().toUpperCase())) {
                D.setFieldError(businessPan, 'Enter a valid business PAN (e.g. ABCDE1234F).');
                ok = false;
            }
        }

        if (index === 2) {
            [['blRegisteredAddressLine', 'Enter your registered address.'],
             ['blRegisteredCity', 'Enter your registered city.'],
             ['blRegisteredState', 'Select your registered state.'],
             ['blRegisteredPincode', 'Enter your 6-digit PIN code.']].forEach(function (pair) {
                var field = el(pair[0]);
                if (!field.value.trim()) { D.setFieldError(field, pair[1]); ok = false; }
            });
            var regPin = el('blRegisteredPincode');
            if (regPin.value.trim() && !/^[0-9]{6}$/.test(regPin.value.trim())) {
                D.setFieldError(regPin, 'Enter a valid 6-digit PIN code.');
                ok = false;
            }
            if (!el('blOperatingSameAsRegistered').checked) {
                [['blOperatingAddressLine', 'Enter your operating address.'],
                 ['blOperatingCity', 'Enter your operating city.'],
                 ['blOperatingState', 'Select your operating state.'],
                 ['blOperatingPincode', 'Enter your 6-digit PIN code.']].forEach(function (pair) {
                    var field = el(pair[0]);
                    if (!field.value.trim()) { D.setFieldError(field, pair[1]); ok = false; }
                });
                var opPin = el('blOperatingPincode');
                if (opPin.value.trim() && !/^[0-9]{6}$/.test(opPin.value.trim())) {
                    D.setFieldError(opPin, 'Enter a valid 6-digit PIN code.');
                    ok = false;
                }
            }
        }

        if (index === 3) {
            var turnover = el('blAnnualTurnover');
            if (!turnover.value || Number(turnover.value) <= 0) {
                D.setFieldError(turnover, 'Enter your annual business turnover.');
                ok = false;
            }
        }

        if (index === 4) {
            Array.prototype.forEach.call(emiList.querySelectorAll('[data-emi]'), function (card) {
                var bank = card.querySelector('[data-field="bank_name"]');
                if (!bank.value.trim()) { D.setFieldError(bank, 'Enter the bank or lender name.'); ok = false; }
            });
        }

        if (index === 5) {
            var requiredAmount = el('blRequiredAmount');
            var purpose = el('blLoanPurpose');
            var tenure = el('blRepaymentTenure');
            var preferred = el('blPreferredEmi');

            if (!requiredAmount.value || Number(requiredAmount.value) < 50000) {
                D.setFieldError(requiredAmount, 'Enter a loan amount of at least \u20B950,000.');
                ok = false;
            }
            if (!purpose.value) { D.setFieldError(purpose, 'Select the purpose of the loan.'); ok = false; }
            if (tenure.value) {
                var months = Number(tenure.value);
                if (months < 6 || months > 240) {
                    D.setFieldError(tenure, 'The tenure must be between 6 and 240 months.');
                    ok = false;
                }
            }
            if (preferred.value && Number(preferred.value) < 0) {
                D.setFieldError(preferred, 'Enter a valid preferred EMI.');
                ok = false;
            }
        }

        if (index === 6) {
            [['blCurrentAddressLine', 'Enter your current address.'],
             ['blCurrentCity', 'Enter your city.'],
             ['blCurrentState', 'Select your state.'],
             ['blCurrentPincode', 'Enter your 6-digit PIN code.']].forEach(function (pair) {
                var field = el(pair[0]);
                if (!field.value.trim()) { D.setFieldError(field, pair[1]); ok = false; }
            });
            var curPin = el('blCurrentPincode');
            if (curPin.value.trim() && !/^[0-9]{6}$/.test(curPin.value.trim())) {
                D.setFieldError(curPin, 'Enter a valid 6-digit PIN code.');
                ok = false;
            }
            if (!el('blSameAsCurrent').checked) {
                [['blPermanentAddressLine', 'Enter your permanent address.'],
                 ['blPermanentCity', 'Enter your city.'],
                 ['blPermanentState', 'Select your state.'],
                 ['blPermanentPincode', 'Enter your 6-digit PIN code.']].forEach(function (pair) {
                    var field = el(pair[0]);
                    if (!field.value.trim()) { D.setFieldError(field, pair[1]); ok = false; }
                });
                var perPin = el('blPermanentPincode');
                if (perPin.value.trim() && !/^[0-9]{6}$/.test(perPin.value.trim())) {
                    D.setFieldError(perPin, 'Enter a valid 6-digit PIN code.');
                    ok = false;
                }
            }
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
        return {
            personal: {
                first_name: el('blFirstName').value.trim(),
                middle_name: el('blMiddleName').value.trim(),
                last_name: el('blLastName').value.trim(),
                date_of_birth: el('blDob').value || '',
                gender: el('blGender').value,
                marital_status: el('blMaritalStatus').value,
                mobile: el('blMobile').value.trim(),
                email: el('blEmail').value.trim(),
                pan_number: el('blPan').value.trim().toUpperCase(),
                aadhaar_number: D.digits(el('blAadhaar').value),
                applicant_role: el('blApplicantRole').value
            },
            business: {
                name: el('blBusinessName').value.trim(),
                constitution: el('blBusinessConstitution').value,
                industry: el('blIndustry').value.trim(),
                nature_of_business: el('blNatureOfBusiness').value.trim(),
                establishment_date: el('blEstablishmentDate').value || '',
                partner_director_count: numOrNull(el('blPartnerDirectorCount').value),
                ownership: el('blBusinessOwnership').value.trim(),
                gstin: el('blGstin').value.trim().toUpperCase(),
                business_pan: el('blBusinessPan').value.trim().toUpperCase(),
                udyam_number: el('blUdyamNumber').value.trim(),
                operating_same_as_registered: el('blOperatingSameAsRegistered').checked
            },
            registered_address: {
                line: el('blRegisteredAddressLine').value.trim(),
                city: el('blRegisteredCity').value.trim(),
                state: el('blRegisteredState').value,
                pincode: el('blRegisteredPincode').value.trim()
            },
            operating_address: {
                line: el('blOperatingAddressLine').value.trim(),
                city: el('blOperatingCity').value.trim(),
                state: el('blOperatingState').value,
                pincode: el('blOperatingPincode').value.trim()
            },
            finance: {
                annual_turnover: numOrNull(el('blAnnualTurnover').value),
                monthly_sales: numOrNull(el('blMonthlySales').value),
                net_profit: numOrNull(el('blNetProfit').value),
                existing_liabilities: numOrNull(el('blExistingLiabilities').value)
            },
            banking: {
                primary_bank_name: el('blPrimaryBankName').value.trim(),
                banking_years: numOrNull(el('blBankingYears').value),
                avg_monthly_balance: numOrNull(el('blAvgMonthlyBalance').value)
            },
            requirement: {
                amount: numOrNull(el('blRequiredAmount').value),
                purpose: el('blLoanPurpose').value,
                tenure_months: numOrNull(el('blRepaymentTenure').value),
                preferred_emi: numOrNull(el('blPreferredEmi').value)
            },
            emis: collectEmis(),
            address: {
                current: {
                    line: el('blCurrentAddressLine').value.trim(),
                    city: el('blCurrentCity').value.trim(),
                    state: el('blCurrentState').value,
                    pincode: el('blCurrentPincode').value.trim()
                },
                same_as_current: el('blSameAsCurrent').checked,
                permanent: {
                    line: el('blPermanentAddressLine').value.trim(),
                    city: el('blPermanentCity').value.trim(),
                    state: el('blPermanentState').value,
                    pincode: el('blPermanentPincode').value.trim()
                }
            },
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
        var hasEmis = payload.emis.length > 0;

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
                { label: 'Financial statements (profit & loss and balance sheet)', required: true },
                { label: 'Bank statement - last 12 months', required: true }
            ]
        });

        if (hasEmis) {
            groups.push({
                title: 'Existing loan documents',
                items: [
                    { label: 'Latest statement of each existing business loan', required: true },
                    { label: 'Repayment schedule of each existing business loan', required: false }
                ]
            });
        }

        return groups;
    }

    function renderChecklist() {
        var container = el('blDocChecklist');
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
            title: 'Applicant details',
            rows: [
                reviewRow('Name', fullName() || '\u2014'),
                reviewRow('Date of birth', p.personal.date_of_birth),
                reviewRow('Mobile', p.personal.mobile),
                reviewRow('Email', p.personal.email),
                reviewRow('PAN', p.personal.pan_number),
                reviewRow('Aadhaar', p.personal.aadhaar_number ? ('XXXX XXXX ' + p.personal.aadhaar_number.slice(-4)) : 'Not provided'),
                reviewRow('Role in business', p.personal.applicant_role)
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
                reviewRow('Business ownership', p.business.ownership),
                reviewRow('Partners / directors', p.business.partner_director_count !== null ? String(p.business.partner_director_count) : ''),
                reviewRow('GSTIN', p.business.gstin),
                reviewRow('Business PAN', p.business.business_pan),
                reviewRow('Udyam number', p.business.udyam_number)
            ]
        });

        blocks.push({
            step: 2,
            title: 'Registered & operating address',
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
                reviewRow('Monthly sales', p.finance.monthly_sales ? money(p.finance.monthly_sales) : '\u2014'),
                reviewRow('Net profit', p.finance.net_profit !== null ? money(p.finance.net_profit) : '\u2014'),
                reviewRow('Existing liabilities', p.finance.existing_liabilities ? money(p.finance.existing_liabilities) : '\u2014'),
                reviewRow('Primary bank', p.banking.primary_bank_name),
                reviewRow('Banking relationship', p.banking.banking_years !== null ? (p.banking.banking_years + ' years') : '\u2014'),
                reviewRow('Avg monthly balance', p.banking.avg_monthly_balance ? money(p.banking.avg_monthly_balance) : '\u2014')
            ]
        });

        blocks.push({
            step: 4,
            title: 'Existing business loans',
            rows: p.emis.length ? p.emis.map(function (emi, index) {
                return reviewRow('Loan ' + (index + 1), (emi.bank_name || '') + (emi.monthly_emi ? ' - ' + money(emi.monthly_emi) + '/month' : ''));
            }) : [reviewRow('Obligations', 'None declared')]
        });

        blocks.push({
            step: 5,
            title: 'Loan requirement',
            rows: [
                reviewRow('Required amount', money(p.requirement.amount)),
                reviewRow('Purpose', p.requirement.purpose),
                reviewRow('Tenure', p.requirement.tenure_months ? (p.requirement.tenure_months + ' months') : '\u2014'),
                reviewRow('Preferred EMI', p.requirement.preferred_emi ? money(p.requirement.preferred_emi) : '\u2014')
            ]
        });

        var applicants = p.co_applicants.length + p.guarantors.length;
        var applicantRows = [
            reviewRow('Current address', [p.address.current.line, p.address.current.city, p.address.current.state, p.address.current.pincode].filter(Boolean).join(', ')),
            reviewRow('Permanent address', p.address.same_as_current
                ? 'Same as current'
                : [p.address.permanent.line, p.address.permanent.city, p.address.permanent.state, p.address.permanent.pincode].filter(Boolean).join(', '))
        ];
        if (applicants) {
            applicantRows = applicantRows
                .concat(p.co_applicants.map(function (a) { return reviewRow('Co-applicant', a.full_name + (a.relationship ? ' (' + a.relationship + ')' : '')); }))
                .concat(p.guarantors.map(function (a) { return reviewRow('Guarantor', a.full_name + (a.relationship ? ' (' + a.relationship + ')' : '')); }));
        } else {
            applicantRows.push(reviewRow('Applicants', 'None added'));
        }
        blocks.push({ step: 6, title: 'Address & applicants', rows: applicantRows });

        el('blReviewSummary').innerHTML = blocks.map(function (block) {
            var rows = Array.isArray(block.rows) ? block.rows.join('') : block.rows;
            return '<div class="cp-review-block">' +
                '<h4><span>' + D.escapeHtml(block.title) + '</span>' +
                '<button type="button" data-goto="' + block.step + '">Edit</button></h4>' +
                rows + '</div>';
        }).join('');
    }

    el('blReviewSummary').addEventListener('click', function (event) {
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
        var requirement = payload.requirement || {};
        var address = payload.address || {};

        el('blFirstName').value = personal.first_name || '';
        el('blMiddleName').value = personal.middle_name || '';
        el('blLastName').value = personal.last_name || '';
        el('blDob').value = personal.date_of_birth || '';
        el('blGender').value = personal.gender || '';
        el('blMaritalStatus').value = personal.marital_status || '';
        el('blMobile').value = personal.mobile || '';
        el('blEmail').value = personal.email || '';
        el('blPan').value = personal.pan_number || '';
        el('blAadhaar').value = personal.aadhaar_number || '';
        el('blApplicantRole').value = personal.applicant_role || '';

        el('blBusinessName').value = business.name || '';
        el('blBusinessConstitution').value = business.constitution || '';
        el('blIndustry').value = business.industry || '';
        el('blNatureOfBusiness').value = business.nature_of_business || '';
        el('blEstablishmentDate').value = business.establishment_date || '';
        el('blPartnerDirectorCount').value = business.partner_director_count || '';
        el('blBusinessOwnership').value = business.ownership || '';
        el('blGstin').value = business.gstin || '';
        el('blBusinessPan').value = business.business_pan || '';
        el('blUdyamNumber').value = business.udyam_number || '';

        el('blRegisteredAddressLine').value = registered.line || '';
        el('blRegisteredCity').value = registered.city || '';
        el('blRegisteredState').value = registered.state || '';
        el('blRegisteredPincode').value = registered.pincode || '';

        el('blOperatingSameAsRegistered').checked = business.operating_same_as_registered !== false;
        el('blOperatingAddressLine').value = operating.line || '';
        el('blOperatingCity').value = operating.city || '';
        el('blOperatingState').value = operating.state || '';
        el('blOperatingPincode').value = operating.pincode || '';

        el('blAnnualTurnover').value = finance.annual_turnover || '';
        el('blMonthlySales').value = finance.monthly_sales || '';
        el('blNetProfit').value = finance.net_profit || '';
        el('blExistingLiabilities').value = finance.existing_liabilities || '';

        el('blPrimaryBankName').value = banking.primary_bank_name || '';
        el('blBankingYears').value = banking.banking_years || '';
        el('blAvgMonthlyBalance').value = banking.avg_monthly_balance || '';

        el('blRequiredAmount').value = requirement.amount || '';
        el('blLoanPurpose').value = requirement.purpose || '';
        if (requirement.tenure_months) { el('blRepaymentTenure').value = String(requirement.tenure_months); }
        el('blPreferredEmi').value = requirement.preferred_emi || '';

        emiList.innerHTML = '';
        (Array.isArray(payload.emis) ? payload.emis : []).forEach(function (emi) {
            emiSeq += 1;
            emiList.insertAdjacentHTML('beforeend', emiTemplate(emiSeq));
            var card = emiList.lastElementChild;
            card.querySelector('[data-field="bank_name"]').value = emi.bank_name || '';
            card.querySelector('[data-field="loan_type"]').value = emi.loan_type || '';
            card.querySelector('[data-field="outstanding_amount"]').value = emi.outstanding_amount || '';
            card.querySelector('[data-field="monthly_emi"]').value = emi.monthly_emi || '';
        });
        updateEmiState();

        var currentAddr = address.current || {};
        el('blCurrentAddressLine').value = currentAddr.line || '';
        el('blCurrentCity').value = currentAddr.city || '';
        el('blCurrentState').value = currentAddr.state || '';
        el('blCurrentPincode').value = currentAddr.pincode || '';

        var permanentAddr = address.permanent || {};
        el('blSameAsCurrent').checked = !!address.same_as_current;
        el('blPermanentAddressLine').value = permanentAddr.line || '';
        el('blPermanentCity').value = permanentAddr.city || '';
        el('blPermanentState').value = permanentAddr.state || '';
        el('blPermanentPincode').value = permanentAddr.pincode || '';

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

        syncConstitution();
        syncOperatingAddress();
        syncPermanentAddress();
        updateEmiEstimate();
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
        emiList.innerHTML = '';
        coList.innerHTML = '';
        guarList.innerHTML = '';
        updateEmiState();
        updateAddButtons();
        syncConstitution();
        syncOperatingAddress();
        syncPermanentAddress();
        updateEmiEstimate();
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
                D.notify('success', 'Draft restored', 'Your saved business loan application has been loaded.');
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
            draftBarText.textContent = 'We found a saved draft of your business loan application on this device.';
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

        var consent = el('blApplicationConsent');
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
            var result = await D.rpc('submit_business_loan_application', {
                p_payload: payload,
                p_draft_id: draftId,
                p_draft_token: draftToken
            });
            clearStoredDraft();
            showSuccess(result);
        } catch (err) {
            console.error('Business loan submission failed:', err);
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
            'Your business loan application has been received. Reference: ' + (result.reference_no || '\u2014') + '.',
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
        if (event.target.id === 'blRequiredAmount' || event.target.id === 'blRepaymentTenure') { updateEmiEstimate(); }
    });

    form.addEventListener('change', function (event) {
        if (event.target.classList.contains('form-control')) {
            D.clearFieldError(event.target);
        }
        if (event.target.id === 'blBusinessConstitution') { syncConstitution(); }
        if (event.target.id === 'blOperatingSameAsRegistered') { syncOperatingAddress(); }
        if (event.target.id === 'blSameAsCurrent') { syncPermanentAddress(); }
        if (event.target.id === 'blRepaymentTenure') { updateEmiEstimate(); }
        if (['blRegisteredAddressLine', 'blRegisteredCity', 'blRegisteredState', 'blRegisteredPincode'].indexOf(event.target.id) !== -1
            && el('blOperatingSameAsRegistered').checked) { syncOperatingAddress(); }
        if (['blCurrentAddressLine', 'blCurrentCity', 'blCurrentState', 'blCurrentPincode'].indexOf(event.target.id) !== -1
            && el('blSameAsCurrent').checked) { syncPermanentAddress(); }
    });

    /* ------------------------------------------------------------------ *
     * Boot
     * ------------------------------------------------------------------ */

    function boot() {
        initOptions();
        updateEmiState();
        updateAddButtons();
        syncConstitution();
        syncOperatingAddress();
        syncPermanentAddress();
        updateEmiEstimate();
        showStep(0, false);
        initDraft();
    }

    boot();
})(window, document);

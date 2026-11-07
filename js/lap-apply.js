/**
 * Dhanvi Finserv - multi-step Loan Against Property (LAP) application wizard.
 *
 * Depends on: js/nhost-client.js, js/public-api.js
 *
 * Flow
 *   1-7  collect personal, employment, business financials, existing EMIs,
 *        collateral property, loan requirement, address and co-applicant /
 *        guarantor details
 *   8    conditional document checklist, review and consent
 *
 * Save / resume
 *   A server-side draft is created through save_home_loan_draft() (shared with
 *   the Home Loan wizard) as soon as the first step validates, and refreshed on
 *   every step change. The draft id + secret token are kept in localStorage so
 *   the applicant can resume in the same browser, and "Save & continue later"
 *   also shows a resume link. Submitting promotes the draft into a real LAP
 *   application through submit_lap_application().
 */
(function (window, document) {
    'use strict';

    var D = window.Dhanvi;
    var form = document.getElementById('lapForm');
    if (!form || !D) { return; }

    var DRAFT_KEY = 'dhanviLapDraft';
    var TOTAL_STEPS = 8;

    var alertBox = document.getElementById('applicationAlert');
    var draftBar = document.getElementById('draftBar');
    var draftBarText = document.getElementById('draftBarText');
    var successBox = document.getElementById('applicationSuccess');
    var stepper = document.getElementById('lapStepper');
    var steps = Array.prototype.slice.call(form.querySelectorAll('.cp-step'));
    var prevBtn = document.getElementById('prevBtn');
    var nextBtn = document.getElementById('nextBtn');
    var submitBtn = document.getElementById('submitBtn');
    var saveDraftBtn = document.getElementById('saveDraftBtn');
    var progressText = document.getElementById('progressText');

    var emiList = document.getElementById('lapEmiList');
    var emiPlaceholder = document.getElementById('lapEmiPlaceholder');
    var addEmiBtn = document.getElementById('lapAddEmi');
    var coList = document.getElementById('lapCoApplicantList');
    var guarList = document.getElementById('lapGuarantorList');
    var addCoBtn = document.getElementById('lapAddCoApplicant');
    var addGuarBtn = document.getElementById('lapAddGuarantor');

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
    var EMI_LOAN_TYPES = ['Home Loan', 'Loan Against Property', 'Personal Loan', 'Vehicle Loan', 'Education Loan', 'Business Loan', 'Credit Card', 'Consumer Durable', 'Other'];
    var RESIDENTIAL_TYPES = ['Flat / Apartment', 'Independent House', 'Villa', 'Row House', 'Plot'];
    var COMMERCIAL_TYPES = ['Shop', 'Office', 'Showroom', 'Industrial', 'Warehouse', 'Plot'];

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
    function offsetISO(target) {
        var today = new Date();
        var base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        var days = Math.round((target.getTime() - base.getTime()) / 86400000);
        return D.todayISO(days);
    }
    function fullName() {
        return [el('lapFirstName').value, el('lapMiddleName').value, el('lapLastName').value]
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

    /* ------------------------------------------------------------------ *
     * Static option lists
     * ------------------------------------------------------------------ */

    function initOptions() {
        ['lapCurrentState', 'lapPermanentState', 'lapPropertyState'].forEach(function (id) {
            var select = el(id);
            if (!select) { return; }
            select.innerHTML = '<option value="">Select state</option>' + optionList(STATES);
        });

        var tenure = el('lapTenureMonths');
        var options = '<option value="">Select tenure</option>';
        for (var months = 12; months <= 360; months += 12) {
            var years = months / 12;
            options += '<option value="' + months + '"' + (months === 180 ? ' selected' : '') + '>' +
                years + (years === 1 ? ' year' : ' years') + ' (' + months + ' months)</option>';
        }
        tenure.innerHTML = options;

        var dob = el('lapDob');
        var today = new Date();
        var min = new Date(today.getFullYear() - 70, today.getMonth(), today.getDate());
        var max = new Date(today.getFullYear() - 18, today.getMonth(), today.getDate());
        dob.setAttribute('min', offsetISO(min));
        dob.setAttribute('max', offsetISO(max));

        syncPropertyCategory();
    }

    /* ------------------------------------------------------------------ *
     * Existing EMI rows
     * ------------------------------------------------------------------ */

    function emiTemplate(seq) {
        var prefix = 'lapEmi' + seq;
        return '' +
            '<div class="cp-applicant" data-emi="' + prefix + '">' +
                '<div class="cp-applicant-head">' +
                    '<h4>Existing EMI</h4>' +
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
        addEmiBtn.innerHTML = '<i class="fa fa-plus"></i> Add existing EMI' + (count >= MAX_EMI ? ' (max ' + MAX_EMI + ')' : '');
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
        var prefix = (isCo ? 'lapCo' : 'lapGuar') + seq;
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

    function syncEmployment() {
        var type = el('lapEmploymentType').value;
        var isSelf = type === 'Self-employed';
        el('salariedFields').classList.toggle('cp-hidden', isSelf);
        el('selfEmployedFields').classList.toggle('cp-hidden', !isSelf);
        el('businessVintageField').classList.toggle('cp-hidden', !isSelf);
        el('workExperienceField').classList.toggle('cp-hidden', isSelf);
        el('businessFinanceBlock').classList.toggle('cp-hidden', type === 'Salaried');
        el('lapBusinessFinanceNote').classList.toggle('cp-hidden', type !== 'Salaried');
    }

    function syncAddress() {
        var same = el('lapSameAsCurrent').checked;
        el('lapPermanentAddressBlock').classList.toggle('cp-hidden', same);
    }

    function syncAnnualIncome() {
        var monthly = numOrNull(el('lapMonthlyIncome').value);
        var annual = el('lapAnnualIncome');
        if (monthly && !annual.value) {
            annual.placeholder = 'e.g. ' + (monthly * 12).toLocaleString('en-IN');
        }
    }

    function syncPropertyCategory() {
        var category = el('lapPropertyCategory').value;
        var options = category === 'Commercial' ? COMMERCIAL_TYPES
            : (category === 'Residential' ? RESIDENTIAL_TYPES : []);
        var select = el('lapPropertyType');
        var previous = select.value;
        select.innerHTML = '<option value="">' + (options.length ? 'Select property type' : 'Select property category first') + '</option>' + optionList(options);
        if (options.indexOf(previous) !== -1) { select.value = previous; }
    }

    function updateEmiEstimate() {
        var principal = numOrNull(el('lapRequiredAmount').value);
        var months = numOrNull(el('lapTenureMonths').value);
        var marketValue = numOrNull(el('lapPropertyMarketValue').value);
        var box = el('lapEmiEstimate');
        if (!principal) {
            box.textContent = 'Enter the loan amount, tenure and property market value to see an indicative EMI and LTV. Indicative rate assumed at 10.5% p.a. Actual figures are decided by your lender.';
            return;
        }
        var term = months || 180;
        var rate = 10.5 / 12 / 100;
        var emi = principal * rate * Math.pow(1 + rate, term) / (Math.pow(1 + rate, term) - 1);
        var text = 'Approximate EMI: <strong>' + money(Math.round(emi)) + '</strong> per month (indicative at 10.5% p.a. over ' + term + ' months).';
        if (marketValue && marketValue > 0) {
            text += ' Indicative LTV: <strong>' + ((principal / marketValue) * 100).toFixed(1) + '%</strong>.';
        }
        box.innerHTML = text + ' Actual rate, EMI and LTV are decided by your lender.';
    }

    function itrValue() {
        var value = el('lapItrFiled').value;
        if (value === 'Yes') { return true; }
        if (value === 'No') { return false; }
        return null;
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
            var first = el('lapFirstName'), last = el('lapLastName'), dob = el('lapDob');
            var mobile = el('lapMobile'), email = el('lapEmail'), pan = el('lapPan'), aadhaar = el('lapAadhaar');

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
            if (!/^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/.test(pan.value.trim())) {
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
            var type = el('lapEmploymentType');
            var monthly = el('lapMonthlyIncome');
            if (!type.value) { D.setFieldError(type, 'Select your employment type.'); ok = false; }
            if (type.value === 'Salaried') {
                var employer = el('lapEmployerName');
                if (!employer.value.trim()) { D.setFieldError(employer, 'Enter your employer name.'); ok = false; }
            }
            if (type.value === 'Self-employed') {
                var business = el('lapBusinessName');
                if (!business.value.trim()) { D.setFieldError(business, 'Enter your business name.'); ok = false; }
            }
            if (!monthly.value || Number(monthly.value) <= 0) {
                D.setFieldError(monthly, 'Enter your monthly income.');
                ok = false;
            }
        }

        if (index === 2) {
            if (el('lapEmploymentType').value === 'Self-employed') {
                var constitution = el('lapBusinessConstitution');
                var turnover = el('lapBusinessTurnover');
                var profit = el('lapBusinessNetProfit');
                if (!constitution.value) { D.setFieldError(constitution, 'Select your business constitution.'); ok = false; }
                if (!turnover.value || Number(turnover.value) <= 0) {
                    D.setFieldError(turnover, 'Enter your annual business turnover.');
                    ok = false;
                }
                if (profit.value !== '' && Number(profit.value) < 0) {
                    D.setFieldError(profit, 'Enter a valid net profit.');
                    ok = false;
                }
            }
        }

        if (index === 3) {
            Array.prototype.forEach.call(emiList.querySelectorAll('[data-emi]'), function (card) {
                var bank = card.querySelector('[data-field="bank_name"]');
                if (!bank.value.trim()) { D.setFieldError(bank, 'Enter the bank or lender name.'); ok = false; }
            });
        }

        if (index === 4) {
            var category = el('lapPropertyCategory');
            var marketValue = el('lapPropertyMarketValue');
            if (!category.value) { D.setFieldError(category, 'Select the property category.'); ok = false; }
            [['lapPropertyAddress', 'Enter the full property address.'],
             ['lapPropertyCity', 'Enter the property city.'],
             ['lapPropertyState', 'Select the property state.'],
             ['lapPropertyPincode', 'Enter the property 6-digit PIN code.']].forEach(function (pair) {
                var field = el(pair[0]);
                if (!field.value.trim()) { D.setFieldError(field, pair[1]); ok = false; }
            });
            var propPin = el('lapPropertyPincode');
            if (propPin.value.trim() && !/^[0-9]{6}$/.test(propPin.value.trim())) {
                D.setFieldError(propPin, 'Enter a valid 6-digit PIN code.');
                ok = false;
            }
            if (!marketValue.value || Number(marketValue.value) <= 0) {
                D.setFieldError(marketValue, 'Enter the current market value of the property.');
                ok = false;
            }
        }

        if (index === 5) {
            var required = el('lapRequiredAmount');
            var purpose = el('lapPurpose');
            var tenure = el('lapTenureMonths');
            var preferred = el('lapPreferredEmi');

            if (!required.value || Number(required.value) < 100000) {
                D.setFieldError(required, 'Enter a LAP amount of at least \u20B91,00,000.');
                ok = false;
            }
            if (!purpose.value) { D.setFieldError(purpose, 'Select the purpose of the loan.'); ok = false; }
            var tenureValue = numOrNull(tenure.value);
            if (tenureValue !== null && (tenureValue < 12 || tenureValue > 360)) {
                D.setFieldError(tenure, 'Select a tenure between 12 and 360 months.');
                ok = false;
            }
            var preferredValue = numOrNull(preferred.value);
            if (preferredValue !== null && preferredValue < 0) {
                D.setFieldError(preferred, 'Enter a valid preferred EMI.');
                ok = false;
            }
        }

        if (index === 6) {
            [['lapCurrentAddressLine', 'Enter your current address.'],
             ['lapCurrentCity', 'Enter your city.'],
             ['lapCurrentState', 'Select your state.'],
             ['lapCurrentPincode', 'Enter your 6-digit PIN code.']].forEach(function (pair) {
                var field = el(pair[0]);
                if (!field.value.trim()) { D.setFieldError(field, pair[1]); ok = false; }
            });
            var curPin = el('lapCurrentPincode');
            if (curPin.value.trim() && !/^[0-9]{6}$/.test(curPin.value.trim())) {
                D.setFieldError(curPin, 'Enter a valid 6-digit PIN code.');
                ok = false;
            }
            if (!el('lapSameAsCurrent').checked) {
                [['lapPermanentAddressLine', 'Enter your permanent address.'],
                 ['lapPermanentCity', 'Enter your city.'],
                 ['lapPermanentState', 'Select your state.'],
                 ['lapPermanentPincode', 'Enter your 6-digit PIN code.']].forEach(function (pair) {
                    var field = el(pair[0]);
                    if (!field.value.trim()) { D.setFieldError(field, pair[1]); ok = false; }
                });
                var perPin = el('lapPermanentPincode');
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
        var same = el('lapSameAsCurrent').checked;

        return {
            personal: {
                first_name: el('lapFirstName').value.trim(),
                middle_name: el('lapMiddleName').value.trim(),
                last_name: el('lapLastName').value.trim(),
                date_of_birth: el('lapDob').value || '',
                gender: el('lapGender').value,
                marital_status: el('lapMaritalStatus').value,
                mobile: el('lapMobile').value.trim(),
                email: el('lapEmail').value.trim(),
                pan_number: el('lapPan').value.trim().toUpperCase(),
                aadhaar_number: D.digits(el('lapAadhaar').value)
            },
            employment: {
                employment_type: el('lapEmploymentType').value,
                employer_name: el('lapEmployerName').value.trim(),
                business_name: el('lapBusinessName').value.trim(),
                designation: el('lapDesignation').value.trim(),
                monthly_income: numOrNull(el('lapMonthlyIncome').value),
                annual_income: numOrNull(el('lapAnnualIncome').value),
                work_experience_years: numOrNull(el('lapWorkExperience').value),
                business_vintage_years: numOrNull(el('lapBusinessVintage').value)
            },
            business_finance: {
                constitution: el('lapBusinessConstitution').value,
                turnover: numOrNull(el('lapBusinessTurnover').value),
                net_profit: numOrNull(el('lapBusinessNetProfit').value),
                itr_filed: itrValue()
            },
            emis: collectEmis(),
            address: {
                current: {
                    line: el('lapCurrentAddressLine').value.trim(),
                    city: el('lapCurrentCity').value.trim(),
                    state: el('lapCurrentState').value,
                    pincode: el('lapCurrentPincode').value.trim()
                },
                same_as_current: same,
                permanent: {
                    line: el('lapPermanentAddressLine').value.trim(),
                    city: el('lapPermanentCity').value.trim(),
                    state: el('lapPermanentState').value,
                    pincode: el('lapPermanentPincode').value.trim()
                }
            },
            property: {
                category: el('lapPropertyCategory').value,
                property_type: el('lapPropertyType').value,
                address: el('lapPropertyAddress').value.trim(),
                city: el('lapPropertyCity').value.trim(),
                state: el('lapPropertyState').value,
                pincode: el('lapPropertyPincode').value.trim(),
                ownership_type: el('lapPropertyOwnership').value,
                co_owners: el('lapPropertyCoOwners').value.trim(),
                usage: el('lapPropertyUsage').value.trim(),
                market_value: numOrNull(el('lapPropertyMarketValue').value),
                purchase_value: numOrNull(el('lapPropertyPurchaseValue').value),
                area_sqft: numOrNull(el('lapPropertyArea').value),
                age_years: numOrNull(el('lapPropertyAge').value)
            },
            requirement: {
                amount: numOrNull(el('lapRequiredAmount').value),
                purpose: el('lapPurpose').value,
                tenure_months: numOrNull(el('lapTenureMonths').value),
                preferred_emi: numOrNull(el('lapPreferredEmi').value)
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
        var salaried = payload.employment.employment_type === 'Salaried';
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
            title: 'Bank statements',
            items: [
                { label: salaried ? 'Bank statement - last 6 months' : 'Bank statement - last 12 months', required: true }
            ]
        });

        if (salaried) {
            groups.push({
                title: 'Income proof (salaried)',
                items: [
                    { label: 'Salary slips - last 3 months', required: true },
                    { label: 'Form 16 - last 2 years', required: true },
                    { label: 'Income proof / ITR', required: false }
                ]
            });
        } else {
            groups.push({
                title: 'Income proof & business (self-employed)',
                items: [
                    { label: 'ITR - last 2 years', required: true },
                    { label: 'Income proof / computation of income', required: true },
                    { label: 'Business proof (GST / Udyam / registration)', required: true }
                ]
            });
        }

        groups.push({
            title: 'Property documents',
            items: [
                { label: 'Property ownership documents (sale deed / registration)', required: true },
                { label: 'Title chain / mother deed', required: true },
                { label: 'Property tax receipts', required: true },
                { label: 'Approved building plans', required: false }
            ]
        });

        if (hasEmis) {
            groups.push({
                title: 'Existing loan documents',
                items: [
                    { label: 'Latest statement of each existing loan', required: true },
                    { label: 'Repayment schedule of each existing loan', required: false }
                ]
            });
        }

        return groups;
    }

    function renderChecklist() {
        var container = el('lapDocChecklist');
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
            title: 'Personal details',
            rows: [
                reviewRow('Name', fullName() || '\u2014'),
                reviewRow('Date of birth', p.personal.date_of_birth),
                reviewRow('Mobile', p.personal.mobile),
                reviewRow('Email', p.personal.email),
                reviewRow('PAN', p.personal.pan_number),
                reviewRow('Aadhaar', p.personal.aadhaar_number ? ('XXXX XXXX ' + p.personal.aadhaar_number.slice(-4)) : 'Not provided')
            ]
        });

        blocks.push({
            step: 1,
            title: 'Employment & income',
            rows: [
                reviewRow('Employment type', p.employment.employment_type),
                reviewRow(p.employment.employment_type === 'Self-employed' ? 'Business' : 'Employer',
                    p.employment.employment_type === 'Self-employed' ? p.employment.business_name : p.employment.employer_name),
                reviewRow('Monthly income', money(p.employment.monthly_income)),
                reviewRow('Annual income', p.employment.annual_income ? money(p.employment.annual_income) : (p.employment.monthly_income ? money(p.employment.monthly_income * 12) + ' (calculated)' : '\u2014'))
            ]
        });

        blocks.push({
            step: 2,
            title: 'Business & financials',
            rows: p.employment.employment_type === 'Self-employed' ? [
                reviewRow('Constitution', p.business_finance.constitution),
                reviewRow('Turnover', money(p.business_finance.turnover)),
                reviewRow('Net profit', p.business_finance.net_profit ? money(p.business_finance.net_profit) : '\u2014'),
                reviewRow('ITR filed', p.business_finance.itr_filed === true ? 'Yes' : (p.business_finance.itr_filed === false ? 'No' : '\u2014'))
            ] : [reviewRow('Applicable', 'Not applicable (salaried)')]
        });

        blocks.push({
            step: 3,
            title: 'Existing EMIs',
            rows: p.emis.length ? p.emis.map(function (emi, index) {
                return reviewRow('EMI ' + (index + 1), (emi.bank_name || '') + (emi.monthly_emi ? ' - ' + money(emi.monthly_emi) + '/month' : ''));
            }).join('') || '' : [reviewRow('Obligations', 'None declared')]
        });

        blocks.push({
            step: 4,
            title: 'Collateral property',
            rows: [
                reviewRow('Category', p.property.category),
                reviewRow('Type', p.property.property_type),
                reviewRow('Location', [p.property.city, p.property.state].filter(Boolean).join(', ')),
                reviewRow('Ownership', p.property.ownership_type),
                reviewRow('Market value', money(p.property.market_value)),
                reviewRow('Purchase value', p.property.purchase_value ? money(p.property.purchase_value) : '\u2014'),
                reviewRow('Area (sq ft)', p.property.area_sqft ? String(p.property.area_sqft) : '\u2014'),
                reviewRow('Property age (years)', p.property.age_years ? String(p.property.age_years) : '\u2014')
            ]
        });

        blocks.push({
            step: 5,
            title: 'Loan requirement',
            rows: [
                reviewRow('Required amount', money(p.requirement.amount)),
                reviewRow('Purpose', p.requirement.purpose),
                reviewRow('Tenure', p.requirement.tenure_months ? (p.requirement.tenure_months / 12) + ' years (' + p.requirement.tenure_months + ' months)' : '\u2014'),
                reviewRow('Preferred EMI', money(p.requirement.preferred_emi))
            ]
        });

        var applicants = p.co_applicants.length + p.guarantors.length;
        blocks.push({
            step: 6,
            title: 'Address, co-applicants & guarantors',
            rows: [reviewRow('Current', [p.address.current.line, p.address.current.city, p.address.current.state, p.address.current.pincode].filter(Boolean).join(', '))]
                .concat([reviewRow('Permanent', p.address.same_as_current
                    ? 'Same as current'
                    : [p.address.permanent.line, p.address.permanent.city, p.address.permanent.state, p.address.permanent.pincode].filter(Boolean).join(', '))])
                .concat(applicants
                    ? []
                        .concat(p.co_applicants.map(function (a) { return reviewRow('Co-applicant', a.full_name + (a.relationship ? ' (' + a.relationship + ')' : '')); }))
                        .concat(p.guarantors.map(function (a) { return reviewRow('Guarantor', a.full_name + (a.relationship ? ' (' + a.relationship + ')' : '')); }))
                    : [reviewRow('Applicants', 'None added')])
        });

        el('lapReviewSummary').innerHTML = blocks.map(function (block) {
            var rows = Array.isArray(block.rows) ? block.rows.join('') : block.rows;
            return '<div class="cp-review-block">' +
                '<h4><span>' + D.escapeHtml(block.title) + '</span>' +
                '<button type="button" data-goto="' + block.step + '">Edit</button></h4>' +
                rows + '</div>';
        }).join('');
    }

    el('lapReviewSummary').addEventListener('click', function (event) {
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
        var employment = payload.employment || {};
        var businessFinance = payload.business_finance || {};
        var address = payload.address || {};
        var property = payload.property || {};
        var requirement = payload.requirement || {};

        el('lapFirstName').value = personal.first_name || '';
        el('lapMiddleName').value = personal.middle_name || '';
        el('lapLastName').value = personal.last_name || '';
        el('lapDob').value = personal.date_of_birth || '';
        el('lapGender').value = personal.gender || '';
        el('lapMaritalStatus').value = personal.marital_status || '';
        el('lapMobile').value = personal.mobile || '';
        el('lapEmail').value = personal.email || '';
        el('lapPan').value = personal.pan_number || '';
        el('lapAadhaar').value = personal.aadhaar_number || '';

        el('lapEmploymentType').value = employment.employment_type || '';
        el('lapEmployerName').value = employment.employer_name || '';
        el('lapBusinessName').value = employment.business_name || '';
        el('lapDesignation').value = employment.designation || '';
        el('lapMonthlyIncome').value = employment.monthly_income || '';
        el('lapAnnualIncome').value = employment.annual_income || '';
        el('lapWorkExperience').value = employment.work_experience_years || '';
        el('lapBusinessVintage').value = employment.business_vintage_years || '';

        el('lapBusinessConstitution').value = businessFinance.constitution || '';
        el('lapBusinessTurnover').value = businessFinance.turnover || '';
        el('lapBusinessNetProfit').value = businessFinance.net_profit || '';
        el('lapItrFiled').value = businessFinance.itr_filed === true ? 'Yes' : (businessFinance.itr_filed === false ? 'No' : '');

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
        el('lapCurrentAddressLine').value = currentAddr.line || '';
        el('lapCurrentCity').value = currentAddr.city || '';
        el('lapCurrentState').value = currentAddr.state || '';
        el('lapCurrentPincode').value = currentAddr.pincode || '';

        var permanentAddr = address.permanent || {};
        el('lapSameAsCurrent').checked = !!address.same_as_current;
        el('lapPermanentAddressLine').value = permanentAddr.line || '';
        el('lapPermanentCity').value = permanentAddr.city || '';
        el('lapPermanentState').value = permanentAddr.state || '';
        el('lapPermanentPincode').value = permanentAddr.pincode || '';

        el('lapPropertyCategory').value = property.category || '';
        syncPropertyCategory();
        el('lapPropertyType').value = property.property_type || '';
        el('lapPropertyAddress').value = property.address || '';
        el('lapPropertyCity').value = property.city || '';
        el('lapPropertyState').value = property.state || '';
        el('lapPropertyPincode').value = property.pincode || '';
        el('lapPropertyOwnership').value = property.ownership_type || '';
        el('lapPropertyCoOwners').value = property.co_owners || '';
        el('lapPropertyUsage').value = property.usage || '';
        el('lapPropertyMarketValue').value = property.market_value || '';
        el('lapPropertyPurchaseValue').value = property.purchase_value || '';
        el('lapPropertyArea').value = property.area_sqft || '';
        el('lapPropertyAge').value = property.age_years || '';

        el('lapRequiredAmount').value = requirement.amount || '';
        el('lapPurpose').value = requirement.purpose || '';
        if (requirement.tenure_months) { el('lapTenureMonths').value = String(requirement.tenure_months); }
        el('lapPreferredEmi').value = requirement.preferred_emi || '';

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

        syncEmployment();
        syncAddress();
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
        syncEmployment();
        syncAddress();
        syncPropertyCategory();
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
                D.notify('success', 'Draft restored', 'Your saved loan against property application has been loaded.');
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
            draftBarText.textContent = 'We found a saved draft of your loan against property application on this device.';
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

        var consent = el('lapApplicationConsent');
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
            var result = await D.rpc('submit_lap_application', {
                p_payload: payload,
                p_draft_id: draftId,
                p_draft_token: draftToken
            });
            clearStoredDraft();
            showSuccess(result);
        } catch (err) {
            console.error('Loan against property submission failed:', err);
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
            'Your loan against property application has been received. Reference: ' + (result.reference_no || '\u2014') + '.',
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
        if (event.target.id === 'lapMonthlyIncome') { syncAnnualIncome(); }
        if (event.target.id === 'lapRequiredAmount' || event.target.id === 'lapPropertyMarketValue') { updateEmiEstimate(); }
    });

    form.addEventListener('change', function (event) {
        if (event.target.classList.contains('form-control')) {
            D.clearFieldError(event.target);
        }
        if (event.target.id === 'lapEmploymentType') { syncEmployment(); }
        if (event.target.id === 'lapSameAsCurrent') { syncAddress(); }
        if (event.target.id === 'lapPropertyCategory') { syncPropertyCategory(); }
        if (event.target.id === 'lapTenureMonths') { updateEmiEstimate(); }
    });

    /* ------------------------------------------------------------------ *
     * Boot
     * ------------------------------------------------------------------ */

    function boot() {
        initOptions();
        updateEmiState();
        updateAddButtons();
        syncEmployment();
        syncAddress();
        updateEmiEstimate();
        showStep(0, false);
        initDraft();
    }

    boot();
})(window, document);

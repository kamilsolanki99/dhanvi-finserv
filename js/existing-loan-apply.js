/**
 * Dhanvi Finserv - multi-step application wizard for loans against an
 * EXISTING home loan:
 *
 *   data-mode="topup"     -> home-loan-topup-apply.html   (Home Loan Top-Up)
 *   data-mode="takeover"  -> home-loan-takeover-apply.html (Home Loan Takeover)
 *
 * Depends on: js/nhost-client.js, js/public-api.js
 *
 * Steps (both modes end with a documents + review step)
 *   T = topup    1 Personal 2 Employment 3 Existing loan 4 Top-up need
 *                5 Property 6 Other loans 7 Address + applicants 8 Documents
 *   K = takeover 1 Personal 2 Employment 3 Existing loan 4 Takeover need
 *                5 Property 6 Address 7 Applicants 8 Documents
 *
 * Save / resume
 *   Reuses the Home Loan draft functions (save_home_loan_draft /
 *   get_home_loan_draft) because the draft payload is opaque JSONB. Drafts are
 *   stored per browser through localStorage and can also be resumed from a
 *   secret link. Submitting promotes the draft into a real application.
 *
 * Indicative figures (combined EMI + LTV for top-up, EMI comparison +
 * interest saved for takeover) are calculated in the browser AND recomputed
 * server-side at submission, so the admin sees the same numbers.
 */
(function (window, document) {
    'use strict';

    var D = window.Dhanvi;
    var form = document.getElementById('existingLoanForm');
    if (!form || !D) { return; }

    var MODE = form.getAttribute('data-mode') === 'takeover' ? 'takeover' : 'topup';
    var IS_TAKEOVER = MODE === 'takeover';
    var TOTAL_STEPS = 8;
    var RPC_NAME = IS_TAKEOVER ? 'submit_home_loan_takeover_application' : 'submit_home_loan_topup_application';
    var DRAFT_KEY = IS_TAKEOVER ? 'dhanviHomeLoanTakeoverDraft' : 'dhanviHomeLoanTopupDraft';

    // Step index map (see the header comment above).
    var STEP = IS_TAKEOVER
        ? { personal: 0, employment: 1, existing: 2, requirement: 3, property: 4, address: 5, applicants: 6, documents: 7 }
        : { personal: 0, employment: 1, existing: 2, requirement: 3, property: 4, otherLoans: 5, address: 6, documents: 7 };

    var alertBox = document.getElementById('applicationAlert');
    var draftBar = document.getElementById('draftBar');
    var draftBarText = document.getElementById('draftBarText');
    var successBox = document.getElementById('applicationSuccess');
    var stepper = document.getElementById('elStepper');
    var steps = Array.prototype.slice.call(form.querySelectorAll('.cp-step'));
    var prevBtn = document.getElementById('prevBtn');
    var nextBtn = document.getElementById('nextBtn');
    var submitBtn = document.getElementById('submitBtn');
    var saveDraftBtn = document.getElementById('saveDraftBtn');
    var progressText = document.getElementById('progressText');
    var consentBox = document.getElementById('applicationConsent');

    var emiList = document.getElementById('emiList');
    var emiPlaceholder = document.getElementById('emiPlaceholder');
    var addEmiBtn = document.getElementById('addEmi');
    var coList = document.getElementById('coApplicantList');
    var guarList = document.getElementById('guarantorList');
    var addCoBtn = document.getElementById('addCoApplicant');
    var addGuarBtn = document.getElementById('addGuarantor');

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
    var LENDER_TYPES = ['Bank', 'NBFC', 'Housing Finance Company', 'Other'];
    var INTEREST_TYPES = ['Floating', 'Fixed', 'Mixed'];
    var TOPUP_PURPOSES = ['Renovation', 'Extension', 'Education', 'Medical', 'Business', 'Personal'];
    var REPAYMENT_HISTORY = ['Regular', 'Irregular', 'Overdue'];
    var OVERDUE_STATUS = ['None', '1-30 days', '31-60 days', '60+ days'];

    /* ------------------------------------------------------------------ *
     * Small helpers
     * ------------------------------------------------------------------ */

    function el(id) { return document.getElementById(id); }
    function optionList(values) {
        return values.map(function (v) {
            return '<option value="' + D.escapeHtml(v) + '">' + D.escapeHtml(v) + '</option>';
        }).join('');
    }
    function value(id) {
        var field = el(id);
        return field ? field.value.trim() : '';
    }
    function numOrNull(v) {
        var raw = String(v === null || v === undefined ? '' : v).trim();
        if (raw === '') { return null; }
        var n = Number(raw);
        return isNaN(n) ? null : n;
    }
    function money(v) {
        var n = Number(v);
        if (isNaN(n)) { return '\u2014'; }
        return '\u20B9' + n.toLocaleString('en-IN');
    }
    function isoDate(date) {
        var m = String(date.getMonth() + 1).padStart(2, '0');
        var d = String(date.getDate()).padStart(2, '0');
        return date.getFullYear() + '-' + m + '-' + d;
    }
    function fullName() {
        return [value('elFirstName'), value('elMiddleName'), value('elLastName')].filter(Boolean).join(' ');
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
    function emiFor(principal, annualRatePct, months) {
        if (!principal || principal <= 0 || !months || months <= 0) { return null; }
        var r = (annualRatePct || 0) / 12 / 100;
        if (r <= 0) { return principal / months; }
        return principal * r * Math.pow(1 + r, months) / (Math.pow(1 + r, months) - 1);
    }

    /* ------------------------------------------------------------------ *
     * Static option lists
     * ------------------------------------------------------------------ */

    function initOptions() {
        ['elCurrentState', 'elPermanentState', 'elPropertyState'].forEach(function (id) {
            var select = el(id);
            if (select) { select.innerHTML = '<option value="">Select state</option>' + optionList(STATES); }
        });

        if (el('elLenderType')) { el('elLenderType').innerHTML = '<option value="">Select lender type</option>' + optionList(LENDER_TYPES); }
        if (el('elInterestType')) { el('elInterestType').innerHTML = '<option value="">Select interest type</option>' + optionList(INTEREST_TYPES); }
        if (el('elTopupPurpose')) { el('elTopupPurpose').innerHTML = '<option value="">Select purpose</option>' + optionList(TOPUP_PURPOSES); }
        if (el('elAdditionalTopupPurpose')) { el('elAdditionalTopupPurpose').innerHTML = '<option value="">Select purpose</option>' + optionList(TOPUP_PURPOSES); }
        if (el('elRepaymentHistory')) { el('elRepaymentHistory').innerHTML = '<option value="">Select repayment history</option>' + optionList(REPAYMENT_HISTORY); }
        if (el('elOverdueStatus')) { el('elOverdueStatus').innerHTML = '<option value="">Select overdue status</option>' + optionList(OVERDUE_STATUS); }

        var desiredTenure = el('elDesiredTenure');
        if (desiredTenure) {
            var options = '<option value="">Select tenure</option>';
            for (var years = 1; years <= 30; years++) {
                options += '<option value="' + (years * 12) + '"' + (years === 20 ? ' selected' : '') + '>' +
                    years + (years === 1 ? ' year' : ' years') + ' (' + (years * 12) + ' months)</option>';
            }
            desiredTenure.innerHTML = options;
        }

        var dob = el('elDob');
        if (dob) {
            var today = new Date();
            dob.setAttribute('min', isoDate(new Date(today.getFullYear() - 70, today.getMonth(), today.getDate())));
            dob.setAttribute('max', isoDate(new Date(today.getFullYear() - 18, today.getMonth(), today.getDate())));
        }

        var startDate = el('elLoanStartDate');
        if (startDate) { startDate.setAttribute('max', isoDate(new Date())); }
    }

    /* ------------------------------------------------------------------ *
     * Other running loans (top-up only)
     * ------------------------------------------------------------------ */

    function emiTemplate(seq) {
        var prefix = 'emi' + seq;
        return '' +
            '<div class="cp-applicant" data-emi="' + prefix + '">' +
                '<div class="cp-applicant-head">' +
                    '<h4>Running loan</h4>' +
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
        if (!emiList) { return; }
        var count = emiList.querySelectorAll('[data-emi]').length;
        if (emiPlaceholder) { emiPlaceholder.classList.toggle('cp-hidden', count > 0); }
        if (addEmiBtn) {
            addEmiBtn.disabled = count >= MAX_EMI;
            addEmiBtn.innerHTML = '<i class="fa fa-plus"></i> Add running loan' + (count >= MAX_EMI ? ' (max ' + MAX_EMI + ')' : '');
        }
    }

    if (addEmiBtn && emiList) {
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
    }

    function collectEmis() {
        if (!emiList) { return []; }
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
        var prefix = (isCo ? 'elco' : 'elguar') + seq;
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
        var co = coList ? coList.querySelectorAll('.cp-applicant').length : 0;
        var guar = guarList ? guarList.querySelectorAll('.cp-applicant').length : 0;
        if (addCoBtn) {
            addCoBtn.disabled = co >= MAX_CO;
            addCoBtn.innerHTML = '<i class="fa fa-plus"></i> Add co-applicant' + (co >= MAX_CO ? ' (max ' + MAX_CO + ')' : '');
        }
        if (addGuarBtn) {
            addGuarBtn.disabled = guar >= MAX_GUAR;
            addGuarBtn.innerHTML = '<i class="fa fa-plus"></i> Add guarantor' + (guar >= MAX_GUAR ? ' (max ' + MAX_GUAR + ')' : '');
        }
    }

    function renumber(container, role) {
        Array.prototype.forEach.call(container.querySelectorAll('.cp-applicant'), function (card, index) {
            var heading = card.querySelector('.cp-applicant-head h4');
            if (heading) {
                heading.textContent = (role === 'co_applicant' ? 'Co-applicant ' : 'Guarantor ') + (index + 1);
            }
        });
    }

    if (addCoBtn && coList) {
        addCoBtn.addEventListener('click', function () {
            if (coList.querySelectorAll('.cp-applicant').length >= MAX_CO) { return; }
            coSeq += 1;
            coList.insertAdjacentHTML('beforeend', applicantTemplate('co_applicant', coList.querySelectorAll('.cp-applicant').length + 1, coSeq));
            updateAddButtons();
            coList.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
    }

    if (addGuarBtn && guarList) {
        addGuarBtn.addEventListener('click', function () {
            if (guarList.querySelectorAll('.cp-applicant').length >= MAX_GUAR) { return; }
            guarSeq += 1;
            guarList.insertAdjacentHTML('beforeend', applicantTemplate('guarantor', guarList.querySelectorAll('.cp-applicant').length + 1, guarSeq));
            updateAddButtons();
            guarList.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
    }

    [coList, guarList].forEach(function (container) {
        if (!container) { return; }
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

        if (!name.value.trim()) { D.setFieldError(name, 'Enter the full name.'); ok = false; }
        if (!relationship.value) { D.setFieldError(relationship, 'Select a relationship.'); ok = false; }
        if (mobile.value.trim() && !D.isIndianMobile(mobile.value)) {
            D.setFieldError(mobile, 'Enter a valid 10-digit Indian mobile number.'); ok = false;
        }
        if (email.value.trim() && !D.isEmail(email.value)) {
            D.setFieldError(email, 'Enter a valid email address.'); ok = false;
        }
        return ok;
    }

    /* ------------------------------------------------------------------ *
     * Conditional behaviour
     * ------------------------------------------------------------------ */

    function syncEmployment() {
        var type = el('elEmploymentType').value;
        var isSelf = type === 'Self-employed';
        el('salariedFields').classList.toggle('cp-hidden', isSelf);
        el('selfEmployedFields').classList.toggle('cp-hidden', !isSelf);
        el('businessVintageField').classList.toggle('cp-hidden', !isSelf);
        el('workExperienceField').classList.toggle('cp-hidden', isSelf);
    }

    function syncAddress() {
        var same = el('elSameAsCurrent').checked;
        el('permanentAddressBlock').classList.toggle('cp-hidden', same);
    }

    function syncAnnualIncome() {
        var monthly = numOrNull(el('elMonthlyIncome').value);
        var annual = el('elAnnualIncome');
        if (monthly && !annual.value) {
            annual.placeholder = 'e.g. ' + (monthly * 12).toLocaleString('en-IN');
        }
    }

    function syncAdditionalTopup() {
        var block = el('additionalTopupBlock');
        if (!block) { return; }
        block.classList.toggle('cp-hidden', !el('elTopupRequired').checked);
    }

    /* ------------------------------------------------------------------ *
     * Indicative calculators
     * ------------------------------------------------------------------ */

    function updateIndicative() {
        if (IS_TAKEOVER) { updateTakeoverEstimate(); } else { updateTopupEstimate(); }
    }

    function updateTopupEstimate() {
        var box = el('topupEstimate');
        if (!box) { return; }

        var outstanding = numOrNull(el('elCurrentOutstanding').value);
        var topup = numOrNull(el('elTopupAmount').value);
        var rate = numOrNull(el('elInterestRate').value);
        var remaining = numOrNull(el('elRemainingTenure').value);
        var propertyValue = numOrNull(el('elPropertyMarketValue').value);
        var currentEmi = numOrNull(el('elCurrentEmi').value);

        if (!topup) {
            box.textContent = 'Enter your current outstanding, the top-up amount and (optionally) your rate, remaining tenure and property value to see an indicative combined EMI and LTV.';
            return;
        }

        var months = remaining && remaining > 0 ? remaining : 240;
        var topupEmi = emiFor(topup, rate || 8.5, months);
        var combined = (currentEmi || 0) + (topupEmi || 0);
        var ltv = (propertyValue && propertyValue > 0 && outstanding)
            ? ((outstanding + topup) / propertyValue) * 100
            : null;

        var text = 'Indicative combined EMI: <strong>' + money(Math.round(combined)) + '</strong> per month ' +
            '(top-up EMI ' + money(Math.round(topupEmi)) + ' + current EMI ' + money(currentEmi || 0) + ') ' +
            'at ' + (rate || 8.5) + '% p.a. over ' + months + ' months.';
        if (ltv !== null) {
            text += ' Indicative LTV (outstanding + top-up against property value): <strong>' + ltv.toFixed(2) + '%</strong>.';
        }
        text += ' Figures are indicative - your lender decides the final rate, tenure and EMI.';
        box.innerHTML = text;
    }

    function updateTakeoverEstimate() {
        var box = el('emiComparison');
        if (!box) { return; }

        var newAmount = numOrNull(el('elNewLoanAmount').value);
        var currentRate = numOrNull(el('elInterestRate').value);
        var desiredRate = numOrNull(el('elDesiredRate').value);
        var desiredTenure = numOrNull(el('elDesiredTenure').value);
        var currentEmi = numOrNull(el('elCurrentEmi').value);
        var remaining = numOrNull(el('elRemainingTenure').value);

        if (!newAmount || !desiredTenure) {
            box.textContent = 'Enter your expected new loan amount, the current outstanding details and your desired tenure to compare the EMI and estimate your interest saving.';
            return;
        }

        var effectiveRate = desiredRate || Math.max((currentRate || 8.5) - 0.5, 1);
        var newEmi = emiFor(newAmount, effectiveRate, desiredTenure);
        var lines = ['Indicative new EMI: <strong>' + money(Math.round(newEmi)) + '</strong> per month at ' + effectiveRate + '% p.a. over ' + desiredTenure + ' months.'];

        if (currentEmi) {
            var diff = newEmi - currentEmi;
            lines.push('EMI change vs your current EMI of ' + money(currentEmi) + ': <strong>' +
                (diff >= 0 ? '+' : '-') + money(Math.abs(Math.round(diff))) + '</strong> per month.');
        }
        if (currentEmi && remaining && remaining > 0) {
            var saving = (currentEmi * remaining) - (newEmi * desiredTenure);
            lines.push('Estimated interest/repayment saving over the remaining term: <strong>' + money(Math.round(saving)) + '</strong>.');
        }
        lines.push('Figures are indicative and exclude processing or foreclosure charges - your new lender confirms the final offer.');
        box.innerHTML = lines.join(' ');
    }

    /* ------------------------------------------------------------------ *
     * Step navigation
     * ------------------------------------------------------------------ */

    function renderStepper() {
        if (!stepper) { return; }
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

    if (stepper) {
        stepper.addEventListener('click', function (event) {
            var item = event.target.closest('.cp-stepper-item');
            if (!item) { return; }
            var index = Number(item.getAttribute('data-step'));
            if (index <= maxStep) { showStep(index, true); }
        });
    }

    /* ------------------------------------------------------------------ *
     * Validation
     * ------------------------------------------------------------------ */

    function validatePersonal() {
        var ok = true;
        var first = el('elFirstName'), last = el('elLastName'), dob = el('elDob');
        var mobile = el('elMobile'), email = el('elEmail'), pan = el('elPan'), aadhaar = el('elAadhaar');

        if (!first.value.trim()) { D.setFieldError(first, 'Enter your first name.'); ok = false; }
        if (!last.value.trim()) { D.setFieldError(last, 'Enter your last name.'); ok = false; }
        if (!dob.value) {
            D.setFieldError(dob, 'Enter your date of birth.');
            ok = false;
        } else {
            var age = ageFrom(dob.value);
            if (age === null || age < 18) {
                D.setFieldError(dob, 'The applicant must be at least 18 years old.'); ok = false;
            } else if (age > 70) {
                D.setFieldError(dob, 'The applicant age must be 70 years or below.'); ok = false;
            }
        }
        if (!mobile.value.trim()) {
            D.setFieldError(mobile, 'Enter your mobile number.'); ok = false;
        } else if (!D.isIndianMobile(mobile.value)) {
            D.setFieldError(mobile, 'Enter a valid 10-digit Indian mobile number.'); ok = false;
        }
        if (!D.isEmail(email.value)) { D.setFieldError(email, 'Enter a valid email address.'); ok = false; }
        if (!/^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/.test(pan.value.trim())) {
            D.setFieldError(pan, 'Enter a valid PAN (e.g. ABCDE1234F).'); ok = false;
        }
        var aadhaarDigits = D.digits(aadhaar.value);
        if (aadhaarDigits && aadhaarDigits.length !== 12) {
            D.setFieldError(aadhaar, 'Enter a valid 12-digit Aadhaar number.'); ok = false;
        }
        return ok;
    }

    function validateEmployment() {
        var ok = true;
        var type = el('elEmploymentType');
        var monthly = el('elMonthlyIncome');
        if (!type.value) { D.setFieldError(type, 'Select your employment type.'); ok = false; }
        if (type.value === 'Salaried') {
            var employer = el('elEmployerName');
            if (!employer.value.trim()) { D.setFieldError(employer, 'Enter your employer name.'); ok = false; }
        }
        if (type.value === 'Self-employed') {
            var business = el('elBusinessName');
            if (!business.value.trim()) { D.setFieldError(business, 'Enter your business name.'); ok = false; }
        }
        if (!monthly.value || Number(monthly.value) <= 0) {
            D.setFieldError(monthly, 'Enter your monthly income.'); ok = false;
        }
        return ok;
    }

    function validateExisting() {
        var ok = true;
        var lender = el('elLenderName'), outstanding = el('elCurrentOutstanding');
        var origTenure = el('elOriginalTenure'), remaining = el('elRemainingTenure');
        var rate = el('elInterestRate'), sanctioned = el('elSanctionedAmount');

        if (!lender.value.trim()) {
            D.setFieldError(lender, IS_TAKEOVER
                ? 'Enter the bank or NBFC that holds your current loan.'
                : 'Enter the bank or NBFC that holds your current home loan.');
            ok = false;
        }
        if (!outstanding.value || Number(outstanding.value) <= 0) {
            D.setFieldError(outstanding, IS_TAKEOVER
                ? 'Enter your current outstanding principal.'
                : 'Enter your current outstanding balance.');
            ok = false;
        }
        if (sanctioned.value && Number(sanctioned.value) < 0) {
            D.setFieldError(sanctioned, 'Enter a valid original sanctioned amount.'); ok = false;
        }
        if (origTenure.value && (Number(origTenure.value) < 12 || Number(origTenure.value) > 480)) {
            D.setFieldError(origTenure, 'Enter the original tenure in months (12 to 480).'); ok = false;
        }
        if (remaining.value && (Number(remaining.value) < 0 || Number(remaining.value) > 480)) {
            D.setFieldError(remaining, 'Enter the remaining tenure in months (0 to 480).'); ok = false;
        }
        if (rate.value && (Number(rate.value) < 0 || Number(rate.value) > 40)) {
            D.setFieldError(rate, 'Enter a valid interest rate (0 to 40).'); ok = false;
        }
        return ok;
    }

    function validateRequirement() {
        var ok = true;

        if (IS_TAKEOVER) {
            var amount = el('elNewLoanAmount');
            var desiredTenure = el('elDesiredTenure');
            var desiredRate = el('elDesiredRate');

            if (!amount.value || Number(amount.value) < 100000) {
                D.setFieldError(amount, 'Enter an expected loan amount of at least \u20B91,00,000.'); ok = false;
            }
            if (!desiredTenure.value) {
                D.setFieldError(desiredTenure, 'Select your desired tenure.'); ok = false;
            }
            if (desiredRate.value && (Number(desiredRate.value) < 0 || Number(desiredRate.value) > 40)) {
                D.setFieldError(desiredRate, 'Enter a valid desired interest rate (0 to 40).'); ok = false;
            }
            if (el('elTopupRequired').checked) {
                var topupAmount = el('elAdditionalTopupAmount');
                var topupPurpose = el('elAdditionalTopupPurpose');
                if (!topupAmount.value || Number(topupAmount.value) < 50000) {
                    D.setFieldError(topupAmount, 'Enter an additional top-up amount of at least \u20B950,000.'); ok = false;
                }
                if (!topupPurpose.value) {
                    D.setFieldError(topupPurpose, 'Select the purpose of the additional top-up.'); ok = false;
                }
            }
        } else {
            var topup = el('elTopupAmount');
            var purpose = el('elTopupPurpose');
            if (!topup.value || Number(topup.value) < 50000) {
                D.setFieldError(topup, 'Enter a top-up amount of at least \u20B950,000.'); ok = false;
            }
            if (!purpose.value) {
                D.setFieldError(purpose, 'Select the purpose of the top-up.'); ok = false;
            }
        }
        return ok;
    }

    function validateProperty() {
        var ok = true;
        var marketValue = el('elPropertyMarketValue');
        if (marketValue.value && Number(marketValue.value) <= 0) {
            D.setFieldError(marketValue, 'Enter a valid property market value.'); ok = false;
        }
        return ok;
    }

    function validateAddress() {
        var ok = true;
        [['elCurrentAddressLine', 'Enter your current address.'],
         ['elCurrentCity', 'Enter your city.'],
         ['elCurrentState', 'Select your state.'],
         ['elCurrentPincode', 'Enter your 6-digit PIN code.']].forEach(function (pair) {
            var field = el(pair[0]);
            if (!field.value.trim()) { D.setFieldError(field, pair[1]); ok = false; }
        });
        var curPin = el('elCurrentPincode');
        if (curPin.value.trim() && !/^[0-9]{6}$/.test(curPin.value.trim())) {
            D.setFieldError(curPin, 'Enter a valid 6-digit PIN code.'); ok = false;
        }
        if (!el('elSameAsCurrent').checked) {
            [['elPermanentAddressLine', 'Enter your permanent address.'],
             ['elPermanentCity', 'Enter your city.'],
             ['elPermanentState', 'Select your state.'],
             ['elPermanentPincode', 'Enter your 6-digit PIN code.']].forEach(function (pair) {
                var field = el(pair[0]);
                if (!field.value.trim()) { D.setFieldError(field, pair[1]); ok = false; }
            });
            var perPin = el('elPermanentPincode');
            if (perPin.value.trim() && !/^[0-9]{6}$/.test(perPin.value.trim())) {
                D.setFieldError(perPin, 'Enter a valid 6-digit PIN code.'); ok = false;
            }
        }
        return ok;
    }

    function validateApplicants() {
        var ok = true;
        [coList, guarList].forEach(function (container) {
            if (!container) { return; }
            Array.prototype.forEach.call(container.querySelectorAll('.cp-applicant'), function (card) {
                if (!validateApplicantCard(card)) { ok = false; }
            });
        });
        return ok;
    }

    function validateOtherLoans() {
        var ok = true;
        if (!emiList) { return true; }
        Array.prototype.forEach.call(emiList.querySelectorAll('[data-emi]'), function (card) {
            var bank = card.querySelector('[data-field="bank_name"]');
            if (!bank.value.trim()) { D.setFieldError(bank, 'Enter the bank or lender name.'); ok = false; }
        });
        return ok;
    }

    function validateStep(index) {
        if (index === STEP.personal) { return validatePersonal(); }
        if (index === STEP.employment) { return validateEmployment(); }
        if (index === STEP.existing) { return validateExisting(); }
        if (index === STEP.requirement) { return validateRequirement(); }
        if (index === STEP.property) { return validateProperty(); }
        if (!IS_TAKEOVER && index === STEP.otherLoans) { return validateOtherLoans(); }
        if (!IS_TAKEOVER && index === STEP.address) { return validateAddress() && validateApplicants(); }
        if (IS_TAKEOVER && index === STEP.address) { return validateAddress(); }
        if (IS_TAKEOVER && index === STEP.applicants) { return validateApplicants(); }
        return true;
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
        var same = el('elSameAsCurrent').checked;
        var payload = {
            personal: {
                first_name: value('elFirstName'),
                middle_name: value('elMiddleName'),
                last_name: value('elLastName'),
                date_of_birth: el('elDob').value || '',
                gender: el('elGender').value,
                marital_status: el('elMaritalStatus').value,
                mobile: value('elMobile'),
                email: value('elEmail'),
                pan_number: value('elPan').toUpperCase(),
                aadhaar_number: D.digits(el('elAadhaar').value)
            },
            employment: {
                employment_type: el('elEmploymentType').value,
                employer_name: value('elEmployerName'),
                business_name: value('elBusinessName'),
                designation: value('elDesignation'),
                monthly_income: numOrNull(el('elMonthlyIncome').value),
                annual_income: numOrNull(el('elAnnualIncome').value),
                work_experience_years: numOrNull(el('elWorkExperience').value),
                business_vintage_years: numOrNull(el('elBusinessVintage').value)
            },
            property: {
                address: value('elPropertyAddress'),
                city: value('elPropertyCity'),
                state: el('elPropertyState').value,
                pincode: value('elPropertyPincode'),
                property_type: el('elPropertyType').value,
                market_value: numOrNull(el('elPropertyMarketValue').value),
                ownership_type: el('elOwnership').value
            },
            address: {
                current: {
                    line: value('elCurrentAddressLine'),
                    city: value('elCurrentCity'),
                    state: el('elCurrentState').value,
                    pincode: value('elCurrentPincode')
                },
                same_as_current: same,
                permanent: {
                    line: value('elPermanentAddressLine'),
                    city: value('elPermanentCity'),
                    state: el('elPermanentState').value,
                    pincode: value('elPermanentPincode')
                }
            },
            co_applicants: coList ? Array.prototype.map.call(coList.querySelectorAll('.cp-applicant'), collectApplicant) : [],
            guarantors: guarList ? Array.prototype.map.call(guarList.querySelectorAll('.cp-applicant'), collectApplicant) : [],
            consent: true,
            consent_version: D.CONSENT_VERSION,
            source_page: window.location.pathname
        };

        if (IS_TAKEOVER) {
            payload.existing_loan = {
                lender_name: value('elLenderName'),
                lender_type: el('elLenderType').value,
                loan_account_number: value('elLoanAccount'),
                original_sanctioned_amount: numOrNull(el('elSanctionedAmount').value),
                current_outstanding_principal: numOrNull(el('elCurrentOutstanding').value),
                current_interest_rate: numOrNull(el('elInterestRate').value),
                interest_type: el('elInterestType').value,
                current_emi: numOrNull(el('elCurrentEmi').value),
                original_tenure_months: numOrNull(el('elOriginalTenure').value),
                remaining_tenure_months: numOrNull(el('elRemainingTenure').value),
                loan_start_date: el('elLoanStartDate').value || '',
                repayment_history: el('elRepaymentHistory').value,
                overdue_status: el('elOverdueStatus').value
            };
            var topupRequired = el('elTopupRequired').checked;
            payload.transfer = {
                expected_new_loan_amount: numOrNull(el('elNewLoanAmount').value),
                desired_interest_rate: numOrNull(el('elDesiredRate').value),
                desired_tenure_months: numOrNull(el('elDesiredTenure').value),
                additional_topup_required: topupRequired,
                additional_topup_amount: topupRequired ? numOrNull(el('elAdditionalTopupAmount').value) : null,
                additional_topup_purpose: topupRequired ? el('elAdditionalTopupPurpose').value : ''
            };
        } else {
            payload.existing_loan = {
                lender_name: value('elLenderName'),
                lender_type: el('elLenderType').value,
                loan_account_number: value('elLoanAccount'),
                sanctioned_amount: numOrNull(el('elSanctionedAmount').value),
                current_outstanding: numOrNull(el('elCurrentOutstanding').value),
                original_tenure_months: numOrNull(el('elOriginalTenure').value),
                remaining_tenure_months: numOrNull(el('elRemainingTenure').value),
                current_interest_rate: numOrNull(el('elInterestRate').value),
                interest_type: el('elInterestType').value,
                current_emi: numOrNull(el('elCurrentEmi').value)
            };
            payload.topup = {
                amount: numOrNull(el('elTopupAmount').value),
                purpose: el('elTopupPurpose').value
            };
            payload.emis = collectEmis();
        }

        return payload;
    }

    /* ------------------------------------------------------------------ *
     * Document checklist + review
     * ------------------------------------------------------------------ */

    function checklistGroups() {
        var payload = buildPayload();
        var salaried = payload.employment.employment_type === 'Salaried';
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

        if (salaried) {
            groups.push({
                title: 'Income proof (salaried)',
                items: [
                    { label: 'Salary slips - last 3 months', required: true },
                    { label: 'Bank statement - last 6 months', required: true },
                    { label: 'Form 16 - last 2 years', required: false }
                ]
            });
        } else {
            groups.push({
                title: 'Income proof (self-employed)',
                items: [
                    { label: 'ITR - last 2 years', required: true },
                    { label: 'Bank statement - last 12 months', required: true },
                    { label: 'Business proof (GST / Udyam / registration)', required: true },
                    { label: 'Profit & loss and balance sheet', required: false }
                ]
            });
        }

        var loanItems = [
            { label: 'Latest sanction letter of your existing loan', required: true },
            { label: 'Latest loan account statement', required: true },
            { label: 'Outstanding / foreclosure certificate from the existing lender', required: true },
            { label: 'Repayment history / track record', required: true }
        ];
        if (!IS_TAKEOVER) {
            loanItems.push({ label: 'Property tax receipt and NOC', required: false });
        }
        groups.push({ title: IS_TAKEOVER ? 'Existing loan & transfer documents' : 'Existing home loan documents', items: loanItems });

        groups.push({
            title: 'Property documents',
            items: [
                { label: 'Title deed / ownership documents', required: true },
                { label: 'Approved building plan and layout', required: false },
                { label: 'Latest property tax receipt', required: false }
            ]
        });

        if (!IS_TAKEOVER && payload.emis && payload.emis.length) {
            groups.push({
                title: 'Other running loan documents',
                items: [
                    { label: 'Latest statement of each running loan', required: true },
                    { label: 'Repayment schedule of each running loan', required: false }
                ]
            });
        }

        return groups;
    }

    function renderChecklist() {
        var container = el('docChecklist');
        if (!container) { return; }
        container.innerHTML = checklistGroups().map(function (group) {
            var items = group.items.map(function (item) {
                return '<div class="cp-check-item' + (item.required ? '' : ' is-optional') + '">' +
                    '<i class="fa fa-' + (item.required ? 'check-circle' : 'circle-o') + '"></i>' +
                    '<span>' + D.escapeHtml(item.label) + (item.required ? '' : ' (optional)') + '</span></div>';
            }).join('');
            return '<div class="cp-checklist-group"><h4>' + D.escapeHtml(group.title) + '</h4>' + items + '</div>';
        }).join('');
    }

    function reviewRow(label, val) {
        return '<div class="cp-review-row"><span>' + D.escapeHtml(label) + '</span><span>' +
            D.escapeHtml(val || '\u2014') + '</span></div>';
    }

    function renderReview() {
        var p = buildPayload();
        var existing = p.existing_loan;
        var blocks = [];

        blocks.push({
            step: STEP.personal,
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
            step: STEP.employment,
            title: 'Employment & income',
            rows: [
                reviewRow('Employment type', p.employment.employment_type),
                reviewRow(p.employment.employment_type === 'Self-employed' ? 'Business' : 'Employer',
                    p.employment.employment_type === 'Self-employed' ? p.employment.business_name : p.employment.employer_name),
                reviewRow('Monthly income', money(p.employment.monthly_income)),
                reviewRow('Annual income', p.employment.annual_income
                    ? money(p.employment.annual_income)
                    : (p.employment.monthly_income ? money(p.employment.monthly_income * 12) + ' (calculated)' : '\u2014'))
            ]
        });

        var existingRows = [
            reviewRow('Existing lender', existing.lender_name),
            reviewRow('Lender type', existing.lender_type),
            reviewRow('Loan account number', existing.loan_account_number),
            reviewRow('Original sanctioned amount', existing.original_sanctioned_amount
                ? money(existing.original_sanctioned_amount) : (existing.sanctioned_amount ? money(existing.sanctioned_amount) : null)),
            reviewRow(IS_TAKEOVER ? 'Current outstanding principal' : 'Current outstanding',
                money(existing.current_outstanding_principal || existing.current_outstanding)),
            reviewRow('Original tenure', existing.original_tenure_months ? existing.original_tenure_months + ' months' : null),
            reviewRow('Remaining tenure', existing.remaining_tenure_months !== null && existing.remaining_tenure_months !== undefined
                ? existing.remaining_tenure_months + ' months' : null),
            reviewRow('Current interest rate', existing.current_interest_rate ? existing.current_interest_rate + '% p.a.' : null),
            reviewRow('Interest type', existing.interest_type),
            reviewRow('Current EMI', existing.current_emi ? money(existing.current_emi) : null)
        ];
        if (IS_TAKEOVER) {
            existingRows.splice(7, 0,
                reviewRow('Loan start date', existing.loan_start_date),
                reviewRow('Repayment history', existing.repayment_history),
                reviewRow('Overdue status', existing.overdue_status));
        }
        blocks.push({ step: STEP.existing, title: 'Existing loan details', rows: existingRows });

        if (IS_TAKEOVER) {
            blocks.push({
                step: STEP.requirement,
                title: 'Takeover requirement',
                rows: [
                    reviewRow('Expected new loan amount', money(p.transfer.expected_new_loan_amount)),
                    reviewRow('Desired interest rate', p.transfer.desired_interest_rate ? p.transfer.desired_interest_rate + '% p.a.' : 'Best available rate'),
                    reviewRow('Desired tenure', p.transfer.desired_tenure_months ? p.transfer.desired_tenure_months + ' months' : null),
                    reviewRow('Additional top-up', p.transfer.additional_topup_required
                        ? money(p.transfer.additional_topup_amount) + ' (' + (p.transfer.additional_topup_purpose || 'purpose not set') + ')'
                        : 'Not required')
                ]
            });
        } else {
            blocks.push({
                step: STEP.requirement,
                title: 'Top-up requirement',
                rows: [
                    reviewRow('Top-up amount', money(p.topup.amount)),
                    reviewRow('Purpose', p.topup.purpose)
                ]
            });
        }

        blocks.push({
            step: STEP.property,
            title: 'Property',
            rows: [
                reviewRow('Property address', [p.property.address, p.property.city, p.property.state, p.property.pincode].filter(Boolean).join(', ')),
                reviewRow('Property type', p.property.property_type),
                reviewRow('Current market value', p.property.market_value ? money(p.property.market_value) : null),
                reviewRow('Ownership', p.property.ownership_type)
            ]
        });

        if (!IS_TAKEOVER) {
            blocks.push({
                step: STEP.otherLoans,
                title: 'Other running loans',
                rows: p.emis.length ? p.emis.map(function (emi, index) {
                    return reviewRow('Loan ' + (index + 1), (emi.bank_name || '') + (emi.monthly_emi ? ' - ' + money(emi.monthly_emi) + '/month' : ''));
                }) : [reviewRow('Obligations', 'None declared')]
            });
        }

        var applicants = p.co_applicants.length + p.guarantors.length;
        var applicantRows = [reviewRow('Current address',
            [p.address.current.line, p.address.current.city, p.address.current.state, p.address.current.pincode].filter(Boolean).join(', ')),
            reviewRow('Permanent address', p.address.same_as_current
                ? 'Same as current'
                : [p.address.permanent.line, p.address.permanent.city, p.address.permanent.state, p.address.permanent.pincode].filter(Boolean).join(', '))];
        if (applicants) {
            applicantRows = applicantRows
                .concat(p.co_applicants.map(function (a) { return reviewRow('Co-applicant', a.full_name + (a.relationship ? ' (' + a.relationship + ')' : '')); }))
                .concat(p.guarantors.map(function (a) { return reviewRow('Guarantor', a.full_name + (a.relationship ? ' (' + a.relationship + ')' : '')); }));
        } else {
            applicantRows.push(reviewRow('Co-applicants', 'None added'));
        }
        blocks.push({ step: IS_TAKEOVER ? STEP.address : STEP.address, title: 'Address & applicants', rows: applicantRows });

        el('reviewSummary').innerHTML = blocks.map(function (block) {
            return '<div class="cp-review-block">' +
                '<h4><span>' + D.escapeHtml(block.title) + '</span>' +
                '<button type="button" data-goto="' + block.step + '">Edit</button></h4>' +
                block.rows.join('') + '</div>';
        }).join('');
    }

    el('reviewSummary').addEventListener('click', function (event) {
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
        try { window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ id: id, token: token, at: Date.now() })); }
        catch (err) { /* ignore quota / privacy errors */ }
    }

    function clearStoredDraft() {
        try { window.localStorage.removeItem(DRAFT_KEY); } catch (err) { /* ignore */ }
    }

    function resumeLink() {
        return window.location.origin + window.location.pathname + '#draft=' + encodeURIComponent(draftId) + '&token=' + encodeURIComponent(draftToken);
    }

    async function saveDraft() {
        var result = await D.rpc('save_home_loan_draft', {
            p_payload: buildPayload(),
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

    function setValue(id, val) {
        var field = el(id);
        if (field) { field.value = (val === null || val === undefined) ? '' : val; }
    }

    function applyPayload(payload) {
        var personal = payload.personal || {};
        var employment = payload.employment || {};
        var existing = payload.existing_loan || {};
        var property = payload.property || {};
        var address = payload.address || {};

        setValue('elFirstName', personal.first_name);
        setValue('elMiddleName', personal.middle_name);
        setValue('elLastName', personal.last_name);
        setValue('elDob', personal.date_of_birth);
        setValue('elGender', personal.gender);
        setValue('elMaritalStatus', personal.marital_status);
        setValue('elMobile', personal.mobile);
        setValue('elEmail', personal.email);
        setValue('elPan', personal.pan_number);
        setValue('elAadhaar', personal.aadhaar_number);

        setValue('elEmploymentType', employment.employment_type);
        setValue('elEmployerName', employment.employer_name);
        setValue('elBusinessName', employment.business_name);
        setValue('elDesignation', employment.designation);
        setValue('elMonthlyIncome', employment.monthly_income);
        setValue('elAnnualIncome', employment.annual_income);
        setValue('elWorkExperience', employment.work_experience_years);
        setValue('elBusinessVintage', employment.business_vintage_years);

        setValue('elLenderName', existing.lender_name);
        setValue('elLenderType', existing.lender_type);
        setValue('elLoanAccount', existing.loan_account_number);
        setValue('elSanctionedAmount', existing.original_sanctioned_amount || existing.sanctioned_amount);
        setValue('elCurrentOutstanding', existing.current_outstanding_principal || existing.current_outstanding);
        setValue('elOriginalTenure', existing.original_tenure_months);
        setValue('elRemainingTenure', existing.remaining_tenure_months);
        setValue('elInterestRate', existing.current_interest_rate);
        setValue('elInterestType', existing.interest_type);
        setValue('elCurrentEmi', existing.current_emi);
        if (IS_TAKEOVER) {
            setValue('elLoanStartDate', existing.loan_start_date);
            setValue('elRepaymentHistory', existing.repayment_history);
            setValue('elOverdueStatus', existing.overdue_status);
        }

        if (IS_TAKEOVER) {
            var transfer = payload.transfer || {};
            setValue('elNewLoanAmount', transfer.expected_new_loan_amount);
            setValue('elDesiredRate', transfer.desired_interest_rate);
            setValue('elDesiredTenure', transfer.desired_tenure_months);
            if (el('elTopupRequired')) { el('elTopupRequired').checked = !!transfer.additional_topup_required; }
            setValue('elAdditionalTopupAmount', transfer.additional_topup_amount);
            setValue('elAdditionalTopupPurpose', transfer.additional_topup_purpose);
        } else {
            var topup = payload.topup || {};
            setValue('elTopupAmount', topup.amount);
            setValue('elTopupPurpose', topup.purpose);

            if (emiList) {
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
            }
        }

        setValue('elPropertyAddress', property.address);
        setValue('elPropertyCity', property.city);
        setValue('elPropertyState', property.state);
        setValue('elPropertyPincode', property.pincode);
        setValue('elPropertyType', property.property_type);
        setValue('elPropertyMarketValue', property.market_value);
        setValue('elOwnership', property.ownership_type);

        var currentAddr = address.current || {};
        setValue('elCurrentAddressLine', currentAddr.line);
        setValue('elCurrentCity', currentAddr.city);
        setValue('elCurrentState', currentAddr.state);
        setValue('elCurrentPincode', currentAddr.pincode);

        var permanentAddr = address.permanent || {};
        el('elSameAsCurrent').checked = !!address.same_as_current;
        setValue('elPermanentAddressLine', permanentAddr.line);
        setValue('elPermanentCity', permanentAddr.city);
        setValue('elPermanentState', permanentAddr.state);
        setValue('elPermanentPincode', permanentAddr.pincode);

        if (coList) {
            coList.innerHTML = '';
            (Array.isArray(payload.co_applicants) ? payload.co_applicants : []).forEach(function (a) {
                coSeq += 1;
                coList.insertAdjacentHTML('beforeend', applicantTemplate('co_applicant', coList.querySelectorAll('.cp-applicant').length + 1, coSeq));
                fillApplicant(coList.lastElementChild, a);
            });
        }
        if (guarList) {
            guarList.innerHTML = '';
            (Array.isArray(payload.guarantors) ? payload.guarantors : []).forEach(function (a) {
                guarSeq += 1;
                guarList.insertAdjacentHTML('beforeend', applicantTemplate('guarantor', guarList.querySelectorAll('.cp-applicant').length + 1, guarSeq));
                fillApplicant(guarList.lastElementChild, a);
            });
        }
        updateAddButtons();

        syncEmployment();
        syncAddress();
        syncAdditionalTopup();
        updateIndicative();
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
        if (emiList) { emiList.innerHTML = ''; }
        if (coList) { coList.innerHTML = ''; }
        if (guarList) { guarList.innerHTML = ''; }
        updateEmiState();
        updateAddButtons();
        syncEmployment();
        syncAddress();
        syncAdditionalTopup();
        updateIndicative();
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
                D.notify('success', 'Draft restored', 'Your saved application has been loaded.');
                return;
            } catch (err) {
                console.warn('Failed to resume draft from link:', err);
                D.showAlert(alertBox, 'warning', 'The resume link could not be loaded. ' + D.friendlyError(err), 'Draft unavailable');
            }
        }
        if (readStoredDraft() && draftBar) {
            draftBar.classList.remove('cp-hidden');
            draftBarText.textContent = 'We found a saved draft of this application on this device.';
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
        saveDraft().catch(function (err) { console.warn('Background draft save failed:', err); });
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

        // Validate every step that carries inputs (the last step is review).
        var stepsToCheck = IS_TAKEOVER
            ? [STEP.personal, STEP.employment, STEP.existing, STEP.requirement, STEP.property, STEP.address, STEP.applicants]
            : [STEP.personal, STEP.employment, STEP.existing, STEP.requirement, STEP.property, STEP.otherLoans, STEP.address];

        for (var i = 0; i < stepsToCheck.length; i++) {
            if (!validateStep(stepsToCheck[i])) {
                showStep(stepsToCheck[i], true);
                focusFirstError();
                return;
            }
        }

        if (!consentBox.checked) {
            D.showAlert(alertBox, 'warning',
                'Please accept the privacy notice and confirm your details before submitting.',
                'Consent required');
            consentBox.focus();
            return;
        }

        D.setLoading(submitBtn, true, 'Submitting application\u2026');
        try {
            var result = await D.rpc(RPC_NAME, {
                p_payload: buildPayload(),
                p_draft_id: draftId,
                p_draft_token: draftToken
            });
            clearStoredDraft();
            showSuccess(result);
        } catch (err) {
            console.error('Application submission failed:', err);
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
            'Your application has been received. Reference: ' + (result.reference_no || '\u2014') + '.',
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
        if (event.target.id === 'elMonthlyIncome') { syncAnnualIncome(); }
        if (['elCurrentOutstanding', 'elTopupAmount', 'elInterestRate', 'elRemainingTenure',
             'elPropertyMarketValue', 'elCurrentEmi', 'elNewLoanAmount', 'elDesiredRate',
             'elDesiredTenure'].indexOf(event.target.id) > -1) {
            updateIndicative();
        }
    });

    form.addEventListener('change', function (event) {
        if (event.target.classList.contains('form-control')) {
            D.clearFieldError(event.target);
        }
        if (event.target.id === 'elEmploymentType') { syncEmployment(); }
        if (event.target.id === 'elSameAsCurrent') { syncAddress(); }
        if (event.target.id === 'elTopupRequired') { syncAdditionalTopup(); }
        if (['elInterestRate', 'elRemainingTenure', 'elDesiredRate', 'elDesiredTenure', 'elCurrentEmi'].indexOf(event.target.id) > -1) {
            updateIndicative();
        }
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
        syncAdditionalTopup();
        updateIndicative();
        showStep(0, false);
        initDraft();
    }

    boot();
})(window, document);

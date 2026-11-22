/**
 * Dhanvi Finserv - multi-step Loan Protection Insurance assistance wizard.
 *
 * Depends on: js/nhost-client.js, js/public-api.js
 *
 * Flow
 *   1    applicant profile, date of birth, occupation, income, address
 *   2    existing loan, lender, outstanding, EMI and remaining tenure
 *   3    coverage requirement, nominee, existing insurance and co-borrower
 *   4    health, occupation-risk and income-proof information for underwriting
 *   5    conditional document checklist
 *   6    review and mandatory insurance declarations / consent
 *
 * Save / resume
 *   A server-side draft is created through save_home_loan_draft() (shared with
 *   the other application wizards) as soon as the first step validates, and
 *   refreshed on every step change. The draft id + secret token are kept in
 *   localStorage so the applicant can resume in the same browser, and
 *   "Save & continue later" also shows a resume link. Submitting promotes the
 *   draft into a real insurance assistance request through
 *   submit_loan_insurance_application().
 *
 * IMPORTANT
 *   Submitting this wizard does NOT issue an insurance policy, approve a
 *   proposal, guarantee coverage or settle a claim. The proposal and policy
 *   fields are controlled by the administrator and can only record what the
 *   authorised insurer has actually confirmed. A quotation is not a policy and
 *   no cover begins until the insurer issues a policy and the premium is paid.
 */
(function (window, document) {
    'use strict';

    var D = window.Dhanvi;
    var form = document.getElementById('insuranceApplicationForm');
    if (!form || !D) { return; }

    var DRAFT_KEY = 'dhanviLoanInsuranceDraft';
    var TOTAL_STEPS = 6;

    var alertBox = document.getElementById('applicationAlert');
    var draftBar = document.getElementById('draftBar');
    var draftBarText = document.getElementById('draftBarText');
    var successBox = document.getElementById('applicationSuccess');
    var stepper = document.getElementById('insuranceStepper');
    var steps = Array.prototype.slice.call(form.querySelectorAll('.cp-step'));
    var prevBtn = document.getElementById('prevBtn');
    var nextBtn = document.getElementById('nextBtn');
    var submitBtn = document.getElementById('submitBtn');
    var saveDraftBtn = document.getElementById('saveDraftBtn');
    var progressText = document.getElementById('progressText');

    var current = 0;
    var maxStep = 0;
    var draftId = null;
    var draftToken = null;

    var STATES = ['Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry'];
    var PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
    var MOBILE_RE = /^[6-9][0-9]{9}$/;
    var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    var PIN_RE = /^[0-9]{6}$/;

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

    function ageFromDob(raw) {
        if (!raw) { return null; }
        var dob = new Date(raw + 'T00:00:00');
        if (isNaN(dob.getTime())) { return null; }
        var today = new Date();
        var age = today.getFullYear() - dob.getFullYear();
        var month = today.getMonth() - dob.getMonth();
        if (month < 0 || (month === 0 && today.getDate() < dob.getDate())) { age -= 1; }
        return age;
    }

    /* ------------------------------------------------------------------ *
     * Static options and conditional behaviour
     * ------------------------------------------------------------------ */

    function initOptions() {
        var select = el('insuranceAddressState');
        if (select) {
            select.innerHTML = '<option value="">Select state</option>' + STATES.map(function (state) {
                return '<option value="' + D.escapeHtml(state) + '">' + D.escapeHtml(state) + '</option>';
            }).join('');
        }
    }

    function syncExistingInsurance() {
        var show = checked('insuranceExistingInsurance');
        var block = el('insuranceExistingInsuranceBlock');
        if (block) { block.classList.toggle('cp-hidden', !show); }
        if (!show) {
            if (el('insuranceExistingInsurer')) { el('insuranceExistingInsurer').value = ''; }
            if (el('insuranceExistingCover')) { el('insuranceExistingCover').value = ''; }
            if (el('insuranceExistingExpiry')) { el('insuranceExistingExpiry').value = ''; }
        }
    }

    function syncCoBorrower() {
        var show = checked('insuranceCoBorrower');
        var block = el('insuranceCoBorrowerBlock');
        if (block) { block.classList.toggle('cp-hidden', !show); }
        if (!show) {
            ['insuranceCoBorrowerName', 'insuranceCoBorrowerRelation',
             'insuranceCoBorrowerDob', 'insuranceCoBorrowerMobile',
             'insuranceCoBorrowerEmail'].forEach(function (id) {
                if (el(id)) { el(id).value = ''; }
            });
        }
    }

    /* ------------------------------------------------------------------ *
     * Document checklist
     * ------------------------------------------------------------------ */

    function buildChecklist() {
        var coverage = value('insuranceCoverageType');
        var hasExisting = checked('insuranceExistingInsurance');
        var medical = checked('insuranceHospitalization') ||
            value('insuranceTobacco') === 'Yes' ||
            value('insuranceMedicalConditions').trim() !== '';
        var property = coverage === 'Property / Fire Insurance' ||
            coverage === 'Loan Protection + Property';

        var identity = ['PAN Card', 'Aadhaar Card', 'Photograph', 'Address Proof'];
        var loan = ['Income Proof', 'Bank Statement', 'Loan Statement', 'Sanction Letter'];
        var insurance = ['Insurance Proposal Form'];

        if (hasExisting) { addIfUnique(insurance, 'Existing Policy'); }
        if (medical) { addIfUnique(insurance, 'Medical Report'); }
        if (property) {
            addIfUnique(insurance, 'Property Documents');
            addIfUnique(insurance, 'Property Tax Receipt');
        }
        addIfUnique(insurance, 'Other');

        var groups = [
            { title: 'Identity & KYC', items: identity },
            { title: 'Loan & income', items: loan },
            { title: 'Insurance & medical', items: insurance }
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
        el('insuranceDocChecklist').innerHTML = groups.map(function (group) {
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
        var loan = payload.loan;
        var coverage = payload.coverage;
        var nominee = payload.nominee;
        var co = payload.co_borrower;
        var underwriting = payload.underwriting;
        var blocks = [];

        blocks.push({
            step: 0,
            title: 'Applicant & address',
            rows: [
                reviewRow('Applicant', personal.applicant_name),
                reviewRow('Date of birth', personal.date_of_birth),
                reviewRow('Gender', personal.gender),
                reviewRow('Mobile', personal.mobile),
                reviewRow('Email', personal.email),
                reviewRow('Occupation', personal.occupation),
                reviewRow('Annual income', personal.annual_income !== null ? money(personal.annual_income) : '\u2014'),
                reviewRow('PAN', personal.pan_number),
                reviewRow('Address', fullAddress(personal.address_line, personal.address_city,
                    personal.address_district, personal.address_state, personal.address_pincode))
            ]
        });

        blocks.push({
            step: 1,
            title: 'Existing loan',
            rows: [
                reviewRow('Loan type', loan.loan_type),
                reviewRow('Lender', loan.lender_name),
                reviewRow('Loan account reference', loan.loan_account_reference),
                reviewRow('Outstanding', loan.outstanding_amount !== null ? money(loan.outstanding_amount) : '\u2014'),
                reviewRow('EMI', loan.emi_amount !== null ? money(loan.emi_amount) : '\u2014'),
                reviewRow('Remaining tenure', loan.remaining_tenure_months !== null ? loan.remaining_tenure_months + ' months' : '\u2014')
            ]
        });

        var coverageRows = [
            reviewRow('Coverage required', coverage.coverage_requirement),
            reviewRow('Desired cover', coverage.desired_cover_amount !== null ? money(coverage.desired_cover_amount) : '\u2014'),
            reviewRow('Policy tenure', coverage.policy_tenure_years !== null ? coverage.policy_tenure_years + ' years' : '\u2014'),
            reviewRow('Premium budget', coverage.premium_budget !== null ? money(coverage.premium_budget) : 'Not specified'),
            reviewRow('Payment frequency', coverage.payment_frequency),
            reviewRow('Preferred insurer', coverage.insurer_preference),
            reviewRow('Existing insurance', coverage.existing_insurance ? 'Yes' : 'No')
        ];
        if (coverage.existing_insurance) {
            coverageRows.push(reviewRow('Existing insurer', coverage.existing_insurer));
            coverageRows.push(reviewRow('Existing cover', coverage.existing_cover_amount !== null ? money(coverage.existing_cover_amount) : '\u2014'));
            coverageRows.push(reviewRow('Existing policy expiry', coverage.existing_policy_expiry));
        }
        coverageRows.push(reviewRow('Nominee', [nominee.nominee_name, nominee.nominee_relation].filter(Boolean).join(' \u00b7 ')));
        coverageRows.push(reviewRow('Nominee mobile', nominee.nominee_mobile));
        coverageRows.push(reviewRow('Co-borrower', co.co_borrower ? 'Yes' : 'No'));
        if (co.co_borrower) {
            coverageRows.push(reviewRow('Co-borrower name', co.co_borrower_name));
            coverageRows.push(reviewRow('Co-borrower relationship', co.co_borrower_relation));
            coverageRows.push(reviewRow('Co-borrower mobile', co.co_borrower_mobile));
            coverageRows.push(reviewRow('Co-borrower email', co.co_borrower_email));
        }
        blocks.push({ step: 2, title: 'Coverage, nominee & co-borrower', rows: coverageRows });

        blocks.push({
            step: 3,
            title: 'Health & underwriting',
            rows: [
                reviewRow('Height', underwriting.height_cm !== null ? underwriting.height_cm + ' cm' : 'Not provided'),
                reviewRow('Weight', underwriting.weight_kg !== null ? underwriting.weight_kg + ' kg' : 'Not provided'),
                reviewRow('Tobacco / nicotine', underwriting.tobacco_use),
                reviewRow('Occupation risk', underwriting.occupation_risk),
                reviewRow('Income proof', underwriting.income_proof_type),
                reviewRow('Medical conditions', underwriting.medical_conditions),
                reviewRow('Medications', underwriting.medications),
                reviewRow('Hospitalised in last 3 years', underwriting.hospitalization_last_3_years ? 'Yes' : 'No'),
                reviewRow('Medical test consent', underwriting.medical_test_consent ? 'Given' : 'Not given')
            ]
        });

        var checklist = buildChecklist();
        blocks.push({
            step: 4,
            title: 'Document checklist',
            rows: checklist.map(function (group) {
                return reviewRow(group.title, group.items.join(', '));
            })
        });

        el('insuranceReviewSummary').innerHTML =
            '<div class="cp-info-box"><strong>This is an insurance enquiry</strong><p>Submitting this form does not issue a policy, approve a proposal, guarantee coverage or settle a claim. The authorised insurer decides whether to accept the risk, the premium, exclusions and the final terms. No cover begins until the insurer issues a policy and the premium is paid.</p></div>' +
            blocks.map(function (block) {
                return '<div class="cp-review-block">' +
                    '<h4><span>' + D.escapeHtml(block.title) + '</span>' +
                    '<button type="button" data-goto="' + block.step + '">Edit</button></h4>' +
                    block.rows.join('') +
                    '</div>';
            }).join('');
    }

    el('insuranceReviewSummary').addEventListener('click', function (event) {
        var button = event.target.closest('button[data-goto]');
        if (!button) { return; }
        var index = Number(button.getAttribute('data-goto'));
        if (!isNaN(index)) { showStep(index, true); }
    });

    /* ------------------------------------------------------------------ *
     * Payload
     * ------------------------------------------------------------------ */

    function buildPayload() {
        return {
            personal: {
                applicant_name: value('insuranceApplicantName'),
                date_of_birth: value('insuranceDob'),
                gender: value('insuranceGender'),
                mobile: D.digits(value('insuranceMobile')),
                email: value('insuranceEmail'),
                occupation: value('insuranceOccupation'),
                annual_income: numOrNull(value('insuranceAnnualIncome')),
                pan_number: value('insurancePan').toUpperCase(),
                address_line: value('insuranceAddressLine'),
                address_city: value('insuranceAddressCity'),
                address_district: value('insuranceAddressDistrict'),
                address_state: value('insuranceAddressState'),
                address_pincode: D.digits(value('insuranceAddressPincode'))
            },
            loan: {
                loan_type: value('insuranceLoanType'),
                lender_name: value('insuranceLender'),
                loan_account_reference: value('insuranceLoanReference'),
                outstanding_amount: numOrNull(value('insuranceOutstanding')),
                emi_amount: numOrNull(value('insuranceEmi')),
                remaining_tenure_months: numOrNull(value('insuranceRemainingTenure'))
            },
            coverage: {
                coverage_requirement: value('insuranceCoverageType'),
                desired_cover_amount: numOrNull(value('insuranceCoverAmount')),
                policy_tenure_years: numOrNull(value('insurancePolicyTenure')),
                premium_budget: numOrNull(value('insurancePremiumBudget')),
                payment_frequency: value('insurancePaymentFrequency'),
                existing_insurance: checked('insuranceExistingInsurance'),
                existing_insurer: value('insuranceExistingInsurer'),
                existing_cover_amount: numOrNull(value('insuranceExistingCover')),
                existing_policy_expiry: value('insuranceExistingExpiry'),
                insurer_preference: value('insuranceInsurerPreference')
            },
            nominee: {
                nominee_name: value('insuranceNomineeName'),
                nominee_relation: value('insuranceNomineeRelation'),
                nominee_date_of_birth: value('insuranceNomineeDob'),
                nominee_mobile: D.digits(value('insuranceNomineeMobile'))
            },
            co_borrower: {
                co_borrower: checked('insuranceCoBorrower'),
                co_borrower_name: value('insuranceCoBorrowerName'),
                co_borrower_relation: value('insuranceCoBorrowerRelation'),
                co_borrower_mobile: D.digits(value('insuranceCoBorrowerMobile')),
                co_borrower_email: value('insuranceCoBorrowerEmail'),
                co_borrower_date_of_birth: value('insuranceCoBorrowerDob')
            },
            underwriting: {
                height_cm: numOrNull(value('insuranceHeight')),
                weight_kg: numOrNull(value('insuranceWeight')),
                tobacco_use: value('insuranceTobacco'),
                medical_conditions: value('insuranceMedicalConditions'),
                medications: value('insuranceMedications'),
                hospitalization_last_3_years: checked('insuranceHospitalization'),
                occupation_risk: value('insuranceOccupationRisk'),
                income_proof_type: value('insuranceIncomeProof'),
                medical_test_consent: checked('insuranceMedicalConsent'),
                underwriting_notes: ''
            },
            declarations: {
                accuracy: checked('insuranceAccuracyDeclaration'),
                authorisation: checked('insuranceAuthorisationDeclaration'),
                insurance_disclosure: checked('insuranceDisclosureDeclaration')
            },
            consent: checked('insuranceApplicationConsent'),
            consent_version: '2026-11',
            source_page: 'loan-insurance-apply.html'
        };
    }

    function draftSafePayload() {
        var payload = buildPayload();
        if (payload.loan) { payload.loan.loan_account_reference = ''; }
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

    function validateAmount(id, label, required) {
        var raw = value(id);
        if (raw === '') {
            if (required) {
                D.setFieldError(el(id), 'Enter ' + label + '.');
                return false;
            }
            return true;
        }
        var number = Number(raw);
        if (isNaN(number) || number < 0) {
            D.setFieldError(el(id), label + ' cannot be negative.');
            return false;
        }
        return true;
    }

    function validateCount(id, label, min, max) {
        var raw = value(id);
        if (raw === '') {
            D.setFieldError(el(id), 'Enter ' + label + '.');
            return false;
        }
        var number = Number(raw);
        if (isNaN(number) || Math.floor(number) !== number || number < min || number > max) {
            D.setFieldError(el(id), label + ' must be a whole number between ' + min + ' and ' + max + '.');
            return false;
        }
        return true;
    }

    function validateStep(index) {
        var ok = true;

        if (index === 0) {
            if (!requireField('insuranceApplicantName', 'Enter the applicant name.')) { ok = false; }
            var dob = value('insuranceDob');
            if (!dob) {
                D.setFieldError(el('insuranceDob'), 'Enter the date of birth.');
                ok = false;
            } else {
                var age = ageFromDob(dob);
                if (age === null || age < 18 || age > 75) {
                    D.setFieldError(el('insuranceDob'), 'The applicant must be between 18 and 75 years old. Insurers may apply stricter age limits.');
                    ok = false;
                }
            }
            if (!MOBILE_RE.test(D.digits(value('insuranceMobile')))) {
                D.setFieldError(el('insuranceMobile'), 'Enter a valid 10-digit Indian mobile number.');
                ok = false;
            }
            if (!EMAIL_RE.test(value('insuranceEmail'))) {
                D.setFieldError(el('insuranceEmail'), 'Enter a valid email address.');
                ok = false;
            }
            if (!requireField('insuranceOccupation', 'Enter the occupation.')) { ok = false; }
            if (!validateAmount('insuranceAnnualIncome', 'annual income', true)) { ok = false; }
            var pan = value('insurancePan').toUpperCase();
            if (pan && !PAN_RE.test(pan)) {
                D.setFieldError(el('insurancePan'), 'Enter a valid PAN (e.g. ABCDE1234F) or leave it blank.');
                ok = false;
            }
            if (!requireField('insuranceAddressLine', 'Enter the residential address.')) { ok = false; }
            if (!requireField('insuranceAddressCity', 'Enter the city or town.')) { ok = false; }
            if (!requireField('insuranceAddressState', 'Select the state.')) { ok = false; }
            if (!PIN_RE.test(D.digits(value('insuranceAddressPincode')))) {
                D.setFieldError(el('insuranceAddressPincode'), 'Enter a valid 6-digit PIN code.');
                ok = false;
            }
        }

        if (index === 1) {
            if (!requireField('insuranceLoanType', 'Select the loan type.')) { ok = false; }
            if (!requireField('insuranceLender', 'Enter the lender name.')) { ok = false; }
            if (!requireField('insuranceLoanReference', 'Enter the loan account reference.')) { ok = false; }
            if (!validateAmount('insuranceOutstanding', 'outstanding amount', true)) { ok = false; }
            if (!validateAmount('insuranceEmi', 'EMI amount', true)) { ok = false; }
            if (!validateCount('insuranceRemainingTenure', 'remaining tenure', 0, 600)) { ok = false; }
        }

        if (index === 2) {
            if (!requireField('insuranceCoverageType', 'Select the coverage required.')) { ok = false; }
            if (!validateAmount('insuranceCoverAmount', 'desired cover amount', true)) { ok = false; }
            if (numOrNull(value('insuranceCoverAmount')) === 0) {
                D.setFieldError(el('insuranceCoverAmount'), 'Desired cover amount must be greater than zero.');
                ok = false;
            }
            if (!validateCount('insurancePolicyTenure', 'policy tenure', 1, 40)) { ok = false; }
            if (!validateAmount('insurancePremiumBudget', 'premium budget', false)) { ok = false; }
            if (checked('insuranceExistingInsurance')) {
                if (!requireField('insuranceExistingInsurer', 'Enter the existing insurer name.')) { ok = false; }
                if (!validateAmount('insuranceExistingCover', 'existing cover amount', true)) { ok = false; }
            }
            if (!requireField('insuranceNomineeName', 'Enter the nominee name.')) { ok = false; }
            if (!requireField('insuranceNomineeRelation', 'Select the nominee relationship.')) { ok = false; }
            var nomineeMobile = D.digits(value('insuranceNomineeMobile'));
            if (nomineeMobile && !MOBILE_RE.test(nomineeMobile)) {
                D.setFieldError(el('insuranceNomineeMobile'), 'Enter a valid 10-digit nominee mobile number.');
                ok = false;
            }
            if (checked('insuranceCoBorrower')) {
                if (!requireField('insuranceCoBorrowerName', 'Enter the co-borrower name.')) { ok = false; }
                if (!requireField('insuranceCoBorrowerRelation', 'Select the co-borrower relationship.')) { ok = false; }
                if (!MOBILE_RE.test(D.digits(value('insuranceCoBorrowerMobile')))) {
                    D.setFieldError(el('insuranceCoBorrowerMobile'), 'Enter a valid 10-digit co-borrower mobile number.');
                    ok = false;
                }
                var coEmail = value('insuranceCoBorrowerEmail');
                if (coEmail && !EMAIL_RE.test(coEmail)) {
                    D.setFieldError(el('insuranceCoBorrowerEmail'), 'Enter a valid co-borrower email address.');
                    ok = false;
                }
            }
        }

        if (index === 3) {
            var height = numOrNull(value('insuranceHeight'));
            if (height !== null && (height < 100 || height > 250)) {
                D.setFieldError(el('insuranceHeight'), 'Enter a height between 100 and 250 cm.');
                ok = false;
            }
            var weight = numOrNull(value('insuranceWeight'));
            if (weight !== null && (weight < 25 || weight > 300)) {
                D.setFieldError(el('insuranceWeight'), 'Enter a weight between 25 and 300 kg.');
                ok = false;
            }
            if (!requireField('insuranceTobacco', 'Select your tobacco use status.')) { ok = false; }
            if (!requireField('insuranceOccupationRisk', 'Select the occupation risk category.')) { ok = false; }
            if (!checked('insuranceMedicalConsent')) {
                D.setFieldError(el('insuranceMedicalConsent'), 'Consent to medical tests or underwriting information is required.');
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

        if (current === 4) { renderChecklist(); }
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
                    D.escapeHtml(resumeLink()) + '</code>. For your security, the loan account reference is not stored in drafts; re-enter it when you resume.';
            }
            D.showAlert(alertBox, 'success',
                'Your insurance application has been saved. Bookmark this page or keep the resume link to continue later. The loan account reference is not stored in drafts and must be re-entered when you resume.',
                'Draft saved');
        } catch (err) {
            console.error('Insurance draft save failed:', err);
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
                D.escapeHtml(resumeLink()) + '</code>. The loan account reference is not stored in drafts; please re-enter it.';
        }
    }

    function applyPayload(payload) {
        var personal = payload.personal || {};
        var loan = payload.loan || {};
        var coverage = payload.coverage || {};
        var nominee = payload.nominee || {};
        var co = payload.co_borrower || {};
        var underwriting = payload.underwriting || {};

        el('insuranceApplicantName').value = personal.applicant_name || '';
        el('insuranceDob').value = personal.date_of_birth || '';
        el('insuranceGender').value = personal.gender || '';
        el('insuranceMobile').value = personal.mobile || '';
        el('insuranceEmail').value = personal.email || '';
        el('insuranceOccupation').value = personal.occupation || '';
        el('insuranceAnnualIncome').value = personal.annual_income !== null && personal.annual_income !== undefined ? personal.annual_income : '';
        el('insurancePan').value = personal.pan_number || '';
        el('insuranceAddressLine').value = personal.address_line || '';
        el('insuranceAddressCity').value = personal.address_city || '';
        el('insuranceAddressDistrict').value = personal.address_district || '';
        setSelectValue('insuranceAddressState', personal.address_state || '');
        el('insuranceAddressPincode').value = personal.address_pincode || '';

        el('insuranceLoanType').value = loan.loan_type || '';
        el('insuranceLender').value = loan.lender_name || '';
        el('insuranceLoanReference').value = loan.loan_account_reference || '';
        el('insuranceOutstanding').value = loan.outstanding_amount !== null && loan.outstanding_amount !== undefined ? loan.outstanding_amount : '';
        el('insuranceEmi').value = loan.emi_amount !== null && loan.emi_amount !== undefined ? loan.emi_amount : '';
        el('insuranceRemainingTenure').value = loan.remaining_tenure_months !== null && loan.remaining_tenure_months !== undefined ? loan.remaining_tenure_months : '';

        el('insuranceCoverageType').value = coverage.coverage_requirement || '';
        el('insuranceCoverAmount').value = coverage.desired_cover_amount !== null && coverage.desired_cover_amount !== undefined ? coverage.desired_cover_amount : '';
        el('insurancePolicyTenure').value = coverage.policy_tenure_years !== null && coverage.policy_tenure_years !== undefined ? coverage.policy_tenure_years : '';
        el('insurancePremiumBudget').value = coverage.premium_budget !== null && coverage.premium_budget !== undefined ? coverage.premium_budget : '';
        el('insurancePaymentFrequency').value = coverage.payment_frequency || '';
        el('insuranceInsurerPreference').value = coverage.insurer_preference || '';
        el('insuranceExistingInsurance').checked = !!coverage.existing_insurance;
        el('insuranceExistingInsurer').value = coverage.existing_insurer || '';
        el('insuranceExistingCover').value = coverage.existing_cover_amount !== null && coverage.existing_cover_amount !== undefined ? coverage.existing_cover_amount : '';
        el('insuranceExistingExpiry').value = coverage.existing_policy_expiry || '';

        el('insuranceNomineeName').value = nominee.nominee_name || '';
        el('insuranceNomineeRelation').value = nominee.nominee_relation || '';
        el('insuranceNomineeDob').value = nominee.nominee_date_of_birth || '';
        el('insuranceNomineeMobile').value = nominee.nominee_mobile || '';

        el('insuranceCoBorrower').checked = !!co.co_borrower;
        el('insuranceCoBorrowerName').value = co.co_borrower_name || '';
        el('insuranceCoBorrowerRelation').value = co.co_borrower_relation || '';
        el('insuranceCoBorrowerMobile').value = co.co_borrower_mobile || '';
        el('insuranceCoBorrowerEmail').value = co.co_borrower_email || '';
        el('insuranceCoBorrowerDob').value = co.co_borrower_date_of_birth || '';

        el('insuranceHeight').value = underwriting.height_cm !== null && underwriting.height_cm !== undefined ? underwriting.height_cm : '';
        el('insuranceWeight').value = underwriting.weight_kg !== null && underwriting.weight_kg !== undefined ? underwriting.weight_kg : '';
        el('insuranceTobacco').value = underwriting.tobacco_use || '';
        el('insuranceOccupationRisk').value = underwriting.occupation_risk || '';
        el('insuranceIncomeProof').value = underwriting.income_proof_type || '';
        el('insuranceMedicalConditions').value = underwriting.medical_conditions || '';
        el('insuranceMedications').value = underwriting.medications || '';
        el('insuranceHospitalization').checked = !!underwriting.hospitalization_last_3_years;
        el('insuranceMedicalConsent').checked = !!underwriting.medical_test_consent;

        syncExistingInsurance();
        syncCoBorrower();
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
        syncExistingInsurance();
        syncCoBorrower();
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
                D.notify('success', 'Draft restored', 'Your saved insurance application has been loaded.');
                return;
            } catch (err) {
                console.warn('Failed to resume insurance draft from link:', err);
                D.showAlert(alertBox, 'warning',
                    'The resume link could not be loaded. ' + D.friendlyError(err),
                    'Draft unavailable');
            }
        }
        if (readStoredDraft() && draftBar) {
            draftBar.classList.remove('cp-hidden');
            draftBarText.textContent = 'We found a saved draft of your insurance application on this device.';
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
            console.warn('Background insurance draft save failed:', err);
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

        if (!checked('insuranceAccuracyDeclaration')) {
            D.showAlert(alertBox, 'warning',
                'Please confirm that the information provided is true, complete and accurate, including your health and loan details.',
                'Declaration required');
            el('insuranceAccuracyDeclaration').focus();
            return;
        }
        if (!checked('insuranceAuthorisationDeclaration')) {
            D.showAlert(alertBox, 'warning',
                'Please authorise Dhanvi Finserv to share this enquiry with authorised insurers.',
                'Authorisation required');
            el('insuranceAuthorisationDeclaration').focus();
            return;
        }
        if (!checked('insuranceDisclosureDeclaration')) {
            D.showAlert(alertBox, 'warning',
                'Please confirm that you understand approval, coverage and claim settlement are decided by the insurer.',
                'Insurance disclosure required');
            el('insuranceDisclosureDeclaration').focus();
            return;
        }
        if (!checked('insuranceApplicationConsent')) {
            D.showAlert(alertBox, 'warning',
                'Please accept the privacy notice and insurance consent before submitting.',
                'Consent required');
            el('insuranceApplicationConsent').focus();
            return;
        }

        var payload = buildPayload();
        D.setLoading(submitBtn, true, 'Submitting application\u2026');
        try {
            var result = await D.rpc('submit_loan_insurance_application', {
                p_payload: payload,
                p_draft_id: draftId,
                p_draft_token: draftToken
            });
            clearStoredDraft();
            showSuccess(result);
        } catch (err) {
            console.error('Insurance submission failed:', err);
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
            'Your insurance enquiry has been received. Reference: ' +
            (result.reference_no || '\u2014') + '. This is not a policy, an approval or a guarantee of coverage.',
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
    });

    form.addEventListener('change', function (event) {
        if (event.target.classList.contains('form-control')) {
            D.clearFieldError(event.target);
        }
        if (event.target.id === 'insuranceExistingInsurance') { syncExistingInsurance(); }
        if (event.target.id === 'insuranceCoBorrower') { syncCoBorrower(); }
    });

    /* ------------------------------------------------------------------ *
     * Boot
     * ------------------------------------------------------------------ */

    function boot() {
        initOptions();
        syncExistingInsurance();
        syncCoBorrower();
        showStep(0, false);
        initDraft();
    }

    boot();
})(window, document);

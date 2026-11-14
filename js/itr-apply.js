/**
 * Dhanvi Finserv - multi-step ITR Filing assistance wizard.
 *
 * Depends on: js/nhost-client.js, js/public-api.js
 *
 * Flow
 *   1    applicant identity, PAN, Aadhaar reference, residential status and address
 *   2    assessment / financial year, taxpayer category and return type
 *   3    income sources (salary, business, house property, capital gains,
 *        other sources, agricultural and foreign income)
 *   4    previous filing history and tax-regime preference
 *   5    TDS, advance tax, self-assessment tax and deductions
 *   6    exemptions, refund bank details and tax-saving investments
 *   7    conditional document checklist
 *   8    review and mandatory declarations / consent
 *
 * Save / resume
 *   A server-side draft is created through save_home_loan_draft() (shared with
 *   the other application wizards) as soon as the first step validates, and
 *   refreshed on every step change. The draft id + secret token are kept in
 *   localStorage so the applicant can resume in the same browser, and
 *   "Save & continue later" also shows a resume link. Submitting promotes the
 *   draft into a real ITR assistance request through submit_itr_application().
 *
 * IMPORTANT
 *   Submitting this wizard does NOT file an income tax return. The filing
 *   status is controlled by the administrator and can only be set to
 *   "Filed & Verified" after actual portal filing and acknowledgement
 *   verification.
 */
(function (window, document) {
    'use strict';

    var D = window.Dhanvi;
    var form = document.getElementById('itrApplicationForm');
    if (!form || !D) { return; }

    var DRAFT_KEY = 'dhanviItrDraft';
    var TOTAL_STEPS = 8;

    var alertBox = document.getElementById('applicationAlert');
    var draftBar = document.getElementById('draftBar');
    var draftBarText = document.getElementById('draftBarText');
    var successBox = document.getElementById('applicationSuccess');
    var stepper = document.getElementById('itrStepper');
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
    var IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
    var AY_BY_FY = {
        '2025-26': '2026-27',
        '2024-25': '2025-26',
        '2023-24': '2024-25',
        '2022-23': '2023-24',
        '2021-22': '2022-23'
    };
    var FY_BY_AY = {
        '2026-27': '2025-26',
        '2025-26': '2024-25',
        '2024-25': '2023-24',
        '2023-24': '2022-23',
        '2022-23': '2021-22'
    };

    /* ------------------------------------------------------------------ *
     * Small helpers
     * ------------------------------------------------------------------ */

    function el(id) { return document.getElementById(id); }

    function value(id) {
        var field = el(id);
        return field ? field.value.trim() : '';
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

    function yesNoOrNull(id) {
        var answer = value(id);
        if (answer === 'Yes') { return true; }
        if (answer === 'No') { return false; }
        return null;
    }

    function money(amount) {
        var number = Number(amount);
        if (isNaN(number)) { return '\u2014'; }
        return '\u20B9' + number.toLocaleString('en-IN');
    }

    function fullName() {
        return [value('itrFirstName'), value('itrMiddleName'), value('itrLastName')]
            .filter(Boolean).join(' ');
    }

    function ageFrom(dobValue) {
        if (!dobValue) { return null; }
        var dob = new Date(dobValue);
        if (isNaN(dob.getTime())) { return null; }
        var today = new Date();
        var age = today.getFullYear() - dob.getFullYear();
        var month = today.getMonth() - dob.getMonth();
        if (month < 0 || (month === 0 && today.getDate() < dob.getDate())) { age -= 1; }
        return age;
    }

    function copyFields(map) {
        map.forEach(function (pair) {
            var from = el(pair[0]);
            var to = el(pair[1]);
            if (from && to) { to.value = from.value; }
        });
    }

    function maskAccount(account) {
        var digits = D.digits(account);
        if (!digits) { return ''; }
        if (digits.length <= 4) { return digits; }
        return new Array(digits.length - 3).join('X') + digits.slice(-4);
    }

    function addIfUnique(list, item) {
        if (list.indexOf(item) === -1) { list.push(item); }
    }

    /* ------------------------------------------------------------------ *
     * Static options
     * ------------------------------------------------------------------ */

    function initOptions() {
        ['itrCurrentState', 'itrPermanentState'].forEach(function (id) {
            var select = el(id);
            if (!select) { return; }
            select.innerHTML = '<option value="">Select state</option>' + STATES.map(function (state) {
                return '<option value="' + D.escapeHtml(state) + '">' + D.escapeHtml(state) + '</option>';
            }).join('');
        });
    }

    /* ------------------------------------------------------------------ *
     * Conditional behaviour
     * ------------------------------------------------------------------ */

    function syncPermanentAddress() {
        var same = checked('itrSameAsCurrent');
        el('itrPermanentAddressBlock').classList.toggle('cp-hidden', same);
        if (same) {
            copyFields([
                ['itrCurrentAddressLine', 'itrPermanentAddressLine'],
                ['itrCurrentCity', 'itrPermanentCity'],
                ['itrCurrentState', 'itrPermanentState'],
                ['itrCurrentPincode', 'itrPermanentPincode']
            ]);
        }
    }

    function syncFinancialYear() {
        var fy = value('itrFinancialYear');
        if (fy && AY_BY_FY[fy]) {
            el('itrAssessmentYear').value = AY_BY_FY[fy];
        }
    }

    function syncAssessmentYear() {
        var ay = value('itrAssessmentYear');
        if (ay && FY_BY_AY[ay]) {
            el('itrFinancialYear').value = FY_BY_AY[ay];
        }
    }

    function syncIncomeBlocks() {
        el('itrSalaryBlock').classList.toggle('cp-hidden', !checked('itrHasSalary'));
        el('itrBusinessBlock').classList.toggle('cp-hidden', !checked('itrHasBusiness'));
        el('itrHouseBlock').classList.toggle('cp-hidden', !checked('itrHasHouseProperty'));
        el('itrCapitalGainsBlock').classList.toggle('cp-hidden', !checked('itrHasCapitalGains'));
        el('itrOtherBlock').classList.toggle('cp-hidden', !checked('itrHasOtherSources'));
        el('itrAgriculturalBlock').classList.toggle('cp-hidden', !checked('itrHasAgricultural'));
        el('itrForeignBlock').classList.toggle('cp-hidden', !checked('itrHasForeign'));
        updateIncomeEstimate();
    }

    function syncPreviousFiling() {
        el('itrPreviousFilingBlock').classList.toggle('cp-hidden', value('itrPreviouslyFiled') !== 'Yes');
    }

    function syncTds() {
        el('itrTdsBlock').classList.toggle('cp-hidden', value('itrTdsDeducted') !== 'Yes');
    }

    function syncAdvanceTax() {
        el('itrAdvanceBlock').classList.toggle('cp-hidden', value('itrAdvanceTaxPaid') !== 'Yes');
    }

    function syncRefund() {
        var yes = value('itrRefundExpected') === 'Yes';
        el('itrRefundAmountBlock').classList.toggle('cp-hidden', !yes);
        el('itrRefundBlock').classList.toggle('cp-hidden', !yes);
    }

    function incomeParts() {
        return {
            salary: checked('itrHasSalary') ? (numOrNull(value('itrSalaryIncome')) || 0) : 0,
            business: checked('itrHasBusiness') ? (numOrNull(value('itrBusinessIncome')) || 0) : 0,
            house: checked('itrHasHouseProperty') ? (numOrNull(value('itrHousePropertyIncome')) || 0) : 0,
            capitalGains: checked('itrHasCapitalGains') ? (numOrNull(value('itrCapitalGainsIncome')) || 0) : 0,
            other: checked('itrHasOtherSources') ? (numOrNull(value('itrOtherSourcesIncome')) || 0) : 0,
            agricultural: checked('itrHasAgricultural') ? (numOrNull(value('itrAgriculturalIncome')) || 0) : 0,
            foreign: checked('itrHasForeign') ? (numOrNull(value('itrForeignIncome')) || 0) : 0
        };
    }

    function deductionTotal() {
        return ['itr80c', 'itr80d', 'itr80e', 'itr80g', 'itr80tta', 'itrOtherDeductions']
            .reduce(function (sum, id) { return sum + (numOrNull(value(id)) || 0); }, 0);
    }

    function exemptionTotal() {
        return ['itrHraExemption', 'itrLtaExemption', 'itrOtherExemptions']
            .reduce(function (sum, id) { return sum + (numOrNull(value(id)) || 0); }, 0);
    }

    function grossTotalIncome() {
        var parts = incomeParts();
        var total = parts.salary + parts.business + parts.house + parts.capitalGains +
            parts.other + parts.foreign;
        return Math.max(total, 0);
    }

    function updateIncomeEstimate() {
        var box = el('itrIncomeEstimate');
        if (!box) { return; }
        var parts = incomeParts();
        var gti = grossTotalIncome();
        var text = 'Indicative gross total income (excluding agricultural income): <strong>' +
            money(gti) + '</strong>.';
        if (parts.agricultural > 0) {
            text += ' Agricultural income of <strong>' + money(parts.agricultural) +
                '</strong> is shown separately and is not included in this total.';
        }
        if (parts.house < 0) {
            text += ' A house-property loss has been included as declared.';
        }
        box.innerHTML = text + ' Final computation is prepared after document review.';
    }

    function updateDeductionEstimate() {
        var box = el('itrDeductionEstimate');
        if (!box) { return; }
        box.innerHTML = 'Indicative total deductions: <strong>' + money(deductionTotal()) +
            '</strong>. Statutory caps and eligibility are applied during preparation.';
    }

    function updateComputationEstimate() {
        var box = el('itrComputationEstimate');
        if (!box) { return; }
        var gti = grossTotalIncome();
        var deductions = deductionTotal();
        var exemptions = exemptionTotal();
        var taxable = Math.max(gti - deductions - exemptions, 0);
        box.innerHTML = '<strong>Indicative computation</strong>' +
            '<p>Gross total income <strong>' + money(gti) + '</strong> &middot; deductions <strong>' +
            money(deductions) + '</strong> &middot; exemptions <strong>' + money(exemptions) +
            '</strong> &middot; indicative taxable income <strong>' + money(taxable) +
            '</strong>. This is not a tax computation and does not confirm any refund or liability. ' +
            'Final figures are prepared and approved by our tax team before filing.</p>';
    }

    /* ------------------------------------------------------------------ *
     * Document checklist
     * ------------------------------------------------------------------ */

    function buildChecklist() {
        var identity = ['PAN Card', 'Aadhaar Card'];
        var income = [];
        var deductions = [];
        var history = [];

        if (checked('itrHasSalary')) {
            addIfUnique(income, 'Form 16');
            addIfUnique(income, 'Salary Slips');
            addIfUnique(income, 'Form 26AS');
            addIfUnique(income, 'AIS / TIS');
        }
        if (checked('itrHasBusiness')) {
            addIfUnique(income, 'Financial Statements');
            addIfUnique(income, 'Business Proof');
            addIfUnique(income, 'ITR');
        }
        if (checked('itrHasHouseProperty')) {
            addIfUnique(income, 'Rent Receipts');
            addIfUnique(income, 'Property Documents');
        }
        if (checked('itrHasCapitalGains')) {
            addIfUnique(income, 'Capital Gains Statement');
        }
        if (checked('itrHasOtherSources')) {
            addIfUnique(income, 'Bank Statement');
            addIfUnique(income, 'Income Proof');
        }
        if (checked('itrHasAgricultural')) {
            addIfUnique(income, 'Income Proof');
        }
        if (checked('itrHasForeign')) {
            addIfUnique(income, 'Foreign Income Documents');
            addIfUnique(income, 'Bank Statement');
        }
        if (value('itrTdsDeducted') === 'Yes' || value('itrAdvanceTaxPaid') === 'Yes' ||
            (numOrNull(value('itrSelfAssessmentTax')) || 0) > 0) {
            addIfUnique(income, 'Form 26AS');
            addIfUnique(income, 'Tax Payment Challan');
        }
        if (deductionTotal() > 0 || value('itrTaxSavingInvestments')) {
            addIfUnique(deductions, 'Investment Proofs');
        }
        if (value('itrRefundExpected') === 'Yes') {
            addIfUnique(deductions, 'Bank Statement');
        }
        if (value('itrPreviouslyFiled') === 'Yes') {
            addIfUnique(history, 'Previous ITR');
            addIfUnique(history, 'ITR Acknowledgement');
        }

        var groups = [
            { title: 'Identity', items: identity },
            { title: 'Income & tax', items: income },
            { title: 'Deductions & refund', items: deductions },
            { title: 'Previous filing', items: history }
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
        el('itrDocChecklist').innerHTML = groups.map(function (group) {
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

    function fullAddress(line, city, state, pincode) {
        return [line, city, state, pincode].filter(Boolean).join(', ');
    }

    function renderReview() {
        var payload = buildPayload();
        var personal = payload.personal;
        var profile = payload.tax_profile;
        var income = payload.income;
        var filing = payload.filing;
        var taxes = payload.taxes;
        var deductions = payload.deductions;
        var refund = payload.refund;
        var address = payload.address;
        var parts = incomeParts();

        var blocks = [];

        blocks.push({
            step: 0,
            title: 'Applicant & address',
            rows: [
                reviewRow('Name', fullName()),
                reviewRow('Date of birth', personal.date_of_birth),
                reviewRow('Gender', personal.gender),
                reviewRow('Mobile', personal.mobile),
                reviewRow('Email', personal.email),
                reviewRow('PAN', personal.pan_number),
                reviewRow('Aadhaar', personal.aadhaar_number
                    ? 'XXXX XXXX ' + personal.aadhaar_number.slice(-4)
                    : 'Not provided'),
                reviewRow('E-verification preference', personal.aadhaar_verification_method),
                reviewRow('Residential status', profile.residential_status),
                reviewRow('Current address', fullAddress(address.current.line, address.current.city, address.current.state, address.current.pincode)),
                reviewRow('Permanent address', address.same_as_current
                    ? 'Same as current address'
                    : fullAddress(address.permanent.line, address.permanent.city, address.permanent.state, address.permanent.pincode))
            ]
        });

        blocks.push({
            step: 1,
            title: 'Tax profile',
            rows: [
                reviewRow('Financial year', profile.financial_year),
                reviewRow('Assessment year', profile.assessment_year),
                reviewRow('Taxpayer category', profile.taxpayer_category),
                reviewRow('Return type', profile.return_type),
                reviewRow('ITR form preference', profile.itr_form_preference)
            ]
        });

        var incomeRows = [];
        if (income.has_salary_income) {
            incomeRows.push(reviewRow('Salary / pension', money(income.salary_income) +
                (income.employer_count ? ' (' + income.employer_count + ' employer/s)' : '')));
        }
        if (income.has_business_income) {
            incomeRows.push(reviewRow('Business / profession', money(income.business_income) +
                (income.business_name ? ' - ' + income.business_name : '')));
        }
        if (income.has_house_property) {
            incomeRows.push(reviewRow('House property', money(income.house_property_income)));
        }
        if (income.has_capital_gains) {
            incomeRows.push(reviewRow('Capital gains', money(income.capital_gains_income) +
                (income.capital_gains_type ? ' - ' + income.capital_gains_type : '')));
        }
        if (income.has_other_sources) {
            incomeRows.push(reviewRow('Other sources', money(income.other_sources_income)));
        }
        if (income.has_agricultural_income) {
            incomeRows.push(reviewRow('Agricultural income (exempt)', money(income.agricultural_income)));
        }
        if (income.has_foreign_income) {
            incomeRows.push(reviewRow('Foreign income', money(income.foreign_income)));
        }
        incomeRows.push(reviewRow('Indicative gross total income', money(grossTotalIncome())));
        blocks.push({ step: 2, title: 'Income sources', rows: incomeRows });

        var filingRows = [
            reviewRow('Filed an ITR before', filing.previously_filed_itr ? 'Yes' : 'No'),
            reviewRow('Tax regime preference', filing.tax_regime)
        ];
        if (filing.previously_filed_itr) {
            filingRows.push(reviewRow('Last filed assessment year', filing.last_filed_assessment_year));
            filingRows.push(reviewRow('Last acknowledgement number', filing.last_acknowledgement_no));
            filingRows.push(reviewRow('Pending notices', filing.pending_notices));
            filingRows.push(reviewRow('Filing history notes', filing.filing_history_notes));
        }
        blocks.push({ step: 3, title: 'Filing history & regime', rows: filingRows });

        var taxRows = [
            reviewRow('TDS deducted', taxes.tds_deducted ? money(taxes.tds_amount) : 'No TDS'),
            reviewRow('Advance tax paid', taxes.advance_tax_paid ? money(taxes.advance_tax_amount) : 'No advance tax'),
            reviewRow('Self-assessment tax', taxes.self_assessment_tax_paid !== null
                ? money(taxes.self_assessment_tax_paid) : '\u2014'),
            reviewRow('Section 80C', deductions.deduction_80c !== null ? money(deductions.deduction_80c) : '\u2014'),
            reviewRow('Section 80D', deductions.deduction_80d !== null ? money(deductions.deduction_80d) : '\u2014'),
            reviewRow('Section 80E', deductions.deduction_80e !== null ? money(deductions.deduction_80e) : '\u2014'),
            reviewRow('Section 80G', deductions.deduction_80g !== null ? money(deductions.deduction_80g) : '\u2014'),
            reviewRow('Section 80TTA / 80TTB', deductions.deduction_80tta_ttb !== null ? money(deductions.deduction_80tta_ttb) : '\u2014'),
            reviewRow('Other deductions', deductions.other_deductions !== null ? money(deductions.other_deductions) : '\u2014'),
            reviewRow('Indicative total deductions', money(deductionTotal()))
        ];
        blocks.push({ step: 4, title: 'Taxes paid & deductions', rows: taxRows });

        var refundRows = [
            reviewRow('HRA exemption', deductions.hra_exemption !== null ? money(deductions.hra_exemption) : '\u2014'),
            reviewRow('LTA exemption', deductions.lta_exemption !== null ? money(deductions.lta_exemption) : '\u2014'),
            reviewRow('Other exemptions', deductions.other_exemptions !== null ? money(deductions.other_exemptions) : '\u2014'),
            reviewRow('Tax-saving investments', deductions.tax_saving_investments),
            reviewRow('Refund expected', refund.refund_expected ? 'Yes' : 'No / not sure'),
            reviewRow('Expected refund amount', refund.refund_amount !== null ? money(refund.refund_amount) : '\u2014'),
            reviewRow('Refund bank account', refund.bank_account_number
                ? (refund.bank_account_name || '') + ' - ' + maskAccount(refund.bank_account_number)
                : '\u2014'),
            reviewRow('IFSC code', refund.ifsc_code),
            reviewRow('Indicative taxable income', money(Math.max(grossTotalIncome() - deductionTotal() - exemptionTotal(), 0)))
        ];
        blocks.push({ step: 5, title: 'Exemptions, refund & investments', rows: refundRows });

        var checklist = buildChecklist();
        var documentRows = checklist.map(function (group) {
            return reviewRow(group.title, group.items.join(', '));
        });
        blocks.push({ step: 6, title: 'Document checklist', rows: documentRows });

        el('itrReviewSummary').innerHTML = blocks.map(function (block) {
            return '<div class="cp-review-block">' +
                '<h4><span>' + D.escapeHtml(block.title) + '</span>' +
                '<button type="button" data-goto="' + block.step + '">Edit</button></h4>' +
                block.rows.join('') +
                '</div>';
        }).join('');
    }

    el('itrReviewSummary').addEventListener('click', function (event) {
        var button = event.target.closest('[data-goto]');
        if (!button) { return; }
        showStep(Number(button.getAttribute('data-goto')), true);
    });

    /* ------------------------------------------------------------------ *
     * Payload
     * ------------------------------------------------------------------ */

    function buildPayload() {
        var same = checked('itrSameAsCurrent');
        var salary = checked('itrHasSalary');
        var business = checked('itrHasBusiness');
        var house = checked('itrHasHouseProperty');
        var gains = checked('itrHasCapitalGains');
        var other = checked('itrHasOtherSources');
        var agricultural = checked('itrHasAgricultural');
        var foreign = checked('itrHasForeign');
        var refund = value('itrRefundExpected') === 'Yes';

        return {
            personal: {
                first_name: value('itrFirstName'),
                middle_name: value('itrMiddleName'),
                last_name: value('itrLastName'),
                date_of_birth: value('itrDob'),
                gender: value('itrGender'),
                mobile: value('itrMobile'),
                email: value('itrEmail'),
                pan_number: value('itrPan').toUpperCase(),
                aadhaar_number: D.digits(value('itrAadhaar')),
                aadhaar_verification_method: value('itrAadhaarMethod')
            },
            tax_profile: {
                residential_status: value('itrResidentialStatus'),
                assessment_year: value('itrAssessmentYear'),
                financial_year: value('itrFinancialYear'),
                taxpayer_category: value('itrTaxpayerCategory'),
                return_type: value('itrReturnType'),
                itr_form_preference: value('itrItrForm')
            },
            income: {
                has_salary_income: salary,
                salary_income: salary ? numOrNull(value('itrSalaryIncome')) : null,
                employer_count: salary ? numOrNull(value('itrEmployerCount')) : null,
                has_business_income: business,
                business_income: business ? numOrNull(value('itrBusinessIncome')) : null,
                business_name: business ? value('itrBusinessName') : '',
                business_constitution: business ? value('itrBusinessConstitution') : '',
                has_house_property: house,
                house_property_income: house ? numOrNull(value('itrHousePropertyIncome')) : null,
                house_property_details: house ? value('itrHousePropertyDetails') : '',
                has_capital_gains: gains,
                capital_gains_income: gains ? numOrNull(value('itrCapitalGainsIncome')) : null,
                capital_gains_type: gains ? value('itrCapitalGainsType') : '',
                has_other_sources: other,
                other_sources_income: other ? numOrNull(value('itrOtherSourcesIncome')) : null,
                has_agricultural_income: agricultural,
                agricultural_income: agricultural ? numOrNull(value('itrAgriculturalIncome')) : null,
                has_foreign_income: foreign,
                foreign_income: foreign ? numOrNull(value('itrForeignIncome')) : null,
                foreign_assets_details: foreign ? value('itrForeignDetails') : ''
            },
            filing: {
                previously_filed_itr: yesNoOrNull('itrPreviouslyFiled'),
                last_filed_assessment_year: value('itrPreviouslyFiled') === 'Yes' ? value('itrLastFiledAy') : '',
                last_acknowledgement_no: value('itrPreviouslyFiled') === 'Yes' ? value('itrLastAck') : '',
                pending_notices: value('itrPreviouslyFiled') === 'Yes' ? value('itrPendingNotices') : '',
                filing_history_notes: value('itrPreviouslyFiled') === 'Yes' ? value('itrFilingHistoryNotes') : '',
                tax_regime: value('itrTaxRegime')
            },
            taxes: {
                tds_deducted: yesNoOrNull('itrTdsDeducted'),
                tds_amount: value('itrTdsDeducted') === 'Yes' ? numOrNull(value('itrTdsAmount')) : null,
                advance_tax_paid: yesNoOrNull('itrAdvanceTaxPaid'),
                advance_tax_amount: value('itrAdvanceTaxPaid') === 'Yes' ? numOrNull(value('itrAdvanceTaxAmount')) : null,
                self_assessment_tax_paid: numOrNull(value('itrSelfAssessmentTax'))
            },
            deductions: {
                deduction_80c: numOrNull(value('itr80c')),
                deduction_80d: numOrNull(value('itr80d')),
                deduction_80e: numOrNull(value('itr80e')),
                deduction_80g: numOrNull(value('itr80g')),
                deduction_80tta_ttb: numOrNull(value('itr80tta')),
                other_deductions: numOrNull(value('itrOtherDeductions')),
                hra_exemption: numOrNull(value('itrHraExemption')),
                lta_exemption: numOrNull(value('itrLtaExemption')),
                other_exemptions: numOrNull(value('itrOtherExemptions')),
                tax_saving_investments: value('itrTaxSavingInvestments')
            },
            refund: {
                refund_expected: yesNoOrNull('itrRefundExpected'),
                refund_amount: refund ? numOrNull(value('itrRefundAmount')) : null,
                bank_account_name: refund ? value('itrBankAccountName') : '',
                bank_account_number: refund ? D.digits(value('itrBankAccountNumber')) : '',
                ifsc_code: refund ? value('itrIfsc').toUpperCase() : ''
            },
            address: {
                same_as_current: same,
                current: {
                    line: value('itrCurrentAddressLine'),
                    city: value('itrCurrentCity'),
                    state: value('itrCurrentState'),
                    pincode: value('itrCurrentPincode')
                },
                permanent: {
                    line: same ? value('itrCurrentAddressLine') : value('itrPermanentAddressLine'),
                    city: same ? value('itrCurrentCity') : value('itrPermanentCity'),
                    state: same ? value('itrCurrentState') : value('itrPermanentState'),
                    pincode: same ? value('itrCurrentPincode') : value('itrPermanentPincode')
                }
            },
            consent: checked('itrApplicationConsent') && checked('itrAccuracyDeclaration'),
            consent_version: D.CONSENT_VERSION || '2026-11',
            source_page: 'itr-apply.html'
        };
    }

    /* ------------------------------------------------------------------ *
     * Validation
     * ------------------------------------------------------------------ */

    function requireField(id, message) {
        var field = el(id);
        if (!field || !field.value.trim()) {
            D.setFieldError(field, message);
            return false;
        }
        return true;
    }

    function validateAddress(prefix, label) {
        var ok = true;
        if (!requireField(prefix + 'AddressLine', 'Enter your ' + label + ' address.')) { ok = false; }
        if (!requireField(prefix + 'City', 'Enter your ' + label + ' city.')) { ok = false; }
        if (!requireField(prefix + 'State', 'Select your ' + label + ' state.')) { ok = false; }
        if (!requireField(prefix + 'Pincode', 'Enter your ' + label + ' PIN code.')) { ok = false; }
        var pin = el(prefix + 'Pincode');
        if (pin && pin.value.trim() && !/^[0-9]{6}$/.test(pin.value.trim())) {
            D.setFieldError(pin, 'Enter a valid 6-digit PIN code.');
            ok = false;
        }
        return ok;
    }

    function validateStep(index) {
        var ok = true;

        if (index === 0) {
            if (!requireField('itrFirstName', 'Enter your first name.')) { ok = false; }
            if (!requireField('itrLastName', 'Enter your last name.')) { ok = false; }

            var dob = el('itrDob');
            if (!dob.value) {
                D.setFieldError(dob, 'Enter your date of birth.');
                ok = false;
            } else {
                var age = ageFrom(dob.value);
                if (age === null || age < 18) {
                    D.setFieldError(dob, 'The applicant must be at least 18 years old.');
                    ok = false;
                } else if (age > 100) {
                    D.setFieldError(dob, 'Please enter a valid date of birth.');
                    ok = false;
                }
            }

            var mobile = el('itrMobile');
            if (!mobile.value.trim()) {
                D.setFieldError(mobile, 'Enter your mobile number.');
                ok = false;
            } else if (!D.isIndianMobile(mobile.value)) {
                D.setFieldError(mobile, 'Enter a valid 10-digit Indian mobile number.');
                ok = false;
            }

            var email = el('itrEmail');
            if (!D.isEmail(email.value)) {
                D.setFieldError(email, 'Enter a valid email address.');
                ok = false;
            }

            var pan = el('itrPan');
            if (!PAN_RE.test(pan.value.trim().toUpperCase())) {
                D.setFieldError(pan, 'Enter a valid PAN (e.g. ABCDE1234F).');
                ok = false;
            }

            var aadhaar = el('itrAadhaar');
            var aadhaarDigits = D.digits(aadhaar.value);
            if (aadhaarDigits && aadhaarDigits.length !== 12) {
                D.setFieldError(aadhaar, 'Enter a valid 12-digit Aadhaar number.');
                ok = false;
            }
            var method = el('itrAadhaarMethod');
            if (aadhaarDigits && !method.value) {
                D.setFieldError(method, 'Select how you would like to complete e-verification.');
                ok = false;
            }

            if (!requireField('itrResidentialStatus', 'Select your residential status.')) { ok = false; }

            if (!validateAddress('itrCurrent', 'current')) { ok = false; }
            if (!checked('itrSameAsCurrent')) {
                if (!validateAddress('itrPermanent', 'permanent')) { ok = false; }
            }
        }

        if (index === 1) {
            var fy = el('itrFinancialYear');
            var ay = el('itrAssessmentYear');
            if (!fy.value) {
                D.setFieldError(fy, 'Select the financial year.');
                ok = false;
            }
            if (!ay.value) {
                D.setFieldError(ay, 'Select the assessment year.');
                ok = false;
            }
            if (fy.value && ay.value && AY_BY_FY[fy.value] !== ay.value) {
                D.setFieldError(ay, 'The assessment year must immediately follow the financial year.');
                ok = false;
            }
            if (!requireField('itrTaxpayerCategory', 'Select your taxpayer category.')) { ok = false; }
            if (!requireField('itrReturnType', 'Select the return type.')) { ok = false; }
        }

        if (index === 2) {
            var hasAnyIncome = checked('itrHasSalary') || checked('itrHasBusiness') ||
                checked('itrHasHouseProperty') || checked('itrHasCapitalGains') ||
                checked('itrHasOtherSources') || checked('itrHasAgricultural') ||
                checked('itrHasForeign');
            if (!hasAnyIncome) {
                D.showAlert(alertBox, 'warning',
                    'Select at least one income source so we can prepare the correct checklist.',
                    'Income source required');
                ok = false;
            }

            if (checked('itrHasSalary')) {
                var salary = el('itrSalaryIncome');
                if (salary.value === '' || Number(salary.value) < 0) {
                    D.setFieldError(salary, 'Enter your gross salary income.');
                    ok = false;
                }
                var employers = el('itrEmployerCount');
                if (employers.value && (Number(employers.value) < 0 || Number(employers.value) > 20)) {
                    D.setFieldError(employers, 'Enter a number between 0 and 20.');
                    ok = false;
                }
            }

            if (checked('itrHasBusiness')) {
                if (!requireField('itrBusinessName', 'Enter the business or profession name.')) { ok = false; }
                var business = el('itrBusinessIncome');
                if (business.value === '' || Number(business.value) < 0) {
                    D.setFieldError(business, 'Enter your net business or professional income.');
                    ok = false;
                }
            }

            if (checked('itrHasHouseProperty')) {
                var house = el('itrHousePropertyIncome');
                if (house.value === '' || isNaN(Number(house.value))) {
                    D.setFieldError(house, 'Enter the house property income or loss.');
                    ok = false;
                }
            }

            if (checked('itrHasCapitalGains')) {
                var gains = el('itrCapitalGainsIncome');
                if (gains.value === '' || Number(gains.value) < 0) {
                    D.setFieldError(gains, 'Enter your net capital gains.');
                    ok = false;
                }
                if (!requireField('itrCapitalGainsType', 'Select the capital gains type.')) { ok = false; }
            }

            if (checked('itrHasOtherSources')) {
                var other = el('itrOtherSourcesIncome');
                if (other.value === '' || Number(other.value) < 0) {
                    D.setFieldError(other, 'Enter your other-source income.');
                    ok = false;
                }
            }

            if (checked('itrHasAgricultural')) {
                var agricultural = el('itrAgriculturalIncome');
                if (agricultural.value === '' || Number(agricultural.value) < 0) {
                    D.setFieldError(agricultural, 'Enter your agricultural income.');
                    ok = false;
                }
            }

            if (checked('itrHasForeign')) {
                var foreign = el('itrForeignIncome');
                if (foreign.value === '' || Number(foreign.value) < 0) {
                    D.setFieldError(foreign, 'Enter your foreign income in INR.');
                    ok = false;
                }
            }
        }

        if (index === 3) {
            if (!requireField('itrPreviouslyFiled', 'Tell us whether you have filed an ITR before.')) { ok = false; }
            if (!requireField('itrTaxRegime', 'Select your tax regime preference.')) { ok = false; }
        }

        if (index === 4) {
            var tds = el('itrTdsDeducted');
            if (!tds.value) {
                D.setFieldError(tds, 'Tell us whether TDS was deducted.');
                ok = false;
            }
            if (tds.value === 'Yes') {
                var tdsAmount = el('itrTdsAmount');
                if (tdsAmount.value === '' || Number(tdsAmount.value) < 0) {
                    D.setFieldError(tdsAmount, 'Enter the total TDS amount.');
                    ok = false;
                }
            }
            var advance = el('itrAdvanceTaxPaid');
            if (!advance.value) {
                D.setFieldError(advance, 'Tell us whether advance tax was paid.');
                ok = false;
            }
            if (advance.value === 'Yes') {
                var advanceAmount = el('itrAdvanceTaxAmount');
                if (advanceAmount.value === '' || Number(advanceAmount.value) < 0) {
                    D.setFieldError(advanceAmount, 'Enter the total advance tax paid.');
                    ok = false;
                }
            }
            var selfTax = el('itrSelfAssessmentTax');
            if (selfTax.value && Number(selfTax.value) < 0) {
                D.setFieldError(selfTax, 'Enter a valid self-assessment tax amount.');
                ok = false;
            }
            ['itr80c', 'itr80d', 'itr80e', 'itr80g', 'itr80tta', 'itrOtherDeductions'].forEach(function (id) {
                var field = el(id);
                if (field.value && Number(field.value) < 0) {
                    D.setFieldError(field, 'Enter a valid deduction amount.');
                    ok = false;
                }
            });
        }

        if (index === 5) {
            ['itrHraExemption', 'itrLtaExemption', 'itrOtherExemptions'].forEach(function (id) {
                var field = el(id);
                if (field.value && Number(field.value) < 0) {
                    D.setFieldError(field, 'Enter a valid exemption amount.');
                    ok = false;
                }
            });
            var refund = el('itrRefundExpected');
            if (!refund.value) {
                D.setFieldError(refund, 'Tell us whether you expect a refund.');
                ok = false;
            }
            if (refund.value === 'Yes') {
                if (!requireField('itrBankAccountName', 'Enter the bank account holder name.')) { ok = false; }
                var account = el('itrBankAccountNumber');
                var accountDigits = D.digits(account.value);
                if (!accountDigits || accountDigits.length < 9 || accountDigits.length > 18) {
                    D.setFieldError(account, 'Enter a valid 9-18 digit bank account number.');
                    ok = false;
                }
                var ifsc = el('itrIfsc');
                if (!IFSC_RE.test(ifsc.value.trim().toUpperCase())) {
                    D.setFieldError(ifsc, 'Enter a valid IFSC code (e.g. HDFC0001234).');
                    ok = false;
                }
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
        steps.forEach(function (step, stepIndex) {
            step.classList.toggle('is-active', stepIndex === current);
        });
        maxStep = Math.max(maxStep, current);
        renderStepper();

        prevBtn.classList.toggle('cp-hidden', current === 0);
        nextBtn.classList.toggle('cp-hidden', current === TOTAL_STEPS - 1);
        submitBtn.classList.toggle('cp-hidden', current !== TOTAL_STEPS - 1);
        progressText.textContent = 'Step ' + (current + 1) + ' of ' + TOTAL_STEPS;

        if (current === 6) {
            renderChecklist();
        }
        if (current === TOTAL_STEPS - 1) {
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

    // Drafts are stored server-side and can be resumed with a secret token, but
    // they do not need the full Aadhaar or bank account number. Redact both so
    // the long-lived draft row never holds those identifiers; the applicant
    // re-enters them on resume before submission.
    function draftSafePayload() {
        var payload = buildPayload();
        if (payload.personal) { payload.personal.aadhaar_number = ''; }
        if (payload.refund) { payload.refund.bank_account_number = ''; }
        return payload;
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
        D.setLoading(saveDraftBtn, true, 'Saving…');
        try {
            await saveDraft();
            if (draftBar) {
                draftBar.classList.remove('cp-hidden');
                draftBarText.innerHTML = 'Draft saved. Resume any time with this link: <code>' +
                    D.escapeHtml(resumeLink()) + '</code>. For your security, Aadhaar and bank account numbers are not stored in drafts; re-enter them when you resume.';
            }
            D.showAlert(alertBox, 'success',
                'Your ITR application has been saved. Bookmark this page or keep the resume link to continue later. Aadhaar and bank account numbers are not stored in drafts and must be re-entered when you resume.',
                'Draft saved');
        } catch (err) {
            console.error('ITR draft save failed:', err);
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
                D.escapeHtml(resumeLink()) + '</code>. Aadhaar and bank account numbers are not stored in drafts; please re-enter them if applicable.';
        }
    }

    function applyPayload(payload) {
        var personal = payload.personal || {};
        var profile = payload.tax_profile || {};
        var income = payload.income || {};
        var filing = payload.filing || {};
        var taxes = payload.taxes || {};
        var deductions = payload.deductions || {};
        var refund = payload.refund || {};
        var address = payload.address || {};
        var currentAddress = address.current || {};
        var permanentAddress = address.permanent || {};

        el('itrFirstName').value = personal.first_name || '';
        el('itrMiddleName').value = personal.middle_name || '';
        el('itrLastName').value = personal.last_name || '';
        el('itrDob').value = personal.date_of_birth || '';
        el('itrGender').value = personal.gender || '';
        el('itrMobile').value = personal.mobile || '';
        el('itrEmail').value = personal.email || '';
        el('itrPan').value = personal.pan_number || '';
        el('itrAadhaar').value = personal.aadhaar_number || '';
        el('itrAadhaarMethod').value = personal.aadhaar_verification_method || '';
        el('itrResidentialStatus').value = profile.residential_status || '';

        el('itrFinancialYear').value = profile.financial_year || '';
        el('itrAssessmentYear').value = profile.assessment_year || '';
        el('itrTaxpayerCategory').value = profile.taxpayer_category || '';
        el('itrReturnType').value = profile.return_type || '';
        el('itrItrForm').value = profile.itr_form_preference || '';

        el('itrHasSalary').checked = !!income.has_salary_income;
        el('itrSalaryIncome').value = income.salary_income !== null && income.salary_income !== undefined ? income.salary_income : '';
        el('itrEmployerCount').value = income.employer_count !== null && income.employer_count !== undefined ? income.employer_count : '';
        el('itrHasBusiness').checked = !!income.has_business_income;
        el('itrBusinessIncome').value = income.business_income !== null && income.business_income !== undefined ? income.business_income : '';
        el('itrBusinessName').value = income.business_name || '';
        el('itrBusinessConstitution').value = income.business_constitution || '';
        el('itrHasHouseProperty').checked = !!income.has_house_property;
        el('itrHousePropertyIncome').value = income.house_property_income !== null && income.house_property_income !== undefined ? income.house_property_income : '';
        el('itrHousePropertyDetails').value = income.house_property_details || '';
        el('itrHasCapitalGains').checked = !!income.has_capital_gains;
        el('itrCapitalGainsIncome').value = income.capital_gains_income !== null && income.capital_gains_income !== undefined ? income.capital_gains_income : '';
        el('itrCapitalGainsType').value = income.capital_gains_type || '';
        el('itrHasOtherSources').checked = !!income.has_other_sources;
        el('itrOtherSourcesIncome').value = income.other_sources_income !== null && income.other_sources_income !== undefined ? income.other_sources_income : '';
        el('itrHasAgricultural').checked = !!income.has_agricultural_income;
        el('itrAgriculturalIncome').value = income.agricultural_income !== null && income.agricultural_income !== undefined ? income.agricultural_income : '';
        el('itrHasForeign').checked = !!income.has_foreign_income;
        el('itrForeignIncome').value = income.foreign_income !== null && income.foreign_income !== undefined ? income.foreign_income : '';
        el('itrForeignDetails').value = income.foreign_assets_details || '';

        el('itrPreviouslyFiled').value = filing.previously_filed_itr ? 'Yes' : (filing.previously_filed_itr === false ? 'No' : '');
        el('itrLastFiledAy').value = filing.last_filed_assessment_year || '';
        el('itrLastAck').value = filing.last_acknowledgement_no || '';
        el('itrPendingNotices').value = filing.pending_notices || '';
        el('itrFilingHistoryNotes').value = filing.filing_history_notes || '';
        el('itrTaxRegime').value = filing.tax_regime || '';

        el('itrTdsDeducted').value = taxes.tds_deducted ? 'Yes' : (taxes.tds_deducted === false ? 'No' : '');
        el('itrTdsAmount').value = taxes.tds_amount !== null && taxes.tds_amount !== undefined ? taxes.tds_amount : '';
        el('itrAdvanceTaxPaid').value = taxes.advance_tax_paid ? 'Yes' : (taxes.advance_tax_paid === false ? 'No' : '');
        el('itrAdvanceTaxAmount').value = taxes.advance_tax_amount !== null && taxes.advance_tax_amount !== undefined ? taxes.advance_tax_amount : '';
        el('itrSelfAssessmentTax').value = taxes.self_assessment_tax_paid !== null && taxes.self_assessment_tax_paid !== undefined ? taxes.self_assessment_tax_paid : '';

        el('itr80c').value = deductions.deduction_80c !== null && deductions.deduction_80c !== undefined ? deductions.deduction_80c : '';
        el('itr80d').value = deductions.deduction_80d !== null && deductions.deduction_80d !== undefined ? deductions.deduction_80d : '';
        el('itr80e').value = deductions.deduction_80e !== null && deductions.deduction_80e !== undefined ? deductions.deduction_80e : '';
        el('itr80g').value = deductions.deduction_80g !== null && deductions.deduction_80g !== undefined ? deductions.deduction_80g : '';
        el('itr80tta').value = deductions.deduction_80tta_ttb !== null && deductions.deduction_80tta_ttb !== undefined ? deductions.deduction_80tta_ttb : '';
        el('itrOtherDeductions').value = deductions.other_deductions !== null && deductions.other_deductions !== undefined ? deductions.other_deductions : '';
        el('itrHraExemption').value = deductions.hra_exemption !== null && deductions.hra_exemption !== undefined ? deductions.hra_exemption : '';
        el('itrLtaExemption').value = deductions.lta_exemption !== null && deductions.lta_exemption !== undefined ? deductions.lta_exemption : '';
        el('itrOtherExemptions').value = deductions.other_exemptions !== null && deductions.other_exemptions !== undefined ? deductions.other_exemptions : '';
        el('itrTaxSavingInvestments').value = deductions.tax_saving_investments || '';

        el('itrRefundExpected').value = refund.refund_expected ? 'Yes' : (refund.refund_expected === false ? 'No' : '');
        el('itrRefundAmount').value = refund.refund_amount !== null && refund.refund_amount !== undefined ? refund.refund_amount : '';
        el('itrBankAccountName').value = refund.bank_account_name || '';
        el('itrBankAccountNumber').value = refund.bank_account_number || '';
        el('itrIfsc').value = refund.ifsc_code || '';

        el('itrCurrentAddressLine').value = currentAddress.line || '';
        el('itrCurrentCity').value = currentAddress.city || '';
        el('itrCurrentState').value = currentAddress.state || '';
        el('itrCurrentPincode').value = currentAddress.pincode || '';

        el('itrSameAsCurrent').checked = address.same_as_current !== false;
        el('itrPermanentAddressLine').value = permanentAddress.line || '';
        el('itrPermanentCity').value = permanentAddress.city || '';
        el('itrPermanentState').value = permanentAddress.state || '';
        el('itrPermanentPincode').value = permanentAddress.pincode || '';

        syncPermanentAddress();
        syncIncomeBlocks();
        syncPreviousFiling();
        syncTds();
        syncAdvanceTax();
        syncRefund();
        updateDeductionEstimate();
        updateComputationEstimate();
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
        syncPermanentAddress();
        syncIncomeBlocks();
        syncPreviousFiling();
        syncTds();
        syncAdvanceTax();
        syncRefund();
        updateDeductionEstimate();
        updateComputationEstimate();
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
                D.notify('success', 'Draft restored', 'Your saved ITR application has been loaded.');
                return;
            } catch (err) {
                console.warn('Failed to resume ITR draft from link:', err);
                D.showAlert(alertBox, 'warning',
                    'The resume link could not be loaded. ' + D.friendlyError(err),
                    'Draft unavailable');
            }
        }
        if (readStoredDraft() && draftBar) {
            draftBar.classList.remove('cp-hidden');
            draftBarText.textContent = 'We found a saved draft of your ITR application on this device.';
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
            console.warn('Background ITR draft save failed:', err);
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

        for (var i = 0; i < TOTAL_STEPS - 1; i++) {
            if (!validateStep(i)) {
                showStep(i, true);
                focusFirstError();
                return;
            }
        }

        if (!checked('itrAccuracyDeclaration')) {
            D.showAlert(alertBox, 'warning',
                'Please confirm that the information provided is true and complete.',
                'Declaration required');
            el('itrAccuracyDeclaration').focus();
            return;
        }
        if (!checked('itrApplicationConsent')) {
            D.showAlert(alertBox, 'warning',
                'Please accept the privacy notice and filing consent before submitting.',
                'Consent required');
            el('itrApplicationConsent').focus();
            return;
        }

        var payload = buildPayload();
        D.setLoading(submitBtn, true, 'Submitting application…');
        try {
            var result = await D.rpc('submit_itr_application', {
                p_payload: payload,
                p_draft_id: draftId,
                p_draft_token: draftToken
            });
            clearStoredDraft();
            showSuccess(result);
        } catch (err) {
            console.error('ITR submission failed:', err);
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
            'Your ITR assistance request has been received. Reference: ' +
            (result.reference_no || '\u2014') + '. This is not a filed return.',
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
        if (['itrSalaryIncome', 'itrBusinessIncome', 'itrHousePropertyIncome',
             'itrCapitalGainsIncome', 'itrOtherSourcesIncome', 'itrAgriculturalIncome',
             'itrForeignIncome'].indexOf(event.target.id) !== -1) {
            updateIncomeEstimate();
            updateComputationEstimate();
        }
        if (['itr80c', 'itr80d', 'itr80e', 'itr80g', 'itr80tta', 'itrOtherDeductions',
             'itrHraExemption', 'itrLtaExemption', 'itrOtherExemptions'].indexOf(event.target.id) !== -1) {
            updateDeductionEstimate();
            updateComputationEstimate();
        }
    });

    form.addEventListener('change', function (event) {
        if (event.target.classList.contains('form-control')) {
            D.clearFieldError(event.target);
        }
        if (event.target.id === 'itrSameAsCurrent') { syncPermanentAddress(); }
        if (event.target.id === 'itrFinancialYear') { syncFinancialYear(); }
        if (event.target.id === 'itrAssessmentYear') { syncAssessmentYear(); }
        if (['itrHasSalary', 'itrHasBusiness', 'itrHasHouseProperty', 'itrHasCapitalGains',
             'itrHasOtherSources', 'itrHasAgricultural', 'itrHasForeign'].indexOf(event.target.id) !== -1) {
            syncIncomeBlocks();
        }
        if (event.target.id === 'itrPreviouslyFiled') { syncPreviousFiling(); }
        if (event.target.id === 'itrTdsDeducted') { syncTds(); }
        if (event.target.id === 'itrAdvanceTaxPaid') { syncAdvanceTax(); }
        if (event.target.id === 'itrRefundExpected') { syncRefund(); }
        if (['itrCurrentAddressLine', 'itrCurrentCity', 'itrCurrentState', 'itrCurrentPincode'].indexOf(event.target.id) !== -1
            && checked('itrSameAsCurrent')) {
            syncPermanentAddress();
        }
    });

    /* ------------------------------------------------------------------ *
     * Boot
     * ------------------------------------------------------------------ */

    function boot() {
        initOptions();
        syncPermanentAddress();
        syncFinancialYear();
        syncIncomeBlocks();
        syncPreviousFiling();
        syncTds();
        syncAdvanceTax();
        syncRefund();
        updateDeductionEstimate();
        updateComputationEstimate();
        showStep(0, false);
        initDraft();
    }

    boot();
})(window, document);

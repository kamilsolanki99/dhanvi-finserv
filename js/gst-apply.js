/**
 * Dhanvi Finserv - multi-step GST Registration & Filing assistance wizard.
 *
 * Depends on: js/nhost-client.js, js/public-api.js
 *
 * Flow
 *   1    applicant / authorised signatory, PAN, Aadhaar reference, address
 *   2    business name, constitution, activity, commencement, turnover, GSTIN
 *   3    service type and conditional registration / return / amendment /
 *        cancellation / compliance fields
 *   4    sales, purchases, input tax credit and tax position
 *   5    authorised signatory and business bank details
 *   6    conditional document checklist
 *   7    review and mandatory declarations / consent
 *
 * Save / resume
 *   A server-side draft is created through save_home_loan_draft() (shared with
 *   the other application wizards) as soon as the first step validates, and
 *   refreshed on every step change. The draft id + secret token are kept in
 *   localStorage so the applicant can resume in the same browser, and
 *   "Save & continue later" also shows a resume link. Submitting promotes the
 *   draft into a real GST assistance request through submit_gst_application().
 *
 * IMPORTANT
 *   Submitting this wizard does NOT register a business or file a GST return.
 *   The filing status is controlled by the administrator and can only be set to
 *   "Filed & Verified" after actual portal submission and ARN verification.
 */
(function (window, document) {
    'use strict';

    var D = window.Dhanvi;
    var form = document.getElementById('gstApplicationForm');
    if (!form || !D) { return; }

    var DRAFT_KEY = 'dhanviGstDraft';
    var TOTAL_STEPS = 7;

    var alertBox = document.getElementById('applicationAlert');
    var draftBar = document.getElementById('draftBar');
    var draftBarText = document.getElementById('draftBarText');
    var successBox = document.getElementById('applicationSuccess');
    var stepper = document.getElementById('gstStepper');
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
    var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    var PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
    var GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
    var IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
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

    function maskAccount(account) {
        var digits = D.digits(account);
        if (!digits) { return ''; }
        if (digits.length <= 4) { return digits; }
        return new Array(digits.length - 3).join('X') + digits.slice(-4);
    }

    function addIfUnique(list, item) {
        if (list.indexOf(item) === -1) { list.push(item); }
    }

    function pad2(number) {
        return String(number).length < 2 ? '0' + number : String(number);
    }

    function monthValue(date) {
        return date.getFullYear() + '-' + pad2(date.getMonth() + 1);
    }

    function monthLabel(period) {
        var parts = String(period || '').split('-');
        var year = Number(parts[0]);
        var month = Number(parts[1]);
        if (!year || !month || month < 1 || month > 12) { return period; }
        return MONTHS[month - 1] + ' ' + year;
    }

    function fyForPeriod(period) {
        var parts = String(period || '').split('-');
        var year = Number(parts[0]);
        var month = Number(parts[1]);
        if (!year || !month) { return ''; }
        var startYear = month >= 4 ? year : year - 1;
        return startYear + '-' + pad2((startYear + 1) % 100);
    }

    function currentFinancialYear() {
        var today = new Date();
        var startYear = today.getMonth() + 1 >= 4 ? today.getFullYear() : today.getFullYear() - 1;
        return startYear + '-' + pad2((startYear + 1) % 100);
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

    /* ------------------------------------------------------------------ *
     * Static options
     * ------------------------------------------------------------------ */

    function initOptions() {
        var stateSelect = el('gstAddressState');
        if (stateSelect) {
            stateSelect.innerHTML = '<option value="">Select state</option>' + STATES.map(function (state) {
                return '<option value="' + D.escapeHtml(state) + '">' + D.escapeHtml(state) + '</option>';
            }).join('');
        }

        var periodSelect = el('gstReturnPeriod');
        if (periodSelect) {
            var today = new Date();
            var start = new Date(today.getFullYear(), today.getMonth(), 1);
            var options = ['<option value="">Select return period</option>'];
            for (var i = 0; i < 18; i += 1) {
                var date = new Date(start.getFullYear(), start.getMonth() - i, 1);
                var period = monthValue(date);
                options.push('<option value="' + period + '">' + D.escapeHtml(monthLabel(period)) + '</option>');
            }
            periodSelect.innerHTML = options.join('');
        }

        var fySelect = el('gstFinancialYear');
        if (fySelect) {
            var fyToday = new Date();
            var fyStart = fyToday.getMonth() + 1 >= 4 ? fyToday.getFullYear() : fyToday.getFullYear() - 1;
            var fyOptions = ['<option value="">Select financial year</option>'];
            for (var j = 0; j < 6; j += 1) {
                var year = fyStart - j;
                var fy = year + '-' + pad2((year + 1) % 100);
                fyOptions.push('<option value="' + fy + '">' + fy + '</option>');
            }
            fySelect.innerHTML = fyOptions.join('');
        }
    }

    /* ------------------------------------------------------------------ *
     * Conditional behaviour
     * ------------------------------------------------------------------ */

    function syncGstin() {
        var registered = value('gstAlreadyRegistered');
        var block = el('gstinBlock');
        if (block) { block.classList.toggle('cp-hidden', registered !== 'Yes'); }
        if (registered !== 'Yes' && el('gstin')) {
            el('gstin').value = '';
        }
        updateGstinNote();
    }

    function updateGstinNote() {
        var note = el('gstGstinNote');
        if (!note) { return; }
        var service = value('gstServiceType');
        var show = service !== '' && service !== 'New GST Registration';
        note.classList.toggle('cp-hidden', !show);
        if (!show) { return; }
        var gstin = value('gstin').toUpperCase();
        var text = el('gstGstinNoteText');
        if (text) {
            text.textContent = gstin
                ? 'GSTIN on record: ' + gstin + '. We will verify the registration before preparing the filing.'
                : 'No GSTIN has been added. Go back to the business profile and enter your existing GSTIN.';
        }
    }

    function syncServiceBlocks() {
        var service = value('gstServiceType');
        el('gstReturnBlock').classList.toggle('cp-hidden', service !== 'GST Return Filing');
        el('gstAmendmentBlock').classList.toggle('cp-hidden', service !== 'GST Amendment');
        el('gstCancellationBlock').classList.toggle('cp-hidden', service !== 'GST Cancellation');
        el('gstComplianceBlock').classList.toggle('cp-hidden', service !== 'GST Compliance Assistance');
        updateGstinNote();
    }

    function syncFinancialYear() {
        var period = value('gstReturnPeriod');
        if (!period) { return; }
        setSelectValue('gstFinancialYear', fyForPeriod(period));
    }

    function updateNetTaxEstimate() {
        var box = el('gstNetTaxEstimate');
        if (!box) { return; }
        var liability = numOrNull(value('gstTaxLiability')) || 0;
        var paid = numOrNull(value('gstTaxPaid')) || 0;
        var late = numOrNull(value('gstLateFee')) || 0;
        var net = liability + late - paid;
        var message;
        if (net > 0) {
            message = 'Indicative net tax payable: ' + money(net) + '. This is not a GST computation and does not confirm any liability. Final figures are reconciled by our tax team before filing.';
        } else if (net < 0) {
            message = 'Indicative excess payment / credit: ' + money(Math.abs(net)) + '. This is not a GST computation and does not confirm any refund or credit. Final figures are reconciled by our tax team.';
        } else {
            message = 'Indicative net tax position: no net payable based on the figures entered. This is not a GST computation. Final figures are reconciled by our tax team before filing.';
        }
        box.innerHTML = '<strong>Indicative net tax position</strong><p>' + D.escapeHtml(message) + '</p>';
    }

    /* ------------------------------------------------------------------ *
     * Document checklist
     * ------------------------------------------------------------------ */

    function buildChecklist() {
        var service = value('gstServiceType');
        var constitution = value('gstConstitution');
        var registered = value('gstAlreadyRegistered') === 'Yes';
        var identity = ['PAN Card', 'Aadhaar Card', 'Photograph', 'Address Proof', 'Business Proof', 'Bank Proof'];
        var registration = [];
        var financial = [];

        if (service === 'New GST Registration') {
            addIfUnique(registration, 'Rent Agreement / NOC');
        }
        if (constitution === 'Private Limited Company' || constitution === 'Public Limited Company') {
            addIfUnique(registration, 'Certificate of Incorporation');
            addIfUnique(registration, 'Board Resolution');
        }
        if (constitution === 'Partnership' || constitution === 'LLP') {
            addIfUnique(registration, 'Partnership Deed');
            addIfUnique(registration, 'Authorisation Letter');
        }
        if (registered || service === 'GST Return Filing' || service === 'GST Amendment' ||
            service === 'GST Cancellation' || service === 'GST Compliance Assistance') {
            addIfUnique(registration, 'GST Certificate');
        }
        if (service === 'GST Return Filing' || service === 'GST Compliance Assistance') {
            addIfUnique(financial, 'Invoices');
            addIfUnique(financial, 'Purchase Bills');
            addIfUnique(financial, 'Previous GST Returns');
            addIfUnique(financial, 'Bank Statement');
        }
        if (service === 'GST Compliance Assistance') {
            addIfUnique(financial, 'Financial Statements');
        }
        if (service === 'GST Amendment' || service === 'GST Cancellation') {
            addIfUnique(registration, 'Other');
        }

        var groups = [
            { title: 'Identity & business', items: identity },
            { title: 'Registration & returns', items: registration },
            { title: 'Financial records', items: financial }
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
        el('gstDocChecklist').innerHTML = groups.map(function (group) {
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

    function fullAddress(line, city, district, state, pincode) {
        return [line, city, district, state, pincode].filter(Boolean).join(', ');
    }

    function renderReview() {
        var payload = buildPayload();
        var personal = payload.personal;
        var address = payload.address;
        var business = payload.business;
        var service = payload.service;
        var financials = payload.financials;
        var signatory = payload.signatory;
        var bank = payload.bank;
        var blocks = [];

        blocks.push({
            step: 0,
            title: 'Applicant & place of business',
            rows: [
                reviewRow('Applicant / signatory', personal.applicant_name),
                reviewRow('Designation', personal.designation),
                reviewRow('Mobile', personal.mobile),
                reviewRow('Email', personal.email),
                reviewRow('PAN', personal.pan_number),
                reviewRow('Aadhaar', personal.aadhaar_number
                    ? 'XXXX XXXX ' + personal.aadhaar_number.slice(-4)
                    : 'Not provided'),
                reviewRow('Aadhaar authentication', personal.aadhaar_verification_method),
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
                reviewRow('Nature of supply', business.business_nature),
                reviewRow('Main activity', business.business_activity),
                reviewRow('NIC / activity code', business.nic_code),
                reviewRow('Date of commencement', business.commencement_date),
                reviewRow('Annual turnover', business.annual_turnover !== null ? money(business.annual_turnover) : '\u2014'),
                reviewRow('Employees', business.employee_count !== null ? String(business.employee_count) : '\u2014'),
                reviewRow('Already GST registered', business.already_registered),
                reviewRow('GSTIN', business.gstin),
                reviewRow('Other registrations', business.existing_registrations)
            ]
        });

        var serviceRows = [
            reviewRow('Service required', service.service_type),
            reviewRow('Registration type', service.registration_type)
        ];
        if (service.service_type === 'GST Return Filing') {
            serviceRows.push(reviewRow('Return type', service.return_type_preference));
            serviceRows.push(reviewRow('Filing frequency', service.filing_frequency));
            serviceRows.push(reviewRow('Return period', service.return_period ? monthLabel(service.return_period) : ''));
            serviceRows.push(reviewRow('Financial year', service.financial_year));
            serviceRows.push(reviewRow('Previous filing status', service.previous_filing_status));
            serviceRows.push(reviewRow('Last return filed on', service.last_return_filed_on));
            serviceRows.push(reviewRow('Pending returns', service.pending_returns !== null ? String(service.pending_returns) : '\u2014'));
        }
        if (service.service_type === 'GST Amendment') {
            serviceRows.push(reviewRow('Amendment type', service.amendment_type));
            serviceRows.push(reviewRow('Amendment details', service.amendment_details));
        }
        if (service.service_type === 'GST Cancellation') {
            serviceRows.push(reviewRow('Cancellation reason', service.cancellation_reason));
            serviceRows.push(reviewRow('Proposed effective date', service.cancellation_effective_date));
        }
        if (service.service_type === 'GST Compliance Assistance') {
            serviceRows.push(reviewRow('Assistance required', service.compliance_areas));
        }
        blocks.push({ step: 2, title: 'Service requirement', rows: serviceRows });

        blocks.push({
            step: 3,
            title: 'Sales, purchases & tax position',
            rows: [
                reviewRow('Taxable sales', financials.sales_taxable !== null ? money(financials.sales_taxable) : '\u2014'),
                reviewRow('Exempt sales', financials.sales_exempt !== null ? money(financials.sales_exempt) : '\u2014'),
                reviewRow('Zero-rated / export sales', financials.sales_zero_rated !== null ? money(financials.sales_zero_rated) : '\u2014'),
                reviewRow('Purchases / inward supplies', financials.purchases !== null ? money(financials.purchases) : '\u2014'),
                reviewRow('Input tax credit claimed', financials.itc_claimed !== null ? money(financials.itc_claimed) : '\u2014'),
                reviewRow('Output tax liability', financials.tax_liability !== null ? money(financials.tax_liability) : '\u2014'),
                reviewRow('Tax already paid', financials.tax_paid !== null ? money(financials.tax_paid) : '\u2014'),
                reviewRow('Late fee & interest', financials.late_fee_interest !== null ? money(financials.late_fee_interest) : '\u2014'),
                reviewRow('Indicative net tax position', money(
                    (financials.tax_liability || 0) + (financials.late_fee_interest || 0) - (financials.tax_paid || 0)
                ))
            ]
        });

        blocks.push({
            step: 4,
            title: 'Authorised signatory & bank',
            rows: [
                reviewRow('Signatory name', signatory.signatory_name),
                reviewRow('Designation', signatory.signatory_designation),
                reviewRow('Signatory PAN', signatory.signatory_pan),
                reviewRow('DIN', signatory.signatory_din),
                reviewRow('Signatory mobile', signatory.signatory_mobile),
                reviewRow('Signatory email', signatory.signatory_email),
                reviewRow('Signatory address', signatory.signatory_address),
                reviewRow('Partners', signatory.partner_count !== null ? String(signatory.partner_count) : '\u2014'),
                reviewRow('Directors', signatory.director_count !== null ? String(signatory.director_count) : '\u2014'),
                reviewRow('Bank', bank.bank_name),
                reviewRow('Account', bank.bank_account_number ? maskAccount(bank.bank_account_number) : '\u2014'),
                reviewRow('IFSC', bank.bank_ifsc),
                reviewRow('Branch', bank.bank_branch),
                reviewRow('Account type', bank.bank_account_type)
            ]
        });

        var checklist = buildChecklist();
        blocks.push({
            step: 5,
            title: 'Document checklist',
            rows: checklist.map(function (group) {
                return reviewRow(group.title, group.items.join(', '));
            })
        });

        el('gstReviewSummary').innerHTML =
            '<div class="cp-info-box"><strong>This is an assistance request</strong><p>Submitting this form does not register your business, amend or cancel a registration, or file a return. Those actions are completed on the GST portal only after document verification and your approval.</p></div>' +
            blocks.map(function (block) {
                return '<div class="cp-review-block">' +
                    '<h4><span>' + D.escapeHtml(block.title) + '</span>' +
                    '<button type="button" data-goto="' + block.step + '">Edit</button></h4>' +
                    block.rows.join('') +
                    '</div>';
            }).join('');
    }

    el('gstReviewSummary').addEventListener('click', function (event) {
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
                applicant_name: value('gstApplicantName'),
                designation: value('gstDesignation'),
                mobile: D.digits(value('gstMobile')),
                email: value('gstEmail'),
                pan_number: value('gstPan').toUpperCase(),
                aadhaar_number: D.digits(value('gstAadhaar')),
                aadhaar_verification_method: value('gstAadhaarMethod')
            },
            address: {
                line: value('gstAddressLine'),
                city: value('gstAddressCity'),
                district: value('gstAddressDistrict'),
                state: value('gstAddressState'),
                pincode: D.digits(value('gstAddressPincode'))
            },
            business: {
                business_name: value('gstBusinessName'),
                trade_name: value('gstTradeName'),
                constitution: value('gstConstitution'),
                business_nature: value('gstBusinessNature'),
                business_activity: value('gstBusinessActivity'),
                nic_code: value('gstNicCode'),
                commencement_date: value('gstCommencementDate'),
                annual_turnover: numOrNull(value('gstAnnualTurnover')),
                employee_count: numOrNull(value('gstEmployeeCount')),
                already_registered: value('gstAlreadyRegistered'),
                gstin: value('gstin').toUpperCase(),
                existing_registrations: value('gstExistingRegistrations')
            },
            service: {
                service_type: value('gstServiceType'),
                registration_type: value('gstRegistrationType'),
                filing_frequency: value('gstFilingFrequency'),
                return_period: value('gstReturnPeriod'),
                financial_year: value('gstFinancialYear'),
                return_type_preference: value('gstReturnType'),
                previous_filing_status: value('gstPreviousFilingStatus'),
                last_return_filed_on: value('gstLastReturnFiledOn'),
                pending_returns: numOrNull(value('gstPendingReturns')),
                amendment_type: value('gstAmendmentType'),
                amendment_details: value('gstAmendmentDetails'),
                cancellation_reason: value('gstCancellationReason'),
                cancellation_effective_date: value('gstCancellationDate'),
                compliance_areas: value('gstComplianceAreas')
            },
            financials: {
                sales_taxable: numOrNull(value('gstSalesTaxable')),
                sales_exempt: numOrNull(value('gstSalesExempt')),
                sales_zero_rated: numOrNull(value('gstSalesZeroRated')),
                purchases: numOrNull(value('gstPurchases')),
                itc_claimed: numOrNull(value('gstItcClaimed')),
                tax_liability: numOrNull(value('gstTaxLiability')),
                tax_paid: numOrNull(value('gstTaxPaid')),
                late_fee_interest: numOrNull(value('gstLateFee')),
                invoice_count: numOrNull(value('gstInvoiceCount')),
                purchase_invoice_count: numOrNull(value('gstPurchaseInvoiceCount'))
            },
            signatory: {
                signatory_name: value('gstSignatoryName'),
                signatory_designation: value('gstSignatoryDesignation'),
                signatory_pan: value('gstSignatoryPan').toUpperCase(),
                signatory_din: value('gstSignatoryDin'),
                signatory_mobile: D.digits(value('gstSignatoryMobile')),
                signatory_email: value('gstSignatoryEmail'),
                signatory_address: value('gstSignatoryAddress'),
                partner_count: numOrNull(value('gstPartnerCount')),
                director_count: numOrNull(value('gstDirectorCount'))
            },
            bank: {
                bank_name: value('gstBankName'),
                bank_account_number: D.digits(value('gstBankAccountNumber')),
                bank_ifsc: value('gstBankIfsc').toUpperCase(),
                bank_branch: value('gstBankBranch'),
                bank_account_type: value('gstBankAccountType')
            },
            declarations: {
                accuracy: checked('gstAccuracyDeclaration'),
                authorisation: checked('gstAuthorisationDeclaration')
            },
            consent: checked('gstApplicationConsent'),
            consent_version: '2026-11',
            source_page: 'gst-apply.html'
        };
    }

    function draftSafePayload() {
        var payload = buildPayload();
        if (payload.personal) { payload.personal.aadhaar_number = ''; }
        if (payload.bank) { payload.bank.bank_account_number = ''; }
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
            if (!requireField('gstApplicantName', 'Enter the applicant or authorised signatory name.')) { ok = false; }
            if (!MOBILE_RE.test(D.digits(value('gstMobile')))) {
                D.setFieldError(el('gstMobile'), 'Enter a valid 10-digit Indian mobile number.');
                ok = false;
            }
            if (!EMAIL_RE.test(value('gstEmail'))) {
                D.setFieldError(el('gstEmail'), 'Enter a valid email address.');
                ok = false;
            }
            if (!PAN_RE.test(value('gstPan').toUpperCase())) {
                D.setFieldError(el('gstPan'), 'Enter a valid PAN (e.g. ABCDE1234F).');
                ok = false;
            }
            var aadhaar = D.digits(value('gstAadhaar'));
            if (aadhaar && aadhaar.length !== 12) {
                D.setFieldError(el('gstAadhaar'), 'Enter a valid 12-digit Aadhaar number.');
                ok = false;
            }
            if (aadhaar && !value('gstAadhaarMethod')) {
                D.setFieldError(el('gstAadhaarMethod'), 'Select the Aadhaar authentication method.');
                ok = false;
            }
            if (!requireField('gstAddressLine', 'Enter the principal place of business address.')) { ok = false; }
            if (!requireField('gstAddressCity', 'Enter the city or town.')) { ok = false; }
            if (!requireField('gstAddressState', 'Select the state.')) { ok = false; }
            if (!PIN_RE.test(D.digits(value('gstAddressPincode')))) {
                D.setFieldError(el('gstAddressPincode'), 'Enter a valid 6-digit PIN code.');
                ok = false;
            }
        }

        if (index === 1) {
            if (!requireField('gstBusinessName', 'Enter the legal business name.')) { ok = false; }
            if (!requireField('gstConstitution', 'Select the constitution of business.')) { ok = false; }
            if (!requireField('gstBusinessNature', 'Select whether you supply goods, services or both.')) { ok = false; }
            if (!requireField('gstBusinessActivity', 'Describe the main business activity.')) { ok = false; }
            if (!requireField('gstCommencementDate', 'Enter the date of commencement of business.')) { ok = false; }
            if (!requireField('gstAnnualTurnover', 'Enter the annual turnover.')) { ok = false; }
            if (!validateAmount('gstAnnualTurnover', 'Annual turnover')) { ok = false; }
            if (!validateCount('gstEmployeeCount', 'Employee count')) { ok = false; }
            if (!requireField('gstAlreadyRegistered', 'Select whether the business is already registered for GST.')) { ok = false; }
            if (value('gstAlreadyRegistered') === 'Yes') {
                var gstin = value('gstin').toUpperCase();
                if (!GSTIN_RE.test(gstin)) {
                    D.setFieldError(el('gstin'), 'Enter a valid 15-character GSTIN.');
                    ok = false;
                }
            }
            var commencement = value('gstCommencementDate');
            if (commencement) {
                var date = new Date(commencement + 'T00:00:00');
                var today = new Date();
                today.setHours(0, 0, 0, 0);
                if (!isNaN(date.getTime()) && date > today) {
                    D.setFieldError(el('gstCommencementDate'), 'Date of commencement cannot be in the future.');
                    ok = false;
                }
            }
        }

        if (index === 2) {
            var service = value('gstServiceType');
            if (!service) {
                D.setFieldError(el('gstServiceType'), 'Select the GST service required.');
                ok = false;
            }
            if (service && service !== 'New GST Registration' && !value('gstin')) {
                D.showAlert(alertBox, 'warning',
                    'Add your existing GSTIN in the business profile before continuing with this service.',
                    'GSTIN required');
                ok = false;
            }
            if (service === 'New GST Registration') {
                if (!requireField('gstRegistrationType', 'Select the registration type.')) { ok = false; }
                if (!requireField('gstAadhaarMethod', 'Select the Aadhaar authentication method.')) { ok = false; }
                if (!requireField('gstCommencementDate', 'Enter the date of commencement of business.')) { ok = false; }
            }
            if (service === 'GST Return Filing') {
                if (!requireField('gstReturnType', 'Select the return type.')) { ok = false; }
                if (!requireField('gstFilingFrequency', 'Select the filing frequency.')) { ok = false; }
                if (!requireField('gstReturnPeriod', 'Select the return period.')) { ok = false; }
                if (!requireField('gstPreviousFilingStatus', 'Select the previous filing status.')) { ok = false; }
                if (!validateCount('gstPendingReturns', 'Pending returns')) { ok = false; }
            }
            if (service === 'GST Amendment') {
                if (!requireField('gstAmendmentType', 'Select the amendment type.')) { ok = false; }
                if (!requireField('gstAmendmentDetails', 'Describe what needs to be amended.')) { ok = false; }
            }
            if (service === 'GST Cancellation') {
                if (!requireField('gstCancellationReason', 'Provide the reason for cancellation.')) { ok = false; }
            }
            if (service === 'GST Compliance Assistance') {
                if (!requireField('gstComplianceAreas', 'Describe the compliance assistance required.')) { ok = false; }
            }
        }

        if (index === 3) {
            if (!validateAmount('gstSalesTaxable', 'Taxable sales')) { ok = false; }
            if (!validateAmount('gstSalesExempt', 'Exempt sales')) { ok = false; }
            if (!validateAmount('gstSalesZeroRated', 'Zero-rated sales')) { ok = false; }
            if (!validateAmount('gstPurchases', 'Purchases')) { ok = false; }
            if (!validateAmount('gstItcClaimed', 'Input tax credit')) { ok = false; }
            if (!validateAmount('gstTaxLiability', 'Tax liability')) { ok = false; }
            if (!validateAmount('gstTaxPaid', 'Tax paid')) { ok = false; }
            if (!validateAmount('gstLateFee', 'Late fee and interest')) { ok = false; }
            if (!validateCount('gstInvoiceCount', 'Sales invoice count')) { ok = false; }
            if (!validateCount('gstPurchaseInvoiceCount', 'Purchase invoice count')) { ok = false; }
        }

        if (index === 4) {
            if (!requireField('gstSignatoryName', 'Enter the authorised signatory name.')) { ok = false; }
            if (!requireField('gstSignatoryDesignation', 'Enter the authorised signatory designation.')) { ok = false; }
            var sigPan = value('gstSignatoryPan').toUpperCase();
            if (sigPan && !PAN_RE.test(sigPan)) {
                D.setFieldError(el('gstSignatoryPan'), 'Enter a valid signatory PAN.');
                ok = false;
            }
            var sigMobile = D.digits(value('gstSignatoryMobile'));
            if (sigMobile && !MOBILE_RE.test(sigMobile)) {
                D.setFieldError(el('gstSignatoryMobile'), 'Enter a valid 10-digit mobile number.');
                ok = false;
            }
            var sigEmail = value('gstSignatoryEmail');
            if (sigEmail && !EMAIL_RE.test(sigEmail)) {
                D.setFieldError(el('gstSignatoryEmail'), 'Enter a valid email address.');
                ok = false;
            }
            if (!validateCount('gstPartnerCount', 'Partner count')) { ok = false; }
            if (!validateCount('gstDirectorCount', 'Director count')) { ok = false; }
            if (!requireField('gstBankName', 'Enter the bank name.')) { ok = false; }
            var account = D.digits(value('gstBankAccountNumber'));
            if (!/^[0-9]{6,18}$/.test(account)) {
                D.setFieldError(el('gstBankAccountNumber'), 'Enter a valid 6-18 digit bank account number.');
                ok = false;
            }
            if (!IFSC_RE.test(value('gstBankIfsc').toUpperCase())) {
                D.setFieldError(el('gstBankIfsc'), 'Enter a valid 11-character IFSC code.');
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
                    D.escapeHtml(resumeLink()) + '</code>. For your security, Aadhaar and bank account numbers are not stored in drafts; re-enter them when you resume.';
            }
            D.showAlert(alertBox, 'success',
                'Your GST application has been saved. Bookmark this page or keep the resume link to continue later. Aadhaar and bank account numbers are not stored in drafts and must be re-entered when you resume.',
                'Draft saved');
        } catch (err) {
            console.error('GST draft save failed:', err);
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
        var address = payload.address || {};
        var business = payload.business || {};
        var service = payload.service || {};
        var financials = payload.financials || {};
        var signatory = payload.signatory || {};
        var bank = payload.bank || {};

        el('gstApplicantName').value = personal.applicant_name || '';
        el('gstDesignation').value = personal.designation || '';
        el('gstMobile').value = personal.mobile || '';
        el('gstEmail').value = personal.email || '';
        el('gstPan').value = personal.pan_number || '';
        el('gstAadhaar').value = personal.aadhaar_number || '';
        el('gstAadhaarMethod').value = personal.aadhaar_verification_method || '';

        el('gstAddressLine').value = address.line || '';
        el('gstAddressCity').value = address.city || '';
        el('gstAddressDistrict').value = address.district || '';
        setSelectValue('gstAddressState', address.state || '');
        el('gstAddressPincode').value = address.pincode || '';

        el('gstBusinessName').value = business.business_name || '';
        el('gstTradeName').value = business.trade_name || '';
        el('gstConstitution').value = business.constitution || '';
        el('gstBusinessNature').value = business.business_nature || '';
        el('gstBusinessActivity').value = business.business_activity || '';
        el('gstNicCode').value = business.nic_code || '';
        el('gstCommencementDate').value = business.commencement_date || '';
        el('gstAnnualTurnover').value = business.annual_turnover !== null && business.annual_turnover !== undefined ? business.annual_turnover : '';
        el('gstEmployeeCount').value = business.employee_count !== null && business.employee_count !== undefined ? business.employee_count : '';
        el('gstAlreadyRegistered').value = business.already_registered || (business.gstin ? 'Yes' : '');
        el('gstin').value = business.gstin || '';
        el('gstExistingRegistrations').value = business.existing_registrations || '';

        el('gstServiceType').value = service.service_type || '';
        el('gstRegistrationType').value = service.registration_type || '';
        el('gstFilingFrequency').value = service.filing_frequency || '';
        setSelectValue('gstReturnPeriod', service.return_period || '');
        setSelectValue('gstFinancialYear', service.financial_year || '');
        el('gstReturnType').value = service.return_type_preference || '';
        el('gstPreviousFilingStatus').value = service.previous_filing_status || '';
        el('gstLastReturnFiledOn').value = service.last_return_filed_on || '';
        el('gstPendingReturns').value = service.pending_returns !== null && service.pending_returns !== undefined ? service.pending_returns : '';
        el('gstAmendmentType').value = service.amendment_type || '';
        el('gstAmendmentDetails').value = service.amendment_details || '';
        el('gstCancellationReason').value = service.cancellation_reason || '';
        el('gstCancellationDate').value = service.cancellation_effective_date || '';
        el('gstComplianceAreas').value = service.compliance_areas || '';

        el('gstSalesTaxable').value = financials.sales_taxable !== null && financials.sales_taxable !== undefined ? financials.sales_taxable : '';
        el('gstSalesExempt').value = financials.sales_exempt !== null && financials.sales_exempt !== undefined ? financials.sales_exempt : '';
        el('gstSalesZeroRated').value = financials.sales_zero_rated !== null && financials.sales_zero_rated !== undefined ? financials.sales_zero_rated : '';
        el('gstPurchases').value = financials.purchases !== null && financials.purchases !== undefined ? financials.purchases : '';
        el('gstItcClaimed').value = financials.itc_claimed !== null && financials.itc_claimed !== undefined ? financials.itc_claimed : '';
        el('gstTaxLiability').value = financials.tax_liability !== null && financials.tax_liability !== undefined ? financials.tax_liability : '';
        el('gstTaxPaid').value = financials.tax_paid !== null && financials.tax_paid !== undefined ? financials.tax_paid : '';
        el('gstLateFee').value = financials.late_fee_interest !== null && financials.late_fee_interest !== undefined ? financials.late_fee_interest : '';
        el('gstInvoiceCount').value = financials.invoice_count !== null && financials.invoice_count !== undefined ? financials.invoice_count : '';
        el('gstPurchaseInvoiceCount').value = financials.purchase_invoice_count !== null && financials.purchase_invoice_count !== undefined ? financials.purchase_invoice_count : '';

        el('gstSignatoryName').value = signatory.signatory_name || '';
        el('gstSignatoryDesignation').value = signatory.signatory_designation || '';
        el('gstSignatoryPan').value = signatory.signatory_pan || '';
        el('gstSignatoryDin').value = signatory.signatory_din || '';
        el('gstSignatoryMobile').value = signatory.signatory_mobile || '';
        el('gstSignatoryEmail').value = signatory.signatory_email || '';
        el('gstSignatoryAddress').value = signatory.signatory_address || '';
        el('gstPartnerCount').value = signatory.partner_count !== null && signatory.partner_count !== undefined ? signatory.partner_count : '';
        el('gstDirectorCount').value = signatory.director_count !== null && signatory.director_count !== undefined ? signatory.director_count : '';

        el('gstBankName').value = bank.bank_name || '';
        el('gstBankAccountNumber').value = bank.bank_account_number || '';
        el('gstBankIfsc').value = bank.bank_ifsc || '';
        el('gstBankBranch').value = bank.bank_branch || '';
        el('gstBankAccountType').value = bank.bank_account_type || '';

        syncGstin();
        syncServiceBlocks();
        syncFinancialYear();
        updateNetTaxEstimate();
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
        syncGstin();
        syncServiceBlocks();
        syncFinancialYear();
        updateNetTaxEstimate();
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
                D.notify('success', 'Draft restored', 'Your saved GST application has been loaded.');
                return;
            } catch (err) {
                console.warn('Failed to resume GST draft from link:', err);
                D.showAlert(alertBox, 'warning',
                    'The resume link could not be loaded. ' + D.friendlyError(err),
                    'Draft unavailable');
            }
        }
        if (readStoredDraft() && draftBar) {
            draftBar.classList.remove('cp-hidden');
            draftBarText.textContent = 'We found a saved draft of your GST application on this device.';
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
            console.warn('Background GST draft save failed:', err);
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

        if (!checked('gstAccuracyDeclaration')) {
            D.showAlert(alertBox, 'warning',
                'Please confirm that the information provided is true and complete.',
                'Declaration required');
            el('gstAccuracyDeclaration').focus();
            return;
        }
        if (!checked('gstAuthorisationDeclaration')) {
            D.showAlert(alertBox, 'warning',
                'Please authorise Dhanvi Finserv to prepare and submit your GST application or return.',
                'Authorisation required');
            el('gstAuthorisationDeclaration').focus();
            return;
        }
        if (!checked('gstApplicationConsent')) {
            D.showAlert(alertBox, 'warning',
                'Please accept the privacy notice and GST consent before submitting.',
                'Consent required');
            el('gstApplicationConsent').focus();
            return;
        }

        var payload = buildPayload();
        D.setLoading(submitBtn, true, 'Submitting application\u2026');
        try {
            var result = await D.rpc('submit_gst_application', {
                p_payload: payload,
                p_draft_id: draftId,
                p_draft_token: draftToken
            });
            clearStoredDraft();
            showSuccess(result);
        } catch (err) {
            console.error('GST submission failed:', err);
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
            'Your GST assistance request has been received. Reference: ' +
            (result.reference_no || '\u2014') + '. This is not a completed registration or a filed return.',
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
        if (['gstSalesTaxable', 'gstSalesExempt', 'gstSalesZeroRated', 'gstPurchases',
             'gstItcClaimed', 'gstTaxLiability', 'gstTaxPaid', 'gstLateFee'].indexOf(event.target.id) !== -1) {
            updateNetTaxEstimate();
        }
    });

    form.addEventListener('change', function (event) {
        if (event.target.classList.contains('form-control')) {
            D.clearFieldError(event.target);
        }
        if (event.target.id === 'gstAlreadyRegistered') { syncGstin(); }
        if (event.target.id === 'gstin') { updateGstinNote(); }
        if (event.target.id === 'gstServiceType') { syncServiceBlocks(); }
        if (event.target.id === 'gstReturnPeriod') { syncFinancialYear(); }
    });

    /* ------------------------------------------------------------------ *
     * Boot
     * ------------------------------------------------------------------ */

    function boot() {
        initOptions();
        syncGstin();
        syncServiceBlocks();
        syncFinancialYear();
        updateNetTaxEstimate();
        showStep(0, false);
        initDraft();
    }

    boot();
})(window, document);

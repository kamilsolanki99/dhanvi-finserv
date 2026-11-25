/**
 * Dhanvi Finserv - multi-step Credit Health / CIBIL advisory wizard.
 *
 * Depends on: js/nhost-client.js, js/public-api.js
 *
 * Flow
 *   1    applicant profile, PAN, date of birth, occupation, income, address
 *   2    advisory service, bureau preference, current score, target loan
 *   3    existing credit profile, overdue / settlement history, disclosed accounts
 *   4    recent credit enquiries
 *   5    conditional document checklist
 *   6    review and mandatory bureau / accuracy / no-guarantee declarations
 *
 * Save / resume
 *   A server-side draft is created through save_home_loan_draft() (shared with
 *   the other application wizards) as soon as the first step validates, and
 *   refreshed on every step change. The draft id + secret token are kept in
 *   localStorage so the applicant can resume in the same browser, and
 *   "Save & continue later" also shows a resume link. Submitting promotes the
 *   draft into a real credit health advisory request through
 *   submit_credit_health_application().
 *
 * IMPORTANT
 *   Submitting this wizard does NOT pull a credit report, increase a score,
 *   remove a genuine default or approve a loan. A bureau report is obtained
 *   only after consent and through an authorised bureau process. The bureau,
 *   lender and their policies decide those outcomes. The administrator records
 *   the bureau reference, report date, score and analysis only after the
 *   authorised bureau has actually supplied the information.
 *
 *   PAN and the last four characters of each account reference are removed from
 *   saved drafts and must be re-entered when a draft is resumed.
 */
(function (window, document) {
    'use strict';

    var D = window.Dhanvi;
    var form = document.getElementById('creditHealthApplicationForm');
    if (!form || !D) { return; }

    var DRAFT_KEY = 'dhanviCreditHealthDraft';
    var TOTAL_STEPS = 6;
    var CONSENT_VERSION = '2026-11';

    var alertBox = document.getElementById('applicationAlert');
    var draftBar = document.getElementById('draftBar');
    var draftBarText = document.getElementById('draftBarText');
    var successBox = document.getElementById('applicationSuccess');
    var stepper = document.getElementById('creditHealthStepper');
    var steps = Array.prototype.slice.call(form.querySelectorAll('.cp-step'));
    var prevBtn = document.getElementById('prevBtn');
    var nextBtn = document.getElementById('nextBtn');
    var submitBtn = document.getElementById('submitBtn');
    var saveDraftBtn = document.getElementById('saveDraftBtn');
    var progressText = document.getElementById('progressText');
    var accountsList = document.getElementById('creditAccountsList');
    var enquiriesList = document.getElementById('creditEnquiriesList');

    var current = 0;
    var maxStep = 0;
    var draftId = null;
    var draftToken = null;
    var accountSeq = 0;
    var enquirySeq = 0;

    var STATES = ['Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal', 'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir', 'Ladakh', 'Lakshadweep', 'Puducherry'];

    var ACCOUNT_TYPES = ['Home Loan', 'Home Loan Top-Up', 'Home Loan Takeover', 'Loan Against Property', 'Business Loan', 'Personal Loan', 'Vehicle Loan', 'Education Loan', 'Gold Loan', 'Credit Card', 'Consumer Durable Loan', 'Working Capital (CC/OD)', 'Other'];
    var ACCOUNT_STATUSES = ['Active', 'Closed', 'Overdue', 'Settled', 'Written Off', 'Restructured', 'Not sure'];
    var ENQUIRY_BUREAUS = ['CIBIL', 'Experian', 'CRIF High Mark', 'Equifax', 'Multiple bureaus', 'Not sure'];
    var ENQUIRY_PURPOSES = ['Loan application', 'Credit card application', 'Existing customer review', 'Background / employment check', 'Other', 'Not sure'];
    var ENQUIRY_STATUSES = ['Approved', 'Rejected', 'Pending', 'Not sure'];

    var PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
    var MOBILE_RE = /^[6-9][0-9]{9}$/;
    var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    var PIN_RE = /^[0-9]{6}$/;
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

    function dateOrNull(raw) {
        var text = String(raw === null || raw === undefined ? '' : raw).trim();
        return text === '' ? null : text;
    }

    function money(amount) {
        var number = Number(amount);
        if (isNaN(number)) { return '\u2014'; }
        return '\u20B9' + number.toLocaleString('en-IN');
    }

    function addIfUnique(list, item) {
        if (list.indexOf(item) === -1) { list.push(item); }
    }

    function optionList(options) {
        return options.map(function (option) {
            return '<option value="' + D.escapeHtml(option) + '">' + D.escapeHtml(option) + '</option>';
        }).join('');
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

    function todayIso() {
        var now = new Date();
        var month = String(now.getMonth() + 1);
        var day = String(now.getDate());
        if (month.length < 2) { month = '0' + month; }
        if (day.length < 2) { day = '0' + day; }
        return now.getFullYear() + '-' + month + '-' + day;
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

    function maskPan(pan) {
        var text = String(pan || '').toUpperCase();
        if (!text) { return ''; }
        if (text.length <= 4) { return '****'; }
        return text.slice(0, 2) + '******' + text.slice(-2);
    }

    /* ------------------------------------------------------------------ *
     * Static options and conditional behaviour
     * ------------------------------------------------------------------ */

    function initOptions() {
        var select = el('creditAddressState');
        if (select) {
            select.innerHTML = '<option value="">Select state</option>' + STATES.map(function (state) {
                return '<option value="' + D.escapeHtml(state) + '">' + D.escapeHtml(state) + '</option>';
            }).join('');
        }
    }

    function syncOverdue() {
        var show = value('creditOverdueAccounts') === 'Yes';
        var block = el('creditOverdueBlock');
        if (block) { block.classList.toggle('cp-hidden', !show); }
        if (!show && el('creditOverdueDetails')) { el('creditOverdueDetails').value = ''; }
    }

    function syncSettlement() {
        var show = value('creditSettlementHistory') === 'Yes';
        var block = el('creditSettlementBlock');
        if (block) { block.classList.toggle('cp-hidden', !show); }
        if (!show && el('creditSettlementDetails')) { el('creditSettlementDetails').value = ''; }
    }

    function syncExistingReport() {
        var show = checked('creditExistingReport');
        var block = el('creditExistingReportBlock');
        if (block) { block.classList.toggle('cp-hidden', !show); }
        if (!show) {
            if (el('creditExistingReportDate')) { el('creditExistingReportDate').value = ''; }
            if (el('creditExistingReportSource')) { el('creditExistingReportSource').value = ''; }
        }
    }

    function syncConditionals() {
        syncOverdue();
        syncSettlement();
        syncExistingReport();
    }

    /* ------------------------------------------------------------------ *
     * Repeatable accounts
     * ------------------------------------------------------------------ */

    function rowValue(row, field) {
        var control = row.querySelector('[data-field="' + field + '"]');
        return control ? String(control.value || '').trim() : '';
    }

    function rowControl(row, field) {
        return row.querySelector('[data-field="' + field + '"]');
    }

    function accountRowTemplate(uid) {
        return '' +
            '<div class="credit-repeat-head">' +
                '<strong><i class="fa fa-credit-card"></i> Credit account</strong>' +
                '<button type="button" class="credit-repeat-remove" aria-label="Remove this credit account"><i class="fa fa-trash-o"></i> Remove</button>' +
            '</div>' +
            '<div class="cp-grid">' +
                '<div class="cp-col-4"><div class="cp-field">' +
                    '<label for="' + uid + 'Type">Account type <span class="cp-req">*</span></label>' +
                    '<select class="form-control" id="' + uid + 'Type" data-field="account_type">' +
                        '<option value="">Select type</option>' + optionList(ACCOUNT_TYPES) +
                    '</select>' +
                '</div></div>' +
                '<div class="cp-col-4"><div class="cp-field">' +
                    '<label for="' + uid + 'Lender">Lender name <span class="cp-req">*</span></label>' +
                    '<input type="text" class="form-control" id="' + uid + 'Lender" data-field="lender_name" maxlength="150" placeholder="e.g. HDFC Bank">' +
                '</div></div>' +
                '<div class="cp-col-4"><div class="cp-field">' +
                    '<label for="' + uid + 'Ref">Account last 4</label>' +
                    '<input type="text" class="form-control" id="' + uid + 'Ref" data-field="account_reference_last4" maxlength="8" placeholder="e.g. 1234" style="text-transform:uppercase;" autocomplete="off">' +
                '</div></div>' +
                '<div class="cp-col-4"><div class="cp-field">' +
                    '<label for="' + uid + 'Status">Account status <span class="cp-req">*</span></label>' +
                    '<select class="form-control" id="' + uid + 'Status" data-field="account_status">' +
                        '<option value="">Select status</option>' + optionList(ACCOUNT_STATUSES) +
                    '</select>' +
                '</div></div>' +
                '<div class="cp-col-4"><div class="cp-field">' +
                    '<label for="' + uid + 'Outstanding">Outstanding (₹)</label>' +
                    '<input type="number" class="form-control" id="' + uid + 'Outstanding" data-field="outstanding_amount" min="0" step="1" placeholder="Optional">' +
                '</div></div>' +
                '<div class="cp-col-4"><div class="cp-field">' +
                    '<label for="' + uid + 'Emi">Monthly EMI (₹)</label>' +
                    '<input type="number" class="form-control" id="' + uid + 'Emi" data-field="emi_amount" min="0" step="1" placeholder="Optional">' +
                '</div></div>' +
                '<div class="cp-col-4"><div class="cp-field">' +
                    '<label for="' + uid + 'Overdue">Overdue amount (₹)</label>' +
                    '<input type="number" class="form-control" id="' + uid + 'Overdue" data-field="overdue_amount" min="0" step="1" placeholder="Optional">' +
                '</div></div>' +
                '<div class="cp-col-4"><div class="cp-field">' +
                    '<label for="' + uid + 'Dpd">Days past due</label>' +
                    '<input type="number" class="form-control" id="' + uid + 'Dpd" data-field="days_past_due" min="0" max="999" step="1" placeholder="Optional">' +
                '</div></div>' +
                '<div class="cp-col-4"><div class="cp-field">' +
                    '<label for="' + uid + 'Opened">Opened on</label>' +
                    '<input type="date" class="form-control" id="' + uid + 'Opened" data-field="opened_date">' +
                '</div></div>' +
                '<div class="cp-col-4"><div class="cp-field">' +
                    '<label for="' + uid + 'Closed">Closed on</label>' +
                    '<input type="date" class="form-control" id="' + uid + 'Closed" data-field="closed_date">' +
                '</div></div>' +
                '<div class="cp-col-4"><div class="cp-field">' +
                    '<label for="' + uid + 'Settled">Settled amount (₹)</label>' +
                    '<input type="number" class="form-control" id="' + uid + 'Settled" data-field="settled_amount" min="0" step="1" placeholder="Optional">' +
                '</div></div>' +
                '<div class="cp-col-4"><div class="cp-field">' +
                    '<label for="' + uid + 'Remarks">Remarks</label>' +
                    '<input type="text" class="form-control" id="' + uid + 'Remarks" data-field="remarks" maxlength="500" placeholder="Optional">' +
                '</div></div>' +
            '</div>';
    }

    function setRowValue(row, field, next) {
        var control = rowControl(row, field);
        if (!control) { return; }
        control.value = next === null || next === undefined ? '' : String(next);
    }

    function updateListEmpty(list, message) {
        if (!list) { return; }
        var rows = list.querySelectorAll('.credit-repeat-row');
        var existing = list.querySelector('.credit-repeat-empty');
        if (rows.length > 0) {
            if (existing) { existing.remove(); }
            return;
        }
        if (!existing) {
            existing = document.createElement('div');
            existing.className = 'credit-repeat-empty';
            list.appendChild(existing);
        }
        existing.innerHTML = '<i class="fa fa-info-circle"></i> ' + D.escapeHtml(message);
    }

    function clearRepeatList(list, message) {
        if (!list) { return; }
        list.innerHTML = '';
        updateListEmpty(list, message);
    }

    function addAccountRow(data) {
        data = data || {};
        accountSeq += 1;
        var uid = 'creditAccount' + accountSeq;
        var row = document.createElement('div');
        row.className = 'credit-repeat-row';
        row.setAttribute('data-repeat', 'account');
        row.innerHTML = accountRowTemplate(uid);
        accountsList.appendChild(row);

        setRowValue(row, 'account_type', data.account_type || '');
        setRowValue(row, 'lender_name', data.lender_name || '');
        setRowValue(row, 'account_reference_last4', data.account_reference_last4 || '');
        setRowValue(row, 'account_status', data.account_status || '');
        setRowValue(row, 'outstanding_amount', data.outstanding_amount !== null && data.outstanding_amount !== undefined ? data.outstanding_amount : '');
        setRowValue(row, 'emi_amount', data.emi_amount !== null && data.emi_amount !== undefined ? data.emi_amount : '');
        setRowValue(row, 'overdue_amount', data.overdue_amount !== null && data.overdue_amount !== undefined ? data.overdue_amount : '');
        setRowValue(row, 'days_past_due', data.days_past_due !== null && data.days_past_due !== undefined ? data.days_past_due : '');
        setRowValue(row, 'opened_date', data.opened_date || '');
        setRowValue(row, 'closed_date', data.closed_date || '');
        setRowValue(row, 'settled_amount', data.settled_amount !== null && data.settled_amount !== undefined ? data.settled_amount : '');
        setRowValue(row, 'remarks', data.remarks || '');

        updateListEmpty(accountsList, 'No credit accounts added yet. Add a loan or credit card if you have one, or continue if you have none.');
        return row;
    }

    /* ------------------------------------------------------------------ *
     * Repeatable enquiries
     * ------------------------------------------------------------------ */

    function enquiryRowTemplate(uid) {
        return '' +
            '<div class="credit-repeat-head">' +
                '<strong><i class="fa fa-search"></i> Credit enquiry</strong>' +
                '<button type="button" class="credit-repeat-remove" aria-label="Remove this credit enquiry"><i class="fa fa-trash-o"></i> Remove</button>' +
            '</div>' +
            '<div class="cp-grid">' +
                '<div class="cp-col-4"><div class="cp-field">' +
                    '<label for="' + uid + 'Bureau">Bureau <span class="cp-req">*</span></label>' +
                    '<select class="form-control" id="' + uid + 'Bureau" data-field="bureau">' +
                        '<option value="">Select bureau</option>' + optionList(ENQUIRY_BUREAUS) +
                    '</select>' +
                '</div></div>' +
                '<div class="cp-col-4"><div class="cp-field">' +
                    '<label for="' + uid + 'Institution">Lender / institution <span class="cp-req">*</span></label>' +
                    '<input type="text" class="form-control" id="' + uid + 'Institution" data-field="institution_name" maxlength="150" placeholder="e.g. ICICI Bank">' +
                '</div></div>' +
                '<div class="cp-col-4"><div class="cp-field">' +
                    '<label for="' + uid + 'Date">Enquiry date <span class="cp-req">*</span></label>' +
                    '<input type="date" class="form-control" id="' + uid + 'Date" data-field="enquiry_date">' +
                '</div></div>' +
                '<div class="cp-col-4"><div class="cp-field">' +
                    '<label for="' + uid + 'Purpose">Purpose <span class="cp-req">*</span></label>' +
                    '<select class="form-control" id="' + uid + 'Purpose" data-field="purpose">' +
                        '<option value="">Select purpose</option>' + optionList(ENQUIRY_PURPOSES) +
                    '</select>' +
                '</div></div>' +
                '<div class="cp-col-4"><div class="cp-field">' +
                    '<label for="' + uid + 'Status">Outcome <span class="cp-req">*</span></label>' +
                    '<select class="form-control" id="' + uid + 'Status" data-field="status">' +
                        '<option value="">Select outcome</option>' + optionList(ENQUIRY_STATUSES) +
                    '</select>' +
                '</div></div>' +
                '<div class="cp-col-4"><div class="cp-field">' +
                    '<label for="' + uid + 'Remarks">Remarks</label>' +
                    '<input type="text" class="form-control" id="' + uid + 'Remarks" data-field="remarks" maxlength="500" placeholder="Optional">' +
                '</div></div>' +
            '</div>';
    }

    function addEnquiryRow(data) {
        data = data || {};
        enquirySeq += 1;
        var uid = 'creditEnquiry' + enquirySeq;
        var row = document.createElement('div');
        row.className = 'credit-repeat-row';
        row.setAttribute('data-repeat', 'enquiry');
        row.innerHTML = enquiryRowTemplate(uid);
        enquiriesList.appendChild(row);

        setRowValue(row, 'bureau', data.bureau || '');
        setRowValue(row, 'institution_name', data.institution_name || '');
        setRowValue(row, 'enquiry_date', data.enquiry_date || '');
        setRowValue(row, 'purpose', data.purpose || '');
        setRowValue(row, 'status', data.status || '');
        setRowValue(row, 'remarks', data.remarks || '');

        updateListEmpty(enquiriesList, 'No enquiries added yet. Add an application you remember, or continue if you are not sure.');
        return row;
    }

    /* ------------------------------------------------------------------ *
     * Collect and validate repeatable rows
     * ------------------------------------------------------------------ */

    function readAccountRow(row) {
        var reference = rowValue(row, 'account_reference_last4').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
        return {
            account_type: rowValue(row, 'account_type'),
            lender_name: rowValue(row, 'lender_name'),
            account_reference_last4: reference,
            account_status: rowValue(row, 'account_status'),
            outstanding_amount: numOrNull(rowValue(row, 'outstanding_amount')),
            emi_amount: numOrNull(rowValue(row, 'emi_amount')),
            overdue_amount: numOrNull(rowValue(row, 'overdue_amount')),
            days_past_due: numOrNull(rowValue(row, 'days_past_due')),
            opened_date: dateOrNull(rowValue(row, 'opened_date')),
            closed_date: dateOrNull(rowValue(row, 'closed_date')),
            settled_amount: numOrNull(rowValue(row, 'settled_amount')),
            remarks: rowValue(row, 'remarks')
        };
    }

    function accountHasData(data) {
        return !!(data.account_type || data.lender_name || data.account_reference_last4 ||
            data.account_status || data.outstanding_amount !== null || data.emi_amount !== null ||
            data.overdue_amount !== null || data.days_past_due !== null || data.opened_date ||
            data.closed_date || data.settled_amount !== null || data.remarks);
    }

    function collectAccounts() {
        var rows = Array.prototype.slice.call(accountsList.querySelectorAll('.credit-repeat-row'));
        var result = [];
        rows.forEach(function (row) {
            var data = readAccountRow(row);
            if (!accountHasData(data)) { return; }
            data.sort_order = result.length + 1;
            result.push(data);
        });
        return result;
    }

    function readEnquiryRow(row) {
        return {
            bureau: rowValue(row, 'bureau'),
            institution_name: rowValue(row, 'institution_name'),
            enquiry_date: dateOrNull(rowValue(row, 'enquiry_date')),
            purpose: rowValue(row, 'purpose'),
            status: rowValue(row, 'status'),
            remarks: rowValue(row, 'remarks')
        };
    }

    function enquiryHasData(data) {
        return !!(data.bureau || data.institution_name || data.enquiry_date || data.purpose || data.status || data.remarks);
    }

    function collectEnquiries() {
        var rows = Array.prototype.slice.call(enquiriesList.querySelectorAll('.credit-repeat-row'));
        var result = [];
        rows.forEach(function (row) {
            var data = readEnquiryRow(row);
            if (!enquiryHasData(data)) { return; }
            data.sort_order = result.length + 1;
            result.push(data);
        });
        return result;
    }

    function nonNegativeOrBlank(raw) {
        var text = String(raw || '').trim();
        if (text === '') { return true; }
        var number = Number(text);
        return !isNaN(number) && number >= 0;
    }

    function wholeNumberInRange(raw, min, max) {
        var text = String(raw || '').trim();
        if (text === '') { return true; }
        var number = Number(text);
        return !isNaN(number) && Math.floor(number) === number && number >= min && number <= max;
    }

    function validateAccounts() {
        var ok = true;
        var rows = Array.prototype.slice.call(accountsList.querySelectorAll('.credit-repeat-row'));
        rows.forEach(function (row) {
            var data = readAccountRow(row);
            if (!accountHasData(data)) { return; }

            if (!data.account_type) {
                D.setFieldError(rowControl(row, 'account_type'), 'Select the account type.');
                ok = false;
            } else if (ACCOUNT_TYPES.indexOf(data.account_type) === -1) {
                D.setFieldError(rowControl(row, 'account_type'), 'Select a valid account type.');
                ok = false;
            }
            if (!data.lender_name) {
                D.setFieldError(rowControl(row, 'lender_name'), 'Enter the lender name.');
                ok = false;
            }
            if (data.account_reference_last4 && !/^[A-Z0-9]{4}$/.test(data.account_reference_last4)) {
                D.setFieldError(rowControl(row, 'account_reference_last4'), 'Enter exactly the last 4 letters or digits, or leave it blank.');
                ok = false;
            }
            if (!data.account_status) {
                D.setFieldError(rowControl(row, 'account_status'), 'Select the account status.');
                ok = false;
            } else if (ACCOUNT_STATUSES.indexOf(data.account_status) === -1) {
                D.setFieldError(rowControl(row, 'account_status'), 'Select a valid account status.');
                ok = false;
            }
            if (!nonNegativeOrBlank(rowValue(row, 'outstanding_amount'))) {
                D.setFieldError(rowControl(row, 'outstanding_amount'), 'Outstanding cannot be negative.');
                ok = false;
            }
            if (!nonNegativeOrBlank(rowValue(row, 'emi_amount'))) {
                D.setFieldError(rowControl(row, 'emi_amount'), 'EMI cannot be negative.');
                ok = false;
            }
            if (!nonNegativeOrBlank(rowValue(row, 'overdue_amount'))) {
                D.setFieldError(rowControl(row, 'overdue_amount'), 'Overdue amount cannot be negative.');
                ok = false;
            }
            if (!wholeNumberInRange(rowValue(row, 'days_past_due'), 0, 999)) {
                D.setFieldError(rowControl(row, 'days_past_due'), 'Days past due must be a whole number between 0 and 999.');
                ok = false;
            }
            if (!nonNegativeOrBlank(rowValue(row, 'settled_amount'))) {
                D.setFieldError(rowControl(row, 'settled_amount'), 'Settled amount cannot be negative.');
                ok = false;
            }
            if (data.opened_date && data.opened_date > todayIso()) {
                D.setFieldError(rowControl(row, 'opened_date'), 'The opening date cannot be in the future.');
                ok = false;
            }
            if (data.closed_date && data.closed_date > todayIso()) {
                D.setFieldError(rowControl(row, 'closed_date'), 'The closure date cannot be in the future.');
                ok = false;
            }
            if (data.opened_date && data.closed_date && data.closed_date < data.opened_date) {
                D.setFieldError(rowControl(row, 'closed_date'), 'The closure date cannot be before the opening date.');
                ok = false;
            }
        });
        return ok;
    }

    function validateEnquiries() {
        var ok = true;
        var rows = Array.prototype.slice.call(enquiriesList.querySelectorAll('.credit-repeat-row'));
        rows.forEach(function (row) {
            var data = readEnquiryRow(row);
            if (!enquiryHasData(data)) { return; }

            if (!data.bureau) {
                D.setFieldError(rowControl(row, 'bureau'), 'Select the bureau.');
                ok = false;
            } else if (ENQUIRY_BUREAUS.indexOf(data.bureau) === -1) {
                D.setFieldError(rowControl(row, 'bureau'), 'Select a valid bureau.');
                ok = false;
            }
            if (!data.institution_name) {
                D.setFieldError(rowControl(row, 'institution_name'), 'Enter the lender or institution name.');
                ok = false;
            }
            if (!data.enquiry_date) {
                D.setFieldError(rowControl(row, 'enquiry_date'), 'Enter the enquiry date.');
                ok = false;
            } else if (data.enquiry_date > todayIso()) {
                D.setFieldError(rowControl(row, 'enquiry_date'), 'The enquiry date cannot be in the future.');
                ok = false;
            }
            if (!data.purpose) {
                D.setFieldError(rowControl(row, 'purpose'), 'Select the purpose.');
                ok = false;
            } else if (ENQUIRY_PURPOSES.indexOf(data.purpose) === -1) {
                D.setFieldError(rowControl(row, 'purpose'), 'Select a valid purpose.');
                ok = false;
            }
            if (!data.status) {
                D.setFieldError(rowControl(row, 'status'), 'Select the outcome.');
                ok = false;
            } else if (ENQUIRY_STATUSES.indexOf(data.status) === -1) {
                D.setFieldError(rowControl(row, 'status'), 'Select a valid outcome.');
                ok = false;
            }
        });
        return ok;
    }

    /* ------------------------------------------------------------------ *
     * Document checklist
     * ------------------------------------------------------------------ */

    function buildChecklist() {
        var occupation = value('creditOccupation');
        var service = value('creditServiceType');
        var accounts = collectAccounts();
        var existingReport = checked('creditExistingReport');
        var settlement = value('creditSettlementHistory') === 'Yes';
        var overdue = value('creditOverdueAccounts') === 'Yes';
        var hasCreditCard = accounts.some(function (account) { return account.account_type === 'Credit Card'; });
        var hasClosed = accounts.some(function (account) {
            return account.account_status === 'Closed' || account.account_status === 'Settled' || account.account_status === 'Written Off';
        });
        var hasOverdue = overdue || accounts.some(function (account) { return account.account_status === 'Overdue'; });
        var hasSettlement = settlement || accounts.some(function (account) {
            return account.account_status === 'Settled' || account.account_status === 'Written Off';
        });
        var reportService = ['Credit Report Assistance', 'Credit Report Review', 'Credit Profile Analysis', 'Credit Improvement Guidance'].indexOf(service) !== -1;
        var needsReport = existingReport || reportService || checked('creditNeedsReportHelp');

        var identity = ['PAN Card', 'Aadhaar Card', 'Address Proof', 'Photograph'];
        var credit = [];
        if (needsReport) { addIfUnique(credit, 'Credit Report'); }
        if (hasCreditCard) { addIfUnique(credit, 'Credit Card Statement'); }
        if (hasOverdue || value('creditEnquiryConcerns') !== '') { addIfUnique(credit, 'Bureau Correspondence'); }
        if (hasClosed) { addIfUnique(credit, 'No Dues Certificate'); }
        if (hasSettlement) { addIfUnique(credit, 'Settlement Letter'); }
        if (!credit.length) { addIfUnique(credit, 'Credit Report'); }

        var income;
        if (occupation === 'Salaried') {
            income = ['Salary Slips', 'Form 16', 'Bank Statement'];
        } else if (occupation === 'Self-employed professional' || occupation === 'Business owner') {
            income = ['ITR', 'Financial Statements', 'Bank Statement'];
        } else {
            income = ['Income Proof', 'Bank Statement'];
        }

        var loanDocs = [];
        if (accounts.length > 0) {
            loanDocs = ['Loan Statement', 'Sanction Letter', 'Repayment History'];
        }

        var groups = [
            { title: 'Identity & KYC', items: identity },
            { title: 'Credit profile', items: credit },
            { title: 'Income', items: income }
        ];
        if (loanDocs.length) { groups.push({ title: 'Loan documents', items: loanDocs }); }
        groups.push({ title: 'Other', items: ['Other'] });

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
        el('creditDocChecklist').innerHTML = groups.map(function (group) {
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
        var requirement = payload.requirement;
        var profile = payload.credit_profile;
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
                reviewRow('PAN', maskPan(personal.pan_number)),
                reviewRow('Occupation', personal.occupation),
                reviewRow('Annual income', personal.annual_income !== null ? money(personal.annual_income) : '\u2014'),
                reviewRow('Address', fullAddress(personal.address_line, personal.address_city,
                    personal.address_district, personal.address_state, personal.address_pincode))
            ]
        });

        var requirementRows = [
            reviewRow('Primary service', requirement.service_type),
            reviewRow('Bureau preference', requirement.bureau_preference),
            reviewRow('Current score', requirement.current_score !== null ? requirement.current_score : 'Not provided'),
            reviewRow('Score date', requirement.current_score_date),
            reviewRow('Score source', requirement.score_source),
            reviewRow('Target loan', requirement.target_loan_type),
            reviewRow('Expected amount', requirement.target_loan_amount !== null ? money(requirement.target_loan_amount) : '\u2014'),
            reviewRow('Preferred lender', requirement.target_lender),
            reviewRow('Timeline', requirement.target_timeline),
            reviewRow('Concerns', requirement.concerns)
        ];
        var support = [];
        if (requirement.needs_report_help) { support.push('Report help'); }
        if (requirement.needs_profile_analysis) { support.push('Profile analysis'); }
        if (requirement.needs_improvement_guidance) { support.push('Improvement guidance'); }
        if (requirement.needs_eligibility_assessment) { support.push('Eligibility assessment'); }
        requirementRows.push(reviewRow('Additional support', support.join(', ') || 'None selected'));
        blocks.push({ step: 1, title: 'Requirement & target loan', rows: requirementRows });

        var profileRows = [
            reviewRow('Profile status', profile.profile_status),
            reviewRow('Running loans / cards', profile.running_loans_count),
            reviewRow('Total outstanding', profile.total_outstanding !== null ? money(profile.total_outstanding) : '\u2014'),
            reviewRow('Total monthly EMI', profile.total_emi !== null ? money(profile.total_emi) : '\u2014'),
            reviewRow('Overdue accounts', profile.overdue_accounts),
            reviewRow('Overdue details', profile.overdue_details),
            reviewRow('Settlement / write-off', profile.settlement_history),
            reviewRow('Settlement details', profile.settlement_details),
            reviewRow('Existing report', profile.existing_report_available ? 'Yes' : 'No')
        ];
        if (profile.existing_report_available) {
            profileRows.push(reviewRow('Report date', profile.existing_report_date));
            profileRows.push(reviewRow('Report source', profile.existing_report_source));
        }
        blocks.push({ step: 2, title: 'Existing credit profile', rows: profileRows });

        var accountRows = [];
        if (!payload.accounts.length) {
            accountRows.push(reviewRow('Accounts', 'None added'));
        } else {
            payload.accounts.forEach(function (account, index) {
                var summary = [
                    account.account_type,
                    account.lender_name,
                    account.account_reference_last4 ? 'ref ' + account.account_reference_last4 : '',
                    account.account_status
                ].filter(Boolean).join(' \u00b7 ');
                accountRows.push(reviewRow('Account ' + (index + 1), summary));
                var amounts = [];
                if (account.outstanding_amount !== null) { amounts.push('Outstanding ' + money(account.outstanding_amount)); }
                if (account.emi_amount !== null) { amounts.push('EMI ' + money(account.emi_amount)); }
                if (account.overdue_amount !== null) { amounts.push('Overdue ' + money(account.overdue_amount)); }
                if (account.days_past_due !== null) { amounts.push(account.days_past_due + ' days past due'); }
                if (amounts.length) { accountRows.push(reviewRow('Amounts', amounts.join(' \u00b7 '))); }
                if (account.opened_date || account.closed_date) {
                    accountRows.push(reviewRow('Dates', [account.opened_date ? 'Opened ' + account.opened_date : '', account.closed_date ? 'Closed ' + account.closed_date : ''].filter(Boolean).join(' \u00b7 ')));
                }
                if (account.remarks) { accountRows.push(reviewRow('Remarks', account.remarks)); }
            });
        }
        blocks.push({ step: 2, title: 'Accounts to review', rows: accountRows });

        var enquiryRows = [];
        if (!payload.enquiries.length) {
            enquiryRows.push(reviewRow('Enquiries', 'None added'));
        } else {
            payload.enquiries.forEach(function (enquiry, index) {
                enquiryRows.push(reviewRow('Enquiry ' + (index + 1), [
                    enquiry.bureau,
                    enquiry.institution_name,
                    enquiry.enquiry_date,
                    enquiry.purpose,
                    enquiry.status
                ].filter(Boolean).join(' \u00b7 ')));
                if (enquiry.remarks) { enquiryRows.push(reviewRow('Remarks', enquiry.remarks)); }
            });
        }
        enquiryRows.push(reviewRow('Other concerns', value('creditEnquiryConcerns')));
        blocks.push({ step: 3, title: 'Recent credit enquiries', rows: enquiryRows });

        var checklist = buildChecklist();
        blocks.push({
            step: 4,
            title: 'Document checklist',
            rows: checklist.map(function (group) {
                return reviewRow(group.title, group.items.join(', '));
            })
        });

        el('creditReviewSummary').innerHTML =
            '<div class="cp-info-box"><strong>This is a credit advisory request</strong><p>Submitting this form does not increase your credit score, remove a genuine default or late payment, guarantee a bureau outcome or approve a loan. A bureau report is obtained only with your consent and through an authorised bureau process. The bureau, lender and their policies decide those outcomes.</p></div>' +
            blocks.map(function (block) {
                return '<div class="cp-review-block">' +
                    '<h4><span>' + D.escapeHtml(block.title) + '</span>' +
                    '<button type="button" data-goto="' + block.step + '">Edit</button></h4>' +
                    block.rows.join('') +
                    '</div>';
            }).join('');
    }

    el('creditReviewSummary').addEventListener('click', function (event) {
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
                applicant_name: value('creditApplicantName'),
                date_of_birth: value('creditDob'),
                gender: value('creditGender'),
                mobile: D.digits(value('creditMobile')),
                email: value('creditEmail'),
                pan_number: value('creditPan').toUpperCase(),
                occupation: value('creditOccupation'),
                annual_income: numOrNull(value('creditAnnualIncome')),
                address_line: value('creditAddressLine'),
                address_city: value('creditAddressCity'),
                address_district: value('creditAddressDistrict'),
                address_state: value('creditAddressState'),
                address_pincode: D.digits(value('creditAddressPincode'))
            },
            requirement: {
                service_type: value('creditServiceType'),
                bureau_preference: value('creditBureauPreference'),
                needs_report_help: checked('creditNeedsReportHelp'),
                needs_profile_analysis: checked('creditNeedsProfileAnalysis'),
                needs_improvement_guidance: checked('creditNeedsImprovementGuidance'),
                needs_eligibility_assessment: checked('creditNeedsEligibilityAssessment'),
                current_score: numOrNull(value('creditCurrentScore')),
                current_score_date: dateOrNull(value('creditCurrentScoreDate')),
                score_source: value('creditScoreSource'),
                target_loan_type: value('creditTargetLoanType'),
                target_loan_amount: numOrNull(value('creditTargetLoanAmount')),
                target_lender: value('creditTargetLender'),
                target_timeline: value('creditTargetTimeline'),
                concerns: value('creditConcerns')
            },
            credit_profile: {
                profile_status: value('creditProfileStatus'),
                running_loans_count: numOrNull(value('creditRunningLoans')),
                total_outstanding: numOrNull(value('creditTotalOutstanding')),
                total_emi: numOrNull(value('creditTotalEmi')),
                overdue_accounts: value('creditOverdueAccounts'),
                overdue_details: value('creditOverdueDetails'),
                settlement_history: value('creditSettlementHistory'),
                settlement_details: value('creditSettlementDetails'),
                existing_report_available: checked('creditExistingReport'),
                existing_report_date: dateOrNull(value('creditExistingReportDate')),
                existing_report_source: value('creditExistingReportSource')
            },
            accounts: collectAccounts(),
            enquiries: collectEnquiries(),
            declarations: {
                accuracy: checked('creditAccuracyDeclaration'),
                bureau_authorisation: checked('creditBureauAuthorisation'),
                no_guarantee: checked('creditNoGuaranteeDeclaration')
            },
            consent: checked('creditApplicationConsent'),
            consent_version: CONSENT_VERSION,
            source_page: 'credit-health-apply.html'
        };
    }

    function draftSafePayload() {
        var payload = buildPayload();
        if (payload.personal) { payload.personal.pan_number = ''; }
        if (payload.accounts) {
            payload.accounts.forEach(function (account) {
                account.account_reference_last4 = '';
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

    function validateDate(id, label, required) {
        var raw = value(id);
        if (raw === '') {
            if (required) {
                D.setFieldError(el(id), 'Enter ' + label + '.');
                return false;
            }
            return true;
        }
        if (raw > todayIso()) {
            D.setFieldError(el(id), label + ' cannot be in the future.');
            return false;
        }
        return true;
    }

    function validateStep(index) {
        var ok = true;

        if (index === 0) {
            if (!requireField('creditApplicantName', 'Enter the applicant name.')) { ok = false; }
            var dob = value('creditDob');
            if (!dob) {
                D.setFieldError(el('creditDob'), 'Enter the date of birth.');
                ok = false;
            } else {
                var age = ageFromDob(dob);
                if (age === null || age < 18 || age > 100) {
                    D.setFieldError(el('creditDob'), 'The applicant must be at least 18 years old.');
                    ok = false;
                }
            }
            if (!MOBILE_RE.test(D.digits(value('creditMobile')))) {
                D.setFieldError(el('creditMobile'), 'Enter a valid 10-digit Indian mobile number.');
                ok = false;
            }
            if (!EMAIL_RE.test(value('creditEmail'))) {
                D.setFieldError(el('creditEmail'), 'Enter a valid email address.');
                ok = false;
            }
            var pan = value('creditPan').toUpperCase();
            if (!pan) {
                D.setFieldError(el('creditPan'), 'Enter the PAN.');
                ok = false;
            } else if (!PAN_RE.test(pan)) {
                D.setFieldError(el('creditPan'), 'Enter a valid PAN (e.g. ABCDE1234F).');
                ok = false;
            }
            if (!requireField('creditOccupation', 'Select the occupation.')) { ok = false; }
            if (!validateAmount('creditAnnualIncome', 'annual income', true)) { ok = false; }
            if (!requireField('creditAddressLine', 'Enter the residential address.')) { ok = false; }
            if (!requireField('creditAddressCity', 'Enter the city or town.')) { ok = false; }
            if (!requireField('creditAddressState', 'Select the state.')) { ok = false; }
            if (!PIN_RE.test(D.digits(value('creditAddressPincode')))) {
                D.setFieldError(el('creditAddressPincode'), 'Enter a valid 6-digit PIN code.');
                ok = false;
            }
        }

        if (index === 1) {
            if (!requireField('creditServiceType', 'Select the primary service.')) { ok = false; }
            if (!requireField('creditBureauPreference', 'Select the bureau preference.')) { ok = false; }
            var scoreRaw = value('creditCurrentScore');
            if (scoreRaw !== '') {
                var score = Number(scoreRaw);
                if (isNaN(score) || Math.floor(score) !== score || score < 300 || score > 900) {
                    D.setFieldError(el('creditCurrentScore'), 'A credit score must be a whole number between 300 and 900, or left blank.');
                    ok = false;
                }
            }
            if (!validateDate('creditCurrentScoreDate', 'The score date', false)) { ok = false; }
            if (!validateAmount('creditTargetLoanAmount', 'the expected loan amount', false)) { ok = false; }
        }

        if (index === 2) {
            if (!requireField('creditProfileStatus', 'Select the credit profile status.')) { ok = false; }
            if (!validateCount('creditRunningLoans', 'the number of running loans / cards', 0, 50)) { ok = false; }
            if (!validateAmount('creditTotalOutstanding', 'the total outstanding amount', false)) { ok = false; }
            if (!validateAmount('creditTotalEmi', 'the total monthly EMI', false)) { ok = false; }
            if (!requireField('creditOverdueAccounts', 'Confirm whether any account is overdue.')) { ok = false; }
            if (value('creditOverdueAccounts') === 'Yes' && !requireField('creditOverdueDetails', 'Describe the overdue accounts.')) { ok = false; }
            if (!requireField('creditSettlementHistory', 'Confirm whether there is a settlement or write-off history.')) { ok = false; }
            if (value('creditSettlementHistory') === 'Yes' && !requireField('creditSettlementDetails', 'Describe the settlement or write-off history.')) { ok = false; }
            if (checked('creditExistingReport')) {
                if (!validateDate('creditExistingReportDate', 'the existing report date', true)) { ok = false; }
            }
            if (!validateAccounts()) { ok = false; }
        }

        if (index === 3) {
            if (!validateEnquiries()) { ok = false; }
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
                    D.escapeHtml(resumeLink()) + '</code>. For your security, PAN and account last-4 references are not stored in drafts; re-enter them when you resume.';
            }
            D.showAlert(alertBox, 'success',
                'Your credit health application has been saved. Bookmark this page or keep the resume link to continue later. PAN and account last-4 references are not stored in drafts and must be re-entered when you resume.',
                'Draft saved');
        } catch (err) {
            console.error('Credit health draft save failed:', err);
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
                D.escapeHtml(resumeLink()) + '</code>. PAN and account last-4 references are not stored in drafts; please re-enter them.';
        }
    }

    function applyPayload(payload) {
        var personal = payload.personal || {};
        var requirement = payload.requirement || {};
        var profile = payload.credit_profile || {};
        var declarations = payload.declarations || {};

        el('creditApplicantName').value = personal.applicant_name || '';
        el('creditDob').value = personal.date_of_birth || '';
        el('creditGender').value = personal.gender || '';
        el('creditMobile').value = personal.mobile || '';
        el('creditEmail').value = personal.email || '';
        el('creditPan').value = personal.pan_number || '';
        el('creditOccupation').value = personal.occupation || '';
        el('creditAnnualIncome').value = personal.annual_income !== null && personal.annual_income !== undefined ? personal.annual_income : '';
        el('creditAddressLine').value = personal.address_line || '';
        el('creditAddressCity').value = personal.address_city || '';
        el('creditAddressDistrict').value = personal.address_district || '';
        setSelectValue('creditAddressState', personal.address_state || '');
        el('creditAddressPincode').value = personal.address_pincode || '';

        el('creditServiceType').value = requirement.service_type || '';
        el('creditBureauPreference').value = requirement.bureau_preference || '';
        el('creditNeedsReportHelp').checked = !!requirement.needs_report_help;
        el('creditNeedsProfileAnalysis').checked = !!requirement.needs_profile_analysis;
        el('creditNeedsImprovementGuidance').checked = !!requirement.needs_improvement_guidance;
        el('creditNeedsEligibilityAssessment').checked = !!requirement.needs_eligibility_assessment;
        el('creditCurrentScore').value = requirement.current_score !== null && requirement.current_score !== undefined ? requirement.current_score : '';
        el('creditCurrentScoreDate').value = requirement.current_score_date || '';
        el('creditScoreSource').value = requirement.score_source || '';
        el('creditTargetLoanType').value = requirement.target_loan_type || '';
        el('creditTargetLoanAmount').value = requirement.target_loan_amount !== null && requirement.target_loan_amount !== undefined ? requirement.target_loan_amount : '';
        el('creditTargetLender').value = requirement.target_lender || '';
        el('creditTargetTimeline').value = requirement.target_timeline || '';
        el('creditConcerns').value = requirement.concerns || '';

        el('creditProfileStatus').value = profile.profile_status || '';
        el('creditRunningLoans').value = profile.running_loans_count !== null && profile.running_loans_count !== undefined ? profile.running_loans_count : 0;
        el('creditTotalOutstanding').value = profile.total_outstanding !== null && profile.total_outstanding !== undefined ? profile.total_outstanding : '';
        el('creditTotalEmi').value = profile.total_emi !== null && profile.total_emi !== undefined ? profile.total_emi : '';
        el('creditOverdueAccounts').value = profile.overdue_accounts || '';
        el('creditOverdueDetails').value = profile.overdue_details || '';
        el('creditSettlementHistory').value = profile.settlement_history || '';
        el('creditSettlementDetails').value = profile.settlement_details || '';
        el('creditExistingReport').checked = !!profile.existing_report_available;
        el('creditExistingReportDate').value = profile.existing_report_date || '';
        el('creditExistingReportSource').value = profile.existing_report_source || '';

        clearRepeatList(accountsList, 'No credit accounts added yet. Add a loan or credit card if you have one, or continue if you have none.');
        (payload.accounts || []).forEach(function (account) { addAccountRow(account); });

        clearRepeatList(enquiriesList, 'No enquiries added yet. Add an application you remember, or continue if you are not sure.');
        (payload.enquiries || []).forEach(function (enquiry) { addEnquiryRow(enquiry); });

        el('creditAccuracyDeclaration').checked = !!declarations.accuracy;
        el('creditBureauAuthorisation').checked = !!declarations.bureau_authorisation;
        el('creditNoGuaranteeDeclaration').checked = !!declarations.no_guarantee;
        el('creditApplicationConsent').checked = !!payload.consent;

        syncConditionals();
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
        clearRepeatList(accountsList, 'No credit accounts added yet. Add a loan or credit card if you have one, or continue if you have none.');
        clearRepeatList(enquiriesList, 'No enquiries added yet. Add an application you remember, or continue if you are not sure.');
        if (draftBar) { draftBar.classList.add('cp-hidden'); }
        D.clearErrors(form);
        D.hideAlert(alertBox);
        maxStep = 0;
        syncConditionals();
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
                D.notify('success', 'Draft restored', 'Your saved credit health application has been loaded.');
                return;
            } catch (err) {
                console.warn('Failed to resume credit health draft from link:', err);
                D.showAlert(alertBox, 'warning',
                    'The resume link could not be loaded. ' + D.friendlyError(err),
                    'Draft unavailable');
            }
        }
        if (readStoredDraft() && draftBar) {
            draftBar.classList.remove('cp-hidden');
            draftBarText.textContent = 'We found a saved draft of your credit health application on this device.';
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
            console.warn('Background credit health draft save failed:', err);
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

        if (!checked('creditAccuracyDeclaration')) {
            D.showAlert(alertBox, 'warning',
                'Please confirm that the information provided is true, complete and accurate, including your credit accounts, EMIs, overdue amounts, settlement history and enquiries.',
                'Declaration required');
            el('creditAccuracyDeclaration').focus();
            return;
        }
        if (!checked('creditBureauAuthorisation')) {
            D.showAlert(alertBox, 'warning',
                'Please authorise Dhanvi Finserv and the selected bureau to obtain or review your credit information for this advisory service.',
                'Bureau authorisation required');
            el('creditBureauAuthorisation').focus();
            return;
        }
        if (!checked('creditNoGuaranteeDeclaration')) {
            D.showAlert(alertBox, 'warning',
                'Please confirm that you understand no score increase or loan approval is guaranteed.',
                'No-guarantee confirmation required');
            el('creditNoGuaranteeDeclaration').focus();
            return;
        }
        if (!checked('creditApplicationConsent')) {
            D.showAlert(alertBox, 'warning',
                'Please accept the privacy notice and credit advisory consent before submitting.',
                'Consent required');
            el('creditApplicationConsent').focus();
            return;
        }

        var payload = buildPayload();
        D.setLoading(submitBtn, true, 'Submitting application\u2026');
        try {
            var result = await D.rpc('submit_credit_health_application', {
                p_payload: payload,
                p_draft_id: draftId,
                p_draft_token: draftToken
            });
            clearStoredDraft();
            showSuccess(result);
        } catch (err) {
            console.error('Credit health submission failed:', err);
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
            'Your credit health request has been received. Reference: ' +
            (result.reference_no || '\u2014') + '. This is not a score increase, a credit repair guarantee or a loan approval.',
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
     * Repeat-row actions
     * ------------------------------------------------------------------ */

    el('addCreditAccountBtn').addEventListener('click', function () {
        var row = addAccountRow();
        var first = row.querySelector('[data-field="account_type"]');
        if (first) { first.focus(); }
    });

    el('addCreditEnquiryBtn').addEventListener('click', function () {
        var row = addEnquiryRow();
        var first = row.querySelector('[data-field="bureau"]');
        if (first) { first.focus(); }
    });

    function bindRemoveHandler(list, message) {
        list.addEventListener('click', function (event) {
            var button = event.target.closest('.credit-repeat-remove');
            if (!button) { return; }
            var row = button.closest('.credit-repeat-row');
            if (row) { row.remove(); }
            updateListEmpty(list, message);
        });
    }

    bindRemoveHandler(accountsList, 'No credit accounts added yet. Add a loan or credit card if you have one, or continue if you have none.');
    bindRemoveHandler(enquiriesList, 'No enquiries added yet. Add an application you remember, or continue if you are not sure.');

    /* ------------------------------------------------------------------ *
     * Live bindings
     * ------------------------------------------------------------------ */

    form.addEventListener('input', function (event) {
        if (event.target.classList.contains('form-control')) {
            D.clearFieldError(event.target);
        }
        if (event.target.id === 'creditPan') {
            event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
        }
        if (event.target.id === 'creditMobile') {
            event.target.value = D.digits(event.target.value).slice(0, 10);
        }
        if (event.target.id === 'creditAddressPincode') {
            event.target.value = D.digits(event.target.value).slice(0, 6);
        }
        if (event.target.getAttribute('data-field') === 'account_reference_last4') {
            event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
        }
    });

    form.addEventListener('change', function (event) {
        if (event.target.classList.contains('form-control')) {
            D.clearFieldError(event.target);
        }
        if (event.target.id === 'creditOverdueAccounts') { syncOverdue(); }
        if (event.target.id === 'creditSettlementHistory') { syncSettlement(); }
        if (event.target.id === 'creditExistingReport') { syncExistingReport(); }
    });

    /* ------------------------------------------------------------------ *
     * Boot
     * ------------------------------------------------------------------ */

    function boot() {
        initOptions();
        clearRepeatList(accountsList, 'No credit accounts added yet. Add a loan or credit card if you have one, or continue if you have none.');
        clearRepeatList(enquiriesList, 'No enquiries added yet. Add an application you remember, or continue if you are not sure.');
        syncConditionals();
        showStep(0, false);
        initDraft();
    }

    boot();
})(window, document);

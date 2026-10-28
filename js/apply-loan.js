/**
 * Dhanvi Finserv - loan application with NRI / co-applicant / guarantor support.
 * Depends on: js/nhost-client.js, js/public-api.js
 */
(function (window, document) {
    'use strict';

    var D = window.Dhanvi;
    var form = document.getElementById('loanApplicationForm');
    if (!form || !D) { return; }

    var alertBox = document.getElementById('applicationAlert');
    var submitBtn = document.getElementById('applicationSubmitBtn');
    var successBox = document.getElementById('applicationSuccess');
    var resetBtn = document.getElementById('resetFormBtn');
    var nriFields = document.getElementById('nriFields');
    var coList = document.getElementById('coApplicantList');
    var guarList = document.getElementById('guarantorList');
    var addCoBtn = document.getElementById('addCoApplicant');
    var addGuarBtn = document.getElementById('addGuarantor');
    var mobileInput = document.getElementById('mobileNumber');

    var coCount = 0;
    var guarCount = 0;
    var coSeq = 0;
    var guarSeq = 0;
    var MAX_CO = 3;
    var MAX_GUAR = 2;

    var RELATIONSHIPS = ['Spouse', 'Parent', 'Sibling', 'Son', 'Daughter', 'Business partner', 'Friend', 'Other'];
    var EMPLOYMENT = ['Salaried', 'Self-employed / business', 'Professional', 'Retired', 'Student', 'Other'];
    var COUNTRIES = ['United Arab Emirates', 'United States', 'United Kingdom', 'Canada', 'Australia', 'Singapore', 'Saudi Arabia', 'Qatar', 'Oman', 'Kuwait', 'New Zealand', 'Other'];
    var RESIDENCY = ['NRI', 'PIO', 'OCI', 'Foreign national'];
    var CURRENCIES = ['INR', 'USD', 'GBP', 'AED', 'CAD', 'AUD', 'SGD', 'EUR'];

    function optionList(values) {
        return values.map(function (value) {
            return '<option value="' + D.escapeHtml(value) + '">' + D.escapeHtml(value) + '</option>';
        }).join('');
    }

    function primaryType() {
        var checked = form.querySelector('input[name="applicantType"]:checked');
        return checked ? checked.value : 'resident';
    }

    function syncPrimaryType() {
        var nri = primaryType() === 'nri';
        nriFields.classList.toggle('cp-hidden', !nri);
        if (nri) {
            mobileInput.removeAttribute('maxlength');
            mobileInput.removeAttribute('pattern');
            mobileInput.placeholder = 'Include country code, e.g. +971 50 123 4567';
        } else {
            mobileInput.setAttribute('maxlength', '10');
            mobileInput.setAttribute('pattern', '[6-9][0-9]{9}');
            mobileInput.placeholder = 'Enter 10-digit mobile number';
        }
        ['countryOfResidence', 'residencyStatus', 'employmentType'].forEach(function (id) {
            var field = document.getElementById(id);
            if (field) {
                field.required = nri;
            }
        });
    }

    function applicantTemplate(role, index, seq) {
        var isCo = role === 'co_applicant';
        var prefix = (isCo ? 'co' : 'guar') + (seq || index);
        var title = (isCo ? 'Co-applicant ' : 'Guarantor ') + index;

        return '' +
            '<div class="cp-applicant" data-role="' + role + '" data-prefix="' + prefix + '">' +
                '<div class="cp-applicant-head">' +
                    '<h4>' + title + '</h4>' +
                    '<button type="button" class="cp-remove" data-remove="' + role + '">' +
                        '<i class="fa fa-trash-o"></i> Remove' +
                    '</button>' +
                '</div>' +
                '<div class="cp-grid">' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Name">Full name <span class="cp-req">*</span></label>' +
                        '<input type="text" class="form-control" id="' + prefix + 'Name" data-field="full_name" placeholder="Enter full name">' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Relationship">Relationship to primary applicant <span class="cp-req">*</span></label>' +
                        '<select class="form-control" id="' + prefix + 'Relationship" data-field="relationship">' +
                            '<option value="">Select relationship</option>' + optionList(RELATIONSHIPS) +
                        '</select>' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label>Applicant type</label>' +
                        '<div class="cp-toggle-row" style="margin-bottom:0;">' +
                            '<label class="cp-toggle"><input type="radio" name="' + prefix + '_type" data-field="applicant_type" value="resident" checked><span>Resident</span></label>' +
                            '<label class="cp-toggle"><input type="radio" name="' + prefix + '_type" data-field="applicant_type" value="nri"><span>NRI</span></label>' +
                        '</div>' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Mobile">Mobile / phone <span class="cp-req">*</span></label>' +
                        '<input type="tel" class="form-control" id="' + prefix + 'Mobile" data-field="mobile" placeholder="Enter phone number">' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Email">Email</label>' +
                        '<input type="email" class="form-control" id="' + prefix + 'Email" data-field="email" placeholder="Enter email address">' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Dob">Date of birth</label>' +
                        '<input type="date" class="form-control" id="' + prefix + 'Dob" data-field="date_of_birth">' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Employment">Employment type <span class="cp-req">*</span></label>' +
                        '<select class="form-control" id="' + prefix + 'Employment" data-field="employment_type">' +
                            '<option value="">Select employment</option>' + optionList(EMPLOYMENT) +
                        '</select>' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Employer">Employer / business name</label>' +
                        '<input type="text" class="form-control" id="' + prefix + 'Employer" data-field="employer_name" placeholder="Optional">' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Income">Monthly income <span class="cp-req">*</span></label>' +
                        '<input type="number" class="form-control" id="' + prefix + 'Income" data-field="monthly_income" min="0" step="1000" placeholder="e.g. 75000">' +
                    '</div></div>' +
                    '<div class="cp-col-4 cp-nri-extra cp-hidden"><div class="cp-field">' +
                        '<label for="' + prefix + 'Country">Country of residence <span class="cp-req">*</span></label>' +
                        '<select class="form-control" id="' + prefix + 'Country" data-field="country_of_residence">' +
                            '<option value="">Select country</option>' + optionList(COUNTRIES) +
                        '</select>' +
                    '</div></div>' +
                    '<div class="cp-col-4 cp-nri-extra cp-hidden"><div class="cp-field">' +
                        '<label for="' + prefix + 'Residency">Residency status <span class="cp-req">*</span></label>' +
                        '<select class="form-control" id="' + prefix + 'Residency" data-field="residency_status">' +
                            '<option value="">Select status</option>' + optionList(RESIDENCY) +
                        '</select>' +
                    '</div></div>' +
                    '<div class="cp-col-4"><div class="cp-field">' +
                        '<label for="' + prefix + 'Currency">Income currency</label>' +
                        '<select class="form-control" id="' + prefix + 'Currency" data-field="income_currency">' +
                            optionList(CURRENCIES) +
                        '</select>' +
                    '</div></div>' +
                '</div>' +
            '</div>';
    }

    function updateAddButtons() {
        if (addCoBtn) {
            addCoBtn.disabled = coCount >= MAX_CO;
            addCoBtn.innerHTML = '<i class="fa fa-plus"></i> Add co-applicant' + (coCount >= MAX_CO ? ' (max ' + MAX_CO + ')' : '');
        }
        if (addGuarBtn) {
            addGuarBtn.disabled = guarCount >= MAX_GUAR;
            addGuarBtn.innerHTML = '<i class="fa fa-plus"></i> Add guarantor' + (guarCount >= MAX_GUAR ? ' (max ' + MAX_GUAR + ')' : '');
        }
    }

    function renumber(container, role) {
        var cards = container.querySelectorAll('.cp-applicant');
        Array.prototype.forEach.call(cards, function (card, index) {
            var heading = card.querySelector('.cp-applicant-head h4');
            if (heading) {
                heading.textContent = (role === 'co_applicant' ? 'Co-applicant ' : 'Guarantor ') + (index + 1);
            }
        });
    }

    function syncCardType(card) {
        var checked = card.querySelector('input[data-field="applicant_type"]:checked');
        var isNri = checked && checked.value === 'nri';
        Array.prototype.forEach.call(card.querySelectorAll('.cp-nri-extra'), function (el) {
            el.classList.toggle('cp-hidden', !isNri);
        });
        var mobile = card.querySelector('[data-field="mobile"]');
        if (mobile) {
            mobile.placeholder = isNri ? 'Include country code' : 'Enter 10-digit mobile number';
        }
    }

    if (addCoBtn) {
        addCoBtn.addEventListener('click', function () {
            if (coCount >= MAX_CO) { return; }
            coCount += 1;
            coSeq += 1;
            coList.insertAdjacentHTML('beforeend', applicantTemplate('co_applicant', coCount, coSeq));
            var card = coList.lastElementChild;
            syncCardType(card);
            updateAddButtons();
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
    }

    if (addGuarBtn) {
        addGuarBtn.addEventListener('click', function () {
            if (guarCount >= MAX_GUAR) { return; }
            guarCount += 1;
            guarSeq += 1;
            guarList.insertAdjacentHTML('beforeend', applicantTemplate('guarantor', guarCount, guarSeq));
            var card = guarList.lastElementChild;
            syncCardType(card);
            updateAddButtons();
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
            if (role === 'co_applicant') {
                coCount = Math.max(0, coCount - 1);
                renumber(coList, 'co_applicant');
            } else {
                guarCount = Math.max(0, guarCount - 1);
                renumber(guarList, 'guarantor');
            }
            updateAddButtons();
        });

        container.addEventListener('change', function (event) {
            if (event.target.matches('input[data-field="applicant_type"]')) {
                syncCardType(event.target.closest('.cp-applicant'));
            }
        });
    });

    form.addEventListener('change', function (event) {
        if (event.target.name === 'applicantType') {
            syncPrimaryType();
        }
        if (event.target.classList.contains('form-control')) {
            D.clearFieldError(event.target);
        }
    });

    form.addEventListener('input', function (event) {
        if (event.target.classList.contains('form-control')) {
            D.clearFieldError(event.target);
        }
    });

    function validateApplicantCard(card) {
        var ok = true;
        var name = card.querySelector('[data-field="full_name"]');
        var relationship = card.querySelector('[data-field="relationship"]');
        var mobile = card.querySelector('[data-field="mobile"]');
        var employment = card.querySelector('[data-field="employment_type"]');
        var income = card.querySelector('[data-field="monthly_income"]');
        var typeInput = card.querySelector('input[data-field="applicant_type"]:checked');
        var type = typeInput ? typeInput.value : 'resident';

        if (!name.value.trim()) {
            D.setFieldError(name, 'Enter the full name.');
            ok = false;
        }
        if (!relationship.value) {
            D.setFieldError(relationship, 'Select a relationship.');
            ok = false;
        }
        if (!mobile.value.trim()) {
            D.setFieldError(mobile, 'Enter a phone number.');
            ok = false;
        } else if (type === 'nri' && !D.isInternationalPhone(mobile.value)) {
            D.setFieldError(mobile, 'Enter a valid international phone number.');
            ok = false;
        } else if (type === 'resident' && !D.isIndianMobile(mobile.value)) {
            D.setFieldError(mobile, 'Enter a valid 10-digit Indian mobile number.');
            ok = false;
        }
        if (!employment.value) {
            D.setFieldError(employment, 'Select an employment type.');
            ok = false;
        }
        if (!income.value || Number(income.value) <= 0) {
            D.setFieldError(income, 'Enter a monthly income.');
            ok = false;
        }
        if (type === 'nri') {
            var country = card.querySelector('[data-field="country_of_residence"]');
            var residency = card.querySelector('[data-field="residency_status"]');
            if (!country.value) {
                D.setFieldError(country, 'Select the country of residence.');
                ok = false;
            }
            if (!residency.value) {
                D.setFieldError(residency, 'Select the residency status.');
                ok = false;
            }
        }
        return ok;
    }

    function collectApplicant(card) {
        var data = {};
        Array.prototype.forEach.call(card.querySelectorAll('[data-field]'), function (input) {
            var key = input.getAttribute('data-field');
            if (input.type === 'radio') {
                if (input.checked) { data[key] = input.value; }
            } else {
                data[key] = input.value.trim();
            }
        });
        return data;
    }

    function validatePrimary() {
        var ok = true;
        var fullName = document.getElementById('fullName');
        var email = document.getElementById('emailAddress');
        var loanType = document.getElementById('loanType');
        var loanAmount = document.getElementById('loanAmount');
        var type = primaryType();

        if (!fullName.value.trim()) {
            D.setFieldError(fullName, 'Enter your full name.');
            ok = false;
        }
        if (!mobileInput.value.trim()) {
            D.setFieldError(mobileInput, 'Enter your phone number.');
            ok = false;
        } else if (type === 'nri' && !D.isInternationalPhone(mobileInput.value)) {
            D.setFieldError(mobileInput, 'Enter a valid international phone number.');
            ok = false;
        } else if (type === 'resident' && !D.isIndianMobile(mobileInput.value)) {
            D.setFieldError(mobileInput, 'Enter a valid 10-digit Indian mobile number.');
            ok = false;
        }
        if (!D.isEmail(email.value)) {
            D.setFieldError(email, 'Enter a valid email address.');
            ok = false;
        }
        if (!loanType.value) {
            D.setFieldError(loanType, 'Select a loan type.');
            ok = false;
        }
        if (!loanAmount.value || Number(loanAmount.value) < 10000) {
            D.setFieldError(loanAmount, 'Enter an amount of at least ₹10,000.');
            ok = false;
        }
        if (type === 'nri') {
            ['countryOfResidence', 'residencyStatus', 'employmentType'].forEach(function (id) {
                var field = document.getElementById(id);
                if (field && !field.value) {
                    D.setFieldError(field, 'This field is required for NRI applicants.');
                    ok = false;
                }
            });
        }
        return ok;
    }

    function validateConsent() {
        var consent = document.getElementById('applicationConsent');
        if (consent && !consent.checked) {
            D.showAlert(alertBox, 'error', 'Please accept the privacy notice and consent to be contacted before submitting.');
            consent.focus();
            return false;
        }
        return true;
    }

    function focusFirstError() {
        var first = form.querySelector('.is-invalid');
        if (first) {
            first.scrollIntoView({ behavior: 'smooth', block: 'center' });
            try { first.focus({ preventScroll: true }); } catch (err) { first.focus(); }
        }
    }

    form.addEventListener('submit', async function (event) {
        event.preventDefault();
        D.hideAlert(alertBox);
        D.clearErrors(form);

        var valid = validatePrimary();
        var consentOk = validateConsent();

        Array.prototype.forEach.call(coList.querySelectorAll('.cp-applicant'), function (card) {
            if (!validateApplicantCard(card)) { valid = false; }
        });
        Array.prototype.forEach.call(guarList.querySelectorAll('.cp-applicant'), function (card) {
            if (!validateApplicantCard(card)) { valid = false; }
        });

        if (!valid || !consentOk) {
            focusFirstError();
            return;
        }

        var payload = {
            full_name: document.getElementById('fullName').value.trim(),
            mobile: mobileInput.value.trim(),
            email: document.getElementById('emailAddress').value.trim(),
            loan_type: document.getElementById('loanType').value,
            loan_amount: Number(document.getElementById('loanAmount').value),
            message: document.getElementById('message').value.trim(),
            applicant_type: primaryType(),
            country_of_residence: (document.getElementById('countryOfResidence') || {}).value || '',
            residency_status: (document.getElementById('residencyStatus') || {}).value || '',
            employment_type: (document.getElementById('employmentType') || {}).value || '',
            consent: true,
            consent_version: D.CONSENT_VERSION,
            source_page: window.location.pathname,
            co_applicants: Array.prototype.map.call(coList.querySelectorAll('.cp-applicant'), collectApplicant),
            guarantors: Array.prototype.map.call(guarList.querySelectorAll('.cp-applicant'), collectApplicant)
        };

        D.setLoading(submitBtn, true, 'Submitting application…');
        try {
            var result = await D.rpc('submit_loan_application_v2', { p_payload: payload });
            showSuccess(result);
        } catch (err) {
            console.error('Application submission failed:', err);
            D.showAlert(alertBox, 'error', D.escapeHtml(D.friendlyError(err)));
            alertBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } finally {
            D.setLoading(submitBtn, false);
        }
    });

    function showSuccess(result) {
        form.classList.add('cp-hidden');
        successBox.classList.add('show');
        document.getElementById('successReference').textContent = result.reference_no || '—';
        var link = document.getElementById('uploadDocsLink');
        if (link) {
            // Keep the access token in the URL fragment so it is never sent in
            // Referer headers or to the static server.
            link.href = 'upload-documents.html#id=' + encodeURIComponent(result.id) +
                '&token=' + encodeURIComponent(result.access_token) +
                '&ref=' + encodeURIComponent(result.reference_no);
        }
        successBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    if (resetBtn) {
        resetBtn.addEventListener('click', function () {
            form.reset();
            coList.innerHTML = '';
            guarList.innerHTML = '';
            coCount = 0;
            guarCount = 0;
            updateAddButtons();
            syncPrimaryType();
            D.clearErrors(form);
            D.hideAlert(alertBox);
            form.classList.remove('cp-hidden');
            successBox.classList.remove('show');
            form.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
    }

    // Preserve the existing ?amount= prefill behaviour.
    (function prefillAmount() {
        var params = new URLSearchParams(window.location.search);
        var amount = params.get('amount');
        if (amount && Number(amount) > 0) {
            document.getElementById('loanAmount').value = amount;
        }
        var type = params.get('type');
        if (type) {
            var select = document.getElementById('loanType');
            Array.prototype.forEach.call(select.options, function (option) {
                if (option.value.toLowerCase() === type.toLowerCase()) {
                    select.value = option.value;
                }
            });
        }
    })();

    updateAddButtons();
    syncPrimaryType();
})(window, document);

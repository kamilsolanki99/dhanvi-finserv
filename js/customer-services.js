/**
 * Dhanvi Finserv - post-disbursal support and complaint ticket forms.
 * Depends on: js/nhost-client.js, js/public-api.js
 */
(function (window, document) {
    'use strict';

    var D = window.Dhanvi;
    if (!D) { return; }

    function handleForm(config) {
        var form = document.getElementById(config.formId);
        if (!form) { return; }

        var alertBox = document.getElementById(config.alertId);
        var submitBtn = document.getElementById(config.submitId);
        var successBox = document.getElementById(config.successId);
        var resetBtn = document.getElementById(config.resetId);
        var refEl = document.getElementById(config.referenceId);

        form.addEventListener('input', function (event) {
            if (event.target.classList.contains('form-control')) {
                D.clearFieldError(event.target);
            }
        });

        form.addEventListener('submit', async function (event) {
            event.preventDefault();
            D.hideAlert(alertBox);
            D.clearErrors(form);

            var name = document.getElementById(config.nameId);
            var mobile = document.getElementById(config.mobileId);
            var email = document.getElementById(config.emailId);
            var description = document.getElementById(config.descriptionId);
            var consent = document.getElementById(config.consentId);
            var category = document.getElementById(config.categoryId);
            var loanRef = document.getElementById(config.loanRefId);
            var ok = true;

            if (!name.value.trim()) {
                D.setFieldError(name, 'Enter your full name.');
                ok = false;
            }
            if (config.requireLoanRef && !loanRef.value.trim()) {
                D.setFieldError(loanRef, 'Enter your loan account or application reference.');
                ok = false;
            }
            if (D.digits(mobile.value).length < 10 || D.digits(mobile.value).length > 15) {
                D.setFieldError(mobile, 'Enter a valid contact number.');
                ok = false;
            }
            if (email.value.trim() && !D.isEmail(email.value)) {
                D.setFieldError(email, 'Enter a valid email address.');
                ok = false;
            }
            if (category && !category.value) {
                D.setFieldError(category, 'Select an option.');
                ok = false;
            }
            if (description.value.trim().length < config.minDescription) {
                D.setFieldError(description, 'Please provide at least ' + config.minDescription + ' characters.');
                ok = false;
            }
            if (!consent.checked) {
                D.showAlert(
                    alertBox,
                    'warning',
                    'Please accept the privacy notice before submitting.',
                    'Consent required'
                );
                ok = false;
            }
            if (!ok) {
                var first = form.querySelector('.is-invalid');
                if (first) { first.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
                return;
            }

            var params = {
                p_full_name: name.value.trim(),
                p_mobile: mobile.value.trim(),
                p_email: email.value.trim(),
                p_loan_reference_no: loanRef.value.trim(),
                p_description: description.value.trim(),
                p_consent: true
            };
            if (config.categoryId) {
                params.p_category = category.value;
            }
            if (config.requestTypeId) {
                params.p_request_type = document.getElementById(config.requestTypeId).value;
            }

            D.setLoading(submitBtn, true, config.loadingLabel);
            try {
                var result = await D.rpc(config.rpc, params);
                var reference = (config.referenceKey === 'ticket_no' ? result.ticket_no : result.reference_no) || '—';
                form.classList.add('cp-hidden');
                successBox.classList.add('show');
                refEl.textContent = reference;
                D.showAlert(
                    alertBox,
                    'success',
                    'Reference: ' + reference + '. Our team will review your submission and contact you shortly.',
                    config.successTitle || 'Request submitted'
                );
                successBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
            } catch (err) {
                console.error(config.rpc + ' failed:', err);
                D.showAlert(
                    alertBox,
                    'error',
                    D.friendlyError(err),
                    config.errorTitle || 'Submission failed'
                );
            } finally {
                D.setLoading(submitBtn, false);
            }
        });

        if (resetBtn) {
            resetBtn.addEventListener('click', function () {
                form.reset();
                D.clearErrors(form);
                D.hideAlert(alertBox);
                form.classList.remove('cp-hidden');
                successBox.classList.remove('show');
                form.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        }
    }

    handleForm({
        formId: 'postDisbursalForm',
        alertId: 'pdAlert',
        submitId: 'pdSubmit',
        successId: 'pdSuccess',
        resetId: 'pdReset',
        referenceId: 'pdReference',
        nameId: 'pdName',
        mobileId: 'pdMobile',
        emailId: 'pdEmail',
        loanRefId: 'pdLoanRef',
        requestTypeId: 'pdRequestType',
        descriptionId: 'pdDescription',
        consentId: 'pdConsent',
        requireLoanRef: true,
        minDescription: 10,
        loadingLabel: 'Submitting request…',
        rpc: 'submit_post_disbursal_request',
        referenceKey: 'reference_no',
        successTitle: 'Request submitted',
        errorTitle: 'Request not submitted'
    });

    handleForm({
        formId: 'complaintForm',
        alertId: 'complaintAlert',
        submitId: 'complaintSubmit',
        successId: 'complaintSuccess',
        resetId: 'complaintReset',
        referenceId: 'complaintReference',
        nameId: 'complaintName',
        mobileId: 'complaintMobile',
        emailId: 'complaintEmail',
        loanRefId: 'complaintLoanRef',
        categoryId: 'complaintCategory',
        descriptionId: 'complaintDescription',
        consentId: 'complaintConsent',
        minDescription: 20,
        loadingLabel: 'Submitting complaint…',
        rpc: 'submit_complaint',
        referenceKey: 'ticket_no',
        successTitle: 'Complaint registered',
        errorTitle: 'Complaint not registered'
    });
})(window, document);

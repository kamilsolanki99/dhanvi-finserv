/**
 * Dhanvi Finserv - secure customer document upload.
 *
 * Files are uploaded to the PRIVATE Nhost Storage bucket "loan-documents".
 * The browser first opens an anonymous Nhost session, uploads the file, then
 * registers the Nhost file UUID through the server-side register_document
 * function. The bucket has no public URLs; administrators generate short-lived
 * presigned URLs from the admin panel.
 *
 * Document requirements are configurable below. Keep the option values aligned
 * with the allowed list in nhost/migrations/001_init.sql.
 */
(function (window, document) {
    'use strict';

    var D = window.Dhanvi;
    if (!D) { return; }

    var MAX_BYTES = 5 * 1024 * 1024;
    var ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    var ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'webp'];

    var DOCUMENT_REQUIREMENTS = {
        'Home Loan': ['PAN Card', 'Aadhaar Card', 'Salary Slips', 'Bank Statement', 'ITR', 'Property Documents', 'Photograph', 'Other'],
        'Home Loan Top-Up': ['PAN Card', 'Aadhaar Card', 'Salary Slips', 'Bank Statement', 'ITR', 'Property Documents', 'Other'],
        'Home Loan Takeover': ['PAN Card', 'Aadhaar Card', 'Salary Slips', 'Bank Statement', 'ITR', 'Property Documents', 'Other'],
        'Loan Against Property': ['PAN Card', 'Aadhaar Card', 'ITR', 'Bank Statement', 'Business Proof', 'Property Documents', 'Other'],
        'Education Loan': ['PAN Card', 'Aadhaar Card', 'ITR', 'Bank Statement', 'Other'],
        'Vehicle Loan': ['PAN Card', 'Aadhaar Card', 'Salary Slips', 'Bank Statement', 'ITR', 'Vehicle Documents', 'Other'],
        'Business Loan': ['PAN Card', 'Aadhaar Card', 'ITR', 'Bank Statement', 'Business Proof', 'Other'],
        'Personal Loan': ['PAN Card', 'Aadhaar Card', 'Salary Slips', 'Bank Statement', 'ITR', 'Other']
    };

    var DEFAULT_DOCS = ['PAN Card', 'Aadhaar Card', 'Salary Slips', 'ITR', 'Bank Statement', 'Property Documents', 'Business Proof', 'Vehicle Documents', 'Photograph', 'Other'];

    var state = null;

    var lookupForm = document.getElementById('uploadLookupForm');
    var lookupAlert = document.getElementById('lookupAlert');
    var workspace = document.getElementById('uploadWorkspace');
    var summaryEl = document.getElementById('applicationSummary');
    var uploadForm = document.getElementById('uploadForm');
    var uploadAlert = document.getElementById('uploadAlert');
    var docType = document.getElementById('documentType');
    var fileInput = document.getElementById('documentFile');
    var fileChip = document.getElementById('fileChip');
    var uploadBtn = document.getElementById('uploadSubmit');
    var docsList = document.getElementById('uploadedDocs');
    var switchBtn = document.getElementById('switchApplication');

    function setLookupBusy(busy) {
        var btn = document.getElementById('lookupSubmit');
        D.setLoading(btn, busy, 'Checking…');
    }

    function showWorkspace(application, token) {
        state = {
            id: application.id,
            token: token || application.access_token,
            reference: application.reference_no,
            loanType: application.loan_type,
            fullName: application.full_name,
            status: application.status
        };

        summaryEl.innerHTML = '' +
            '<div class="cp-summary-item"><span>Application reference</span><strong>' + D.escapeHtml(state.reference) + '</strong></div>' +
            '<div class="cp-summary-item"><span>Applicant</span><strong>' + D.escapeHtml(state.fullName) + '</strong></div>' +
            '<div class="cp-summary-item"><span>Loan type</span><strong>' + D.escapeHtml(state.loanType) + '</strong></div>' +
            '<div class="cp-summary-item"><span>Status</span><strong>' + D.escapeHtml(state.status || 'New') + '</strong></div>';

        var docs = DOCUMENT_REQUIREMENTS[state.loanType] || DEFAULT_DOCS;
        docType.innerHTML = '<option value="">Select document type</option>' +
            docs.map(function (value) {
                return '<option value="' + D.escapeHtml(value) + '">' + D.escapeHtml(value) + '</option>';
            }).join('');

        workspace.classList.remove('cp-hidden');
        if (lookupForm) { lookupForm.classList.add('cp-hidden'); }
        D.hideAlert(uploadAlert);
        loadDocuments();
    }

    async function loadDocuments() {
        if (!state) { return; }
        docsList.innerHTML = '<li class="cp-empty"><i class="fa fa-circle-o-notch fa-spin"></i>Loading documents…</li>';
        try {
            var rows = await D.rpc('get_application_documents', {
                p_lead_id: state.id,
                p_access_token: state.token
            });
            // A tracked function returning one row is unwrapped to a single
            // object by D.rpc; normalise it back to a list.
            if (rows && !Array.isArray(rows)) { rows = [rows]; }
            renderDocuments(rows || []);
        } catch (err) {
            console.error('Could not load documents:', err);
            docsList.innerHTML = '<li class="cp-empty"><i class="fa fa-exclamation-circle"></i>We could not load your documents. Please refresh the page.</li>';
        }
    }

    function renderDocuments(rows) {
        if (!rows.length) {
            docsList.innerHTML = '<li class="cp-empty"><i class="fa fa-folder-open-o"></i>No documents uploaded yet.</li>';
            return;
        }

        docsList.innerHTML = rows.map(function (row) {
            var status = row.status || 'Pending';
            var badgeClass = status === 'Verified' ? 'cp-badge-verified' :
                (status === 'Rejected' ? 'cp-badge-rejected' : 'cp-badge-pending');
            return '' +
                '<li class="cp-doc-item">' +
                    '<div>' +
                        '<span class="cp-doc-name">' + D.escapeHtml(row.file_name || row.document_type) + '</span>' +
                        '<span class="cp-doc-meta">' + D.escapeHtml(row.document_type) + ' · ' +
                            D.escapeHtml(D.prettyDate(String(row.created_at || '').slice(0, 10))) + '</span>' +
                    '</div>' +
                    '<span class="cp-badge ' + badgeClass + '">' + D.escapeHtml(status) + '</span>' +
                '</li>';
        }).join('');
    }

    async function lookupApplication(event) {
        if (event) { event.preventDefault(); }
        D.hideAlert(lookupAlert);
        D.clearErrors(lookupForm);

        var reference = document.getElementById('lookupRef');
        var mobile = document.getElementById('lookupMobile');
        var email = document.getElementById('lookupEmail');
        var ok = true;

        if (!reference.value.trim()) {
            D.setFieldError(reference, 'Enter your application reference.');
            ok = false;
        }
        if (D.digits(mobile.value).length < 10) {
            D.setFieldError(mobile, 'Enter the mobile number used in the application.');
            ok = false;
        }
        if (!D.isEmail(email.value)) {
            D.setFieldError(email, 'Enter the email address used in the application.');
            ok = false;
        }
        if (!ok) { return; }

        setLookupBusy(true);
        try {
            var result = await D.rpc('lookup_application', {
                p_reference: reference.value.trim(),
                p_mobile: mobile.value.trim(),
                p_email: email.value.trim()
            });
            showWorkspace(result, result.access_token);
        } catch (err) {
            console.error('Application lookup failed:', err);
            D.showAlert(lookupAlert, 'error', D.escapeHtml(D.friendlyError(err)));
        } finally {
            setLookupBusy(false);
        }
    }

    function fileExtension(name) {
        var parts = String(name || '').split('.');
        return parts.length > 1 ? parts.pop().toLowerCase() : '';
    }

    function describeFile(file) {
        var kb = file.size / 1024;
        var size = kb >= 1024 ? (kb / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(kb)) + ' KB';
        return file.name + ' · ' + size;
    }

    function validateFile(file) {
        if (!file) {
            D.showAlert(uploadAlert, 'error', 'Choose a document to upload.');
            return false;
        }
        var extension = fileExtension(file.name);
        if (ALLOWED_TYPES.indexOf(file.type) === -1 && ALLOWED_EXT.indexOf(extension) === -1) {
            D.showAlert(uploadAlert, 'error', 'Only PDF, JPG, PNG or WEBP files are accepted.');
            return false;
        }
        if (file.size > MAX_BYTES) {
            D.showAlert(uploadAlert, 'error', 'This file is larger than 5 MB. Please compress it or upload a smaller scan.');
            return false;
        }
        if (file.size <= 0) {
            D.showAlert(uploadAlert, 'error', 'This file appears to be empty.');
            return false;
        }
        return true;
    }

    async function uploadDocument(event) {
        event.preventDefault();
        if (!state) { return; }
        D.hideAlert(uploadAlert);
        D.clearErrors(uploadForm);

        if (!docType.value) {
            D.setFieldError(docType, 'Choose the document type.');
            return;
        }
        var file = fileInput.files && fileInput.files[0];
        if (!validateFile(file)) { return; }

        var consent = document.getElementById('uploadConsent');
        if (!consent.checked) {
            D.showAlert(uploadAlert, 'error', 'Please confirm that these documents belong to you or the applicant and accept the privacy notice.');
            return;
        }

        D.setLoading(uploadBtn, true, 'Uploading securely…');
        try {
            // Nhost Storage checks Hasura permissions, so the browser needs a
            // real (anonymous) session before the file can be uploaded.
            await D.ensureAnonymousSession();

            var upload = await D.uploadFile(file);

            await D.rpc('register_document', {
                p_lead_id: state.id,
                p_access_token: state.token,
                p_document_type: docType.value,
                p_storage_file_id: upload.id
            });

            uploadForm.reset();
            fileChip.classList.remove('show');
            fileChip.innerHTML = '';
            D.showAlert(uploadAlert, 'success', 'Document uploaded successfully. It is now pending verification by our team.');
            await loadDocuments();
        } catch (err) {
            console.error('Document upload failed:', err);
            var message = D.friendlyError(err);
            if (err.code === 'permission-error' || err.code === 'access-denied' ||
                err.code === 'permission-denied' || /row-level security|policy|permission/i.test(message)) {
                message = 'This upload was blocked for security reasons. Please check that you opened the correct application link, then try again.';
            }
            D.showAlert(uploadAlert, 'error', D.escapeHtml(message));
        } finally {
            D.setLoading(uploadBtn, false);
        }
    }

    if (lookupForm) {
        lookupForm.addEventListener('submit', lookupApplication);
        lookupForm.addEventListener('input', function (event) {
            if (event.target.classList.contains('form-control')) {
                D.clearFieldError(event.target);
            }
        });
    }

    if (fileInput) {
        fileInput.addEventListener('change', function () {
            var file = fileInput.files && fileInput.files[0];
            if (!file) {
                fileChip.classList.remove('show');
                return;
            }
            fileChip.innerHTML = '<i class="fa fa-file-o"></i> ' + D.escapeHtml(describeFile(file));
            fileChip.classList.add('show');
            D.hideAlert(uploadAlert);
        });
    }

    if (uploadForm) {
        uploadForm.addEventListener('submit', uploadDocument);
    }

    if (switchBtn) {
        switchBtn.addEventListener('click', function () {
            state = null;
            workspace.classList.add('cp-hidden');
            if (lookupForm) { lookupForm.classList.remove('cp-hidden'); }
            D.hideAlert(lookupAlert);
            if (lookupForm) { lookupForm.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        });
    }

    // Direct link from the application confirmation page. The token is read
    // only from the URL fragment so it is never sent to the server, stored in
    // Referer headers, or written to static-server access logs.
    (function bootFromLink() {
        var params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
        var id = params.get('id');
        var token = params.get('token');
        var reference = params.get('ref');
        if (reference && document.getElementById('lookupRef')) {
            document.getElementById('lookupRef').value = reference;
        }
        if (!id || !token) { return; }

        D.setLoading(document.getElementById('lookupSubmit'), true, 'Opening application…');
        D.rpc('get_application_by_token', { p_lead_id: id, p_access_token: token })
            .then(function (application) {
                showWorkspace(application, token);
            })
            .catch(function (err) {
                console.error('Invalid document link:', err);
                D.showAlert(lookupAlert, 'error', D.escapeHtml(D.friendlyError(err)));
            })
            .finally(function () {
                D.setLoading(document.getElementById('lookupSubmit'), false);
            });
    })();
})(window, document);

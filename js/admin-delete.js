/**
 * Dhanvi Finserv - admin record deletion.
 *
 * Provides a reusable confirmation dialog and the database/storage deletion
 * helpers used by the admin modules. Every destructive action is confirmed
 * before any request is sent. Database records are removed first, then any
 * private storage files are deleted best-effort so a storage permission issue
 * never leaves a half-deleted database record.
 */
(function (window, document) {
    'use strict';

    var overlay = null;
    var resolver = null;
    var lastFocus = null;
    var cancelButton = null;
    var confirmButton = null;
    var keyHandler = null;

    var SIMPLE_TABLES = {
        callback_bookings: true,
        complaints: true,
        post_disbursal_requests: true,
        loan_followups: true
    };

    function backend() {
        return window.DhanviBackend;
    }

    function requireBackend() {
        var service = backend();
        if (!service || typeof service.adminGql !== 'function') {
            throw new Error('The secure admin service could not be loaded. Please refresh the page.');
        }
        return service;
    }

    function ensureDialog() {
        if (overlay && document.body.contains(overlay)) { return; }

        overlay = document.createElement('div');
        overlay.className = 'dhanvi-confirm';
        overlay.hidden = true;
        overlay.innerHTML =
            '<div class="dhanvi-confirm__backdrop" data-confirm-cancel></div>' +
            '<div class="dhanvi-confirm__dialog" role="alertdialog" aria-modal="true" ' +
                'aria-labelledby="dhanviConfirmTitle" aria-describedby="dhanviConfirmMessage dhanviConfirmDetails">' +
                '<div class="dhanvi-confirm__icon" aria-hidden="true">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
                        'stroke-linecap="round" stroke-linejoin="round">' +
                        '<path d="M3 6h18"></path><path d="M8 6V4h8v2"></path>' +
                        '<path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v5"></path><path d="M14 11v5"></path>' +
                    '</svg>' +
                '</div>' +
                '<h2 class="dhanvi-confirm__title" id="dhanviConfirmTitle">Delete record?</h2>' +
                '<p class="dhanvi-confirm__message" id="dhanviConfirmMessage"></p>' +
                '<p class="dhanvi-confirm__details" id="dhanviConfirmDetails"></p>' +
                '<div class="dhanvi-confirm__actions">' +
                    '<button type="button" class="dhanvi-confirm__cancel">Cancel</button>' +
                    '<button type="button" class="dhanvi-confirm__delete">Delete permanently</button>' +
                '</div>' +
            '</div>';

        document.body.appendChild(overlay);

        cancelButton = overlay.querySelector('.dhanvi-confirm__cancel');
        confirmButton = overlay.querySelector('.dhanvi-confirm__delete');

        cancelButton.addEventListener('click', function () { close(false); });
        confirmButton.addEventListener('click', function () { close(true); });
        overlay.querySelector('[data-confirm-cancel]').addEventListener('click', function () { close(false); });
    }

    function onKeydown(event) {
        if (event.key === 'Escape') {
            event.preventDefault();
            close(false);
            return;
        }
        if (event.key !== 'Tab') { return; }

        var focusables = [cancelButton, confirmButton];
        var index = focusables.indexOf(document.activeElement);
        if (event.shiftKey) {
            if (index <= 0) {
                event.preventDefault();
                confirmButton.focus();
            }
        } else if (index === focusables.length - 1) {
            event.preventDefault();
            cancelButton.focus();
        }
    }

    function close(result) {
        if (!overlay || !resolver) { return; }

        document.removeEventListener('keydown', keyHandler, true);
        keyHandler = null;
        overlay.hidden = true;
        overlay.classList.remove('is-open');
        document.body.classList.remove('dhanvi-confirm-open');

        var finish = resolver;
        resolver = null;
        if (lastFocus && typeof lastFocus.focus === 'function') { lastFocus.focus(); }
        lastFocus = null;
        finish(result);
    }

    function confirmDelete(options) {
        options = options || {};
        ensureDialog();

        if (resolver) { close(false); }

        var title = overlay.querySelector('#dhanviConfirmTitle');
        var message = overlay.querySelector('#dhanviConfirmMessage');
        var details = overlay.querySelector('#dhanviConfirmDetails');

        title.textContent = options.title || 'Delete record?';
        message.textContent = options.message || 'This action permanently removes the record and cannot be undone.';
        details.textContent = options.details || '';
        details.hidden = !options.details;
        confirmButton.textContent = options.confirmLabel || 'Delete permanently';

        lastFocus = document.activeElement;
        overlay.hidden = false;
        document.body.classList.add('dhanvi-confirm-open');
        keyHandler = onKeydown;
        document.addEventListener('keydown', keyHandler, true);

        window.requestAnimationFrame(function () {
            if (!overlay.hidden) { overlay.classList.add('is-open'); }
        });
        cancelButton.focus();

        return new Promise(function (resolve) {
            resolver = resolve;
        });
    }

    async function deleteFiles(fileIds) {
        var service = requireBackend();
        var seen = {};
        var ids = [];

        (fileIds || []).forEach(function (id) {
            if (id && !seen[id]) {
                seen[id] = true;
                ids.push(id);
            }
        });

        var failed = [];
        for (var i = 0; i < ids.length; i += 1) {
            try {
                if (typeof service.deleteFile === 'function') {
                    await service.deleteFile(ids[i]);
                } else {
                    var client = service.getClient && service.getClient();
                    if (!client) { throw new Error('The storage service could not be loaded.'); }
                    await client.storage.deleteFile(ids[i]);
                }
            } catch (err) {
                failed.push({ id: ids[i], message: err.message || 'The file could not be removed.' });
            }
        }
        return failed;
    }

    async function deleteLead(id) {
        if (!id) { throw new Error('The application id is missing.'); }
        var service = requireBackend();

        var files = await service.adminGql(
            'query LeadFiles($id: uuid!) {' +
            '  loan_documents(where: {loan_lead_id: {_eq: $id}}) { storage_file_id }' +
            '}',
            { id: id }
        );

        var fileIds = ((files && files.loan_documents) || []).map(function (row) {
            return row.storage_file_id;
        }).filter(Boolean);

        var deleted = await service.adminGql(
            'mutation DeleteLead($id: uuid!) {' +
            '  delete_loan_leads_by_pk(id: $id) { id }' +
            '}',
            { id: id }
        );
        if (!deleted || !deleted.delete_loan_leads_by_pk) {
            throw new Error('This application no longer exists.');
        }

        return { failedFiles: await deleteFiles(fileIds) };
    }

    async function deleteDocument(id) {
        if (!id) { throw new Error('The document id is missing.'); }
        var service = requireBackend();

        var found = await service.adminGql(
            'query DocumentFile($id: uuid!) {' +
            '  loan_documents_by_pk(id: $id) { storage_file_id }' +
            '}',
            { id: id }
        );
        var doc = found && found.loan_documents_by_pk;
        if (!doc) { throw new Error('This document no longer exists.'); }

        var deleted = await service.adminGql(
            'mutation DeleteDocument($id: uuid!) {' +
            '  delete_loan_documents_by_pk(id: $id) { id }' +
            '}',
            { id: id }
        );
        if (!deleted || !deleted.delete_loan_documents_by_pk) {
            throw new Error('This document no longer exists.');
        }

        return { failedFiles: await deleteFiles(doc.storage_file_id ? [doc.storage_file_id] : []) };
    }

    async function deleteRow(table, id) {
        if (!SIMPLE_TABLES[table]) { throw new Error('Unsupported record type.'); }
        if (!id) { throw new Error('The record id is missing.'); }

        var service = requireBackend();
        var deleted = await service.adminGql(
            'mutation DeleteRecord($id: uuid!) {' +
            '  delete_' + table + '_by_pk(id: $id) { id }' +
            '}',
            { id: id }
        );
        if (!deleted || !deleted['delete_' + table + '_by_pk']) {
            throw new Error('This record no longer exists.');
        }
    }

    window.DhanviAdminDelete = {
        confirm: confirmDelete,
        deleteLead: deleteLead,
        deleteDocument: deleteDocument,
        deleteRow: deleteRow,
        deleteFiles: deleteFiles
    };
})(window, document);

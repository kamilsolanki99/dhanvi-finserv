/**
 * Dhanvi Finserv - shared helpers for customer-facing service forms.
 *
 * This file does not create its own backend client. It reuses
 * js/nhost-client.js so there is a single Nhost project configuration.
 */
(function (window) {
    'use strict';

    var CONSENT_VERSION = '2026-10';

    function getClient() {
        if (typeof window.getNhostClient !== 'function') {
            return null;
        }
        try {
            return window.getNhostClient();
        } catch (err) {
            console.error('Nhost client error:', err);
            return null;
        }
    }

    function escapeHtml(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function digits(value) {
        return String(value || '').replace(/\D/g, '');
    }

    function isEmail(value) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
    }

    function isIndianMobile(value) {
        return /^[6-9]\d{9}$/.test(digits(value));
    }

    function isInternationalPhone(value) {
        var d = digits(value);
        return d.length >= 8 && d.length <= 15;
    }

    function normalizeAlertType(type) {
        var value = String(type || 'info').toLowerCase();
        if (value === 'warn') { return 'warning'; }
        if (value === 'danger') { return 'error'; }
        if (value === 'information') { return 'info'; }
        return value;
    }

    /**
     * Track toasts created for a specific inline alert element so that the
     * existing hideAlert() calls also dismiss the matching notifications.
     */
    function trackToast(el, id) {
        if (!el || !id) { return; }
        if (!el._dhanviToastIds) { el._dhanviToastIds = []; }
        el._dhanviToastIds.push(id);
    }

    function dismissTrackedToasts(el) {
        if (!el || !el._dhanviToastIds || !window.DhanviNotify) { return; }
        el._dhanviToastIds.forEach(function (id) {
            window.DhanviNotify.dismiss(id);
        });
        el._dhanviToastIds = [];
    }

    /**
     * All customer-facing service messages go through the centralized toast
     * component. The inline element is cleared so old pages never show a
     * duplicate message. If notifications.js is unavailable, fall back to the
     * original inline alert so the form still communicates with the user.
     */
    function showAlert(el, type, message, title) {
        var normalized = normalizeAlertType(type);

        if (el) {
            el.className = 'cp-alert';
            el.innerHTML = '';
            el.removeAttribute('role');
        }

        if (window.DhanviNotify) {
            var id = window.DhanviNotify.show({
                type: normalized,
                title: title || '',
                message: message
            });
            trackToast(el, id);
            return;
        }

        if (!el) { return; }
        var fallbackType = normalized === 'warning' ? 'warn' : normalized;
        el.className = 'cp-alert cp-alert-' + fallbackType + ' show';
        el.innerHTML = message;
        el.setAttribute('role', normalized === 'error' ? 'alert' : 'status');
    }

    function hideAlert(el) {
        dismissTrackedToasts(el);
        if (!el) { return; }
        el.className = 'cp-alert';
        el.innerHTML = '';
        el.removeAttribute('role');
    }

    function notify(type, title, message, options) {
        if (!window.DhanviNotify) { return null; }
        var normalized = normalizeAlertType(type);
        return window.DhanviNotify.show({
            type: normalized,
            title: title || '',
            message: message,
            duration: options && options.duration
        });
    }

    function errorElement(field) {
        if (!field) { return null; }
        var id = field.id ? field.id + '-error' : '';
        var el = id ? document.getElementById(id) : null;
        if (!el) {
            el = document.createElement('span');
            el.className = 'cp-error-text';
            if (id) { el.id = id; }
            field.insertAdjacentElement('afterend', el);
        }
        return el;
    }

    function setFieldError(field, message) {
        if (!field) { return; }
        field.classList.add('is-invalid');
        field.setAttribute('aria-invalid', 'true');
        var el = errorElement(field);
        if (el) {
            el.textContent = message;
            el.classList.add('show');
        }
    }

    function clearFieldError(field) {
        if (!field) { return; }
        field.classList.remove('is-invalid');
        field.removeAttribute('aria-invalid');
        var el = field.id ? document.getElementById(field.id + '-error') : null;
        if (el) {
            el.textContent = '';
            el.classList.remove('show');
        }
    }

    function clearErrors(scope) {
        if (!scope) { return; }
        Array.prototype.forEach.call(scope.querySelectorAll('.is-invalid'), function (field) {
            field.classList.remove('is-invalid');
            field.removeAttribute('aria-invalid');
        });
        Array.prototype.forEach.call(scope.querySelectorAll('.cp-error-text'), function (el) {
            el.textContent = '';
            el.classList.remove('show');
        });
    }

    async function rpc(name, params) {
        if (!window.DhanviBackend || typeof window.DhanviBackend.rpc !== 'function') {
            throw new Error('The secure service could not be loaded. Please refresh the page or call +91 99250 02324.');
        }
        return window.DhanviBackend.rpc(name, params || {});
    }

    async function ensureAnonymousSession() {
        if (!window.DhanviBackend || typeof window.DhanviBackend.ensureAnonymousSession !== 'function') {
            throw new Error('The secure upload service could not be loaded. Please refresh the page.');
        }
        return window.DhanviBackend.ensureAnonymousSession();
    }

    async function uploadFile(file) {
        if (!window.DhanviBackend || typeof window.DhanviBackend.uploadFile !== 'function') {
            throw new Error('The secure upload service could not be loaded. Please refresh the page.');
        }
        return window.DhanviBackend.uploadFile(file);
    }

    function friendlyError(err) {
        if (window.DhanviBackend && typeof window.DhanviBackend.errorMessage === 'function') {
            return window.DhanviBackend.errorMessage(err);
        }
        return (err && err.message) ? err.message : 'Something went wrong. Please try again.';
    }

    function setLoading(button, loading, label) {
        if (!button) { return; }
        if (loading) {
            if (!button.dataset.originalLabel) {
                button.dataset.originalLabel = button.innerHTML;
            }
            button.classList.add('is-loading');
            button.disabled = true;
            button.innerHTML = '<span class="cp-spinner"></span> ' + escapeHtml(label || 'Please wait…');
        } else {
            button.classList.remove('is-loading');
            button.disabled = false;
            if (button.dataset.originalLabel) {
                button.innerHTML = button.dataset.originalLabel;
            }
        }
    }

    function prettyDate(value) {
        if (!value) { return ''; }
        var parts = String(value).split('-');
        if (parts.length !== 3) { return value; }
        var date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
        if (isNaN(date.getTime())) { return value; }
        return date.toLocaleDateString('en-IN', {
            weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'
        });
    }

    function prettySlot(value) {
        if (!value) { return ''; }
        var parts = String(value).split(':');
        if (parts.length !== 2) { return value; }
        var hour = Number(parts[0]);
        var minute = parts[1];
        var suffix = hour >= 12 ? 'PM' : 'AM';
        var displayHour = hour % 12 || 12;
        return displayHour + ':' + minute + ' ' + suffix;
    }

    function todayISO(offsetDays) {
        var date = new Date();
        date.setDate(date.getDate() + (offsetDays || 0));
        var month = String(date.getMonth() + 1).padStart(2, '0');
        var day = String(date.getDate()).padStart(2, '0');
        return date.getFullYear() + '-' + month + '-' + day;
    }

    function isSunday(value) {
        if (!value) { return false; }
        var parts = String(value).split('-');
        var date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
        return date.getDay() === 0;
    }

    window.Dhanvi = {
        CONSENT_VERSION: CONSENT_VERSION,
        getClient: getClient,
        escapeHtml: escapeHtml,
        digits: digits,
        isEmail: isEmail,
        isIndianMobile: isIndianMobile,
        isInternationalPhone: isInternationalPhone,
        showAlert: showAlert,
        hideAlert: hideAlert,
        notify: notify,
        setFieldError: setFieldError,
        clearFieldError: clearFieldError,
        clearErrors: clearErrors,
        rpc: rpc,
        ensureAnonymousSession: ensureAnonymousSession,
        uploadFile: uploadFile,
        friendlyError: friendlyError,
        setLoading: setLoading,
        prettyDate: prettyDate,
        prettySlot: prettySlot,
        todayISO: todayISO,
        isSunday: isSunday
    };
})(window);

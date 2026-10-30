/**
 * Dhanvi Finserv - centralized toast notification system.
 *
 * Usage:
 *   DhanviNotify.success('Profile updated', 'Your details have been saved.');
 *   DhanviNotify.warning('File too large', 'Choose a file smaller than 5 MB.');
 *   DhanviNotify.error('Upload failed', 'Please try again.');
 *   DhanviNotify.info('Opening WhatsApp', 'Continue in the WhatsApp window.');
 *
 *   DhanviNotify.show({
 *       type: 'success',
 *       title: 'Saved',
 *       message: 'Your changes have been saved.',
 *       duration: 5000,
 *       context: 'profile-form'
 *   });
 *
 *   DhanviNotify.dismiss(id);
 *   DhanviNotify.dismissContext('profile-form');
 *   DhanviNotify.dismissAll();
 *
 * The component has no external dependencies and is safe to load in <head>.
 * Notifications are queued until the document body is available.
 */
(function (window, document) {
    'use strict';

    var DEFAULT_TITLES = {
        success: 'Success',
        warning: 'Please check',
        error: 'Something went wrong',
        info: 'Information'
    };

    var DEFAULT_DURATIONS = {
        success: 5000,
        warning: 7000,
        error: 8000,
        info: 6000
    };

    var TYPE_ALIASES = {
        ok: 'success',
        warn: 'warning',
        information: 'info',
        danger: 'error'
    };

    var ICONS = {
        success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="m8.4 12.2 2.5 2.5 4.9-5.1"></path></svg>',
        warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0Z"></path><path d="M12 9v4"></path><path d="M12 16.5h.01"></path></svg>',
        error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="m9.2 9.2 5.6 5.6"></path><path d="m14.8 9.2-5.6 5.6"></path></svg>',
        info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5"></path><path d="M12 8h.01"></path></svg>',
        close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 6 12 12"></path><path d="m18 6-12 12"></path></svg>'
    };

    var toasts = [];
    var pending = [];
    var sequence = 0;
    var viewport = null;
    var region = null;
    var config = {
        maxVisible: 4,
        durations: {
            success: DEFAULT_DURATIONS.success,
            warning: DEFAULT_DURATIONS.warning,
            error: DEFAULT_DURATIONS.error,
            info: DEFAULT_DURATIONS.info
        }
    };

    function prefersReducedMotion() {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    function normalizeType(type) {
        var value = String(type || 'info').toLowerCase();
        return TYPE_ALIASES[value] || (DEFAULT_TITLES[value] ? value : 'info');
    }

    /**
     * Older call sites pass HTML-escaped text. Decode the common entities so
     * the toast shows the intended characters, then render with textContent so
     * user-supplied values can never inject markup.
     */
    function decodeEntities(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&(amp|lt|gt|quot|apos|#39|#x27|nbsp);/gi, function (match, entity) {
                switch (entity.toLowerCase()) {
                    case 'amp': return '&';
                    case 'lt': return '<';
                    case 'gt': return '>';
                    case 'quot': return '"';
                    case 'apos': return "'";
                    case '#39': return "'";
                    case '#x27': return "'";
                    case 'nbsp': return ' ';
                    default: return match;
                }
            });
    }

    function cleanText(value) {
        return decodeEntities(value).trim();
    }

    function defaultTitle(type) {
        return DEFAULT_TITLES[type] || DEFAULT_TITLES.info;
    }

    function ensureViewport() {
        if (region && viewport && document.body && document.body.contains(viewport)) {
            return region;
        }
        if (!document.body) { return null; }

        viewport = document.createElement('div');
        viewport.className = 'dhanvi-toast-viewport';
        viewport.setAttribute('role', 'region');
        viewport.setAttribute('aria-label', 'Notifications');
        viewport.setAttribute('data-dhanvi-toast-viewport', '');

        region = document.createElement('div');
        region.className = 'dhanvi-toast-region';
        region.setAttribute('aria-live', 'polite');
        region.setAttribute('aria-atomic', 'false');

        viewport.appendChild(region);
        document.body.appendChild(viewport);
        return region;
    }

    function findToast(id) {
        for (var i = 0; i < toasts.length; i += 1) {
            if (toasts[i].getAttribute('data-dhanvi-toast-id') === id) {
                return toasts[i];
            }
        }
        return null;
    }

    function findDuplicate(key) {
        for (var i = 0; i < toasts.length; i += 1) {
            if (!toasts[i]._leaving && toasts[i]._key === key) {
                return toasts[i];
            }
        }
        return null;
    }

    function startTimer(toast, duration) {
        clearTimeout(toast._timer);
        toast._startedAt = Date.now();
        toast._remaining = duration;
        toast._timer = window.setTimeout(function () {
            dismiss(toast.getAttribute('data-dhanvi-toast-id'));
        }, duration);
    }

    function pauseTimer(toast) {
        if (!toast || toast._leaving || !toast._timer) { return; }
        window.clearTimeout(toast._timer);
        toast._timer = null;
        toast._remaining = Math.max(0, toast._remaining - (Date.now() - toast._startedAt));
        toast.classList.add('is-paused');
    }

    function resumeTimer(toast) {
        if (!toast || toast._leaving || toast._timer || toast._duration <= 0) { return; }
        toast.classList.remove('is-paused');
        if (toast._remaining <= 0) {
            dismiss(toast.getAttribute('data-dhanvi-toast-id'));
            return;
        }
        startTimer(toast, toast._remaining);
    }

    function restartTimer(toast) {
        if (!toast || toast._leaving || toast._duration <= 0) { return; }
        toast.classList.remove('is-paused');
        startTimer(toast, toast._duration);
    }

    function dismiss(id) {
        var toast = findToast(id);
        if (!toast || toast._leaving) { return false; }

        toast._leaving = true;
        window.clearTimeout(toast._timer);
        toast._timer = null;
        toast.classList.remove('is-paused');
        toast.classList.add('is-leaving');

        function remove() {
            if (toast.parentNode) { toast.parentNode.removeChild(toast); }
            var index = toasts.indexOf(toast);
            if (index > -1) { toasts.splice(index, 1); }
        }

        if (prefersReducedMotion()) {
            remove();
        } else {
            window.setTimeout(remove, 240);
        }
        return true;
    }

    function dismissAll() {
        toasts.slice().forEach(function (toast) {
            dismiss(toast.getAttribute('data-dhanvi-toast-id'));
        });
    }

    /**
     * Dismiss every toast created for one context (for example a specific
     * inline alert container). This lets pages clear stale messages when the
     * matching form, modal, or page section resets, without hiding unrelated
     * notifications.
     */
    function dismissContext(context) {
        var value = String(context === null || context === undefined ? '' : context).trim();
        if (!value) { return 0; }

        var dismissed = 0;
        toasts.slice().forEach(function (toast) {
            if (toast._context === value && dismiss(toast.getAttribute('data-dhanvi-toast-id'))) {
                dismissed += 1;
            }
        });

        for (var i = pending.length - 1; i >= 0; i -= 1) {
            if (pending[i].context === value) { pending.splice(i, 1); }
        }
        return dismissed;
    }

    function enforceLimit() {
        var active = toasts.filter(function (toast) { return !toast._leaving; });
        while (active.length > config.maxVisible) {
            var oldest = active.shift();
            dismiss(oldest.getAttribute('data-dhanvi-toast-id'));
        }
    }

    function bindToast(toast) {
        var id = toast.getAttribute('data-dhanvi-toast-id');
        var close = toast.querySelector('.dhanvi-toast__close');

        if (close) {
            close.addEventListener('click', function () {
                dismiss(id);
            });
        }

        toast.addEventListener('mouseenter', function () { pauseTimer(toast); });
        toast.addEventListener('mouseleave', function () { resumeTimer(toast); });
        toast.addEventListener('focusin', function () { pauseTimer(toast); });
        toast.addEventListener('focusout', function (event) {
            if (!toast.contains(event.relatedTarget)) { resumeTimer(toast); }
        });
        toast.addEventListener('keydown', function (event) {
            if (event.key === 'Escape') {
                event.stopPropagation();
                dismiss(id);
            }
        });
    }

    function render(payload) {
        var regionEl = ensureViewport();
        if (!regionEl) {
            pending.push(payload);
            return payload.id;
        }

        var toast = document.createElement('div');
        toast.className = 'dhanvi-toast dhanvi-toast--' + payload.type;
        toast.setAttribute('data-dhanvi-toast-id', payload.id);
        if (payload.context) {
            toast.setAttribute('data-dhanvi-toast-context', payload.context);
        }
        toast.setAttribute('role', payload.type === 'error' || payload.type === 'warning' ? 'alert' : 'status');
        toast.setAttribute('aria-atomic', 'true');
        toast.innerHTML =
            '<div class="dhanvi-toast__icon" aria-hidden="true">' + ICONS[payload.type] + '</div>' +
            '<div class="dhanvi-toast__content">' +
                '<p class="dhanvi-toast__title"></p>' +
                '<p class="dhanvi-toast__message"></p>' +
            '</div>' +
            '<button type="button" class="dhanvi-toast__close" aria-label="Dismiss notification" title="Dismiss">' +
                ICONS.close +
            '</button>';

        toast.querySelector('.dhanvi-toast__title').textContent = payload.title;
        toast.querySelector('.dhanvi-toast__message').textContent = payload.message;

        toast._key = payload.key;
        toast._type = payload.type;
        toast._context = payload.context;
        toast._duration = payload.duration;
        toast._remaining = payload.duration;
        toast._timer = null;
        toast._startedAt = 0;
        toast._leaving = false;

        regionEl.insertBefore(toast, regionEl.firstChild);
        toasts.push(toast);
        bindToast(toast);
        enforceLimit();

        if (payload.duration > 0) {
            startTimer(toast, payload.duration);
        }
        return payload.id;
    }

    function show(options) {
        if (typeof options === 'string') {
            options = { message: options };
        }
        if (!options || typeof options !== 'object') { return null; }

        var type = normalizeType(options.type);
        var title = cleanText(options.title);
        var message = cleanText(options.message);
        var context = String(options.context === null || options.context === undefined ? '' : options.context).trim();

        // Allow show({ type: 'success', message: 'Saved.' }) and
        // success('Saved.') while still producing a clear title.
        if (!message && title) {
            message = title;
            title = '';
        }
        if (!message) { return null; }
        if (!title) { title = defaultTitle(type); }

        var key = context + '|' + type + '|' + title + '|' + message;
        var existing = findDuplicate(key);
        if (existing) {
            restartTimer(existing);
            return existing.getAttribute('data-dhanvi-toast-id');
        }

        var duration = options.duration;
        if (duration === undefined || duration === null) {
            duration = config.durations[type];
            if (message.length > 150) { duration += 1500; }
        }
        duration = Number(duration);
        if (!isFinite(duration) || duration < 0) { duration = 0; }

        var payload = {
            id: 'dhanvi-toast-' + (++sequence),
            type: type,
            title: title,
            message: message,
            duration: duration,
            context: context || null,
            key: key
        };

        return render(payload);
    }

    function convenience(type, title, message, options) {
        var payload = {};
        var extra = options;

        if (message === undefined || message === null) {
            payload.message = title;
        } else if (typeof message === 'object') {
            payload.message = title;
            extra = message;
        } else {
            payload.title = title;
            payload.message = message;
        }

        if (extra && typeof extra === 'object') {
            Object.keys(extra).forEach(function (key) {
                payload[key] = extra[key];
            });
        }
        payload.type = type;
        return show(payload);
    }

    function flush() {
        ensureViewport();
        var queued = pending.splice(0, pending.length);
        queued.forEach(render);
    }

    function configure(options) {
        if (!options || typeof options !== 'object') { return; }
        if (options.maxVisible !== undefined) {
            var max = Number(options.maxVisible);
            if (isFinite(max) && max > 0) { config.maxVisible = Math.floor(max); }
        }
        if (options.durations && typeof options.durations === 'object') {
            Object.keys(options.durations).forEach(function (type) {
                var value = Number(options.durations[type]);
                if (isFinite(value) && value >= 0) {
                    config.durations[normalizeType(type)] = value;
                }
            });
        }
    }

    var api = {
        show: show,
        success: function (title, message, options) {
            return convenience('success', title, message, options);
        },
        warning: function (title, message, options) {
            return convenience('warning', title, message, options);
        },
        warn: function (title, message, options) {
            return convenience('warning', title, message, options);
        },
        error: function (title, message, options) {
            return convenience('error', title, message, options);
        },
        info: function (title, message, options) {
            return convenience('info', title, message, options);
        },
        dismiss: dismiss,
        dismissContext: dismissContext,
        dismissAll: dismissAll,
        configure: configure
    };

    window.DhanviNotify = api;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', flush);
    } else {
        flush();
    }
})(window, document);

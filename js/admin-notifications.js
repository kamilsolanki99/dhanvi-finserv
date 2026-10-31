/**
 * Dhanvi Finserv - real-time admin notifications.
 *
 * Loaded on every admin page after js/nhost-client.js and js/admin-layout.js.
 * It waits for window.DhanviAdminReady, injects the bell into .topbar-right,
 * opens a Hasura WebSocket subscription, and keeps the unread badge in sync
 * across tabs.
 *
 * Public API (also used by admin-notifications.html):
 *   window.DhanviAdminNotifications.ready
 *   window.DhanviAdminNotifications.refresh()
 *   window.DhanviAdminNotifications.list({ status, search, type, sort, limit, offset })
 *   window.DhanviAdminNotifications.counts()
 *   window.DhanviAdminNotifications.markRead(id, isRead)
 *   window.DhanviAdminNotifications.markAllRead()
 *   window.DhanviAdminNotifications.remove(id)
 *   window.DhanviAdminNotifications.clearAll()
 *   window.DhanviAdminNotifications.open(id)
 *   window.DhanviAdminNotifications.getState()
 *   window.DhanviAdminNotifications.on('change' | 'error' | 'connection', handler)
 */
(function (window, document) {
    'use strict';

    var FIELDS = 'id recipient_user_id type title message entity_type entity_id action_url is_read created_at read_at metadata';

    var SNAPSHOT_QUERY =
        'query AdminNotificationSnapshot {' +
        '  admin_notifications(order_by: {created_at: desc}, limit: 25) { ' + FIELDS + ' }' +
        '  admin_notifications_aggregate(where: {is_read: {_eq: false}}) {' +
        '    aggregate { count }' +
        '  }' +
        '}';

    var SUBSCRIPTION_QUERY =
        'subscription AdminNotificationFeed {' +
        '  admin_notifications(order_by: {created_at: desc}, limit: 25) { ' + FIELDS + ' }' +
        '  admin_notifications_aggregate(where: {is_read: {_eq: false}}) {' +
        '    aggregate { count }' +
        '  }' +
        '}';

    var LIST_QUERY =
        'query AdminNotificationList($where: admin_notifications_bool_exp, $order_by: [admin_notifications_order_by!], $limit: Int!, $offset: Int!) {' +
        '  admin_notifications(where: $where, order_by: $order_by, limit: $limit, offset: $offset) { ' + FIELDS + ' }' +
        '  admin_notifications_aggregate(where: $where) {' +
        '    aggregate { count }' +
        '  }' +
        '}';

    var COUNTS_QUERY =
        'query AdminNotificationCounts {' +
        '  all: admin_notifications_aggregate { aggregate { count } }' +
        '  unread: admin_notifications_aggregate(where: {is_read: {_eq: false}}) { aggregate { count } }' +
        '  read: admin_notifications_aggregate(where: {is_read: {_eq: true}}) { aggregate { count } }' +
        '}';

    var MARK_READ_MUTATION =
        'mutation MarkAdminNotification($id: uuid!, $is_read: Boolean!) {' +
        '  update_admin_notifications_by_pk(pk_columns: {id: $id}, _set: {is_read: $is_read}) {' +
        '    id is_read read_at read_by' +
        '  }' +
        '}';

    var MARK_ALL_READ_MUTATION =
        'mutation MarkAllAdminNotifications {' +
        '  update_admin_notifications(where: {is_read: {_eq: false}}, _set: {is_read: true}) {' +
        '    affected_rows' +
        '  }' +
        '}';

    var DELETE_MUTATION =
        'mutation DeleteAdminNotification($id: uuid!) {' +
        '  delete_admin_notifications_by_pk(id: $id) { id }' +
        '}';

    var CLEAR_ALL_MUTATION =
        'mutation ClearAdminNotifications {' +
        '  delete_admin_notifications(where: {}) { affected_rows }' +
        '}';

    var TYPE_META = {
        lead: { label: 'Loan application', icon: 'fa-file-text-o', className: 'type-lead' },
        callback: { label: 'Callback', icon: 'fa-phone', className: 'type-callback' },
        document: { label: 'Document', icon: 'fa-folder-open', className: 'type-document' },
        followup: { label: 'Follow-up', icon: 'fa-calendar-check-o', className: 'type-followup' },
        support: { label: 'Support', icon: 'fa-life-ring', className: 'type-support' },
        complaint: { label: 'Complaint', icon: 'fa-exclamation-circle', className: 'type-complaint' },
        system: { label: 'System', icon: 'fa-info-circle', className: 'type-system' }
    };

    var state = {
        initialized: false,
        items: [],
        unreadCount: 0,
        loading: true,
        error: null,
        connection: 'connecting',
        activeFilter: 'all',
        panelOpen: false,
        refreshing: null,
        ws: null,
        wsProtocolIndex: 0,
        wsAcknowledged: false,
        connecting: false,
        reconnectAttempts: 0,
        reconnectTimer: null,
        pollTimer: null,
        stopped: false,
        knownIds: {},
        firstPayload: true,
        lastRefreshAt: 0
    };

    var els = {};
    var listeners = [];
    var channel = null;
    var tabId = 'tab-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
    var readyResolve;
    var readyPromise = new Promise(function (resolve) { readyResolve = resolve; });

    // -------------------------------------------------------------------------
    // Shared helpers
    // -------------------------------------------------------------------------

    function backend() {
        return window.DhanviBackend;
    }

    function gql(query, variables) {
        var service = backend();
        if (!service || typeof service.adminGql !== 'function') {
            return Promise.reject(new Error('The secure admin service could not be loaded. Please refresh the page.'));
        }
        return service.adminGql(query, variables);
    }

    function esc(value) {
        return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, function (character) {
            return {
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#39;'
            }[character];
        });
    }

    function typeMeta(type) {
        return TYPE_META[type] || TYPE_META.system;
    }

    function fullTime(value) {
        var date = new Date(value);
        if (isNaN(date.getTime())) { return ''; }
        return date.toLocaleString('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function relativeTime(value) {
        var date = new Date(value);
        if (isNaN(date.getTime())) { return ''; }

        var diff = Date.now() - date.getTime();
        var future = diff < 0;
        diff = Math.abs(diff);

        if (diff < 45000) { return future ? 'In a moment' : 'Just now'; }

        var minutes = Math.floor(diff / 60000);
        if (minutes < 60) {
            return future ? 'In ' + minutes + ' min' : minutes + ' min ago';
        }

        var hours = Math.floor(minutes / 60);
        if (hours < 24) {
            return future
                ? 'In ' + hours + ' hr'
                : hours + (hours === 1 ? ' hour ago' : ' hours ago');
        }

        var days = Math.floor(hours / 24);
        if (days === 1) { return future ? 'Tomorrow' : 'Yesterday'; }
        if (days < 7) {
            return future ? 'In ' + days + ' days' : days + ' days ago';
        }

        var options = { day: '2-digit', month: 'short' };
        if (date.getFullYear() !== new Date().getFullYear()) { options.year = 'numeric'; }
        return date.toLocaleDateString('en-GB', options);
    }

    function safeUrl(value) {
        if (!value) { return null; }
        var url;
        try {
            url = new window.URL(String(value), window.location.href);
        } catch (err) {
            return null;
        }
        if (url.origin !== window.location.origin) { return null; }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') { return null; }
        return url.href;
    }

    function toast(type, title, message) {
        var notify = window.DhanviNotify;
        if (notify && typeof notify[type] === 'function') {
            try {
                notify[type](title, message);
                return;
            } catch (err) {
                // Fall through to the console.
            }
        }
        if (window.console && typeof window.console.log === 'function') {
            window.console.log('[admin-notifications]', title, message || '');
        }
    }

    function confirmAction(options) {
        options = options || {};
        var dialog = window.DhanviAdminDelete;
        if (dialog && typeof dialog.confirm === 'function') {
            return dialog.confirm({
                title: options.title || 'Are you sure?',
                message: options.message || 'This action cannot be undone.',
                details: options.details || '',
                confirmLabel: options.confirmLabel || 'Delete permanently'
            });
        }
        var text = options.message || 'Are you sure?';
        if (options.details) { text += '\n\n' + options.details; }
        return Promise.resolve(window.confirm(text));
    }

    function emit(name, detail) {
        listeners.slice().forEach(function (listener) {
            if (listener.name !== name) { return; }
            try {
                listener.handler(detail);
            } catch (err) {
                if (window.console) { window.console.warn('Notification listener failed:', err); }
            }
        });
    }

    function on(name, handler) {
        if (typeof handler !== 'function') { return function () {}; }
        var listener = { name: name, handler: handler };
        listeners.push(listener);
        return function () { off(name, handler); };
    }

    function off(name, handler) {
        listeners = listeners.filter(function (listener) {
            return listener.name !== name || listener.handler !== handler;
        });
    }

    function findItem(id) {
        for (var i = 0; i < state.items.length; i += 1) {
            if (state.items[i].id === id) { return state.items[i]; }
        }
        return null;
    }

    function getState() {
        return {
            items: state.items.slice(),
            unreadCount: state.unreadCount,
            loading: state.loading,
            error: state.error,
            connection: state.connection
        };
    }

    // -------------------------------------------------------------------------
    // Bell, badge and dropdown rendering
    // -------------------------------------------------------------------------

    function setConnection(status) {
        state.connection = status;
        if (!els.live) { return; }

        var labels = {
            connecting: 'Connecting',
            live: 'Live',
            reconnecting: 'Reconnecting',
            polling: 'Polling',
            offline: 'Offline'
        };
        els.live.className = 'dhanvi-notif__live is-' + status;
        els.live.innerHTML = '<span class="dot"></span>' + (labels[status] || 'Live');
        emit('connection', { status: status });
    }

    function updateBadge() {
        if (!els.badge || !els.bell) { return; }
        var count = Math.max(0, Number(state.unreadCount) || 0);
        els.badge.textContent = count > 99 ? '99+' : String(count);
        els.badge.hidden = count === 0;
        els.bell.setAttribute('aria-label', count === 0
            ? 'Notifications'
            : 'Notifications, ' + count + ' unread');
    }

    function skeletonHtml(count) {
        var html = '';
        for (var i = 0; i < count; i += 1) {
            html += '<div class="dhanvi-notif__skeleton" aria-hidden="true">' +
                '<div class="dhanvi-notif__skeleton-icon"></div>' +
                '<div class="dhanvi-notif__skeleton-lines">' +
                    '<div class="dhanvi-notif__skeleton-line w-70"></div>' +
                    '<div class="dhanvi-notif__skeleton-line w-90"></div>' +
                    '<div class="dhanvi-notif__skeleton-line w-45"></div>' +
                '</div>' +
            '</div>';
        }
        return html;
    }

    function emptyHtml() {
        var title = 'No notifications yet';
        var message = 'New leads, documents and customer requests will appear here.';

        if (state.activeFilter === 'unread') {
            title = 'No unread notifications';
            message = 'You have read everything in your inbox.';
        } else if (state.activeFilter === 'read') {
            title = 'No read notifications';
            message = 'Notifications you open will appear here.';
        }

        return '<div class="dhanvi-notif__state">' +
            '<i class="fa fa-bell-o" aria-hidden="true"></i>' +
            '<strong>' + title + '</strong>' +
            message +
        '</div>';
    }

    function errorHtml() {
        var message = state.error && state.error.message
            ? state.error.message
            : 'Please check your connection and try again.';
        return '<div class="dhanvi-notif__state dhanvi-notif__state--error">' +
            '<i class="fa fa-exclamation-circle" aria-hidden="true"></i>' +
            '<strong>Notifications unavailable</strong>' +
            esc(message) +
            '<button type="button" class="dhanvi-notif__text-btn" data-action="retry">Try again</button>' +
        '</div>';
    }

    function itemHtml(item) {
        var meta = typeMeta(item.type);
        var unread = !item.is_read;
        var title = esc(item.title || 'Notification');
        var message = item.message
            ? '<p class="dhanvi-notif__item-message">' + esc(item.message) + '</p>'
            : '';
        var toggleLabel = unread ? 'Mark as read' : 'Mark as unread';

        return '<div class="dhanvi-notif__item' + (unread ? ' is-unread' : '') + '"' +
                ' data-id="' + esc(item.id) + '">' +
            '<span class="dhanvi-notif__item-icon ' + meta.className + '">' +
                '<i class="fa ' + meta.icon + '" aria-hidden="true"></i>' +
            '</span>' +
            '<div class="dhanvi-notif__item-content" role="button" tabindex="0"' +
                ' data-action="open" aria-label="Open notification: ' + title + '">' +
                '<div class="dhanvi-notif__item-heading">' +
                    '<span class="dhanvi-notif__item-title">' + title + '</span>' +
                    (unread ? '<span class="dhanvi-notif__new">New</span>' : '') +
                '</div>' +
                message +
                '<div class="dhanvi-notif__item-meta">' +
                    '<span class="dhanvi-notif__type">' + esc(meta.label) + '</span>' +
                    '<span class="dhanvi-notif__dot"></span>' +
                    '<time datetime="' + esc(item.created_at) + '"' +
                        ' title="' + esc(fullTime(item.created_at)) + '"' +
                        ' data-relative-time="' + esc(item.created_at) + '">' +
                        esc(relativeTime(item.created_at)) +
                    '</time>' +
                '</div>' +
            '</div>' +
            '<div class="dhanvi-notif__item-actions">' +
                '<button type="button" class="dhanvi-notif__icon-btn" data-action="toggle-read"' +
                    ' title="' + toggleLabel + '" aria-label="' + toggleLabel + '">' +
                    '<i class="fa ' + (unread ? 'fa-check-circle-o' : 'fa-circle-o') + '" aria-hidden="true"></i>' +
                '</button>' +
                '<button type="button" class="dhanvi-notif__icon-btn danger" data-action="delete"' +
                    ' title="Delete notification" aria-label="Delete notification">' +
                    '<i class="fa fa-trash-o" aria-hidden="true"></i>' +
                '</button>' +
            '</div>' +
        '</div>';
    }

    function renderPanel() {
        if (!els.list) { return; }

        var filtered = state.items;
        if (state.activeFilter === 'unread') {
            filtered = state.items.filter(function (item) { return !item.is_read; });
        } else if (state.activeFilter === 'read') {
            filtered = state.items.filter(function (item) { return item.is_read; });
        }

        Array.prototype.forEach.call(els.filterButtons || [], function (button) {
            var isActive = button.getAttribute('data-filter') === state.activeFilter;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });

        // The dropdown only renders the latest 25 notifications, so its tab
        // counts describe that visible window. The badge and summary above
        // still show the total unread count from the aggregate.
        if (els.countAll) { els.countAll.textContent = String(state.items.length); }
        if (els.countUnread) {
            els.countUnread.textContent = String(state.items.filter(function (item) {
                return !item.is_read;
            }).length);
        }
        if (els.countRead) {
            els.countRead.textContent = String(state.items.filter(function (item) {
                return item.is_read;
            }).length);
        }

        if (els.summary) {
            if (state.error && state.items.length === 0) {
                els.summary.textContent = 'Unable to load notifications';
            } else if (state.error) {
                els.summary.textContent = 'Unable to refresh';
            } else if (state.loading && state.items.length === 0) {
                els.summary.textContent = 'Loading…';
            } else if (state.unreadCount > 0) {
                els.summary.textContent = state.unreadCount + (state.unreadCount === 1
                    ? ' unread notification'
                    : ' unread notifications');
            } else {
                els.summary.textContent = 'You are all caught up';
            }
        }

        if (els.markAll) {
            els.markAll.disabled = state.unreadCount === 0 || !!state.error;
        }
        if (els.clear) {
            els.clear.disabled = state.items.length === 0 || !!state.error;
        }

        if (state.loading && state.items.length === 0) {
            els.list.innerHTML = skeletonHtml(4);
            return;
        }
        if (state.error && state.items.length === 0) {
            els.list.innerHTML = errorHtml();
            return;
        }
        if (!filtered.length) {
            els.list.innerHTML = emptyHtml();
            return;
        }

        els.list.innerHTML = filtered.map(itemHtml).join('');
    }

    function applySnapshot(data, options) {
        options = options || {};
        var rows = (data && data.admin_notifications) || [];
        var aggregate = data && data.admin_notifications_aggregate;
        var count = aggregate && aggregate.aggregate
            ? Number(aggregate.aggregate.count)
            : null;

        var newOnes = [];
        rows.forEach(function (row) {
            if (!state.knownIds[row.id]) {
                state.knownIds[row.id] = true;
                newOnes.push(row);
            }
        });

        state.items = rows;
        if (count !== null && isFinite(count)) {
            state.unreadCount = Math.max(0, count);
        }
        state.loading = false;
        state.error = null;
        state.lastRefreshAt = Date.now();

        updateBadge();
        renderPanel();

        if (options.announce && newOnes.length && !state.firstPayload) {
            var latest = newOnes[0];
            var extra = newOnes.length > 1 ? ' (+' + (newOnes.length - 1) + ' more)' : '';
            toast('info', 'New notification', (latest.title || 'You have a new notification') + extra);
            ringBell();
            broadcast();
        }

        state.firstPayload = false;
        emit('change', {
            reason: options.reason || 'snapshot',
            items: state.items.slice(),
            unreadCount: state.unreadCount
        });
    }

    function refresh(force) {
        if (state.refreshing) {
            // A mutation must not reuse a snapshot that started before it was
            // committed, otherwise a stale unread count can overwrite the
            // optimistic state. Wait for the in-flight refresh, then fetch
            // again.
            if (force) {
                return state.refreshing.then(function () { return refresh(); });
            }
            return state.refreshing;
        }

        if (!state.items.length) {
            state.loading = true;
            renderPanel();
        }

        state.refreshing = gql(SNAPSHOT_QUERY)
            .then(function (data) {
                applySnapshot(data, { reason: 'refresh', announce: false });
            })
            .catch(function (err) {
                state.loading = false;
                state.error = err;
                if (window.console) { window.console.warn('Notification refresh failed:', err); }
                renderPanel();
                emit('error', err);
            })
            .then(function () {
                state.refreshing = null;
            });

        return state.refreshing;
    }

    // -------------------------------------------------------------------------
    // Data API
    // -------------------------------------------------------------------------

    function list(options) {
        options = options || {};
        var limit = Math.min(Math.max(parseInt(options.limit, 10) || 15, 1), 100);
        var offset = Math.max(parseInt(options.offset, 10) || 0, 0);
        var where = {};

        if (options.status === 'unread') { where.is_read = { _eq: false }; }
        else if (options.status === 'read') { where.is_read = { _eq: true }; }

        if (options.type) { where.type = { _eq: String(options.type) }; }

        var search = String(options.search || '').trim();
        if (search) {
            var term = '%' + search.replace(/[\\%_]/g, '\\$&') + '%';
            where._or = [
                { title: { _ilike: term } },
                { message: { _ilike: term } }
            ];
        }

        return gql(LIST_QUERY, {
            where: where,
            order_by: [{ created_at: options.sort === 'oldest' ? 'asc' : 'desc' }],
            limit: limit,
            offset: offset
        }).then(function (data) {
            var rows = (data && data.admin_notifications) || [];
            var aggregate = data && data.admin_notifications_aggregate;
            var total = aggregate && aggregate.aggregate
                ? Number(aggregate.aggregate.count)
                : 0;
            return {
                rows: rows,
                total: isFinite(total) ? total : 0
            };
        });
    }

    function counts() {
        return gql(COUNTS_QUERY).then(function (data) {
            function readCount(key) {
                var node = data && data[key];
                var value = node && node.aggregate ? Number(node.aggregate.count) : 0;
                return isFinite(value) ? value : 0;
            }
            return {
                all: readCount('all'),
                unread: readCount('unread'),
                read: readCount('read')
            };
        });
    }

    async function markRead(id, isRead) {
        if (!id) { throw new Error('The notification id is missing.'); }
        var read = !!isRead;
        var data = await gql(MARK_READ_MUTATION, { id: id, is_read: read });
        var row = data && data.update_admin_notifications_by_pk;
        if (!row) { throw new Error('This notification no longer exists.'); }

        var item = findItem(id);
        if (item) {
            var wasRead = !!item.is_read;
            item.is_read = !!row.is_read;
            item.read_at = row.read_at || null;
            item.read_by = row.read_by || null;
            if (wasRead !== item.is_read) {
                state.unreadCount = Math.max(0, state.unreadCount + (item.is_read ? -1 : 1));
            }
        }

        updateBadge();
        renderPanel();
        broadcast();
        refresh(true);
        return row;
    }

    async function markAllRead() {
        var data = await gql(MARK_ALL_READ_MUTATION);
        var affected = data && data.update_admin_notifications
            ? Number(data.update_admin_notifications.affected_rows) || 0
            : 0;
        var now = new Date().toISOString();

        state.items.forEach(function (item) {
            if (!item.is_read) {
                item.is_read = true;
                item.read_at = item.read_at || now;
            }
        });
        state.unreadCount = 0;
        updateBadge();
        renderPanel();
        broadcast();
        refresh(true);
        return affected;
    }

    async function remove(id) {
        if (!id) { throw new Error('The notification id is missing.'); }
        var data = await gql(DELETE_MUTATION, { id: id });
        var row = data && data.delete_admin_notifications_by_pk;
        if (!row) { throw new Error('This notification no longer exists.'); }

        var item = findItem(id);
        state.items = state.items.filter(function (entry) { return entry.id !== id; });
        delete state.knownIds[id];
        if (item && !item.is_read) {
            state.unreadCount = Math.max(0, state.unreadCount - 1);
        }

        updateBadge();
        renderPanel();
        broadcast();
        refresh(true);
    }

    async function clearAll() {
        var data = await gql(CLEAR_ALL_MUTATION);
        var affected = data && data.delete_admin_notifications
            ? Number(data.delete_admin_notifications.affected_rows) || 0
            : 0;

        state.items = [];
        state.knownIds = {};
        state.unreadCount = 0;
        updateBadge();
        renderPanel();
        broadcast();
        refresh(true);
        return affected;
    }

    async function openNotification(id) {
        var item = findItem(id);

        if (!item) {
            try {
                var data = await gql(
                    'query AdminNotificationById($id: uuid!) {' +
                    '  admin_notifications_by_pk(id: $id) { ' + FIELDS + ' }' +
                    '}',
                    { id: id }
                );
                item = data && data.admin_notifications_by_pk;
            } catch (err) {
                item = null;
            }
        }

        if (!item) {
            toast('error', 'Notification unavailable', 'This notification could not be found.');
            return false;
        }

        if (!item.is_read) {
            try {
                await markRead(item.id, true);
            } catch (err) {
                if (window.console) { window.console.warn('Could not mark notification as read:', err); }
            }
        }

        var url = safeUrl(item.action_url);
        if (url) {
            window.location.href = url;
            return true;
        }

        toast('success', 'Notification opened', 'There is no linked page for this notification.');
        return false;
    }

    // -------------------------------------------------------------------------
    // Realtime WebSocket with protocol fallback and polling
    // -------------------------------------------------------------------------

    function wsUrl() {
        var service = backend();
        var nhost = service && typeof service.getClient === 'function' ? service.getClient() : null;
        var httpUrl = nhost && nhost.graphql ? nhost.graphql.url : null;

        if (!httpUrl) {
            var config = service && service.config ? service.config : {};
            if (!config.subdomain || !config.region) { return null; }
            httpUrl = 'https://' + config.subdomain + '.graphql.' + config.region + '.nhost.run/v1';
        }

        return String(httpUrl).replace(/^http/i, 'ws');
    }

    function tokenExpiry(token) {
        try {
            var parts = String(token).split('.');
            if (parts.length < 2) { return 0; }
            var base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            while (base64.length % 4) { base64 += '='; }
            var payload = JSON.parse(window.atob(base64));
            return payload && payload.exp ? Number(payload.exp) * 1000 : 0;
        } catch (err) {
            return 0;
        }
    }

    async function ensureToken() {
        var service = backend();
        var nhost = service && typeof service.getClient === 'function' ? service.getClient() : null;
        if (!nhost) { return null; }

        var session = typeof nhost.getUserSession === 'function' ? nhost.getUserSession() : null;
        if (!session || !session.accessToken) { return null; }

        var expires = tokenExpiry(session.accessToken);
        if (expires && expires - Date.now() > 60000) { return session.accessToken; }

        if (session.refreshToken && nhost.auth && typeof nhost.auth.refreshToken === 'function') {
            try {
                var response = await nhost.auth.refreshToken({ refreshToken: session.refreshToken });
                var body = response && response.body;
                // The Nhost auth token endpoint returns the session either
                // directly or wrapped in a session property, depending on the
                // SDK/API version. Accept both.
                var fresh = body && (body.session || body);
                if (fresh && fresh.accessToken) { return fresh.accessToken; }
                var current = typeof nhost.getUserSession === 'function' ? nhost.getUserSession() : null;
                if (current && current.accessToken) { return current.accessToken; }
            } catch (err) {
                if (window.console) {
                    window.console.warn('Could not refresh the admin session for notifications:', err);
                }
            }
        }

        return session.accessToken;
    }

    function wsSend(socket, message) {
        if (!socket || socket.readyState !== 1) { return; }
        try {
            socket.send(JSON.stringify(message));
        } catch (err) {
            if (window.console) { window.console.warn('Notification socket send failed:', err); }
        }
    }

    function connect() {
        if (state.stopped || !state.initialized) { return; }
        if (typeof window.WebSocket !== 'function') {
            scheduleReconnect();
            return;
        }
        if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) { return; }
        if (state.connecting) { return; }

        state.connecting = true;
        clearTimeout(state.reconnectTimer);
        setConnection(state.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

        ensureToken().then(function (token) {
            state.connecting = false;

            if (!token || state.stopped) {
                scheduleReconnect();
                return;
            }

            var url = wsUrl();
            if (!url) {
                scheduleReconnect();
                return;
            }

            var protocol = state.wsProtocolIndex === 0
                ? 'graphql-transport-ws'
                : 'graphql-ws';
            var socket;
            try {
                socket = new window.WebSocket(url, protocol);
            } catch (err) {
                if (window.console) { window.console.warn('Notification socket could not be created:', err); }
                scheduleReconnect();
                return;
            }

            state.ws = socket;
            state.wsAcknowledged = false;

            var ackTimer = window.setTimeout(function () {
                if (state.ws === socket && !state.wsAcknowledged) {
                    try { socket.close(); } catch (err) { /* ignore */ }
                }
            }, 12000);

            socket.onopen = function () {
                wsSend(socket, {
                    type: 'connection_init',
                    payload: {
                        headers: {
                            Authorization: 'Bearer ' + token,
                            'x-hasura-role': 'admin'
                        }
                    }
                });
            };

            socket.onmessage = function (event) {
                var message;
                try {
                    message = JSON.parse(event.data);
                } catch (err) {
                    return;
                }
                if (!message || !message.type) { return; }

                if (message.type === 'connection_ack') {
                    window.clearTimeout(ackTimer);
                    state.wsAcknowledged = true;
                    state.reconnectAttempts = 0;
                    setConnection('live');
                    stopPolling();
                    wsSend(socket, {
                        id: 'admin-notifications',
                        type: state.wsProtocolIndex === 0 ? 'subscribe' : 'start',
                        payload: {
                            query: SUBSCRIPTION_QUERY,
                            variables: {}
                        }
                    });
                    return;
                }

                if (message.type === 'ping') {
                    wsSend(socket, { type: 'pong' });
                    return;
                }

                if (message.type === 'connection_keep_alive' || message.type === 'ka') {
                    return;
                }

                if (message.type === 'next' || message.type === 'data') {
                    var payload = message.payload || {};
                    if (payload.data) {
                        applySnapshot(payload.data, { reason: 'realtime', announce: true });
                    } else if (payload.errors) {
                        if (window.console) {
                            window.console.warn('Notification subscription returned errors:', payload.errors);
                        }
                        setConnection('polling');
                        startPolling();
                    }
                    return;
                }

                if (message.type === 'error' || message.type === 'connection_error') {
                    if (window.console) {
                        window.console.warn('Notification subscription error:', message.payload);
                    }
                    setConnection('polling');
                    startPolling();
                    return;
                }

                if (message.type === 'complete') {
                    try { socket.close(); } catch (err) { /* ignore */ }
                }
            };

            socket.onerror = function () {
                // The close event below handles reconnection.
            };

            socket.onclose = function () {
                window.clearTimeout(ackTimer);
                var acknowledged = state.wsAcknowledged;
                if (state.ws === socket) { state.ws = null; }
                state.wsAcknowledged = false;

                if (state.stopped) { return; }

                // Hasura accepts both graphql-transport-ws and the legacy
                // graphql-ws protocol. If the handshake fails before an ack,
                // try the other protocol once before backing off.
                if (!acknowledged && state.wsProtocolIndex === 0) {
                    state.wsProtocolIndex = 1;
                    connect();
                    return;
                }

                scheduleReconnect();
            };
        }).catch(function (err) {
            state.connecting = false;
            if (window.console) { window.console.warn('Notification socket setup failed:', err); }
            scheduleReconnect();
        });
    }

    function scheduleReconnect() {
        if (state.stopped || !state.initialized) { return; }

        state.reconnectAttempts += 1;
        setConnection('polling');
        startPolling();

        var exponent = Math.min(state.reconnectAttempts - 1, 5);
        var delay = Math.min(30000, 1000 * Math.pow(2, exponent));
        delay += Math.floor(Math.random() * 600);

        window.clearTimeout(state.reconnectTimer);
        state.reconnectTimer = window.setTimeout(connect, delay);
    }

    function startPolling() {
        if (state.pollTimer) { return; }
        state.pollTimer = window.setInterval(function () {
            if (!document.hidden) { refresh(); }
        }, 30000);
    }

    function stopPolling() {
        if (!state.pollTimer) { return; }
        window.clearInterval(state.pollTimer);
        state.pollTimer = null;
    }

    // -------------------------------------------------------------------------
    // Cross-tab synchronization
    // -------------------------------------------------------------------------

    function setupChannel() {
        if (typeof window.BroadcastChannel === 'function') {
            try {
                channel = new window.BroadcastChannel('dhanvi-admin-notifications');
                channel.onmessage = function (event) {
                    var message = event.data || {};
                    if (message.source === tabId) { return; }
                    if (message.type === 'notifications-changed') { refresh(); }
                };
            } catch (err) {
                channel = null;
            }
        }

        window.addEventListener('storage', function (event) {
            if (event.key === 'dhanvi-notifications-sync') { refresh(); }
        });
    }

    function broadcast() {
        if (channel) {
            try {
                channel.postMessage({
                    type: 'notifications-changed',
                    source: tabId,
                    at: Date.now()
                });
            } catch (err) {
                // BroadcastChannel is best-effort.
            }
        }
        try {
            window.localStorage.setItem('dhanvi-notifications-sync', String(Date.now()));
        } catch (err) {
            // Private browsing or storage limits.
        }
    }

    // -------------------------------------------------------------------------
    // UI wiring
    // -------------------------------------------------------------------------

    function injectUI() {
        if (document.querySelector('.dhanvi-notif[data-dhanvi-notifications]')) { return true; }

        var topbarRight = document.querySelector('.admin-topbar .topbar-right') ||
            document.querySelector('.topbar-right');
        if (!topbarRight) {
            if (window.console) { window.console.warn('Admin notifications: .topbar-right was not found.'); }
            return false;
        }

        // Replace the old static bell that showed a hard-coded badge.
        var oldBell = topbarRight.querySelector('.topbar-notification');
        if (oldBell && oldBell.parentNode) { oldBell.parentNode.removeChild(oldBell); }

        var wrapper = document.createElement('div');
        wrapper.className = 'dhanvi-notif';
        wrapper.setAttribute('data-dhanvi-notifications', '');
        wrapper.innerHTML =
            '<button type="button" class="dhanvi-notif__bell" id="dhanviNotifBell"' +
                ' aria-label="Notifications" aria-haspopup="dialog" aria-expanded="false"' +
                ' aria-controls="dhanviNotifPanel">' +
                '<i class="fa fa-bell-o" aria-hidden="true"></i>' +
                '<span class="dhanvi-notif__badge" id="dhanviNotifBadge" hidden>0</span>' +
            '</button>' +
            '<div class="dhanvi-notif__panel" id="dhanviNotifPanel" role="dialog"' +
                ' aria-label="Notifications" aria-hidden="true" tabindex="-1">' +
                '<div class="dhanvi-notif__header">' +
                    '<div>' +
                        '<h3>Notifications</h3>' +
                        '<p class="dhanvi-notif__summary">' +
                            '<span id="dhanviNotifSummary">Loading…</span>' +
                            '<span class="dhanvi-notif__live is-connecting" id="dhanviNotifLive">' +
                                '<span class="dot"></span>Connecting' +
                            '</span>' +
                        '</p>' +
                    '</div>' +
                    '<div class="dhanvi-notif__header-actions">' +
                        '<button type="button" class="dhanvi-notif__text-btn" id="dhanviNotifMarkAll">Mark all read</button>' +
                        '<button type="button" class="dhanvi-notif__icon-btn" id="dhanviNotifClose"' +
                            ' aria-label="Close notifications">' +
                            '<i class="fa fa-times" aria-hidden="true"></i>' +
                        '</button>' +
                    '</div>' +
                '</div>' +
                '<div class="dhanvi-notif__toolbar" role="tablist" aria-label="Filter notifications">' +
                    '<button type="button" class="dhanvi-notif__filter active" data-filter="all"' +
                        ' role="tab" aria-selected="true">All' +
                        ' <span class="count" id="dhanviNotifCountAll">0</span></button>' +
                    '<button type="button" class="dhanvi-notif__filter" data-filter="unread"' +
                        ' role="tab" aria-selected="false">Unread' +
                        ' <span class="count" id="dhanviNotifCountUnread">0</span></button>' +
                    '<button type="button" class="dhanvi-notif__filter" data-filter="read"' +
                        ' role="tab" aria-selected="false">Read' +
                        ' <span class="count" id="dhanviNotifCountRead">0</span></button>' +
                '</div>' +
                '<div class="dhanvi-notif__list" id="dhanviNotifList" aria-live="polite"></div>' +
                '<div class="dhanvi-notif__footer">' +
                    '<a href="admin-notifications.html">View all notifications' +
                        ' <i class="fa fa-arrow-right" aria-hidden="true"></i></a>' +
                    '<button type="button" class="dhanvi-notif__clear" id="dhanviNotifClear">Clear all</button>' +
                '</div>' +
            '</div>';

        var profile = topbarRight.querySelector('.topbar-profile');
        if (profile && profile.parentNode === topbarRight) {
            topbarRight.insertBefore(wrapper, profile);
        } else {
            topbarRight.appendChild(wrapper);
        }

        return true;
    }

    function cacheEls() {
        els.root = document.querySelector('.dhanvi-notif[data-dhanvi-notifications]');
        els.bell = document.getElementById('dhanviNotifBell');
        els.badge = document.getElementById('dhanviNotifBadge');
        els.panel = document.getElementById('dhanviNotifPanel');
        els.list = document.getElementById('dhanviNotifList');
        els.summary = document.getElementById('dhanviNotifSummary');
        els.live = document.getElementById('dhanviNotifLive');
        els.markAll = document.getElementById('dhanviNotifMarkAll');
        els.close = document.getElementById('dhanviNotifClose');
        els.clear = document.getElementById('dhanviNotifClear');
        els.countAll = document.getElementById('dhanviNotifCountAll');
        els.countUnread = document.getElementById('dhanviNotifCountUnread');
        els.countRead = document.getElementById('dhanviNotifCountRead');
        els.filterButtons = els.panel
            ? els.panel.querySelectorAll('.dhanvi-notif__filter')
            : [];
    }

    function openPanel() {
        if (!els.panel) { return; }
        state.panelOpen = true;
        els.panel.classList.add('is-open');
        els.panel.setAttribute('aria-hidden', 'false');
        if (els.bell) { els.bell.setAttribute('aria-expanded', 'true'); }

        if (typeof els.panel.focus === 'function') {
            try {
                els.panel.focus({ preventScroll: true });
            } catch (err) {
                els.panel.focus();
            }
        }

        refresh();
    }

    function closePanel(restoreFocus) {
        if (!els.panel) { return; }
        state.panelOpen = false;
        els.panel.classList.remove('is-open');
        els.panel.setAttribute('aria-hidden', 'true');
        if (els.bell) {
            els.bell.setAttribute('aria-expanded', 'false');
            if (restoreFocus) {
                try {
                    els.bell.focus({ preventScroll: true });
                } catch (err) {
                    els.bell.focus();
                }
            }
        }
    }

    function togglePanel() {
        if (state.panelOpen) { closePanel(true); }
        else { openPanel(); }
    }

    function ringBell() {
        if (!els.bell) { return; }
        els.bell.classList.remove('is-ringing');
        void els.bell.offsetWidth;
        els.bell.classList.add('is-ringing');
        window.setTimeout(function () {
            if (els.bell) { els.bell.classList.remove('is-ringing'); }
        }, 800);
    }

    async function handleToggleRead(id, button) {
        var item = findItem(id);
        if (!item) { return; }

        var markAsRead = !item.is_read;
        if (button) { button.disabled = true; }

        try {
            await markRead(id, markAsRead);
            toast(
                'success',
                markAsRead ? 'Marked as read' : 'Marked as unread',
                markAsRead
                    ? 'The notification is now marked as read.'
                    : 'The notification is back in your unread list.'
            );
        } catch (err) {
            toast('error', 'Could not update notification', err.message || 'Please try again.');
        } finally {
            if (button && document.body.contains(button)) { button.disabled = false; }
        }
    }

    async function handleDelete(id, button) {
        var confirmed = await confirmAction({
            title: 'Delete notification?',
            message: 'This notification will be permanently removed from your inbox.',
            details: 'This action cannot be undone.',
            confirmLabel: 'Delete notification'
        });
        if (!confirmed) { return; }

        if (button) { button.disabled = true; }
        try {
            await remove(id);
            toast('success', 'Notification deleted', 'The notification has been removed.');
        } catch (err) {
            toast('error', 'Could not delete notification', err.message || 'Please try again.');
        } finally {
            if (button && document.body.contains(button)) { button.disabled = false; }
        }
    }

    async function handleMarkAll(button) {
        if (state.unreadCount === 0) { return; }
        if (button) { button.disabled = true; }

        try {
            var affected = await markAllRead();
            toast(
                'success',
                'All notifications marked as read',
                affected
                    ? affected + ' notification' + (affected === 1 ? '' : 's') + ' updated.'
                    : 'Your inbox is already up to date.'
            );
        } catch (err) {
            toast('error', 'Could not mark all as read', err.message || 'Please try again.');
        } finally {
            if (button) { button.disabled = false; }
            renderPanel();
        }
    }

    async function handleClearAll(button) {
        if (!state.items.length) { return; }

        var confirmed = await confirmAction({
            title: 'Clear all notifications?',
            message: 'This permanently removes every notification from your inbox.',
            details: 'This action cannot be undone.',
            confirmLabel: 'Clear all notifications'
        });
        if (!confirmed) { return; }

        if (button) { button.disabled = true; }
        try {
            var affected = await clearAll();
            toast(
                'success',
                'Notifications cleared',
                affected
                    ? affected + ' notification' + (affected === 1 ? '' : 's') + ' removed.'
                    : 'Your inbox was already empty.'
            );
        } catch (err) {
            toast('error', 'Could not clear notifications', err.message || 'Please try again.');
        } finally {
            if (button) { button.disabled = false; }
            renderPanel();
        }
    }

    function updateRelativeTimes() {
        var nodes = document.querySelectorAll('[data-relative-time]');
        Array.prototype.forEach.call(nodes, function (node) {
            node.textContent = relativeTime(node.getAttribute('data-relative-time'));
        });
    }

    function bindUI() {
        if (!els.root || !els.bell || !els.panel) { return; }

        els.bell.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            togglePanel();
        });

        if (els.close) {
            els.close.addEventListener('click', function (event) {
                event.stopPropagation();
                closePanel(true);
            });
        }

        if (els.markAll) {
            els.markAll.addEventListener('click', function (event) {
                event.stopPropagation();
                handleMarkAll(els.markAll);
            });
        }

        if (els.clear) {
            els.clear.addEventListener('click', function (event) {
                event.stopPropagation();
                handleClearAll(els.clear);
            });
        }

        Array.prototype.forEach.call(els.filterButtons || [], function (button) {
            button.addEventListener('click', function (event) {
                event.stopPropagation();
                state.activeFilter = button.getAttribute('data-filter') || 'all';
                renderPanel();
            });
        });

        els.list.addEventListener('click', function (event) {
            var retry = event.target.closest('[data-action="retry"]');
            if (retry) {
                refresh();
                return;
            }

            var itemElement = event.target.closest('.dhanvi-notif__item');
            if (!itemElement) { return; }

            var actionElement = event.target.closest('[data-action]');
            var action = actionElement ? actionElement.getAttribute('data-action') : null;
            var id = itemElement.getAttribute('data-id');

            if (action === 'toggle-read') {
                handleToggleRead(id, actionElement);
                return;
            }
            if (action === 'delete') {
                handleDelete(id, actionElement);
                return;
            }

            openNotification(id);
        });

        els.list.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter' && event.key !== ' ') { return; }
            if (event.target.closest('button')) { return; }

            var itemElement = event.target.closest('.dhanvi-notif__item');
            if (!itemElement) { return; }

            event.preventDefault();
            openNotification(itemElement.getAttribute('data-id'));
        });

        // Capture phase so the panel closes even when another handler stops
        // propagation (for example the profile dropdown).
        document.addEventListener('click', function (event) {
            if (!state.panelOpen) { return; }
            if (els.root && els.root.contains(event.target)) { return; }
            closePanel(false);
        }, true);

        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && state.panelOpen) {
                event.preventDefault();
                closePanel(true);
            }
        });
    }

    // -------------------------------------------------------------------------
    // Initialisation
    // -------------------------------------------------------------------------

    function init() {
        if (state.initialized) { return; }
        state.initialized = true;

        try {
            injectUI();
            cacheEls();
            bindUI();
            setupChannel();
            setConnection(state.connection);
            updateBadge();
            renderPanel();
            refresh();
            connect();

            window.setInterval(updateRelativeTimes, 30000);

            document.addEventListener('visibilitychange', function () {
                if (document.hidden) { return; }
                refresh();
                if (!state.ws || state.ws.readyState > 1) { connect(); }
            });

            window.addEventListener('online', function () {
                state.reconnectAttempts = 0;
                connect();
                refresh();
            });

            window.addEventListener('offline', function () {
                setConnection('offline');
            });

            window.addEventListener('focus', function () {
                if (Date.now() - state.lastRefreshAt > 60000) { refresh(); }
            });
        } catch (err) {
            if (window.console) { window.console.warn('Admin notifications could not start:', err); }
        } finally {
            readyResolve(API);
        }
    }

    var API = {
        ready: readyPromise,
        refresh: refresh,
        list: list,
        counts: counts,
        markRead: markRead,
        markAllRead: markAllRead,
        remove: remove,
        clearAll: clearAll,
        open: openNotification,
        getState: getState,
        on: on,
        off: off,
        utils: {
            relativeTime: relativeTime,
            fullTime: fullTime,
            typeMeta: typeMeta,
            escapeHtml: esc,
            confirm: confirmAction
        }
    };

    window.DhanviAdminNotifications = API;

    if (window.DhanviAdminReady && typeof window.DhanviAdminReady.then === 'function') {
        window.DhanviAdminReady.then(init).catch(function (err) {
            if (window.console) { window.console.warn('Admin notifications could not start:', err); }
            readyResolve(API);
        });
    } else if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})(window, document);

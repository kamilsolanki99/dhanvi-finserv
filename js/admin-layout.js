/**
 * Admin Layout & Auth Guard
 * Project: Dhanvi Finserv
 *
 * Validates the Nhost session, confirms that the signed-in user holds the
 * custom Hasura role "admin", loads the admin profile, and exposes shared UI
 * behaviour (sidebar highlight, profile menu, logout).
 *
 * Admin pages must wait for window.DhanviAdminReady before loading data:
 *
 *   window.DhanviAdminReady.then(function (ctx) { ... });
 */

(function (window, document) {
    'use strict';

    var readyResolve;
    window.DhanviAdminReady = new Promise(function (resolve) {
        readyResolve = resolve;
    });

    function redirectToLogin(message) {
        if (message) {
            try { window.sessionStorage.setItem('dhanviAdminLoginMessage', message); } catch (err) { /* ignore */ }
        }
        window.location.replace('admin-login.html');
    }

    var AdminLayout = {
        user: null,
        profile: null,

        async init() {
            var context;
            try {
                context = await this.checkAuth();
            } catch (err) {
                console.error('Admin auth guard failed:', err);
                redirectToLogin('Your session could not be verified. Please sign in again.');
                return;
            }

            if (!context) { return; }

            this.user = context.user;
            this.profile = context.profile;

            this.setupProfile();
            this.setupSidebar();
            this.setupProfileDropdown();

            window.DhanviAdmin = {
                user: this.user,
                profile: this.profile
            };
            readyResolve({ user: this.user, profile: this.profile });
            window.dispatchEvent(new CustomEvent('dhanvi:admin-ready', {
                detail: { user: this.user, profile: this.profile }
            }));
        },

        async checkAuth() {
            var backend = window.DhanviBackend;
            if (!backend || typeof backend.getClient !== 'function') {
                console.error('Nhost client helper is not loaded.');
                redirectToLogin('The admin service could not be loaded. Please try again.');
                return null;
            }

            var nhost = backend.getClient();
            if (!nhost) {
                redirectToLogin('The admin service is not configured. Please contact the site administrator.');
                return null;
            }

            var session = nhost.getUserSession();
            if (!session || !session.user) {
                console.log('No active Nhost session, redirecting to login.');
                redirectToLogin();
                return null;
            }

            // Re-validate the token with the auth server so a revoked or stale
            // session cannot keep an admin page open.
            var user;
            try {
                var response = await nhost.auth.getUser();
                user = response && response.body;
            } catch (err) {
                console.warn('Nhost session validation failed:', err);
                await backend.signOut();
                redirectToLogin('Your session has expired. Please sign in again.');
                return null;
            }

            if (!user || user.isAnonymous) {
                await backend.signOut();
                redirectToLogin('Please sign in with an administrator account.');
                return null;
            }

            if (!Array.isArray(user.roles) || user.roles.indexOf('admin') === -1) {
                console.error('Unauthorized: the signed-in user does not have the admin role.');
                await backend.signOut();
                redirectToLogin('Access denied. This account does not have administrator privileges.');
                return null;
            }

            // The JWT role alone is not enough: the profile row is the
            // application-level allow-list used by the admin panel.
            var profile = null;
            try {
                var data = await backend.adminGql(
                    'query AdminGuard($userId: uuid!) {' +
                    '  admin_profiles_by_pk(user_id: $userId) { user_id role full_name }' +
                    '}',
                    { userId: user.id }
                );
                profile = data && data.admin_profiles_by_pk;
            } catch (err) {
                console.error('Admin profile lookup failed:', err);
                await backend.signOut();
                redirectToLogin('Access denied. The administrator profile could not be verified.');
                return null;
            }

            if (!profile || profile.role !== 'admin') {
                console.error('Unauthorized: no admin_profiles row for this user.');
                await backend.signOut();
                redirectToLogin('Access denied. The administrator profile could not be verified.');
                return null;
            }

            return { user: user, profile: profile };
        },

        displayName() {
            if (this.profile && this.profile.full_name) { return this.profile.full_name; }
            if (this.user && this.user.displayName) { return this.user.displayName; }
            if (this.user && this.user.email) { return this.user.email; }
            return 'Admin User';
        },

        setupProfile() {
            var name = this.displayName();
            var email = (this.user && this.user.email) || '';
            var initials = name.split(/\s+/).filter(Boolean).map(function (part) {
                return part.charAt(0);
            }).join('').toUpperCase().substring(0, 2) || 'AD';

            var profileNameEl = document.querySelector('.topbar-profile-name');
            var profileAvatarEl = document.querySelector('.topbar-avatar');
            var profileEmailEl = document.querySelector('.topbar-profile-email');

            if (profileNameEl) { profileNameEl.textContent = name; }
            if (profileAvatarEl) { profileAvatarEl.textContent = initials; }
            if (profileEmailEl) { profileEmailEl.textContent = email; }
        },

        setupSidebar() {
            var currentPath = window.location.pathname;
            var filename = currentPath.substring(currentPath.lastIndexOf('/') + 1) || 'index.html';

            Array.prototype.forEach.call(document.querySelectorAll('.sidebar-nav a'), function (link) {
                if (link.getAttribute('href') === filename) {
                    link.classList.add('active');
                } else {
                    link.classList.remove('active');
                }
            });
        },

        setupProfileDropdown() {
            var profileToggle = document.querySelector('.topbar-profile');
            if (!profileToggle) {
                console.warn('AdminLayout: .topbar-profile not found.');
                return;
            }
            this._executeDropdownSetup(profileToggle);
        },

        _executeDropdownSetup(profileToggle) {
            if (document.getElementById('admin-profile-dropdown')) { return; }

            var dropdown = document.createElement('div');
            dropdown.className = 'profile-dropdown-menu';
            dropdown.id = 'admin-profile-dropdown';
            dropdown.innerHTML =
                '<div class="dropdown-header" style="padding: 12px 16px; font-size: 11px; color: #aaa; text-transform: uppercase; font-weight: 600; border-bottom: 1px solid #edf0f5;">Account</div>' +
                '<div class="dropdown-item" id="adminProfileLink"><i class="fa fa-user"></i> My Profile</div>' +
                '<div class="dropdown-item" id="adminSettingsLink"><i class="fa fa-cog"></i> Account Settings</div>' +
                '<div class="dropdown-item" id="adminPasswordLink"><i class="fa fa-lock"></i> Change Password</div>' +
                '<div class="dropdown-divider"></div>' +
                '<div class="dropdown-item logout-btn" id="adminLogout"><i class="fa fa-sign-out"></i> Logout</div>';

            var style = document.createElement('style');
            style.textContent =
                '.profile-dropdown-menu {' +
                '  position: fixed !important;' +
                '  background: #fff !important;' +
                '  box-shadow: 0 4px 20px rgba(0,0,0,0.2) !important;' +
                '  border-radius: 8px !important;' +
                '  width: 200px !important;' +
                '  display: none;' +
                '  z-index: 999999 !important;' +
                '  overflow: hidden !important;' +
                '  border: 1px solid #edf0f5 !important;' +
                "  font-family: 'Poppins', sans-serif !important;" +
                '  color: #333 !important;' +
                '}' +
                '.profile-dropdown-menu.show { display: block !important; }' +
                '.dropdown-item {' +
                '  padding: 12px 16px !important;' +
                '  font-size: 13px !important;' +
                '  color: #5d6b80 !important;' +
                '  cursor: pointer !important;' +
                '  display: flex !important;' +
                '  align-items: center !important;' +
                '  gap: 10px !important;' +
                '  transition: background 0.2s !important;' +
                '}' +
                '.dropdown-item:hover { background: #f8fafc !important; color: #15549a !important; }' +
                '.dropdown-divider { height: 1px !important; background: #edf0f5 !important; }' +
                '.logout-btn { color: #e14b4b !important; }' +
                '.logout-btn:hover { background: #fdf0f0 !important; color: #c93030 !important; }';
            document.head.appendChild(style);
            document.body.appendChild(dropdown);

            function goToSettings() {
                window.location.href = 'admin-settings.html';
            }

            function updatePosition() {
                var rect = profileToggle.getBoundingClientRect();
                dropdown.style.top = (rect.bottom + 5) + 'px';
                dropdown.style.left = Math.max(8, rect.right - 200) + 'px';
            }

            profileToggle.addEventListener('click', function (event) {
                event.preventDefault();
                event.stopPropagation();
                updatePosition();
                dropdown.classList.toggle('show');
            });

            document.addEventListener('click', function (event) {
                if (!profileToggle.contains(event.target) && !dropdown.contains(event.target)) {
                    dropdown.classList.remove('show');
                }
            });

            document.getElementById('adminProfileLink').addEventListener('click', goToSettings);
            document.getElementById('adminSettingsLink').addEventListener('click', goToSettings);
            document.getElementById('adminPasswordLink').addEventListener('click', goToSettings);

            document.getElementById('adminLogout').addEventListener('click', async function (event) {
                event.stopPropagation();
                try {
                    await window.DhanviBackend.signOut();
                } finally {
                    window.location.href = 'admin-login.html';
                }
            });
        }
    };

    window.DhanviAdminLayout = AdminLayout;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { AdminLayout.init(); });
    } else {
        AdminLayout.init();
    }
})(window, document);

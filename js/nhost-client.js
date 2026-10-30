/**
 * Dhanvi Finserv - Nhost client and secure backend helpers.
 *
 * This is the ONLY place that knows the Nhost project configuration.
 * Replace the two placeholder values below with the subdomain and region
 * shown in the Nhost dashboard (Project -> Settings -> General).
 *
 * The client is loaded on both public and admin pages:
 *   <script src="https://cdn.jsdelivr.net/npm/@nhost/nhost-js@4.9.0/dist/nhost-js.umd.js"></script>
 *   <script src="js/nhost-client.js"></script>
 */
(function (window) {
    'use strict';

    var CONFIG = window.DHANVI_NHOST_CONFIG || {
        subdomain: 'yybitlaloiggcvxntptp',
        region: 'ap-south-1'
    };

    var client = null;
    var anonymousPromise = null;

    function isConfigured() {
        return !!CONFIG.subdomain &&
            !!CONFIG.region &&
            CONFIG.subdomain.indexOf('YOUR_') !== 0 &&
            CONFIG.region.indexOf('YOUR_') !== 0;
    }

    function getClient() {
        if (client) { return client; }
        if (!isConfigured()) {
            console.error('Nhost is not configured. Set the subdomain and region in js/nhost-client.js.');
            return null;
        }
        if (!window.NhostJs || typeof window.NhostJs.createClient !== 'function') {
            console.error('The Nhost SDK did not load. Check the CDN script tag.');
            return null;
        }
        client = window.NhostJs.createClient({
            subdomain: CONFIG.subdomain,
            region: CONFIG.region
        });
        return client;
    }

    function getSession() {
        var nhost = getClient();
        return nhost ? nhost.getUserSession() : null;
    }

    function currentUser() {
        var session = getSession();
        return session && session.user ? session.user : null;
    }

    function isAdminUser(user) {
        return !!(user && Array.isArray(user.roles) && user.roles.indexOf('admin') !== -1);
    }

    function normalizeError(err) {
        var gqlError = err && err.body && err.body.errors && err.body.errors[0];
        var internal = gqlError && gqlError.extensions && gqlError.extensions.internal &&
            gqlError.extensions.internal.error;
        var message = (gqlError && gqlError.message) || (err && err.message) || 'Something went wrong. Please try again.';

        // Hasura reports a generic "database query error" for Postgres errors
        // whose SQLSTATE is not P0001. Our functions raise user-facing
        // validation messages, so surface the real message when available.
        if (message === 'database query error' && internal && internal.message) {
            message = internal.message;
        }

        var code = (gqlError && gqlError.extensions && (gqlError.extensions.code || gqlError.extensions.sqlState)) ||
            (internal && internal.status_code) ||
            (err && err.body && err.body.error) ||
            (err && err.code);
        var out = new Error(message);
        out.code = code;
        out.original = err;
        return out;
    }

    function errorMessage(err) {
        var message = (err && err.message) ? String(err.message) : 'Something went wrong. Please try again.';
        var code = err && err.code;

        if (code === 'invalid-email-password' || /invalid email or password/i.test(message)) {
            return 'Invalid email or password.';
        }
        if (code === 'unverified-user') {
            return 'Please verify your email address before signing in.';
        }
        if (code === 'signup-disabled' || code === 'disabled-endpoint') {
            return 'Sign-in is temporarily unavailable. Please contact the administrator.';
        }
        if (/Failed to fetch|NetworkError|Load failed|fetch/i.test(message)) {
            return 'We could not reach the secure server. Please check your connection and try again.';
        }
        if (/JWT|apikey|permission denied|permission-error|not allowed|access-denied|permission-denied|x-hasura-role/i.test(message)) {
            return 'The secure service is temporarily unavailable. Please call +91 99250 02324 or try again later.';
        }
        return message;
    }

    async function signOut() {
        var nhost = getClient();
        if (!nhost) { return; }
        var session = nhost.getUserSession();
        try {
            await nhost.auth.signOut(session && session.refreshToken
                ? { refreshToken: session.refreshToken }
                : {});
        } catch (err) {
            console.warn('Nhost sign-out request failed; clearing the local session anyway.', err);
        }
        nhost.clearSession();
        // A cached anonymous sign-in must not be reused after sign-out.
        anonymousPromise = null;
    }

    /**
     * The public upload page needs a real Nhost session because Nhost Storage
     * checks Hasura permissions for storage.files. Anonymous sessions are
     * created on demand and reused for the rest of the browser session.
     */
    async function ensureAnonymousSession() {
        var nhost = getClient();
        if (!nhost) {
            throw new Error('The secure upload service is not configured. Please call +91 99250 02324.');
        }

        var session = nhost.getUserSession();
        if (session && session.user) {
            if (session.user.isAnonymous) { return session; }
            if (isAdminUser(session.user)) { return session; }
            // A normal signed-up user has no upload permissions. Replace that
            // session with an anonymous one so the public page keeps working.
            await signOut();
        }

        if (!anonymousPromise) {
            anonymousPromise = nhost.auth.signInAnonymous()
                .then(function (response) {
                    var newSession = response && response.body && response.body.session;
                    if (!newSession) {
                        throw new Error('Could not start a secure upload session. Please try again.');
                    }
                    return newSession;
                })
                .catch(function (err) {
                    anonymousPromise = null;
                    throw normalizeError(err);
                });
        }
        await anonymousPromise;
        var current = nhost.getUserSession();
        if (!current || !current.user) {
            anonymousPromise = null;
            throw new Error('Could not start a secure upload session. Please try again.');
        }
        return current;
    }

    // Exact GraphQL argument types for every tracked custom function.
    var RPC_DEFINITIONS = {
        submit_loan_application_v2: {
            type: 'mutation',
            args: { p_payload: 'jsonb' }
        },
        book_callback: {
            type: 'mutation',
            args: {
                p_full_name: 'String',
                p_mobile: 'String',
                p_email: 'String',
                p_date: 'date',
                p_slot: 'String',
                p_notes: 'String',
                p_application_reference: 'String',
                p_consent: 'Boolean'
            }
        },
        get_booked_callback_slots: {
            type: 'query',
            args: { p_date: 'date' }
        },
        submit_post_disbursal_request: {
            type: 'mutation',
            args: {
                p_full_name: 'String',
                p_mobile: 'String',
                p_email: 'String',
                p_loan_reference_no: 'String',
                p_request_type: 'String',
                p_description: 'String',
                p_consent: 'Boolean'
            }
        },
        submit_complaint: {
            type: 'mutation',
            args: {
                p_full_name: 'String',
                p_mobile: 'String',
                p_email: 'String',
                p_category: 'String',
                p_loan_reference_no: 'String',
                p_description: 'String',
                p_consent: 'Boolean'
            }
        },
        lookup_application: {
            type: 'query',
            args: {
                p_reference: 'String',
                p_mobile: 'String',
                p_email: 'String'
            }
        },
        get_application_by_token: {
            type: 'query',
            args: {
                p_lead_id: 'uuid',
                p_access_token: 'uuid'
            }
        },
        register_document: {
            type: 'mutation',
            args: {
                p_lead_id: 'uuid',
                p_access_token: 'uuid',
                p_document_type: 'String',
                p_storage_file_id: 'uuid'
            }
        },
        get_application_documents: {
            type: 'query',
            args: {
                p_lead_id: 'uuid',
                p_access_token: 'uuid'
            }
        }
    };

    /**
     * Call a tracked Hasura custom function. Functions return SETOF api_result,
     * so the result is an array of { payload } rows. A single row is unwrapped
     * to its payload object; multiple rows are returned as an array of payloads.
     */
    async function rpc(name, params) {
        var definition = RPC_DEFINITIONS[name];
        if (!definition) {
            throw new Error('Unknown secure service operation: ' + name);
        }

        var nhost = getClient();
        if (!nhost) {
            throw new Error('The secure service could not be loaded. Please refresh the page or call +91 99250 02324.');
        }

        var variables = {};
        var variableDefinitions = [];
        var argumentFields = [];
        var values = params || {};

        Object.keys(definition.args).forEach(function (argName) {
            var graphqlType = definition.args[argName];
            variables[argName] = values[argName] === undefined ? null : values[argName];
            variableDefinitions.push('$' + argName + ': ' + graphqlType);
            argumentFields.push(argName + ': $' + argName);
        });

        var operation = definition.type === 'mutation' ? 'mutation' : 'query';
        var query = operation + ' DhanviRpc(' + variableDefinitions.join(', ') + ') { ' +
            name + '(args: { ' + argumentFields.join(', ') + ' }) { payload } }';

        var response;
        try {
            response = await nhost.graphql.request({ query: query, variables: variables });
        } catch (err) {
            throw normalizeError(err);
        }

        var data = response && response.body && response.body.data;
        var rows = data && data[name] ? data[name] : [];
        var payloads = rows.map(function (row) { return row.payload; });

        if (payloads.length === 0) { return null; }
        if (payloads.length === 1) { return payloads[0]; }
        return payloads;
    }

    /**
     * Admin GraphQL. The x-hasura-role header selects the custom admin role;
     * Hasura rejects the request unless the JWT contains that allowed role.
     */
    async function adminGql(query, variables) {
        var nhost = getClient();
        if (!nhost) {
            throw new Error('The secure service could not be loaded. Please refresh the page.');
        }
        try {
            var response = await nhost.graphql.request(
                { query: query, variables: variables || {} },
                { headers: { 'x-hasura-role': 'admin' } }
            );
            return response.body.data;
        } catch (err) {
            throw normalizeError(err);
        }
    }

    async function uploadFile(file) {
        var nhost = getClient();
        if (!nhost) {
            throw new Error('The secure upload service could not be loaded. Please refresh the page.');
        }
        var response;
        try {
            response = await nhost.storage.uploadFiles({
                'bucket-id': 'loan-documents',
                'file[]': [file]
            });
        } catch (err) {
            throw normalizeError(err);
        }
        var files = response && response.body && response.body.processedFiles;
        if (!files || !files.length) {
            throw new Error('The file could not be uploaded. Please try again.');
        }
        return files[0];
    }

    /**
     * Delete one private storage file. Only administrators have delete access
     * to the loan-documents bucket; the admin panel uses this after removing
     * the matching database record.
     */
    async function deleteFile(fileId) {
        var nhost = getClient();
        if (!nhost) {
            throw new Error('The secure document service could not be loaded.');
        }
        if (!fileId) { return; }
        try {
            await nhost.storage.deleteFile(fileId);
        } catch (err) {
            throw normalizeError(err);
        }
    }

    async function getFileUrl(fileId) {
        var nhost = getClient();
        if (!nhost) {
            throw new Error('The secure document service could not be loaded.');
        }
        var response;
        try {
            response = await nhost.storage.getFilePresignedURL(fileId);
        } catch (err) {
            throw normalizeError(err);
        }
        var url = response && response.body && response.body.url;
        if (!url) {
            throw new Error('A secure document link could not be generated.');
        }
        return url;
    }

    async function changePassword(newPassword) {
        var nhost = getClient();
        if (!nhost) {
            throw new Error('The secure account service could not be loaded.');
        }
        try {
            await nhost.auth.changeUserPassword({ newPassword: newPassword });
        } catch (err) {
            throw normalizeError(err);
        }
    }

    window.getNhostClient = getClient;
    window.DhanviBackend = {
        config: CONFIG,
        isConfigured: isConfigured,
        getClient: getClient,
        getSession: getSession,
        currentUser: currentUser,
        isAdminUser: isAdminUser,
        ensureAnonymousSession: ensureAnonymousSession,
        signOut: signOut,
        rpc: rpc,
        adminGql: adminGql,
        uploadFile: uploadFile,
        deleteFile: deleteFile,
        getFileUrl: getFileUrl,
        changePassword: changePassword,
        errorMessage: errorMessage,
        normalizeError: normalizeError
    };
})(window);

# Nhost setup — Dhanvi Finserv

This site uses **Nhost** for Postgres, Hasura GraphQL, Auth and private file
storage. There is no Supabase dependency left in the frontend.

The browser only ever receives the Nhost **subdomain** and **region**. Never put
the Hasura admin secret, a service key, a database password or a JWT signing key
in any file under this repository.

---

## 1. Project values

Open the Nhost dashboard for the **Dhanvi Finserv** project and copy:

- **Subdomain** — Project → Settings → General
- **Region** — Project → Settings → General (for example `eu-central-1`)

Put them in `js/nhost-client.js`:

```js
var CONFIG = window.DHANVI_NHOST_CONFIG || {
    subdomain: 'your-subdomain',
    region: 'your-region'
};
```

The project ID in the dashboard URL is **not** necessarily the subdomain.

---

## 2. Run the database migration

1. Open the Nhost dashboard.
2. Go to **Database → SQL Editor**.
3. Paste the entire contents of `nhost/migrations/001_init.sql`.
4. Run it once.

The script creates the business tables, the `api_result` helper table, the
server-side functions, the private `loan-documents` bucket and the custom
`admin` auth role.

If you already ran `001_init.sql` before **30 October 2026**, also run
[`migrations/002_register_document_null_uploader.sql`](migrations/002_register_document_null_uploader.sql).
It lets `register_document` accept uploads when Nhost leaves the deprecated
`storage.files.uploaded_by_user_id` column empty, while still enforcing the
ownership check whenever the column is populated.

Then run
[`migrations/003_admin_notifications.sql`](migrations/003_admin_notifications.sql).
It creates the admin notification inbox, its indexes, the read-state trigger and
the real business-event triggers. The script is idempotent and safe to run
again.

Do **not** enable Postgres RLS on these tables. Access is enforced by Hasura
permissions, which is how Nhost is designed to work.

---

## 3. Track tables and functions in Hasura

Open **GraphQL → Hasura Console → Data**.

### 3.1 Track these tables

Under `public`:

- `admin_profiles`
- `admin_notifications`
- `loan_leads`
- `loan_applicants`
- `callback_bookings`
- `post_disbursal_requests`
- `complaints`
- `loan_documents`
- `loan_followups`
- `api_result`

`api_result` is only a return-type carrier for the functions. It is never
written by the application.

### 3.2 Track these functions

Under **Data → SQL → Track** (or the “Untracked functions” list):

- `submit_loan_application_v2`
- `book_callback`
- `get_booked_callback_slots`
- `submit_post_disbursal_request`
- `submit_complaint`
- `lookup_application`
- `get_application_by_token`
- `register_document`
- `get_application_documents`

Hasura needs each function to return `SETOF public.api_result`, which the
migration already does. `VOLATILE` functions are mutations; `STABLE` functions
are queries.

---

## 4. Hasura permissions

Open **Data → [table] → Permissions** and add the rows below. Do not grant
anything to the `user` role: a normal signed-up user must have no business-table
access.

### 4.1 `api_result`

| Role | select | insert | update | delete |
| --- | --- | --- | --- | --- |
| `public` | yes | no | no | no |
| `anonymous` | yes | no | no | no |
| `admin` | yes | no | no | no |

`api_result` only needs `select`; the functions are `SECURITY DEFINER` and
insert nothing into it.

### 4.2 Function permissions

Open **Data → [function] → Permissions**.

| Function | `public` | `anonymous` | `admin` |
| --- | --- | --- | --- |
| `submit_loan_application_v2` | execute | execute | execute |
| `book_callback` | execute | execute | execute |
| `get_booked_callback_slots` | execute | execute | execute |
| `submit_post_disbursal_request` | execute | execute | execute |
| `submit_complaint` | execute | execute | execute |
| `lookup_application` | execute | execute | execute |
| `get_application_by_token` | execute | execute | execute |
| `get_application_documents` | execute | execute | execute |
| `register_document` | **no** | execute | execute |

`register_document` requires an authenticated Nhost session, so it must not be
available to the unauthenticated `public` role. It is limited to `anonymous`
(the public upload page) and `admin`.

The `user` role intentionally has no execute permissions. A customer who has
signed up through the Nhost API (there is no signup form on the site) must sign
out before using the public forms; see the troubleshooting table.

### 4.3 Business tables for `admin`

Grant only what the admin panel uses:

| Table | select | insert | update | delete |
| --- | --- | --- | --- | --- |
| `admin_profiles` | yes | no | yes | no |
| `admin_notifications` | yes | no | yes | yes |
| `loan_leads` | yes | no | yes | yes |
| `loan_applicants` | yes | no | no | no |
| `loan_documents` | yes | no | yes | yes |
| `loan_followups` | yes | no | yes | yes |
| `callback_bookings` | yes | no | yes | yes |
| `post_disbursal_requests` | yes | no | yes | yes |
| `complaints` | yes | no | yes | yes |

The admin panel exposes a confirmed, permanent delete action for leads,
documents, follow-ups, callbacks, support requests and complaints. Grant
`delete` only on those tables. Deleting a `loan_leads` row cascades to
`loan_applicants`, `loan_documents` and `loan_followups`; linked callbacks,
complaints and support requests are kept with `loan_lead_id` set to `NULL`
(`ON DELETE SET NULL`). `admin_profiles` and `loan_applicants` must not be
deletable from the admin UI.

For `admin_profiles` update, allow only `full_name` (and `updated_at` is
maintained by the trigger). Restrict the update columns per table to match the
admin panel:

| Table | Columns the admin panel updates |
| --- | --- |
| `admin_profiles` | `full_name` |
| `loan_leads` | `status`, `admin_notes` |
| `loan_documents` | `status`, `notes`, `verified_by`, `verification_date` |
| `loan_followups` | `status`, `notes` |
| `callback_bookings` | `status`, `admin_notes`, `preferred_date`, `preferred_slot`, `rescheduled_to_date`, `rescheduled_to_slot` |
| `post_disbursal_requests` | `status`, `admin_notes`, `resolved_at` |
| `complaints` | `status`, `resolution_details`, `resolved_at` |

Do not add `public` or `anonymous` permissions on any business table.

### 4.4 `admin_notifications` permissions

The notification inbox is written only by the `SECURITY DEFINER` triggers in
migration `003`. The browser must never be able to insert a notification.

For the `admin` role:

| Permission | Configuration |
| --- | --- |
| `select` | All columns. Row filter: `_or: [{recipient_user_id: {_is_null: true}}, {recipient_user_id: {_eq: "X-Hasura-User-Id"}}]`. Enable **Allow aggregations**. |
| `update` | Columns: **`is_read` only**. Same row filter as `select`. |
| `delete` | Same row filter as `select`. |
| `insert` | **No permission.** |

**Allow aggregations** is required: the bell badge, dropdown summary and
Notification Center totals use `admin_notifications_aggregate`. Without it,
Hasura returns a permission error for the aggregate fields and the inbox shows
as unavailable.

The row filter is the authorization boundary: an administrator can only see,
update or delete notifications addressed to their own `auth.users.id`, plus
shared notifications with `recipient_user_id = NULL`.

Do **not** grant `read_at` or `read_by` as update columns. The
`set_admin_notification_read_state` trigger writes them from the verified
Hasura session and preserves them when `is_read` does not change.

Hasura real-time subscriptions use the same `select` permission. Once the table
is tracked and the permission is saved, no extra real-time configuration is
needed. The admin panel subscribes over the Nhost GraphQL WebSocket endpoint and
falls back to polling if the socket cannot connect.

The trigger creates one private notification per row in `admin_profiles`, so
mark-read and delete actions are isolated per administrator. If no admin profile
exists yet, it writes one shared row so the event is not lost.

### 4.5 Column presets / insert permissions

No column presets are needed on the business tables because the public site
never inserts into them directly. All public writes go through the
`SECURITY DEFINER` functions.

---

## 5. Storage permissions

The bucket is created by the migration. Confirm it in **Storage → Buckets**:

- ID: `loan-documents`
- Access: private — no `public` role permissions (configured in the next step)
- Maximum file size: 5 MB
- Presigned URLs: enabled, 60-second expiry

Then open **Storage → Permissions** (the grid at the bottom of the Storage
sidebar). Nhost configures `storage.files` permissions from this grid; do not
try to grant storage access from the Hasura table permissions screen.

### `anonymous` role

- **Upload** — custom check: `bucket_id` equals `loan-documents`
- **Uploader identity** — enabled (prefills `uploaded_by_user_id` with
  `X-Hasura-User-Id`)
- **Download / Replace / Delete** — no access

### `admin` role

- **Download** — custom check: `bucket_id` equals `loan-documents`
- **Upload** — custom check: `bucket_id` equals `loan-documents`
- **Uploader identity** — enabled (prefills `uploaded_by_user_id` with
  `X-Hasura-User-Id`)
- **Delete** — required: after an administrator removes a document or lead
  record, the admin panel best-effort deletes the matching private storage file.
- **Replace** — not used by the admin panel.

Admin Upload is required because `ensureAnonymousSession()` reuses an existing
admin session instead of signing the administrator out. The public upload page
therefore works for an admin too, and `register_document` records the upload as
`admin` rather than `customer`.

### `public` and `user` roles

No storage access.

> **Note:** `storage.files.uploaded_by_user_id` is deprecated in Nhost Storage.
> Some projects leave it `NULL` even when **Uploader identity** is enabled.
> `register_document` enforces the ownership match only when the column is
> populated; migration `002` contains that behaviour.

The upload flow is:

1. The browser opens an anonymous Nhost session.
2. The file is uploaded to the private bucket.
3. `register_document` reads the file name, size and MIME type from
   `storage.files`, verifies the uploader, and stores the metadata.

Failed registrations leave an orphaned file in the bucket. That is deliberate:
anonymous customers are not allowed to delete files, so a bad actor cannot
remove evidence. An administrator can clean up orphaned files from the Nhost
dashboard.

---

## 6. Auth settings

In **Auth → Settings**:

- **Signup**: enabled.
  Anonymous sign-in is rejected when signup is disabled, so this must stay on.
  Security comes from the `user` role having no permissions, not from disabling
  signup.
- **Anonymous users**: enabled.
- **Email verification**: optional, but the admin account must be verified
  before it can sign in if verification is on.

Nhost assigns anonymous users the `anonymous` role, not `user`.

---

## 7. Create the administrator account

1. In **Auth → Users**, add the administrator with an email and password.
2. Verify the email if verification is enabled.
3. Run this SQL in **Database → SQL Editor**, replacing the email:

```sql
-- Make sure the custom role exists (the migration already inserts it).
INSERT INTO auth.roles (role) VALUES ('admin')
ON CONFLICT (role) DO NOTHING;

-- Add the role to the user and make it the default Hasura role.
INSERT INTO auth.user_roles (user_id, role)
SELECT id, 'admin' FROM auth.users WHERE email = 'admin@example.com'
ON CONFLICT DO NOTHING;

UPDATE auth.users
SET default_role = 'admin'
WHERE email = 'admin@example.com';

-- Application-level allow-list used by js/admin-layout.js.
INSERT INTO public.admin_profiles (user_id, role, full_name)
SELECT id, 'admin', 'Administrator'
FROM auth.users
WHERE email = 'admin@example.com'
ON CONFLICT (user_id) DO UPDATE
SET role = 'admin';
```

The administrator must sign out and sign in again after this SQL so the JWT
contains the `admin` role.

The admin pages send `x-hasura-role: admin` explicitly. The JWT must contain
`admin` in `x-hasura-allowed-roles`; the SQL above ensures that.

---

## 8. Verify the setup

First run [`verify_setup.sql`](verify_setup.sql) in **Database → SQL Editor**.
It is read-only and returns a single JSON report confirming the tables, columns,
functions, triggers, indexes, private bucket, `admin` role, sequence and
`api_result` grant. Every expected object should show `OK`. The report includes
`admin_notifications`, the notification triggers and their indexes.

Then test the full flow:

1. Open the public site and submit a loan application. It should return a
   `DF-2026-xxxxx` reference and an upload link.
2. Open the upload link, choose a PDF or image and upload it. The document
   should appear as **Pending**.
3. Sign in at `admin-login.html` with the administrator account.
4. Check **Documents**, open the file with **Open document securely**, and
   verify the 60-second presigned link works.
5. Check **Callbacks**, **Support Requests** and **Complaints** after submitting
   each public form.
6. Try to sign in with a non-admin account. The guard must sign it out and
   return it to the login page.
7. Open the admin panel in two tabs. Submit a new public form (or upload a
   document). The bell and unread badge must update in both tabs without a
   refresh.
8. Open the bell, then mark one notification read/unread, mark all read, delete
   one and clear all. Confirm that the badge and the Notification Center counts
   stay correct.
9. Open `admin-notifications.html` and test All/Unread/Read, search, type
   filter, newest/oldest sort and **Load more**.
10. Refresh the page and sign out/in. The unread count must still match the
    database.

---

## 9. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `field 'submit_loan_application_v2' not found` | The function is not tracked in Hasura. Track it under Data → SQL. |
| `permission denied for function ...` | Add the execute permission for the correct role in Hasura. |
| `permission denied for table api_result` | Grant `select` on `api_result` to that role in Hasura. |
| `Anonymous sign-in is disabled` / `signup-disabled` | Enable signup and anonymous users in Auth settings. |
| Upload fails with `permission-error` | Storage → Permissions → `anonymous` needs Upload on `loan-documents` with uploader identity enabled. |
| Admin upload fails from the public upload page | Give the `admin` role Upload + uploader identity on `loan-documents` in Storage → Permissions. |
| `This file does not belong to your upload session` | The upload was made without the anonymous session, or the file was uploaded by a different session. Reload the page and retry. |
| Admin document link fails | `admin` needs Download permission on `loan-documents` in Storage → Permissions. |
| Admin page redirects to login immediately | The JWT does not contain the `admin` role, or `admin_profiles` has no row. Re-run section 7 and sign in again. |
| `The administrator profile could not be verified` | The `admin_profiles` row is missing or the Hasura role header is not accepted. Check section 7. |
| Public forms fail while signed in | A normal Nhost `user` account intentionally has no execute permissions. Sign out (or use a private window); customers normally use the site without an account. |
| `field 'admin_notifications' not found` | Migration `003` has not been run, or the table is not tracked in Hasura. Run the migration and track the table under Data. |
| `permission denied for table admin_notifications` | The `admin` select/update/delete permissions or the recipient row filter are missing. See section 4.4. |
| The bell says **Notifications unavailable** | The table is missing, untracked, the `admin` select permission is missing, or **Allow aggregations** is off. Run `verify_setup.sql` and check section 4.4. |
| New records do not create notifications | Run migration `003` and confirm the seven notification triggers exist. The trigger needs at least one row in `admin_profiles`; without one it writes a shared notification instead. |
| Real-time updates do not arrive instantly | The WebSocket may be blocked by a proxy or firewall. The panel automatically falls back to polling every 30 seconds. Allow `wss://*.nhost.run` and check the browser console. |
| Notifications disappear for another admin | Each admin receives a private row, so delete/clear is isolated. Shared `recipient_user_id = NULL` rows are intentionally visible to all admins. |

---

## 10. Hosting

The site is static HTML/CSS/JS. It can be hosted on any static host (Netlify,
Cloudflare Pages, GitHub Pages, Hostinger, GoDaddy cPanel, etc.). Nhost hosts
the database, auth, GraphQL API and files, not the HTML.

Owning a GoDaddy domain is not the same as having hosting. Point the domain at
the static host only after the host is chosen and the files are uploaded.

Never upload `nhost/` to a public web root. Only the site files (`*.html`,
`css/`, `js/`, `images/`, fonts, etc.) need to be published.

---

## 11. Security checklist

- [ ] No service-role key, admin secret or database password in the frontend.
- [ ] `loan-documents` bucket is private.
- [ ] `public` and `anonymous` have no business-table permissions.
- [ ] `register_document` is not executable by `public`.
- [ ] `user` role has no business-table permissions.
- [ ] `admin_notifications` has no insert permission for any browser role.
- [ ] Admin notification select/update/delete use the recipient row filter.
- [ ] The notification select permission has **Allow aggregations** enabled.
- [ ] The notification update permission is limited to `is_read`.
- [ ] Admin role is granted only through `auth.user_roles` + `admin_profiles`.
- [ ] Presigned document links expire quickly and are never stored in the page.
- [ ] RLS is not enabled; Hasura permissions are the access-control layer.

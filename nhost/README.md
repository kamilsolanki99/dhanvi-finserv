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

Do **not** enable Postgres RLS on these tables. Access is enforced by Hasura
permissions, which is how Nhost is designed to work.

---

## 3. Track tables and functions in Hasura

Open **GraphQL → Hasura Console → Data**.

### 3.1 Track these tables

Under `public`:

- `admin_profiles`
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
| `loan_leads` | yes | no | yes | no |
| `loan_applicants` | yes | no | no | no |
| `loan_documents` | yes | no | yes | no |
| `loan_followups` | yes | no | yes | no |
| `callback_bookings` | yes | no | yes | no |
| `post_disbursal_requests` | yes | no | yes | no |
| `complaints` | yes | no | yes | no |

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

### 4.4 Column presets / insert permissions

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
- **Replace / Delete** — optional; the admin panel only downloads

Admin Upload is required because `ensureAnonymousSession()` reuses an existing
admin session instead of signing the administrator out. The public upload page
therefore works for an admin too, and `register_document` records the upload as
`admin` rather than `customer`.

### `public` and `user` roles

No storage access.

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
`api_result` grant. Every expected object should show `OK`.

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
- [ ] Admin role is granted only through `auth.user_roles` + `admin_profiles`.
- [ ] Presigned document links expire quickly and are never stored in the page.
- [ ] RLS is not enabled; Hasura permissions are the access-control layer.

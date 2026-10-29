<p align="center">
  <img src="images/logo.png" alt="Dhanvi Finserv" width="220">
</p>

<h1 align="center">Dhanvi Finserv</h1>

<p align="center">
  Loan consultancy website and secure customer-service portal for an Ahmedabad-based loan advisory.
</p>

<p align="center">
  <img alt="Static frontend" src="https://img.shields.io/badge/frontend-static%20HTML%2FCSS%2FJS-15549a">
  <img alt="Nhost backend" src="https://img.shields.io/badge/backend-Nhost%20%2B%20Hasura-1f2937">
  <img alt="No build step" src="https://img.shields.io/badge/build-none-0f766e">
</p>

> **Project status:** the static frontend is complete. The Nhost backend must be
> configured before the forms, document uploads and admin portal will work.
> Follow [`nhost/README.md`](nhost/README.md) for the full setup.

---

## About the project

Dhanvi Finserv is an independent loan advisory based in Ahmedabad, Gujarat,
founded by Kamil and Dhara Solanki. The team helps individuals and businesses
compare offers from banks and NBFCs and manages the process from enquiry to
disbursal.

This repository contains:

- The public marketing website.
- The customer self-service journeys.
- The internal admin portal used by the Dhanvi Finserv team.

It is deliberately a **static site**: plain HTML, CSS and JavaScript with no
React/Next.js, no bundler and no build step. **Nhost** provides the database,
GraphQL API, authentication and private file storage.

---

## Features

### Public website

- Loan product pages: home loan, home loan top-up, home loan takeover, loan
  against property, education loan, vehicle loan, business loan and personal
  loan.
- ITR filing service page.
- EMI calculator and loan eligibility checker.
- Document checklist, FAQs, blog, team, about and contact pages.
- SEO metadata, sitemap and `robots.txt`.

### Customer self-service

- **Loan application** with resident/NRI support, up to three co-applicants and
  two guarantors.
- **Secure document upload** through a tokenised link — customers do not need
  an account or password.
- **Callback scheduling** with live slot availability and duplicate-slot
  protection.
- **Post-disbursal support** requests for repayment, foreclosure, part payment,
  balance transfer, top-up and annual reviews.
- **Complaint ticketing** with a trackable ticket number.

### Admin portal

The `admin-*.html` pages provide:

- An auth-guarded dashboard with live counts.
- Lead and application management, including status and internal notes.
- Follow-up tracking.
- Document review with short-lived presigned download links.
- Callback, post-disbursal and complaint management.
- Admin profile and password settings.

---

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | HTML5, CSS3, vanilla JavaScript, jQuery (existing template) |
| Icons and fonts | Font Awesome, Flaticon and bundled web fonts |
| Backend | [Nhost](https://nhost.io/) — Postgres, Hasura GraphQL, Auth and Storage |
| Nhost SDK | `@nhost/nhost-js` 4.9.0, loaded from jsDelivr |
| Build tooling | None — files are served as-is |
| Hosting | Any static host (Netlify, Cloudflare Pages, GitHub Pages, Hostinger, cPanel, etc.) |

There is no `package.json`, no `node_modules` and no compile step.

---

## Architecture

```text
Browser
  │
  ├── Public pages ──────► Hasura custom functions ──────► Postgres
  │                         (SECURITY DEFINER, validated)
  │
  ├── Upload page ───────► Nhost Storage (private bucket)
  │                         └── register_document() verifies ownership
  │
  └── Admin pages ───────► Nhost Auth (admin role)
                            └── Hasura permissions (admin role)
```

### Security model

- Public writes go through server-side SQL functions, never direct table
  inserts. Input validation, reference generation and consent capture happen in
  Postgres.
- The `user` role has **no** business-table permissions. Anonymous visitors use
  the `anonymous` role only for document uploads.
- The `loan-documents` bucket is private. Admins receive 60-second presigned
  URLs; customers never receive a public file URL.
- Upload links keep the access token in the URL fragment, so it is not sent in
  `Referer` headers or written to static-server access logs.
- Admin access requires an Nhost session with the custom `admin` role **and** a
  matching `admin_profiles` row.
- No service-role key, database password or Hasura admin secret exists in the
  frontend. The browser only knows the Nhost subdomain and region.
- Row-level security is intentionally **not** used; Hasura permissions are the
  access-control layer, as Nhost is designed.

---

## Repository structure

```text
.
├── index.html, *.html           # public pages
├── admin-*.html                 # admin portal (auth-guarded)
├── css/                         # site, admin and customer-portal styles
├── js/
│   ├── nhost-client.js          # single Nhost config + backend helpers
│   ├── public-api.js            # shared public form helpers
│   ├── apply-loan.js            # loan application + co-applicants/guarantors
│   ├── callback.js              # callback booking and slot availability
│   ├── customer-services.js     # post-disbursal and complaint forms
│   ├── document-upload.js       # anonymous upload + document status
│   └── admin-layout.js          # admin auth guard and shared layout
├── images/, dhanvi_images/      # site imagery and brand assets
├── fonts/, flat-font-icons/     # bundled fonts and icon fonts
├── nhost/
│   ├── migrations/001_init.sql  # schema, RPCs, private bucket, role seed
│   ├── verify_setup.sql         # read-only setup verification report
│   └── README.md                # complete backend setup guide
├── _backup_before_rebuild/      # historical templates — not deployed
├── _demo_backup/                # historical templates — not deployed
└── knowledge-base/              # internal reference notes — not deployed
```

`nhost/` contains database migrations and documentation. It is **not** part of
the published website.

---

## Getting started

### 1. Preview the static site

Clone the repository and serve the folder with any static file server:

```bash
git clone https://github.com/kamilsolanki99/dhanvi-finserv.git
cd dhanvi-finserv
python -m http.server 8080
```

Or, with Node.js:

```bash
npx serve .
```

Then open <http://localhost:8080>.

> Use a local server rather than opening `index.html` directly with `file://`.
> Browsers apply different CORS rules to local files, which can block the Nhost
> API requests.

Without a configured backend, the pages render but the forms will report that
the secure service is unavailable.

### 2. Configure the Nhost backend

The complete, step-by-step guide is in **[`nhost/README.md`](nhost/README.md)**.
In short:

1. Put the Nhost **subdomain** and **region** into
   [`js/nhost-client.js`](js/nhost-client.js).
2. Run [`nhost/migrations/001_init.sql`](nhost/migrations/001_init.sql) in the
   Nhost **Database → SQL Editor**.
3. Track the tables and custom functions in Hasura.
4. Apply the Hasura permissions and Storage permissions listed in the guide.
5. Create the administrator account and assign the custom `admin` role.

### 3. Sign in to the admin portal

Open `admin-login.html` with the administrator account created in step 2. A
normal Nhost user is rejected: the account needs the `admin` role and an
`admin_profiles` row.

---

## Deployment

This repository does not include hosting configuration. Publish the static files
to any static host, then point the domain's DNS at that host.

**Publish only the website files:**

```text
*.html
css/
js/
images/
dhanvi_images/
fonts/
flat-font-icons/
robots.txt
sitemap.xml
```

**Do not publish:**

```text
nhost/
_backup_before_rebuild/
_demo_backup/
knowledge-base/
.git/
```

Before going live:

- [ ] Set the real Nhost subdomain and region in `js/nhost-client.js`.
- [ ] Run the migration and complete the Hasura and Storage permissions.
- [ ] Create the admin user and verify the admin guard rejects non-admins.
- [ ] Test application → document upload → admin review end to end.
- [ ] Test callback booking, post-disbursal support and complaint ticketing.
- [ ] Replace the canonical, Open Graph and sitemap URLs with the production
      domain.
- [ ] Choose a static host and configure DNS.

---

## Documentation

| Document | Purpose |
| --- | --- |
| [`nhost/README.md`](nhost/README.md) | Nhost project setup, Hasura tracking, permissions, storage, admin account, testing and troubleshooting |
| [`nhost/migrations/001_init.sql`](nhost/migrations/001_init.sql) | Database schema, public RPCs, private storage bucket and role seed |
| [`js/nhost-client.js`](js/nhost-client.js) | The single place where the Nhost subdomain and region are configured |

---

## Contact

**Dhanvi Finserv**  
Ahmedabad, Gujarat, India  
Phone: +91 99250 02324

For business enquiries, use the contact page on the deployed website.

---

## License

No open-source licence is included in this repository. The Dhanvi Finserv name,
logo, copy and brand assets are proprietary. Please contact the owner before
reusing the code or content.

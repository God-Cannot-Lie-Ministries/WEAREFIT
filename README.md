# WEAREFIT

WEAREFIT is the production F.I.T. Financial Integrity Training portal for members and coaches. It uses F.I.T. branding, member onboarding, coach/mentee workflows, financial profiles, worksheets, paystub archives, savings and investment tracking, session reviews, and secure production services through Supabase and Resend.

Live app: `https://fit-training.org/`

## What is included

- Member and coach sign up/sign in with email verification through Supabase Auth.
- Required member profile setup before financial worksheets can be created.
- Light mode and dark mode with navy, gold, white, and clean neutral styling.
- Profile photos for members, spouses, and coaches.
- Financial profile storage for recurring bills, debts, credit cards, APR details, promotional APR details, savings, investments, and paystubs.
- Recurring bill autofill into new worksheets without duplicate bills.
- Spouse assignment for new worksheets.
- Coach invitation, mentee request, review, approval, and removal workflows.
- Coach document review with bills to pay now or wait until the next check.
- Carried-forward mortgage, debt, credit-card, and savings balances after coach approval.
- Paystub uploads into a private archive instead of the main dashboard.
- AI-style F.I.T. session review records with coach notes, bills paid, bills left to pay, next steps, and user responses.
- Church community link to the God Cannot Lie Ministries Facebook page.

## Production services

The site is static on GitHub Pages, while private data, account verification, role protection, file storage, and email delivery are handled by Supabase and Resend.

Do not put the Supabase service-role key or Resend API key in frontend files. Only the Supabase URL and publishable/anon key belong in the browser config.

## Supabase setup

1. Create or open the Supabase project for WEAREFIT.
2. Open the SQL editor and run:

```sql
-- supabase/migrations/202606080001_production_portal.sql
```

3. Confirm these tables exist: `profiles`, `portal_states`, and `email_audit`.
4. Confirm these private storage buckets exist: `profile-photos` and `financial-documents`.
5. In Authentication settings, set the site URL to:

```text
https://fit-training.org
```

6. Add redirect URLs:

```text
https://fit-training.org
https://god-cannot-lie-ministries.github.io/WEAREFIT/
```

7. Keep email confirmation enabled so both coach accounts and member accounts receive verification by email.

Supabase recommends custom SMTP for production Auth emails because the default sender is limited and not intended for real users. See the official Supabase SMTP guide: https://supabase.com/docs/guides/auth/auth-smtp

## Account deletion deployment

Coach and member account deletion uses expiring, one-time hashed verification tokens and must be deployed with the project-owner Supabase account:

```bash
supabase db push
supabase functions deploy request-account-deletion
supabase functions deploy complete-account-deletion --no-verify-jwt
```

The functions require `RESEND_API_KEY`, `EMAIL_FROM`, and `APP_URL` secrets. Use `WEAREFIT <verification@notifications.fit-training.org>` for `EMAIL_FROM`.

After deployment, set the GitHub Actions variables `ACCOUNT_DELETION_ENABLED` and `PRESENCE_ENABLED` to `true`, then redeploy the site.

## Resend setup

Use this sending domain:

```text
notifications.fit-training.org
```

After Resend verifies the DNS records for that domain, configure Supabase Auth SMTP with the Resend values:

```text
Host: smtp.resend.com
Port: 465
Username: resend
Password: your Resend API key
Sender: WEAREFIT <verification@notifications.fit-training.org>
```

Resend's official Supabase SMTP guide is here: https://resend.com/docs/send-with-supabase-smtp

## Edge Function setup

Deploy the coach invitation email function from the Supabase CLI:

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy send-coach-invite
```

Set the function secrets in Supabase:

```bash
supabase secrets set RESEND_API_KEY=YOUR_RESEND_API_KEY
supabase secrets set EMAIL_FROM="WEAREFIT <invites@notifications.fit-training.org>"
supabase secrets set APP_URL=https://fit-training.org
```

Completed F.I.T. session summary texts use Twilio and contain a secure sign-in link to the summary and printable PDF. Configure the server-only Twilio values, then deploy the function:

```bash
supabase secrets set TWILIO_ACCOUNT_SID=YOUR_TWILIO_ACCOUNT_SID
supabase secrets set TWILIO_AUTH_TOKEN=YOUR_TWILIO_AUTH_TOKEN
supabase secrets set TWILIO_FROM_NUMBER=YOUR_TWILIO_PHONE_NUMBER
supabase functions deploy send-session-summary-sms
```

Never place Twilio credentials in frontend code or repository variables.

Bill reminders are sent by the `send-bill-reminders` Edge Function. A GitHub Actions schedule calls it daily and the function emails members, plus their connected coach, when a saved bill is due. Each account can choose a reminder window from 1 to 7 days in Settings. Reminder emails do not include bill amounts; users sign in to view financial details securely. Paid bills are skipped even if an older due date remains in saved profile data.

For stronger protection, set the same cron secret in both Supabase and GitHub:

```bash
supabase secrets set BILL_REMINDER_CRON_SECRET=YOUR_LONG_RANDOM_SECRET
```

Then add `BILL_REMINDER_CRON_SECRET` as a GitHub repository secret. If this secret is set in Supabase, reminder requests must include the matching header. The workflow file is `.github/workflows/send-bill-reminders.yml`.

To change the fallback for accounts that have not saved a preference yet, add or update the GitHub repository variable `BILL_REMINDER_DAYS_AHEAD`. If the variable is blank, reminders default to 5 days ahead. The Edge Function also honors a Supabase secret named `BILL_REMINDER_DAYS_AHEAD` for direct/manual function calls.

Supabase provides `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` automatically to Edge Functions. Never place the service-role key in the website or GitHub repository. Supabase's function deployment and secrets docs are here:

- https://supabase.com/docs/guides/functions/deploy
- https://supabase.com/docs/guides/functions/secrets

## GitHub Pages setup

This repo includes a GitHub Pages workflow that creates the live `config.js` during deployment.

In the GitHub repository, add these repository variables:

```text
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_PUBLISHABLE_KEY=YOUR_SUPABASE_PUBLISHABLE_OR_ANON_KEY
```

The workflow uses those public values to connect the browser app to Supabase.

## Domain setup

GitHub Pages and DNS are configured to serve the app from `https://fit-training.org/`.

## Local preview

Open `index.html` directly or serve this folder locally. The checked-in `config.js` has production disabled, so local preview can still run without Supabase credentials.

To test against Supabase locally, temporarily update `config.js` with your Supabase URL and publishable key, then set `production: true`.

Run the calculation regression checks before publishing math changes:

```bash
node --test tests/math-regression.test.js
```

## Security notes

- Row Level Security policies are included for profiles, portal states, email audit records, and private storage.
- Coaches can only read assigned mentees.
- Members keep ownership of their data when removed from a coach.
- Uploaded profile photos and paystubs are stored in private Supabase Storage buckets.
- The site never asks for bank usernames or bank passwords.
- Server-only keys must stay in Supabase secrets or GitHub secrets, never in frontend code.

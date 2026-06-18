create table if not exists public.fit_email_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  coach_id uuid references auth.users(id) on delete set null,
  recipient_user_id uuid references auth.users(id) on delete set null,
  recipient_role text not null check (recipient_role in ('member', 'coach')),
  event_type text not null,
  recipient_email text not null,
  subject text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  resend_email_id text,
  related_session_id text,
  related_document_id text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  error_message text
);

create index if not exists fit_email_logs_recipient_user_id_idx
on public.fit_email_logs (recipient_user_id, created_at desc);

create index if not exists fit_email_logs_user_id_idx
on public.fit_email_logs (user_id, created_at desc);

create index if not exists fit_email_logs_coach_id_idx
on public.fit_email_logs (coach_id, created_at desc);

alter table public.fit_email_logs enable row level security;

drop policy if exists "fit email logs read own or assigned" on public.fit_email_logs;
create policy "fit email logs read own or assigned"
on public.fit_email_logs for select to authenticated
using (
  recipient_user_id = auth.uid()
  or user_id = auth.uid()
  or coach_id = auth.uid()
);

grant select on public.fit_email_logs to authenticated;

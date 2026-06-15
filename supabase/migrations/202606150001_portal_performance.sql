create index if not exists portal_states_coach_email_idx
on public.portal_states (coach_email)
where coach_email is not null;

create index if not exists portal_states_updated_at_idx
on public.portal_states (updated_at desc);

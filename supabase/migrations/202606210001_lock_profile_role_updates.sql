-- Keep role assignment server-controlled. Users may update their display name,
-- but they must not be able to promote their own profile role from the browser.
revoke update on public.profiles from authenticated;
grant update (full_name, updated_at) on public.profiles to authenticated;

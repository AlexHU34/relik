-- ============================================================
-- Relik: Supabase Storage для E2E-шифрованных медиа
-- Выполните один раз в Supabase → SQL Editor → Run.
--
-- В bucket 'files' попадает только AES-GCM-шифротекст.
-- Ключ файла передаётся внутри зашифрованного сообщения,
-- поэтому публичное чтение безопасно: без ключа это мусор.
-- ============================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('files', 'files', true, 104857600)
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit;

drop policy if exists "relik files read" on storage.objects;
create policy "relik files read"
  on storage.objects for select
  using (bucket_id = 'files');

drop policy if exists "relik files upload" on storage.objects;
create policy "relik files upload"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'files');

drop policy if exists "relik files update" on storage.objects;
create policy "relik files update"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'files' and owner = auth.uid())
  with check (bucket_id = 'files' and owner = auth.uid());

drop policy if exists "relik files delete" on storage.objects;
create policy "relik files delete"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'files' and owner = auth.uid());

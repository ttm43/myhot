-- Feishu sign-in is no longer part of MyHOT: the admin is the password admin only.
ALTER TABLE admin_users DROP COLUMN IF EXISTS feishu_union_id;

-- Reviewed cloud snapshot, 2026-09-07: 0 users, 5 empty organizations,
-- each with 1 project. Approved and applied to fontes-app on 2026-09-07.
-- A fresh backup was restored and verified before the cleanup.
-- Scope is fixed to the reviewed IDs; newly created organizations are excluded.
DELETE FROM organization
WHERE id IN (
  '4FQ5aYXI0vtymMuvdX5hE1zTDoz1XrXr',
  'B6z5axEOKU8jUy2NPtl9wpwnUrdbaj06',
  'PTuPf4V7DSRpPeyM5HmYX2c9WonMW2R9',
  'm7cZIp6ntB3qfSvMtrT0RbvBwQiMeZdR',
  'uyck41qjISfiGuNAfN0RdrYoDh1mlGMu'
)
AND NOT EXISTS (SELECT 1 FROM member WHERE member.organizationId = organization.id);
-- Projects and invitations are removed through their organization foreign keys.

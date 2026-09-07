-- Replace every occurrence of user@example.com with the account email.
-- Run all statements in Cloudflare D1 Studio, in this order.
-- Deletes organizations only when this user is their sole member; their projects
-- and invitations cascade. Shared organizations/projects remain.

DELETE FROM organization
WHERE id IN (
  SELECT organizationId FROM member
  WHERE userId IN (SELECT id FROM user WHERE email = 'user@example.com')
)
AND NOT EXISTS (
  SELECT 1 FROM member m
  WHERE m.organizationId = organization.id
    AND m.userId NOT IN (SELECT id FROM user WHERE email = 'user@example.com')
);

DELETE FROM invitation WHERE email = 'user@example.com';

-- Better Auth password-reset records hold the user ID in value.
DELETE FROM verification
WHERE value IN (SELECT id FROM user WHERE email = 'user@example.com');

-- Foreign keys cascade to sessions, linked accounts, memberships and invitations
-- issued by this user. No deletion is performed until this script is run.
DELETE FROM user WHERE email = 'user@example.com';

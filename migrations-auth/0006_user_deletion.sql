-- Shared organizations must retain an owner. Check before any cascading writes.
CREATE TRIGGER user_require_organization_owner
BEFORE DELETE ON "user"
WHEN EXISTS (
  SELECT 1 FROM member mine
  WHERE mine.userId = OLD.id
    AND instr(',' || mine.role || ',', ',owner,') > 0
    AND EXISTS (SELECT 1 FROM member other WHERE other.organizationId = mine.organizationId AND other.userId <> OLD.id)
    AND NOT EXISTS (
      SELECT 1 FROM member successor WHERE successor.organizationId = mine.organizationId
        AND successor.userId <> OLD.id AND instr(',' || successor.role || ',', ',owner,') > 0
    )
)
BEGIN
  SELECT RAISE(ABORT, 'TRANSFER_ORGANIZATION_OWNERSHIP_BEFORE_DELETING_USER');
END;

-- Runs before ownerId's existing ON DELETE SET NULL action.
-- Public projects belong to the organization; private projects belong to the user.
CREATE TRIGGER user_delete_private_data
BEFORE DELETE ON "user"
BEGIN
  DELETE FROM project WHERE ownerId = OLD.id AND visibility = 'private';
  DELETE FROM authToken WHERE kind IN ('verify', 'reset') AND json_extract(value, '$.userId') = OLD.id;
  DELETE FROM organizationJoinAttempt WHERE key = 'user:' || OLD.id;
END;

-- Removing the final membership removes the organization; existing foreign keys
-- then cascade to its projects and invitations. No reverse user FK is needed.
CREATE TRIGGER member_delete_empty_organization
AFTER DELETE ON member
BEGIN
  DELETE FROM organization WHERE id = OLD.organizationId
    AND NOT EXISTS (SELECT 1 FROM member WHERE organizationId = OLD.organizationId);
END;

CREATE TRIGGER organization_clear_session_selection
AFTER DELETE ON organization
BEGIN
  UPDATE session SET activeOrganizationId = NULL WHERE activeOrganizationId = OLD.id;
  DELETE FROM organizationJoinAttempt WHERE key = 'org:' || OLD.id;
END;

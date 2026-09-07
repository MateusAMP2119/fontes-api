# User deletion and ownership

Cloud inspection on 2026-09-07 found zero users, five organizations with zero
members, and one ownerless project in each. Foreign-key checks passed. This was a
missing deletion policy: memberships cascade from a deleted user, but organizations
are parent records, and project.ownerId explicitly uses ON DELETE SET NULL.

Migration 0006 adds database triggers, so Cloudflare Studio DELETE statements get
the same behavior as application deletes:

- Deleting a sole member removes their organization, projects and invitations.
- Deleting the last owner of an organization with other members is rejected with
  TRANSFER_ORGANIZATION_OWNERSHIP_BEFORE_DELETING_USER. Give another member the owner
  role first. Multiple owners are supported, including comma-separated role lists.
- Private projects are deleted before their user's foreign key becomes NULL.
- Public projects in a surviving organization remain organization-owned. A NULL
  ownerId is allowed for these records; it means the original user no longer exists.
- User verification/reset tokens and user join-attempt counters are removed.
- Deleting an organization clears activeOrganizationId in remaining sessions and
  its organization join-attempt counter. Existing foreign keys remove child rows.

The organization API's deliberate deletion (members first, then organization) is
still supported. Removing the final membership also cleans up its parent. Merely
inserting a new organization without a member does not delete it: onboarding creates
these records in sequence. Direct administrative role changes still require care;
this migration does not enforce every possible role or membership-edit policy.

The migration itself does not remove historical records. On 2026-09-07, after
explicit approval and a fresh export, ops/cleanup-empty-organizations.sql removed
the five reviewed empty organizations and their five projects from `fontes-app`.
The script restricts deletion to the reviewed IDs and rechecks for memberships.
Remote verification found zero organizations/projects and no foreign-key violations.

Cloudflare D1 names are immutable, so the database was moved from `fontes-auth`
(`2ebddf0d-bb3f-4fee-8448-64306706035a`) to `fontes-app`
(`2d52f44f-e89a-487a-9149-94fb5ead9b32`), retaining EU jurisdiction.
Before cleanup, all table rows, schema definitions, migration history and four
triggers were compared between the databases and matched. The old remote database
was then retired. Application code and Worker configuration use `APP_DB`; the
service is now named `fontes-api`. Pages preview settings also target the
new database, with `AUTH_DB` retained there as a compatibility alias. Existing
immutable preview deployments must be redeployed to pick up changed bindings.
Local development keeps its previous storage identity, preserving local accounts.

Private backups (not committed):
- `.wrangler/backups/auth-before-deletion-rules.sql`: before the deletion migration.
- `.wrangler/backups/auth-before-rename-cleanup.sql`: complete pre-cleanup export,
  including the new triggers; restored and checked locally before the move.

Restoring the pre-cleanup export restores the five deleted organizations/projects;
import it into a separate recovery database before selectively restoring records.

Validation: node --test scripts/user-deletion.test.mjs executes the migration and
Studio-style DELETE statements against both SQLite (foreign keys on) and workerd
D1. It covers sole-member cascade, shared-owner protection, ownership transfer,
private vs public project behavior, token cleanup, session selection cleanup,
foreign-key integrity and compatibility with the organization API's deletion order.
The existing auth and onboarding integration tests also pass with the migration.

Rollback of the new behavior (does not restore previously deleted data):

```sql
DROP TRIGGER user_require_organization_owner;
DROP TRIGGER user_delete_private_data;
DROP TRIGGER member_delete_empty_organization;
DROP TRIGGER organization_clear_session_selection;
```

D1 foreign-key behavior: https://developers.cloudflare.com/d1/sql-api/foreign-keys/

Pre-extraction backup files remain in the original fontes-app checkout’s ignored
`.wrangler/backups/` directory; they are not published in this repository.

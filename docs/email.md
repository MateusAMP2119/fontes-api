# Fontes email files

Every email has a complete HTML document and a wording JSON in private R2 bucket `fontes-email-templates`, under `transactional/pt-PT/`. Local mirrors live in `worker/email/emails/`.

The seven names are `sign-in`, `email-verification`, `forget-password`, `change-email`, `verify-link`, `reset-link`, and `invite`. Each has `.html` and `.json` objects. The HTML owns layout, header and footer structure; the JSON owns wording and a plain-text template referencing those same wording fields.

## Artwork

The existing R2 PNGs are served publicly at:

- https://api.fonteslabs.com/email-assets/header.png
- https://api.fonteslabs.com/email-assets/footer.png

Only these two paths are exposed by the Worker. Templates, wording and other R2 objects stay private. The Worker Cache API stores successful image responses for five minutes. The zone currently overrides the public browser cache lifetime to four hours (verified in live response headers). Requests support HEAD, ETag revalidation and GET. The route bypasses authentication and the API's private/no-store response handling.

Email HTML uses these HTTPS URLs directly. There are no image attachments, CID references or embedded image bytes in outgoing mail. The sender reads only the selected HTML and JSON, in parallel. Remote-image privacy settings can still prevent display. No inbox speed benchmark has been performed.

## Designer workflow

Replace the appropriate HTML, JSON or PNG objects in R2. No deployment or compilation is needed for design or wording changes. Image changes can remain cached for four hours in browsers; mail providers may cache images longer. A new query parameter in HTML, such as `header.png?v=20260909`, gives mail proxies a new image URL, though our edge still shares the underlying five-minute object cache.

Preserve placeholder names and impersonal PT-PT copy. No direct address or em dash. Codes and private links are generated at send time and never stored in R2. JSON values are escaped as plain text; formatting belongs in HTML. Expiries remain codes 10 minutes, verification links 24 hours, recovery links 1 hour and invitations 7 days.

`npm run email:package` validates files; `npm run email:publish` uploads all pairs and artwork without deploying. Dashboard edits should also be synchronized into the repository to keep the bundled fallback current. Missing or invalid R2 pairs use that fallback. New email types or sending logic require deployment.

## Checks

`npm test`, `npm run typecheck`, `npm run build`, and `npm run email:preview`. Tests verify zero outgoing attachments, HTML and text content, two template reads, public image routing, caching and private-object rejection. Tests do not send email. Received-client rendering must be checked using a new email.

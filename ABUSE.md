# Abuse policy

Pixvault is free image and file hosting. Hosting for strangers is only safe if abuse is handled quickly, so
these rules apply to every org on the service.

## Not allowed

- Child sexual abuse material (CSAM): zero tolerance. Matched content is blocked, preserved as the law requires,
  and reported to the relevant authorities.
- Malware, phishing pages or kits, and files used to attack systems.
- Content that infringes copyright or trademark.
- Non-consensual intimate imagery, doxxing, and content that incites violence.
- Using Pixvault as a CDN for spam or as a proxy to evade another service's blocks.

## How we enforce it

- New public uploads from free plans are **held** and not served until automated safety checks pass.
- Every serving hostname, including custom domains where supported, uses CSAM scanning.
- Libraries can set AI moderation to standard or strict, and flagged files go to a review queue.
- Every public file page carries a **Report** link (and a `Link: <…>; rel="report"` header) that opens a case
  for the platform team.
- A takedown blocks the file within minutes and serves an HTTP 451 notice page. The uploader's org is notified.
- Orgs that break these rules repeatedly are suspended.

## Reporting content

Use the **Report** link on the file's page. Until that link ships (milestone PV4 in
[the plan](specs/epics/pixvault-team-media/implementation-plan.md)), report through this repository's private
**Security → Report a vulnerability** form, with the file URL and the reason. Never attach or re-upload illegal
content; the URL is enough.

## Grievance officer (India IT Rules)

The grievance officer's name and contact details will be published here and on the product's abuse page before
public sharing opens in production. We acknowledge complaints within 24 hours and resolve them within the
timelines the IT Rules set. A takedown log with response times is kept.

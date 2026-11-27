# Security policy

Pixvault hosts other people's files, so we treat tenant isolation, signed URLs, API keys, WebDAV app passwords
and storage credentials as security boundaries.

## Reporting a vulnerability

Please **don't open a public issue.** Report privately through GitHub:
**Security → Report a vulnerability** on this repository (private vulnerability reporting is on).

Include what you found, how to reproduce it, and what an attacker gains. We acknowledge within 3 working days and
aim to fix critical issues (cross-org or cross-library access, signature forgery, credential exposure) within 7 days.

## In scope

- Anything that lets one org or library read, list, serve or change another's files or metadata (D1, R2, KV,
  Durable Objects, serving paths, WebDAV, share links, upload links, custom domains, the random-image API).
- Forging or extending signed URLs or share links.
- Leaking API keys, app passwords, BYO bucket credentials or signing keys.
- Bypassing quotas, safety holds, takedowns or rate limits.

## Out of scope

Volumetric denial of service, social engineering, and findings in CloudFlare-ImgBed or Sanyue-ImgHub that don't
affect Pixvault (report those upstream).

## Abuse is not a security report

To report content hosted on Pixvault (CSAM, malware, phishing, copyright), see [ABUSE.md](ABUSE.md).

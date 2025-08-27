# Context Pack — Inspectie App

## Business
- Inspectietool (demarcatie & opleverpunten), foto’s/annotaties aan ruimtes/elements
- PDF (plattegronden, gevels, doorsneden) + interactieve highlights/coderingen
- IFC viewer (fase 1 read-only; fase 2 write-back kopie)
- Rapportage: per verdieping → ruimte → element (PDF/Excel/BCF)
- Bedrijfsspecifieke checklists/kleurcoderingen/benamingen
- Quotas aan abonnementen (500MB→1TB)
- ISO19650 in MVP: guidance-only (autocorrect + uitleg)

## Tech
- Next.js 14 (web), React Native (expo)
- Firebase: Auth, Firestore, Functions, Storage
- PDF.js, IFC.js, Y.js (CRDT), Meilisearch primair (Algolia optie)
- AV-scan (ClamAV), WAF (Cloud Armor), daily backups (365d)

## Perf Targets
- PDF first visible page < 350ms desktop / < 450ms mobiel
- Overlay updates ~30 FPS
- Rapportage async job + notificatie

## Security
- Tenant isolation via Firestore Rules + custom claims
- Signed URLs, MIME + magic bytes
- WAF limits: 100/min/IP, 600/min/tenant

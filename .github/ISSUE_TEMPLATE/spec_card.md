---
name: "Spec Card"
about: "Kleine, afgebakende taak voor AI Implementer"
title: "SC-XX — Titel"
labels: ["spec"]
assignees: ""
---

**Context**
Zie /docs/context/overview.md

**What to build**
- ...

**Inputs/Outputs**
- Props / API / Firestore paden:
- Save model:
```ts
type Annotation = {
  tenantId: string; projectId: string; docId: string;
  pageIndex: number; geometry: GeoJSON; codingId?: string;
  stableId: string; createdBy: string; createdAt: number;
}

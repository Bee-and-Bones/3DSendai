---
title: Bun/TS typed-array generics and the Workflow script parser subset
module: host (TypeScript) + workflow tooling
date: 2026-07-01
problem_type: developer_experience
component: tooling
severity: low
applies_when:
  - Writing TypeScript that stores/reslices Uint8Array buffers under strict tsc 5.7+
  - Authoring a script for the Workflow (multi-agent orchestration) tool
tags:
  - bun
  - typescript
  - typed-arrays
  - workflow
  - gotchas
---

## Context

Two small but time-wasting friction points hit while building the Bun/TS host and a multi-agent orchestration workflow. Both produce confusing errors with non-obvious causes.

## Guidance

**1. Annotate byte-buffer fields as `Uint8Array`, not the inferred type.** Under TypeScript 5.7+ typed arrays are generic. A field initialized as `private buf = new Uint8Array(0)` infers `Uint8Array<ArrayBuffer>`, but `.subarray()` / `.slice()` return `Uint8Array<ArrayBufferLike>`, so reassigning the field fails:

```
Type 'Uint8Array<ArrayBufferLike>' is not assignable to type 'Uint8Array<ArrayBuffer>'
```

Fix — widen the annotation explicitly:

```ts
private buf: Uint8Array = new Uint8Array(0);   // not: private buf = new Uint8Array(0)
```

**2. The Workflow tool's script parser is a restricted JS subset — write plain, old-style JS.** Modern syntax fails to parse with a misleading `Unexpected token` pointing at the wrong line. Confirmed rejected: **nullish coalescing (`??`)** and **object spread (`{ ...x }`)**. Use instead:

```js
// instead of: rank[s] ?? 9
const rk = (s) => (rank[s] === undefined ? 9 : rank[s]);
// instead of: { ...f, verdict: v }
Object.assign({}, f, { verdict: v });
```

Prefer function expressions over exotic arrow chains, and avoid `Date.now()`/`Math.random()` (they throw in that sandbox).

## Why This Matters

Both errors point somewhere other than the real cause — the tsc variance error names a reslice line far from the field declaration, and the Workflow parse error reports a line after the offending token. Knowing the two triggers turns a 15-minute hunt into a one-line fix.

## When to Apply

Strict-tsc Bun/Node code that buffers bytes (protocol codecs, stream readers); any Workflow orchestration script.

# Forensic Audit High-Priority Fix Plan

## Scope

This plan includes only findings that meet both criteria:

1. Confirmed by inspecting the repository.
2. High severity after reassessing the original audit severity.

Medium- and low-severity findings are intentionally excluded.

## Eligible Findings

None.

The review found no issue that is both confirmed and appropriately classified as High severity. The original audit overstated several findings:

- Unreferenced frontend files are confirmed dead code, but are low-risk cleanup.
- `gemini-cache.ts` is obsolete and unreferenced, but is low-risk cleanup.
- Firestore support is conditional compatibility code, not confirmed dead code.
- `auth.test.ts` is active and discovered by Vitest.
- Broad exception handling requires targeted review; it is not uniformly incorrect.
- TypeScript `any` usage and console statements are technical debt, not confirmed High-severity defects.
- Lack of `React.memo` does not establish a performance bug.

## Implementation Gate

No fixes should be implemented from this plan until a new confirmed High-severity finding is established with:

- a reproducible failure or security impact;
- exact repository locations;
- verified runtime reachability;
- affected behavior and dependencies;
- a correction that preserves supported deployment modes.

## Deferred Findings

The following reviewed items remain outside this plan by design:

- Firestore retirement and adapter simplification.
- Removal of confirmed unreferenced frontend files.
- Narrowing broad exception handlers.
- Reducing frontend `any` usage.
- Reviewing frontend console logging.
- Optimizing the review-batch N+1 query.
- Adding response models selectively.
- Reviewing large modules and pages.
- Reviewing the query-string backup download token.

These require separate medium- or low-priority plans and must not be folded into a High-severity fix without new evidence.

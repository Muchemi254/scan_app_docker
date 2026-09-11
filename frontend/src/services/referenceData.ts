// Shared cache for slow-moving reference data (industries / categories).
//
// Problem: every ReceiptForm mount fired industries + user-default +
// categories calls, so editing N receipts in a row re-fetched identical
// taxonomy data 3N times. This data changes only via the admin UI, so it is
// cached in-memory with a short TTL and invalidated on admin mutations.
//
// Usage: import { getIndustries, getCategories, getDefaultIndustry } from
// './referenceData' instead of calling industriesApi/categoriesApi directly
// from user-facing screens. AdminPage keeps using the raw APIs (it needs
// fresh data incl. inactive rows) and calls invalidateReferenceData() after
// every industry/category mutation.

import { industriesApi, categoriesApi } from './api';

const TTL_MS = 5 * 60 * 1000; // 5 minutes — safety net; invalidation is the real refresh

type Entry<T> = { at: number; value: T };

let industriesCache: Record<string, Entry<Awaited<ReturnType<typeof industriesApi.list>>>> = {};
let industriesInflight: Record<string, Promise<Awaited<ReturnType<typeof industriesApi.list>>>> = {};

let categoriesCache: Record<string, Entry<Awaited<ReturnType<typeof categoriesApi.list>>>> = {};
let categoriesInflight: Record<string, Promise<Awaited<ReturnType<typeof categoriesApi.list>>>> = {};

let defaultCache: Entry<Awaited<ReturnType<typeof categoriesApi.getDefault>>> | null = null;
let defaultInflight: Promise<Awaited<ReturnType<typeof categoriesApi.getDefault>>> | null = null;

const fresh = <T>(e: Entry<T> | null | undefined): e is Entry<T> =>
  !!e && Date.now() - e.at < TTL_MS;

export async function getIndustries(activeOnly = true) {
  const key = String(activeOnly);
  const hit = industriesCache[key];
  if (fresh(hit)) return hit.value;
  if (!industriesInflight[key]) {
    industriesInflight[key] = industriesApi.list(activeOnly).then(
      (v) => {
        industriesCache[key] = { at: Date.now(), value: v };
        delete industriesInflight[key];
        return v;
      },
      (err) => {
        delete industriesInflight[key];
        throw err;
      },
    );
  }
  return industriesInflight[key];
}

export async function getCategories(
  industryId?: string,
  opts: { activeOnly?: boolean; search?: string } = {},
) {
  const key = `${industryId || ''}|${opts.activeOnly ?? ''}|${opts.search || ''}`;
  const hit = categoriesCache[key];
  if (fresh(hit)) return hit.value;
  if (!categoriesInflight[key]) {
    categoriesInflight[key] = categoriesApi.list(industryId, opts).then(
      (v) => {
        categoriesCache[key] = { at: Date.now(), value: v };
        delete categoriesInflight[key];
        return v;
      },
      (err) => {
        delete categoriesInflight[key];
        throw err;
      },
    );
  }
  return categoriesInflight[key];
}

export async function getDefaultIndustry() {
  if (fresh(defaultCache)) return defaultCache.value;
  if (!defaultInflight) {
    defaultInflight = categoriesApi.getDefault().then(
      (v) => {
        defaultCache = { at: Date.now(), value: v };
        defaultInflight = null;
        return v;
      },
      (err) => {
        defaultInflight = null;
        throw err;
      },
    );
  }
  return defaultInflight;
}

/** Persist a new user-default industry and drop the cached default. */
export async function setDefaultIndustry(industryId: string | null) {
  const v = await categoriesApi.setDefault(industryId);
  defaultCache = null;
  return v;
}

/**
 * Drop all cached reference data. Call after any admin industry/category
 * create/update/delete (and CSV import) so user screens pick up the change
 * on their next mount instead of waiting for TTL expiry.
 */
export function invalidateReferenceData() {
  industriesCache = {};
  industriesInflight = {};
  categoriesCache = {};
  categoriesInflight = {};
  defaultCache = null;
  defaultInflight = null;
}

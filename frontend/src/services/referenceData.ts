// Shared cache for slow-moving reference data.
//
// Problem: every ReceiptForm / PostReceipt / ReviewPanel / DetailsPage mount
// fired the same taxonomy + lookup calls, so editing N receipts re-fetched
// identical data 3N times. This data changes only via admin UI or receipt
// mutations, so it is cached in-memory with a short TTL and invalidated on
// the corresponding admin/user mutation.
//
// Tier 1 (reference data, 5m TTL, explicit invalidate on admin mutate):
//   industries, categories, defaultIndustry, locations, entryTypes
// Tier 2 (user/global prefs & dashboard years, 5m/60s TTL):
//   taxPreference (per-user), globalTaxRate, dashboardYears (per-user)
// Tier 3+ (receipts, dashboard aggregates, messages, batches) intentionally NOT
// cached — stale list = wrong data. Only in-flight dedupe there.
//
// Usage: import { getIndustries, getCategories, ... } from './referenceData'
// from user-facing screens. AdminPage keeps using the raw APIs for
// fresh/inactive rows and calls invalidateReferenceData() after mutations.

import { industriesApi, categoriesApi, locationsApi, entryTypesApi, settingsApi, dashboardApi } from './api';

const REF_TTL_MS = 5 * 60 * 1000; // Tier 1: safety net; invalidation is the real refresh
const PREF_TTL_MS = 5 * 60 * 1000; // Tier 2 prefs: same
const YEARS_TTL_MS = 60 * 1000; // dashboard years: 60s (new year appears quickly)

type Entry<T> = { at: number; value: T };
const fresh = <T>(e: Entry<T> | null | undefined, ttl: number): e is Entry<T> =>
  !!e && Date.now() - e.at < ttl;

// ── Industries / Categories / Default industry (Tier 1) ────────────────

let industriesCache: Record<string, Entry<Awaited<ReturnType<typeof industriesApi.list>>>> = {};
let industriesInflight: Record<string, Promise<Awaited<ReturnType<typeof industriesApi.list>>>> = {};

let categoriesCache: Record<string, Entry<Awaited<ReturnType<typeof categoriesApi.list>>>> = {};
let categoriesInflight: Record<string, Promise<Awaited<ReturnType<typeof categoriesApi.list>>>> = {};

let defaultCache: Entry<Awaited<ReturnType<typeof categoriesApi.getDefault>>> | null = null;
let defaultInflight: Promise<Awaited<ReturnType<typeof categoriesApi.getDefault>>> | null = null;

export async function getIndustries(activeOnly = true) {
  const key = String(activeOnly);
  const hit = industriesCache[key];
  if (fresh(hit, REF_TTL_MS)) return hit.value;
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
  if (fresh(hit, REF_TTL_MS)) return hit.value;
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
  if (fresh(defaultCache, REF_TTL_MS)) return defaultCache.value;
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

// ── Locations / EntryTypes (Tier 1) ────────────────────────────────────

let locationsCache: Entry<Awaited<ReturnType<typeof locationsApi.list>>> | null = null;
let locationsInflight: Promise<Awaited<ReturnType<typeof locationsApi.list>>> | null = null;

let entryTypesCache: Entry<Awaited<ReturnType<typeof entryTypesApi.list>>> | null = null;
let entryTypesInflight: Promise<Awaited<ReturnType<typeof entryTypesApi.list>>> | null = null;

export async function getLocations() {
  if (fresh(locationsCache, REF_TTL_MS)) return locationsCache.value;
  if (!locationsInflight) {
    locationsInflight = locationsApi.list().then(
      (v) => {
        locationsCache = { at: Date.now(), value: v };
        locationsInflight = null;
        return v;
      },
      (err) => {
        locationsInflight = null;
        throw err;
      },
    );
  }
  return locationsInflight;
}

export async function getEntryTypes() {
  if (fresh(entryTypesCache, REF_TTL_MS)) return entryTypesCache.value;
  if (!entryTypesInflight) {
    entryTypesInflight = entryTypesApi.list().then(
      (v) => {
        entryTypesCache = { at: Date.now(), value: v };
        entryTypesInflight = null;
        return v;
      },
      (err) => {
        entryTypesInflight = null;
        throw err;
      },
    );
  }
  return entryTypesInflight;
}

// ── Tax prefs / Dashboard years (Tier 2) ───────────────────────────────

let taxPrefCache: Entry<Awaited<ReturnType<typeof settingsApi.getTaxPreference>>> | null = null;
let taxPrefInflight: Promise<Awaited<ReturnType<typeof settingsApi.getTaxPreference>>> | null = null;

let globalTaxCache: Entry<Awaited<ReturnType<typeof settingsApi.getGlobalTaxRate>>> | null = null;
let globalTaxInflight: Promise<Awaited<ReturnType<typeof settingsApi.getGlobalTaxRate>>> | null = null;

let yearsCache: Entry<Awaited<ReturnType<typeof dashboardApi.years>>> | null = null;
let yearsInflight: Promise<Awaited<ReturnType<typeof dashboardApi.years>>> | null = null;

export async function getTaxPreference() {
  if (fresh(taxPrefCache, PREF_TTL_MS)) return taxPrefCache.value;
  if (!taxPrefInflight) {
    taxPrefInflight = settingsApi.getTaxPreference().then(
      (v) => {
        taxPrefCache = { at: Date.now(), value: v };
        taxPrefInflight = null;
        return v;
      },
      (err) => {
        taxPrefInflight = null;
        throw err;
      },
    );
  }
  return taxPrefInflight;
}

export async function setTaxPreference(rate: number) {
  const v = await settingsApi.setTaxPreference(rate);
  taxPrefCache = { at: Date.now(), value: v };
  return v;
}

export async function getGlobalTaxRate() {
  if (fresh(globalTaxCache, PREF_TTL_MS)) return globalTaxCache.value;
  if (!globalTaxInflight) {
    globalTaxInflight = settingsApi.getGlobalTaxRate().then(
      (v) => {
        globalTaxCache = { at: Date.now(), value: v };
        globalTaxInflight = null;
        return v;
      },
      (err) => {
        globalTaxInflight = null;
        throw err;
      },
    );
  }
  return globalTaxInflight;
}

export async function setGlobalTaxRate(rate: number) {
  const v = await settingsApi.setGlobalTaxRate(rate);
  globalTaxCache = { at: Date.now(), value: v };
  return v;
}

export async function getDashboardYears() {
  if (fresh(yearsCache, YEARS_TTL_MS)) return yearsCache.value;
  if (!yearsInflight) {
    yearsInflight = dashboardApi.years().then(
      (v) => {
        yearsCache = { at: Date.now(), value: v };
        yearsInflight = null;
        return v;
      },
      (err) => {
        yearsInflight = null;
        throw err;
      },
    );
  }
  return yearsInflight;
}

/**
 * Drop all cached reference data. Call after any admin industry/category/
 * location/entryType create/update/delete (and CSV import) so user screens
 * pick up the change on their next mount instead of waiting for TTL expiry.
 * Also called on signOut so the next user doesn't see the previous user's
 * cached tax prefs.
 */
export function invalidateReferenceData() {
  industriesCache = {};
  industriesInflight = {};
  categoriesCache = {};
  categoriesInflight = {};
  defaultCache = null;
  defaultInflight = null;
  locationsCache = null;
  locationsInflight = null;
  entryTypesCache = null;
  entryTypesInflight = null;
  taxPrefCache = null;
  taxPrefInflight = null;
  globalTaxCache = null;
  globalTaxInflight = null;
  yearsCache = null;
  yearsInflight = null;
}

/** Invalidate only the dashboard-years cache (e.g. after a receipt is created). */
export function invalidateDashboardYears() {
  yearsCache = null;
  yearsInflight = null;
}

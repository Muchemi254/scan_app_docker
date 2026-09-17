import { useState, useCallback } from 'react';
import { cellValue, isBlankCellValue } from '../components/ReceiptsTableView';

// ── Shared column-filter state (used by the "modern live" per-column row) ──
// 5 pages duplicated this verbatim: a Record<string,string> + a setter that
// deletes blank entries + a client IIFE that lowercases cellValue. This hook
// is the single implementation for both modes:
//
//  - client mode: the 4 pages that filter an in-memory array (instant)
//  - server mode: GalleryPage which round-trips receiptApi.list(?supplier=&…)
//
// Pages adopt it incrementally without changing displayed data.

export const BLANK_SENTINEL = '??';
// Keep old sentinel for backward compat (e.g. bookmarked URLs/filters)
const isBlankSentinel = (v: string) => v === '??' || v === '__BLANK__';

export function useColumnFilters() {
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});

  const handleColumnFilter = useCallback((key: string, value: string) => {
    setColumnFilters(prev => {
      const next = { ...prev, [key]: value };
      if (!value) delete next[key];
      return next;
    });
  }, []);

  const clearColumnFilters = useCallback(() => setColumnFilters({}), []);

  return { columnFilters, handleColumnFilter, clearColumnFilters, setColumnFilters };
}

// Helpers for the two wiring patterns.

export function filterRowsClient<T>(rows: T[], columnFilters: Record<string, string>): T[] {
  if (!Object.keys(columnFilters).length) return rows;
  return rows.filter(r => {
    for (const [k, raw] of Object.entries(columnFilters)) {
      const val = cellValue(r as any, k);
      if (isBlankSentinel(raw)) {
        if (!isBlankCellValue(val)) return false;
      } else if (!String(val).toLowerCase().includes(String(raw).toLowerCase())) {
        return false;
      }
    }
    return true;
  });
}

export function sortRowsClient<T>(
  rows: T[],
  sortBy: string | null,
  order: 'asc' | 'desc',
  compare?: (a: T, b: T) => number,
): T[] {
  if (!sortBy) return rows;
  if (compare) return [...rows].sort((a, b) => (order === 'asc' ? compare(a, b) : -compare(a, b)));
  // Generic string/number fallback used by the ad-hoc per-page sorters
  return [...rows].sort((a: any, b: any) => {
    const av = cellValue(a, sortBy);
    const bv = cellValue(b, sortBy);
    const an = Number(av);
    const bn = Number(bv);
    const avNum = !Number.isNaN(an) && av !== '';
    const bvNum = !Number.isNaN(bn) && bv !== '';
    let cmp = 0;
    if (avNum && bvNum) cmp = an - bn;
    else cmp = String(av).localeCompare(String(bv));
    return order === 'asc' ? cmp : -cmp;
  });
}

export function serverParamsFromColumnFilters(columnFilters: Record<string, string>): {
  params: Record<string, string>;
  blankKeys: string[];
} {
  const params: Record<string, string> = {};
  const blankKeys: string[] = [];
  for (const [k, v] of Object.entries(columnFilters)) {
    if (isBlankSentinel(v)) blankKeys.push(k);
    else if (v) params[k] = v;
  }
  return { params, blankKeys };
}

export function isBlankColumnFilter(columnFilters: Record<string, string>, key: string): boolean {
  return isBlankSentinel(columnFilters[key] ?? '');
}

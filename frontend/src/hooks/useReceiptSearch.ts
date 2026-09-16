import { useState, useCallback } from 'react';

// ── Shared search state (modern live search via SearchBar) ─────────────
// 6 pages duplicated this boilerplate verbatim:
//   searchResults/searchTotal/searchQuery + onSearchResults/onSearchClear
//   + loadSearchPage that calls receiptApi.search with page-specific
//   searchFilters + gating `searchResults !== null` vs local filtering.
// This hook centralises the *state machine*; pages only supply how to fetch.

export type ReceiptSearchState<T = any> = {
  searchResults: T[] | null;
  searchTotal: number;
  searchQuery: string;
};

export function useReceiptSearch<T = any>({
  pageSize = 25,
  searchFn,
}: {
  pageSize?: number;
  searchFn: (q: string, limit: number, offset: number) => Promise<{ results?: T[]; items?: T[]; total: number }>;
}) {
  const [searchResults, setSearchResults] = useState<T[] | null>(null);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');

  const onSearchResults = useCallback((results: T[], total: number) => {
    setSearchResults(results);
    setSearchTotal(total);
  }, []);

  const onSearchClear = useCallback(() => {
    setSearchResults(null);
    setSearchTotal(0);
    setSearchQuery('');
  }, []);

  const loadSearchPage = useCallback(
    async (pageNum: number) => {
      if (!searchQuery.trim()) return null;
      const offset = (pageNum - 1) * pageSize;
      const r = await searchFn(searchQuery.trim(), pageSize, offset);
      const results = (r.results ?? (r as any).items ?? []) as T[];
      const total = r.total ?? 0;
      setSearchResults(results);
      setSearchTotal(total);
      return { results, total };
    },
    [searchQuery, pageSize, searchFn],
  );

  return {
    searchResults,
    searchTotal,
    searchQuery,
    setSearchQuery,
    onSearchResults,
    onSearchClear,
    loadSearchPage,
  };
}

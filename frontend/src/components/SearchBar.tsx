import { useState, useRef, useEffect } from 'react';
import { Search, X } from 'lucide-react';
import { receiptApi } from '../services/api';

interface SearchBarProps {
  placeholder?: string;
  pageSize?: number;
  onResults: (results: any[], total: number) => void;
  onClear: () => void;
  onQueryChange?: (query: string) => void;
  searchKey?: string;
  /** Override the search backend (defaults to the user-scoped receipt search).
   *  Used e.g. by the admin approval center to search a cross-tenant list. */
  searchFn?: (q: string, limit: number, offset: number) => Promise<any>;
}

const SearchBar = ({
  placeholder = 'Search everything — supplier, item, invoice, pin...',
  pageSize = 25,
  onResults,
  onClear,
  onQueryChange,
  searchKey = '',
  searchFn,
}: SearchBarProps) => {
  const [inputValue, setInputValue] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [pdfOnly, setPdfOnly] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestId = useRef(0);
  const hadQuery = useRef(false);
  const searchFnRef = useRef(searchFn);
  const onResultsRef = useRef(onResults);
  const onClearRef = useRef(onClear);

  useEffect(() => { searchFnRef.current = searchFn; }, [searchFn]);
  useEffect(() => { onResultsRef.current = onResults; }, [onResults]);
  useEffect(() => { onClearRef.current = onClear; }, [onClear]);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = inputValue.trim();
    setError('');
    if (!q) {
      setTotal(0);
      setIsSearching(false);
      if (hadQuery.current) onClearRef.current();
      hadQuery.current = false;
      return undefined;
    }
    hadQuery.current = true;
    setIsSearching(true);
    searchTimer.current = setTimeout(async () => {
      const currentRequest = ++requestId.current;
      try {
        const r = searchFnRef.current
          ? await searchFnRef.current(q, pageSize, 0)
          : await receiptApi.search(q, pageSize, 0, pdfOnly ? { hasPdf: true } : undefined);
        if (currentRequest !== requestId.current) return;
        onResultsRef.current(r.results || r.items || [], r.total || 0);
        setTotal(r.total || 0);
        setIsSearching(false);
      } catch (e) {
        if (currentRequest !== requestId.current) return;
        onResultsRef.current([], 0);
        setError(e instanceof Error ? e.message : 'Search failed');
        setIsSearching(false);
      }
    }, 300);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
      requestId.current += 1;
    };
  }, [inputValue, pageSize, searchKey, pdfOnly]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    setInputValue(q);
    onQueryChange?.(q);
  };

  const clear = () => {
    setInputValue('');
    setTotal(0);
    setError('');
    setIsSearching(false);
    hadQuery.current = false;
    requestId.current += 1;
    onClearRef.current();
  };

  return (
    <>
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <input
          type="text"
          value={inputValue}
          onChange={handleChange}
          placeholder={placeholder}
          className="w-full pl-8 pr-8 py-1.5 text-sm border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
        />
        {inputValue && (
          <button onClick={clear}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <div className="flex items-center gap-2 mt-1.5">
        <button
          type="button"
          onClick={() => setPdfOnly(v => !v)}
          title="Restrict search results to PDF receipts"
          className={`px-2 py-0.5 rounded-full text-[11px] font-medium border transition-colors ${
            pdfOnly ? 'bg-red-50 border-red-300 text-red-600' : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100'
          }`}
        >
          📄 PDF only
        </button>
        {inputValue.trim() && !isSearching && (
          <p className={`text-xs ${error ? 'text-red-500' : 'text-gray-500'}`}>
            {error || <>{total} match{total !== 1 ? 'es' : ''}{total > 0 && <span className="text-blue-500"> · ranked</span>}</>}
          </p>
        )}
      </div>
    </>
  );
};

export default SearchBar;

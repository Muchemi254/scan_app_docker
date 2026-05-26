import { useState, useRef } from 'react';
import { Search, X } from 'lucide-react';
import { receiptApi } from '../services/api';

interface SearchBarProps {
  placeholder?: string;
  pageSize?: number;
  onResults: (results: any[], total: number) => void;
  onClear: () => void;
  onQueryChange?: (query: string) => void;
}

const SearchBar = ({
  placeholder = 'Search everything — supplier, item, invoice, pin...',
  pageSize = 25,
  onResults,
  onClear,
  onQueryChange,
}: SearchBarProps) => {
  const [inputValue, setInputValue] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [total, setTotal] = useState(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    setInputValue(q);
    onQueryChange?.(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!q.trim()) {
      setTotal(0);
      setIsSearching(false);
      onClear();
      return;
    }
    setIsSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const r = await receiptApi.search(q.trim(), pageSize, 0);
        onResults(r.results || [], r.total || 0);
        setTotal(r.total || 0);
        setIsSearching(false);
      } catch (_) {
        setIsSearching(false);
      }
    }, 300);
  };

  const clear = () => {
    setInputValue('');
    setTotal(0);
    setIsSearching(false);
    onClear();
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
      {inputValue.trim() && !isSearching && (
        <p className="text-xs text-gray-500 mt-1">
          {total} match{total !== 1 ? 'es' : ''}
          {total > 0 && <span className="text-blue-500"> · ranked</span>}
        </p>
      )}
    </>
  );
};

export default SearchBar;

import { useState, useEffect } from 'react';

export default function ExportNameModal({
  open,
  defaultName,
  count,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  defaultName: string;
  count: number;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(defaultName);
  useEffect(() => { if (open) setName(defaultName); }, [open, defaultName]);
  if (!open) return null;
  const safe = name.trim() || defaultName;
  const finalName = safe.endsWith('.csv') ? safe : `${safe}.csv`;
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-5 space-y-4">
        <h3 className="text-base font-semibold text-gray-900">Export filtered table</h3>
        <p className="text-xs text-gray-500">{count.toLocaleString()} row{count !== 1 ? 's' : ''} will be exported with current column selection.</p>
        <div>
          <label className="block text-xs font-medium text-gray-700 mb-1">File name</label>
          <input
            autoFocus
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && onConfirm(finalName)}
            className="w-full px-3 py-2 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder={defaultName}
          />
          <p className="text-[11px] text-gray-400 mt-1">Saved as: {finalName}</p>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onCancel} className="px-4 py-2 text-sm rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700">Cancel</button>
          <button onClick={() => onConfirm(finalName)} className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700">Download</button>
        </div>
      </div>
    </div>
  );
}

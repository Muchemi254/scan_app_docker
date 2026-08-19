import { useEffect, useState } from 'react';
import { receiptApi } from '../services/api';
import { History, Clock, User, ArrowRight } from 'lucide-react';

interface AuditEntry {
  id: string;
  receipt_id: string;
  action: string;
  changed_by: string;
  timestamp: string;
  changes: { field: string; old_value: any; new_value: any; action?: string }[];
}

const AuditTrail = ({ receiptId, ownerUid }: { receiptId: string; ownerUid?: string }) => {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!receiptId) return;
    const fetch = async () => {
      try {
        const res = await receiptApi.getAuditTrail(receiptId, ownerUid);
        setEntries(res.items || []);
      } catch (err) {
        console.error('Failed to load audit trail:', err);
      } finally {
        setLoading(false);
      }
    };
    fetch();
  }, [receiptId, ownerUid]);

  if (loading) return null;
  if (entries.length === 0) return null;

  const actionLabel = (action: string) => {
    switch (action) {
      case 'created': return { text: 'Created', color: 'text-green-600 bg-green-50 border-green-200' };
      case 'updated': return { text: 'Updated', color: 'text-blue-600 bg-blue-50 border-blue-200' };
      case 'deleted': return { text: 'Deleted', color: 'text-red-600 bg-red-50 border-red-200' };
      default: return { text: action, color: 'text-gray-600 bg-gray-50 border-gray-200' };
    }
  };

  return (
    <div className="border border-gray-200 rounded-lg bg-white">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-gray-500" />
          <span className="font-semibold text-sm text-gray-700">Audit Trail</span>
          <span className="text-xs text-gray-400 font-medium">({entries.length} events)</span>
        </div>
        <svg
          className={`h-4 w-4 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="border-t divide-y max-h-80 overflow-y-auto">
          {entries.map(entry => {
            const action = actionLabel(entry.action);
            const ts = new Date(entry.timestamp).toLocaleString();
            return (
              <div key={entry.id} className="px-4 py-3 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded border ${action.color}`}>
                    {action.text}
                  </span>
                  <span className="text-xs text-gray-500 flex items-center gap-1">
                    <Clock className="h-3 w-3" /> {ts}
                  </span>
                  <span className="text-xs text-gray-400 flex items-center gap-1">
                    <User className="h-3 w-3" /> {entry.changed_by.slice(0, 8)}…
                  </span>
                </div>
                {entry.changes.length > 0 && (
                  <div className="ml-1 space-y-1">
                    {entry.changes.map((change, i) => (
                      <div key={i} className="flex items-center gap-2 text-xs text-gray-600">
                        <span className="font-mono font-medium text-gray-500 min-w-[7rem]">{change.field}</span>
                        {change.action === 'created' ? (
                          <span className="text-green-600 truncate max-w-[200px]">
                            {typeof change.new_value === 'object'
                              ? JSON.stringify(change.new_value).slice(0, 60)
                              : String(change.new_value ?? '')}
                          </span>
                        ) : change.action === 'deleted' ? (
                          <span className="text-red-600 truncate max-w-[200px]">
                            {typeof change.old_value === 'object'
                              ? JSON.stringify(change.old_value).slice(0, 60)
                              : String(change.old_value ?? '')}
                          </span>
                        ) : (
                          <>
                            <span className="text-red-500 truncate max-w-[150px]">
                              {typeof change.old_value === 'object'
                                ? JSON.stringify(change.old_value).slice(0, 40)
                                : String(change.old_value ?? '—')}
                            </span>
                            <ArrowRight className="h-3 w-3 text-gray-400 flex-shrink-0" />
                            <span className="text-green-600 truncate max-w-[150px]">
                              {typeof change.new_value === 'object'
                                ? JSON.stringify(change.new_value).slice(0, 40)
                                : String(change.new_value ?? '—')}
                            </span>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default AuditTrail;

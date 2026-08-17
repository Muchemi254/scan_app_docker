import { useState, useRef, useEffect, useCallback } from 'react';
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { useScopeStore } from '../stores/scopeStore';
import { adminListUsers } from '../services/auth';
import {
  Home, Camera, FileText, ClipboardCheck, Download,
  LogOut, Menu, X, ChevronDown, User, Settings,
  Images, Sparkles, Search, ListChecks, Bell,
  Shield, PlusCircle, CheckCheck, Users, MessageCircle,
} from 'lucide-react';
import { scanErrorApi } from '../services/api';
import { messagesApi } from '../services/messagesApi';
import { isAllowedWhileImpersonating } from '../utils/scope';
import { toast } from '../stores/toastStore';
import MessageCenter from './MessageCenter';
import { useMessageStream } from '../hooks/useMessageStream';

const Layout = () => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAuthStore(s => s.user);
  const signOut = useAuthStore(s => s.signOut);
  const setActiveUid = useScopeStore((s) => s.setActiveUid);
  const activeUid = useScopeStore((s) => s.activeUid);
  const [scopeUsers, setScopeUsers] = useState<any[]>([]);

  // Admin is operating inside another user's workspace (approval-mode).
  const impersonating = !!activeUid && activeUid !== user?.uid;
  const scopeOwnerEmail =
    scopeUsers.find((u: any) => u.uid === activeUid)?.email || 'this user';

  const receiptsRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);

  // Unread scan/error notifications badge (skipped while impersonating so we
  // never pull another user's personal data).
  const [unread, setUnread] = useState(0);
  const currentUid = user?.uid;
  const refreshUnread = useCallback(async () => {
    if (!currentUid || impersonating) return;
    try {
      const { unread: n } = await scanErrorApi.unreadCount();
      setUnread(n ?? 0);
    } catch {
      /* badge is best-effort */
    }
  }, [currentUid, impersonating]);

  useEffect(() => {
    refreshUnread();
    const timer = setInterval(refreshUnread, 30000);
    return () => clearInterval(timer);
  }, [refreshUnread]);

  // Refresh the badge immediately after visiting the notifications page.
  useEffect(() => {
    if (location.pathname === '/notifications') refreshUnread();
  }, [location.pathname, refreshUnread]);

  // ── Messages ────────────────────────────────────────────────────────────
  const [msgOpen, setMsgOpen] = useState(false);
  const [msgUnread, setMsgUnread] = useState(0);
  const refreshMsgUnread = useCallback(async () => {
    if (!currentUid || impersonating) return;
    try {
      const { unread } = await messagesApi.unreadCount();
      setMsgUnread(unread ?? 0);
    } catch {
      /* badge is best-effort */
    }
  }, [currentUid, impersonating]);

  useEffect(() => {
    refreshMsgUnread();
    const timer = setInterval(refreshMsgUnread, 30000);
    return () => clearInterval(timer);
  }, [refreshMsgUnread]);

  // Instant badge update when a message arrives while the drawer is closed.
  useMessageStream((ev) => {
    if (ev.type !== 'message' || impersonating) return;
    setMsgUnread(n => n + 1);
    if (!msgOpen) {
      toast('info', 'New message', 'You have a new message', { duration: 4000 });
    }
  });

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (receiptsRef.current && !receiptsRef.current.contains(e.target as Node)) setReceiptsOpen(false);
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) setProfileOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleLogout = async () => {
    try { signOut(); navigate('/login'); }
    catch (error) { console.error('Logout failed:', error); }
  };

  const isActive = (path: string) => location.pathname.startsWith(path);
  const isExact = (path: string) => location.pathname === path;

  const userEmail = user?.email || 'User';
  const userName = userEmail.split('@')[0];

  // When impersonating, lock any page that isn't approval/review related.
  useEffect(() => {
    if (impersonating && !isAllowedWhileImpersonating(location.pathname)) {
      navigate('/review', { replace: true });
    }
  }, [impersonating, location.pathname, navigate]);

  // Load the user list for the admin scope selector.
  useEffect(() => {
    if (!user?.is_admin) {
      setScopeUsers([]);
      return;
    }
    adminListUsers()
      .then(setScopeUsers)
      .catch(() => setScopeUsers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.is_admin]);

  const receiptsItems = impersonating
    ? [
        { path: '/receipts', label: 'All Receipts', icon: FileText },
        { path: '/review', label: 'Review', icon: ClipboardCheck },
      ]
    : [
        { path: '/receipts', label: 'All Receipts', icon: FileText },
        { path: '/review', label: 'Review', icon: ClipboardCheck },
        { path: '/gallery', label: 'Gallery', icon: Images },
        { path: '/review-batches', label: 'Batches', icon: ListChecks },
        { path: '/cleaning', label: 'Clean', icon: Sparkles },
        { path: '/post-receipt', label: 'Manual Entry', icon: PlusCircle },
      ];

  const DropdownMenu = ({ items, open, onSelect }: { items: any[], open: boolean, onSelect: () => void }) => (
    <div className={`absolute top-full left-0 mt-1 w-56 bg-white rounded-lg shadow-lg border py-1 z-50 transition-all duration-150 ${open ? 'opacity-100 visible' : 'opacity-0 invisible'}`}>
      {items.map(item => {
        const Icon = item.icon;
        const active = isExact(item.path) || (item.path.includes('?') && location.pathname + location.search === item.path);
        return (
          <button
            key={item.path}
            onClick={() => { navigate(item.path); onSelect(); }}
            className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
              active ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-50'
            }`}
          >
            <Icon className="h-4 w-4" />
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top Navigation Bar */}
      <nav className="bg-white shadow-md sticky top-0 z-50">
        <div className="w-full px-4 sm:px-6">
          <div className="flex justify-between items-center h-14">
            {/* Left: Logo + Nav */}
            <div className="flex items-center gap-1">
              <Link to="/dashboard" className="flex items-center gap-2 text-lg font-bold text-blue-600 mr-4">
                <FileText className="h-5 w-5" />
                <span className="hidden sm:inline">RM</span>
              </Link>

              {/* Desktop Nav Items */}
              <div className="hidden md:flex items-center gap-0.5">
                {!impersonating && (
                  <Link to="/dashboard"
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${isExact('/dashboard') ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-100'}`}>
                    <Home className="h-4 w-4" /><span>Dashboard</span>
                  </Link>
                )}

                {!impersonating && (
                  <Link to="/scanner"
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${isExact('/scanner') ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-100'}`}>
                    <Camera className="h-4 w-4" /><span>Scanner</span>
                  </Link>
                )}

                {!impersonating && (
                  <Link to="/scans"
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${isExact('/scans') ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-100'}`}>
                    <ListChecks className="h-4 w-4" /><span>Scans</span>
                  </Link>
                )}

                {/* Receipts Dropdown */}
                <div ref={receiptsRef} className="relative">
                  <button onClick={() => setReceiptsOpen(!receiptsOpen)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                      receiptsItems.some(i => isActive(i.path)) ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-100'
                    }`}>
                    <Search className="h-4 w-4" /><span>Receipts</span>
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform ${receiptsOpen ? 'rotate-180' : ''}`} />
                  </button>
                  <DropdownMenu items={receiptsItems} open={receiptsOpen} onSelect={() => setReceiptsOpen(false)} />
                </div>

                {/* My Approvals — user's own pending/approved documents */}
                {!impersonating && (
                  <Link to="/my-approvals"
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${isActive('/my-approvals') ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-100'}`}>
                    <CheckCheck className="h-4 w-4" /><span>My Approvals</span>
                  </Link>
                )}

                {/* Settings — direct link (tabs handle sub-navigation) */}
                {!impersonating && (
                  <Link to="/settings"
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                      isActive('/settings') ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-100'
                    }`}>
                    <Settings className="h-4 w-4" /><span>Settings</span>
                  </Link>
                )}

                {user?.is_admin && (
                  <Link to="/admin"
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                      isActive('/admin') ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-100'
                    }`}>
                    <Shield className="h-4 w-4" /><span>Admin</span>
                  </Link>
                )}

                {user?.is_admin && (
                  <Link to="/approvals"
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                      isActive('/approvals') ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-100'
                    }`}>
                    <CheckCheck className="h-4 w-4" /><span>Approvals</span>
                  </Link>
                )}

                {user?.is_admin && (
                  <div className="flex items-center gap-1.5 ml-1 pl-2 border-l border-gray-200">
                    <Users className="h-4 w-4 text-gray-400" />
                    <select
                      value={activeUid || user.uid}
                      onChange={(e) => setActiveUid(e.target.value === user.uid ? null : e.target.value)}
                      title="Admin: choose whose workspace to view/edit"
                      className="max-w-[150px] px-2 py-1 text-xs border rounded bg-white text-gray-700"
                    >
                      <option value={user.uid}>My account</option>
                      {scopeUsers
                        .filter((u: any) => u.uid !== user.uid)
                        .map((u: any) => (
                          <option key={u.uid} value={u.uid}>{u.email}</option>
                        ))}
                    </select>
                  </div>
                )}
              </div>
            </div>

            {/* Right: Messages + Notifications bell + Profile Dropdown */}
            <div className="flex items-center gap-2">
              {!impersonating && (
                <button
                  onClick={() => setMsgOpen(true)}
                  className="relative p-2 rounded-lg text-gray-600 hover:bg-gray-100 transition"
                  aria-label="Messages"
                >
                  <MessageCircle className="h-5 w-5" />
                  {msgUnread > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-blue-500 text-white text-[10px] font-semibold flex items-center justify-center">
                      {msgUnread > 99 ? '99+' : msgUnread}
                    </span>
                  )}
                </button>
              )}

              {!impersonating && (
                <Link
                  to="/notifications"
                  className="relative p-2 rounded-lg text-gray-600 hover:bg-gray-100 transition"
                  aria-label="Notifications"
                >
                  <Bell className="h-5 w-5" />
                  {unread > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-semibold flex items-center justify-center">
                      {unread > 99 ? '99+' : unread}
                    </span>
                  )}
                </Link>
              )}

              <div ref={profileRef} className="relative hidden md:block">
                <button onClick={() => setProfileOpen(!profileOpen)}
                  className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-gray-600 hover:bg-gray-100 transition-colors">
                  <div className="w-7 h-7 rounded-full bg-blue-500 flex items-center justify-center text-white text-xs font-bold">
                    {userName[0]?.toUpperCase()}
                  </div>
                  <span className="hidden lg:inline max-w-[120px] truncate">{userName}</span>
                  <ChevronDown className={`h-3.5 w-3.5 transition-transform ${profileOpen ? 'rotate-180' : ''}`} />
                </button>
                <div className={`absolute top-full right-0 mt-1 w-48 bg-white rounded-lg shadow-lg border py-1 z-50 transition-all duration-150 ${profileOpen ? 'opacity-100 visible' : 'opacity-0 invisible'}`}>
                  <div className="px-4 py-2 border-b">
                    <p className="text-sm font-medium text-gray-900 truncate">{userName}</p>
                    <p className="text-xs text-gray-500 truncate">{userEmail}</p>
                  </div>
                  <button onClick={handleLogout}
                    className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors">
                    <LogOut className="h-4 w-4" /><span>Logout</span>
                  </button>
                </div>
              </div>

              {/* Mobile logout */}
              <button onClick={handleLogout} className="md:hidden p-2 text-red-600 hover:bg-red-50 rounded-lg">
                <LogOut className="h-5 w-5" />
              </button>

              {/* Mobile Menu Toggle */}
              <button onClick={() => setMobileMenuOpen(!mobileMenuOpen)} className="md:hidden p-2 rounded-lg text-gray-700 hover:bg-gray-100">
                {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
              </button>
            </div>
          </div>
        </div>

        {/* Mobile Menu */}
        <div className={`md:hidden transition-all duration-300 ease-in-out overflow-hidden ${mobileMenuOpen ? 'max-h-screen opacity-100' : 'max-h-0 opacity-0'}`}>
          <div className="px-4 pt-2 pb-4 space-y-1 border-t">
            {!impersonating && (
              <Link to="/dashboard" onClick={() => setMobileMenuOpen(false)}
                className={`flex items-center gap-3 px-4 py-2.5 rounded-lg ${isExact('/dashboard') ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100'}`}>
                <Home className="h-5 w-5" /><span>Dashboard</span>
              </Link>
            )}
            {!impersonating && (
              <Link to="/scanner" onClick={() => setMobileMenuOpen(false)}
                className={`flex items-center gap-3 px-4 py-2.5 rounded-lg ${isExact('/scanner') ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100'}`}>
                <Camera className="h-5 w-5" /><span>Scanner</span>
              </Link>
            )}
            {!impersonating && (
              <Link to="/scans" onClick={() => setMobileMenuOpen(false)}
                className={`flex items-center gap-3 px-4 py-2.5 rounded-lg ${isExact('/scans') ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100'}`}>
                <ListChecks className="h-5 w-5" /><span>Scans</span>
              </Link>
            )}
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider px-4 pt-2">Receipts</div>
            {receiptsItems.map(item => {
              const Icon = item.icon;
              return (
                <Link key={item.path} to={item.path} onClick={() => setMobileMenuOpen(false)}
                  className={`flex items-center gap-3 px-4 py-2.5 rounded-lg ${isExact(item.path) ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100'}`}>
                  <Icon className="h-5 w-5" /><span>{item.label}</span>
                </Link>
              );
            })}
            {!impersonating && (
              <Link to="/my-approvals" onClick={() => setMobileMenuOpen(false)}
                className={`flex items-center gap-3 px-4 py-2.5 rounded-lg ${isActive('/my-approvals') ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100'}`}>
                <CheckCheck className="h-5 w-5" /><span>My Approvals</span>
              </Link>
            )}
            {!impersonating && (
              <>
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider px-4 pt-2">Settings</div>
                <Link to="/settings" onClick={() => setMobileMenuOpen(false)}
                  className={`flex items-center gap-3 px-4 py-2.5 rounded-lg ${isExact('/settings') ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100'}`}>
                  <Settings className="h-5 w-5" /><span>Settings</span>
                </Link>
              </>
            )}
            {user?.is_admin && (
              <Link to="/admin" onClick={() => setMobileMenuOpen(false)}
                className={`flex items-center gap-3 px-4 py-2.5 rounded-lg ${isExact('/admin') ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100'}`}>
                <Shield className="h-5 w-5" /><span>Admin</span>
              </Link>
            )}
            {user?.is_admin && (
              <Link to="/approvals" onClick={() => setMobileMenuOpen(false)}
                className={`flex items-center gap-3 px-4 py-2.5 rounded-lg ${isExact('/approvals') ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100'}`}>
                <CheckCheck className="h-5 w-5" /><span>Approvals</span>
              </Link>
            )}
            <button onClick={() => { setMobileMenuOpen(false); handleLogout(); }}
              className="flex items-center gap-3 w-full px-4 py-2.5 rounded-lg text-red-600 hover:bg-red-50">
              <LogOut className="h-5 w-5" /><span>Logout</span>
            </button>
          </div>
        </div>
      </nav>

      {impersonating && (
        <div className="bg-amber-100 border-b border-amber-200 px-4 py-2 flex items-center justify-between gap-3 flex-wrap">
          <p className="text-sm text-amber-900">
            <Shield className="h-4 w-4 inline mr-1 -mt-0.5" />
            Approval mode — viewing <strong>{scopeOwnerEmail}</strong>'s workspace. Only review &amp; approvals are available here.
          </p>
          <button
            onClick={() => { setActiveUid(null); navigate('/dashboard'); }}
            className="text-xs px-3 py-1 rounded bg-amber-600 text-white hover:bg-amber-700 font-medium"
          >
            Exit scope
          </button>
        </div>
      )}

      <main className="w-full">
        <Outlet />
      </main>

      {/* Message center drawer */}
      <MessageCenter
        open={msgOpen && !impersonating}
        onClose={() => setMsgOpen(false)}
        onUnreadChange={(n) => setMsgUnread(n)}
      />
    </div>
  );
};

export default Layout;

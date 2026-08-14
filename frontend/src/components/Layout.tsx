import { useState, useRef, useEffect, useCallback } from 'react';
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import {
  Home, Camera, FileText, ClipboardCheck, Download,
  LogOut, Menu, X, ChevronDown, User, Settings,
  Images, Sparkles, Search, ListChecks, Bell,
  Shield, PlusCircle,
} from 'lucide-react';
import { scanErrorApi } from '../services/api';

const Layout = () => {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [receiptsOpen, setReceiptsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const user = useAuthStore(s => s.user);
  const signOut = useAuthStore(s => s.signOut);

  const receiptsRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);

  // Unread scan/error notifications badge
  const [unread, setUnread] = useState(0);
  const currentUid = user?.uid;
  const refreshUnread = useCallback(async () => {
    if (!currentUid) return;
    try {
      const { unread: n } = await scanErrorApi.unreadCount();
      setUnread(n ?? 0);
    } catch {
      /* badge is best-effort */
    }
  }, [currentUid]);

  useEffect(() => {
    refreshUnread();
    const timer = setInterval(refreshUnread, 30000);
    return () => clearInterval(timer);
  }, [refreshUnread]);

  // Refresh the badge immediately after visiting the notifications page.
  useEffect(() => {
    if (location.pathname === '/notifications') refreshUnread();
  }, [location.pathname, refreshUnread]);

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

  const receiptsItems = [
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
                <Link to="/dashboard"
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${isExact('/dashboard') ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-100'}`}>
                  <Home className="h-4 w-4" /><span>Dashboard</span>
                </Link>

                <Link to="/scanner"
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${isExact('/scanner') ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-100'}`}>
                  <Camera className="h-4 w-4" /><span>Scanner</span>
                </Link>

                <Link to="/scans"
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${isExact('/scans') ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-100'}`}>
                  <ListChecks className="h-4 w-4" /><span>Scans</span>
                </Link>

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

                {/* Settings — direct link (tabs handle sub-navigation) */}
                <Link to="/settings"
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                    isActive('/settings') ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-100'
                  }`}>
                  <Settings className="h-4 w-4" /><span>Settings</span>
                </Link>

                {user?.is_admin && (
                  <Link to="/admin"
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                      isActive('/admin') ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-100'
                    }`}>
                    <Shield className="h-4 w-4" /><span>Admin</span>
                  </Link>
                )}
              </div>
            </div>

            {/* Right: Notifications bell + Profile Dropdown */}
            <div className="flex items-center gap-2">
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
            <Link to="/dashboard" onClick={() => setMobileMenuOpen(false)}
              className={`flex items-center gap-3 px-4 py-2.5 rounded-lg ${isExact('/dashboard') ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100'}`}>
              <Home className="h-5 w-5" /><span>Dashboard</span>
            </Link>
            <Link to="/scanner" onClick={() => setMobileMenuOpen(false)}
              className={`flex items-center gap-3 px-4 py-2.5 rounded-lg ${isExact('/scanner') ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100'}`}>
              <Camera className="h-5 w-5" /><span>Scanner</span>
            </Link>
            <Link to="/scans" onClick={() => setMobileMenuOpen(false)}
              className={`flex items-center gap-3 px-4 py-2.5 rounded-lg ${isExact('/scans') ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100'}`}>
              <ListChecks className="h-5 w-5" /><span>Scans</span>
            </Link>
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
            <div className="text-xs font-semibold text-gray-400 uppercase tracking-wider px-4 pt-2">Settings</div>
            <Link to="/settings" onClick={() => setMobileMenuOpen(false)}
              className={`flex items-center gap-3 px-4 py-2.5 rounded-lg ${isExact('/settings') ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100'}`}>
              <Settings className="h-5 w-5" /><span>Settings</span>
            </Link>
            {user?.is_admin && (
              <Link to="/admin" onClick={() => setMobileMenuOpen(false)}
                className={`flex items-center gap-3 px-4 py-2.5 rounded-lg ${isExact('/admin') ? 'bg-blue-100 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100'}`}>
                <Shield className="h-5 w-5" /><span>Admin</span>
              </Link>
            )}
            <button onClick={() => { setMobileMenuOpen(false); handleLogout(); }}
              className="flex items-center gap-3 w-full px-4 py-2.5 rounded-lg text-red-600 hover:bg-red-50">
              <LogOut className="h-5 w-5" /><span>Logout</span>
            </button>
          </div>
        </div>
      </nav>

      <main className="w-full">
        <Outlet />
      </main>
    </div>
  );
};

export default Layout;

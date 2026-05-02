import type { PageKey } from '../../App';
import { useAuth } from '../../context/AuthContext';

type SidebarProps = {
  activePage: PageKey;
  onNavigate: (page: PageKey) => void;
  onLogout: () => void;
};

const navItems: Array<{ key: PageKey; label: string; icon: string }> = [
  { key: 'dashboard', label: 'Dashboard', icon: '🏠' },
  { key: 'lessons', label: 'Lessons', icon: '📚' },
  { key: 'practices', label: 'Practices', icon: '📝' },
  { key: 'quizzes', label: 'Quizzes', icon: '🧩' },
  { key: 'exam', label: 'Exam', icon: '📋' },
  { key: 'analysis', label: 'Analysis', icon: '📊' }
];

function Sidebar({ activePage, onNavigate, onLogout }: SidebarProps) {
  const { user } = useAuth();

  return (
    <aside className="sidebar glass-panel">
      <div className="sidebar-profile">
        <div className="avatar-orb">{user.initials}</div>
        <div>
          <h2>{user.name}</h2>
          <p>{user.role}</p>
        </div>
      </div>

      <nav className="sidebar-nav">
        {navItems.map((item) => (
          <button
            key={item.key}
            className={`nav-item ${activePage === item.key ? 'active' : ''}`}
            onClick={() => onNavigate(item.key)}
            type="button"
          >
            <span className="nav-icon" aria-hidden="true">
              {item.icon}
            </span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <button className="logout-button" onClick={onLogout} type="button">
        <span aria-hidden="true">↩</span>
        <span>Logout</span>
      </button>
    </aside>
  );
}

export default Sidebar;

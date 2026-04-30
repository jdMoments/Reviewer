import { useAuth } from '../../context/AuthContext';
import { formatToday } from '../../utils/helpers';

type HeaderProps = {
  badgeText?: string;
};

function Header({ badgeText = "You're on a 5-day streak" }: HeaderProps) {
  const { user } = useAuth();
  const firstName = user.name.split(' ')[0] || user.name;

  return (
    <header className="dashboard-header">
      <div>
        <span className="eyebrow">Learning Command Center</span>
        <h1>Welcome back, {firstName}</h1>
        <p>{formatToday()}</p>
      </div>
      <div className="streak-badge">{badgeText}</div>
    </header>
  );
}

export default Header;

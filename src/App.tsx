import { useState } from 'react';
import Sidebar from './components/Sidebar';
import Dashboard from './pages/Dashboard';
import Practices from './pages/Practices';
import Lesson from './pages/Lesson';
import Quizzes from './pages/Quizzes';
import Analysis from './pages/Analysis';
import Exam from './pages/Exam';
import Login from './pages/Login';
import { useAuth } from './context/AuthContext';

export type PageKey = 'dashboard' | 'practices' | 'lessons' | 'quizzes' | 'analysis' | 'exam';

const CURTAIN_SWAP_MS = 280;
const CURTAIN_TOTAL_MS = 680;

function App() {
  const { isAuthenticated, completeLogin, signOut } = useAuth();
  const [activePage, setActivePage] = useState<PageKey>('dashboard');
  const [contentStage, setContentStage] = useState<'idle' | 'out' | 'in'>('in');
  const [curtainMode, setCurtainMode] = useState<'idle' | 'forward' | 'reverse'>('idle');

  const pageContent = (() => {
    switch (activePage) {
      case 'dashboard':
        return <Dashboard onQuickNavigate={handleNavigate} />;
      case 'practices':
        return <Practices />;
      case 'lessons':
        return <Lesson />;
      case 'quizzes':
        return <Quizzes />;
      case 'analysis':
        return <Analysis />;
      case 'exam':
        return <Exam />;
      default:
        return <Dashboard onQuickNavigate={handleNavigate} />;
    }
  })();

  function handleNavigate(nextPage: PageKey) {
    if (nextPage === activePage) {
      return;
    }

    setContentStage('out');
    window.setTimeout(() => {
      setActivePage(nextPage);
      setContentStage('in');
    }, 150);
  }

  function handleLoginSuccess() {
    setCurtainMode('forward');
    window.setTimeout(() => {
      completeLogin();
    }, CURTAIN_SWAP_MS);
    window.setTimeout(() => {
      setCurtainMode('idle');
      setContentStage('in');
    }, CURTAIN_TOTAL_MS);
  }

  function handleLogout() {
    setCurtainMode('reverse');
    window.setTimeout(() => {
      setActivePage('dashboard');
      signOut();
    }, CURTAIN_SWAP_MS);
    window.setTimeout(() => {
      setCurtainMode('idle');
      setContentStage('in');
    }, CURTAIN_TOTAL_MS);
  }

  return (
    <div className="app-shell-root">
      <div className="mesh mesh-one" />
      <div className="mesh mesh-two" />

      <div
        className={[
          'curtain',
          curtainMode === 'forward' ? 'curtain-forward' : '',
          curtainMode === 'reverse' ? 'curtain-reverse' : ''
        ]
          .filter(Boolean)
          .join(' ')}
      />

      {!isAuthenticated ? (
        <Login onSuccess={handleLoginSuccess} />
      ) : (
        <div className="app-shell page-enter">
          <Sidebar activePage={activePage} onNavigate={handleNavigate} onLogout={handleLogout} />
          <main
            className={[
              'content-shell',
              contentStage === 'out' ? 'content-fade-out' : '',
              contentStage === 'in' ? 'content-fade-in' : ''
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {pageContent}
          </main>
        </div>
      )}
    </div>
  );
}

export default App;

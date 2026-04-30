import { useEffect, useMemo, useState } from 'react';
import type { PageKey } from '../App';
import ActivityFeed from '../components/ActivityFeed';
import DetailPanel from '../components/DetailPanel';
import Header from '../components/Header';
import Loader from '../components/Loader';
import Modal from '../components/Modal';
import QuickStart from '../components/QuickStart';
import StatCard, { type StatCardData } from '../components/StatCard';
import { useAuth } from '../context/AuthContext';
import {
  getPracticeWorkspace,
  normalizePracticeTopics,
  type PracticeQuizRecord,
  type PracticeWorkspace
} from '../lib/supabase';

type DashboardProps = {
  onQuickNavigate: (page: PageKey) => void;
};

type DashboardQuizAnalytics = {
  attempts: number;
  label: string;
  passed: boolean;
  practiceCompletion: number;
  quizAccuracy: number;
  scoreLabel: string;
  totalQuestions: number;
};

type ActivityItem = {
  title: string;
  time: string;
  tag: string;
};

function isPlaceholderQuestion(prompt: string) {
  return /^Question\s+\d+$/i.test(prompt.trim());
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function roundToSingleDecimal(value: number) {
  return Math.round(value * 10) / 10;
}

function formatSyncLabel(dateValue: string | undefined) {
  if (!dateValue) {
    return 'Current workspace';
  }

  const parsed = new Date(dateValue);

  if (Number.isNaN(parsed.getTime())) {
    return 'Current workspace';
  }

  return `Updated ${new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(parsed)}`;
}

function buildQuizAnalytics(quiz: PracticeQuizRecord, topic: string): DashboardQuizAnalytics {
  const totalQuestions = Math.max(quiz.itemCount, quiz.questions.length, 1);
  const preparedQuestions = quiz.questions.filter(
    (question) =>
      question.prompt.trim().length > 0 &&
      !isPlaceholderQuestion(question.prompt) &&
      question.answer.trim().length > 0
  ).length;
  const practiceCompletion = clampPercent((preparedQuestions / totalQuestions) * 100);
  const quizAccuracy = quiz.attempts > 0 ? clampPercent(quiz.lastAccuracy) : 0;

  return {
    attempts: quiz.attempts,
    label: `${topic} ${quiz.id}`,
    passed: quiz.attempts > 0 && quiz.lastAccuracy >= 75,
    practiceCompletion,
    quizAccuracy,
    scoreLabel:
      quiz.attempts > 0
        ? `${quiz.lastScore}/${quiz.questions.length || totalQuestions}`
        : 'Not attempted',
    totalQuestions
  };
}

function getAverage(values: number[]) {
  if (!values.length) {
    return 0;
  }

  return clampPercent(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function getReportIntro(stat: StatCardData) {
  switch (stat.id) {
    case 'practice':
      return 'This reflects how fully your created quizzes are prepared with usable questions and answers.';
    case 'quiz':
      return 'This reflects your average accuracy across the quizzes you have already attempted.';
    case 'attempts':
      return 'This shows how many of your created quizzes have already been taken at least once.';
    case 'overall':
      return 'This combines readiness, attempts, and passed quizzes into one overall progress view.';
    default:
      return 'This card reflects your latest saved workspace progress.';
  }
}

function Dashboard({ onQuickNavigate }: DashboardProps) {
  const { isAuthenticated, user } = useAuth();
  const [selectedStat, setSelectedStat] = useState<StatCardData | null>(null);
  const [modalStat, setModalStat] = useState<StatCardData | null>(null);
  const [workspace, setWorkspace] = useState<PracticeWorkspace | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const flashcardsReport = useMemo(
    () => ({
      title: 'Flashcard Review Queue',
      message:
        'Flashcards are queued as the next learning module. This prototype keeps the entry point visible while the full review engine is still being wired in.'
    }),
    []
  );
  const [showFlashcardsModal, setShowFlashcardsModal] = useState(false);

  useEffect(() => {
    if (!isAuthenticated || !user.id) {
      setWorkspace(null);
      return;
    }

    let cancelled = false;

    async function loadWorkspace() {
      setIsLoading(true);

      try {
        const nextWorkspace = await getPracticeWorkspace(user.id);

        if (!cancelled) {
          setWorkspace(nextWorkspace);
        }
      } catch {
        if (!cancelled) {
          setWorkspace(null);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadWorkspace();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, user.id]);

  const practiceTopics = useMemo(() => normalizePracticeTopics(workspace), [workspace]);

  const analytics = useMemo(
    () =>
      practiceTopics.flatMap((topic) =>
        topic.quizzes.map((quiz) => buildQuizAnalytics(quiz, topic.title))
      ),
    [practiceTopics]
  );

  const summary = useMemo(() => {
    const totalQuizzes = analytics.length;
    const attemptedQuizzes = analytics.filter((quiz) => quiz.attempts > 0).length;
    const readyQuizzes = analytics.filter((quiz) => quiz.practiceCompletion === 100).length;
    const passedQuizzes = analytics.filter((quiz) => quiz.passed).length;
    const averagePracticeCompletion = getAverage(
      analytics.map((quiz) => quiz.practiceCompletion)
    );
    const attemptedAccuracy = analytics
      .filter((quiz) => quiz.attempts > 0)
      .map((quiz) => quiz.quizAccuracy);
    const averageQuizAccuracy = getAverage(attemptedAccuracy);
    const attemptRate = totalQuizzes
      ? clampPercent((attemptedQuizzes / totalQuizzes) * 100)
      : 0;
    const passRate = totalQuizzes ? clampPercent((passedQuizzes / totalQuizzes) * 100) : 0;
    const overallProgress = totalQuizzes
      ? roundToSingleDecimal((averagePracticeCompletion + attemptRate + passRate) / 3)
      : 0;

    return {
      attemptRate,
      attemptedQuizzes,
      averagePracticeCompletion,
      averageQuizAccuracy,
      overallProgress,
      passedQuizzes,
      passRate,
      readyQuizzes,
      totalQuizzes
    };
  }, [analytics]);

  const topicCompletionBreakdown = useMemo(
    () =>
      practiceTopics.map((topic) => ({
        label: topic.title,
        value: getAverage(
          topic.quizzes.map((quiz) => buildQuizAnalytics(quiz, topic.title).practiceCompletion)
        )
      })),
    [practiceTopics]
  );

  const topicAccuracyBreakdown = useMemo(
    () =>
      practiceTopics.map((topic) => {
        const attemptedAccuracies = topic.quizzes
          .map((quiz) => buildQuizAnalytics(quiz, topic.title))
          .filter((quiz) => quiz.attempts > 0)
          .map((quiz) => quiz.quizAccuracy);

        return {
          label: topic.title,
          value: getAverage(attemptedAccuracies)
        };
      }),
    [practiceTopics]
  );

  const topicAttemptBreakdown = useMemo(
    () =>
      practiceTopics.map((topic) => ({
        label: topic.title,
        value: topic.quizzes.length
          ? clampPercent(
              (topic.quizzes.filter((quiz) => quiz.attempts > 0).length / topic.quizzes.length) *
                100
            )
          : 0
      })),
    [practiceTopics]
  );

  const statCards = useMemo<StatCardData[]>(() => {
    const practiceTrend = analytics.length
      ? analytics.map((quiz) => quiz.practiceCompletion)
      : [0, 0];
    const quizTrend = analytics.some((quiz) => quiz.attempts > 0)
      ? analytics.filter((quiz) => quiz.attempts > 0).map((quiz) => quiz.quizAccuracy)
      : [0, 0];
    const attemptTrend = topicAttemptBreakdown.length
      ? topicAttemptBreakdown.map((item) => item.value)
      : [0, 0];

    return [
      {
        id: 'practice',
        title: 'Practice Readiness',
        icon: 'P',
        value: summary.averagePracticeCompletion,
        suffix: '%',
        label:
          summary.totalQuizzes > 0
            ? `${summary.readyQuizzes} of ${summary.totalQuizzes} quizzes fully prepared`
            : 'No quizzes created yet',
        accent: '#22d3c5',
        trend: practiceTrend,
        breakdown: topicCompletionBreakdown
      },
      {
        id: 'quiz',
        title: 'Quiz Accuracy',
        icon: 'Q',
        value: summary.averageQuizAccuracy,
        suffix: '%',
        label:
          summary.attemptedQuizzes > 0
            ? `Based on ${summary.attemptedQuizzes} completed quiz attempts`
            : 'No completed quiz attempts yet',
        accent: '#4aa8ff',
        trend: quizTrend,
        breakdown: topicAccuracyBreakdown
      },
      {
        id: 'attempts',
        title: 'Quizzes Attempted',
        icon: 'T',
        value: summary.attemptedQuizzes,
        max: Math.max(summary.totalQuizzes, 1),
        label:
          summary.totalQuizzes > 0
            ? `${summary.attemptedQuizzes} of ${summary.totalQuizzes} quizzes taken`
            : 'Start a practice topic to track attempts',
        accent: '#f4ba5d',
        trend: attemptTrend,
        breakdown: topicAttemptBreakdown
      },
      {
        id: 'overall',
        title: 'Overall Progress',
        icon: 'O',
        value: summary.overallProgress,
        decimals: 1,
        suffix: '%',
        label:
          summary.totalQuizzes > 0
            ? `${summary.passedQuizzes} quizzes passed at 75% or higher`
            : 'Your combined progress will appear here',
        accent: '#0b9a7a',
        trend: [
          summary.averagePracticeCompletion,
          summary.attemptRate,
          summary.passRate,
          summary.overallProgress
        ],
        breakdown: [
          { label: 'Prepared', value: summary.averagePracticeCompletion },
          { label: 'Attempted', value: summary.attemptRate },
          { label: 'Passed', value: summary.passRate }
        ]
      }
    ];
  }, [analytics, summary, topicAttemptBreakdown, topicAccuracyBreakdown, topicCompletionBreakdown]);

  useEffect(() => {
    if (!selectedStat) {
      return;
    }

    const nextSelectedStat = statCards.find((stat) => stat.id === selectedStat.id) ?? null;
    setSelectedStat(nextSelectedStat);
  }, [selectedStat?.id, statCards]);

  useEffect(() => {
    if (!modalStat) {
      return;
    }

    const nextModalStat = statCards.find((stat) => stat.id === modalStat.id) ?? null;
    setModalStat(nextModalStat);
  }, [modalStat?.id, statCards]);

  const headerBadge = useMemo(() => {
    if (!summary.totalQuizzes) {
      return 'Create your first practice topic';
    }

    if (summary.passedQuizzes > 0) {
      return `${summary.passedQuizzes} quizzes passed`;
    }

    if (summary.attemptedQuizzes > 0) {
      return `${summary.attemptedQuizzes} quiz attempts recorded`;
    }

    if (summary.readyQuizzes > 0) {
      return `${summary.readyQuizzes} quizzes ready to take`;
    }

    return `${practiceTopics.length} topics in progress`;
  }, [practiceTopics.length, summary.attemptedQuizzes, summary.passedQuizzes, summary.readyQuizzes, summary.totalQuizzes]);

  const activityItems = useMemo<ActivityItem[]>(() => {
    if (!summary.totalQuizzes) {
      return [
        {
          title: 'No quiz progress yet. Create your first practice topic to start tracking.',
          time: 'Waiting for your first workspace update',
          tag: 'Start'
        }
      ];
    }

    const syncLabel = formatSyncLabel(workspace?.updated_at);
    const bestAttempt = analytics
      .filter((quiz) => quiz.attempts > 0)
      .sort((left, right) => right.quizAccuracy - left.quizAccuracy)[0];
    const nextFocus = [...analytics].sort(
      (left, right) => left.practiceCompletion - right.practiceCompletion
    )[0];

    return [
      {
        title: `${practiceTopics.length} topic${practiceTopics.length === 1 ? '' : 's'} in your practice workspace`,
        time: syncLabel,
        tag: 'Topics'
      },
      {
        title: `${summary.readyQuizzes} quiz${summary.readyQuizzes === 1 ? '' : 'zes'} fully prepared with questions and answers`,
        time: `${summary.averagePracticeCompletion}% average readiness`,
        tag: 'Practice'
      },
      {
        title: `${summary.attemptedQuizzes} of ${summary.totalQuizzes} quizzes attempted`,
        time: `${summary.averageQuizAccuracy}% average quiz accuracy`,
        tag: 'Quiz'
      },
      {
        title: bestAttempt
          ? `Best result so far: ${bestAttempt.label} scored ${bestAttempt.scoreLabel}`
          : 'No quiz attempt has been completed yet',
        time: bestAttempt
          ? `${bestAttempt.quizAccuracy}% accuracy`
          : 'Take a quiz to populate this card',
        tag: 'Result'
      },
      {
        title: nextFocus
          ? `Next focus: ${nextFocus.label}`
          : 'Your next focus will appear here',
        time: nextFocus
          ? `${nextFocus.practiceCompletion}% practice readiness`
          : 'Build more questions to unlock this insight',
        tag: 'Focus'
      }
    ];
  }, [analytics, practiceTopics.length, summary.attemptedQuizzes, summary.averagePracticeCompletion, summary.averageQuizAccuracy, summary.readyQuizzes, summary.totalQuizzes, workspace?.updated_at]);

  return (
    <div className="dashboard-page">
      <Header badgeText={headerBadge} />

      <section className="stats-section">
        {isLoading ? (
          <Loader label="Loading your dashboard progress..." />
        ) : (
          <>
            <div className="stats-grid">
              {statCards.map((stat) => (
                <StatCard key={stat.id} onSelect={setSelectedStat} stat={stat} />
              ))}
            </div>

            <DetailPanel
              onClose={() => setSelectedStat(null)}
              onViewReport={(stat) => setModalStat(stat)}
              stat={selectedStat}
            />
          </>
        )}
      </section>

      <section className="dashboard-lower">
        <ActivityFeed items={activityItems} />
        <QuickStart
          onFlashcards={() => setShowFlashcardsModal(true)}
          onNavigate={onQuickNavigate}
        />
      </section>

      <Modal
        onClose={() => setModalStat(null)}
        open={Boolean(modalStat)}
        title={modalStat ? `${modalStat.title} Report` : 'Report'}
      >
        {modalStat && (
          <div className="modal-report">
            <p>
              <strong>{modalStat.title}</strong> is currently tracking at{' '}
              {modalStat.value}
              {modalStat.suffix ?? ''}
              {modalStat.max ? ` / ${modalStat.max}` : ''}.
            </p>
            <p>{getReportIntro(modalStat)}</p>
            <ul className="modal-list">
              {modalStat.breakdown.map((item) => (
                <li key={item.label}>
                  {item.label}: {item.value}%
                </li>
              ))}
            </ul>
          </div>
        )}
      </Modal>

      <Modal
        onClose={() => setShowFlashcardsModal(false)}
        open={showFlashcardsModal}
        title={flashcardsReport.title}
      >
        <p>{flashcardsReport.message}</p>
      </Modal>
    </div>
  );
}

export default Dashboard;

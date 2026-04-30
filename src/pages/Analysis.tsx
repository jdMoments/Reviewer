import { useEffect, useMemo, useState } from 'react';
import Loader from '../components/Loader';
import { useAuth } from '../context/AuthContext';
import {
  getPracticeWorkspace,
  normalizePracticeTopics,
  type PracticeQuizRecord,
  type PracticeWorkspace
} from '../lib/supabase';

type QuizAnalytics = {
  id: number;
  attempts: number;
  key: string;
  label: string;
  passed: boolean;
  practiceCompletion: number;
  preparedQuestions: number;
  quizAccuracy: number;
  scoreLabel: string;
  totalQuestions: number;
};

function isPlaceholderQuestion(prompt: string) {
  return /^Question\s+\d+$/i.test(prompt.trim());
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function buildQuizAnalytics(quiz: PracticeQuizRecord, topic: string, topicId: number): QuizAnalytics {
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
    id: quiz.id,
    attempts: quiz.attempts,
    key: `${topicId}-${quiz.id}`,
    label: `${topic} ${quiz.id}`,
    passed: quiz.attempts > 0 && quiz.lastAccuracy >= 75,
    practiceCompletion,
    preparedQuestions,
    quizAccuracy,
    scoreLabel:
      quiz.attempts > 0
        ? `${quiz.lastScore}/${quiz.questions.length || totalQuestions}`
        : 'Not attempted',
    totalQuestions
  };
}

function getTrendPoints(values: number[], width: number, height: number, padding: number) {
  if (!values.length) {
    return '';
  }

  if (values.length === 1) {
    const x = width / 2;
    const y = height - padding - ((values[0] / 100) * (height - padding * 2));
    return `${x},${y}`;
  }

  return values
    .map((value, index) => {
      const x = padding + (index / (values.length - 1)) * (width - padding * 2);
      const y = height - padding - ((value / 100) * (height - padding * 2));
      return `${x},${y}`;
    })
    .join(' ');
}

function Analysis() {
  const { isAuthenticated, user } = useAuth();
  const [workspace, setWorkspace] = useState<PracticeWorkspace | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState('Loading analysis data...');

  useEffect(() => {
    if (!isAuthenticated || !user.id) {
      return;
    }

    let cancelled = false;

    async function loadAnalysis() {
      setIsLoading(true);
      setStatus('Loading Practice and Quiz insights from Supabase...');

      try {
        const nextWorkspace = await getPracticeWorkspace(user.id);

        if (cancelled) {
          return;
        }

        setWorkspace(nextWorkspace);
        setStatus(
          nextWorkspace
            ? 'Practice and Quiz analytics are ready.'
            : 'No Practice workspace found yet. Build quizzes first to unlock analysis.'
        );
      } catch {
        if (!cancelled) {
          setStatus('Could not load analysis data from Supabase.');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadAnalysis();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, user.id]);

  const practiceTopics = useMemo(() => normalizePracticeTopics(workspace), [workspace]);
  const analytics = useMemo(() => {
    if (!workspace) {
      return [];
    }

    return practiceTopics.flatMap((topic) =>
      topic.quizzes.map((quiz) => buildQuizAnalytics(quiz, topic.title, topic.id))
    );
  }, [practiceTopics, workspace]);

  const summary = useMemo(() => {
    if (!analytics.length) {
      return {
        attemptedQuizzes: 0,
        averagePracticeCompletion: 0,
        averageQuizAccuracy: 0,
        completionGap: 0,
        notReadyQuizzes: 0,
        passedQuizzes: 0,
        readyQuizzes: 0
      };
    }

    const attemptedQuizzes = analytics.filter((quiz) => quiz.attempts > 0).length;
    const readyQuizzes = analytics.filter((quiz) => quiz.practiceCompletion === 100).length;
    const passedQuizzes = analytics.filter((quiz) => quiz.passed).length;
    const averagePracticeCompletion = clampPercent(
      analytics.reduce((sum, quiz) => sum + quiz.practiceCompletion, 0) / analytics.length
    );
    const quizAccuracySource = analytics.filter((quiz) => quiz.attempts > 0);
    const averageQuizAccuracy = quizAccuracySource.length
      ? clampPercent(
          quizAccuracySource.reduce((sum, quiz) => sum + quiz.quizAccuracy, 0) /
            quizAccuracySource.length
        )
      : 0;

    return {
      attemptedQuizzes,
      averagePracticeCompletion,
      averageQuizAccuracy,
      completionGap: averagePracticeCompletion - averageQuizAccuracy,
      notReadyQuizzes: analytics.length - readyQuizzes,
      passedQuizzes,
      readyQuizzes
    };
  }, [analytics]);

  const practiceTrendPoints = useMemo(
    () => getTrendPoints(analytics.map((quiz) => quiz.practiceCompletion), 560, 240, 28),
    [analytics]
  );
  const quizTrendPoints = useMemo(
    () => getTrendPoints(analytics.map((quiz) => quiz.quizAccuracy), 560, 240, 28),
    [analytics]
  );

  const pieSegments = useMemo(() => {
    const values = [
      { color: '#0b9a7a', label: 'Passed quizzes', value: summary.passedQuizzes },
      {
        color: '#f4ba5d',
        label: 'Ready but not passed',
        value: Math.max(summary.readyQuizzes - summary.passedQuizzes, 0)
      },
      { color: '#d66a6a', label: 'Still building', value: summary.notReadyQuizzes }
    ];
    const total = values.reduce((sum, item) => sum + item.value, 0) || 1;
    let currentAngle = -90;

    return values.map((segment) => {
      const startAngle = currentAngle;
      const sweep = (segment.value / total) * 360;
      currentAngle += sweep;

      return {
        ...segment,
        endAngle: currentAngle,
        startAngle
      };
    });
  }, [summary.notReadyQuizzes, summary.passedQuizzes, summary.readyQuizzes]);

  const networkNodes = useMemo(() => {
    const centerX = 210;
    const centerY = 190;
    const radius = 132;

    return analytics.map((quiz, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(analytics.length, 1) - Math.PI / 2;
      return {
        ...quiz,
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius
      };
    });
  }, [analytics]);

  function polarToCartesian(centerX: number, centerY: number, radius: number, angleInDegrees: number) {
    const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0;
    return {
      x: centerX + radius * Math.cos(angleInRadians),
      y: centerY + radius * Math.sin(angleInRadians)
    };
  }

  function describeArc(centerX: number, centerY: number, radius: number, startAngle: number, endAngle: number) {
    const start = polarToCartesian(centerX, centerY, radius, endAngle);
    const end = polarToCartesian(centerX, centerY, radius, startAngle);
    const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';

    return [`M`, start.x, start.y, `A`, radius, radius, 0, largeArcFlag, 0, end.x, end.y].join(' ');
  }

  return (
    <section className="analysis-shell page-enter glass-panel">
      <div className="analysis-intro">
        <span className="eyebrow">Analysis</span>
        <h1>Analysis</h1>
        <p>Track how Practices preparation compares with Quiz performance across every quiz you build.</p>
        <div className="analysis-sync-note">{status}</div>
      </div>

      {isLoading ? (
        <div className="analysis-loader-shell">
          <Loader label="Charts and learning signals are syncing in." />
        </div>
      ) : !workspace || !analytics.length ? (
        <div className="analysis-empty-state">
          <strong>No analysis data yet</strong>
          <p>Create quizzes in Practices and complete quiz attempts to unlock these charts.</p>
        </div>
      ) : (
        <>
          <div className="analysis-stat-grid">
            <article className="analysis-stat-card">
              <div className="practice-summary-label">Practice Readiness</div>
              <strong>{summary.averagePracticeCompletion}%</strong>
              <p>Average completion of questions and answers in Practices.</p>
            </article>
            <article className="analysis-stat-card">
              <div className="practice-summary-label">Quiz Accuracy</div>
              <strong>{summary.averageQuizAccuracy}%</strong>
              <p>Average accuracy from quizzes attempted in the Quizzes page.</p>
            </article>
            <article className="analysis-stat-card">
              <div className="practice-summary-label">Ready Vs Passed</div>
              <strong>
                {summary.readyQuizzes} / {summary.passedQuizzes}
              </strong>
              <p>Ready quizzes compared with quizzes that reached the passing score.</p>
            </article>
            <article className="analysis-stat-card">
              <div className="practice-summary-label">Quiz Vs Practice Gap</div>
              <strong>{summary.completionGap}%</strong>
              <p>Positive values mean preparation is ahead of quiz performance.</p>
            </article>
          </div>

          <div className="analysis-diff-panel">
            <div>
              <div className="practice-summary-label">Quiz Vs Practice Differentiation</div>
              <strong>Readiness compared with performance</strong>
              <p>These views separate preparation quality in Practices from actual outcomes in Quizzes.</p>
            </div>

            <div className="analysis-diff-list">
              {analytics.map((quiz) => (
                <div className="analysis-diff-row" key={quiz.key}>
                  <div className="analysis-diff-copy">
                    <span>{quiz.label}</span>
                    <small>
                      Practice {quiz.practiceCompletion}% vs Quiz {quiz.quizAccuracy}%
                    </small>
                  </div>
                  <div className="analysis-diff-bars">
                    <div className="analysis-diff-bar practice">
                      <span style={{ width: `${quiz.practiceCompletion}%` }} />
                    </div>
                    <div className="analysis-diff-bar quiz">
                      <span style={{ width: `${quiz.quizAccuracy}%` }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="analysis-chart-grid">
            <article className="analysis-chart-card">
              <div className="analysis-chart-head">
                <div>
                  <div className="practice-summary-label">Bar Graph</div>
                  <strong>Practice Completion Vs Quiz Accuracy</strong>
                </div>
              </div>
              <div className="bar-chart">
                {analytics.map((quiz) => (
                  <div className="analysis-bar-group" key={`bar-${quiz.key}`}>
                    <div className="bar-label-row">
                      <span>{quiz.label}</span>
                      <strong>{quiz.scoreLabel}</strong>
                    </div>
                    <div className="analysis-bar-stack">
                      <div className="bar-track">
                        <div className="bar-fill analysis-practice-fill" style={{ width: `${quiz.practiceCompletion}%` }} />
                      </div>
                      <div className="bar-track">
                        <div className="bar-fill analysis-quiz-fill" style={{ width: `${quiz.quizAccuracy}%` }} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </article>

            <article className="analysis-chart-card">
              <div className="analysis-chart-head">
                <div>
                  <div className="practice-summary-label">Line Graph</div>
                  <strong>Readiness And Accuracy Trend</strong>
                </div>
              </div>
              <svg className="analysis-line-chart" viewBox="0 0 560 240" role="img">
                <path className="analysis-line-grid" d="M28 28 H532 M28 120 H532 M28 212 H532" />
                <polyline className="analysis-line practice" points={practiceTrendPoints} />
                <polyline className="analysis-line quiz" points={quizTrendPoints} />
                {analytics.map((quiz, index) => {
                  const practicePoint = getTrendPoints([quiz.practiceCompletion], 560, 240, 28);
                  const quizPoint = getTrendPoints([quiz.quizAccuracy], 560, 240, 28);
                  const x =
                    analytics.length === 1
                      ? 280
                      : 28 + (index / (analytics.length - 1)) * (560 - 56);
                  const practiceY = 240 - 28 - ((quiz.practiceCompletion / 100) * (240 - 56));
                  const quizY = 240 - 28 - ((quiz.quizAccuracy / 100) * (240 - 56));

                  return (
                    <g key={`line-point-${quiz.key}`}>
                      <circle className="analysis-line-point practice" cx={x} cy={practiceY} r="5" />
                      <circle className="analysis-line-point quiz" cx={x} cy={quizY} r="5" />
                    </g>
                  );
                })}
              </svg>
              <div className="analysis-line-legend">
                <span className="practice">Practice completion</span>
                <span className="quiz">Quiz accuracy</span>
              </div>
            </article>

            <article className="analysis-chart-card">
              <div className="analysis-chart-head">
                <div>
                  <div className="practice-summary-label">Pie Chart</div>
                  <strong>Finished Quiz Distribution</strong>
                </div>
              </div>
              <div className="analysis-pie-shell">
                <svg className="analysis-pie-chart" viewBox="0 0 260 260" role="img">
                  <circle className="analysis-pie-base" cx="130" cy="130" r="72" />
                  {pieSegments.map((segment) =>
                    segment.value > 0 ? (
                      <path
                        className="analysis-pie-slice"
                        d={describeArc(130, 130, 72, segment.startAngle, segment.endAngle)}
                        key={segment.label}
                        stroke={segment.color}
                      />
                    ) : null
                  )}
                </svg>
                <div className="analysis-pie-legend">
                  {pieSegments.map((segment) => (
                    <div className="analysis-pie-legend-row" key={segment.label}>
                      <span className="analysis-pie-dot" style={{ background: segment.color }} />
                      <strong>{segment.value}</strong>
                      <small>{segment.label}</small>
                    </div>
                  ))}
                </div>
              </div>
            </article>

            <article className="analysis-chart-card">
              <div className="analysis-chart-head">
                <div>
                  <div className="practice-summary-label">Scatter Plot</div>
                  <strong>Preparation Against Performance</strong>
                </div>
              </div>
              <svg className="analysis-scatter-chart" viewBox="0 0 360 260" role="img">
                <path className="analysis-line-grid" d="M48 24 V220 H320 M48 122 H320 M184 24 V220" />
                {analytics.map((quiz) => {
                  const x = 48 + (quiz.practiceCompletion / 100) * 272;
                  const y = 220 - (quiz.quizAccuracy / 100) * 196;
                  return (
                    <g key={`scatter-${quiz.key}`}>
                      <circle
                        className={`analysis-scatter-dot ${quiz.passed ? 'pass' : 'fail'}`}
                        cx={x}
                        cy={y}
                        r="8"
                      />
                      <text className="analysis-scatter-label" x={x + 10} y={y - 10}>
                        Q{quiz.id}
                      </text>
                    </g>
                  );
                })}
              </svg>
              <div className="analysis-axis-copy">
                <span>X: Practice completion</span>
                <span>Y: Quiz accuracy</span>
              </div>
            </article>

            <article className="analysis-chart-card">
              <div className="analysis-chart-head">
                <div>
                  <div className="practice-summary-label">Network Graph</div>
                  <strong>Topic To Quiz Relationship Map</strong>
                </div>
              </div>
              <svg className="analysis-network-chart" viewBox="0 0 420 380" role="img">
                {networkNodes.map((node) => (
                  <line
                    className="analysis-network-edge"
                    key={`edge-${node.key}`}
                    x1="210"
                    x2={node.x}
                    y1="190"
                    y2={node.y}
                  />
                ))}
                <circle className="analysis-network-center" cx="210" cy="190" r="58" />
                <text className="analysis-network-center-label" x="210" y="186">
                  {practiceTopics.length > 1 ? 'Practice Topics' : practiceTopics[0]?.title ?? workspace.title}
                </text>
                <text className="analysis-network-center-sub" x="210" y="208">
                  {practiceTopics.length} topic{practiceTopics.length === 1 ? '' : 's'} linked
                </text>
                {networkNodes.map((node) => (
                  <g key={`node-${node.key}`}>
                    <circle
                      className={`analysis-network-node ${node.passed ? 'pass' : 'default'}`}
                      cx={node.x}
                      cy={node.y}
                      r="30"
                    />
                    <text className="analysis-network-node-label" x={node.x} y={node.y - 2}>
                      Q{node.id}
                    </text>
                    <text className="analysis-network-node-sub" x={node.x} y={node.y + 14}>
                      {node.quizAccuracy}%
                    </text>
                  </g>
                ))}
              </svg>
            </article>
          </div>
        </>
      )}
    </section>
  );
}

export default Analysis;

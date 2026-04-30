import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import Modal from '../components/Modal';
import { useAuth } from '../context/AuthContext';
import {
  flattenPracticeTopics,
  getPracticeWorkspace,
  normalizePracticeTopics,
  upsertPracticeWorkspace,
  type PracticeQuestionRecord,
  type PracticeQuizRecord,
  type PracticeTopicRecord,
  type PracticeWorkspace
} from '../lib/supabase';

const QUIZ_PAGE_SIZE = 5;
const PASSING_ACCURACY = 75;

type ParsedChoice = {
  label: string;
  text: string;
};

type SessionQuestion = PracticeQuestionRecord & {
  globalIndex: number;
  quizId: number;
  quizLabel: string;
  sessionKey: string;
};

type QuizResultRecord = {
  accuracy: number;
  attempt: number;
  passed: boolean;
  questions: SessionQuestion[];
  quizId: number;
  quizLabel: string;
  responses: Record<string, string>;
  score: number;
  total: number;
};

function isPlaceholderQuestion(prompt: string) {
  return /^Question\s+\d+$/i.test(prompt.trim());
}

function isQuizReady(quiz: PracticeQuizRecord) {
  return (
    quiz.questions.length > 0 &&
    quiz.questions.every(
      (question) =>
        question.prompt.trim().length > 0 &&
        !isPlaceholderQuestion(question.prompt) &&
        question.answer.trim().length > 0
    )
  );
}

function parsePromptChoices(prompt: string, answer: string) {
  const lines = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const choices: ParsedChoice[] = [];
  const stemLines: string[] = [];

  lines.forEach((line, index) => {
    const normalizedLine = index === 0 ? line.replace(/^\d+\.\s*/, '') : line;
    const choiceMatch = normalizedLine.match(/^([A-Z])\.\s*(.+)$/);

    if (choiceMatch) {
      choices.push({
        label: choiceMatch[1],
        text: choiceMatch[2]
      });
      return;
    }

    stemLines.push(normalizedLine);
  });

  if (!choices.length && answer.trim()) {
    choices.push({
      label: 'Answer',
      text: answer.trim()
    });
  }

  return {
    stem: stemLines.join('\n').trim() || prompt.trim(),
    choices
  };
}

function getCorrectChoiceLabel(answer: string, choices: ParsedChoice[]) {
  const normalizedAnswer = answer.trim().toLowerCase();

  if (!normalizedAnswer) {
    return '';
  }

  const labelMatch = normalizedAnswer.match(/^([a-z])(?:\.|\)|\s|$)/);
  if (labelMatch) {
    return labelMatch[1].toUpperCase();
  }

  const exactChoice = choices.find(
    (choice) => choice.text.trim().toLowerCase() === normalizedAnswer
  );

  return exactChoice?.label ?? answer.trim();
}

function buildSessionQuestions(quizzes: PracticeQuizRecord[], topic: PracticeTopicRecord) {
  let questionNumber = 1;

  return quizzes.flatMap((quiz) =>
    quiz.questions.map((question, index) => {
      const nextQuestion = {
        ...question,
        globalIndex: questionNumber,
        quizId: quiz.id,
        quizLabel: `${topic.title} ${quiz.id}`,
        sessionKey: `${topic.id}-${quiz.id}-${index + 1}`
      };

      questionNumber += 1;
      return nextQuestion;
    })
  );
}

function buildPerformanceAnalysis(accuracy: number, score: number, total: number) {
  if (accuracy >= 90) {
    return `Excellent recall. You answered ${score} out of ${total} correctly with strong mastery.`;
  }

  if (accuracy >= PASSING_ACCURACY) {
    return `Strong performance. You answered ${score} out of ${total} correctly and passed this quiz.`;
  }

  return `More review is needed. You answered ${score} out of ${total} correctly and did not reach the passing score yet.`;
}

function Quizzes() {
  const { isAuthenticated, user } = useAuth();
  const [workspace, setWorkspace] = useState<PracticeWorkspace | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState('Select a Practice topic to begin building a quiz set.');
  const [selectedTopicId, setSelectedTopicId] = useState('');
  const [selectedQuizCount, setSelectedQuizCount] = useState('1');
  const [selectedQuizIds, setSelectedQuizIds] = useState<number[]>([]);
  const [submittedQuizIds, setSubmittedQuizIds] = useState<number[]>([]);
  const [isQuizStarted, setIsQuizStarted] = useState(false);
  const [activeQuizIds, setActiveQuizIds] = useState<number[]>([]);
  const [currentQuestionPage, setCurrentQuestionPage] = useState(0);
  const [quizResponses, setQuizResponses] = useState<Record<string, string>>({});
  const [quizResults, setQuizResults] = useState<QuizResultRecord[]>([]);
  const [activeResultQuizId, setActiveResultQuizId] = useState<number | null>(null);
  const [showResultModal, setShowResultModal] = useState(false);
  const [showResultReview, setShowResultReview] = useState(false);

  useEffect(() => {
    if (!isAuthenticated || !user.id) {
      return;
    }

    let cancelled = false;

    async function loadPracticeTopics() {
      setIsLoading(true);
      setStatus('Loading Practice topic from Supabase...');

      try {
        const nextWorkspace = await getPracticeWorkspace(user.id);

        if (cancelled) {
          return;
        }

        setWorkspace(nextWorkspace);

        if (nextWorkspace) {
          const practiceTopics = normalizePracticeTopics(nextWorkspace);
          const defaultTopic =
            practiceTopics.find((topic) => topic.quizzes.some(isQuizReady)) ??
            practiceTopics[0] ??
            null;
          const readyQuizzes = defaultTopic?.quizzes.filter(isQuizReady) ?? [];

          setSelectedTopicId(defaultTopic ? String(defaultTopic.id) : '');
          setSelectedQuizCount(String(Math.max(1, Math.min(readyQuizzes.length || 1, 1))));
          setQuizResults([]);
          setStatus(
            readyQuizzes.length
              ? 'Choose a finished quiz, then submit your selection.'
              : 'No finished quizzes with answered questionnaires are available yet.'
          );
        } else {
          setStatus('No Practice topic found yet. Create quizzes in Practices first.');
        }
      } catch {
        if (!cancelled) {
          setStatus('Could not load Practice topic from Supabase.');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadPracticeTopics();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, user.id]);

  const practiceTopics = useMemo(() => normalizePracticeTopics(workspace), [workspace]);
  const selectedTopicRecord = useMemo(
    () =>
      practiceTopics.find((topic) => String(topic.id) === selectedTopicId) ??
      practiceTopics[0] ??
      null,
    [practiceTopics, selectedTopicId]
  );
  const selectedTopic = selectedTopicRecord?.title ?? '';
  const availableQuizzes = useMemo(
    () => selectedTopicRecord?.quizzes.filter(isQuizReady) ?? [],
    [selectedTopicRecord]
  );
  const targetCount = Number(selectedQuizCount);
  const selectedQuizMap = useMemo(
    () => new Map(availableQuizzes.map((quiz) => [quiz.id, quiz])),
    [availableQuizzes]
  );
  const activeSessionQuizzes = useMemo(
    () =>
      activeQuizIds
        .map((quizId) => selectedQuizMap.get(quizId) ?? null)
        .filter((quiz): quiz is PracticeQuizRecord => quiz !== null),
    [activeQuizIds, selectedQuizMap]
  );
  const sessionQuestions = useMemo(
    () => (selectedTopicRecord ? buildSessionQuestions(activeSessionQuizzes, selectedTopicRecord) : []),
    [activeSessionQuizzes, selectedTopicRecord]
  );
  const questionPageCount = Math.max(1, Math.ceil(sessionQuestions.length / QUIZ_PAGE_SIZE));
  const visibleQuestions = sessionQuestions.slice(
    currentQuestionPage * QUIZ_PAGE_SIZE,
    currentQuestionPage * QUIZ_PAGE_SIZE + QUIZ_PAGE_SIZE
  );
  const resultCards = useMemo(
    () => quizResults.slice().sort((left, right) => left.quizId - right.quizId),
    [quizResults]
  );
  const activeResult = useMemo(
    () => quizResults.find((result) => result.quizId === activeResultQuizId) ?? null,
    [activeResultQuizId, quizResults]
  );

  function toggleQuizSelection(quizId: number) {
    setSelectedQuizIds((current) => {
      const isSelected = current.includes(quizId);

      if (isSelected) {
        return current.filter((id) => id !== quizId);
      }

      if (current.length >= targetCount) {
        return [...current.slice(1), quizId];
      }

      return [...current, quizId];
    });
    setSubmittedQuizIds([]);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedQuizIds.length) {
      setStatus('Choose at least one finished quiz from the selected Practice topic.');
      return;
    }

    setSubmittedQuizIds([...selectedQuizIds]);
    setStatus('Quiz selection saved. Click Start Quiz to begin.');
  }

  function startQuiz(quizIds: number[]) {
    const nextQuizzes = quizIds
      .map((quizId) => selectedQuizMap.get(quizId) ?? null)
      .filter((quiz): quiz is PracticeQuizRecord => quiz !== null);

    if (!nextQuizzes.length) {
      setStatus('Choose at least one finished quiz from the selected Practice topic.');
      return;
    }

    setActiveQuizIds(quizIds);
    setQuizResponses({});
    setCurrentQuestionPage(0);
    setIsQuizStarted(true);
    setShowResultModal(false);
    setShowResultReview(false);
    setStatus('Quiz started. Answer the questions below, then submit on the last page.');
  }

  function handleStartQuiz() {
    startQuiz(submittedQuizIds);
  }

  function handleChoiceResponse(sessionKey: string, value: string) {
    setQuizResponses((current) => ({
      ...current,
      [sessionKey]: value
    }));
  }

  function handleNextQuestionPage() {
    setCurrentQuestionPage((current) => Math.min(current + 1, questionPageCount - 1));
  }

  function handlePreviousQuestionPage() {
    setCurrentQuestionPage((current) => Math.max(current - 1, 0));
  }

  function handleSubmitQuiz() {
    const nextResults = activeSessionQuizzes.map((quiz) => {
      const questions = sessionQuestions.filter((question) => question.quizId === quiz.id);
      const score = questions.reduce((currentScore, question) => {
        const parsedQuestion = parsePromptChoices(question.prompt, question.answer);
        const submittedAnswer = quizResponses[question.sessionKey] ?? '';

        if (parsedQuestion.choices.length) {
          const correctChoiceLabel = getCorrectChoiceLabel(question.answer, parsedQuestion.choices);
          return submittedAnswer === correctChoiceLabel ? currentScore + 1 : currentScore;
        }

        return submittedAnswer.trim().toLowerCase() === question.answer.trim().toLowerCase()
          ? currentScore + 1
          : currentScore;
      }, 0);
      const total = questions.length;
      const accuracy = total ? Math.round((score / total) * 100) : 0;
      const previousAttempt =
        selectedTopicRecord?.quizzes.find((entry) => entry.id === quiz.id)?.attempts ??
        quizResults.find((result) => result.quizId === quiz.id)?.attempt ??
        0;

      return {
        accuracy,
        attempt: previousAttempt + 1,
        passed: accuracy >= PASSING_ACCURACY,
        questions,
        quizId: quiz.id,
        quizLabel: `${selectedTopic} ${quiz.id}`,
        responses: Object.fromEntries(
          questions.map((question) => [question.sessionKey, quizResponses[question.sessionKey] ?? ''])
        ),
        score,
        total
      };
    });

    if (workspace) {
      const nextPracticeTopics = normalizePracticeTopics(workspace).map((topic) => {
        if (topic.id !== selectedTopicRecord?.id) {
          return topic;
        }

        return {
          ...topic,
          quiz_count: topic.quizzes.length,
          quizzes: topic.quizzes.map((quiz) => {
            const matchingResult = nextResults.find((result) => result.quizId === quiz.id);

            if (!matchingResult) {
              return quiz;
            }

            return {
              ...quiz,
              attempts: matchingResult.attempt,
              lastAccuracy: matchingResult.accuracy,
              lastAnalysis: buildPerformanceAnalysis(
                matchingResult.accuracy,
                matchingResult.score,
                matchingResult.total
              ),
              lastResponses: Object.fromEntries(
                matchingResult.questions.map((question) => [
                  question.id,
                  matchingResult.responses[question.sessionKey] ?? ''
                ])
              ),
              lastScore: matchingResult.score
            };
          })
        };
      });
      const nextWorkspaceQuizzes = flattenPracticeTopics(nextPracticeTopics);
      const primaryTopic = nextPracticeTopics[0];

      const nextWorkspace = {
        ...workspace,
        title: primaryTopic?.title ?? workspace.title,
        quiz_count: primaryTopic?.quizzes.length ?? workspace.quiz_count,
        quizzes: nextWorkspaceQuizzes
      };

      setWorkspace(nextWorkspace);
      setQuizResults((current) => [
        ...current.filter((result) => !activeQuizIds.includes(result.quizId)),
        ...nextResults
      ]);

      if (user.id) {
        void upsertPracticeWorkspace({
          studentAccountId: user.id,
          title: nextWorkspace.title,
          quizCount: nextWorkspace.quiz_count,
          quizzes: nextWorkspaceQuizzes
        }).catch(() => {
          setStatus('Quiz submitted, but the result could not be synced to Supabase.');
        });
      }
    } else {
      setQuizResults((current) => [
        ...current.filter((result) => !activeQuizIds.includes(result.quizId)),
        ...nextResults
      ]);
    }

    setSubmittedQuizIds([...activeQuizIds]);
    setIsQuizStarted(false);
    setActiveQuizIds([]);
    setCurrentQuestionPage(0);
    setQuizResponses({});
    setStatus('Quiz submitted. Check the score cards below to review the results.');
  }

  function openResultModal(quizId: number) {
    setActiveResultQuizId(quizId);
    setShowResultReview(false);
    setShowResultModal(true);
  }

  function handleRetakeQuiz(quizId: number) {
    setShowResultModal(false);
    setShowResultReview(false);
    setSelectedQuizIds([quizId]);
    setSubmittedQuizIds([quizId]);
    startQuiz([quizId]);
  }

  return (
    <>
      <section className="quiz-builder-shell page-enter glass-panel">
        {!isQuizStarted ? (
          <>
            <div className="quiz-builder-intro">
              <span className="eyebrow">Quizzes</span>
              <h1>Quizzes</h1>
              <p>Pick a Practice topic, choose how many finished quizzes you want, then submit your selection.</p>
              <div className="quiz-sync-note">
                {isLoading ? 'Syncing Practice topics...' : status}
              </div>
            </div>

            <form className="quiz-selection-form" onSubmit={handleSubmit}>
              <div className="quiz-selection-top">
                <label className="practice-field">
                  <span>Topic from Practices</span>
                  <select
                    className="practice-select"
                    disabled={!practiceTopics.length}
                    onChange={(event) => {
                      setSelectedTopicId(event.target.value);
                      setSelectedQuizCount('1');
                      setSelectedQuizIds([]);
                      setSubmittedQuizIds([]);
                      setQuizResults([]);
                    }}
                    value={selectedTopicId}
                  >
                    {practiceTopics.length ? (
                      practiceTopics.map((topic) => (
                        <option key={topic.id} value={topic.id}>
                          {topic.title}
                        </option>
                      ))
                    ) : (
                      <option value="">No topic available</option>
                    )}
                  </select>
                </label>

                <label className="practice-field">
                  <span>How many quizzes do you choose?</span>
                  <select
                    className="practice-select"
                    disabled={!availableQuizzes.length}
                    onChange={(event) => {
                      const nextCount = event.target.value;
                      setSelectedQuizCount(nextCount);
                      setSelectedQuizIds((current) => current.slice(0, Number(nextCount)));
                      setSubmittedQuizIds([]);
                    }}
                    value={selectedQuizCount}
                  >
                    {Array.from({ length: Math.max(availableQuizzes.length, 1) }, (_, index) => {
                      const value = String(index + 1);
                      return (
                        <option key={value} value={value}>
                          {value} {index === 0 ? 'quiz' : 'quizzes'}
                        </option>
                      );
                    })}
                  </select>
                </label>
              </div>

              <div className="quiz-source-panel">
                <div className="practice-panel-head">
                  <div>
                    <div className="practice-summary-label">Available Answered Quizzes</div>
                    <strong>{selectedTopic || 'No topic selected yet'}</strong>
                  </div>
                  <span className="quiz-counter-pill">
                    {selectedQuizIds.length} / {targetCount} selected
                  </span>
                </div>

                <div className="quiz-choice-grid">
                  {availableQuizzes.length ? (
                    availableQuizzes.map((quiz) => (
                      <button
                        key={quiz.id}
                        className={`quiz-choice-card ${selectedQuizIds.includes(quiz.id) ? 'selected' : ''}`}
                        onClick={() => toggleQuizSelection(quiz.id)}
                        type="button"
                      >
                        <div className="quiz-choice-head">
                          <span className="practice-quiz-number">Quiz {quiz.id}</span>
                          <span className="practice-quiz-pill">{quiz.itemCount} items</span>
                        </div>
                        <h3>
                          {selectedTopic} {quiz.id}
                        </h3>
                        <p>
                          {quiz.questions.length} finished question{quiz.questions.length === 1 ? '' : 's'}
                        </p>
                      </button>
                    ))
                  ) : (
                    <div className="quiz-empty-state">
                      No finished quizzes with answered questionnaires are available yet.
                    </div>
                  )}
                </div>
              </div>

              <div className="quiz-submit-row">
                {submittedQuizIds.length ? (
                  <button className="practice-submit" onClick={handleStartQuiz} type="button">
                    Start Quiz
                  </button>
                ) : (
                  <button className="practice-submit" disabled={!availableQuizzes.length} type="submit">
                    Submit Quiz Selection
                  </button>
                )}
              </div>
            </form>

            <div className="quiz-selection-summary">
              <div className="practice-summary-label">Selected Quizzes</div>
              <strong>{selectedTopic || 'No topic selected'}</strong>
              <p>
                {submittedQuizIds.length
                  ? `Ready to start: ${submittedQuizIds.map((id) => `Quiz ${id}`).join(', ')}`
                  : 'No quiz selection submitted yet.'}
              </p>
            </div>

            {resultCards.length > 0 && (
              <div className="quiz-results-board">
                <div className="practice-panel-head">
                  <div>
                    <div className="practice-summary-label">Quiz Scores</div>
                    <strong>Finished Quizzes</strong>
                  </div>
                </div>

                <div className="quiz-results-card-grid">
                  {resultCards.map((result) => (
                    <button
                      key={result.quizId}
                      className={`quiz-score-card ${result.passed ? 'pass' : 'fail'}`}
                      onClick={() => openResultModal(result.quizId)}
                      type="button"
                    >
                      <span className="practice-quiz-number">{result.quizLabel}</span>
                      <strong>
                        {result.score} / {result.total}
                      </strong>
                      <p>{result.accuracy}% accuracy</p>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="quiz-session-shell">
            <div className="quiz-builder-intro">
              <span className="eyebrow">Quiz Session</span>
              <h1>Start Quiz</h1>
              <p>Answer the first five questions on this page, then click Next to continue.</p>
              <div className="quiz-sync-note">
                Page {currentQuestionPage + 1} of {questionPageCount}
              </div>
            </div>

            <div className="quiz-session-head">
              <div className="quiz-selection-summary">
                <div className="practice-summary-label">Selected Quizzes</div>
                <strong>{activeSessionQuizzes.map((quiz) => `Quiz ${quiz.id}`).join(', ')}</strong>
                <p>{sessionQuestions.length} total questions ready for this quiz.</p>
              </div>

              <div className="quiz-selection-summary">
                <div className="practice-summary-label">Question Range</div>
                <strong>
                  {visibleQuestions[0]?.globalIndex ?? 0}-{visibleQuestions[visibleQuestions.length - 1]?.globalIndex ?? 0}
                </strong>
                <p>Questions are shown in batches of five per page.</p>
              </div>
            </div>

            <div className="quiz-session-list">
              {visibleQuestions.map((question) => {
                const parsedQuestion = parsePromptChoices(question.prompt, question.answer);
                const responseValue = quizResponses[question.sessionKey] ?? '';

                return (
                  <article className="quiz-session-question" key={question.sessionKey}>
                    <div className="quiz-session-question-head">
                      <span className="practice-quiz-number">Q{question.globalIndex}</span>
                      <span className="practice-quiz-pill">{question.quizLabel}</span>
                    </div>

                    <div className="quiz-session-question-copy">
                      <h3>{parsedQuestion.stem}</h3>

                      {parsedQuestion.choices.length > 1 ? (
                        <div className="practice-choice-list">
                          {parsedQuestion.choices.map((choice) => (
                            <button
                              key={`${question.sessionKey}-${choice.label}`}
                              className={`practice-choice-card ${
                                responseValue === choice.label ? 'selected' : ''
                              }`}
                              onClick={() => handleChoiceResponse(question.sessionKey, choice.label)}
                              type="button"
                            >
                              <span className="practice-choice-label">{choice.label}</span>
                              <span>{choice.text}</span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <input
                          className="practice-answer-input"
                          onChange={(event) => handleChoiceResponse(question.sessionKey, event.target.value)}
                          placeholder="Type your answer"
                          type="text"
                          value={responseValue}
                        />
                      )}
                    </div>
                  </article>
                );
              })}
            </div>

            <div className="quiz-session-actions">
              {currentQuestionPage > 0 ? (
                <button className="practice-secondary-button" onClick={handlePreviousQuestionPage} type="button">
                  Back
                </button>
              ) : (
                <span />
              )}

              {currentQuestionPage === questionPageCount - 1 ? (
                <button className="practice-submit" onClick={handleSubmitQuiz} type="button">
                  Submit Quiz
                </button>
              ) : (
                <button className="practice-submit" onClick={handleNextQuestionPage} type="button">
                  Next
                </button>
              )}
            </div>
          </div>
        )}
      </section>

      <Modal
        open={showResultModal && activeResult !== null}
        title={activeResult ? `${activeResult.quizLabel} Result` : 'Quiz Result'}
        onClose={() => {
          setShowResultModal(false);
          setShowResultReview(false);
        }}
      >
        {activeResult && (
          <div className="practice-results-shell">
            <div
              className="practice-score-hero"
              style={
                {
                  '--score-sweep': `${Math.round((activeResult.accuracy / 100) * 360)}deg`
                } as CSSProperties
              }
            >
              <div className="practice-score-ring">
                <span>{activeResult.accuracy}%</span>
              </div>
              <div className="practice-score-copy">
                <h4>{activeResult.quizLabel}</h4>
                <p>
                  Score {activeResult.score} / {activeResult.total}
                </p>
              </div>
            </div>

            <div className="practice-results-grid">
              <article className="practice-result-card">
                <div className="practice-result-label">Score</div>
                <strong>
                  {activeResult.score} / {activeResult.total}
                </strong>
              </article>
              <article className="practice-result-card">
                <div className="practice-result-label">Accuracy</div>
                <strong>{activeResult.accuracy}%</strong>
              </article>
              <article className="practice-result-card">
                <div className="practice-result-label">Result</div>
                <strong>{activeResult.passed ? 'Pass' : 'Failed'}</strong>
              </article>
            </div>

            <button
              className="practice-show-result"
              onClick={() => setShowResultReview((current) => !current)}
              type="button"
            >
              {showResultReview ? 'Hide Review Result' : 'Review Result'}
            </button>

            {showResultReview && (
              <div className="practice-results-list">
                {activeResult.questions.map((question) => {
                  const parsedQuestion = parsePromptChoices(question.prompt, question.answer);
                  const responseValue = activeResult.responses[question.sessionKey] ?? '';
                  const correctChoiceLabel = getCorrectChoiceLabel(question.answer, parsedQuestion.choices);
                  const selectedChoice = parsedQuestion.choices.find(
                    (choice) => choice.label === responseValue
                  );
                  const correctChoice = parsedQuestion.choices.find(
                    (choice) => choice.label === correctChoiceLabel
                  );
                  const isCorrect = parsedQuestion.choices.length
                    ? responseValue === correctChoiceLabel
                    : responseValue.trim().toLowerCase() === question.answer.trim().toLowerCase();

                  return (
                    <article
                      className={`practice-review-card ${isCorrect ? 'correct' : 'wrong'}`}
                      key={question.sessionKey}
                    >
                      <div className="practice-review-head">
                        <strong className="practice-review-number">
                          {isCorrect ? `Q${question.globalIndex}` : `Q${question.globalIndex} X`}
                        </strong>
                      </div>
                      <h4>{parsedQuestion.stem}</h4>
                      <div className="practice-review-answer-row">
                        <span className="practice-review-label">Your answer</span>
                        <span className={`practice-review-answer ${isCorrect ? 'correct' : 'wrong'}`}>
                          {parsedQuestion.choices.length
                            ? selectedChoice
                              ? `${selectedChoice.label}. ${selectedChoice.text}`
                              : 'No answer selected'
                            : responseValue || 'No answer typed'}
                        </span>
                      </div>
                      {!isCorrect && (
                        <div className="practice-review-answer-row">
                          <span className="practice-review-label">Correct answer</span>
                          <span className="practice-review-correct-answer">
                            {parsedQuestion.choices.length
                              ? correctChoice
                                ? `${correctChoice.label}. ${correctChoice.text}`
                                : question.answer
                              : question.answer}
                          </span>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}

            <div className="practice-results-actions">
              <button
                className="practice-submit"
                onClick={() => handleRetakeQuiz(activeResult.quizId)}
                type="button"
              >
                Retake
              </button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

export default Quizzes;

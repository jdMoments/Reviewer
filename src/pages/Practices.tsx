import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type FormEvent
} from 'react';
import Modal from '../components/Modal';
import { useAuth } from '../context/AuthContext';
import { generateAnswersWithGemini } from '../lib/gemini';
import {
  flattenPracticeTopics,
  getPracticeWorkspace,
  normalizePracticeTopics,
  upsertPracticeWorkspace
} from '../lib/supabase';
import { extractTextFromQuestionFile } from '../utils/fileTextExtraction';

type QuestionEntry = {
  id: number;
  prompt: string;
  answer: string;
};

type QuizInstance = {
  id: number;
  itemCount: number;
  sourceText: string;
  questions: QuestionEntry[];
  attempts: number;
  lastScore: number;
  lastAccuracy: number;
  lastAnalysis: string;
  lastResponses: Record<number, string>;
};

type PracticeTopic = {
  id: number;
  title: string;
  quizzes: QuizInstance[];
};

type ParsedChoice = {
  label: string;
  text: string;
};

type QuizResultSummary = {
  accuracy: number;
  attempt: number;
  score: number;
  total: number;
  analysis: string;
};

type AnswerAssistMode = 'manual' | 'ai';
type AnswerAssistStep = 'select' | 'reminder';
type AnswerAssistTrigger = 'scan' | 'save';
type PendingScanSelection = {
  questions: QuestionEntry[];
  totalDetected: number;
};
type AppliedScanRange = {
  start: number;
  end: number;
  total: number;
};
type ScanMessageTone = 'info' | 'error';
type ScanRangeModalMode = 'initial' | 'edit';
type QuizEditorDraft = {
  itemCount: number;
  sourceText: string;
  questions: QuestionEntry[];
  editorMode: 'text' | 'file';
  loadedFileName: string;
  isSourceScanned: boolean;
  isScanManualLocked: boolean;
  appliedScanRange: AppliedScanRange | null;
  scanMessage: string;
  scanMessageTone: ScanMessageTone;
};

function createDefaultQuestions(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    prompt: `Question ${index + 1}`,
    answer: ''
  }));
}

function createQuizInstances(
  count: number,
  previous: Array<Partial<QuizInstance>> = []
) {
  return Array.from({ length: count }, (_, index) => {
    const previousQuiz = previous[index];
    const nextCount = previousQuiz?.itemCount ?? 10;

    return {
      id: index + 1,
      itemCount: nextCount,
      sourceText: previousQuiz?.sourceText ?? '',
      attempts: previousQuiz?.attempts ?? 0,
      lastScore: previousQuiz?.lastScore ?? 0,
      lastAccuracy: previousQuiz?.lastAccuracy ?? 0,
      lastAnalysis: previousQuiz?.lastAnalysis ?? '',
      lastResponses: previousQuiz?.lastResponses ?? {},
      questions: previousQuiz?.questions?.length
        ? previousQuiz.questions
        : createDefaultQuestions(nextCount)
    };
  });
}

function createPracticeTopic(
  topicId: number,
  title = 'Weekly Mastery Check',
  quizCount = 5,
  previous: Array<Partial<QuizInstance>> = []
) {
  return {
    id: topicId,
    title,
    quizzes: createQuizInstances(quizCount, previous)
  };
}

function normalizePracticeTopicState(topics: PracticeTopic[]) {
  return topics.map((topic, topicIndex) => {
    const nextTopicId = topicIndex + 1;
    const nextTitle = topic.title.trim() || `Practice Topic ${nextTopicId}`;
    const nextQuizzes =
      topic.quizzes.length > 0
        ? topic.quizzes.map((quiz, quizIndex) => ({
            ...quiz,
            id: quizIndex + 1,
            questions: quiz.questions.length
              ? quiz.questions.map((question, questionIndex) => ({
                  ...question,
                  id: questionIndex + 1
                }))
              : createDefaultQuestions(quiz.itemCount)
          }))
        : createQuizInstances(1);

    return {
      id: nextTopicId,
      title: nextTitle,
      quizzes: nextQuizzes
    };
  });
}

function normalizeQuestionBlocks(text: string) {
  const normalizedText = text
    .replace(/\r\n?/g, '\n')
    .replace(/\f/g, '\n')
    .replace(/([^\n])(?:\s{2,}|\t+)(\d+\.\s)/g, '$1\n$2');

  const numberedBlocks = Array.from(
    normalizedText.matchAll(/(?:^|\n)\s*(\d+)\.\s*([\s\S]*?)(?=\n\s*\d+\.\s|\s*$)/g)
  ).map((match) => `${match[1]}. ${match[2].trim()}`.trim());

  if (numberedBlocks.length) {
    return numberedBlocks;
  }

  return normalizedText
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
}

function createQuestionsFromSource(text: string) {
  const lines = text.split(/\r?\n/);
  const answersHeaderIndex = lines.findIndex((line) => /^answers\s*:?$/i.test(line.trim()));
  const answerMap = new Map<number, string>();
  const inlineAnswersMatch = text.match(/answers\s*:\s*([\s\S]*)$/i);

  let questionSourceText = text;

  if (answersHeaderIndex >= 0) {
    const answerLines = lines.slice(answersHeaderIndex + 1);

    answerLines.forEach((line) => {
      const match = line.trim().match(/^(\d+)\.\s*(.+)$/);

      if (match) {
        answerMap.set(Number(match[1]), match[2].trim());
      }
    });

    questionSourceText = lines.slice(0, answersHeaderIndex).join('\n').trim();
  } else if (inlineAnswersMatch) {
    const answerSection = inlineAnswersMatch[1];
    const answerMatches = Array.from(answerSection.matchAll(/(\d+)\.\s*([A-Za-z]+)/g));

    answerMatches.forEach((match) => {
      answerMap.set(Number(match[1]), match[2].trim());
    });

    questionSourceText = text.slice(0, inlineAnswersMatch.index).trim();
  }

  const questionBlocks = normalizeQuestionBlocks(questionSourceText);

  return {
    totalDetected: questionBlocks.length,
    questions: questionBlocks.map((block, index) => {
      const lines = block
        .split(/\r?\n/)
        .map((line) => line.trimEnd());
      const answerLineIndex = lines.findIndex((line) =>
        /^answer\s*[:=]\s*/i.test(line.trim())
      );

      let extractedAnswer = '';
      let promptLines = lines;

      if (answerLineIndex >= 0) {
        const answerLine = lines[answerLineIndex].trim();
        extractedAnswer = answerLine.replace(/^answer\s*[:=]\s*/i, '').trim();
        promptLines = lines.filter((_, currentIndex) => currentIndex !== answerLineIndex);
      }

      return {
        id: index + 1,
        prompt: promptLines.join('\n').trim(),
        answer: extractedAnswer || answerMap.get(index + 1) || ''
      };
    })
  };
}

function buildQuestionDrafts(
  count: number,
  scannedQuestions: QuestionEntry[] = [],
  previousQuestions: QuestionEntry[] = []
) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    prompt:
      scannedQuestions[index]?.prompt ??
      previousQuestions[index]?.prompt ??
      `Question ${index + 1}`,
    answer:
      scannedQuestions[index]?.answer ??
      previousQuestions[index]?.answer ??
      ''
  }));
}

function buildScannedQuestionDrafts(
  count: number,
  scannedQuestions: QuestionEntry[],
  previousQuestions: QuestionEntry[] = []
) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    prompt:
      scannedQuestions[index]?.prompt ??
      previousQuestions[index]?.prompt ??
      `Question ${index + 1}`,
    answer:
      scannedQuestions[index] !== undefined
        ? scannedQuestions[index].answer
        : previousQuestions[index]?.answer ?? ''
  }));
}

function isPlaceholderQuestion(prompt: string) {
  return /^Question\s+\d+$/i.test(prompt.trim());
}

function hasSavedQuizContent(quiz: QuizInstance) {
  return quiz.questions.some(
    (question) =>
      question.answer.trim().length > 0 || !isPlaceholderQuestion(question.prompt)
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

function buildPerformanceAnalysis(accuracy: number, score: number, total: number) {
  if (accuracy >= 90) {
    return `Excellent recall. You answered ${score} out of ${total} correctly, which shows strong mastery and consistent recognition of the right choices.`;
  }

  if (accuracy >= 75) {
    return `Strong performance overall. You got ${score} out of ${total} correct, and a short targeted review should push this quiz even closer to mastery.`;
  }

  if (accuracy >= 50) {
    return `Developing understanding. You answered ${score} out of ${total} correctly, so reviewing missed concepts and retaking the quiz will likely improve retention quickly.`;
  }

  return `This attempt shows the topic still needs reinforcement. You answered ${score} out of ${total} correctly, so a guided review before the next retake would be the best next step.`;
}

function getAccuracyToneClass(accuracy: number) {
  if (accuracy >= 91) {
    return 'practice-accuracy-top';
  }

  if (accuracy >= 81) {
    return 'practice-accuracy-high';
  }

  if (accuracy >= 75) {
    return 'practice-accuracy-mid';
  }

  return 'practice-accuracy-low';
}

function inferAnswerForQuestion(question: QuestionEntry) {
  const parsed = parsePromptChoices(question.prompt, question.answer);
  const mathMatch = parsed.stem.match(/(-?\d+(?:\.\d+)?)\s*([+\-x×*\/÷])\s*(-?\d+(?:\.\d+)?)/i);

  if (!mathMatch) {
    return '';
  }

  const left = Number(mathMatch[1]);
  const operator = mathMatch[2];
  const right = Number(mathMatch[3]);

  let result = 0;

  switch (operator) {
    case '+':
      result = left + right;
      break;
    case '-':
      result = left - right;
      break;
    case 'x':
    case 'X':
    case '×':
    case '*':
      result = left * right;
      break;
    case '/':
    case '÷':
      result = right === 0 ? Number.NaN : left / right;
      break;
    default:
      return '';
  }

  if (Number.isNaN(result)) {
    return '';
  }

  const normalizedResult = Number.isInteger(result) ? String(result) : String(Number(result.toFixed(2)));
  const matchingChoice = parsed.choices.find(
    (choice) => choice.text.replace(/,/g, '').trim() === normalizedResult
  );

  return matchingChoice?.label ?? normalizedResult;
}

function Practices() {
  const TOPICS_PER_PAGE = 5;
  const MAX_TOPIC_PAGE_INPUT = 5;
  const { isAuthenticated, user } = useAuth();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [showQuizModal, setShowQuizModal] = useState(false);
  const [topicModalMode, setTopicModalMode] = useState<'create' | 'edit'>('create');
  const [showQuestionCountModal, setShowQuestionCountModal] = useState(false);
  const [showItemsModal, setShowItemsModal] = useState(false);
  const [showPlayModal, setShowPlayModal] = useState(false);
  const [showQuizOverviewModal, setShowQuizOverviewModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showDeleteTopicModal, setShowDeleteTopicModal] = useState(false);
  const [showAnswerAssistModal, setShowAnswerAssistModal] = useState(false);
  const [showScanRangeModal, setShowScanRangeModal] = useState(false);
  const [practiceTopics, setPracticeTopics] = useState<PracticeTopic[]>(() => [
    createPracticeTopic(1)
  ]);
  const [selectedTopicId, setSelectedTopicId] = useState(1);
  const [expandedTopicId, setExpandedTopicId] = useState<number | null>(1);
  const [quizTitle, setQuizTitle] = useState('Weekly Mastery Check');
  const [quizCount, setQuizCount] = useState('5');
  const [selectedQuizId, setSelectedQuizId] = useState(1);
  const [selectedItemCount, setSelectedItemCount] = useState('10');
  const [editorSourceText, setEditorSourceText] = useState('');
  const [editorQuestions, setEditorQuestions] = useState<QuestionEntry[]>(createDefaultQuestions(10));
  const [editorMode, setEditorMode] = useState<'text' | 'file'>('text');
  const [loadedFileName, setLoadedFileName] = useState('');
  const [isSourceScanned, setIsSourceScanned] = useState(false);
  const [isScanManualLocked, setIsScanManualLocked] = useState(false);
  const [scanMessage, setScanMessage] = useState('Paste questions or upload a PDF, DOC, DOCX, or text file to scan them.');
  const [scanMessageTone, setScanMessageTone] = useState<ScanMessageTone>('info');
  const [saveValidationMessage, setSaveValidationMessage] = useState('');
  const [invalidAnswerQuestionIds, setInvalidAnswerQuestionIds] = useState<number[]>([]);
  const [isPracticeLoading, setIsPracticeLoading] = useState(false);
  const [isGeneratingAnswers, setIsGeneratingAnswers] = useState(false);
  const [practiceStatus, setPracticeStatus] = useState('');
  const [openTopicMenuId, setOpenTopicMenuId] = useState<number | null>(null);
  const [openQuizMenuId, setOpenQuizMenuId] = useState<number | null>(null);
  const [pendingDeleteTopicId, setPendingDeleteTopicId] = useState<number | null>(null);
  const [pendingDeleteQuizId, setPendingDeleteQuizId] = useState<number | null>(null);
  const [quizDrafts, setQuizDrafts] = useState<Record<string, QuizEditorDraft>>({});
  const [pendingSaveQuestions, setPendingSaveQuestions] = useState<QuestionEntry[] | null>(null);
  const [pendingScanSelection, setPendingScanSelection] = useState<PendingScanSelection | null>(null);
  const [scanStartQuestion, setScanStartQuestion] = useState('1');
  const [appliedScanRange, setAppliedScanRange] = useState<AppliedScanRange | null>(null);
  const [scanRangeModalMode, setScanRangeModalMode] = useState<ScanRangeModalMode>('initial');
  const [answerAssistMode, setAnswerAssistMode] = useState<AnswerAssistMode>('manual');
  const [answerAssistStep, setAnswerAssistStep] = useState<AnswerAssistStep>('select');
  const [answerAssistTrigger, setAnswerAssistTrigger] = useState<AnswerAssistTrigger>('save');
  const [answerAssistQuestionScope, setAnswerAssistQuestionScope] = useState<number | null>(null);
  const [playQuestionIndex, setPlayQuestionIndex] = useState(0);
  const [playSelectedChoice, setPlaySelectedChoice] = useState('');
  const [playResponses, setPlayResponses] = useState<Record<number, string>>({});
  const [playCompleted, setPlayCompleted] = useState(false);
  const [playResult, setPlayResult] = useState<QuizResultSummary | null>(null);
  const [showResultReview, setShowResultReview] = useState(false);
  const [topicPage, setTopicPage] = useState(0);
  const [topicPageInput, setTopicPageInput] = useState('1');

  const selectedTopic = useMemo(
    () => practiceTopics.find((topic) => topic.id === selectedTopicId) ?? null,
    [practiceTopics, selectedTopicId]
  );
  const expandedTopic = useMemo(
    () => practiceTopics.find((topic) => topic.id === expandedTopicId) ?? null,
    [expandedTopicId, practiceTopics]
  );
  const quizInstances = selectedTopic?.quizzes ?? [];
  const savedTitle = selectedTopic?.title ?? 'Weekly Mastery Check';
  const selectedQuiz = useMemo(
    () => quizInstances.find((quiz) => quiz.id === selectedQuizId) ?? null,
    [quizInstances, selectedQuizId]
  );
  const activePlayQuestion = selectedQuiz?.questions[playQuestionIndex] ?? null;
  const parsedPlayQuestion = activePlayQuestion
    ? parsePromptChoices(activePlayQuestion.prompt, activePlayQuestion.answer)
    : null;
  const answerAssistQuestions = pendingSaveQuestions?.slice(
    0,
    answerAssistTrigger === 'scan'
      ? answerAssistQuestionScope ?? pendingSaveQuestions.length
      : pendingSaveQuestions.length
  ) ?? [];
  const pendingMissingAnswerCount = answerAssistQuestions.filter(
    (question) => !question.answer.trim()
  ).length;
  const scanRangeLimit = Number(selectedItemCount);
  const maxScanStartQuestion = pendingScanSelection
    ? Math.max(pendingScanSelection.totalDetected - scanRangeLimit + 1, 1)
    : 1;
  const previewScanEndQuestion = Math.min(
    Number(scanStartQuestion || '1') + scanRangeLimit - 1,
    pendingScanSelection?.totalDetected ?? scanRangeLimit
  );
  const totalTopicPages = Math.max(Math.ceil(practiceTopics.length / TOPICS_PER_PAGE), 1);
  const visiblePracticeTopics = practiceTopics.slice(
    topicPage * TOPICS_PER_PAGE,
    topicPage * TOPICS_PER_PAGE + TOPICS_PER_PAGE
  );

  useEffect(() => {
    if (!invalidAnswerQuestionIds.length) {
      setSaveValidationMessage('');
    }
  }, [invalidAnswerQuestionIds]);

  useEffect(() => {
    setTopicPage((current) => Math.min(current, Math.max(totalTopicPages - 1, 0)));
  }, [totalTopicPages]);

  useEffect(() => {
    setTopicPageInput(String(topicPage + 1));
  }, [topicPage]);

  function commitTopicPage(nextValue: string) {
    const parsedValue = Number(nextValue);

    if (!Number.isFinite(parsedValue)) {
      setTopicPageInput(String(topicPage + 1));
      return;
    }

    const clampedPage = Math.min(
      Math.max(Math.trunc(parsedValue), 1),
      Math.min(totalTopicPages, MAX_TOPIC_PAGE_INPUT)
    );
    setTopicPage(clampedPage - 1);
    setTopicPageInput(String(clampedPage));
  }

  function getDraftKey(topicId: number, quizId: number) {
    return `${topicId}-${quizId}`;
  }

  function createScanMessageDraft(message: string, tone: ScanMessageTone = 'info') {
    return {
      scanMessage: message,
      scanMessageTone: tone
    };
  }

  function showScanMessage(message: string, tone: ScanMessageTone = 'info') {
    setScanMessage(message);
    setScanMessageTone(tone);
  }

  function applyPracticeTopics(
    nextTopics: PracticeTopic[],
    nextSelectedTopicId = selectedTopicId,
    nextExpandedTopicId = expandedTopicId
  ) {
    const normalizedTopics = normalizePracticeTopicState(nextTopics);
    const fallbackTopic = createPracticeTopic(1);

    if (!normalizedTopics.length) {
      setPracticeTopics([]);
      setSelectedTopicId(nextSelectedTopicId);
      setExpandedTopicId(null);
      setQuizTitle('');
      setQuizCount('1');
      setSelectedQuizId(1);
      return;
    }

    const resolvedSelectedTopic =
      normalizedTopics.find((topic) => topic.id === nextSelectedTopicId) ?? fallbackTopic;
    const resolvedExpandedTopic =
      nextExpandedTopicId === null
        ? null
        : normalizedTopics.find((topic) => topic.id === nextExpandedTopicId)?.id ??
          resolvedSelectedTopic.id;

    setPracticeTopics(normalizedTopics);
    setSelectedTopicId(resolvedSelectedTopic.id);
    setExpandedTopicId(resolvedExpandedTopic);
    setQuizTitle(resolvedSelectedTopic.title);
    setQuizCount(String(Math.max(resolvedSelectedTopic.quizzes.length, 1)));
    setSelectedQuizId((current) =>
      Math.min(Math.max(current, 1), Math.max(resolvedSelectedTopic.quizzes.length, 1))
    );
  }

  async function persistPracticeTopics(
    nextTopics: PracticeTopic[],
    nextSelectedTopicId = selectedTopicId,
    nextExpandedTopicId = expandedTopicId
  ) {
    const normalizedTopics = normalizePracticeTopicState(nextTopics);
    const fallbackTopic = normalizedTopics[0] ?? createPracticeTopic(1);
    const flattenedQuizzes = flattenPracticeTopics(normalizedTopics);

    applyPracticeTopics(normalizedTopics, nextSelectedTopicId, nextExpandedTopicId);

    if (!user.id) {
      return;
    }

    setPracticeStatus('Saving Practice to Supabase...');

    try {
      await upsertPracticeWorkspace({
        studentAccountId: user.id,
        title: fallbackTopic.title,
        quizCount: fallbackTopic.quizzes.length,
        quizzes: flattenedQuizzes
      });
      setPracticeStatus('Practice synced to Supabase.');
    } catch {
      setPracticeStatus('Could not save Practice to Supabase.');
    }
  }

  useEffect(() => {
    if (!isAuthenticated || !user.id) {
      return;
    }

    let cancelled = false;

    async function loadPracticeWorkspace() {
      setIsPracticeLoading(true);
      setPracticeStatus('Loading Practice from Supabase...');

      try {
        const workspace = await getPracticeWorkspace(user.id);

        if (cancelled) {
          return;
        }

        if (workspace) {
          const nextTopics = normalizePracticeTopics(workspace).map((topic) =>
            createPracticeTopic(
              topic.id,
              topic.title,
              Math.max(topic.quizzes.length, topic.quiz_count, 1),
              topic.quizzes
            )
          );

          applyPracticeTopics(nextTopics, nextTopics[0]?.id ?? 1, nextTopics[0]?.id ?? 1);
          setPracticeStatus('Practice loaded from Supabase.');
          return;
        }

        const defaultTopics = [createPracticeTopic(1)];
        applyPracticeTopics(defaultTopics, 1, 1);
        await upsertPracticeWorkspace({
          studentAccountId: user.id,
          title: 'Weekly Mastery Check',
          quizCount: defaultTopics[0].quizzes.length,
          quizzes: flattenPracticeTopics(defaultTopics)
        });
        setPracticeStatus('Practice workspace created in Supabase.');
      } catch {
        if (!cancelled) {
          setPracticeStatus('Could not load Practice from Supabase.');
        }
      } finally {
        if (!cancelled) {
          setIsPracticeLoading(false);
        }
      }
    }

    void loadPracticeWorkspace();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, user.id]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextCount = Number(quizCount);
    const nextTitle = quizTitle.trim() || 'Untitled Quiz';
    const nextTopics =
      topicModalMode === 'create'
        ? [
            ...practiceTopics,
            createPracticeTopic(practiceTopics.length + 1, nextTitle, nextCount)
          ]
        : practiceTopics.map((topic) =>
            topic.id === selectedTopicId
              ? {
                  ...topic,
                  title: nextTitle,
                  quizzes: createQuizInstances(nextCount, topic.quizzes)
                }
              : topic
          );
    const nextTopicId =
      topicModalMode === 'create' ? nextTopics.length : selectedTopicId;

    if (topicModalMode === 'create') {
      setTopicPage(Math.floor((nextTopics.length - 1) / TOPICS_PER_PAGE));
    }

    void persistPracticeTopics(nextTopics, nextTopicId, nextTopicId);
    setShowQuizModal(false);
  }

  function handleOpenTopicModal(mode: 'create' | 'edit', topicId = selectedTopicId) {
    const topic = practiceTopics.find((entry) => entry.id === topicId) ?? null;

    setTopicModalMode(mode);
    setSelectedTopicId(topic?.id ?? topicId);
    setQuizTitle(mode === 'create' ? '' : topic?.title ?? '');
    setQuizCount(mode === 'create' ? '1' : String(topic?.quizzes.length ?? 1));
    setOpenTopicMenuId(null);
    setShowQuizModal(true);
  }

  function handleOpenQuizCollection(topicId: number) {
    setSelectedTopicId(topicId);
    setExpandedTopicId((current) => (current === topicId ? null : topicId));
    setOpenTopicMenuId(null);
    setOpenQuizMenuId(null);
  }

  function buildQuizDraft(overrides: Partial<QuizEditorDraft> = {}): QuizEditorDraft {
    return {
      itemCount: Number(selectedItemCount),
      sourceText: editorSourceText,
      questions: editorQuestions,
      editorMode,
      loadedFileName,
      isSourceScanned,
      isScanManualLocked,
      appliedScanRange,
      scanMessage,
      scanMessageTone,
      ...overrides
    };
  }

  function saveQuizDraft(quizId: number, overrides: Partial<QuizEditorDraft> = {}) {
    const draftKey = getDraftKey(selectedTopicId, quizId);

    setQuizDrafts((current) => ({
      ...current,
      [draftKey]: buildQuizDraft(overrides)
    }));
  }

  function clearQuizDraft(quizId: number) {
    const draftKey = getDraftKey(selectedTopicId, quizId);

    setQuizDrafts((current) => {
      if (!(draftKey in current)) {
        return current;
      }

      const nextDrafts = { ...current };
      delete nextDrafts[draftKey];
      return nextDrafts;
    });
  }

  function buildNextTopicsForSelectedTopic(nextTitle: string, nextQuizzes: QuizInstance[]) {
    return practiceTopics.map((topic) =>
      topic.id === selectedTopicId
        ? {
            ...topic,
            title: nextTitle,
            quizzes: nextQuizzes
          }
        : topic
    );
  }

  function openQuizCountStep(quizId: number) {
    const quiz = quizInstances.find((entry) => entry.id === quizId);
    const draft = quizDrafts[getDraftKey(selectedTopicId, quizId)];
    const currentCount = String(draft?.itemCount ?? quiz?.itemCount ?? 10);

    setSelectedQuizId(quizId);
    setSelectedItemCount(currentCount);
    setShowPlayModal(false);
    setShowQuestionCountModal(true);
  }

  function launchQuizEditor(quizId: number, questionCount: number) {
    const quiz = quizInstances.find((entry) => entry.id === quizId);
    const draft = quizDrafts[getDraftKey(selectedTopicId, quizId)];
    const nextQuestionCount = draft?.itemCount ?? questionCount;
    const nextDraftQuestions =
      draft?.questions ?? buildQuestionDrafts(nextQuestionCount, [], quiz?.questions ?? []);

    setSelectedQuizId(quizId);
    setSelectedItemCount(String(nextQuestionCount));
    setEditorSourceText(draft?.sourceText ?? quiz?.sourceText ?? '');
    setEditorQuestions(nextDraftQuestions);
    setLoadedFileName(draft?.loadedFileName ?? '');
    setIsSourceScanned(draft?.isSourceScanned ?? false);
    setIsScanManualLocked(draft?.isScanManualLocked ?? false);
    setAppliedScanRange(draft?.appliedScanRange ?? null);
    setSaveValidationMessage('');
    setInvalidAnswerQuestionIds([]);
    setEditorMode(draft?.editorMode ?? 'text');
    setScanMessage(
      draft?.scanMessage ??
        'Paste questions or upload a PDF, DOC, DOCX, or text file to scan them.'
    );
    setScanMessageTone(draft?.scanMessageTone ?? 'info');
    setShowQuestionCountModal(false);
    setShowPlayModal(false);
    setOpenQuizMenuId(null);
    setShowItemsModal(true);
  }

  function openQuizPlayer(quizId: number) {
    setSelectedQuizId(quizId);
    setPlayQuestionIndex(0);
    setPlaySelectedChoice('');
    setPlayResponses({});
    setPlayCompleted(false);
    setPlayResult(null);
    setShowResultReview(false);
    setShowPlayModal(true);
  }

  function openSelectedQuizFlow(quiz: QuizInstance) {
    const draft = quizDrafts[getDraftKey(selectedTopicId, quiz.id)];

    setShowQuizOverviewModal(false);

    if (draft) {
      launchQuizEditor(quiz.id, draft.itemCount);
      return;
    }

    if (quiz.attempts > 0) {
      openQuizResultSummary(quiz.id);
      return;
    }

    if (hasSavedQuizContent(quiz)) {
      openQuizPlayer(quiz.id);
      return;
    }

    openQuizCountStep(quiz.id);
  }

  function handleEditQuiz(quizId: number) {
    const quiz = quizInstances.find((entry) => entry.id === quizId);
    launchQuizEditor(quizId, quiz?.itemCount ?? 10);
  }

  function handleDeleteQuizRequest(quizId: number) {
    setPendingDeleteQuizId(quizId);
    setOpenQuizMenuId(null);
    setShowDeleteModal(true);
  }

  function handleDeleteTopicRequest(topicId: number) {
    setPendingDeleteTopicId(topicId);
    setOpenTopicMenuId(null);
    setShowDeleteTopicModal(true);
  }

  function handleConfirmDeleteTopic() {
    if (pendingDeleteTopicId === null) {
      return;
    }

    const remainingTopics = practiceTopics.filter((topic) => topic.id !== pendingDeleteTopicId);
    const nextSelectedRawId =
      selectedTopicId === pendingDeleteTopicId
        ? remainingTopics[0]?.id ?? 1
        : selectedTopicId;
    const nextExpandedRawId =
      expandedTopicId === pendingDeleteTopicId
        ? remainingTopics[0]?.id ?? null
        : expandedTopicId;
    const nextSelectedTopicId =
      remainingTopics.findIndex((topic) => topic.id === nextSelectedRawId) + 1 || 1;
    const expandedTopicIndex =
      nextExpandedRawId === null
        ? -1
        : remainingTopics.findIndex((topic) => topic.id === nextExpandedRawId);
    const nextExpandedTopicId =
      nextExpandedRawId === null
        ? null
        : expandedTopicIndex >= 0
        ? expandedTopicIndex + 1
        : remainingTopics[0]
        ? 1
        : null;

    void persistPracticeTopics(remainingTopics, nextSelectedTopicId, nextExpandedTopicId);
    setPendingDeleteTopicId(null);
    setShowDeleteTopicModal(false);
    setShowQuizModal(false);
    setShowQuizOverviewModal(false);
  }

  function handleConfirmDeleteQuiz() {
    if (pendingDeleteQuizId === null) {
      return;
    }

    const nextQuizzes = quizInstances
      .filter((quiz) => quiz.id !== pendingDeleteQuizId)
      .map((quiz, index) => ({
        ...quiz,
        id: index + 1,
        questions: quiz.questions.map((question, questionIndex) => ({
          ...question,
          id: questionIndex + 1
        }))
      }));

    void persistPracticeTopics(
      buildNextTopicsForSelectedTopic(savedTitle, nextQuizzes),
      selectedTopicId,
      expandedTopicId
    );
    setSelectedQuizId(1);
    setPendingDeleteQuizId(null);
    setShowDeleteModal(false);
    setShowPlayModal(false);
    setShowItemsModal(false);
    setShowQuestionCountModal(false);
  }

  function openQuizResultSummary(quizId: number) {
    const quiz = quizInstances.find((entry) => entry.id === quizId);

    if (!quiz) {
      return;
    }

    setSelectedQuizId(quizId);
    setPlayQuestionIndex(0);
    setPlaySelectedChoice('');
    setPlayResponses(quiz.lastResponses ?? {});
    setPlayCompleted(true);
    setShowResultReview(false);
    setPlayResult({
      accuracy: quiz.lastAccuracy,
      attempt: quiz.attempts,
      score: quiz.lastScore,
      total: quiz.questions.length,
      analysis:
        quiz.lastAnalysis || buildPerformanceAnalysis(quiz.lastAccuracy, quiz.lastScore, quiz.questions.length)
    });
    setShowPlayModal(true);
  }

  function handleQuizCardClick(quiz: QuizInstance) {
    setSelectedQuizId(quiz.id);
    setOpenQuizMenuId(null);
    setShowQuizOverviewModal(true);
  }

  function openQuizEditor() {
    launchQuizEditor(selectedQuizId, Number(selectedItemCount));
  }

  function handleItemCountChange(nextValue: string) {
    const nextCount = Number(nextValue);
    setSelectedItemCount(nextValue);
    setEditorQuestions((current) => {
      const nextQuestions = buildQuestionDrafts(nextCount, [], current);
      saveQuizDraft(selectedQuizId, {
        itemCount: nextCount,
        questions: nextQuestions
      });
      return nextQuestions;
    });
  }

  function applyScannedQuestions(
    parsedQuestions: QuestionEntry[],
    totalDetected: number,
    limit: number,
    startQuestionNumber: number,
    showAnswerAssistOnMissing = true
  ) {
    const shouldLockManualChoice = isSourceScanned && isScanManualLocked;
    const nextQuestions = buildScannedQuestionDrafts(limit, parsedQuestions, editorQuestions);
    const endQuestionNumber = startQuestionNumber + parsedQuestions.length - 1;
    const missingAnswersCount = nextQuestions
      .slice(0, parsedQuestions.length)
      .filter((question) => !question.answer.trim()).length;
    const detectedAnswersCount = parsedQuestions.length - missingAnswersCount;

    setEditorQuestions(nextQuestions);
    setIsSourceScanned(true);
    setAppliedScanRange(
      totalDetected > limit
        ? {
            start: startQuestionNumber,
            end: endQuestionNumber,
            total: totalDetected
          }
        : null
    );
    saveQuizDraft(selectedQuizId, {
      itemCount: limit,
      questions: nextQuestions,
      isSourceScanned: true,
      appliedScanRange:
        totalDetected > limit
          ? {
              start: startQuestionNumber,
              end: endQuestionNumber,
              total: totalDetected
            }
          : null
    });

    if (missingAnswersCount > 0 && showAnswerAssistOnMissing) {
      setPendingSaveQuestions(nextQuestions);
      setAnswerAssistMode(shouldLockManualChoice ? 'ai' : 'manual');
      setAnswerAssistStep('select');
      setAnswerAssistTrigger('scan');
      setAnswerAssistQuestionScope(parsedQuestions.length);
      setShowAnswerAssistModal(true);
      showScanMessage(
        `Scanned ${parsedQuestions.length} question${
          parsedQuestions.length === 1 ? '' : 's'
        } from question ${startQuestionNumber} to ${
          endQuestionNumber
        } in ${editorMode === 'file' && loadedFileName ? loadedFileName : 'the text input'}${
          totalDetected > limit ? '.' : '.'
        } ${
          detectedAnswersCount > 0
            ? `${detectedAnswersCount} answer${detectedAnswersCount === 1 ? ' was' : 's were'} found automatically.`
            : 'No answers were found in the source.'
        }`
      );
      return;
    }

    setPendingSaveQuestions(
      missingAnswersCount > 0 ? nextQuestions : null
    );
    setAnswerAssistTrigger('save');
    setAnswerAssistQuestionScope(null);

    if (missingAnswersCount > 0) {
      showScanMessage(
        `Question range ${startQuestionNumber} to ${endQuestionNumber} is ready. Click Scanned if you want to choose Manual or AI for the missing answers.`
      );
      return;
    }

    showScanMessage(
      `Scanned ${parsedQuestions.length} question${
        parsedQuestions.length === 1 ? '' : 's'
      } from question ${startQuestionNumber} to ${
        endQuestionNumber
      } in ${editorMode === 'file' && loadedFileName ? loadedFileName : 'the text input'} and filled the answers automatically.`
    );
  }

  function openScanRangeSelection(
    parsedQuestions: QuestionEntry[],
    totalDetected: number,
    preferredStartQuestion = 1,
    mode: ScanRangeModalMode = 'initial'
  ) {
    const limit = Number(selectedItemCount);
    const maxStart = Math.max(totalDetected - limit + 1, 1);
    const nextStartQuestion = Math.min(Math.max(preferredStartQuestion, 1), maxStart);

    setPendingScanSelection({
      questions: parsedQuestions,
      totalDetected
    });
    setScanRangeModalMode(mode);
    setScanStartQuestion(String(nextStartQuestion));
    setShowScanRangeModal(true);
  }

  function handleOpenAnswerAssistFromScan() {
    const nextPendingQuestions = editorQuestions.map((question) => ({
      ...question
    }));
    const missingAnswersCount = nextPendingQuestions.filter(
      (question) => !question.answer.trim()
    ).length;

    if (!missingAnswersCount) {
      showScanMessage('This scanned question range already has answers filled in.');
      return;
    }

    setPendingSaveQuestions(nextPendingQuestions);
    setAnswerAssistMode(isScanManualLocked ? 'ai' : 'manual');
    setAnswerAssistStep('select');
    setAnswerAssistTrigger('scan');
    setAnswerAssistQuestionScope(nextPendingQuestions.length);
    setShowAnswerAssistModal(true);
  }

  function handleScanQuestions() {
    if (isSourceScanned) {
      handleOpenAnswerAssistFromScan();
      return;
    }

    const limit = Number(selectedItemCount);
    const { questions: parsedQuestions, totalDetected } = createQuestionsFromSource(editorSourceText);

    if (!parsedQuestions.length) {
      showScanMessage(
        'No questions were detected. Try numbered questions like 1. 2. 3.',
        'error'
      );
      return;
    }

    if (totalDetected > limit) {
      openScanRangeSelection(parsedQuestions, totalDetected, appliedScanRange?.start ?? 1, 'initial');
      return;
    }

    applyScannedQuestions(parsedQuestions.slice(0, limit), totalDetected, limit, 1);
  }

  function handleEditScanRange() {
    const limit = Number(selectedItemCount);
    const { questions: parsedQuestions, totalDetected } = createQuestionsFromSource(editorSourceText);

    if (!parsedQuestions.length || totalDetected <= limit) {
      return;
    }

    openScanRangeSelection(parsedQuestions, totalDetected, appliedScanRange?.start ?? 1, 'edit');
  }

  function handleConfirmScanRange() {
    if (!pendingScanSelection) {
      setShowScanRangeModal(false);
      return;
    }

    const limit = Number(selectedItemCount);
    const maxStart = Math.max(pendingScanSelection.totalDetected - limit + 1, 1);
    const requestedStart = Number(scanStartQuestion);
    const startQuestionNumber = Math.min(Math.max(requestedStart, 1), maxStart);
    const startIndex = startQuestionNumber - 1;
    const selectedQuestions = pendingScanSelection.questions.slice(startIndex, startIndex + limit);
    const shouldOpenAnswerAssist = scanRangeModalMode !== 'edit';

    setShowScanRangeModal(false);
    setPendingScanSelection(null);
    setScanRangeModalMode('initial');
    applyScannedQuestions(
      selectedQuestions,
      pendingScanSelection.totalDetected,
      limit,
      startQuestionNumber,
      shouldOpenAnswerAssist
    );
  }

  function handleQuestionChange(questionId: number, field: 'prompt' | 'answer', value: string) {
    setEditorQuestions((current) =>
      {
        const nextQuestions = current.map((question) =>
          question.id === questionId ? { ...question, [field]: value } : question
        );
        saveQuizDraft(selectedQuizId, {
          questions: nextQuestions
        });
        return nextQuestions;
      }
    );

    if (field === 'answer' && value.trim()) {
      setInvalidAnswerQuestionIds((current) => current.filter((id) => id !== questionId));
    }
  }

  function handleAddQuestion() {
    setEditorQuestions((current) => {
      const nextQuestion = {
        id: current.length + 1,
        prompt: `Question ${current.length + 1}`,
        answer: ''
      };

      const nextQuestions = [...current, nextQuestion];
      setSelectedItemCount(String(nextQuestions.length));
      saveQuizDraft(selectedQuizId, {
        itemCount: nextQuestions.length,
        questions: nextQuestions
      });
      return nextQuestions;
    });
    showScanMessage('Added a new question card. You can type the question and answer manually.');
  }

  async function handleFileLoad(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    try {
      const extracted = await extractTextFromQuestionFile(file);
      setEditorMode('file');
      setLoadedFileName(file.name);
      setIsSourceScanned(false);
      setIsScanManualLocked(false);
      setAppliedScanRange(null);
      setPendingScanSelection(null);
      setShowScanRangeModal(false);
      setScanRangeModalMode('initial');
      setEditorSourceText(extracted.text);
      saveQuizDraft(selectedQuizId, {
        sourceText: extracted.text,
        editorMode: 'file',
        loadedFileName: file.name,
        isSourceScanned: false,
        isScanManualLocked: false,
        appliedScanRange: null,
        ...createScanMessageDraft(
          `${file.name} (${extracted.sourceLabel}) is ready. Click Scan to check for answers and fill the question cards.`
        )
      });
      showScanMessage(
        `${file.name} (${extracted.sourceLabel}) is ready. Click Scan to check for answers and fill the question cards.`
      );
    } catch {
      showScanMessage(
        'This file could not be read. Try PDF, DOCX, or a text-based document with numbered questions.',
        'error'
      );
    } finally {
      event.target.value = '';
    }
  }

  function handleSourceTextChange(value: string) {
    setEditorSourceText(value);
    setIsSourceScanned(false);
    setIsScanManualLocked(false);
    setAppliedScanRange(null);
    setPendingScanSelection(null);
    setShowScanRangeModal(false);
    setScanRangeModalMode('initial');
    saveQuizDraft(selectedQuizId, {
      sourceText: value,
      isSourceScanned: false,
      isScanManualLocked: false,
      appliedScanRange: null
    });
  }

  function handleClearLoadedFile() {
    setLoadedFileName('');
    setEditorMode('text');
    setEditorSourceText('');
    setEditorQuestions(createDefaultQuestions(Number(selectedItemCount)));
    setIsSourceScanned(false);
    setIsScanManualLocked(false);
    setAppliedScanRange(null);
    setSaveValidationMessage('');
    setInvalidAnswerQuestionIds([]);
    setPendingSaveQuestions(null);
    setPendingScanSelection(null);
    setAnswerAssistStep('select');
    setAnswerAssistQuestionScope(null);
    setShowAnswerAssistModal(false);
    setShowScanRangeModal(false);
    setScanRangeModalMode('initial');
    showScanMessage('Current file cleared. Upload a new file or paste new questions to scan again.');
    saveQuizDraft(selectedQuizId, {
      sourceText: '',
      questions: createDefaultQuestions(Number(selectedItemCount)),
      editorMode: 'text',
      loadedFileName: '',
      isSourceScanned: false,
      isScanManualLocked: false,
      appliedScanRange: null,
      ...createScanMessageDraft('Current file cleared. Upload a new file or paste new questions to scan again.')
    });
  }

  function commitQuizItems(nextQuestions: QuestionEntry[]) {
    const nextQuizzes = quizInstances.map((quiz) =>
      quiz.id === selectedQuizId
        ? {
            ...quiz,
            itemCount: nextQuestions.length,
            sourceText: editorSourceText,
            questions: nextQuestions.length
              ? nextQuestions
              : createDefaultQuestions(Number(selectedItemCount))
          }
        : quiz
    );

    void persistPracticeTopics(
      buildNextTopicsForSelectedTopic(savedTitle, nextQuizzes),
      selectedTopicId,
      expandedTopicId
    );
    clearQuizDraft(selectedQuizId);
    setPendingSaveQuestions(null);
    setAnswerAssistQuestionScope(null);
    setSaveValidationMessage('');
    setInvalidAnswerQuestionIds([]);
    setShowAnswerAssistModal(false);
    setShowItemsModal(false);
  }

  function handleSaveItems(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanedQuestions = editorQuestions
      .map((question, index) => ({
        id: index + 1,
        prompt: question.prompt.trim() || `Question ${index + 1}`,
        answer: question.answer.trim()
      }))
      .filter((question) => question.prompt.trim().length > 0);

    const missingAnswerIds = cleanedQuestions
      .filter((question) => !question.answer.trim())
      .map((question) => question.id);

    if (missingAnswerIds.length) {
      setSaveValidationMessage('Save Quiz will not proceed because there are still unfinished questions.');
      setInvalidAnswerQuestionIds(missingAnswerIds);
      return;
    }

    setSaveValidationMessage('');
    setInvalidAnswerQuestionIds([]);
    commitQuizItems(cleanedQuestions);
  }

  function handleConfirmAnswerAssist() {
    if (!pendingSaveQuestions?.length) {
      setShowAnswerAssistModal(false);
      return;
    }

    if (answerAssistMode === 'manual') {
      setShowAnswerAssistModal(false);
      setAnswerAssistStep('select');
      if (answerAssistTrigger === 'scan') {
        setIsSourceScanned(true);
        setIsScanManualLocked(true);
        saveQuizDraft(selectedQuizId, {
          isSourceScanned: true,
          isScanManualLocked: true,
          ...createScanMessageDraft(
            'Scan complete. Please review the questions and type the missing answers manually.'
          )
        });
      }
      showScanMessage(
        answerAssistTrigger === 'scan'
          ? 'Scan complete. Please review the questions and type the missing answers manually.'
          : 'Some questions still have no answer. Please enter the missing answers manually before saving.'
      );
      return;
    }

    void handleConfirmAiAnswerAssist();
  }

  async function handleConfirmAiAnswerAssist() {
    if (!pendingSaveQuestions?.length) {
      setShowAnswerAssistModal(false);
      setAnswerAssistStep('select');
      return;
    }

    const scopedQuestionCount =
      answerAssistTrigger === 'scan'
        ? answerAssistQuestionScope ?? pendingSaveQuestions.length
        : pendingSaveQuestions.length;
    const unansweredQuestions = pendingSaveQuestions
      .slice(0, scopedQuestionCount)
      .filter((question) => !question.answer.trim());

    if (!unansweredQuestions.length) {
      setShowAnswerAssistModal(false);
      setAnswerAssistStep('select');
      return;
    }

    setIsGeneratingAnswers(true);
    setPracticeStatus('Generating missing answers with Gemini...');
    showScanMessage('Generating missing answers with AI...');

    try {
      const aiAnswers = await generateAnswersWithGemini(
        unansweredQuestions.map((question) => ({
          id: question.id,
          prompt: question.prompt
        }))
      );
      const aiAnswerMap = new Map(
        aiAnswers
          .filter((entry) => entry.answer.trim().length > 0)
          .map((entry) => [entry.id, entry.answer.trim()])
      );
      const generatedQuestions = pendingSaveQuestions.map((question, index) => {
        if (index >= scopedQuestionCount || question.answer.trim()) {
          return question;
        }

        return {
          ...question,
          answer: aiAnswerMap.get(question.id) || inferAnswerForQuestion(question)
        };
      });
      const unansweredBeforeGeneration = pendingSaveQuestions
        .slice(0, scopedQuestionCount)
        .filter((question) => !question.answer.trim()).length;
      const unresolvedCount = generatedQuestions
        .slice(0, scopedQuestionCount)
        .filter((question) => !question.answer.trim()).length;
      const filledCount = unansweredBeforeGeneration - unresolvedCount;

      setEditorQuestions(generatedQuestions);
      setPendingSaveQuestions(generatedQuestions);
      saveQuizDraft(selectedQuizId, {
        questions: generatedQuestions
      });

      if (answerAssistTrigger === 'scan') {
        setShowAnswerAssistModal(false);
        setAnswerAssistStep('select');
        setPendingSaveQuestions(null);
        setAnswerAssistQuestionScope(null);
        setIsSourceScanned(true);
        saveQuizDraft(selectedQuizId, {
          questions: generatedQuestions,
          isSourceScanned: true
        });

        if (unresolvedCount > 0) {
          saveQuizDraft(selectedQuizId, {
            questions: generatedQuestions,
            isSourceScanned: true,
            ...createScanMessageDraft(
              `AI filled ${filledCount} answer${
                filledCount === 1 ? '' : 's'
              }, but ${unresolvedCount} still need manual review.`
            )
          });
          showScanMessage(
            `AI filled ${filledCount} answer${
              filledCount === 1 ? '' : 's'
            }, but ${unresolvedCount} still need manual review.`
          );
          return;
        }

        saveQuizDraft(selectedQuizId, {
          questions: generatedQuestions,
          isSourceScanned: true,
          ...createScanMessageDraft(
            'AI filled the missing answers into the Type the correct answer fields. Please review them before saving the quiz.'
          )
        });
        showScanMessage(
          'AI filled the missing answers into the Type the correct answer fields. Please review them before saving the quiz.'
        );
        return;
      }

      if (unresolvedCount > 0) {
        setShowAnswerAssistModal(false);
        setAnswerAssistStep('select');
        showScanMessage(
          `AI filled ${filledCount} answer${
            filledCount === 1 ? '' : 's'
          }, but ${unresolvedCount} still need manual review.`
        );
        return;
      }

      showScanMessage('AI generated the missing answers and the quiz was saved.');
      commitQuizItems(generatedQuestions);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'The AI request failed for an unknown reason.';
      setPracticeStatus(message);
      showScanMessage(message, 'error');
    } finally {
      setIsGeneratingAnswers(false);
    }
  }

  function handleSubmitPlayQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!activePlayQuestion || !playSelectedChoice) {
      return;
    }

    const nextResponses = {
      ...playResponses,
      [activePlayQuestion.id]: playSelectedChoice
    };

    setPlayResponses(nextResponses);

    if (!selectedQuiz || playQuestionIndex >= selectedQuiz.questions.length - 1) {
      const total = selectedQuiz?.questions.length ?? 0;
      const score = (selectedQuiz?.questions ?? []).reduce((currentScore, question) => {
        const parsedQuestion = parsePromptChoices(question.prompt, question.answer);
        const correctChoiceLabel = getCorrectChoiceLabel(question.answer, parsedQuestion.choices);
        const chosenLabel = nextResponses[question.id] ?? '';

        return chosenLabel === correctChoiceLabel ? currentScore + 1 : currentScore;
      }, 0);
      const accuracy = total ? Math.round((score / total) * 100) : 0;
      const nextAttempt = (selectedQuiz?.attempts ?? 0) + 1;
      const analysis = buildPerformanceAnalysis(accuracy, score, total);

      const nextQuizzes = quizInstances.map((quiz) =>
          quiz.id === selectedQuizId
            ? {
                ...quiz,
                attempts: nextAttempt,
                lastScore: score,
                lastAccuracy: accuracy,
                lastAnalysis: analysis,
                lastResponses: nextResponses
              }
            : quiz
      );
      void persistPracticeTopics(
        buildNextTopicsForSelectedTopic(savedTitle, nextQuizzes),
        selectedTopicId,
        expandedTopicId
      );
      setPlayResult({
        accuracy,
        attempt: nextAttempt,
        score,
        total,
        analysis
      });
      setPlayCompleted(true);
      setShowResultReview(false);
      return;
    }

    const nextIndex = playQuestionIndex + 1;
    setPlayQuestionIndex(nextIndex);
    setPlaySelectedChoice(nextResponses[nextIndex + 1] ?? '');
  }

  function handleRestartQuiz() {
    setPlayQuestionIndex(0);
    setPlaySelectedChoice('');
    setPlayResponses({});
    setPlayCompleted(false);
    setPlayResult(null);
    setShowResultReview(false);
  }

  const currentQuestionCount = editorQuestions.length;

  return (
    <>
      <section className="practice-builder-shell page-enter glass-panel">
        <div className="practice-intro-head">
          <div className="practice-intro">
            <h1>Practices</h1>
            <p>Create practice topics, choose how many quizzes each topic should store, then build the questions and answers for every quiz card.</p>
          </div>

          <button
            className="practice-add-topic-button"
            onClick={() => handleOpenTopicModal('create')}
            type="button"
          >
            Add Practice
          </button>
        </div>

        <div className="practice-grid">
          {visiblePracticeTopics.map((topic) => (
            <article
              key={topic.id}
              className={`practice-tile ${selectedTopicId === topic.id ? 'active' : ''}`}
              onClick={() => handleOpenQuizCollection(topic.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  handleOpenQuizCollection(topic.id);
                }
              }}
              role="button"
              tabIndex={0}
            >
              <div className="practice-tile-top">
                <div className="practice-tile-icon">Q</div>
                <div className="practice-tile-actions">
                  <button
                    aria-label={`Open actions for ${topic.title}`}
                    className="practice-menu-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenQuizMenuId(null);
                      setOpenTopicMenuId((current) => (current === topic.id ? null : topic.id));
                    }}
                    type="button"
                  >
                    <span />
                    <span />
                    <span />
                  </button>
                  {openTopicMenuId === topic.id && (
                    <div
                      className="practice-menu-dropdown"
                      onClick={(event) => event.stopPropagation()}
                      role="menu"
                    >
                      <button
                        className="practice-menu-item"
                        onClick={() => handleOpenTopicModal('edit', topic.id)}
                        type="button"
                      >
                        Edit
                      </button>
                      <button
                        className="practice-menu-item delete"
                        onClick={() => handleDeleteTopicRequest(topic.id)}
                        type="button"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div className="practice-tile-copy">
                <h2>{topic.title}</h2>
                <p>Open this topic to manage its {topic.quizzes.length} practice quiz card{topic.quizzes.length === 1 ? '' : 's'}.</p>
              </div>

              <div className="practice-tile-foot">
                <span className="practice-meta">
                  {topic.quizzes.length} {topic.quizzes.length === 1 ? 'quiz' : 'quizzes'}
                </span>
                <span className="practice-arrow">{expandedTopicId === topic.id ? '-' : '+'}</span>
              </div>
            </article>
          ))}
        </div>

        {practiceTopics.length > 0 && (
          <div className="practice-grid-nav">
            <button
              aria-label="Go to previous topic page"
              className={`practice-grid-arrow ${topicPage === 0 ? 'hidden' : ''}`}
              disabled={topicPage === 0}
              onClick={() => setTopicPage((current) => Math.max(current - 1, 0))}
              type="button"
            >
              &larr;
            </button>

            <label className="practice-grid-page-control">
              <span>Page</span>
              <input
                className="practice-grid-page-input"
                inputMode="numeric"
                max={Math.min(totalTopicPages, MAX_TOPIC_PAGE_INPUT)}
                min={1}
                onBlur={() => commitTopicPage(topicPageInput)}
                onChange={(event) => setTopicPageInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitTopicPage(topicPageInput);
                  }
                }}
                type="number"
                value={topicPageInput}
              />
              <small>of {totalTopicPages}</small>
            </label>

            <button
              aria-label="Go to next topic page"
              className="practice-grid-arrow"
              disabled={topicPage >= totalTopicPages - 1}
              onClick={() =>
                setTopicPage((current) => Math.min(current + 1, totalTopicPages - 1))
              }
              type="button"
            >
              &rarr;
            </button>
          </div>
        )}

        {expandedTopic && (
          <div className="practice-collection page-enter">
            <div className="practice-collection-head">
              <div>
                <div className="practice-summary-label">Created Quizzes</div>
                <strong>{expandedTopic.title}</strong>
                <p>Click any quiz card below to open its setup, review the question count, and continue.</p>
              </div>
            </div>

            <div className="practice-quiz-list">
              {expandedTopic.quizzes.map((quiz) => (
                <article
                  key={quiz.id}
                  className="practice-quiz-card"
                  onClick={() => handleQuizCardClick(quiz)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      handleQuizCardClick(quiz);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="practice-quiz-card-top">
                    <span className="practice-quiz-number">Quiz {quiz.id}</span>
                    <div className="practice-quiz-actions">
                      <button
                        aria-label={`Open actions for Quiz ${quiz.id}`}
                        className="practice-menu-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setOpenQuizMenuId((current) => (current === quiz.id ? null : quiz.id));
                        }}
                        type="button"
                      >
                        <span />
                        <span />
                        <span />
                      </button>
                      {openQuizMenuId === quiz.id && (
                        <div
                          className="practice-menu-dropdown"
                          onClick={(event) => event.stopPropagation()}
                          role="menu"
                        >
                          {hasSavedQuizContent(quiz) && (
                            <button
                              className="practice-menu-item"
                              onClick={() => handleEditQuiz(quiz.id)}
                              type="button"
                            >
                              Edit
                            </button>
                          )}
                          <button
                            className="practice-menu-item delete"
                            onClick={() => handleDeleteQuizRequest(quiz.id)}
                            type="button"
                          >
                            Delete
                          </button>
                        </div>
                      )}
                      <span className="practice-quiz-pill">{quiz.itemCount} items</span>
                    </div>
                  </div>
                  <h3>
                    {expandedTopic.title} {quiz.id}
                  </h3>
                  <p>
                    {hasSavedQuizContent(quiz)
                      ? `${quiz.itemCount} ${quiz.itemCount === 1 ? 'question' : 'questions'} ready`
                      : 'No question yet'}
                  </p>
                </article>
              ))}
            </div>
          </div>
        )}
      </section>

      <Modal
        open={showQuizModal}
        title={topicModalMode === 'create' ? 'Add Practice Topic' : 'Edit Practice Topic'}
        onClose={() => setShowQuizModal(false)}
      >
        <form className="practice-form" onSubmit={handleSubmit}>
          <label className="practice-field">
            <span>Topic title</span>
            <input
              className="practice-input"
              onChange={(event) => setQuizTitle(event.target.value)}
              placeholder="Enter topic title"
              type="text"
              value={quizTitle}
            />
          </label>

          <label className="practice-field">
            <span>How many quizzes should this topic store?</span>
            <select
              className="practice-select"
              onChange={(event) => setQuizCount(event.target.value)}
              value={quizCount}
            >
              {Array.from({ length: 10 }, (_, index) => {
                const value = String(index + 1);
                return (
                  <option key={value} value={value}>
                    {value}
                  </option>
                );
              })}
            </select>
          </label>

          <div className="practice-preview-card">
            <div className="practice-preview-label">Preview</div>
            <strong>{quizTitle.trim() || 'Untitled Quiz'}</strong>
            <p>
              {quizCount} {Number(quizCount) === 1 ? 'quiz card' : 'quiz cards'} ready in this topic
            </p>
          </div>

          <button className="practice-submit" type="submit">
            {topicModalMode === 'create' ? 'Create Topic' : 'Save Topic'}
          </button>
        </form>
      </Modal>

      <Modal
        open={showQuizOverviewModal}
        title={selectedQuiz ? `${savedTitle} ${selectedQuiz.id}` : 'Quiz Setup'}
        onClose={() => setShowQuizOverviewModal(false)}
      >
        {selectedQuiz && (
          <div className="practice-quiz-overview">
            <div className="practice-preview-card practice-quiz-overview-card">
              <div className="practice-preview-label">Current Quiz Setup</div>
              <strong>
                {savedTitle} {selectedQuiz.id}
              </strong>
              <p>
                {selectedQuiz.itemCount} {selectedQuiz.itemCount === 1 ? 'question' : 'questions'} in this quiz
              </p>
            </div>

            <div className="practice-quiz-overview-stats">
              <div className="practice-quiz-card-stat">
                <span>Topic</span>
                <strong>{savedTitle}</strong>
              </div>
              <div className="practice-quiz-card-stat">
                <span>Attempts</span>
                <strong>{selectedQuiz.attempts}</strong>
              </div>
              <div className="practice-quiz-card-stat">
                <span>Status</span>
                <strong>
                  {quizDrafts[getDraftKey(selectedTopicId, selectedQuiz.id)]
                    ? 'Editing'
                    : selectedQuiz.attempts > 0
                    ? 'Completed'
                    : hasSavedQuizContent(selectedQuiz)
                    ? 'Ready'
                    : 'Needs Setup'}
                </strong>
              </div>
            </div>

            <p className="practice-quiz-overview-copy">
              {quizDrafts[getDraftKey(selectedTopicId, selectedQuiz.id)]
                ? 'A saved draft already exists for this quiz. Continue editing to keep building from where you left off.'
                : selectedQuiz.attempts > 0
                ? `This quiz has ${selectedQuiz.attempts} saved attempt${
                    selectedQuiz.attempts === 1 ? '' : 's'
                  } and can open directly to the result summary.`
                : hasSavedQuizContent(selectedQuiz)
                ? 'This quiz already has saved questions and answers, so it is ready to play or edit.'
                : 'This quiz is still empty. Open the setup flow to choose the question count and start building it.'}
            </p>

            <div className="practice-quiz-overview-actions">
              {selectedQuiz.attempts > 0 ? (
                <>
                  <button
                    className="practice-quiz-overview-link"
                    onClick={() => openSelectedQuizFlow(selectedQuiz)}
                    type="button"
                  >
                    View Result
                  </button>
                  <button
                    className="practice-submit"
                    onClick={() => setShowQuizOverviewModal(false)}
                    type="button"
                  >
                    Okay
                  </button>
                </>
              ) : (
                <>
                  {hasSavedQuizContent(selectedQuiz) && (
                    <button
                      className="practice-secondary-button"
                      onClick={() => {
                        setShowQuizOverviewModal(false);
                        handleEditQuiz(selectedQuiz.id);
                      }}
                      type="button"
                    >
                      Edit Quiz Content
                    </button>
                  )}
                  <button
                    className="practice-submit"
                    onClick={() => openSelectedQuizFlow(selectedQuiz)}
                    type="button"
                  >
                    {quizDrafts[getDraftKey(selectedTopicId, selectedQuiz.id)]
                      ? 'Continue Editing'
                      : hasSavedQuizContent(selectedQuiz)
                      ? 'Open Quiz'
                      : 'Start Setup'}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </Modal>

      <Modal
        open={showQuestionCountModal}
        title={selectedQuiz ? `${savedTitle} ${selectedQuiz.id} Setup` : 'Question Count'}
        onClose={() => setShowQuestionCountModal(false)}
      >
        <form
          className="practice-form"
          onSubmit={(event) => {
            event.preventDefault();
            openQuizEditor();
          }}
        >
          <label className="practice-field">
            <span>
              How many questions should {selectedQuiz ? `Quiz ${selectedQuiz.id}` : 'this quiz'} have?
            </span>
            <select
              className="practice-select"
              onChange={(event) => setSelectedItemCount(event.target.value)}
              value={selectedItemCount}
            >
              {Array.from({ length: 50 }, (_, index) => {
                const value = String(index + 1);
                return (
                  <option key={value} value={value}>
                    {value} {index === 0 ? 'question' : 'questions'}
                  </option>
                );
              })}
            </select>
          </label>

          <div className="practice-preview-card">
            <div className="practice-preview-label">Selected Quiz</div>
            <strong>
              {selectedQuiz ? `${savedTitle} ${selectedQuiz.id}` : savedTitle}
            </strong>
            <p>
              {selectedItemCount} {Number(selectedItemCount) === 1 ? 'question' : 'questions'} will be created before the editor opens
            </p>
          </div>

          <button className="practice-submit" type="submit">
            Continue to Quiz Builder
          </button>
        </form>
      </Modal>

      <Modal
        open={showDeleteModal}
        title="Delete Quiz"
        onClose={() => {
          setPendingDeleteQuizId(null);
          setShowDeleteModal(false);
        }}
      >
        <div className="practice-delete-shell">
          <p className="practice-delete-copy">
            Are you sure you want to delete{' '}
            <strong>
              {pendingDeleteQuizId ? `${savedTitle} ${pendingDeleteQuizId}` : 'this quiz'}
            </strong>
            ?
          </p>
          <div className="practice-delete-actions">
            <button
              className="practice-cancel-button"
              onClick={() => {
                setPendingDeleteQuizId(null);
                setShowDeleteModal(false);
              }}
              type="button"
            >
              Cancel
            </button>
            <button className="practice-danger-button" onClick={handleConfirmDeleteQuiz} type="button">
              Delete
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={showDeleteTopicModal}
        title="Delete Topic"
        onClose={() => {
          setPendingDeleteTopicId(null);
          setShowDeleteTopicModal(false);
        }}
      >
        <div className="practice-delete-shell">
          <p className="practice-delete-copy">
            Are you sure you want to delete{' '}
            <strong>
              {pendingDeleteTopicId
                ? practiceTopics.find((topic) => topic.id === pendingDeleteTopicId)?.title ??
                  'this topic'
                : 'this topic'}
            </strong>
            ?
          </p>
          <div className="practice-delete-actions">
            <button
              className="practice-cancel-button"
              onClick={() => {
                setPendingDeleteTopicId(null);
                setShowDeleteTopicModal(false);
              }}
              type="button"
            >
              Cancel
            </button>
            <button
              className="practice-danger-button"
              onClick={handleConfirmDeleteTopic}
              type="button"
            >
              Delete
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={showScanRangeModal}
        backdropClassName="modal-backdrop-front modal-backdrop-range"
        title="Choose Question Range"
        onClose={() => {
          setShowScanRangeModal(false);
          setPendingScanSelection(null);
          setScanStartQuestion('1');
          setScanRangeModalMode('initial');
        }}
      >
        <div className="practice-scan-range-shell">
          <p className="practice-answer-assist-copy">
            {pendingScanSelection?.totalDetected ?? 0} questions were detected, but this quiz is set to{' '}
            {selectedItemCount}. Choose which question number should start the scan.
          </p>

          <div className="practice-scan-range-grid">
            <label className="practice-field">
              <span>Start from</span>
              <select
                className="practice-select"
                onChange={(event) => setScanStartQuestion(event.target.value)}
                value={scanStartQuestion}
              >
                {Array.from({ length: maxScanStartQuestion }, (_, index) => {
                  const value = String(index + 1);
                  return (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  );
                })}
              </select>
            </label>

            <div className="practice-preview-card">
              <div className="practice-preview-label">Selected Range</div>
              <strong>
                {scanStartQuestion} - {previewScanEndQuestion}
              </strong>
              <p>
                Questions {scanStartQuestion} to {previewScanEndQuestion} will be used for this scan.
              </p>
            </div>
          </div>

          <div className="practice-answer-assist-actions">
            <button
              className="practice-cancel-button"
              onClick={() => {
                setShowScanRangeModal(false);
                setPendingScanSelection(null);
                setScanStartQuestion('1');
                setScanRangeModalMode('initial');
              }}
              type="button"
            >
              Cancel
            </button>
            <button className="practice-submit" onClick={handleConfirmScanRange} type="button">
              {scanRangeModalMode === 'edit' ? 'Okay' : 'Continue Scan'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={showAnswerAssistModal}
        backdropClassName="modal-backdrop-front"
        title={answerAssistTrigger === 'scan' ? 'Answers Not Found' : 'Missing Answers'}
        onClose={() => {
          setShowAnswerAssistModal(false);
          setAnswerAssistStep('select');
        }}
      >
        <div className="practice-answer-assist-shell">
          <p className="practice-answer-assist-copy">
            {pendingMissingAnswerCount} question
            {pendingMissingAnswerCount === 1
              ? ''
              : 's'}{' '}
            {answerAssistTrigger === 'scan'
              ? 'do not have an answer in the scanned source. Do you want to use our AI model or answer them manually?'
              : 'still have no answer. Choose whether you want to generate the answer with AI or enter it manually.'}
          </p>

          <div className="practice-answer-assist-options">
            <button
              className={`practice-answer-assist-option ${
                answerAssistMode === 'manual' ? 'active' : ''
              } ${answerAssistTrigger === 'scan' && isScanManualLocked ? 'disabled' : ''}`}
              disabled={isGeneratingAnswers || (answerAssistTrigger === 'scan' && isScanManualLocked)}
              onClick={() => setAnswerAssistMode('manual')}
              type="button"
            >
              <span>Manual</span>
              <small>
                {answerAssistTrigger === 'scan' && isScanManualLocked
                  ? 'Manual was already used for this scanned file. Choose AI Generate if you want help filling the remaining answers.'
                  : answerAssistTrigger === 'scan'
                  ? 'Keep the scanned questions in the builder and type the missing answers yourself.'
                  : 'Keep the builder open so you can type the missing answers yourself.'}
              </small>
            </button>

            <button
              className={`practice-answer-assist-option ${
                answerAssistMode === 'ai' ? 'active' : ''
              }`}
              disabled={isGeneratingAnswers}
              onClick={() => setAnswerAssistMode('ai')}
              type="button"
            >
              <span>AI Generate</span>
              <small>
                {answerAssistTrigger === 'scan'
                  ? 'Let our AI model try to infer the missing correct answers from the scanned questions and fill them automatically.'
                  : 'Try to infer the missing correct answers and fill them automatically.'}
              </small>
            </button>
          </div>

          <div className="practice-answer-assist-actions">
            <button
              className="practice-cancel-button"
              onClick={() => {
                setShowAnswerAssistModal(false);
                setAnswerAssistStep('select');
              }}
              disabled={isGeneratingAnswers}
              type="button"
            >
              Cancel
            </button>
            <button
              className="practice-submit"
              disabled={isGeneratingAnswers}
              onClick={handleConfirmAnswerAssist}
              type="button"
            >
              {isGeneratingAnswers
                ? 'Generating...'
                : answerAssistMode === 'ai'
                ? 'Generate Answers'
                : 'OK'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        open={showItemsModal}
        title={selectedQuiz ? `${savedTitle} ${selectedQuiz.id}` : 'Quiz Builder'}
        onClose={() => setShowItemsModal(false)}
      >
        <form className="practice-builder-form" onSubmit={handleSaveItems}>
          <div className="practice-builder-toolbar">
            <div className="practice-builder-summary">
              <span className="practice-builder-summary-label">Question Count</span>
              <strong>
                {selectedItemCount} {Number(selectedItemCount) === 1 ? 'question' : 'questions'}
              </strong>
            </div>

            <div className="practice-mode-toggle">
              <button
                className={`practice-mode-button ${editorMode === 'text' ? 'active' : ''}`}
                onClick={() => setEditorMode('text')}
                type="button"
              >
                Paste Text
              </button>
              <button
                className={`practice-mode-button ${editorMode === 'file' ? 'active' : ''}`}
                onClick={() => {
                  setEditorMode('file');
                  fileInputRef.current?.click();
                }}
                type="button"
              >
                Upload File
              </button>
            </div>
          </div>

          <div className="practice-builder-grid">
            <div className="practice-source-panel">
              <div className="practice-panel-head">
                <div>
                  <div className="practice-summary-label">Source</div>
                  <strong>Questions Input</strong>
                </div>
              </div>

              <textarea
                className="practice-source-textarea"
                onChange={(event) => handleSourceTextChange(event.target.value)}
                placeholder={`Paste questions like:\n\n1. What is Sora?\nA. A music app\nB. An AI video generation tool\nC. A game console\nD. A social media platform`}
                value={editorSourceText}
              />

              <div className="practice-source-actions">
                {appliedScanRange && appliedScanRange.total > Number(selectedItemCount) && (
                  <button
                    className="practice-scan-range-chip"
                    onClick={handleEditScanRange}
                    type="button"
                  >
                    {appliedScanRange.start}-{appliedScanRange.end}
                  </button>
                )}
                <button className="practice-scan-button" onClick={handleScanQuestions} type="button">
                  {isSourceScanned ? 'Scanned' : 'Scan'}
                </button>
              </div>

              <div className="practice-file-row">
                <button
                  className="practice-file-button"
                  onClick={() => fileInputRef.current?.click()}
                  type="button"
                >
                  File
                </button>
                <span className="practice-file-note">
                  {loadedFileName || 'File'}
                </span>
                {loadedFileName && (
                  <button
                    aria-label="Clear current file"
                    className="practice-file-clear"
                    onClick={handleClearLoadedFile}
                    type="button"
                  >
                    x
                  </button>
                )}
                <input
                  ref={fileInputRef}
                  accept=".txt,.md,.csv,.pdf,.doc,.docx,text/plain,text/markdown,text/csv,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  className="practice-file-input"
                  onChange={handleFileLoad}
                  type="file"
                />
              </div>

              <p
                className={`practice-scan-message ${
                  scanMessageTone === 'error' ? 'error' : ''
                }`.trim()}
              >
                {scanMessage}
              </p>
            </div>

            <div className="practice-answers-panel">
              <div className="practice-panel-head">
                <div>
                  <div className="practice-summary-label">Answers</div>
                  <strong>
                    {currentQuestionCount} {currentQuestionCount === 1 ? 'Question' : 'Questions'}
                  </strong>
                </div>
                <button className="practice-add-button" onClick={handleAddQuestion} type="button">
                  + Add Question
                </button>
              </div>

              {saveValidationMessage && (
                <p className="practice-validation-message">{saveValidationMessage}</p>
              )}

              <div className="practice-question-list">
                {editorQuestions.map((question) => {
                  const isAnswerMissing = invalidAnswerQuestionIds.includes(question.id);

                  return (
                  <div
                    className={`practice-question-card ${isAnswerMissing ? 'invalid' : ''}`}
                    key={question.id}
                  >
                    <div className="practice-question-head">
                      <span className={`practice-quiz-number ${isAnswerMissing ? 'invalid' : ''}`}>
                        Q{question.id}
                      </span>
                    </div>
                    <textarea
                      className="practice-question-input"
                      onChange={(event) =>
                        handleQuestionChange(question.id, 'prompt', event.target.value)
                      }
                      value={question.prompt}
                    />
                    <input
                      aria-invalid={isAnswerMissing}
                      className={`practice-answer-input ${isAnswerMissing ? 'invalid' : ''}`}
                      onChange={(event) =>
                        handleQuestionChange(question.id, 'answer', event.target.value)
                      }
                      placeholder="Type the correct answer"
                      type="text"
                      value={question.answer}
                    />
                    {isAnswerMissing && (
                      <p className="practice-answer-error">Please type the answer</p>
                    )}
                  </div>
                )})}
              </div>
            </div>
          </div>

          <button className="practice-submit" type="submit">
            Save Quiz
          </button>
        </form>
      </Modal>

      <Modal
        open={showPlayModal}
        title={selectedQuiz ? `${savedTitle} ${selectedQuiz.id}` : 'Quiz Player'}
        onClose={() => setShowPlayModal(false)}
      >
        {selectedQuiz && (
          <div className="practice-play-shell">
            {!playCompleted && activePlayQuestion && parsedPlayQuestion ? (
              <form className="practice-play-form" onSubmit={handleSubmitPlayQuestion}>
                <div className="practice-play-head">
                  <div>
                    <div className="practice-preview-label">Question Progress</div>
                    <strong>
                      Question {playQuestionIndex + 1} of {selectedQuiz.questions.length}
                    </strong>
                  </div>
                  <button
                    className="practice-secondary-button"
                    onClick={() => openQuizCountStep(selectedQuiz.id)}
                    type="button"
                  >
                    Edit Quiz Content
                  </button>
                </div>

                <div className="practice-play-card">
                  <h4>{parsedPlayQuestion.stem}</h4>
                  <div className="practice-choice-list">
                    {parsedPlayQuestion.choices.map((choice) => (
                      <button
                        key={`${activePlayQuestion.id}-${choice.label}`}
                        className={`practice-choice-card ${
                          playSelectedChoice === choice.label ? 'selected' : ''
                        }`}
                        onClick={() => setPlaySelectedChoice(choice.label)}
                        type="button"
                      >
                        <span className="practice-choice-label">{choice.label}</span>
                        <span>{choice.text}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  className="practice-submit"
                  disabled={!playSelectedChoice}
                  type="submit"
                >
                  {playQuestionIndex === selectedQuiz.questions.length - 1
                    ? 'Submit Quiz'
                    : 'Submit and Next Question'}
                </button>
              </form>
            ) : (
              <div className="practice-results-shell">
                <div className="practice-play-head">
                  <div>
                    <div className="practice-preview-label">Quiz Complete</div>
                    <strong className={getAccuracyToneClass(playResult?.accuracy ?? 0)}>
                      Accuracy: {playResult?.accuracy ?? 0}%
                    </strong>
                  </div>
                </div>

                <div className="practice-score-hero">
                  <div
                    className="practice-score-ring"
                    style={
                      {
                        '--score-sweep': `${Math.round(((playResult?.accuracy ?? 0) / 100) * 360)}deg`
                      } as CSSProperties
                    }
                  >
                    <span>{playResult?.accuracy ?? 0}%</span>
                  </div>
                  <div className="practice-score-copy">
                    <h4>{selectedQuiz.questions.length} question{selectedQuiz.questions.length === 1 ? '' : 's'} completed</h4>
                    <p>Your latest attempt has been saved for this quiz.</p>
                  </div>
                </div>

                <div className="practice-results-grid">
                  <article className="practice-result-card">
                    <div className="practice-result-label">Attempt</div>
                    <strong>{playResult?.attempt ?? 0}</strong>
                  </article>
                  <article className="practice-result-card">
                    <div className="practice-result-label">Attempt Score</div>
                    <strong>
                      {playResult?.score ?? 0} / {playResult?.total ?? 0}
                    </strong>
                  </article>
                  <article className="practice-result-card">
                    <div className="practice-result-label">Total</div>
                    <strong>{playResult?.total ?? 0}</strong>
                  </article>
                </div>

                <div className="practice-analysis-card">
                  <div className="practice-preview-label">AI Analysis</div>
                  <p>{playResult?.analysis ?? 'No analysis available yet.'}</p>
                </div>

                <button
                  className="practice-show-result"
                  onClick={() => setShowResultReview((current) => !current)}
                  type="button"
                >
                  {showResultReview ? 'Hide Result' : 'Show Result'}
                </button>

                {showResultReview && (
                  <div className="practice-results-list">
                    {selectedQuiz.questions.map((question) => {
                      const parsedQuestion = parsePromptChoices(question.prompt, question.answer);
                      const correctChoiceLabel = getCorrectChoiceLabel(question.answer, parsedQuestion.choices);
                      const chosenLabel = playResponses[question.id] ?? '';
                      const selectedChoice = parsedQuestion.choices.find(
                        (choice) => choice.label === chosenLabel
                      );
                      const correctChoice = parsedQuestion.choices.find(
                        (choice) => choice.label === correctChoiceLabel
                      );
                      const isCorrect = Boolean(chosenLabel) && chosenLabel === correctChoiceLabel;

                      return (
                        <article
                          className={`practice-review-card ${isCorrect ? 'correct' : 'wrong'}`}
                          key={question.id}
                        >
                          <div className="practice-review-head">
                            <strong className="practice-review-number">
                              {isCorrect ? `Q${question.id}` : `Q${question.id} X`}
                            </strong>
                          </div>
                          <h4>{parsedQuestion.stem}</h4>
                          <div className="practice-review-answer-row">
                            <span className="practice-review-label">Your answer</span>
                            <span className={`practice-review-answer ${isCorrect ? 'correct' : 'wrong'}`}>
                              {selectedChoice
                                ? `${selectedChoice.label}. ${selectedChoice.text}`
                                : 'No answer selected'}
                            </span>
                          </div>
                          {!isCorrect && (
                            <div className="practice-review-answer-row">
                              <span className="practice-review-label">Correct answer</span>
                              <span className="practice-review-correct-answer">
                                {correctChoice
                                  ? `${correctChoice.label}. ${correctChoice.text}`
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
                    className="practice-secondary-button practice-results-close"
                    onClick={() => {
                      setShowResultReview(false);
                      setShowPlayModal(false);
                    }}
                    type="button"
                  >
                    Close
                  </button>
                  <button className="practice-submit" onClick={handleRestartQuiz} type="button">
                    Retake
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

export default Practices;

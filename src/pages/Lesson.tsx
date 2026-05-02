import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent
} from 'react';
import Modal from '../components/Modal';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { extractTextFromQuestionFile } from '../utils/fileTextExtraction';

type LessonRecord = {
  id: number;
  title: string;
  content: string;
  fileName: string;
  fileSourceLabel: string;
  createdAt: string;
};

const LESSONS_PER_PAGE = 6;

function formatMonth(value: string) {
  return new Intl.DateTimeFormat('en-US', { month: 'short' }).format(new Date(value));
}

function formatDay(value: string) {
  return new Intl.DateTimeFormat('en-US', { day: '2-digit' }).format(new Date(value));
}

function formatYear(value: string) {
  return new Intl.DateTimeFormat('en-US', { year: 'numeric' }).format(new Date(value));
}

function formatCreatedAt(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value));
}

function formatShortCreatedAt(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: '2-digit',
    year: 'numeric'
  }).format(new Date(value));
}

function getLessonBadgeText(fileName: string) {
  return fileName ? 'File lesson' : 'Text lesson';
}

function getLessonFileLabel(fileName: string, fileSourceLabel: string) {
  if (!fileName) {
    return 'No file uploaded';
  }

  return fileSourceLabel ? `${fileName} (${fileSourceLabel})` : fileName;
}

function Lesson() {
  const [lessons, setLessons] = useLocalStorage<LessonRecord[]>('lesson-cards', []);
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedLessonId, setSelectedLessonId] = useState<number | null>(null);
  const [editingLessonId, setEditingLessonId] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [manualContent, setManualContent] = useState('');
  const [selectedFileName, setSelectedFileName] = useState('');
  const [selectedFileSourceLabel, setSelectedFileSourceLabel] = useState('');
  const [titleError, setTitleError] = useState('');
  const [contentError, setContentError] = useState('');
  const [page, setPage] = useState(0);
  const [pageInput, setPageInput] = useState('1');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const totalPages = Math.max(Math.ceil(lessons.length / LESSONS_PER_PAGE), 1);
  const visibleLessons = lessons.slice(
    page * LESSONS_PER_PAGE,
    page * LESSONS_PER_PAGE + LESSONS_PER_PAGE
  );
  const selectedLesson = useMemo(
    () => lessons.find((lesson) => lesson.id === selectedLessonId) ?? null,
    [lessons, selectedLessonId]
  );

  useEffect(() => {
    setPage((current) => Math.min(current, Math.max(totalPages - 1, 0)));
  }, [totalPages]);

  useEffect(() => {
    setPageInput(String(page + 1));
  }, [page]);

  function resetForm() {
    setTitle('');
    setContent('');
    setManualContent('');
    setSelectedFileName('');
    setSelectedFileSourceLabel('');
    setTitleError('');
    setContentError('');
  }

  function handleOpenAddModal() {
    resetForm();
    setEditingLessonId(null);
    setShowAddModal(true);
  }

  function handleCloseAddModal() {
    setShowAddModal(false);
    setEditingLessonId(null);
    setTitleError('');
    setContentError('');
  }

  function handleOpenEditModal(lesson: LessonRecord) {
    setEditingLessonId(lesson.id);
    setTitle(lesson.title);
    setContent(lesson.content);
    setManualContent(lesson.fileName ? '' : lesson.content);
    setSelectedFileName(lesson.fileName);
    setSelectedFileSourceLabel(lesson.fileSourceLabel);
    setTitleError('');
    setContentError('');
    setShowAddModal(true);
  }

  function commitPage(nextValue: string) {
    const parsedValue = Number(nextValue);

    if (!Number.isFinite(parsedValue)) {
      setPageInput(String(page + 1));
      return;
    }

    const clampedPage = Math.min(Math.max(Math.trunc(parsedValue), 1), totalPages);
    setPage(clampedPage - 1);
    setPageInput(String(clampedPage));
  }

  function handleContentChange(nextValue: string) {
    setContent(nextValue);
    setManualContent(nextValue);
    setContentError('');
  }

  async function handleFileLoad(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    try {
      const extracted = await extractTextFromQuestionFile(file);
      setSelectedFileName(file.name);
      setSelectedFileSourceLabel(extracted.sourceLabel);
      setContent(extracted.text);
      setContentError('');
    } catch {
      setContentError('This file could not be read. Try DOC, PDF, DOCX, or CSV.');
    } finally {
      event.target.value = '';
    }
  }

  function handleClearSelectedFile() {
    setSelectedFileName('');
    setSelectedFileSourceLabel('');
    setContent(manualContent);
    setContentError('');
  }

  function handleConfirmSelectedFile() {
    setContentError('');
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const normalizedTitle = title.trim();
    const normalizedContent = content.trim();
    let hasError = false;

    if (!normalizedTitle) {
      setTitleError('Please enter a lesson title.');
      hasError = true;
    } else {
      setTitleError('');
    }

    if (!normalizedContent && !selectedFileName) {
      setContentError('Please add lesson content or upload a file.');
      hasError = true;
    } else {
      setContentError('');
    }

    if (hasError) {
      return;
    }

    const nextLesson: LessonRecord = {
      id: editingLessonId ?? Date.now(),
      title: normalizedTitle,
      content: normalizedContent,
      fileName: selectedFileName,
      fileSourceLabel: selectedFileSourceLabel,
      createdAt:
        lessons.find((lesson) => lesson.id === editingLessonId)?.createdAt ??
        new Date().toISOString()
    };

    setLessons((current) =>
      editingLessonId === null
        ? [nextLesson, ...current]
        : current.map((lesson) => (lesson.id === editingLessonId ? nextLesson : lesson))
    );
    setPage(0);
    handleCloseAddModal();
    resetForm();
  }

  return (
    <>
      <section className="lesson-shell page-enter glass-panel">
        {selectedLesson ? (
          <div className="lesson-reader page-enter">
            <button
              className="lesson-back-button"
              onClick={() => setSelectedLessonId(null)}
              type="button"
            >
              &larr; Back
            </button>

            <div className="lesson-reader-head">
              <div className="lesson-reader-copy">
                <span className="lesson-reader-date">
                  {formatShortCreatedAt(selectedLesson.createdAt)}
                </span>
                <h1>{selectedLesson.title}</h1>
                <p>{getLessonBadgeText(selectedLesson.fileName)}</p>
              </div>

              <div className="lesson-detail-calendar">
                <small>{formatMonth(selectedLesson.createdAt)}</small>
                <strong>{formatDay(selectedLesson.createdAt)}</strong>
                <span>{formatYear(selectedLesson.createdAt)}</span>
              </div>
            </div>

            <div className="lesson-reader-body">
              <div className="lesson-detail-copy">
                <div className="practice-preview-label">Created</div>
                <p>{formatCreatedAt(selectedLesson.createdAt)}</p>
              </div>

              <div className="lesson-detail-copy">
                <div className="practice-preview-label">Uploaded File</div>
                <p>{getLessonFileLabel(selectedLesson.fileName, selectedLesson.fileSourceLabel)}</p>
              </div>

              <div className="lesson-detail-copy lesson-reader-content">
                <div className="practice-preview-label">Content</div>
                <p>{selectedLesson.content || 'No lesson content was saved for this card.'}</p>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="lesson-intro-head">
              <div className="lesson-intro">
                <h1>Lessons</h1>
                <p>
                  Build lesson cards with a title, content, and optional uploaded lesson file so
                  students can review everything from one clean space.
                </p>
              </div>

              <button className="lesson-add-button" onClick={handleOpenAddModal} type="button">
                Add Lesson
              </button>
            </div>

            {visibleLessons.length ? (
              <div className="lesson-grid">
                {visibleLessons.map((lesson) => (
                  <article
                    key={lesson.id}
                    className="lesson-card"
                    onClick={() => setSelectedLessonId(lesson.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedLessonId(lesson.id);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="lesson-card-top">
                      <div className="lesson-calendar">
                        <small>{formatMonth(lesson.createdAt)}</small>
                        <strong>{formatDay(lesson.createdAt)}</strong>
                        <span>{formatYear(lesson.createdAt)}</span>
                      </div>
                      <button
                        className="lesson-card-pill lesson-card-edit-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleOpenEditModal(lesson);
                        }}
                        type="button"
                      >
                        Edit lesson
                      </button>
                    </div>

                    <div className="lesson-card-copy">
                      <h2>{lesson.title}</h2>
                      <p className="lesson-card-view">View Lesson</p>
                    </div>

                    <div className="lesson-card-foot">
                      <span className="lesson-link-chip">
                        {lesson.fileName ? lesson.fileName : 'Manual content'}
                      </span>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="lesson-empty-state">
                <strong>No lessons yet</strong>
                <p>
                  Add your first lesson card to save a title, content, uploaded file, and its
                  created date.
                </p>
              </div>
            )}

            <div className="lesson-grid-nav">
              <button
                aria-label="Go to previous lesson page"
                className={`practice-grid-arrow ${page === 0 ? 'hidden' : ''}`}
                disabled={page === 0}
                onClick={() => setPage((current) => Math.max(current - 1, 0))}
                type="button"
              >
                &larr;
              </button>

              <label className="practice-grid-page-control">
                <span>Page</span>
                <input
                  className="practice-grid-page-input"
                  inputMode="numeric"
                  max={totalPages}
                  min={1}
                  onBlur={() => commitPage(pageInput)}
                  onChange={(event) => setPageInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitPage(pageInput);
                    }
                  }}
                  type="number"
                  value={pageInput}
                />
                <small>of {totalPages}</small>
              </label>

              <button
                aria-label="Go to next lesson page"
                className="practice-grid-arrow"
                disabled={page >= totalPages - 1}
                onClick={() => setPage((current) => Math.min(current + 1, totalPages - 1))}
                type="button"
              >
                &rarr;
              </button>
            </div>
          </>
        )}
      </section>

      <Modal
        open={showAddModal}
        title={editingLessonId === null ? 'Add Lesson' : 'Edit Lesson'}
        onClose={handleCloseAddModal}
      >
        <form className="lesson-form" onSubmit={handleSubmit}>
          <label className="practice-field">
            <span>Title</span>
            <input
              className="practice-input"
              onChange={(event) => {
                setTitle(event.target.value);
                setTitleError('');
              }}
              placeholder="Enter the lesson title"
              type="text"
              value={title}
            />
            {titleError && <p className="lesson-form-error">{titleError}</p>}
          </label>

          <label className="practice-field">
            <span>Content</span>
            {selectedFileName ? (
              <input
                className="practice-input lesson-content-locked"
                disabled
                type="text"
                value={getLessonFileLabel(selectedFileName, selectedFileSourceLabel)}
              />
            ) : (
              <textarea
                className="lesson-textarea"
                onChange={(event) => handleContentChange(event.target.value)}
                placeholder="Type the lesson content or notes here"
                rows={7}
                value={content}
              />
            )}
            {contentError && !selectedFileName && (
              <p className="lesson-form-error">{contentError}</p>
            )}
          </label>

          <div className="practice-field">
            <span>File Link</span>
            <div className="practice-file-row lesson-upload-row">
              <button
                className="practice-file-button"
                onClick={() => fileInputRef.current?.click()}
                type="button"
              >
                File Link
              </button>
              <span className="practice-file-note">
                {selectedFileName
                  ? getLessonFileLabel(selectedFileName, selectedFileSourceLabel)
                  : 'Upload a DOC, PDF, DOCX, or CSV file if you want to use a file instead of manual content.'}
              </span>
              {selectedFileName && (
                <button
                  className="practice-file-button lesson-done-button"
                  onClick={handleConfirmSelectedFile}
                  type="button"
                >
                  Done
                </button>
              )}
              {selectedFileName && (
                <button
                  aria-label="Clear selected lesson file"
                  className="practice-file-clear"
                  onClick={handleClearSelectedFile}
                  type="button"
                >
                  x
                </button>
              )}
              <input
                ref={fileInputRef}
                accept=".doc,.docs,.pdf,.docx,.csv,text/csv,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                className="practice-file-input"
                onChange={handleFileLoad}
                type="file"
              />
            </div>
            {contentError && selectedFileName && (
              <p className="lesson-form-error">{contentError}</p>
            )}
          </div>

          <div className="lesson-modal-actions">
            <button
              className="practice-file-button lesson-secondary-button"
              onClick={handleCloseAddModal}
              type="button"
            >
              Cancel
            </button>
            <button className="practice-submit" type="submit">
              {editingLessonId === null ? 'Add' : 'Save'}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}

export default Lesson;

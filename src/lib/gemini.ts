const GEMINI_MODEL = import.meta.env.VITE_GEMINI_MODEL || 'gemini-2.0-flash';
const LOCAL_AI_URL = import.meta.env.VITE_LOCAL_AI_URL || 'http://127.0.0.1:11434/api/generate';
const LOCAL_AI_MODEL = import.meta.env.VITE_LOCAL_AI_MODEL || 'llama3.2';
const LOCAL_AI_TIMEOUT_MS = Number(import.meta.env.VITE_LOCAL_AI_TIMEOUT_MS || '12000');
const GEMINI_API_KEYS = [
  import.meta.env.VITE_GEMINI_API_KEY,
  import.meta.env.VITE_GEMINI_API_KEY_2,
  import.meta.env.VITE_GEMINI_API_KEY_3,
  import.meta.env.VITE_GEMINI_API_KEY_4
].filter((key, index, keys): key is string => Boolean(key) && keys.indexOf(key) === index);
let geminiKeyCursor = 0;

type AiQuestionInput = {
  id: number;
  prompt: string;
};

type AiAnswerOutput = {
  id: number;
  answer: string;
};

type GeminiPart = {
  text?: string;
};

type GeminiCandidate = {
  content?: {
    parts?: GeminiPart[];
  };
};

type GeminiResponse = {
  candidates?: GeminiCandidate[];
};

type LocalAiResponse =
  | {
      response?: string;
      message?: {
        content?: string;
      };
      choices?: Array<{
        message?: {
          content?: string;
        };
        text?: string;
      }>;
      candidates?: GeminiCandidate[];
    }
  | null;

type GeminiErrorDetail = {
  '@type'?: string;
  retryDelay?: string;
};

type GeminiErrorResponse = {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: GeminiErrorDetail[];
  };
};

type ParsedGeminiError = {
  isQuotaError: boolean;
  message: string;
  retryDelayMs: number | null;
};

function extractJsonPayload(text: string) {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);

  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  return text.trim();
}

function extractResponseText(payload: LocalAiResponse) {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  if (typeof payload.response === 'string') {
    return payload.response.trim();
  }

  if (typeof payload.message?.content === 'string') {
    return payload.message.content.trim();
  }

  if (typeof payload.choices?.[0]?.message?.content === 'string') {
    return payload.choices[0].message.content.trim();
  }

  if (typeof payload.choices?.[0]?.text === 'string') {
    return payload.choices[0].text.trim();
  }

  if (payload.candidates?.length) {
    return payload.candidates
      .flatMap((candidate) => candidate.content?.parts ?? [])
      .map((part) => part.text || '')
      .join('')
      .trim();
  }

  return '';
}

function normalizeAiAnswers(payload: unknown) {
  const rawAnswers = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { answers?: unknown[] }).answers)
    ? (payload as { answers: unknown[] }).answers
    : [];

  return rawAnswers
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const { id, answer } = entry as Partial<AiAnswerOutput>;

      if (typeof id !== 'number' || typeof answer !== 'string') {
        return null;
      }

      return {
        id,
        answer: answer.trim()
      };
    })
    .filter((entry): entry is AiAnswerOutput => entry !== null);
}

function formatRetryDelay(retryDelay?: string) {
  if (!retryDelay) {
    return '';
  }

  const secondsMatch = retryDelay.match(/(\d+)/);
  const seconds = secondsMatch ? Number(secondsMatch[1]) : Number.NaN;

  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '';
  }

  return seconds === 1 ? ' Please try again in about 1 second.' : ` Please try again in about ${seconds} seconds.`;
}

function parseRetryDelayMs(retryDelay?: string) {
  if (!retryDelay) {
    return null;
  }

  const secondsMatch = retryDelay.match(/(\d+)/);
  const seconds = secondsMatch ? Number(secondsMatch[1]) : Number.NaN;

  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  return seconds * 1000;
}

function delay(ms: number) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function requestLocalAi(prompt: string) {
  const abortController = new AbortController();
  const timeoutId = window.setTimeout(() => abortController.abort(), LOCAL_AI_TIMEOUT_MS);

  try {
    const response = await fetch(LOCAL_AI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: LOCAL_AI_MODEL,
        prompt,
        stream: false
      }),
      signal: abortController.signal
    });

    if (!response.ok) {
      throw new Error(`Local AI request failed with status ${response.status}.`);
    }

    const payload = (await response.json()) as LocalAiResponse;
    const text = extractResponseText(payload);

    if (!text) {
      throw new Error('Local AI returned an empty response.');
    }

    return normalizeAiAnswers(JSON.parse(extractJsonPayload(text)));
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function getRotatedApiKeys() {
  if (!GEMINI_API_KEYS.length) {
    return [];
  }

  const normalizedCursor = geminiKeyCursor % GEMINI_API_KEYS.length;
  return [
    ...GEMINI_API_KEYS.slice(normalizedCursor),
    ...GEMINI_API_KEYS.slice(0, normalizedCursor)
  ];
}

function parseGeminiError(errorText: string): ParsedGeminiError {
  const fallbackMessage = 'AI answers are unavailable right now. Please try again.';

  try {
    const parsed = JSON.parse(errorText) as GeminiErrorResponse;
    const error = parsed.error;

    if (!error) {
      return {
        isQuotaError: false,
        message: fallbackMessage,
        retryDelayMs: null
      };
    }

    const rawMessage = error.message?.toLowerCase() ?? '';
    const isQuotaError =
      error.code === 429 ||
      error.status === 'RESOURCE_EXHAUSTED' ||
      rawMessage.includes('quota exceeded') ||
      rawMessage.includes('exceeded your current quota');

    if (isQuotaError) {
      const retryDelay = error.details?.find((detail) => detail.retryDelay)?.retryDelay;
      return {
        isQuotaError: true,
        message: `AI answers are temporarily unavailable because the Gemini quota has been reached.${formatRetryDelay(
          retryDelay
        )}`,
        retryDelayMs: parseRetryDelayMs(retryDelay)
      };
    }
  } catch {
    if (
      errorText.toLowerCase().includes('quota exceeded') ||
      errorText.toLowerCase().includes('resource_exhausted')
    ) {
      return {
        isQuotaError: true,
        message:
          'AI answers are temporarily unavailable because the Gemini quota has been reached. Please try again soon.',
        retryDelayMs: null
      };
    }
  }

  return {
    isQuotaError: false,
    message: fallbackMessage,
    retryDelayMs: null
  };
}

export async function generateAnswersWithGemini(questions: AiQuestionInput[]) {
  if (!GEMINI_API_KEYS.length && !LOCAL_AI_URL) {
    throw new Error('Missing Gemini API keys in the app environment.');
  }

  const prompt = [
    'Infer the best answer for each quiz item.',
    'Rules:',
    '1. Return JSON only.',
    '2. If the item is multiple choice, answer with the single choice label only, like A or B.',
    '3. If the item is open-ended, answer with the shortest correct answer text.',
    '4. If the answer cannot be inferred confidently, return an empty string.',
    '5. Preserve the same id values.',
    '',
    'Questions:',
    JSON.stringify(questions, null, 2)
  ].join('\n');

  try {
    const localAnswers = await requestLocalAi(prompt);

    if (localAnswers.length) {
      return localAnswers;
    }
  } catch {
    // Fall back to Gemini when the local model is unavailable or returns invalid output.
  }

  if (!GEMINI_API_KEYS.length) {
    throw new Error('Local AI is unavailable and Gemini API keys are missing.');
  }

  let lastErrorMessage = 'Gemini request failed';
  const maxQuotaRetryRounds = 2;

  for (let round = 0; round < maxQuotaRetryRounds; round += 1) {
    const rotatedApiKeys = getRotatedApiKeys();
    let shortestRetryDelayMs: number | null = null;

    for (let index = 0; index < rotatedApiKeys.length; index += 1) {
      const apiKey = rotatedApiKeys[index];
      const actualKeyIndex = GEMINI_API_KEYS.indexOf(apiKey);

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
          GEMINI_MODEL
        )}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            contents: [
              {
                role: 'user',
                parts: [{ text: prompt }]
              }
            ],
            generationConfig: {
              temperature: 0.2,
              responseMimeType: 'application/json'
            }
          })
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        const parsedError = errorText
          ? parseGeminiError(errorText)
          : {
              isQuotaError: false,
              message: 'Gemini request failed',
              retryDelayMs: null
            };

        lastErrorMessage = parsedError.message;

        if (parsedError.isQuotaError) {
          if (
            parsedError.retryDelayMs !== null &&
            (shortestRetryDelayMs === null || parsedError.retryDelayMs < shortestRetryDelayMs)
          ) {
            shortestRetryDelayMs = parsedError.retryDelayMs;
          }

          geminiKeyCursor = actualKeyIndex >= 0 ? (actualKeyIndex + 1) % GEMINI_API_KEYS.length : 0;
          continue;
        }

        throw new Error(parsedError.message);
      }

      const data = (await response.json()) as GeminiResponse;
      const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('').trim();

      if (!text) {
        throw new Error('Gemini returned an empty response.');
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(extractJsonPayload(text));
      } catch {
        throw new Error('Gemini returned a response that was not valid JSON.');
      }

      geminiKeyCursor = actualKeyIndex >= 0 ? (actualKeyIndex + 1) % GEMINI_API_KEYS.length : 0;
      return normalizeAiAnswers(parsed);
    }

    if (shortestRetryDelayMs !== null && round < maxQuotaRetryRounds - 1) {
      await delay(shortestRetryDelayMs);
      continue;
    }
  }

  throw new Error(lastErrorMessage);
}

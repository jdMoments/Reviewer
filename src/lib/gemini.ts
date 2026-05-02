const GEMINI_MODEL = import.meta.env.VITE_GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_API_KEYS = [
  import.meta.env.VITE_GEMINI_API_KEY,
  import.meta.env.VITE_GEMINI_API_KEY_2,
  import.meta.env.VITE_GEMINI_API_KEY_3,
  import.meta.env.VITE_GEMINI_API_KEY_4
].filter((key, index, keys): key is string => Boolean(key) && keys.indexOf(key) === index);

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
};

function extractJsonPayload(text: string) {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);

  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  return text.trim();
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

function parseGeminiError(errorText: string): ParsedGeminiError {
  const fallbackMessage = 'AI answers are unavailable right now. Please try again.';

  try {
    const parsed = JSON.parse(errorText) as GeminiErrorResponse;
    const error = parsed.error;

    if (!error) {
      return {
        isQuotaError: false,
        message: fallbackMessage
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
        )}`
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
          'AI answers are temporarily unavailable because the Gemini quota has been reached. Please try again soon.'
      };
    }
  }

  return {
    isQuotaError: false,
    message: fallbackMessage
  };
}

export async function generateAnswersWithGemini(questions: AiQuestionInput[]) {
  if (!GEMINI_API_KEYS.length) {
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

  let lastErrorMessage = 'Gemini request failed';

  for (const apiKey of GEMINI_API_KEYS) {
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
            message: 'Gemini request failed'
          };

      lastErrorMessage = parsedError.message;

      if (parsedError.isQuotaError) {
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

    return normalizeAiAnswers(parsed);
  }

  throw new Error(lastErrorMessage);
}

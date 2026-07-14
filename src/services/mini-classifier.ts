export const MINI_ROLES = [
  'general',
  'reasoning',
  'coding',
  'research',
  'creative',
  'review',
] as const;

export type MiniRole = (typeof MINI_ROLES)[number];
export type MiniSpecialistRole = Exclude<MiniRole, 'general'>;

export type MiniClassifierInput = {
  latestUserText: string;
  previousUserText?: string;
  previousMiniRole?: MiniRole;
};

export type MiniClassification = {
  role: MiniRole;
  scores: Record<MiniSpecialistRole, number>;
  matchedSignals: string[];
};

type WeightedSignal = readonly [phrase: string, weight: number];

export const MIN_SPECIALIST_SCORE = 3;

const MAX_CLASSIFIER_TEXT_LENGTH = 32_000;
const PREVIOUS_USER_WEIGHT = 0.6;

const SPECIALIST_ROLES: readonly MiniSpecialistRole[] = [
  'reasoning',
  'coding',
  'research',
  'creative',
  'review',
];

const TIE_PRECEDENCE: readonly MiniSpecialistRole[] = [
  'review',
  'coding',
  'research',
  'reasoning',
  'creative',
];

const SIGNALS: Record<MiniSpecialistRole, readonly WeightedSignal[]> = {
  reasoning: [
    ['step by step', 3],
    ['formal logic', 3],
    ['trade off', 3],
    ['prove', 3],
    ['calculate', 3],
    ['derive', 3],
    ['phan tich tung buoc', 4],
    ['tung buoc', 2],
    ['phan tich', 2],
    ['suy luan', 3],
    ['chung minh', 3],
    ['tinh toan', 3],
    ['danh doi', 3],
  ],
  coding: [
    ['stack trace', 4],
    ['write code', 3],
    ['implement', 3],
    ['implementation', 3],
    ['debug', 3],
    ['refactor', 3],
    ['typescript', 2],
    ['javascript', 2],
    ['react', 2],
    ['python', 2],
    ['viet code', 3],
    ['sua code', 3],
    ['trien khai', 2],
    ['loi', 1],
    ['ham', 1],
    ['class', 1],
    ['build', 2],
    ['compile', 2],
  ],
  research: [
    ['compare sources', 4],
    ['synthesize findings', 4],
    ['research', 3],
    ['sources', 3],
    ['citations', 3],
    ['cite', 2],
    ['evidence', 3],
    ['literature', 3],
    ['nghien cuu', 3],
    ['tim nguon', 3],
    ['dan chung', 3],
    ['trich nguon', 3],
    ['tong hop tai lieu', 4],
    ['kiem chung', 2],
  ],
  creative: [
    ['creative writing', 4],
    ['rewrite creatively', 4],
    ['brainstorm', 3],
    ['slogan', 3],
    ['story', 3],
    ['ideate', 3],
    ['len y tuong', 3],
    ['dat ten', 3],
    ['viet truyen', 3],
    ['sang tao', 3],
  ],
  review: [
    ['security vulnerabilities', 5],
    ['security vulnerability', 5],
    ['vulnerabilities', 4],
    ['vulnerability', 4],
    ['review', 4],
    ['audit', 4],
    ['critique', 4],
    ['correctness', 3],
    ['danh gia', 3],
    ['xem lai', 3],
    ['kiem tra', 2],
    ['phan bien', 3],
    ['lo hong', 4],
    ['dung chua', 3],
  ],
};

const CONTINUATION_SIGNALS = [
  'continue',
  'keep going',
  'do that',
  'that part',
  'the above',
  'above',
  'tiep tuc',
  'lam tiep',
  'sua luon phan do',
  'phan do',
  'doan tren',
] as const;

type ScoredText = {
  scores: Record<MiniSpecialistRole, number>;
  matchedSignals: string[];
};

function emptyScores(): Record<MiniSpecialistRole, number> {
  return {
    reasoning: 0,
    coding: 0,
    research: 0,
    creative: 0,
    review: 0,
  };
}

function normalizeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .slice(0, MAX_CLASSIFIER_TEXT_LENGTH)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9_+#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsPhrase(normalizedText: string, phrase: string): boolean {
  return ` ${normalizedText} `.includes(` ${phrase} `);
}

function scoreText(value: unknown, weightMultiplier = 1): ScoredText {
  const normalized = normalizeText(value);
  const scores = emptyScores();
  const matchedSignals: string[] = [];
  if (!normalized) return { scores, matchedSignals };

  for (const role of SPECIALIST_ROLES) {
    for (const [phrase, weight] of SIGNALS[role]) {
      if (!containsPhrase(normalized, phrase)) continue;
      scores[role] += weight * weightMultiplier;
      matchedSignals.push(`${role}:${phrase}`);
    }
  }

  const source = typeof value === 'string' ? value.slice(0, MAX_CLASSIFIER_TEXT_LENGTH) : '';
  if (/```[\s\S]*?```/.test(source)) {
    scores.coding += 4 * weightMultiplier;
    matchedSignals.push('coding:fenced-code');
  }
  if (/\b(?:at\s+\S+\s+\([^\n)]+:\d+(?::\d+)?\)|traceback \(most recent call last\))/i.test(source)) {
    scores.coding += 4 * weightMultiplier;
    matchedSignals.push('coding:stack-trace');
  }
  if (/\b[\w-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|cs|cpp|c|rb|php)\b/i.test(source)) {
    scores.coding += 3 * weightMultiplier;
    matchedSignals.push('coding:file-extension');
  }

  return { scores, matchedSignals };
}

function selectSpecialist(scores: Record<MiniSpecialistRole, number>): MiniSpecialistRole | null {
  let selected: MiniSpecialistRole | null = null;
  let selectedScore = MIN_SPECIALIST_SCORE;

  for (const role of TIE_PRECEDENCE) {
    const score = scores[role];
    if (score < selectedScore) continue;
    if (score === selectedScore && selected !== null) continue;
    selected = role;
    selectedScore = score;
  }

  return selected;
}

function isContinuation(value: unknown): boolean {
  const normalized = normalizeText(value);
  return CONTINUATION_SIGNALS.some((signal) => containsPhrase(normalized, signal));
}

function isMiniRole(value: unknown): value is MiniRole {
  return MINI_ROLES.includes(value as MiniRole);
}

export function classifyMiniIntent(input: MiniClassifierInput): MiniClassification {
  const latest = scoreText(input?.latestUserText);
  const latestRole = selectSpecialist(latest.scores);

  if (latestRole) {
    return { role: latestRole, scores: latest.scores, matchedSignals: latest.matchedSignals };
  }

  if (!isContinuation(input?.latestUserText)) {
    return { role: 'general', scores: latest.scores, matchedSignals: latest.matchedSignals };
  }

  if (isMiniRole(input?.previousMiniRole)) {
    return {
      role: input.previousMiniRole,
      scores: latest.scores,
      matchedSignals: [...latest.matchedSignals, `continuation:previous-role:${input.previousMiniRole}`],
    };
  }

  const previous = scoreText(input?.previousUserText, PREVIOUS_USER_WEIGHT);
  const previousRole = selectSpecialist(previous.scores);
  if (previousRole) {
    return {
      role: previousRole,
      scores: latest.scores,
      matchedSignals: previous.matchedSignals.map((signal) => `previous:${signal}`),
    };
  }

  return { role: 'general', scores: latest.scores, matchedSignals: latest.matchedSignals };
}

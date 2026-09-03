import type {
  LeaderboardBoard,
  LeaderboardMetric,
  LeaderboardOverviewResponse,
  LeaderboardRange,
  LeaderboardRow,
  ToolLeaderboard,
} from '@juejin-opensource/jusage-core';
import mockHotList from '../../mock-users.json' with { type: 'json' };

/** Mock list size; aligned with core LEADERBOARD_DEFAULT_LIMIT (50). */
const MOCK_LEADERBOARD_LIMIT = 50;

type MockUser = Omit<LeaderboardRow, 'rank' | 'isCurrentUser'> & {
  avatarUrl?: string;
  isCurrentUser: boolean;
};

interface MockAuthor {
  avatar: string;
  name: string;
  userId: string;
}

interface MockRangeProfile {
  costScale: number;
  currentCostScale: number;
  currentTokensScale: number;
  participantScale: number;
  seed: number;
  tokensScale: number;
}

interface MockToolProfile {
  costScale: number;
  key: string;
  name: string;
  offset: number;
  sortOrder: number;
  tokensScale: number;
  totalUsers: number;
}

const MOCK_AUTHORS: readonly MockAuthor[] = (() => {
  const authors = new Map<string, MockAuthor>();
  for (const item of mockHotList) {
    const author = item.author;
    if (!author?.user_id || authors.has(author.user_id)) continue;
    authors.set(author.user_id, {
      userId: author.user_id,
      name: author.name,
      avatar: author.avatar,
    });
  }
  return Array.from(authors.values());
})();

const MOCK_USERS: readonly MockUser[] = Array.from(
  { length: MOCK_LEADERBOARD_LIMIT },
  (_, index) => {
    const author =
      MOCK_AUTHORS.length > 0
        ? MOCK_AUTHORS[index % MOCK_AUTHORS.length]
        : undefined;
    const isCurrentUser = index === 0;
    const userHash = isCurrentUser
      ? 'c0dec001'
      : (Math.imul(0x45d9f3b, index + 17) >>> 0)
          .toString(16)
          .padStart(8, '0');
    // Unique uid so cycling author avatars still produce distinct list rows.
    const uid = author
      ? index < MOCK_AUTHORS.length
        ? author.userId
        : `${author.userId}-${index}`
      : userHash;

    return {
      displayName: author?.name ?? `用户 ${userHash}`,
      userHash,
      uid,
      avatarUrl: author?.avatar,
      tokens: isCurrentUser
        ? 15_000_000_000
        : Math.max(
            120_000_000,
            9_500_000_000 -
              index * 175_000_000 +
              ((index * 7) % 5) * 45_000_000,
          ),
      costUsd: isCurrentUser
        ? 14_000
        : Math.max(
            80,
            Number(
              (
                8_200 -
                index * 145 +
                ((index * 11) % 7) * 38
              ).toFixed(2),
            ),
          ),
      isCurrentUser,
    };
  },
);

/** Profiles for rank page avatar/name when mock data is enabled. */
export function createMockUserProfiles(): Record<
  string,
  { uid: string; userName: string; avatarUrl: string; profileUrl: string }
> {
  const profiles: Record<
    string,
    { uid: string; userName: string; avatarUrl: string; profileUrl: string }
  > = {};
  for (const user of MOCK_USERS) {
    if (!user.uid) continue;
    profiles[user.uid] = {
      uid: user.uid,
      userName: user.displayName,
      avatarUrl: user.avatarUrl ?? '',
      profileUrl: `https://juejin.cn/user/${encodeURIComponent(user.uid)}`,
    };
  }
  return profiles;
}

const RANGE_PROFILES: Readonly<Record<LeaderboardRange, MockRangeProfile>> = {
  today: {
    tokensScale: 0.035,
    costScale: 0.04,
    currentTokensScale: 1.32,
    currentCostScale: 1.18,
    participantScale: 0.34,
    seed: 1,
  },
  week: {
    tokensScale: 1,
    costScale: 1,
    currentTokensScale: 1.15,
    currentCostScale: 1.12,
    participantScale: 0.72,
    seed: 3,
  },
  month: {
    tokensScale: 3.7,
    costScale: 3.55,
    currentTokensScale: 1.21,
    currentCostScale: 1.08,
    participantScale: 0.91,
    seed: 5,
  },
  all: {
    tokensScale: 9.4,
    costScale: 8.85,
    currentTokensScale: 1.18,
    currentCostScale: 1.2,
    participantScale: 1,
    seed: 7,
  },
};

const RANGE_DAYS: Readonly<Record<LeaderboardRange, number | null>> = {
  today: 1,
  week: 7,
  month: 30,
  all: null,
};

const MOCK_TOOL_PROFILES: readonly MockToolProfile[] = [
  {
    key: 'cursor',
    name: 'Cursor',
    tokensScale: 0.46,
    costScale: 0.54,
    offset: 2,
    sortOrder: 10,
    totalUsers: 186,
  },
  {
    key: 'claude-code',
    name: 'Claude Code',
    tokensScale: 0.37,
    costScale: 0.31,
    offset: 7,
    sortOrder: 20,
    totalUsers: 142,
  },
  {
    key: 'codex',
    name: 'Codex',
    tokensScale: 0.33,
    costScale: 0.28,
    offset: 10,
    sortOrder: 25,
    totalUsers: 128,
  },
  {
    key: 'qoder',
    name: 'Qoder',
    tokensScale: 0.24,
    costScale: 0.2,
    offset: 13,
    sortOrder: 40,
    totalUsers: 104,
  },
  {
    key: 'opencode',
    name: 'OpenCode',
    tokensScale: 0.2,
    costScale: 0.17,
    offset: 17,
    sortOrder: 50,
    totalUsers: 96,
  },
];

const MOCK_MODELS: readonly { tool: string; model: string }[] = [
  { tool: 'cursor', model: 'Claude Haiku 4.5' },
  { tool: 'cursor', model: 'claude-sonnet-4-6' },
  { tool: 'cursor', model: 'gemini-2-5-pro' },
  { tool: 'cursor', model: 'gpt-5' },
  { tool: 'cursor', model: 'grok-4.6' },
  { tool: 'claude-code', model: 'claude-fable-5' },
  { tool: 'claude-code', model: 'claude-sonnet-4-6' },
  { tool: 'claude-code', model: 'claude-opus-4' },
  { tool: 'claude-code', model: 'k3' },
  { tool: 'claude-code', model: 'k3-256k' },
  { tool: 'claude-code', model: 'MiniMax-M3' },
  { tool: 'codex', model: 'gpt-5.3-codex' },
  { tool: 'codex', model: 'gpt-5.2-codex' },
  { tool: 'codex', model: 'K2.7 Code' },
  { tool: 'codex', model: 'doubao-seed-2.1-turbo' },
  { tool: 'codex', model: 'mistral-large' },
  { tool: 'qoder', model: 'qwen3-coder' },
  { tool: 'qoder', model: 'deepseek-v3' },
  { tool: 'opencode', model: 'gpt-5' },
  { tool: 'opencode', model: 'claude-sonnet-4-6' },
  { tool: 'opencode', model: 'zai_auto' },
];

export function createMockLeaderboardOverview(
  range: LeaderboardRange,
  filters: { tool?: string; model?: string } = {},
): LeaderboardOverviewResponse {
  const toolProfile = filters.tool
    ? MOCK_TOOL_PROFILES.find((profile) => profile.key === filters.tool)
    : undefined;
  const modelOffset = filters.model ? hashOffset(filters.model) : 0;

  return {
    configured: true,
    range,
    days: RANGE_DAYS[range],
    limit: MOCK_LEADERBOARD_LIMIT,
    generatedAt: startOfToday().toISOString(),
    profiles: createMockUserProfiles(),
    global: {
      cost: createMockBoard(range, 'cost', toolProfile, modelOffset),
      tokens: createMockBoard(range, 'tokens', toolProfile, modelOffset),
    },
    tools: MOCK_TOOL_PROFILES.map((profile): ToolLeaderboard => ({
      tool: profile.key,
      displayName: profile.name,
      sortOrder: profile.sortOrder,
      costSupported: true,
      boards: {
        cost: createMockBoard(range, 'cost', profile, modelOffset),
        tokens: createMockBoard(range, 'tokens', profile, modelOffset),
      },
    })),
    filterOptions: {
      tools: MOCK_TOOL_PROFILES.map((profile) => ({
        key: profile.key,
        displayName: profile.name,
      })),
      models: MOCK_MODELS.map((item) => ({ ...item })),
    },
  };
}

function createMockBoard(
  range: LeaderboardRange,
  metric: LeaderboardMetric,
  profile?: MockToolProfile,
  modelOffset = 0,
): LeaderboardBoard {
  const rangeProfile = RANGE_PROFILES[range];
  const toolOffset = (profile?.offset ?? 0) + modelOffset;
  const ranked = MOCK_USERS.map((user, index) => {
    const tokenVariation = user.isCurrentUser
      ? rangeProfile.currentTokensScale
      : 0.8 +
        ((index * 7 + rangeProfile.seed * 3 + toolOffset) % 9) * 0.055;
    const costVariation = user.isCurrentUser
      ? rangeProfile.currentCostScale
      : 0.79 +
        ((index * 11 + rangeProfile.seed + toolOffset * 2) % 10) * 0.05;

    return {
      ...user,
      tokens: Math.round(
        user.tokens *
          rangeProfile.tokensScale *
          (profile?.tokensScale ?? 1) *
          tokenVariation,
      ),
      costUsd: Number(
        (
          user.costUsd *
          rangeProfile.costScale *
          (profile?.costScale ?? 1) *
          costVariation
        ).toFixed(2),
      ),
    };
  })
    .sort((left, right) => {
      const leftValue = metric === 'cost' ? left.costUsd : left.tokens;
      const rightValue = metric === 'cost' ? right.costUsd : right.tokens;
      if (rightValue !== leftValue) return rightValue - leftValue;
      return left.userHash.localeCompare(right.userHash);
    })
    .map((user, index): LeaderboardRow => ({ ...user, rank: index + 1 }));

  return {
    metric,
    totalUsers: participantCount(range, profile),
    rows: ranked.slice(0, MOCK_LEADERBOARD_LIMIT),
    currentUser: ranked.find((row) => row.isCurrentUser) ?? null,
  };
}

function hashOffset(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return (hash % 23) + 1;
}

function participantCount(
  range: LeaderboardRange,
  profile?: MockToolProfile,
): number {
  const base = profile?.totalUsers ?? 286;
  return Math.max(
    MOCK_LEADERBOARD_LIMIT,
    Math.round(base * RANGE_PROFILES[range].participantScale),
  );
}

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

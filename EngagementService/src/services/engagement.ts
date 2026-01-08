import type { EngagementEventBody } from "../schemas/engagement";

type Aggregate = {
  likes: number;
  views: number;
};

type EngagementStore = Map<string, Aggregate>;
type ProgressKey = `${string}:${string}`;

export type ContinueWatchProgress = {
  userId: string;
  episodeId: string;
  watchedDuration: number;
  totalDuration: number;
  lastWatchedAt: string | null;
  isCompleted: boolean;
};

type ContinueWatchInput = {
  userId: string;
  episodeId: string;
  watchedDuration: number;
  totalDuration: number;
  lastWatchedAt?: string | null;
  isCompleted?: boolean;
};

const store: EngagementStore = new Map();
const progressStore: Map<ProgressKey, ContinueWatchProgress> = new Map();

function getOrCreateAggregate(videoId: string): Aggregate {
  const existing = store.get(videoId);
  if (existing) {
    return existing;
  }
  const aggregate: Aggregate = { likes: 0, views: 0 };
  store.set(videoId, aggregate);
  return aggregate;
}

export function applyEngagementEvent(
  videoId: string,
  body: EngagementEventBody
): Aggregate {
  const aggregate = getOrCreateAggregate(videoId);
  switch (body.action) {
    case "like":
      aggregate.likes += 1;
      break;
    case "unlike":
      aggregate.likes = Math.max(0, aggregate.likes - 1);
      break;
    case "view":
      aggregate.views += 1;
      break;
    case "favorite":
      aggregate.likes += 1;
      break;
    default:
      break;
  }
  store.set(videoId, aggregate);
  return aggregate;
}

export function getAggregate(videoId: string): Aggregate {
  return { ...getOrCreateAggregate(videoId) };
}

function buildProgressKey(userId: string, episodeId: string): ProgressKey {
  return `${userId}:${episodeId}`;
}

export function upsertProgress(
  payload: ContinueWatchInput
): ContinueWatchProgress {
  const watchedDuration = Math.max(0, Math.floor(payload.watchedDuration));
  const totalDuration = Math.max(1, Math.floor(payload.totalDuration));
  const isCompleted =
    typeof payload.isCompleted === "boolean"
      ? payload.isCompleted
      : watchedDuration >= totalDuration;
  const lastWatchedAt = payload.lastWatchedAt ?? new Date().toISOString();

  const entry: ContinueWatchProgress = {
    userId: payload.userId,
    episodeId: payload.episodeId,
    watchedDuration,
    totalDuration,
    lastWatchedAt,
    isCompleted,
  };

  progressStore.set(buildProgressKey(payload.userId, payload.episodeId), entry);
  return { ...entry };
}

export function getProgressEntries(
  userId: string,
  episodeIds: readonly string[]
): ContinueWatchProgress[] {
  const entries: ContinueWatchProgress[] = [];
  episodeIds.forEach((episodeId) => {
    const existing = progressStore.get(buildProgressKey(userId, episodeId));
    if (existing) {
      entries.push({ ...existing });
    }
  });
  return entries;
}

export type { Aggregate };

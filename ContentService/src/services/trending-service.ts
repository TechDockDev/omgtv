import type { Redis } from "ioredis";

export type EngagementMetric = {
  contentId: string;
  score: number;
  likes?: number;
  views?: number;
  rating?: number;
};

export type TrendingServiceOptions = {
  trendingKey: string;
  ratingsKey: string;
  maxEntries?: number;
};

const DEFAULT_MAX_ENTRIES = 500;

export class TrendingService {
  private readonly trendingKey: string;
  private readonly ratingsKey: string;
  private readonly maxEntries: number;

  constructor(
    private readonly redis: Redis,
    options: TrendingServiceOptions
  ) {
    this.trendingKey = options.trendingKey;
    this.ratingsKey = options.ratingsKey;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  async applyMetrics(metrics: EngagementMetric[]): Promise<void> {
    if (metrics.length === 0) {
      return;
    }

    const pipeline = this.redis.multi();
    for (const metric of metrics) {
      pipeline.zadd(this.trendingKey, metric.score, metric.contentId);
      if (typeof metric.rating === "number") {
        pipeline.hset(
          this.ratingsKey,
          metric.contentId,
          metric.rating.toFixed(3)
        );
      }
    }

    pipeline.zremrangebyrank(this.trendingKey, 0, -(this.maxEntries + 1));

    await pipeline.exec();
  }

  async getScores(ids: readonly string[]): Promise<Map<string, number>> {
    if (ids.length === 0) {
      return new Map();
    }
    const scores = await this.redis.zmscore(this.trendingKey, ...ids);
    const result = new Map<string, number>();
    ids.forEach((id, index) => {
      const value = scores?.[index];
      if (typeof value === "number") {
        result.set(id, value);
      }
    });
    return result;
  }

  async getAverageRatings(
    ids: readonly string[]
  ): Promise<Map<string, number>> {
    if (ids.length === 0) {
      return new Map();
    }
    const ratings = await this.redis.hmget(this.ratingsKey, ...ids);
    const result = new Map<string, number>();
    ids.forEach((id, index) => {
      const value = ratings?.[index];
      if (value) {
        const parsed = Number.parseFloat(value);
        if (!Number.isNaN(parsed)) {
          result.set(id, parsed);
        }
      }
    });
    return result;
  }

  async getTopContentIds(limit: number): Promise<string[]> {
    if (limit <= 0) {
      return [];
    }
    return this.redis.zrevrange(this.trendingKey, 0, limit - 1);
  }
}

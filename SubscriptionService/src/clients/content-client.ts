import { loadConfig } from "../config";

export class ContentClient {
  private readonly baseUrl: string;
  private readonly serviceToken: string | undefined;

  constructor() {
    const config = loadConfig();
    this.baseUrl = config.CONTENT_SERVICE_URL;
    this.serviceToken = config.SERVICE_AUTH_TOKEN;
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.serviceToken) {
      h["authorization"] = `Bearer ${this.serviceToken}`;
    }
    return h;
  }

  async getEpisodeCoinCost(
    episodeId: string
  ): Promise<{ episodeId: string; title: string; coinCost: number | null }> {
    const res = await fetch(
      `${this.baseUrl}/internal/episodes/${episodeId}/coin-cost`,
      { headers: this.headers }
    );

    if (res.status === 404) {
      throw new Error(`Episode ${episodeId} not found`);
    }
    if (!res.ok) {
      throw new Error(`ContentService error: ${res.status}`);
    }

    return res.json() as Promise<{ episodeId: string; title: string; coinCost: number | null }>;
  }

  async getEpisodesBatch(
    episodeIds: string[]
  ): Promise<Array<{ id: string; title: string | null; thumbnail: string | null; seriesTitle: string | null }>> {
    if (!episodeIds.length) return [];

    const res = await fetch(`${this.baseUrl}/internal/episodes/batch-info`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ ids: episodeIds }),
    });

    if (!res.ok) return [];

    const data = await res.json() as { items: any[] };
    return (data.items ?? []).map((item: any) => ({
      id: item.id,
      title: item.title ?? null,
      thumbnail: item.thumbnail ?? null,
      seriesTitle: item.seriesTitle ?? null,
    }));
  }
}

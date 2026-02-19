
import { MobileAppService } from "./src/services/mobile-app-service";

// Mock Repository
const mockRepo = {
    getTopTenSeries: async () => ([
        {
            series: {
                id: "s_top10",
                title: "Top 10 Audio Series",
                isAudioSeries: true,
                category: { name: "Fiction" }
            }
        }
    ]),
    listCarouselEntries: async () => ([
        {
            position: 1,
            seriesId: "s_carousel",
            series: {
                id: "s_carousel",
                title: "Carousel Audio Series",
                isAudioSeries: true,
                category: { name: "Fiction" },
                heroImageUrl: "http://example.com/hero.jpg"
            }
        }
    ]),
    listHomeSeries: async () => ({
        items: [
            {
                id: "s_cat",
                title: "Category Audio Series",
                isAudioSeries: true,
                category: { name: "Fiction" },
                heroImageUrl: "http://example.com/cat.jpg",
                tags: ["audio"],
                releaseDate: new Date(),
                createdAt: new Date()
            }
        ],
        nextCursor: null
    })
} as any;

const mockConfig = {
    homeFeedLimit: 10,
    carouselLimit: 5,
    continueWatchLimit: 10,
    sectionItemLimit: 10,
    defaultPlanPurchased: true,
    defaultGuestCanWatch: true,
    streamingType: "HLS",
    reelsPageSize: 10,
};

const mockViewerCatalog = {
    getHomeSeries: async () => ({
        items: [
            {
                id: "s_cat",
                title: "Category Audio Series",
                series: {
                    id: "s_cat",
                    title: "Category Audio Series",
                    category: { name: "Fiction", slug: "fiction" },
                    isAudioSeries: true,
                    heroImageUrl: "http://example.com/cat.jpg"
                },
                tags: ["audio"],
                playback: { status: "READY", variants: [] },
                localization: { captions: [], availableLanguages: [] },
                ratings: { average: 4.5 },
                personalization: { reason: "recent" },
                durationSeconds: 0,
                publishedAt: new Date().toISOString()
            }
        ],
        nextCursor: null,
        fromCache: false
    })
} as any;

const mockEngagement = {
    getUserProgressList: async () => [],
    getUserState: async (params: any) => {
        const states: any = {};
        params.items.forEach((item: any) => {
            states[`${item.contentType}:${item.contentId}`] = {
                likeCount: 10,
                viewCount: 100,
                saveCount: 5,
                isLiked: true,
                isSaved: true,
                averageRating: 4.8,
                reviewCount: 15
            };
        });
        return states;
    }
} as any;

const service = new MobileAppService({
    viewerCatalog: mockViewerCatalog,
    repository: mockRepo,
    config: mockConfig as any,
    engagementClient: mockEngagement,
});

async function run() {
    console.log("Running Verification for Audio Series, Engagement, and Ratings...");
    const result = await service.getHomeExperience({}, { context: { userId: "user-123" } } as any);

    const data = result.data;

    // 1. Verify Carousel Engagement & Ratings
    console.log("Checking Carousel...");
    const carouselItem = data.carousel?.[0];
    if (carouselItem && carouselItem.engagement) {
        console.log("Carousel Engagement:", JSON.stringify(carouselItem.engagement, null, 2));
        if (carouselItem.engagement.averageRating === 4.8 && carouselItem.engagement.reviewCount === 15) {
            console.log("SUCCESS: Carousel item has rating data.");
        } else {
            console.error("FAIL: Carousel item rating data missing or incorrect.");
        }
    } else {
        console.error("FAIL: Carousel item or engagement missing.");
    }

    // 2. Verify Top 10 Engagement & Ratings
    console.log("Checking Top 10...");
    const top10Item = data.top10?.[0];
    if (top10Item && top10Item.engagement) {
        if (top10Item.engagement.averageRating === 4.8) {
            console.log("SUCCESS: Top 10 item has rating data.");
        } else {
            console.error("FAIL: Top 10 item rating data missing or incorrect.");
        }
    }

    // 3. Verify Categories (Sections) Engagement & Ratings
    console.log("Checking Sections...");
    const section = data.sections.find(s => s.title === "Fiction");
    const sectionItem = section?.items[0];
    if (sectionItem && sectionItem.engagement) {
        if (sectionItem.engagement.averageRating === 4.8) {
            console.log("SUCCESS: Section item has rating data.");
        } else {
            console.error("FAIL: Section item rating data missing or incorrect.");
        }
    }

    // 4. Verify Audio Series Inclusion
    if (carouselItem?.is_audio_series && top10Item?.is_audio_series && sectionItem?.is_audio_series) {
        console.log("SUCCESS: is_audio_series flag is set correctly.");
    } else {
        console.error("FAIL: is_audio_series flag missing or incorrect.");
    }
}

run().catch(err => {
    console.error("Verification script failed:", err);
    process.exit(1);
});

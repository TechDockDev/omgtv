
import { MobileAppService } from "./src/services/mobile-app-service";
import { ViewerCatalogService } from "./src/services/viewer-catalog-service";

// Mock Dependencies
const mockRepo = {
    getTopTenSeries: async () => ([{
        series: { id: "s1", title: "Top 1", isAudioSeries: false }
    }]),
    listCarouselEntries: async () => []
} as any;

const mockConfig = {
    homeFeedLimit: 10,
    carouselLimit: 5,
    continueWatchLimit: 10,
    sectionItemLimit: 10,
    defaultPlanPurchased: false,
    defaultGuestCanWatch: false,
    streamingType: "hls",
    reelsPageSize: 10,
};

const mockViewerCatalog = {
    getHomeSeries: async () => ({
        items: [
            {
                id: "ep1",
                title: "Episode 1",
                tags: ["popular"],
                series: {
                    id: "s2",
                    title: "Action Series",
                    category: { name: "Action", slug: "action" },
                    isAudioSeries: false
                },
                playback: { status: "READY", variants: [] },
                localization: { captions: [], availableLanguages: [] },
                ratings: { average: 5 },
                personalization: { reason: "recent" },
                durationSeconds: 100
            },
            {
                id: "ep2",
                title: "Episode 2",
                tags: ["popular"],
                series: {
                    id: "s3",
                    title: "Drama Series",
                    category: { name: "Drama", slug: "drama" },
                    isAudioSeries: true
                },
                playback: { status: "READY", variants: [] },
                localization: { captions: [], availableLanguages: [] },
                ratings: { average: 4 },
                personalization: { reason: "recent" },
                durationSeconds: 100
            }
        ],
        nextCursor: null,
        fromCache: false
    }),
    getEpisodesBatch: async () => []
} as unknown as ViewerCatalogService;

const mockEngagement = {
    getUserProgressList: async () => [],
    getUserState: async () => ({}),
} as any;

const mockSubscription = {
    checkEntitlement: async () => ({ canWatch: true, planPurchased: false }),
} as any;

const service = new MobileAppService({
    viewerCatalog: mockViewerCatalog,
    repository: mockRepo,
    config: mockConfig,
    engagementClient: mockEngagement,
    subscriptionClient: mockSubscription,
});

async function run() {
    console.log("Testing with tag='popular'...");
    const result = await service.getHomeExperience({ tag: "popular" }); // No user context, so no continue watch

    console.log("Top 10 Length:", result.data.top10?.length);
    console.log("Carousel Length:", result.data.carousel?.length);
    console.log("Sections:", JSON.stringify(result.data.sections, null, 2));

    let failed = false;

    if (result.data.top10 && result.data.top10.length > 0) {
        console.error("FAIL: Top 10 should be empty when tag is present");
        failed = true;
    }

    const sectionCategories = result.data.sections.map(s => s.title);
    if (!sectionCategories.includes("Action") || !sectionCategories.includes("Drama")) {
        console.error("FAIL: Should contain categories 'Action' and 'Drama', but got:", sectionCategories);
        failed = true;
    }

    if (failed) {
        process.exit(1);
    } else {
        console.log("SUCCESS: Behavior matches expectations.");
    }
}

run();

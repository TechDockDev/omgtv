export interface FunnelStepDef {
  event: string;
  label: string;
  properties?: { key: string; value: string | number | boolean; operator: string; type: string }[];
}

export interface FunnelDef {
  id: string;
  name: string;
  conversionWindowInterval: number;
  conversionWindowUnit: "day" | "hour" | "minute";
  steps: FunnelStepDef[];
}

export const FUNNELS: Record<string, FunnelDef> = {
  activation: {
    id: "activation",
    name: "Activation",
    conversionWindowInterval: 7,
    conversionWindowUnit: "day",
    steps: [
      { event: "app_first_open",          label: "App First Open" },
      { event: "splash_shown",            label: "Splash seen" },
      { event: "otp_requested",           label: "OTP requested" },
      { event: "auth_otp_screen_shown",   label: "OTP screen seen" },
      { event: "auth_otp_verified",       label: "OTP verified" },
      { event: "first_time_register",     label: "Registered" },
      { event: "paywall_shown",           label: "Paywall shown" },
    ],
  },
  "paywall-conversion": {
    id: "paywall-conversion",
    name: "Paywall → Conversion",
    conversionWindowInterval: 7,
    conversionWindowUnit: "day",
    steps: [
      { event: "paywall_shown",                  label: "Paywall shown" },
      { event: "paywall_cta_clicked",            label: "Paywall CTA clicked" },
      { event: "razorpay_checkout_opened",       label: "Razorpay checkout opened" },
      { event: "trial_started",                  label: "Trial started" },
      { event: "trial_activated",                label: "Trial activated" },
      { event: "first_subscription_purchased",   label: "First subscription purchased" },
    ],
  },
  "video-engagement": {
    id: "video-engagement",
    name: "Video Engagement",
    conversionWindowInterval: 1,
    conversionWindowUnit: "day",
    steps: [
      { event: "video_started",   label: "Video started" },
      {
        event: "video_progress", label: "Reached 25%",
        properties: [{ key: "percent", value: 25, operator: "exact", type: "event" }],
      },
      {
        event: "video_progress", label: "Reached 50%",
        properties: [{ key: "percent", value: 50, operator: "exact", type: "event" }],
      },
      {
        event: "video_progress", label: "Reached 75%",
        properties: [{ key: "percent", value: 75, operator: "exact", type: "event" }],
      },
      {
        event: "video_progress", label: "Reached 95%",
        properties: [{ key: "percent", value: 95, operator: "exact", type: "event" }],
      },
      { event: "video_completed", label: "Completed" },
    ],
  },
  "episode-paywall": {
    id: "episode-paywall",
    name: "Episode Hard-Paywall",
    conversionWindowInterval: 1,
    conversionWindowUnit: "day",
    steps: [
      { event: "video_started",                        label: "Video started" },
      { event: "episode_paywall_position_reached",     label: "Hit paywall position" },
      { event: "paywall_shown",                        label: "Paywall shown" },
      { event: "paywall_cta_clicked",                  label: "Paywall CTA clicked" },
    ],
  },
  "audio-engagement": {
    id: "audio-engagement",
    name: "Audio Engagement",
    conversionWindowInterval: 1,
    conversionWindowUnit: "day",
    steps: [
      { event: "audio_series_grid_viewed",           label: "Audio grid viewed" },
      { event: "audio_story_playback_started",       label: "Playback started" },
      { event: "audio_background_playback_started",  label: "Background playback started" },
    ],
  },
  search: {
    id: "search",
    name: "Search",
    conversionWindowInterval: 1,
    conversionWindowUnit: "hour",
    steps: [
      { event: "search_query_submitted",  label: "Search submitted" },
      { event: "search_result_clicked",   label: "Result clicked" },
    ],
  },
};

export const FUNNEL_IDS = Object.keys(FUNNELS);

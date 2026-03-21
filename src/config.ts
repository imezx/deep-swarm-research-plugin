import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
  .field(
    "researchDepth",
    "select",
    {
      displayName: "Research Depth",
      subtitle: "Controls how many adaptive rounds run after the initial swarm",
      options: [
        {
          value: "shallow",
          displayName: "Shallow — 1 round, ~8 sources, fast",
        },
        {
          value: "standard",
          displayName: "Standard — 2 rounds, ~15 sources (recommended)",
        },
        {
          value: "deep",
          displayName: "Deep — 3 rounds, ~25 sources, thorough",
        },
      ],
    },
    "standard",
  )
  .field(
    "maxSourcesTotal",
    "numeric",
    {
      displayName: "Max Sources Total",
      subtitle:
        "Hard cap on total pages read across all workers and rounds (8-30)",
      min: 8,
      max: 30,
      int: true,
      slider: { step: 1, min: 8, max: 30 },
    },
    15,
  )
  .field(
    "contentLimitPerPage",
    "numeric",
    {
      displayName: "Content Per Page (chars)",
      subtitle:
        "Characters extracted per page. Higher = richer but slower (1000-10000)",
      min: 1000,
      max: 10000,
      int: true,
      slider: { step: 500, min: 1000, max: 10000 },
    },
    4000,
  )
  .field(
    "enableLinkFollowing",
    "select",
    {
      displayName: "Link Following",
      subtitle:
        "Depth and Academic workers follow relevant in-page links (like citations)",
      options: [
        { value: "on", displayName: "On — follow top links (recommended)" },
        { value: "off", displayName: "Off — search results only" },
      ],
    },
    "on",
  )
  .field(
    "enableAIPlanning",
    "select",
    {
      displayName: "AI Query Planning",
      subtitle:
        "Use the loaded model for smarter queries, dynamic decomposition, and synthesis",
      options: [
        { value: "on", displayName: "On — AI-powered (best quality)" },
        {
          value: "off",
          displayName: "Off — dimension-based fallback (faster start)",
        },
      ],
    },
    "on",
  )
  .field(
    "safeSearch",
    "select",
    {
      displayName: "Safe Search",
      options: [
        { value: "strict", displayName: "Strict" },
        { value: "moderate", displayName: "Moderate" },
        { value: "off", displayName: "Off" },
      ],
    },
    "moderate",
  )
  .build();

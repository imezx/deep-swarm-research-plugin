import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
  .field(
    "researchDepth",
    "select",
    {
      displayName: "Research Depth",
      subtitle:
        "Controls rounds, per-worker budgets, queries, and link-following aggressiveness. " +
        "Sources are collected adaptively with no hard cap — deeper = more sources.",
      options: [
        {
          value: "shallow",
          displayName: "Shallow — 1 round, ~10-25 sources, fast",
        },
        {
          value: "standard",
          displayName: "Standard — 3 rounds, ~30-60 sources (recommended)",
        },
        {
          value: "deep",
          displayName: "Deep — 5 rounds, ~60-120 sources, thorough",
        },
        {
          value: "deeper",
          displayName: "Deeper — 10 rounds, ~100-200+ sources, very thorough",
        },
        {
          value: "exhaustive",
          displayName: "Exhaustive — 15 rounds, 200+ sources, maximum depth",
        },
      ],
    },
    "standard",
  )
  .field(
    "contentLimitPerPage",
    "numeric",
    {
      displayName: "Content Per Page (chars)",
      subtitle:
        "Characters extracted per page. Higher = richer but slower. " +
        "Leave at default to auto-scale with depth preset (1000-20000)",
      min: 1000,
      max: 20000,
      int: true,
      slider: { step: 1000, min: 1000, max: 20000 },
    },
    4000,
  )
  .field(
    "enableLinkFollowing",
    "select",
    {
      displayName: "Link Following",
      subtitle:
        "Workers follow relevant in-page links (like citations and references)",
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

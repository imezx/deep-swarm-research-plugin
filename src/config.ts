/**
 * @file config.ts
 * Plugin config schematics.
 * contentLimitPerPage stays NUMERIC (v1 stored a number; a select of strings
 * failed validation against persisted values). 0 = Auto → depth-scaled limit.
 */
import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
  .field("researchDepth", "select", {
    displayName: "Research Depth",
    subtitle:
      "Controls rounds, crawler count, page budget, engine mix, and synthesis size.",
    options: [
      { value: "shallow", displayName: "Shallow" },
      { value: "standard", displayName: "Standard" },
      { value: "deep", displayName: "Deep" },
      { value: "deeper", displayName: "Deeper" },
      { value: "exhaustive", displayName: "Exhaustive" },
    ],
  }, "standard")
  .field("contentLimitPerPage", "numeric", {
    displayName: "Content Per Page",
    subtitle:
      "Extracted chars per page. 0 = Auto (scales with depth, 5K–16K). " +
      "Set 1000–20000 to pin a fixed value.",
    min: 0,
    max: 20000,
    step: 1000,
  }, 0)
  .field("researchTimeoutMinutes", "numeric", {
    displayName: "Research Time Limit (minutes)",
    subtitle:
      "Hard wall-clock limit per research run. When hit, crawling and AI steps " +
      "stop immediately and partial results are returned. 0 = no limit.",
    min: 0,
    max: 120,
    step: 1,
  }, 10)
  .field("searxngBaseUrl", "string", {
    displayName: "SearXNG Base URL",
    subtitle:
      "Optional. Your SearXNG instance (e.g. http://localhost:8888) used as the " +
      "primary general-web engine instead of DDG/Brave scrapes. Requires " +
      "'formats: [html, json]' in the instance's settings.yml. Leave empty to disable.",
  }, "")
  .field("enableLinkFollowing", "select", {
    displayName: "Link Following",
    subtitle: "Fetch promising in-page references beyond search results.",
    options: [
      { value: "on", displayName: "On" },
      { value: "off", displayName: "Off" },
    ],
  }, "on")
  .field("enableAIPlanning", "select", {
    displayName: "AI Planning & Synthesis",
    subtitle: "Use the loaded model for query decomposition, narrative synthesis, and contradiction detection.",
    options: [
      { value: "on", displayName: "On" },
      { value: "off", displayName: "Off" },
    ],
  }, "on")
  .field("safeSearch", "select", {
    displayName: "Safe Search",
    subtitle: "Applies to scraped web engines.",
    options: [
      { value: "strict", displayName: "Strict" },
      { value: "moderate", displayName: "Moderate" },
      { value: "off", displayName: "Off" },
    ],
  }, "moderate")
  .field("enableLocalSources", "select", {
    displayName: "Local Document Sources",
    subtitle: "Search your indexed local collections before/alongside the web.",
    options: [
      { value: "off", displayName: "Off" },
      { value: "on", displayName: "On" },
    ],
  }, "off")
  .build();

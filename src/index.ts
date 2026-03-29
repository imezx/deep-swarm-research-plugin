/**
 * @file index.ts
 * LM Studio plugin entry point.
 */

import { PluginContext, ChatMessage } from "@lmstudio/sdk";
import { configSchematics } from "./config";
import { toolsProvider } from "./toolsProvider";

export async function main(context: PluginContext): Promise<void> {
  context.withConfigSchematics(configSchematics);
  context.withToolsProvider(toolsProvider);
  context.withPromptPreprocessor(async (_ctl, userMessage) => {
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const timeStr = now.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    });
    const modified = ChatMessage.from(userMessage);
    const original = userMessage.getText();
    modified.replaceText(
      `[Current date and time: ${dateStr}, ${timeStr}]\n\n${original}`,
    );
    return modified;
  });
}

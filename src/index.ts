/**
 * @file index.ts
 * LM Studio plugin entry point.
 */

import { PluginContext } from "@lmstudio/sdk";
import { configSchematics } from "./config";
import { toolsProvider } from "./toolsProvider";

export async function main(context: PluginContext): Promise<void> {
  context.withConfigSchematics(configSchematics);
  context.withToolsProvider(toolsProvider);
}

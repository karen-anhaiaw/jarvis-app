#!/usr/bin/env node
// Test script: verify DeepSeek provider can be created and session can be initialized

import { createDeepSeekProvider } from "./app/src/ai/deepseek/provider.js";

const config = {
  getTools: () => [],
  getBasePrompt: () => "You are a helpful assistant.",
  getCoreContext: () => [],
  getPluginInstructions: () => [],
  getPluginContext: () => [],
  getInstructions: () => ({ content: "", filename: "" }),
};

console.log("🧪 Testing DeepSeek provider creation...");

try {
  const provider = createDeepSeekProvider(config);
  console.log(`✅ Provider created: ${provider.name}`);
  console.log(`✅ Factory available: ${!!provider.factory}`);
  console.log(`✅ Metrics HUD available: ${!!provider.metricsPiece}`);

  // Try creating a session
  const session = provider.factory.create({ label: "test-session" });
  console.log(`✅ Session created: ${session.sessionId}`);

  // Check session implements AISession interface
  console.log(`✅ Session has sendAndStream: ${typeof (session as any).sendAndStream === "function"}`);
  console.log(`✅ Session has continueAndStream: ${typeof (session as any).continueAndStream === "function"}`);
  console.log(`✅ Session has getMessages: ${typeof (session as any).getMessages === "function"}`);

  console.log("\n✅ All tests passed!");
  process.exit(0);
} catch (err) {
  console.error("❌ Error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}

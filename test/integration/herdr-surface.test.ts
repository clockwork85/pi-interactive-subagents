/**
 * Live Herdr surface smoke test.
 *
 * Run from a Herdr-managed pane:
 *   node --test test/integration/herdr-surface.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  closeSurface,
  createSurface,
  isHerdrAvailable,
  pollForExit,
  readScreen,
  sendCommand,
} from "../../pi-extension/subagents/tmux.ts";

const describeHerdr = isHerdrAvailable() ? describe : describe.skip;

describeHerdr("Herdr surface", { timeout: 60_000 }, () => {
  it("splits beside the parent, runs a command, reads its sentinel, and closes", async () => {
    const surface = createSurface("herdr-smoke");
    try {
      assert.match(surface, /^w[^:]+:p[^:]+$/);
      await new Promise((resolve) => setTimeout(resolve, 500));

      sendCommand(surface, "read -r line; printf 'STEERED_%s\\n' \"$line\"");
      await new Promise((resolve) => setTimeout(resolve, 100));
      sendCommand(surface, "hello-from-parent");

      let steeredScreen = "";
      for (let attempt = 0; attempt < 20; attempt++) {
        steeredScreen = readScreen(surface, 20);
        if (steeredScreen.includes("STEERED_hello-from-parent")) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.match(steeredScreen, /STEERED_hello-from-parent/);

      sendCommand(surface, "printf '__SUBAGENT_DONE_0__\\n'");
      const result = await pollForExit(surface, new AbortController().signal, { interval: 50 });
      assert.equal(result.reason, "sentinel");
      assert.equal(result.exitCode, 0);
      assert.match(readScreen(surface, 20), /__SUBAGENT_DONE_0__/);
    } finally {
      closeSurface(surface);
    }
  });
});

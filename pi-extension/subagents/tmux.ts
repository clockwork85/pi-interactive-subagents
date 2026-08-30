/**
 * Terminal surface layer for Herdr and tmux.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create/split a pane, type a command into it, read its screen, close
 * it, and poll for exit. Herdr is preferred when both environments are
 * present. The filename remains `tmux.ts` for compatibility with existing
 * imports and downstream tests.
 *
 * Herdr panes use stable ids such as `w1:p2` and are always targeted from the
 * parent Pi pane in `$HERDR_PANE_ID`. tmux panes use ids such as `%12` and
 * target `$TMUX_PANE`.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

type MuxBackend = "herdr" | "tmux";

/** True when running inside Herdr with the Herdr CLI on PATH. */
export function isHerdrAvailable(): boolean {
  return process.env.HERDR_ENV === "1" && !!process.env.HERDR_PANE_ID && hasCommand("herdr");
}

/** True when running inside tmux with the tmux binary on PATH. */
export function isTmuxAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

export function isMuxAvailable(): boolean {
  return isHerdrAvailable() || isTmuxAvailable();
}

export function muxSetupHint(): string {
  return "Start Pi inside Herdr, or inside tmux if Herdr is unavailable.";
}

function requireMux(): MuxBackend {
  if (isHerdrAvailable()) return "herdr";
  if (isTmuxAvailable()) return "tmux";
  throw new Error(`A supported terminal multiplexer is required for subagents. ${muxSetupHint()}`);
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

interface HerdrPaneResponse {
  result?: {
    pane?: {
      pane_id?: unknown;
    };
  };
}

function parseHerdrPaneId(raw: string): string {
  let payload: HerdrPaneResponse;
  try {
    payload = JSON.parse(raw) as HerdrPaneResponse;
  } catch {
    throw new Error(`Unexpected Herdr pane response: ${raw.trim() || "(empty)"}`);
  }
  const paneId = payload.result?.pane?.pane_id;
  if (typeof paneId !== "string" || !/^w[^:]+:p[^:]+$/.test(paneId)) {
    throw new Error(`Herdr response did not contain a valid pane id: ${raw.trim()}`);
  }
  return paneId;
}

function herdrDirection(direction: "left" | "right" | "up" | "down"): "right" | "down" {
  return direction === "left" || direction === "right" ? "right" : "down";
}

function requireHerdrParentPane(fromSurface?: string): string {
  const pane = fromSurface ?? process.env.HERDR_PANE_ID;
  if (!pane) {
    throw new Error("HERDR_PANE_ID is missing; cannot target the parent Pi pane.");
  }
  return pane;
}

export const __surfaceTest__ = { parseHerdrPaneId, herdrDirection };

// ── Pane layout ──

/**
 * tmux layout applied to the subagent window to keep panes evenly sized.
 * Switchable: "even-horizontal" (equal columns, matches Ctrl+b Alt+1),
 * "main-vertical" (big main pane + tiled column), "tiled" (grid).
 */
const SUBAGENT_TMUX_LAYOUT = "even-horizontal";

let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-balance subagent panes so repeated splits don't leave them lopsided.
 * tmux halves the target pane on every split and dumps freed space onto a
 * neighbor on close, so without this panes drift to wildly uneven widths.
 * Applies SUBAGENT_TMUX_LAYOUT to the parent pi window. Debounced so a burst
 * of parallel spawns or staggered exits collapses into a single layout call,
 * and non-fatal: a cosmetic resize must never break spawning or watching.
 */
function rebalanceSurfaces(hintPane?: string): void {
  // Prefer the parent pi pane (stable; survives a closing subagent pane).
  const target = process.env.TMUX_PANE ?? hintPane;
  if (!target) return;
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    try {
      // -t <pane> resolves to that pane's window; does not change focus.
      execFileSync("tmux", ["select-layout", "-t", target, SUBAGENT_TMUX_LAYOUT], {
        encoding: "utf8",
      });
    } catch {
      // Pane/window may be gone; balancing is best-effort.
    }
  }, 120);
}

// ── Surface primitives ──

/** Create a right-hand pane beside the parent Pi pane without stealing focus. */
export function createSurface(name: string): string {
  const parentPane = isHerdrAvailable() ? process.env.HERDR_PANE_ID : process.env.TMUX_PANE;
  return createSurfaceSplit(name, "right", parentPane);
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Herdr currently exposes right/down splits; left/up requests preserve their
 * axis and use right/down respectively. Returns an opaque backend pane id.
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  const backend = requireMux();

  if (backend === "herdr") {
    const parentPane = requireHerdrParentPane(fromSurface);
    const args = [
      "pane",
      "split",
      "--pane",
      parentPane,
      "--direction",
      herdrDirection(direction),
      "--cwd",
      process.cwd(),
      "--no-focus",
    ];
    const raw = execFileSync("herdr", args, { encoding: "utf8" });
    const pane = parseHerdrPaneId(raw);
    try {
      execFileSync("herdr", ["pane", "rename", pane, name], { encoding: "utf8" });
    } catch {
      // A cosmetic pane label must never make spawning fail.
    }
    return pane;
  }

  void name; // tmux panes are not named; the Pi process supplies its own title.

  const args = ["split-window", "-d"];
  if (direction === "left" || direction === "right") {
    args.push("-h");
  } else {
    args.push("-v");
  }
  if (direction === "left" || direction === "up") {
    args.push("-b");
  }
  if (fromSurface) {
    args.push("-t", fromSurface);
  }
  args.push("-P", "-F", "#{pane_id}");

  const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux split-window output: ${pane}`);
  }

  rebalanceSurfaces(pane);
  return pane;
}

/**
 * Send a command string to a pane and execute it.
 * Typed literally (`-l`) so special characters are not interpreted as keys,
 * then submitted with Enter.
 */
export function sendCommand(surface: string, command: string): void {
  const backend = requireMux();
  if (backend === "herdr") {
    execFileSync("herdr", ["pane", "run", surface, command], { encoding: "utf8" });
    return;
  }
  execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
  execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  const backend = requireMux();
  if (backend === "herdr") {
    return execFileSync(
      "herdr",
      ["pane", "read", surface, "--source", "recent-unwrapped", "--lines", String(Math.max(1, lines))],
      { encoding: "utf8" },
    );
  }
  return execFileSync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    {
      encoding: "utf8",
    },
  );
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  const backend = requireMux();
  if (backend === "herdr") {
    const { stdout } = await execFileAsync(
      "herdr",
      ["pane", "read", surface, "--source", "recent-unwrapped", "--lines", String(Math.max(1, lines))],
      { encoding: "utf8" },
    );
    return stdout;
  }
  const { stdout } = await execFileAsync(
    "tmux",
    ["capture-pane", "-p", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
  return stdout;
}

/**
 * Read the small bottom-of-terminal snapshot used for completion sentinels.
 * Herdr's `recent-unwrapped` source preserves viewport padding, so asking for
 * only five rows can return blank lines while the sentinel is still visible.
 * Its `detection` source is purpose-built for bottom-buffer state checks.
 */
async function readSentinelScreenAsync(surface: string, lines = 5): Promise<string> {
  const backend = requireMux();
  if (backend === "herdr") {
    const { stdout } = await execFileAsync(
      "herdr",
      ["pane", "read", surface, "--source", "detection", "--lines", String(Math.max(1, lines))],
      { encoding: "utf8" },
    );
    return stdout;
  }
  return readScreenAsync(surface, lines);
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  const backend = requireMux();
  if (backend === "herdr") {
    execFileSync("herdr", ["pane", "close", surface], { encoding: "utf8" });
    return;
  }
  execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
  rebalanceSurfaces();
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readSentinelScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

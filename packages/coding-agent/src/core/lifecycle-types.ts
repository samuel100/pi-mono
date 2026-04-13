/**
 * Re-export consumer-facing lifecycle types from @mariozechner/pi-local.
 * These were moved to pi-local to make the package reusable by other consumers
 * (OpenClaw, etc.) without depending on coding-agent.
 */
export type { ModelLifecycleInfo, ModelLifecycleProvider } from "@mariozechner/pi-local";

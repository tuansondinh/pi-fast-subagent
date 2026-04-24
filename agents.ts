/**
 * Agent discovery — reads .md files from user + project agent directories.
 * Compatible with pi-subagents frontmatter format.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

/**
 * tools frontmatter semantics:
 *   unset        → all builtins + all parent extensions — DEFAULT
 *   `all`        → all builtins + all parent extensions (web_search, fetch_content, mcp, …)
 *   `builtins`   → built-in coding tools only (read, bash, edit, write, grep, find, ls)
 *   `none`       → no tools at all
 *   comma list   → allowlist; extensions auto-loaded if any listed tool is non-builtin
 *
 * Represented as:
 *   "builtins"   → only built-in coding tools
 *   "all"        → everything (default)
 *   "none"       → no tools
 *   string[]     → allowlist
 */
export type AgentTools = "builtins" | "all" | "none" | string[];

export const BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

export interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  tools: AgentTools;
  /** Number of nested subagent generations this agent may spawn. Default: 0. */
  maxDepth: number;
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
}

const BUILTIN_TOOLS = new Set<string>(BUILTIN_TOOL_NAMES);

export function agentNeedsExtensions(tools: AgentTools): boolean {
  if (tools === "all") return true;
  if (tools === "builtins" || tools === "none") return false;
  return tools.some((t) => !BUILTIN_TOOLS.has(t));
}

// Default: all tools, matching pi-subagents behavior. Agents opt into lean mode
// with `tools: builtins` or explicit built-in allowlists.
export function parseToolsField(raw: unknown): AgentTools {
  if (raw === undefined || raw === null) return "all";
  const str = String(raw).trim();
  if (!str) return "all";
  const lower = str.toLowerCase();
  if (lower === "all") return "all";
  if (lower === "none") return "none";
  if (lower === "builtins" || lower === "builtin") return "builtins";
  const list = str.split(",").map((t) => t.trim()).filter(Boolean);
  return list.length ? list : "all";
}

export function parseMaxDepthField(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
  if (!fs.existsSync(dir)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AgentConfig[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const filePath = path.join(dir, entry.name);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
      if (!frontmatter?.name || !frontmatter?.description) continue;
      const tools = parseToolsField(frontmatter.tools);
      const maxDepth = parseMaxDepthField(
        frontmatter.maxDepth ?? frontmatter.max_depth ?? frontmatter.depth ?? frontmatter.subagentDepth,
      );
      agents.push({
        name: frontmatter.name,
        description: frontmatter.description,
        model: frontmatter.model,
        tools,
        maxDepth,
        systemPrompt: body.trim(),
        source,
        filePath,
      });
    } catch {
      // skip malformed files
    }
  }
  return agents;
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    const candidate = path.join(dir, ".pi", "agents");
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {}
    // Also support legacy .agents/ dir
    const legacy = path.join(dir, ".agents");
    try {
      if (fs.statSync(legacy).isDirectory()) return legacy;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function discoverAgents(cwd: string): AgentConfig[] {
  const agentMap = new Map<string, AgentConfig>();

  // Bundled package agents (lowest priority)
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundledDir = path.join(here, "agents");
  for (const agent of loadAgentsFromDir(bundledDir, "user")) {
    agentMap.set(agent.name, { ...agent, source: "user" });
  }

  // User agents override bundled agents
  const userDir = path.join(getAgentDir(), "agents");
  for (const agent of loadAgentsFromDir(userDir, "user")) {
    agentMap.set(agent.name, agent);
  }

  // Project agents override user agents
  const projectDir = findNearestProjectAgentsDir(cwd);
  if (projectDir) {
    for (const agent of loadAgentsFromDir(projectDir, "project")) {
      agentMap.set(agent.name, agent);
    }
  }

  return Array.from(agentMap.values());
}

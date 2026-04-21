/**
 * Agent discovery — reads .md files from user + project agent directories.
 * Compatible with pi-subagents frontmatter format.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

export interface AgentConfig {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  systemPrompt: string;
  source: "user" | "project";
  filePath: string;
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
      const rawTools = frontmatter.tools;
      const tools = rawTools?.split(",").map((t: string) => t.trim()).filter(Boolean);
      agents.push({
        name: frontmatter.name,
        description: frontmatter.description,
        model: frontmatter.model,
        tools: tools?.length ? tools : undefined,
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

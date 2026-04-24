/**
 * Pooled ResourceLoader for subagent sessions.
 *
 * Loading the full extension/resource graph is expensive, so each unique
 * (cwd, agentDir, noExtensions) tuple is warmed once and the underlying
 * loader is reused across subagent runs. The pool is intentionally simple:
 * one-loader-per-tuple with a FIFO idle queue.
 */

import { DefaultResourceLoader } from "@mariozechner/pi-coding-agent";
import type { ResourceLoader } from "@mariozechner/pi-coding-agent";

type DefaultResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];

/** Minimum surface the pool needs from a loader. */
export interface PoolableLoader extends ResourceLoader {
  reload(): Promise<void>;
}

export type LoaderFactory = (options: DefaultResourceLoaderOptions) => PoolableLoader;

interface LoaderPoolEntry {
  idle: PoolableLoader[];
  active: Set<PoolableLoader>;
  warming: Set<Promise<void>>;
}

export interface LoaderLease {
  loader: ResourceLoader;
  release: () => void;
}

export class AgentPromptResourceLoader implements ResourceLoader {
  constructor(
    private readonly base: ResourceLoader,
    private readonly systemPromptOverride: string | undefined,
  ) {}

  getExtensions() { return this.base.getExtensions(); }
  getSkills() { return this.base.getSkills(); }
  getPrompts() { return this.base.getPrompts(); }
  getThemes() { return this.base.getThemes(); }
  getAgentsFiles() { return this.base.getAgentsFiles(); }
  getSystemPrompt() { return this.systemPromptOverride ?? this.base.getSystemPrompt(); }
  getAppendSystemPrompt() { return this.base.getAppendSystemPrompt(); }
  extendResources(paths: Parameters<ResourceLoader["extendResources"]>[0]): void {
    this.base.extendResources(paths);
  }
  reload(): Promise<void> { return this.base.reload(); }
}

export function makeLoaderOptions(
  cwd: string,
  agentDir: string,
  noExtensions: boolean,
): DefaultResourceLoaderOptions {
  return {
    cwd,
    agentDir,
    noExtensions,
    noContextFiles: true,
    noSkills: true,
  };
}

export class LoaderPool {
  private entries = new Map<string, LoaderPoolEntry>();

  constructor(
    private readonly factory: LoaderFactory = (opts) => new DefaultResourceLoader(opts) as PoolableLoader,
  ) {}

  private key(cwd: string, agentDir: string, noExtensions: boolean): string {
    return `${cwd}\0${agentDir}\0${noExtensions ? "noext" : "ext"}`;
  }

  private getEntry(cwd: string, agentDir: string, noExtensions: boolean): LoaderPoolEntry {
    const k = this.key(cwd, agentDir, noExtensions);
    let entry = this.entries.get(k);
    if (!entry) {
      entry = { idle: [], active: new Set(), warming: new Set() };
      this.entries.set(k, entry);
    }
    return entry;
  }

  isWarm(cwd: string, agentDir: string, noExtensions: boolean): boolean {
    const entry = this.entries.get(this.key(cwd, agentDir, noExtensions));
    return !!entry && entry.idle.length > 0;
  }

  async acquire(
    cwd: string,
    agentDir: string,
    noExtensions: boolean,
    systemPromptOverride: string | undefined,
  ): Promise<LoaderLease> {
    const entry = this.getEntry(cwd, agentDir, noExtensions);

    while (true) {
      const cached = entry.idle.pop();
      if (cached) {
        entry.active.add(cached);
        let released = false;
        return {
          loader: new AgentPromptResourceLoader(cached, systemPromptOverride),
          release: () => {
            if (released) return;
            released = true;
            entry.active.delete(cached);
            entry.idle.push(cached);
          },
        };
      }

      const warming = entry.warming.values().next().value as Promise<void> | undefined;
      if (warming) {
        await warming;
        continue;
      }

      const loader = this.factory(makeLoaderOptions(cwd, agentDir, noExtensions));
      const warmPromise = loader
        .reload()
        .then(() => {
          entry.idle.push(loader);
        })
        .finally(() => {
          entry.warming.delete(warmPromise);
        });
      entry.warming.add(warmPromise);
      await warmPromise;
    }
  }

  warm(cwd: string, agentDir: string, noExtensions: boolean): void {
    const entry = this.getEntry(cwd, agentDir, noExtensions);
    if (entry.idle.length > 0 || entry.active.size > 0 || entry.warming.size > 0) return;
    const loader = this.factory(makeLoaderOptions(cwd, agentDir, noExtensions));
    const warmPromise = loader
      .reload()
      .then(() => {
        entry.idle.push(loader);
      })
      .catch(() => {
        /* ignore warm failures; foreground call reports real error */
      })
      .finally(() => {
        entry.warming.delete(warmPromise);
      });
    entry.warming.add(warmPromise);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Test-only inspection helpers. */
  _sizes(cwd: string, agentDir: string, noExtensions: boolean): { idle: number; active: number; warming: number } {
    const entry = this.entries.get(this.key(cwd, agentDir, noExtensions));
    if (!entry) return { idle: 0, active: 0, warming: 0 };
    return { idle: entry.idle.length, active: entry.active.size, warming: entry.warming.size };
  }
}

/** Default singleton used by the extension at runtime. */
export const defaultLoaderPool = new LoaderPool();

export async function allowUiPaint(coldLoader: boolean): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (!coldLoader) return;
  // Give pi's TUI render timer a real timers-phase turn before CPU-heavy extension loading.
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

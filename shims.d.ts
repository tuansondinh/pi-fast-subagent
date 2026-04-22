declare module "@mariozechner/pi-coding-agent" {
  export type ExtensionAPI = any;

  export const AuthStorage: any;
  export const createAgentSession: any;
  export const DefaultResourceLoader: any;
  export const getAgentDir: any;
  export const ModelRegistry: any;
  export const SessionManager: any;

  export function truncateToVisualLines(
    text: string,
    maxVisualLines: number,
    width: number,
    paddingX?: number,
  ): { visualLines: string[]; skippedCount: number };

  export function keyHint(keybinding: string, description: string): string;
}

declare module "@mariozechner/pi-tui" {
  export function truncateToWidth(
    text: string,
    maxWidth: number,
    ellipsis?: string,
    pad?: boolean,
  ): string;
}

declare module "@sinclair/typebox" {
  export const Type: any;
}

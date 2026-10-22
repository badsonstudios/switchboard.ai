// "Which AIs exist" — the wire shapes the AIs tab, the AI switch and the
// session icons read (E40 item 08, #1291; design record §4 "As built, item
// 08"). Main owns the model (`src/main/ai-catalog/`); the renderer only asks.
//
// Shared because both halves name them: main fills them in, the preload
// passes them through, and #1292 / #1293 draw them.

import type { AiReason } from './ai-reason';

/**
 * Where the AIs' icons are served, relative to the renderer's page: the
 * renderer's own `public/ai-icons/`, so an `<img src={AI_ICON_BASE + icon}>`
 * is `'self'` under the CSP (`shared/csp.ts` allows no `data:` and no remote
 * image). Each SVG was downloaded ONCE from its registry `icon` URL; the app
 * never fetches one.
 */
export const AI_ICON_BASE = 'ai-icons/';

/**
 * Claude's catalog id, which is also its provider id. Shared because a few
 * words are true only of Claude (#1316): the renderer adds them when a
 * session's AI is this one, and says the AI-neutral sentence otherwise.
 */
export const CLAUDE_AI_ID = 'claude-code';

/** How a person gets an AI onto this computer. Shown, never run. */
export type InstallHint =
  /** a command to copy, e.g. `npm i -g @google/gemini-cli` */
  | { kind: 'command'; command: string }
  /** the maker's own install page */
  | { kind: 'link'; url: string };

/** What starts the AI in ACP mode, as the registry gives it. */
export interface LaunchSpec {
  /** a program name looked up on PATH at spawn time, or an absolute path */
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** One AI the app ships knowledge of. */
export interface CatalogEntry {
  /** stable catalog id: the ACP registry id, or `claude-code` */
  id: string;
  /** the registry id this entry was copied from; absent for Claude */
  registryId?: string;
  /** the registry version the entry was copied at */
  registryVersion?: string;
  name: string;
  /** `authors[0]` in the registry */
  maker: string;
  description: string;
  license?: string;
  website?: string;
  /** `native` = its own engine (Claude); `acp` = the general ACP engine */
  engine: 'native' | 'acp';
  install: InstallHint;
  /** absent for a native engine, whose provider builds its own spawn */
  launch?: LaunchSpec;
  /** the program whose presence on PATH means "installed" */
  detectCommand: string;
  /** the screen-5 filter: can it run a model on this machine (Ollama) */
  runsLocalModels: boolean;
  /** file name under `AI_ICON_BASE` (the renderer's own origin) */
  icon?: string;
  /** the provider id that hosts it when one is registered */
  providerId?: string;
}

/** A "Something else" entry: any program that speaks ACP. */
export interface CustomAi {
  /** `custom:<slug>`, and also its provider id */
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** epoch ms */
  addedAt: number;
}

/** What a custom-AI form sends. */
export interface CustomAiDraft {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export type LoginState = 'logged-in' | 'logged-out' | 'unknown';

/**
 * One detection answer. Modelled honestly: a probe that ran out of time, or
 * that threw, does not know whether the AI is installed, and says so.
 */
export interface DetectionResult {
  installed: boolean | 'unknown';
  version?: string;
  login: LoginState;
  /** the account the AI says it is signed in as, where it says */
  account?: string;
  /** the plan the AI reports (`max`, …), where it says */
  plan?: string;
  /** why an answer is `unknown`, in words (English: the log, and the fallback) */
  detail?: string;
  /** the same, as a code the AIs tab translates (#1365) */
  detailCode?: AiReason;
  /** epoch ms the answer was produced */
  probedAt: number;
  /** how long the probe took */
  ms?: number;
}

/** A registered provider the catalog has no entry for (a test fake, say). */
export interface ProviderOnlyEntry {
  id: string;
  name: string;
}

export type AiListItem =
  | { kind: 'catalog'; entry: CatalogEntry; providerId?: string; registered: boolean; detection?: DetectionResult }
  | { kind: 'custom'; entry: CustomAi; providerId: string; registered: boolean; detection?: DetectionResult }
  | { kind: 'provider'; entry: ProviderOnlyEntry; providerId: string; registered: true; detection?: DetectionResult };

/** Which AI new sessions start on, and why. */
export interface DefaultAiState {
  /** the provider id new sessions use */
  id: string;
  /** what the user chose; absent = never chosen (the first registered stands) */
  chosen?: string;
  /** the chosen one is not registered, so `id` is the fallback */
  fellBack: boolean;
}

export interface AisSnapshot {
  items: AiListItem[];
  default: DefaultAiState;
  /** a detection run is in flight */
  detecting: boolean;
}

/** What "Test" on a custom AI reports. */
export interface CustomAiTestResult {
  ok: boolean;
  agentName?: string;
  agentVersion?: string;
  protocolVersion?: number;
  authMethods?: string[];
  error?: string;
  /** `error` as a code the dialog translates (#1365) */
  errorCode?: AiReason;
  ms: number;
}

/** What "Log in" reports. The sign-in itself is always the AI's own. */
export interface AiLoginResult {
  supported: boolean;
  ok?: boolean;
  reason?: string;
  /** `reason` as a code the AIs tab translates (#1365); `reason` stays the English */
  reasonCode?: AiReason;
  /** the sign-in methods the AI offers, when it offers more than one */
  methods?: string[];
  /**
   * The AI's own label for each of `methods`, by id ("ChatGPT" for
   * `chat-gpt`, #1316). A method with no label is shown by its id.
   */
  methodLabels?: Record<string, string>;
}

/** One registry agent, trimmed to what a diff and a list need. */
export interface RegistryAgent {
  id: string;
  name: string;
  version: string;
  description?: string;
  maker?: string;
  license?: string;
  website?: string;
  repository?: string;
  /** which distributions it has: `npx`, `uvx`, `binary` */
  distributions: string[];
}

export interface RegistryDiff {
  added: RegistryAgent[];
  changed: Array<{ id: string; name: string; from: string; to: string }>;
  removed: Array<{ id: string; name: string }>;
}

export type RegistryCheckResult =
  | { ok: true; fetchedAt: number; total: number; diff: RegistryDiff }
  | { ok: false; error: string };

export type CustomAiAddResult = { ok: true; ai: CustomAi } | { ok: false; error: string };

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { Tokenizer } from "@huggingface/tokenizers";
import { encodingForModel, getEncoding } from "js-tiktoken";
import type { ChatMessage } from "./types.js";
import type { TokenizerType } from "./types.js";
import { logger } from "../utils/logger.js";

type Encoder = {
  encode: (text: string) => number[];
};

type TokenCounter = {
  tokenizerType: TokenizerType;
  count: (text: string) => number;
};

interface HuggingFaceTokenizerConfig {
  tokenizerKey: string;
  tokenizerJsonPath: string;
  tokenizerConfigPath?: string;
  repoId?: string;
  revision: string;
}

const DEFAULT_ENCODING = "cl100k_base";
const HF_TOKENIZER_PATHS_ENV = "HF_TOKENIZER_PATHS";
const HF_TOKENIZER_CONFIG_PATHS_ENV = "HF_TOKENIZER_CONFIG_PATHS";
const HF_TOKENIZER_REPOS_ENV = "HF_TOKENIZER_REPOS";
const HF_TOKENIZER_REVISIONS_ENV = "HF_TOKENIZER_REVISIONS";
const HF_TOKEN_ENV = "HF_TOKEN";
const DEFAULT_HF_REVISION = "main";
const DOWNLOAD_RETRY_DELAY_MS = 5 * 60 * 1000;
const TOKENS_PER_MESSAGE = 3;
const TOKENS_ASSISTANT_PRIMER = 3;
const encoderCache = new Map<string, Encoder>();
const tokenCounterCache = new Map<string, TokenCounter>();
const downloadRetryAfterMs = new Map<string, number>();

const MODEL_ALIASES: Array<{ matcher: RegExp; model: string }> = [
  { matcher: /gpt-4o/i, model: "gpt-4o" },
  { matcher: /gpt-4\.1/i, model: "gpt-4.1" },
  { matcher: /gpt-4/i, model: "gpt-4" },
  { matcher: /gpt-3\.5/i, model: "gpt-3.5-turbo" },
  { matcher: /o1/i, model: "o1" },
  { matcher: /o3/i, model: "o3-mini" }
];

function resolveModelAlias(model: string): string {
  const normalized = model.trim();
  if (!normalized) {
    return "gpt-4o-mini";
  }

  for (const alias of MODEL_ALIASES) {
    if (alias.matcher.test(normalized)) {
      return alias.model;
    }
  }

  return normalized;
}

function parsePathMap(envName: string): Record<string, string> {
  const raw = process.env[envName];
  if (!raw) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return Object.entries(parsed).reduce<Record<string, string>>((paths, [model, path]) => {
      if (typeof path === "string" && path.trim()) {
        paths[model.toLowerCase()] = path;
      }

      return paths;
    }, {});
  } catch {
    return {};
  }
}

function modelMatchesTokenizerKey(model: string, tokenizerKey: string): boolean {
  const normalizedModel = model.trim().toLowerCase();
  const normalizedKey = tokenizerKey.trim().toLowerCase();

  return normalizedModel === normalizedKey || normalizedModel.includes(normalizedKey);
}

function resolveHuggingFaceTokenizerConfig(model: string): HuggingFaceTokenizerConfig | undefined {
  const tokenizerPaths = parsePathMap(HF_TOKENIZER_PATHS_ENV);
  const tokenizerConfigPaths = parsePathMap(HF_TOKENIZER_CONFIG_PATHS_ENV);
  const tokenizerRepos = parsePathMap(HF_TOKENIZER_REPOS_ENV);
  const tokenizerRevisions = parsePathMap(HF_TOKENIZER_REVISIONS_ENV);
  const tokenizerKey = Object.keys(tokenizerPaths).find((key) => modelMatchesTokenizerKey(model, key));

  if (!tokenizerKey) {
    return undefined;
  }

  return {
    tokenizerKey,
    tokenizerJsonPath: tokenizerPaths[tokenizerKey],
    tokenizerConfigPath: tokenizerConfigPaths[tokenizerKey],
    repoId: tokenizerRepos[tokenizerKey],
    revision: tokenizerRevisions[tokenizerKey] ?? DEFAULT_HF_REVISION
  };
}

function readJsonFile(path: string): object {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8")) as object;
}

function buildDownloadKey(config: HuggingFaceTokenizerConfig): string {
  return `${config.tokenizerKey}:${config.repoId ?? ""}:${config.revision}`;
}

function buildHuggingFaceResolveUrl(repoId: string, revision: string, remoteFileName: string): string {
  return `https://huggingface.co/${repoId}/resolve/${encodeURIComponent(revision)}/${encodeURIComponent(remoteFileName)}`;
}

function downloadTokenizerFileSync(
  repoId: string,
  revision: string,
  remoteFileName: string,
  localPath: string
): void {
  const url = buildHuggingFaceResolveUrl(repoId, revision, remoteFileName);
  const args = ["-fsSL", url, "-o", localPath];
  const hfToken = process.env[HF_TOKEN_ENV];
  if (hfToken) {
    args.push("-H", `Authorization: Bearer ${hfToken}`);
  }

  mkdirSync(dirname(localPath), { recursive: true });
  execFileSync("curl", args, { stdio: "pipe" });
}

function ensureTokenizerFilesDownloaded(config: HuggingFaceTokenizerConfig): boolean {
  if (!config.repoId) {
    return false;
  }

  const tokenizerJsonPath = resolve(process.cwd(), config.tokenizerJsonPath);
  if (existsSync(tokenizerJsonPath)) {
    return true;
  }

  const downloadKey = buildDownloadKey(config);
  const now = Date.now();
  const retryAfter = downloadRetryAfterMs.get(downloadKey);
  if (retryAfter && retryAfter > now) {
    return false;
  }

  try {
    downloadTokenizerFileSync(
      config.repoId,
      config.revision,
      basename(config.tokenizerJsonPath),
      tokenizerJsonPath
    );

    if (config.tokenizerConfigPath) {
      const tokenizerConfigPath = resolve(process.cwd(), config.tokenizerConfigPath);
      if (!existsSync(tokenizerConfigPath)) {
        try {
          downloadTokenizerFileSync(
            config.repoId,
            config.revision,
            basename(config.tokenizerConfigPath),
            tokenizerConfigPath
          );
        } catch (error) {
          logger.warn("tokenizer.hf.config_download_failed", {
            tokenizerKey: config.tokenizerKey,
            repoId: config.repoId,
            revision: config.revision,
            tokenizerConfigPath: config.tokenizerConfigPath,
            error: error instanceof Error ? error.message : "download_failed"
          });
        }
      }
    }

    tokenCounterCache.clear();
    downloadRetryAfterMs.delete(downloadKey);
    logger.info("tokenizer.hf.downloaded", {
      tokenizerKey: config.tokenizerKey,
      repoId: config.repoId,
      revision: config.revision,
      tokenizerJsonPath: config.tokenizerJsonPath
    });
    return true;
  } catch (error) {
    downloadRetryAfterMs.set(downloadKey, Date.now() + DOWNLOAD_RETRY_DELAY_MS);
    logger.warn("tokenizer.hf.download_failed", {
      tokenizerKey: config.tokenizerKey,
      repoId: config.repoId,
      revision: config.revision,
      tokenizerJsonPath: config.tokenizerJsonPath,
      error: error instanceof Error ? error.message : "download_failed"
    });
    return false;
  }
}

export function preloadConfiguredTokenizers(): void {
  const tokenizerPaths = parsePathMap(HF_TOKENIZER_PATHS_ENV);
  const tokenizerConfigPaths = parsePathMap(HF_TOKENIZER_CONFIG_PATHS_ENV);
  const tokenizerRepos = parsePathMap(HF_TOKENIZER_REPOS_ENV);
  const tokenizerRevisions = parsePathMap(HF_TOKENIZER_REVISIONS_ENV);

  for (const [tokenizerKey, tokenizerJsonPath] of Object.entries(tokenizerPaths)) {
    const config: HuggingFaceTokenizerConfig = {
      tokenizerKey,
      tokenizerJsonPath,
      tokenizerConfigPath: tokenizerConfigPaths[tokenizerKey],
      repoId: tokenizerRepos[tokenizerKey],
      revision: tokenizerRevisions[tokenizerKey] ?? DEFAULT_HF_REVISION
    };
    ensureTokenizerFilesDownloaded(config);
  }
}

function createHuggingFaceTokenCounter(config: HuggingFaceTokenizerConfig): TokenCounter | undefined {
  const tokenizerJsonPath = resolve(process.cwd(), config.tokenizerJsonPath);
  if (!existsSync(tokenizerJsonPath)) {
    ensureTokenizerFilesDownloaded(config);
  }
  if (!existsSync(tokenizerJsonPath)) {
    return undefined;
  }

  const tokenizerJson = readJsonFile(config.tokenizerJsonPath);
  const tokenizerConfig =
    config.tokenizerConfigPath && existsSync(resolve(process.cwd(), config.tokenizerConfigPath))
      ? readJsonFile(config.tokenizerConfigPath)
      : {};
  const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);

  return {
    tokenizerType: "huggingface",
    count: (text: string) => tokenizer.encode(text, { add_special_tokens: false }).ids.length
  };
}

function getEncoder(model: string): Encoder {
  const cacheKey = model.trim().toLowerCase() || DEFAULT_ENCODING;
  const cached = encoderCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const aliasedModel = resolveModelAlias(model);
  const encoder = (() => {
    try {
      return encodingForModel(aliasedModel as never) as Encoder;
    } catch {
      return getEncoding(DEFAULT_ENCODING) as Encoder;
    }
  })();

  encoderCache.set(cacheKey, encoder);
  return encoder;
}

function createTiktokenCounter(model: string): TokenCounter {
  return {
    tokenizerType: "tiktoken",
    count: (text: string) => getEncoder(model).encode(text).length
  };
}

function getTokenCounter(model: string): TokenCounter {
  const cacheKey = model.trim().toLowerCase() || DEFAULT_ENCODING;
  const cached = tokenCounterCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const huggingFaceConfig = resolveHuggingFaceTokenizerConfig(model);
  const counter = huggingFaceConfig
    ? createHuggingFaceTokenCounter(huggingFaceConfig) ?? createTiktokenCounter(model)
    : createTiktokenCounter(model);

  tokenCounterCache.set(cacheKey, counter);
  return counter;
}

function countTextTokens(model: string, text: string): number {
  if (!text.trim()) {
    return 0;
  }

  return getTokenCounter(model).count(text);
}

export function resolveTokenizerType(model: string): TokenizerType {
  return getTokenCounter(model).tokenizerType;
}

export function estimatePromptTokens(model: string, messages: ChatMessage[]): number {
  return messages.reduce((total, message) => {
    return (
      total +
      TOKENS_PER_MESSAGE +
      countTextTokens(model, message.role) +
      countTextTokens(model, message.content)
    );
  }, TOKENS_ASSISTANT_PRIMER);
}

export function estimateCompletionTokens(model: string, completionText: string): number {
  return countTextTokens(model, completionText);
}

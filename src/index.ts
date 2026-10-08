import { open } from "node:fs/promises";
import { prepareBundle } from "./bundle.js";
import { inputError, isObject, RosebudError } from "./errors.js";
import type { JsonValue } from "./errors.js";

export { RosebudError } from "./errors.js";
export type { JsonValue, PublishOutcome, RosebudErrorKind } from "./errors.js";

export interface RosebudOptions {
  apiBaseUrl: string;
  timeoutMs?: number;
}
export type AgentClient =
  "codex" | "claude-code" | "gemini-cli" | "cursor" | "other" | "unknown";
export interface AdoptionContext {
  agent_client?: AgentClient;
  agent_version?: string;
  model_provider?: "openai" | "anthropic" | "google" | "other" | "unknown";
  model?: string;
  use_case?:
    | "learning"
    | "game-jam"
    | "prototype"
    | "portfolio"
    | "classroom"
    | "client-work"
    | "commercial"
    | "other";
  framework?: "vanilla" | "phaser" | "three" | "other" | "unknown";
  discovery_source?:
    | "docs"
    | "search"
    | "github"
    | "recommendation"
    | "existing-user"
    | "other"
    | "unknown";
  sdk_version?: string;
  interface?: "http" | "sdk" | "cli";
}
export interface GameMetadata {
  title?: string;
  name?: string;
  description?: string;
  thumbnail?: string;
}
export type BundleInput =
  { directory: string; zip?: never } | { zip: string; directory?: never };
export type PublishOptions = BundleInput &
  GameMetadata & { context?: AdoptionContext; signal?: AbortSignal };
export interface PublishResult {
  project_id: string;
  play_url: string;
  claim_url: string;
  claim_expires_at: string;
  content_version: string;
  [key: string]: JsonValue;
}
export interface ConnectionOptions {
  projectId: string;
  claimSecret?: string;
  client?: AgentClient;
  signal?: AbortSignal;
}
export interface AgentAuthorization {
  projectId: string;
  agentToken: string;
  signal?: AbortSignal;
}
export interface ConnectionResult {
  project_id: string;
  connection_id: string;
  agent_token: string;
  approval_url: string;
  status: "pending";
  expires_at: string;
}
export interface ConnectionStatus {
  project_id: string;
  connection_id: string;
  status: "pending" | "active" | "revoked" | "expired";
  expires_at: string;
  content_version?: string;
  title?: string;
  play_url?: string;
}
export type UpdateOptions = BundleInput &
  GameMetadata &
  AgentAuthorization & { expectedVersion: string; operationId: string };
export interface UpdateResult {
  project_id: string;
  play_url: string;
  content_version: string;
  operation_id: string;
}

function httpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

async function readResponse(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) {
        await reader.cancel();
        throw new RosebudError(
          "The response exceeded 1 MiB; the project may already exist. No retry was attempted.",
          {
            kind: "response",
            code: "unexpected_response",
            outcome: "unknown",
            status: response.status,
          },
        );
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

function projectPath(projectId: string): string {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      projectId,
    )
  )
    throw inputError("project_id", "Use the project_id returned by Rosebud.");
  return `/api/developer/projects/${projectId.toLowerCase()}`;
}
function validateToken(token: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw inputError(
      "agent_token",
      "Use the private agent credential returned by connect.",
    );
}
function unexpected(): never {
  throw new RosebudError(
    "The API returned an unexpected response. The operation may have completed; no retry was attempted.",
    { kind: "response", code: "unexpected_response", outcome: "unknown" },
  );
}
export async function readCover(path: string): Promise<Uint8Array> {
  try {
    const file = await open(path, "r");
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 2 * 1024 * 1024)
        throw inputError(
          "thumbnail",
          "Use a PNG or JPEG file of at most 2 MiB.",
        );
      const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          size,
          buffer.length - size,
          null,
        );
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size > 2 * 1024 * 1024)
        throw inputError("thumbnail", "Use a cover of at most 2 MiB.");
      return buffer.subarray(0, size);
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof RosebudError) throw error;
    throw inputError("thumbnail", "The thumbnail file could not be read.");
  }
}
async function gameForm(
  options: BundleInput & GameMetadata & { signal?: AbortSignal },
): Promise<FormData> {
  if (!options || typeof options !== "object")
    throw inputError("input_required", "Provide a directory or ZIP path.");
  for (const key of ["name", "title"] as const) {
    if (
      options[key] !== undefined &&
      (typeof options[key] !== "string" ||
        !options[key].trim() ||
        options[key].length > 255)
    )
      throw inputError(key, "Use a nonempty title of at most 255 characters.");
  }
  if (
    options.name !== undefined &&
    options.title !== undefined &&
    options.name !== options.title
  )
    throw inputError(
      "title",
      "Use matching title and name, or supply only title.",
    );
  if (
    options.description !== undefined &&
    (typeof options.description !== "string" ||
      options.description.length > 4000)
  )
    throw inputError(
      "description",
      "Use a description of at most 4000 characters.",
    );
  if (options.signal?.aborted)
    throw inputError("aborted", "Upload cancelled before sending.");
  const bytes = await prepareBundle(options);
  const form = new FormData();
  form.append(
    "bundle",
    new Blob([new Uint8Array(bytes)], { type: "application/zip" }),
    "game.zip",
  );
  for (const key of ["name", "title", "description"] as const)
    if (options[key] !== undefined) form.append(key, options[key]);
  if (options.thumbnail !== undefined)
    form.append(
      "thumbnail",
      new Blob([new Uint8Array(await readCover(options.thumbnail))]),
      "cover",
    );
  return form;
}

/** Node publishing client. Library calls never persist credentials or project files. */
export class Rosebud {
  readonly apiBaseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: RosebudOptions) {
    let url: URL;
    try {
      url = new URL(options.apiBaseUrl);
    } catch {
      throw inputError(
        "api_base",
        "Provide an explicit HTTP(S) API origin in apiBaseUrl.",
      );
    }
    if (!httpUrl(url.href) || url.pathname !== "/" || url.search || url.hash)
      throw inputError(
        "api_base",
        "Use the API origin without a path, query, fragment or credentials.",
      );
    // Credentials travel to this origin, so plain HTTP is only for a local server.
    if (
      url.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      throw inputError(
        "api_base",
        "Use an HTTPS API origin. Plain HTTP is allowed only for localhost.",
      );
    this.apiBaseUrl = url.origin;
    this.timeoutMs = options.timeoutMs ?? 120000;
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      this.timeoutMs > 2147483647
    )
      throw inputError(
        "timeout",
        "timeoutMs must be a positive integer at most 2147483647.",
      );
  }

  async publish(options: PublishOptions): Promise<PublishResult> {
    const form = await gameForm(options);
    if (options.context !== undefined)
      form.append("context", JSON.stringify(options.context));
    const body = await this.request(
      "/api/developer/projects/import/",
      "POST",
      form,
      undefined,
      options.signal,
    );
    if (
      typeof body.project_id !== "string" ||
      !body.project_id ||
      !httpUrl(body.play_url) ||
      !httpUrl(body.claim_url) ||
      typeof body.claim_expires_at !== "string" ||
      !Number.isFinite(Date.parse(body.claim_expires_at)) ||
      typeof body.content_version !== "string"
    )
      unexpected();
    return body as unknown as PublishResult;
  }

  async connect(options: ConnectionOptions): Promise<ConnectionResult> {
    const path = projectPath(options.projectId);
    if (options.claimSecret !== undefined) validateToken(options.claimSecret);
    const body = await this.request(
      `${path}/connect/`,
      "POST",
      JSON.stringify({
        claim_secret: options.claimSecret,
        client: options.client ?? "unknown",
      }),
      undefined,
      options.signal,
    );
    if (
      body.project_id !== options.projectId.toLowerCase() ||
      typeof body.agent_token !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.agent_token) ||
      !httpUrl(body.approval_url) ||
      body.status !== "pending" ||
      typeof body.expires_at !== "string"
    )
      unexpected();
    return body as unknown as ConnectionResult;
  }

  async status(options: AgentAuthorization): Promise<ConnectionStatus> {
    validateToken(options.agentToken);
    const body = await this.request(
      `${projectPath(options.projectId)}/connection/`,
      "GET",
      undefined,
      options.agentToken,
      options.signal,
    );
    if (
      body.project_id !== options.projectId.toLowerCase() ||
      !["pending", "active", "revoked", "expired"].includes(
        String(body.status),
      ) ||
      typeof body.expires_at !== "string"
    )
      unexpected();
    if (
      body.status === "active" &&
      (typeof body.content_version !== "string" || !httpUrl(body.play_url))
    )
      unexpected();
    return body as unknown as ConnectionStatus;
  }

  async update(options: UpdateOptions): Promise<UpdateResult> {
    validateToken(options.agentToken);
    const path = projectPath(options.projectId);
    projectPath(options.operationId);
    if (!/^[a-f0-9]{64}$/.test(options.expectedVersion))
      throw inputError(
        "expected_version",
        "Use the content_version you last accepted for this project.",
      );
    const form = await gameForm(options);
    form.append("expected_version", options.expectedVersion);
    form.append("operation_id", options.operationId);
    const body = await this.request(
      `${path}/releases/`,
      "POST",
      form,
      options.agentToken,
      options.signal,
    );
    if (
      body.project_id !== options.projectId.toLowerCase() ||
      body.operation_id !== options.operationId.toLowerCase() ||
      typeof body.content_version !== "string" ||
      !httpUrl(body.play_url)
    )
      unexpected();
    return body as unknown as UpdateResult;
  }

  async disconnect(options: AgentAuthorization): Promise<void> {
    validateToken(options.agentToken);
    await this.request(
      `${projectPath(options.projectId)}/connection/`,
      "DELETE",
      undefined,
      options.agentToken,
      options.signal,
    );
  }

  private async request(
    path: string,
    method: string,
    body?: FormData | string,
    token?: string,
    cancellation?: AbortSignal,
  ): Promise<Record<string, JsonValue>> {
    if (cancellation?.aborted)
      throw inputError("aborted", "Request cancelled before sending.");
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = cancellation
      ? AbortSignal.any([timeout, cancellation])
      : timeout;
    let response: Response;
    let text: string;
    try {
      response = await fetch(new URL(path, this.apiBaseUrl), {
        method,
        ...(body !== undefined ? { body } : {}),
        signal,
        redirect: "manual",
        headers: {
          ...(typeof body === "string"
            ? { "Content-Type": "application/json" }
            : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      text = await readResponse(response);
    } catch (error) {
      if (error instanceof RosebudError) throw error;
      throw new RosebudError(
        "Request or response interrupted. The operation may have completed; no retry was attempted.",
        {
          kind: "transport",
          code: signal.aborted ? "aborted" : "network_error",
          outcome: "unknown",
        },
      );
    }
    let result: JsonValue;
    try {
      result = response.status === 204 ? {} : (JSON.parse(text) as JsonValue);
    } catch {
      result = text;
    }
    if (!response.ok) {
      const detail =
        isObject(result) && isObject(result.error) ? result.error : undefined;
      throw new RosebudError(
        typeof detail?.message === "string"
          ? detail.message
          : `Rosebud API returned HTTP ${response.status}.`,
        {
          kind: "api",
          code: typeof detail?.code === "string" ? detail.code : "http_error",
          outcome:
            response.status >= 400 && response.status < 500
              ? "rejected"
              : "unknown",
          status: response.status,
          body: result,
        },
      );
    }
    if (!isObject(result)) unexpected();
    return result;
  }
}

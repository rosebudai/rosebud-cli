import { link, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
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
export interface LoginOptions {
  client?: AgentClient;
  name?: string;
  signal?: AbortSignal;
}
export interface LoginResult {
  login_id: string;
  token: string;
  approval_url: string;
  status: "pending";
  expires_at: string;
}
/** An account login token (`rbk_...`), or an API key made in Rosebud. */
export interface AccountAuthorization {
  token: string;
  signal?: AbortSignal;
}
export interface LoginStatus {
  login_id: string | null;
  status: "pending" | "active" | "expired" | "revoked";
  expires_at: string | null;
  [key: string]: JsonValue;
}
export interface AssetModelInput {
  name: string;
  type: string;
  required: boolean;
  [key: string]: JsonValue;
}
export interface AssetModel {
  id: string;
  inputs: AssetModelInput[];
  [key: string]: JsonValue;
}
export interface AssetQuote {
  id: string;
  model: string;
  credits: number;
  expires_at: string;
  [key: string]: JsonValue;
}
export interface Asset {
  id: string;
  /** Public file link, or an API path that needs the caller's credential. */
  url: string;
  [key: string]: JsonValue;
}
export interface AssetJob {
  id: string;
  /** queued and running are unfinished; succeeded, failed and canceled are final. */
  status: string;
  asset: Asset | null;
  error: { code: string; message: string } | null;
  [key: string]: JsonValue;
}
export interface AssetDownloadOptions {
  /** An asset's `url`; API paths are resolved against the API origin. */
  url: string;
  path: string;
  /** Sent only to the API origin, never to file storage. */
  token?: string;
  overwrite?: boolean;
  signal?: AbortSignal;
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

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function projectPath(projectId: string): string {
  if (!uuid.test(projectId))
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
function validateAccountToken(token: string): void {
  if (!/^rbk_[A-Za-z0-9_-]{43}$/.test(token))
    throw inputError(
      "account_token",
      "Use the private login credential saved by rosebud login.",
    );
}
function uuidPath(base: string, id: string, label: string): string {
  if (!uuid.test(id))
    throw inputError(
      `${label}_id`,
      `Use the ${label} id returned by Rosebud, a UUID.`,
    );
  return `${base}${id.toLowerCase()}/`;
}
function withQuery(path: string, query: Record<string, string | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) search.set(key, value);
  return search.size ? `${path}?${search}` : path;
}
function isJob(body: Record<string, JsonValue>): boolean {
  return (
    typeof body.id === "string" &&
    typeof body.status === "string" &&
    (body.asset === null ||
      (isObject(body.asset) && typeof body.asset.url === "string")) &&
    (body.error === null || isObject(body.error))
  );
}
/** Rosebud's error shapes: `{error: {code, message}}` and `{detail, code}`. */
function apiError(status: number, result: JsonValue): RosebudError {
  const detail = isObject(result)
    ? isObject(result.error)
      ? { message: result.error.message, code: result.error.code }
      : { message: result.detail, code: result.code }
    : undefined;
  return new RosebudError(
    typeof detail?.message === "string"
      ? detail.message
      : `Rosebud API returned HTTP ${status}.`,
    {
      kind: "api",
      code: typeof detail?.code === "string" ? detail.code : "http_error",
      outcome: status >= 400 && status < 500 ? "rejected" : "unknown",
      status,
      body: result,
    },
  );
}
function downloadInterrupted(signal: AbortSignal): RosebudError {
  return new RosebudError(
    "The download was interrupted and no file was saved. Run the command again to retry it.",
    {
      kind: "transport",
      code: signal.aborted ? "aborted" : "network_error",
      outcome: "unknown",
    },
  );
}
const downloadLimit = 512 * 1024 * 1024;
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

  /** Start an account login; nothing works until a signed-in person approves it. */
  async login(options: LoginOptions = {}): Promise<LoginResult> {
    if (
      options.name !== undefined &&
      (typeof options.name !== "string" ||
        !options.name.trim() ||
        options.name.length > 80)
    )
      throw inputError(
        "name",
        "Use a nonempty login name of at most 80 characters.",
      );
    const body = await this.request(
      "/api/v1/agent-logins/",
      "POST",
      JSON.stringify({
        client: options.client ?? "unknown",
        ...(options.name !== undefined ? { name: options.name } : {}),
      }),
      undefined,
      options.signal,
    );
    if (
      typeof body.login_id !== "string" ||
      typeof body.token !== "string" ||
      !/^rbk_[A-Za-z0-9_-]{43}$/.test(body.token) ||
      !httpUrl(body.approval_url) ||
      body.status !== "pending" ||
      typeof body.expires_at !== "string"
    )
      unexpected();
    return body as unknown as LoginResult;
  }

  async loginStatus(options: AccountAuthorization): Promise<LoginStatus> {
    validateAccountToken(options.token);
    const body = await this.request(
      "/api/v1/agent-logins/current/",
      "GET",
      undefined,
      options.token,
      options.signal,
    );
    if (
      !["pending", "active", "expired", "revoked"].includes(String(body.status))
    )
      unexpected();
    return body as unknown as LoginStatus;
  }

  /** Cancel a pending login or revoke an approved one. */
  async logout(options: AccountAuthorization): Promise<void> {
    validateAccountToken(options.token);
    await this.request(
      "/api/v1/agent-logins/current/",
      "DELETE",
      undefined,
      options.token,
      options.signal,
    );
  }

  async assetModels(
    options: { category?: string; signal?: AbortSignal } = {},
  ): Promise<{ models: AssetModel[]; [key: string]: JsonValue }> {
    const body = await this.request(
      withQuery("/api/v1/asset-models/", { category: options.category }),
      "GET",
      undefined,
      undefined,
      options.signal,
    );
    if (!Array.isArray(body.models)) unexpected();
    return body as { models: AssetModel[]; [key: string]: JsonValue };
  }

  async assetModel(options: {
    model: string;
    signal?: AbortSignal;
  }): Promise<AssetModel> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.model))
      throw inputError("model", "Use a model id from rosebud assets models.");
    const body = await this.request(
      `/api/v1/asset-models/${options.model}/`,
      "GET",
      undefined,
      undefined,
      options.signal,
    );
    if (
      body.id !== options.model ||
      !Array.isArray(body.inputs) ||
      !body.inputs.every(
        (field) =>
          isObject(field) &&
          typeof field.name === "string" &&
          typeof field.type === "string",
      )
    )
      unexpected();
    return body as unknown as AssetModel;
  }

  /** Validate inputs and freeze the price for a few minutes; quoting is free. */
  async quoteAsset(
    options: AccountAuthorization & {
      model: string;
      input: Record<string, JsonValue>;
    },
  ): Promise<AssetQuote> {
    validateAccountToken(options.token);
    const body = await this.request(
      "/api/v1/asset-quotes/",
      "POST",
      JSON.stringify({ model: options.model, input: options.input }),
      options.token,
      options.signal,
    );
    if (
      typeof body.id !== "string" ||
      !uuid.test(body.id) ||
      typeof body.credits !== "number" ||
      typeof body.expires_at !== "string"
    )
      unexpected();
    return body as unknown as AssetQuote;
  }

  /** Pay for a quote and start its job. Repeating the same key returns the same job. */
  async createAssetJob(
    options: AccountAuthorization & {
      quoteId: string;
      idempotencyKey: string;
    },
  ): Promise<AssetJob> {
    validateAccountToken(options.token);
    uuidPath("", options.quoteId, "quote");
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(options.idempotencyKey))
      throw inputError(
        "idempotency_key",
        "Use 1-128 letters, digits, '.', '_', ':' or '-' as the idempotency key.",
      );
    const body = await this.request(
      "/api/v1/asset-jobs/",
      "POST",
      JSON.stringify({
        quote_id: options.quoteId,
        idempotency_key: options.idempotencyKey,
      }),
      options.token,
      options.signal,
    );
    if (!isJob(body)) unexpected();
    return body as unknown as AssetJob;
  }

  async assetJob(
    options: AccountAuthorization & { jobId: string },
  ): Promise<AssetJob> {
    validateAccountToken(options.token);
    const body = await this.request(
      uuidPath("/api/v1/asset-jobs/", options.jobId, "job"),
      "GET",
      undefined,
      options.token,
      options.signal,
    );
    if (!isJob(body) || body.id !== options.jobId.toLowerCase()) unexpected();
    return body as unknown as AssetJob;
  }

  /** The account's assets, newest first, one page at a time. */
  async listAssets(
    options: AccountAuthorization & { query?: string; category?: string },
  ): Promise<{ results: Asset[]; [key: string]: JsonValue }> {
    validateAccountToken(options.token);
    const body = await this.request(
      withQuery("/api/v1/assets/", {
        q: options.query,
        category: options.category,
      }),
      "GET",
      undefined,
      options.token,
      options.signal,
    );
    if (!Array.isArray(body.results)) unexpected();
    return body as { results: Asset[]; [key: string]: JsonValue };
  }

  async asset(
    options: AccountAuthorization & { assetId: string },
  ): Promise<Asset> {
    validateAccountToken(options.token);
    const body = await this.request(
      uuidPath("/api/v1/assets/", options.assetId, "asset"),
      "GET",
      undefined,
      options.token,
      options.signal,
    );
    if (typeof body.id !== "string" || typeof body.url !== "string")
      unexpected();
    return body as unknown as Asset;
  }

  /** Save an asset's file. Without `overwrite`, an existing file is never replaced. */
  async downloadAsset(options: AssetDownloadOptions): Promise<number> {
    let url: URL;
    try {
      url = new URL(options.url, this.apiBaseUrl);
    } catch {
      unexpected();
    }
    const own = url.origin === this.apiBaseUrl;
    if (
      !httpUrl(url.href) ||
      (url.protocol === "http:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      unexpected();
    if (own && options.token !== undefined) validateAccountToken(options.token);
    if (options.signal?.aborted)
      throw inputError("aborted", "Download cancelled before sending.");
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([timeout, options.signal])
      : timeout;
    let response: Response;
    try {
      response = await fetch(url, {
        signal,
        // A redirect must not carry the credential anywhere else.
        redirect: own ? "manual" : "follow",
        headers:
          own && options.token
            ? { Authorization: `Bearer ${options.token}` }
            : {},
      });
    } catch {
      throw downloadInterrupted(signal);
    }
    if (!response.ok || !response.body) {
      let text = "";
      try {
        text = await readResponse(response);
      } catch {
        // The status alone explains the failure.
      }
      let result: JsonValue = text;
      try {
        result = JSON.parse(text) as JsonValue;
      } catch {
        // Storage errors are not JSON.
      }
      throw apiError(response.status, own ? result : null);
    }
    await mkdir(dirname(options.path), { recursive: true });
    const temporary = `${options.path}.${randomUUID()}.part`;
    let size = 0;
    try {
      const file = await open(temporary, "wx");
      const reader = response.body.getReader();
      try {
        while (true) {
          let chunk: Awaited<ReturnType<typeof reader.read>>;
          try {
            chunk = await reader.read();
          } catch {
            throw downloadInterrupted(signal);
          }
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > downloadLimit) {
            await reader.cancel();
            throw new RosebudError(
              "The asset file exceeded 512 MiB and was not saved.",
              { kind: "response", code: "file_too_large", outcome: "rejected" },
            );
          }
          await file.write(chunk.value);
        }
      } finally {
        reader.releaseLock();
        await file.close();
      }
      if (options.overwrite) await rename(temporary, options.path);
      else
        try {
          await link(temporary, options.path);
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "EEXIST"
          )
            throw inputError(
              "file_exists",
              "The output file already exists. Choose another path or pass --force to replace it.",
            );
          throw error;
        }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    return size;
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
    if (!response.ok) throw apiError(response.status, result);
    if (!isObject(result)) unexpected();
    return result;
  }
}

#!/usr/bin/env node
import { parseArgs } from "node:util";
import { lstat, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { prepareBundle } from "./bundle.js";
import { Rosebud, RosebudError, readCover } from "./index.js";
import type {
  AdoptionContext,
  AgentClient,
  AssetJob,
  BundleInput,
  GameMetadata,
  JsonValue,
  LoginStatus,
} from "./index.js";
import { inputError, isObject } from "./errors.js";
import {
  accountPath,
  assetRequestPath,
  credentialPath,
  outsideBuild,
  prepareCredentials,
  readState,
  removeState,
  saveState,
  withStateLock,
} from "./state.js";
import type {
  AccountCredentials,
  AssetRequest,
  Credentials,
  ProjectHandle,
} from "./state.js";

const version = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as {
    version: string;
  }
).version;
const defaultApiBaseUrl = "https://api.rosebud.ai";
const help = `Rosebud CLI — publish and update browser-ready games

  rosebud publish --directory ./dist --title <title> --description <text>
  rosebud connect [--project <id>] [--agent-client codex]
  rosebud status
  rosebud update --directory ./dist [--title <title>] [--thumbnail ./cover.png]
  rosebud disconnect

Common: --state <file> (default .rosebud/project.json), --timeout-ms <ms>, --help, --version
Uploads: exactly one --directory or --zip; optional --title, --description, --thumbnail.
Optional first-upload context: --context <JSON file>, --agent-client <client>.
--name remains a title alias. Rosebud is the default destination; no configuration needed.

publish creates one new game and saves its handle. Unclaimed games expire after one
hour and are permanently deleted. The result includes claim_expires_at; claim before
then to keep the same link. After expiry, upload your local build with a fresh
--state file to create a new game and link. The old game cannot be recovered.
connect returns a PRIVATE sign-in
link; the human must approve before update works. status checks approval without
silently accepting remote edits. After reconciling a conflict, explicitly pass
--expected-version <version from status> to update.

Update retries reuse the saved operation ID for identical input. After an uncertain
response, rerun the same update. Changed input requires explicit reconciliation.
An uncertain first publish may have created a game: do not automatically publish again.

Make assets with the person's Rosebud credits:
  rosebud login [--agent-client codex] [--name <label>]
  rosebud whoami
  rosebud logout
  rosebud assets models [--category image]
  rosebud assets quote --model <id> --prompt <text> [--input name=value ...]
  rosebud assets create --model <id> --prompt <text> [--max-credits <n>] [--out <file>]
  rosebud assets status <job_id>
  rosebud assets list [--query <text>] [--category <category>]
  rosebud assets download <asset_id> --out <file>

login returns a PRIVATE approval link; the human must approve before assets work.
--prompt fills the model's prompt input; --input sets any other input it lists
(repeatable), and --input-json <file> supplies inputs as one JSON object.
create quotes first, refuses a quote above --max-credits, then waits up to
--timeout-ms (default 600000) and saves the file to --out. --force replaces an
existing file; --no-wait returns the job at once. After an uncertain create, rerun
the identical command: it resumes the same job instead of paying again. Once a
create finishes, the same command makes a new asset.

Credentials live separately under ~/.config/rosebud/credentials (mode 0600).
Keep .rosebud/ out of Git and keep state outside your build output.
JSON goes to stdout; errors to stderr. Exit 2 input, 3 HTTP rejection, 4 unknown outcome.
`;
const strings = [
  "directory",
  "zip",
  "name",
  "title",
  "description",
  "thumbnail",
  "context",
  "agent-client",
  "api-base",
  "timeout-ms",
  "state",
  "project",
  "expected-version",
  "model",
  "prompt",
  "input-json",
  "max-credits",
  "out",
  "category",
  "query",
];
const projectCommands = [
  "publish",
  "connect",
  "status",
  "update",
  "disconnect",
];
/** Positional arguments each assets subcommand takes, including "assets". */
const assetCommands: Record<string, number> = {
  models: 2,
  quote: 2,
  create: 2,
  status: 3,
  list: 2,
  download: 3,
};
/** Ids that help recover from an error, added to its JSON. */
const errorContext: { job_id?: string; asset_id?: string } = {};

async function main(): Promise<void> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs({
      allowPositionals: true,
      strict: true,
      tokens: true,
      options: {
        ...Object.fromEntries(
          strings.map((name) => [name, { type: "string" as const }]),
        ),
        input: { type: "string", multiple: true },
        force: { type: "boolean" },
        "no-wait": { type: "boolean" },
        help: { type: "boolean" },
        version: { type: "boolean" },
      },
    });
  } catch {
    throw inputError("usage", "Invalid arguments. Run rosebud --help.");
  }
  const seen = new Set<string>();
  for (const token of args.tokens ?? []) {
    if (token.kind === "option" && token.name !== "input") {
      if (seen.has(token.name))
        throw inputError("usage", `Use --${token.name} only once.`);
      seen.add(token.name);
    }
  }
  const { values, positionals } = args;
  const value = (name: string): string | undefined =>
    typeof values[name] === "string" ? (values[name] as string) : undefined;
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  if (values.version) {
    process.stdout.write(`${version}\n`);
    return;
  }
  const command = positionals[0] ?? "";
  const client = value("agent-client") ?? "unknown";
  if (
    ![
      "codex",
      "claude-code",
      "gemini-cli",
      "cursor",
      "other",
      "unknown",
    ].includes(client)
  )
    throw inputError(
      "agent_client",
      "Choose codex, claude-code, gemini-cli, cursor, other or unknown.",
    );
  if (command === "assets") {
    if (assetCommands[positionals[1] ?? ""] !== positionals.length)
      throw inputError(
        "usage",
        "Choose assets models, quote, create, status <job_id>, list or download <asset_id>.",
      );
    await assets(positionals, value, values);
    return;
  }
  if (["login", "whoami", "logout"].includes(command)) {
    if (positionals.length !== 1)
      throw inputError("usage", `rosebud ${command} takes no arguments.`);
    await account(command, value, client as AgentClient);
    return;
  }
  if (positionals.length !== 1 || !projectCommands.includes(command))
    throw inputError(
      "usage",
      "Choose publish, connect, status, update, disconnect, login, whoami, logout or assets.",
    );
  const directory = value("directory"),
    zip = value("zip");
  const uploading = command === "publish" || command === "update";
  if (uploading && (directory === undefined) === (zip === undefined))
    throw inputError(
      "input_required",
      "Choose exactly one --directory or --zip.",
    );
  const input: BundleInput =
    directory !== undefined ? { directory } : { zip: zip ?? "" };
  const metadata: GameMetadata = {};
  for (const key of ["name", "title", "description", "thumbnail"] as const) {
    const v = value(key);
    if (v !== undefined) metadata[key] = v;
  }
  const statePath = resolve(value("state") ?? ".rosebud/project.json");
  outsideBuild(statePath, directory);

  await withStateLock(statePath, async () => {
    let handle = await readState<ProjectHandle>(statePath);
    if (
      handle &&
      (handle.version !== 1 ||
        typeof handle.api_base_url !== "string" ||
        typeof handle.project_id !== "string")
    )
      throw inputError("state_format", "This project handle is not supported.");
    const configuredBase = value("api-base") ?? process.env.ROSEBUD_API_BASE;
    const api = new Rosebud({
      apiBaseUrl: configuredBase || handle?.api_base_url || defaultApiBaseUrl,
      timeoutMs: Number(value("timeout-ms") ?? 120000),
    });
    if (handle && handle.api_base_url !== api.apiBaseUrl)
      throw inputError(
        "origin_mismatch",
        "This handle belongs to a different API origin. Use its saved origin or a separate state file.",
      );
    if (command === "publish") {
      if (handle)
        throw inputError(
          "project_exists",
          "This state already holds a game. Use update for a claimed game, or an unused --state .rosebud/new-project.json to upload your local build as a new game.",
        );
      let supplied: AdoptionContext = {};
      if (value("context")) {
        try {
          supplied = JSON.parse(
            await readFile(value("context") ?? "", "utf8"),
          ) as AdoptionContext;
        } catch {
          throw inputError("context", "Provide a readable JSON context file.");
        }
      }
      const destination = credentialPath(statePath, {
        version: 1,
        api_base_url: api.apiBaseUrl,
        project_id: "new-project",
      });
      outsideBuild(destination, directory);
      await prepareCredentials(destination);
      const result = await api.publish({
        ...input,
        ...metadata,
        context: {
          ...supplied,
          ...(client !== "unknown"
            ? { agent_client: client as AgentClient }
            : {}),
          sdk_version: version,
          interface: "cli",
        },
      });
      handle = {
        version: 1,
        api_base_url: api.apiBaseUrl,
        project_id: result.project_id,
        play_url: result.play_url,
        claim_expires_at: result.claim_expires_at,
        content_version: result.content_version,
      };
      const path = credentialPath(statePath, handle);
      outsideBuild(path, directory);
      await prepareCredentials(path);
      await saveState(path, {
        api_base_url: api.apiBaseUrl,
        project_id: result.project_id,
        claim_secret: new URL(result.claim_url).hash.slice(1),
      });
      await saveState(statePath, handle);
      output({
        ...result,
        state_file: statePath,
        next_action: `Claim by ${result.claim_expires_at} to keep this game online for free. Unclaimed uploads are permanently deleted after one hour. Run rosebud connect with this state file, then give its private approval link to the person.`,
      });
      return;
    }
    if (command === "connect" && !handle) {
      const projectId = value("project");
      if (!projectId)
        throw inputError(
          "project_required",
          "Use --project with an existing claimed project ID, or publish a new game first.",
        );
      handle = {
        version: 1,
        api_base_url: api.apiBaseUrl,
        project_id: projectId,
      };
    }
    if (!handle)
      throw inputError(
        "state_missing",
        "Publish a game or connect --project <id> first.",
      );
    if (value("project") && value("project") !== handle.project_id)
      throw inputError(
        "project_mismatch",
        "This state belongs to another project. Choose a separate --state file.",
      );
    const path = credentialPath(statePath, handle);
    outsideBuild(path, directory);
    await prepareCredentials(path);
    let credentials = (await readState<Credentials>(path)) ?? {
      api_base_url: api.apiBaseUrl,
      project_id: handle.project_id,
    };
    if (
      credentials.api_base_url !== api.apiBaseUrl ||
      credentials.project_id !== handle.project_id
    )
      throw inputError(
        "credential_mismatch",
        "The saved credential does not belong to this project and API origin.",
      );
    const status = async () => {
      if (!credentials.agent_token)
        throw inputError(
          "connection_required",
          "Run rosebud connect, then ask the person to sign in and approve access.",
        );
      return api.status({
        projectId: handle.project_id,
        agentToken: credentials.agent_token,
      });
    };
    if (command === "connect") {
      if (credentials.agent_token) {
        const current = await status();
        if (current.status === "active" || current.status === "pending") {
          output({
            ...current,
            ...(current.status === "pending"
              ? { approval_url: credentials.approval_url }
              : {}),
          });
          return;
        }
      }
      const connection = await api.connect({
        projectId: handle.project_id,
        client: client as AgentClient,
        ...(credentials.claim_secret
          ? { claimSecret: credentials.claim_secret }
          : {}),
      });
      credentials = {
        ...credentials,
        agent_token: connection.agent_token,
        approval_url: connection.approval_url,
      };
      await saveState(path, credentials);
      await saveState(statePath, handle);
      output({
        project_id: handle.project_id,
        status: connection.status,
        approval_url: connection.approval_url,
        expires_at: connection.expires_at,
        claim_expires_at: handle.claim_expires_at,
      });
      return;
    }
    if (command === "status") {
      const current = await status();
      if (current.status === "active") {
        if (!handle.content_version && current.content_version)
          handle.content_version = current.content_version;
        if (current.play_url) handle.play_url = current.play_url;
        delete handle.claim_expires_at;
        await saveState(statePath, handle);
        delete credentials.claim_secret;
        delete credentials.approval_url;
        await saveState(path, credentials);
      }
      output({
        ...current,
        saved_content_version: handle.content_version,
        ...(current.status === "pending"
          ? { approval_url: credentials.approval_url }
          : {}),
      });
      return;
    }
    if (!credentials.agent_token)
      throw inputError(
        "connection_required",
        "Run rosebud connect and have the person approve access.",
      );
    if (command === "disconnect") {
      await api.disconnect({
        projectId: handle.project_id,
        agentToken: credentials.agent_token,
      });
      delete credentials.agent_token;
      delete credentials.approval_url;
      await saveState(path, credentials);
      output({ project_id: handle.project_id, status: "revoked" });
      return;
    }
    const expectedVersion = value("expected-version") ?? handle.content_version;
    if (!expectedVersion)
      throw inputError(
        "version_required",
        "Run status after approval to establish this connection's initial version.",
      );
    const bytes = await prepareBundle(input);
    const cover = metadata.thumbnail
      ? await readCover(metadata.thumbnail)
      : undefined;
    const fingerprint = createHash("sha256")
      .update(bytes)
      .update(
        JSON.stringify({
          ...metadata,
          thumbnail: cover
            ? createHash("sha256").update(cover).digest("hex")
            : null,
          expectedVersion,
        }),
      )
      .digest("hex");
    if (
      credentials.pending &&
      credentials.pending.fingerprint !== fingerprint &&
      !value("expected-version")
    )
      throw inputError(
        "pending_operation",
        "A previous update has an uncertain outcome. Retry its identical input, or check status, reconcile changes and explicitly provide --expected-version for a new update.",
      );
    const resuming = credentials.pending?.fingerprint === fingerprint;
    const pending =
      credentials.pending?.fingerprint === fingerprint
        ? credentials.pending
        : {
            operation_id: randomUUID(),
            fingerprint,
            expected_version: expectedVersion,
          };
    credentials.pending = pending;
    await saveState(path, credentials);
    try {
      const result = await api.update({
        ...input,
        ...metadata,
        projectId: handle.project_id,
        agentToken: credentials.agent_token,
        expectedVersion: pending.expected_version,
        operationId: pending.operation_id,
      });
      handle.content_version = result.content_version;
      handle.play_url = result.play_url;
      await saveState(statePath, handle);
      delete credentials.pending;
      await saveState(path, credentials);
      output(result);
    } catch (error) {
      if (
        error instanceof RosebudError &&
        error.outcome !== "unknown" &&
        !resuming
      ) {
        delete credentials.pending;
        await saveState(path, credentials);
      }
      throw error;
    }
  });
}

type Value = (name: string) => string | undefined;

function output(result: object): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

/** Account and asset commands have no project, so no saved origin applies. */
function apiBase(value: Value): string {
  return (
    (value("api-base") ?? process.env.ROSEBUD_API_BASE) || defaultApiBaseUrl
  );
}

async function readAccount(
  path: string,
  apiBaseUrl: string,
): Promise<AccountCredentials | undefined> {
  const saved = await readState<AccountCredentials>(path);
  if (
    saved &&
    (saved.version !== 1 ||
      saved.api_base_url !== apiBaseUrl ||
      typeof saved.token !== "string")
  )
    throw inputError(
      "credential_mismatch",
      "The saved login does not belong to this API origin.",
    );
  return saved;
}

/** A login's status, plus its private approval link while it waits for the person. */
function loginView(current: LoginStatus, saved: AccountCredentials): object {
  return {
    ...current,
    ...(current.status === "pending" && saved.approval_url
      ? { approval_url: saved.approval_url }
      : {}),
  };
}

/** Rosebud no longer knows the token, as after a pending login expires. */
function unknownToken(error: unknown): boolean {
  return (
    error instanceof RosebudError &&
    error.kind === "api" &&
    error.status === 401
  );
}

async function account(
  command: string,
  value: Value,
  client: AgentClient,
): Promise<void> {
  const api = new Rosebud({
    apiBaseUrl: apiBase(value),
    timeoutMs: Number(value("timeout-ms") ?? 120000),
  });
  const path = accountPath(api.apiBaseUrl);
  await prepareCredentials(path);
  await withStateLock(path, async () => {
    const saved = await readAccount(path, api.apiBaseUrl);
    if (command === "login") {
      if (saved) {
        let current: LoginStatus | undefined;
        try {
          current = await api.loginStatus({ token: saved.token });
        } catch (error) {
          if (!unknownToken(error)) throw error;
        }
        if (current?.status === "active" || current?.status === "pending") {
          output({
            ...loginView(current, saved),
            next_action:
              current.status === "active"
                ? "Already logged in. To use another account, run rosebud logout, then rosebud login."
                : "This login still waits for approval. Give the person its private approval_url.",
          });
          return;
        }
      }
      const name = value("name");
      const login = await api.login({
        client,
        ...(name !== undefined ? { name } : {}),
      });
      await saveState(path, {
        version: 1,
        api_base_url: api.apiBaseUrl,
        login_id: login.login_id,
        token: login.token,
        approval_url: login.approval_url,
      });
      output({
        status: login.status,
        approval_url: login.approval_url,
        expires_at: login.expires_at,
        next_action:
          "Give the private approval_url to the person. After they sign in and approve, run rosebud whoami, then make assets.",
      });
      return;
    }
    if (!saved)
      throw inputError(
        "login_required",
        "No saved login for this API origin. Run rosebud login first.",
      );
    if (command === "whoami") {
      const current = await api.loginStatus({ token: saved.token });
      if (current.status === "active" && saved.approval_url) {
        delete saved.approval_url;
        await saveState(path, saved);
      }
      output(loginView(current, saved));
      return;
    }
    try {
      await api.logout({ token: saved.token });
    } catch (error) {
      if (!unknownToken(error)) throw error;
    }
    await removeState(path);
    output({ status: "revoked" });
  });
}

async function assets(
  positionals: string[],
  value: Value,
  values: { input?: unknown; force?: unknown; "no-wait"?: unknown },
): Promise<void> {
  const subcommand = positionals[1] ?? "";
  const creating = subcommand === "create";
  const waitMs = Number(value("timeout-ms") ?? (creating ? 600000 : 120000));
  const deadline = Date.now() + waitMs;
  const api = new Rosebud({
    apiBaseUrl: apiBase(value),
    timeoutMs: Math.min(waitMs, 120000),
  });
  if (subcommand === "models") {
    const category = value("category");
    output(await api.assetModels(category !== undefined ? { category } : {}));
    return;
  }
  const force = values.force === true,
    wait = values["no-wait"] !== true;
  const out = value("out") !== undefined ? resolve(value("out") ?? "") : "";
  const maxCredits = value("max-credits");
  if (maxCredits !== undefined && !/^\d{1,15}$/.test(maxCredits))
    throw inputError(
      "max_credits",
      "Use --max-credits with a whole number of credits.",
    );
  if (subcommand === "download" && !out)
    throw inputError(
      "out_required",
      "Use --out <file> to choose where to save the asset.",
    );
  if (creating && out && !wait)
    throw inputError(
      "usage",
      "--out needs the finished file. Remove --no-wait, or save it later with rosebud assets download.",
    );
  if (out && (creating || subcommand === "download"))
    await checkOut(out, force);
  const saved = await readAccount(accountPath(api.apiBaseUrl), api.apiBaseUrl);
  if (!saved)
    throw inputError(
      "login_required",
      "Run rosebud login and give its private approval link to the person. After they approve, run this command again.",
    );
  const token = saved.token;
  try {
    if (subcommand === "status") {
      output(await api.assetJob({ token, jobId: positionals[2] ?? "" }));
      return;
    }
    if (subcommand === "list") {
      const query = value("query"),
        category = value("category");
      output(
        await api.listAssets({
          token,
          ...(query !== undefined ? { query } : {}),
          ...(category !== undefined ? { category } : {}),
        }),
      );
      return;
    }
    if (subcommand === "download") {
      const asset = await api.asset({ token, assetId: positionals[2] ?? "" });
      errorContext.asset_id = asset.id;
      await api.downloadAsset({
        url: asset.url,
        path: out,
        token,
        overwrite: force,
      });
      output({ ...asset, file: out });
      return;
    }
    const model = value("model");
    if (!model)
      throw inputError(
        "model_required",
        "Use --model with an id from rosebud assets models.",
      );
    const input = await assetInput(
      api,
      model,
      value("prompt"),
      Array.isArray(values.input) ? (values.input as string[]) : [],
      value("input-json"),
    );
    if (subcommand === "quote") {
      output(await api.quoteAsset({ token, model, input }));
      return;
    }
    await createAsset(api, {
      token,
      model,
      input,
      out,
      force,
      wait,
      deadline,
      ...(maxCredits !== undefined ? { maxCredits: Number(maxCredits) } : {}),
    });
  } catch (error) {
    if (unknownToken(error))
      throw new RosebudError(
        "Rosebud did not accept the saved login. Run rosebud whoami: a pending login still needs the person to approve its approval_url, and after revoked or expired, run rosebud login again.",
        {
          kind: "api",
          code: (error as RosebudError).code,
          outcome: (error as RosebudError).outcome,
          status: 401,
        },
      );
    throw error;
  }
}

async function checkOut(path: string, force: boolean): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile())
      throw inputError(
        "out_path",
        "--out must name a file, not a directory or link.",
      );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
  if (!force)
    throw inputError(
      "file_exists",
      "--out already exists. Choose another path, or pass --force to replace it.",
    );
}

/** Map --prompt and --input name=value onto the inputs the model lists. */
async function assetInput(
  api: Rosebud,
  model: string,
  prompt: string | undefined,
  pairs: string[],
  jsonPath: string | undefined,
): Promise<Record<string, JsonValue>> {
  let input: Record<string, JsonValue> = {};
  if (jsonPath !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(jsonPath, "utf8"));
    } catch {
      parsed = undefined;
    }
    if (!isObject(parsed))
      throw inputError(
        "input_json",
        "Provide a readable JSON file holding an object of model inputs.",
      );
    input = parsed as Record<string, JsonValue>;
  }
  const fields = new Map(
    (await api.assetModel({ model })).inputs.map((field) => [
      field.name,
      field,
    ]),
  );
  const unknown = () =>
    inputError(
      "unknown_input",
      `${model} takes these inputs: ${[...fields.keys()].join(", ")}. Run rosebud assets models for their descriptions.`,
    );
  const once = (name: string) => {
    if (name in input)
      throw inputError(
        "input",
        `Set ${name} once, with --prompt, --input or --input-json.`,
      );
  };
  for (const pair of pairs) {
    const split = pair.indexOf("=");
    if (split < 1) throw inputError("input", "Use --input name=value.");
    const name = pair.slice(0, split),
      raw = pair.slice(split + 1);
    const field = fields.get(name);
    if (!field) throw unknown();
    once(name);
    if (field.type === "integer" || field.type === "number") {
      const number = Number(raw);
      if (
        !raw.trim() ||
        !Number.isFinite(number) ||
        (field.type === "integer" && !Number.isSafeInteger(number))
      )
        throw inputError(
          "input",
          `${name} must be ${field.type === "integer" ? "a whole number" : "a number"}.`,
        );
      input[name] = number;
    } else if (field.type === "boolean") {
      if (raw !== "true" && raw !== "false")
        throw inputError("input", `${name} must be true or false.`);
      input[name] = raw === "true";
    } else if (Array.isArray(field.values) && !field.values.includes(raw))
      throw inputError(
        "input",
        `${name} must be one of: ${field.values.join(", ")}.`,
      );
    else input[name] = raw;
  }
  if (prompt !== undefined) {
    if (!fields.has("prompt")) throw unknown();
    once("prompt");
    input.prompt = prompt;
  }
  if (Object.keys(input).some((name) => !fields.has(name))) throw unknown();
  return input;
}

/**
 * Quote, then start a job under an idempotency key saved first, then wait for it.
 * The saved request lives until the outcome is known, so rerunning an identical
 * command resumes the same job instead of paying again.
 */
async function createAsset(
  api: Rosebud,
  options: {
    token: string;
    model: string;
    input: Record<string, JsonValue>;
    out: string;
    force: boolean;
    wait: boolean;
    deadline: number;
    maxCredits?: number;
  },
): Promise<void> {
  const { token, input, maxCredits } = options;
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        options.model,
        Object.keys(input)
          .sort()
          .map((key) => [key, input[key]]),
      ]),
    )
    .digest("hex");
  const path = assetRequestPath(api.apiBaseUrl, fingerprint);
  await prepareCredentials(path);
  await withStateLock(path, async () => {
    let saved = await readState<AssetRequest>(path);
    if (
      saved &&
      (saved.version !== 1 ||
        saved.api_base_url !== api.apiBaseUrl ||
        saved.fingerprint !== fingerprint)
    )
      throw inputError(
        "state_format",
        "This saved asset request is not supported.",
      );
    const resuming = saved !== undefined;
    let job: AssetJob;
    if (saved?.job_id) {
      errorContext.job_id = saved.job_id;
      job = await api.assetJob({ token, jobId: saved.job_id });
    } else {
      if (!saved) {
        const quote = await api.quoteAsset({
          token,
          model: options.model,
          input,
        });
        if (maxCredits !== undefined && quote.credits > maxCredits)
          throw inputError(
            "max_credits",
            `This asset costs ${quote.credits} credits, more than --max-credits ${maxCredits}. No job was started.`,
          );
        saved = {
          version: 1,
          api_base_url: api.apiBaseUrl,
          fingerprint,
          quote_id: quote.id,
          idempotency_key: randomUUID(),
          credits: quote.credits,
        };
        await saveState(path, saved);
      } else if (maxCredits !== undefined && saved.credits > maxCredits)
        throw inputError(
          "max_credits",
          `The saved request costs ${saved.credits} credits, more than --max-credits ${maxCredits}, so it was not sent again. Its earlier attempt may have started a job.`,
        );
      try {
        job = await api.createAssetJob({
          token,
          quoteId: saved.quote_id,
          idempotencyKey: saved.idempotency_key,
        });
      } catch (error) {
        // A rejection proves no job holds this key, unless a retry was refused
        // (auth, throttling) before Rosebud looked the key up.
        if (
          error instanceof RosebudError &&
          error.outcome !== "unknown" &&
          !(resuming && [401, 403, 429].includes(error.status ?? 0))
        )
          await removeState(path);
        throw error;
      }
      errorContext.job_id = job.id;
      if (options.wait) {
        saved.job_id = job.id;
        await saveState(path, saved);
      }
    }
    if (!options.wait) {
      await removeState(path);
      output({
        ...job,
        next_action: `Run rosebud assets status ${job.id} until it succeeds, then rosebud assets download <asset id> --out <file>.`,
      });
      return;
    }
    let delay = 1000;
    while (job.status === "queued" || job.status === "running") {
      const remaining = options.deadline - Date.now();
      if (remaining <= 0)
        throw new RosebudError(
          `Job ${job.id} is still ${job.status}. Rerun the identical command to keep waiting without paying again, or check it with rosebud assets status ${job.id}.`,
          { kind: "response", code: "job_unfinished", outcome: "unknown" },
        );
      await sleep(Math.min(delay, remaining));
      delay = Math.min(delay * 1.5, 10000);
      try {
        job = await api.assetJob({ token, jobId: job.id });
      } catch (error) {
        // Reading a job is safe to repeat, so brief outages only delay the next poll.
        if (
          !(error instanceof RosebudError) ||
          (error.outcome !== "unknown" && error.status !== 429)
        )
          throw error;
      }
    }
    if (job.status !== "succeeded") {
      await removeState(path);
      const error: Record<string, unknown> = isObject(job.error)
        ? job.error
        : {};
      throw new RosebudError(
        typeof error.message === "string"
          ? error.message
          : `The job ended with status ${job.status}.`,
        {
          kind: "api",
          code: typeof error.code === "string" ? error.code : "job_failed",
          outcome: "rejected",
        },
      );
    }
    if (options.out) {
      if (!job.asset)
        throw new RosebudError(
          `Job ${job.id} succeeded without a file to download. Check it with rosebud assets status ${job.id}.`,
          { kind: "response", code: "unexpected_response", outcome: "unknown" },
        );
      errorContext.asset_id = job.asset.id;
      await api.downloadAsset({
        url: job.asset.url,
        path: options.out,
        token,
        overwrite: options.force,
      });
    }
    await removeState(path);
    output({
      ...job,
      ...(resuming ? { resumed: true } : {}),
      ...(options.out ? { file: options.out } : {}),
    });
  });
}

/** Server-validated diagnostics worth showing; never the raw response body. */
function apiDetails(error: RosebudError): {
  filename?: string;
  limit?: number;
} {
  const body = error.body;
  if (
    error.kind !== "api" ||
    !body ||
    typeof body !== "object" ||
    Array.isArray(body)
  )
    return {};
  const details = body.error;
  if (!details || typeof details !== "object" || Array.isArray(details))
    return {};
  const { filename, limit } = details;
  return {
    ...(typeof filename === "string" && filename.length <= 512
      ? { filename }
      : {}),
    ...(typeof limit === "number" && Number.isSafeInteger(limit)
      ? { limit }
      : {}),
  };
}

main().catch((error: unknown) => {
  const known =
    error instanceof RosebudError
      ? error
      : new RosebudError(
          "Could not complete the command. Check local state before retrying; no automatic retry was attempted.",
          { kind: "response", code: "unexpected_error", outcome: "unknown" },
        );
  process.stderr.write(
    `${JSON.stringify({ error: { kind: known.kind, code: known.code, message: known.message, outcome: known.outcome, ...(known.status !== undefined ? { status: known.status } : {}), ...apiDetails(known), ...errorContext } })}\n`,
  );
  process.exitCode =
    known.outcome === "unknown"
      ? 4
      : known.kind === "input"
        ? 2
        : known.kind === "api"
          ? 3
          : 4;
});

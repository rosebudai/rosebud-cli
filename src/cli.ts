#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { prepareBundle } from "./bundle.js";
import { Rosebud, RosebudError, readCover } from "./index.js";
import type {
  AdoptionContext,
  AgentClient,
  BundleInput,
  GameMetadata,
} from "./index.js";
import { inputError } from "./errors.js";
import {
  credentialPath,
  outsideBuild,
  prepareCredentials,
  readState,
  saveState,
  withStateLock,
} from "./state.js";
import type { Credentials, ProjectHandle } from "./state.js";

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
];

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
        help: { type: "boolean" },
        version: { type: "boolean" },
      },
    });
  } catch {
    throw inputError("usage", "Invalid arguments. Run rosebud --help.");
  }
  const seen = new Set<string>();
  for (const token of args.tokens ?? []) {
    if (token.kind === "option") {
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
  const command = positionals[0];
  if (
    positionals.length !== 1 ||
    !["publish", "connect", "status", "update", "disconnect"].includes(
      command ?? "",
    )
  )
    throw inputError(
      "usage",
      "Choose publish, connect, status, update or disconnect.",
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
    const output = (result: object) =>
      process.stdout.write(`${JSON.stringify(result)}\n`);
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
    `${JSON.stringify({ error: { kind: known.kind, code: known.code, message: known.message, outcome: known.outcome, ...(known.status !== undefined ? { status: known.status } : {}), ...apiDetails(known) } })}\n`,
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

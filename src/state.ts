import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import nodePath, { dirname, join, resolve } from "node:path";
import type { PlatformPath } from "node:path";
import { inputError } from "./errors.js";

export interface ProjectHandle {
  version: 1;
  api_base_url: string;
  project_id: string;
  play_url?: string;
  claim_expires_at?: string;
  content_version?: string;
}
export interface Credentials {
  api_base_url: string;
  project_id: string;
  claim_secret?: string;
  agent_token?: string;
  approval_url?: string;
  pending?: {
    operation_id: string;
    fingerprint: string;
    expected_version: string;
  };
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Whether a file's permission bits let other users read it. Windows has no POSIX
 * permission bits (files always report 0o666); there the files sit in the user's
 * profile, whose access control lists already keep other accounts out.
 */
export function exposedToOtherUsers(
  mode: number,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32" && (mode & 0o077) !== 0;
}

export async function readState<T>(path: string): Promise<T | undefined> {
  try {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      exposedToOtherUsers(info.mode)
    )
      throw inputError(
        "state_permissions",
        "State and credential files must be regular private files (mode 0600).",
      );
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (missing(error)) return undefined;
    throw inputError(
      "state_unreadable",
      "Could not read private Rosebud state. Check its JSON and file permissions.",
    );
  }
}
export async function saveState(
  path: string,
  data: ProjectHandle | Credentials,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw inputError(
        "state_path",
        "Refusing to replace a nonregular state file.",
      );
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(`${JSON.stringify(data, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary);
    throw error;
  }
}
export function credentialPath(
  statePath: string,
  handle: ProjectHandle,
): string {
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        resolve(statePath),
        handle.api_base_url,
        handle.project_id,
      ]),
    )
    .digest("hex");
  return join(
    process.env.ROSEBUD_CREDENTIALS_DIR ??
      join(homedir(), ".config", "rosebud", "credentials"),
    `${key}.json`,
  );
}
export async function prepareCredentials(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const info = await lstat(dirname(path));
  if (!info.isDirectory() || info.isSymbolicLink())
    throw inputError(
      "credentials_path",
      "Use a private credential directory, without symlinks.",
    );
  await chmod(dirname(path), 0o700);
}
/** `paths` defaults to the running platform; tests pass `path.win32` or `path.posix`. */
export function outsideBuild(
  path: string,
  directory: string | undefined,
  paths: PlatformPath = nodePath,
): void {
  if (directory === undefined) return;
  const child = paths.relative(paths.resolve(directory), paths.resolve(path));
  if (
    child === "" ||
    (child !== ".." &&
      !child.startsWith(`..${paths.sep}`) &&
      !paths.isAbsolute(child))
  )
    throw inputError(
      "state_in_build",
      "The upload folder can't contain the CLI's saved state (--state, default .rosebud/project.json) or credentials. Publish the game's build folder, not the project root. No build step? Copy the game's files into a folder such as ./dist and publish that.",
    );
}
export async function withStateLock<T>(
  path: string,
  action: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  let file;
  try {
    file = await open(lock, "wx", 0o600);
  } catch {
    throw inputError(
      "state_locked",
      "Another command is using this state. If a previous process crashed, confirm it stopped before removing the .lock file.",
    );
  }
  try {
    await file.writeFile(`${process.pid}\n`);
    return await action();
  } finally {
    await file.close();
    await unlink(lock);
  }
}

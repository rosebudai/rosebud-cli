import { constants, unlinkSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
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
  /** Path to MD5 of every file in the last release or pull; absent for a handle from 0.1.0. */
  files?: Record<string, string>;
  /** Paths Rosebud holds as media; absent for a handle from 0.1.0. */
  media?: string[];
  /** The folder `files` describes, absolute; a pull into any other folder ignores `files`. */
  directory?: string;
  /**
   * The last pull's unresolved conflicts, with the version it read. Until a pull
   * reports none, update needs --expected-version, even when the saved version is current.
   */
  pull_conflicts?: { content_version: string; paths: string[] };
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
/** The account login, one per API origin, kept apart from project credentials. */
export interface AccountCredentials {
  version: 1;
  api_base_url: string;
  login_id: string;
  token: string;
  approval_url?: string;
}
/** An asset create saved before its job is sent, so a retry cannot pay twice. */
export interface AssetRequest {
  version: 1;
  api_base_url: string;
  fingerprint: string;
  quote_id: string;
  idempotency_key: string;
  credits: number;
  job_id?: string;
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
  data: ProjectHandle | Credentials | AccountCredentials | AssetRequest,
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
export async function removeState(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!missing(error)) throw error;
  }
}
function credentialFile(name: string, parts: string[]): string {
  const key = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return join(
    process.env.ROSEBUD_CREDENTIALS_DIR ??
      join(homedir(), ".config", "rosebud", "credentials"),
    `${name}${key}.json`,
  );
}
export function credentialPath(
  statePath: string,
  handle: ProjectHandle,
): string {
  return credentialFile("", [
    resolve(statePath),
    handle.api_base_url,
    handle.project_id,
  ]);
}
export function accountPath(apiBaseUrl: string): string {
  return credentialFile("account-", [apiBaseUrl]);
}
export function assetRequestPath(
  apiBaseUrl: string,
  fingerprint: string,
): string {
  return credentialFile("asset-", [apiBaseUrl, fingerprint]);
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
/** Locks this process holds, so a signal that stops it can release them. */
const heldLocks = new Set<string>();
/** Remove every lock this process holds; for a signal handler, so synchronous. */
export function releaseLocks(): void {
  for (const lock of heldLocks)
    try {
      unlinkSync(lock);
    } catch {
      // Already gone.
    }
  heldLocks.clear();
}
/** The process id a lock names, when it names one. */
async function lockOwner(lock: string): Promise<number | undefined> {
  const text = await readFile(lock, "utf8").catch(() => "");
  return /^\d{1,10}\n?$/.test(text) ? Number(text.trim()) : undefined;
}
function running(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 only asks whether the process exists
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return !(
      error instanceof Error &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}
/**
 * Create the lock, or take it over from a process that no longer runs: a command
 * killed outright (as an agent's timeout does) can't remove its own. The stale
 * lock is moved aside, not deleted, so of two commands taking it over at once only
 * one succeeds, and a live lock moved by mistake is put back.
 */
async function claimLock(lock: string): Promise<FileHandle> {
  const locked = (pid?: number) =>
    inputError(
      "state_locked",
      pid === undefined
        ? "Another command is using this state. If a previous process crashed, confirm it stopped before removing the .lock file."
        : `Another rosebud command (process ${pid}) is using this state. Wait for it to finish, then run this one again.`,
    );
  try {
    return await open(lock, "wx", 0o600);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw locked();
  }
  const pid = await lockOwner(lock);
  if (pid === undefined || pid === process.pid || running(pid))
    throw locked(pid);
  const aside = `${lock}.${randomUUID()}.stale`;
  try {
    await rename(lock, aside);
  } catch {
    throw locked(); // another command took it over first
  }
  if ((await lockOwner(aside)) !== pid) {
    await link(aside, lock).catch(() => undefined);
    await unlink(aside).catch(() => undefined);
    throw locked();
  }
  await unlink(aside);
  try {
    return await open(lock, "wx", 0o600);
  } catch {
    throw locked();
  }
}
export async function withStateLock<T>(
  path: string,
  action: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  const file = await claimLock(lock);
  heldLocks.add(lock);
  try {
    await file.writeFile(`${process.pid}\n`);
    return await action();
  } finally {
    await file.close();
    await unlink(lock);
    heldLocks.delete(lock);
  }
}

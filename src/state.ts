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
/** Remove every lock this process holds, returning how many; for a signal handler, so synchronous. */
export function releaseLocks(): number {
  const count = heldLocks.size;
  for (const lock of heldLocks)
    try {
      unlinkSync(lock);
    } catch {
      // Already gone.
    }
  heldLocks.clear();
  return count;
}
/** A lock's text: undefined when there is no lock, "" when it can't be read. */
async function lockText(lock: string): Promise<string | undefined> {
  try {
    return await readFile(lock, "utf8");
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
      ? undefined
      : "";
  }
}
/** The process id a lock names, when it names one. */
const ownerOf = (text: string | undefined) =>
  text !== undefined && /^\d{1,10}\n?$/.test(text)
    ? Number(text.trim())
    : undefined;
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
 * Whether a lock's process has gone. One naming this process but not held by it
 * is left from an earlier process that had the same id. A lock that names no
 * process, as while its owner is still writing its id, is never stale.
 */
function stale(lock: string, pid: number | undefined): boolean {
  if (pid === undefined) return false;
  return pid === process.pid ? !heldLocks.has(lock) : !running(pid);
}
/** Create `path` exclusively, recording it as held before anything can interrupt. */
async function create(path: string): Promise<FileHandle | undefined> {
  let file: FileHandle;
  try {
    file = await open(path, "wx", 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      return undefined;
    throw error;
  }
  heldLocks.add(path);
  return file;
}
async function release(path: string, file: FileHandle): Promise<void> {
  await file.close();
  await unlink(path);
  heldLocks.delete(path);
}
/**
 * Remove a stale lock that names `pid`. It is moved aside first and checked, so a
 * live lock that took its place in the meantime is put back rather than deleted.
 */
async function removeStale(path: string, pid: number): Promise<boolean> {
  const aside = `${path}.${randomUUID()}.stale`;
  try {
    await rename(path, aside);
  } catch {
    return false;
  }
  if (ownerOf(await lockText(aside)) !== pid) {
    await link(aside, path).catch(() => undefined);
    await unlink(aside).catch(() => undefined);
    return false;
  }
  await unlink(aside);
  return true;
}
/**
 * Create the lock, or take it over from a process that no longer runs: a command
 * killed outright (as an agent's timeout does) can't remove its own. Takeovers
 * run one at a time under a guard file, and under it the lock is read again, so
 * two commands can never both replace it. A guard left by a takeover that was
 * itself killed is stale the same way.
 */
async function claimLock(lock: string): Promise<FileHandle> {
  const locked = (pid?: number) =>
    inputError(
      "state_locked",
      pid === undefined
        ? "Another command is using this state. If a previous process crashed, confirm it stopped before removing the .lock file."
        : `Another rosebud command (process ${pid}) is using this state. Wait for it to finish, then run this one again.`,
    );
  const take = async () => {
    try {
      return await create(lock);
    } catch {
      throw locked();
    }
  };
  const first = await take();
  if (first) return first;
  const seen = ownerOf(await lockText(lock));
  if (!stale(lock, seen)) throw locked(seen);
  const guardPath = `${lock}.takeover`;
  let guard = await create(guardPath).catch(() => undefined);
  if (!guard) {
    const holder = ownerOf(await lockText(guardPath));
    if (
      !stale(guardPath, holder) ||
      !(await removeStale(guardPath, holder ?? 0))
    )
      throw locked();
    guard = await create(guardPath).catch(() => undefined);
    if (!guard) throw locked();
  }
  try {
    await guard.writeFile(`${process.pid}\n`);
    // Only a takeover removes a lock, and this is the only one running: the lock
    // is now gone, held by a live process, or still stale.
    const text = await lockText(lock);
    if (text !== undefined) {
      const owner = ownerOf(text);
      if (!stale(lock, owner) || !(await removeStale(lock, owner ?? 0)))
        throw locked(owner);
    }
    const file = await take();
    if (!file) throw locked();
    return file;
  } finally {
    await release(guardPath, guard);
  }
}
export async function withStateLock<T>(
  path: string,
  action: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  const file = await claimLock(lock);
  try {
    await file.writeFile(`${process.pid}\n`);
    return await action();
  } finally {
    await release(lock, file);
  }
}

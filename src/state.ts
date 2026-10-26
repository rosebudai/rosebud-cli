import { constants, readFileSync, unlinkSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import nodePath, { basename, dirname, join, resolve } from "node:path";
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
/** Whether `path` is `directory` or inside it. */
function within(
  path: string,
  directory: string,
  paths: PlatformPath = nodePath,
): boolean {
  const child = paths.relative(paths.resolve(directory), paths.resolve(path));
  return (
    child === "" ||
    (child !== ".." &&
      !child.startsWith(`..${paths.sep}`) &&
      !paths.isAbsolute(child))
  );
}
const stateInBuild = () =>
  inputError(
    "state_in_build",
    "The upload folder can't contain the CLI's saved state (--state, default .rosebud/project.json) or credentials. Publish the game's build folder, not the project root. No build step? Copy the game's files into a folder such as ./dist and publish that.",
  );
/** `paths` defaults to the running platform; tests pass `path.win32` or `path.posix`. */
export function outsideBuild(
  path: string,
  directory: string | undefined,
  paths: PlatformPath = nodePath,
): void {
  if (directory !== undefined && within(path, directory, paths))
    throw stateInBuild();
}
/**
 * A path as the disk resolves it, for comparing places: links in the part that
 * exists are resolved and its names take the disk's spelling; the rest is kept
 * as given. Letter case and Unicode form are folded, so two spellings the disk
 * might store as one compare equal: refusing them is safe, overlapping is not.
 */
async function diskPlace(path: string): Promise<string> {
  const rest: string[] = [];
  let current = resolve(path);
  let found = current;
  for (;;) {
    try {
      found = join(await realpath(current), ...rest);
      break;
    } catch {
      const parent = dirname(current);
      if (parent === current) break;
      rest.unshift(basename(current));
      current = parent;
    }
  }
  return found.normalize("NFC").toUpperCase().toLowerCase();
}
/** Whether `path` is `directory` or inside it once links are resolved, as the disk sees them. */
export async function withinOnDisk(
  path: string,
  directory: string,
): Promise<boolean> {
  return within(await diskPlace(path), await diskPlace(directory));
}
/** outsideBuild, also through a linked parent or another spelling of a name. */
export async function outsideBuildOnDisk(
  path: string,
  directory: string | undefined,
): Promise<void> {
  outsideBuild(path, directory);
  if (directory !== undefined && (await withinOnDisk(path, directory)))
    throw stateInBuild();
}
/** Lock files this process holds, each with its text, so a signal that stops it can release them. */
const heldLocks = new Map<string, string>();
/** Remove every lock this process holds, returning how many; for a signal handler, so synchronous. */
export function releaseLocks(): number {
  const count = heldLocks.size;
  for (const [lock, text] of heldLocks)
    try {
      if (readFileSync(lock, "utf8") === text) unlinkSync(lock);
    } catch {
      // Already gone.
    }
  heldLocks.clear();
  return count;
}
/** A lock's text: its process id, then a token unique to this lock. */
const LOCK_TEXT = /^(\d{1,10})(?: ([0-9a-f-]{36}))?\n?$/;
/** How long a lock may stay empty while it is written; an older empty one lost its process. */
const EMPTY_LOCK_MS = 10_000;
interface LockRead {
  text: string;
  ageMs: number;
  /** The file is there but couldn't be read: its holder is unknown, so it is held. */
  unreadable?: true;
}
/** A lock's text and age; undefined when there is none. An unreadable one is flagged, never judged empty. */
async function readLock(path: string): Promise<LockRead | undefined> {
  try {
    const text = await readFile(path, "utf8");
    return { text, ageMs: Date.now() - (await lstat(path)).mtimeMs };
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
      ? undefined
      : { text: "", ageMs: 0, unreadable: true };
  }
}
const ownerOf = (text: string) => {
  const match = LOCK_TEXT.exec(text);
  return match ? Number(match[1]) : undefined;
};
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
 * Whether a lock's process has gone. One naming this process that it doesn't hold
 * was left by an earlier process with the same id. A lock that names no process is
 * stale only once it has been empty for a while: its creator was killed at once.
 */
function stale(path: string, lock: LockRead): boolean {
  if (lock.unreadable) return false;
  const pid = ownerOf(lock.text);
  if (pid === undefined) return lock.text === "" && lock.ageMs > EMPTY_LOCK_MS;
  return pid === process.pid
    ? heldLocks.get(path) !== lock.text
    : !running(pid);
}
/**
 * Create the lock file `path`, holding this process's id and a fresh token. It is
 * written aside and linked into place, so it never exists empty; a disk that
 * can't link gets an exclusive create in place instead. Returns false when it
 * already exists.
 */
async function createLock(path: string): Promise<boolean> {
  const text = `${process.pid} ${randomUUID()}\n`;
  const aside = `${path}.${randomUUID()}.tmp`;
  await writeFile(aside, text, { flag: "wx", mode: 0o600 });
  try {
    await link(aside, path);
    heldLocks.set(path, text);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      return false;
    // Any other failure means this disk can't link (Windows exFAT and SMB shares
    // report EISDIR or EINVAL, others EPERM or ENOTSUP). The in-place create below
    // is exclusive too, and fails if the lock is there, so it is safe to try;
    // the file is empty for an instant.
    let file;
    try {
      file = await open(path, "wx", 0o600);
    } catch (inPlace) {
      if (
        inPlace instanceof Error &&
        "code" in inPlace &&
        inPlace.code === "EEXIST"
      )
        return false;
      throw inPlace;
    }
    heldLocks.set(path, text);
    try {
      await file.writeFile(text);
    } finally {
      await file.close();
    }
    return true;
  } finally {
    await unlink(aside).catch(() => undefined);
  }
}
/** Remove a lock this process holds; one removed by hand meanwhile is simply gone. */
async function releaseLock(path: string): Promise<void> {
  try {
    if ((await readFile(path, "utf8")) === heldLocks.get(path))
      await unlink(path);
  } catch {
    // Gone already, or can't be removed: its process ends, so it is stale either way.
  } finally {
    heldLocks.delete(path);
  }
}
/**
 * Remove the stale lock `path` whose text was `seen`. Of all the commands that
 * found it stale, only the one that creates its claim file may remove it: no
 * other can, so it is still there when that one looks again. A claim left by a
 * takeover that was itself killed is stale and taken over the same way. Returns
 * false when a live command is already taking it over.
 */
async function takeOver(
  path: string,
  seen: string,
  depth = 0,
): Promise<boolean> {
  const match = LOCK_TEXT.exec(seen);
  const instance = match
    ? (match[2] ?? match[1])
    : createHash("sha256").update(seen).digest("hex").slice(0, 16);
  const claim = `${path}.${instance}.claim`;
  for (let attempt = 0; attempt < 3 && depth < 8; attempt += 1) {
    if (await createLock(claim))
      try {
        const now = await readLock(path);
        // An unreadable lock is never "the same empty one": its holder is unknown.
        if (now && !now.unreadable && now.text === seen) await unlink(path);
        return true;
      } finally {
        await releaseLock(claim);
      }
    const holder = await readLock(claim);
    if (holder === undefined) continue; // released just now: try again
    if (
      !stale(claim, holder) ||
      !(await takeOver(claim, holder.text, depth + 1))
    )
      return false;
  }
  return false;
}
/**
 * Create the lock, or take it over from a process that no longer runs: a command
 * killed outright (as an agent's timeout does) can't remove its own.
 */
async function claimLock(lock: string): Promise<void> {
  const locked = (pid?: number) =>
    inputError(
      "state_locked",
      pid === undefined
        ? "Another command is using this state. If a previous process crashed, confirm it stopped before removing the .lock file."
        : `Another rosebud command (process ${pid}) is using this state. Wait for it to finish, then run this one again.`,
    );
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let created: boolean;
    try {
      created = await createLock(lock);
    } catch {
      throw locked();
    }
    if (created) return;
    const current = await readLock(lock);
    if (current === undefined) continue; // released just now: try again
    if (!stale(lock, current)) throw locked(ownerOf(current.text));
    if (!(await takeOver(lock, current.text).catch(() => false)))
      throw locked();
  }
  throw locked();
}
export async function withStateLock<T>(
  path: string,
  action: () => Promise<T>,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  await claimLock(lock);
  try {
    return await action();
  } finally {
    await releaseLock(lock);
  }
}

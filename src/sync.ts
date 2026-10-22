import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { inputError, RosebudError } from "./errors.js";
import type { GameFiles, Rosebud } from "./index.js";

export type ConflictReason =
  "both_changed" | "local_deleted" | "remote_deleted";
export interface PullPlan {
  /** Paths to take from Rosebud. */
  write: string[];
  /** Local files Rosebud deleted, unchanged here since the last sync. */
  remove: string[];
  /** Changed on both sides; the local copy stays. */
  conflicts: { path: string; reason: ConflictReason }[];
  /** Files Rosebud never had; they stay and go up with the next update. */
  localOnly: string[];
}
const LOCAL_LIMIT = 10_000;
const UNSAFE = /[<>:"\\|?*\u0000-\u001f\u007f]/u;

/**
 * Compare Rosebud's files, the folder and the last sync (each path → MD5).
 * Without a last sync every difference is a conflict, so nothing local is lost.
 */
export function planPull(
  remote: ReadonlyMap<string, string>,
  local: ReadonlyMap<string, string>,
  base: ReadonlyMap<string, string> | undefined,
  force = false,
): PullPlan {
  const plan: PullPlan = {
    write: [],
    remove: [],
    conflicts: [],
    localOnly: [],
  };
  for (const path of [...new Set([...remote.keys(), ...local.keys()])].sort()) {
    const r = remote.get(path),
      l = local.get(path),
      b = base?.get(path);
    if (r === l) continue;
    if (r !== undefined) {
      if (l === undefined) {
        if (b === undefined || force) plan.write.push(path);
        else if (b !== r)
          plan.conflicts.push({ path, reason: "local_deleted" });
        // b === r: deleted here and unchanged in Rosebud; the next update deletes it.
      } else if (l === b || force) plan.write.push(path);
      else if (r !== b) plan.conflicts.push({ path, reason: "both_changed" });
      // r === b: changed here only; the next update sends it.
    } else if (b === undefined) plan.localOnly.push(path);
    else if (l === b || force) plan.remove.push(path);
    else plan.conflicts.push({ path, reason: "remote_deleted" });
  }
  return plan;
}

/** A relative path that stays inside the folder on every platform. */
export function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 500 &&
    path
      .split("/")
      .every(
        (part) =>
          part !== "" &&
          part !== ".." &&
          !part.startsWith(".") &&
          part.length <= 255 &&
          !UNSAFE.test(part),
      )
  );
}

const md5Of = (bytes: Uint8Array) =>
  createHash("md5").update(bytes).digest("hex");
async function md5File(path: string): Promise<string> {
  const hash = createHash("md5");
  // O_NOFOLLOW: a file swapped for a link after the walk is not read.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    for await (const chunk of file.createReadStream() as AsyncIterable<Buffer>)
      hash.update(chunk);
  } finally {
    await file.close();
  }
  return hash.digest("hex");
}

const linkRefused = (path: string) =>
  inputError(
    "unsupported_input",
    `Remove symbolic links and special files from the folder: ${path}`,
  );

/** Every file in the folder, path → MD5. Links are refused, never followed. */
async function localFiles(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  async function walk(path: string): Promise<void> {
    for (const name of (await readdir(join(root, path))).sort()) {
      const child = path ? `${path}/${name}` : name;
      const info = await lstat(join(root, child));
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
        throw linkRefused(child);
      if (info.isDirectory()) await walk(child);
      else {
        if (found.size >= LOCAL_LIMIT)
          throw inputError(
            "entry_limit",
            `Pull into the game's own folder; this one holds more than ${LOCAL_LIMIT} files.`,
          );
        found.set(child, await md5File(join(root, child)));
      }
    }
  }
  try {
    if (!(await lstat(root)).isDirectory())
      throw inputError(
        "unsupported_input",
        "Use a folder, without a symbolic link at its root.",
      );
  } catch (error) {
    if (error instanceof RosebudError) throw error;
    await mkdir(root, { recursive: true }); // a new folder is fine
  }
  await walk("");
  return found;
}

/** The target's folders exist and none is a link, so a write lands inside `root`. */
async function prepareTarget(root: string, path: string): Promise<string> {
  const parts = path.split("/");
  let current = root;
  await mkdir(root, { recursive: true });
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const info = await lstat(current).catch(() => undefined);
    if (!info) await mkdir(current);
    else if (info.isSymbolicLink()) throw linkRefused(path);
    else if (!info.isDirectory())
      throw inputError(
        "path_conflict",
        `${part} is a file here but a folder in Rosebud. Rename or remove it, then pull again: ${path}`,
      );
  }
  return join(root, ...parts);
}

async function writeAtomically(
  target: string,
  bytes: Uint8Array,
): Promise<void> {
  const temporary = `${target}.${randomUUID()}.part`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/** Move a verified download into place; across devices it is copied first. */
async function place(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EXDEV"))
      throw error;
    const temporary = `${to}.${randomUUID()}.part`;
    try {
      await copyFile(from, temporary);
      await rename(temporary, to);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    await unlink(from);
  }
}

const corrupt = (path: string) =>
  new RosebudError(`${path} arrived damaged. Run rosebud pull again.`, {
    kind: "response",
    code: "download_corrupt",
    outcome: "unknown",
  });

/**
 * Bring Rosebud's files into `directory`. Local edits stay; Rosebud's copies of
 * files changed on both sides are saved under `remoteCopies`, never in the folder.
 * Every download is checked before it touches the folder, and a failure part-way
 * leaves nothing that a rerun would mistake for a local edit.
 */
export async function pullInto(options: {
  api: Rosebud;
  game: GameFiles;
  /** Absolute. */
  directory: string;
  /** Absolute, outside `directory`; emptied on every pull. */
  remoteCopies: string;
  base?: Record<string, string>;
  force: boolean;
}): Promise<{
  plan: PullPlan;
  skipped: { path: string; reason: "unsafe_path" }[];
  /** Rosebud's manifest: path → MD5. */
  files: Record<string, string>;
  media: string[];
  /** Conflicting path → Rosebud's copy on disk. */
  copies: Record<string, string>;
}> {
  const { api, game, directory, remoteCopies } = options;
  const inside = relative(remoteCopies, directory);
  if (
    inside === "" ||
    (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
  )
    throw inputError(
      "state_in_build",
      "--directory can't sit inside the folder where pull saves Rosebud's copies (the --state file's name without .json, plus .remote). Choose another folder.",
    );
  const skipped: { path: string; reason: "unsafe_path" }[] = [];
  const texts = new Map<string, Uint8Array>();
  const media = new Map<string, GameFiles["media"][number]>();
  const remote = new Map<string, string>();
  for (const file of game.files) {
    if (!safePath(file.path) || remote.has(file.path)) {
      skipped.push({ path: file.path, reason: "unsafe_path" });
      continue;
    }
    const bytes = new TextEncoder().encode(file.content);
    texts.set(file.path, bytes);
    remote.set(file.path, md5Of(bytes));
  }
  for (const file of game.media) {
    if (!safePath(file.path) || remote.has(file.path) || media.has(file.path)) {
      skipped.push({ path: file.path, reason: "unsafe_path" });
      continue;
    }
    media.set(file.path, file);
    if (file.md5 !== null) remote.set(file.path, file.md5);
  }
  const local = await localFiles(directory);
  await rm(remoteCopies, { recursive: true, force: true });
  const incoming = join(remoteCopies, ".incoming");
  /** Downloaded and checked, outside the folder; fetched once, whatever it is needed for. */
  const held = new Map<string, { to: string; md5: string }>();
  const download = async (path: string) => {
    const file = media.get(path);
    if (!file) throw corrupt(path);
    const to = join(incoming, randomUUID());
    await api.downloadAsset({ url: file.url, path: to, overwrite: true });
    const md5 = await md5File(to);
    if (file.md5 !== null && md5 !== file.md5) throw corrupt(path);
    const got = { to, md5 };
    held.set(path, got);
    return got;
  };
  try {
    // A file without a recorded MD5 is downloaded now to learn it.
    for (const [path, file] of media)
      if (file.md5 === null) remote.set(path, (await download(path)).md5);
    const plan = planPull(
      remote,
      local,
      options.base ? new Map(Object.entries(options.base)) : undefined,
      options.force,
    );
    const fetchTo = async (path: string, target: string) => {
      const text = texts.get(path);
      if (text) return writeAtomically(target, text);
      await place((held.get(path) ?? (await download(path))).to, target);
    };
    const copies = Object.create(null) as Record<string, string>;
    for (const { path, reason } of plan.conflicts) {
      if (reason === "remote_deleted") continue;
      const copy = await prepareTarget(remoteCopies, path);
      await fetchTo(path, copy);
      copies[path] = copy;
    }
    for (const path of plan.write)
      await fetchTo(path, await prepareTarget(directory, path));
    for (const path of plan.remove)
      await unlink(await prepareTarget(directory, path));
    return {
      plan,
      skipped,
      files: Object.fromEntries(remote),
      media: [...media.keys()].sort(),
      copies,
    };
  } finally {
    await rm(incoming, { recursive: true, force: true });
    await rmdir(remoteCopies).catch(() => undefined); // only when empty
  }
}

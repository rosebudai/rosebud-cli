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
import { join } from "node:path";
import { isOsJunk } from "./bundle.js";
import { inputError, RosebudError } from "./errors.js";
import { withinOnDisk } from "./state.js";
import type { GameFiles, Rosebud } from "./index.js";

export type ConflictReason =
  | "both_changed"
  | "local_deleted"
  | "remote_deleted"
  /**
   * Rosebud's name and a local file or folder that stays differ only by letter case,
   * on a disk that stores them as one: writing Rosebud's would replace or rename it.
   */
  | "case_conflict"
  /** Two of Rosebud's names would land on one file or folder on this disk, so neither is written. */
  | "name_collision";
/** Why a path Rosebud holds was not brought in; a duplicate keeps its first copy. */
export type SkipReason = "unsafe_path" | "duplicate_path";
export interface PullPlan {
  /** Paths to take from Rosebud. */
  write: string[];
  /** Local files Rosebud deleted, unchanged here since the last sync. */
  remove: string[];
  /** Changed on both sides; the local copy stays. */
  conflicts: {
    path: string;
    reason: ConflictReason;
    /** The other name: the local file or folder for a case_conflict, another of Rosebud's for a name_collision. */
    clashesWith?: string;
  }[];
  /** Files Rosebud never had; they stay and go up with the next update. */
  localOnly: string[];
  /**
   * In Rosebud and the last sync, unchanged in Rosebud, but not here: deleted here
   * on purpose or lost. The next update deletes them from the game; --force restores them.
   */
  missing: string[];
  /** A path to write → the local file it lands on, when this disk spells that file differently. */
  localNames: Map<string, string>;
}
/** How the disk under the folder compares names. */
export interface DiskNames {
  /** One key for every spelling this disk stores as the same file. Default: exact names. */
  fold?: (path: string) => string;
  /** Every folder in the local folder, empty ones included; by default, those of the local files. */
  folders?: Iterable<string>;
}
const LOCAL_LIMIT = 10_000;
/** What an interrupted download leaves behind: `name.<uuid>.part`. */
const LEFTOVER =
  /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.part$/i;
const UNSAFE = /[<>:"\\|?*\u0000-\u001f\u007f]/u;

const byPath = (a: { path: string }, b: { path: string }) =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
/** Every folder a path sits in, outermost first: a/b/c → a, a/b. */
const foldersOf = (path: string) =>
  path
    .split("/")
    .slice(0, -1)
    .map((_, index, parts) => parts.slice(0, index + 1).join("/"));
/** Whether two names with the same key differ by more than Unicode form: by letter case, on a disk that folds it. */
const caseDiffers = (a: string, b: string) =>
  a.normalize("NFC") !== b.normalize("NFC");

/**
 * Compare Rosebud's files, the folder and the last sync (each path → MD5).
 * Without a last sync every difference is a conflict, so nothing local is lost.
 * `force` settles conflicts for Rosebud and restores files missing here; an edit
 * or new file made only here is never touched.
 *
 * Names are matched by `disk.fold` (see `diskNames`): a local file spelled
 * differently from Rosebud's is the same file, so an edit to it is never
 * overwritten unseen. A difference in letter case counts as a change of name,
 * compared with the last sync like any other change; a difference only in Unicode
 * form does not, and Rosebud's text lands on the local file under its local name.
 */
export function planPull(
  remote: ReadonlyMap<string, string>,
  local: ReadonlyMap<string, string>,
  base: ReadonlyMap<string, string> | undefined,
  force = false,
  disk: DiskNames = {},
): PullPlan {
  const fold = disk.fold ?? ((path: string) => path);
  const plan: PullPlan = {
    write: [],
    remove: [],
    conflicts: [],
    localOnly: [],
    missing: [],
    localNames: new Map(),
  };
  // Rosebud names that would land on one file or folder here, like Foo.js and
  // foo.js, or Scripts/a.js and scripts/b.js: writing both would silently keep one.
  const spellings = new Map<string, Map<string, string>>();
  for (const path of [...remote.keys()].sort())
    for (const name of [...foldersOf(path), path]) {
      const seen = spellings.get(fold(name)) ?? new Map<string, string>();
      if (!seen.has(name)) seen.set(name, path);
      spellings.set(fold(name), seen);
    }
  const colliding = new Set<string>();
  for (const path of remote.keys())
    for (const name of [...foldersOf(path), path]) {
      const other = [...(spellings.get(fold(name)) ?? [])].find(
        ([spelling]) => spelling !== name,
      );
      if (!other) continue;
      plan.conflicts.push({
        path,
        reason: "name_collision",
        clashesWith: other[1],
      });
      colliding.add(fold(path));
      break;
    }
  const index = (paths: Iterable<string>) => {
    const keyed = new Map<string, string[]>();
    for (const path of paths)
      if (!colliding.has(fold(path)))
        keyed.set(fold(path), [...(keyed.get(fold(path)) ?? []), path]);
    return keyed;
  };
  const remoteBy = index(remote.keys()),
    localBy = index(local.keys()),
    baseBy = index(base?.keys() ?? []);
  const take = (path: string, from?: string) => {
    plan.write.push(path);
    if (from !== undefined && caseDiffers(from, path)) plan.remove.push(from);
    else if (from !== undefined && from !== path)
      plan.localNames.set(path, from);
  };
  // R, L and B are one file's names in Rosebud, here and at the last sync.
  const decide = (R?: string, L?: string, B?: string) => {
    const r = R === undefined ? undefined : remote.get(R),
      l = L === undefined ? undefined : local.get(L),
      b = B === undefined ? undefined : base?.get(B);
    // The same content under the same name, give or take its Unicode form.
    const same = (x?: string, X?: string, y?: string, Y?: string) =>
      x === y && (X === undefined || Y === undefined || !caseDiffers(X, Y));
    if (R === undefined) {
      if (L === undefined) return;
      if (B === undefined) plan.localOnly.push(L);
      else if (same(l, L, b, B) || force) plan.remove.push(L);
      else plan.conflicts.push({ path: L, reason: "remote_deleted" });
    } else if (L === undefined) {
      // The folder never lists a junk-named file, so after the first pull it is ignored, not missing.
      if (B !== undefined && isOsJunk(R.slice(R.lastIndexOf("/") + 1))) return;
      if (B === undefined || force) take(R);
      else if (!same(b, B, r, R))
        plan.conflicts.push({ path: R, reason: "local_deleted" });
      else plan.missing.push(R);
    } else if (same(r, R, l, L)) {
      // Already the same file and content.
    } else if (B !== undefined && same(l, L, b, B)) take(R, L);
    else if (B !== undefined && same(r, R, b, B)) {
      // Changed here only (perhaps renamed by case); the next update sends it.
    } else if (!caseDiffers(L, R)) {
      if (force) take(R, L);
      else plan.conflicts.push({ path: R, reason: "both_changed" });
    } else if (force && B !== undefined && !caseDiffers(L, B)) take(R, L);
    // Renamed by case on one side and changed on the other, or a file of the
    // agent's own under another case: --force never replaces that.
    else
      plan.conflicts.push({ path: R, reason: "case_conflict", clashesWith: L });
  };
  for (const key of new Set([...remoteBy.keys(), ...localBy.keys()])) {
    const R = remoteBy.get(key)?.[0];
    const locals = localBy.get(key) ?? [];
    const bases = baseBy.get(key) ?? [];
    if (locals.length > 1) {
      // Only when the key is coarser than the disk, which keeps these apart: match exactly.
      for (const name of new Set([...(R === undefined ? [] : [R]), ...locals]))
        decide(
          remote.has(name) ? name : undefined,
          local.has(name) ? name : undefined,
          base?.has(name) ? name : undefined,
        );
      continue;
    }
    const L = locals[0];
    const B =
      bases.find((name) => name === L) ??
      bases.find((name) => name === R) ??
      bases[0];
    decide(R, L, B);
  }
  // A folder here whose name differs by case from Rosebud's would take the file
  // under its own spelling, and the next update would rename it in Rosebud.
  const folderBy = new Map<string, string>();
  for (const folder of [
    ...(disk.folders ?? []),
    ...[...local.keys()].flatMap(foldersOf),
  ])
    folderBy.set(fold(folder), folder);
  const renamedFrom = new Map(
    plan.write.flatMap((path) => {
      const L = localBy.get(fold(path))?.[0];
      return L !== undefined && plan.remove.includes(L) ? [[path, L]] : [];
    }),
  );
  plan.write = plan.write.filter((path) => {
    if (plan.localNames.has(path)) return true;
    for (const name of foldersOf(path)) {
      const here = folderBy.get(fold(name));
      if (here === undefined) continue;
      if (caseDiffers(here, name)) {
        plan.conflicts.push({
          path,
          reason: "case_conflict",
          clashesWith: here,
        });
        const from = renamedFrom.get(path);
        if (from !== undefined)
          plan.remove.splice(plan.remove.indexOf(from), 1);
        return false;
      }
    }
    return true;
  });
  // Folders spelled only in another Unicode form are the same folders: write into them as they are.
  for (const path of plan.write) {
    if (plan.localNames.has(path)) continue;
    const parts = path.split("/");
    const named = parts.map((part, at) =>
      at === parts.length - 1
        ? part
        : (folderBy
            .get(fold(parts.slice(0, at + 1).join("/")))
            ?.split("/")
            .at(-1) ?? part),
    );
    if (named.join("/") !== path) plan.localNames.set(path, named.join("/"));
  }
  for (const list of [plan.write, plan.remove, plan.localOnly, plan.missing])
    list.sort();
  plan.conflicts.sort(byPath);
  return plan;
}

/** Names Windows reserves for devices, with any extension, and names it would trim. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
/**
 * A relative path that stays inside the folder on every platform, and that this
 * platform saves under the same name: Windows drops a trailing dot or space, and
 * writes names such as `con.js` to a device.
 */
export function safePath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
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
          !UNSAFE.test(part) &&
          (platform !== "win32" ||
            (!/[. ]$/.test(part) && !WINDOWS_DEVICE.test(part))),
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

const pathConflict = (what: string) =>
  inputError("path_conflict", `${what}. Rename or remove it, then pull again.`);
const linkRefused = (path: string) =>
  inputError(
    "unsupported_input",
    `Remove symbolic links and special files from the folder: ${path}`,
  );

/**
 * Every game file in the folder, path → MD5. Links are refused, never followed.
 * Hidden entries, leftover temporary files and regular files named like OS junk
 * (Thumbs.db, desktop.ini) are not game files, so they are never listed. Pull never
 * writes a hidden name, but Rosebud may hold a junk-named file: pull writes it, and
 * since the folder then ignores it, the next update leaves it out of the game.
 * Update skips junk the same way and refuses other hidden entries with unsafe_path.
 */
async function localFiles(root: string): Promise<{
  files: Map<string, string>;
  folders: string[];
  /** Hidden entries other than OS junk, which update would refuse. */
  hidden: string[];
}> {
  const found = new Map<string, string>();
  const folders: string[] = [];
  const hidden: string[] = [];
  async function walk(path: string): Promise<void> {
    for (const name of (await readdir(join(root, path))).sort()) {
      const child = path ? `${path}/${name}` : name;
      if (name.startsWith(".")) {
        if (!(isOsJunk(name) && (await lstat(join(root, child))).isFile()))
          hidden.push(child);
        continue;
      }
      if (LEFTOVER.test(name)) continue;
      const info = await lstat(join(root, child));
      if (isOsJunk(name) && info.isFile()) continue;
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
        throw linkRefused(child);
      if (info.isDirectory()) {
        folders.push(child);
        await walk(child);
      } else {
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
  return { files: found, folders, hidden };
}

/**
 * How names are matched. Unicode form (an accented letter as one character or two)
 * never counts, on any disk: Rosebud names every file in NFC and an update sends
 * each name so, so two local names differing only in form are one file to Rosebud.
 * Letter case counts unless the disk folds it, as macOS and Windows disks do by
 * default; that is learned once per pull from a scratch file in `scratch`, so
 * nothing is ever created in the game's folder. When `scratch` sits on another
 * disk than the folder, the answer can't speak for the folder, so case is folded:
 * refusing a pair of names the disk could have kept apart is safe, overwriting one
 * with the other is not.
 */
export async function diskNames(
  directory: string,
  scratch: string,
): Promise<(path: string) => string> {
  let foldsCase = true;
  try {
    await mkdir(scratch, { recursive: true });
    if ((await lstat(directory)).dev === (await lstat(scratch)).dev) {
      const probe = join(scratch, randomUUID());
      await writeFile(`${probe}-A`, "", { flag: "wx" });
      try {
        foldsCase = await lstat(`${probe}-a`).then(
          () => true,
          () => false,
        );
      } finally {
        await unlink(`${probe}-A`);
      }
    }
  } catch {
    // A disk that can't be asked is treated as folding case, the safe side.
    foldsCase = true;
  }
  return (path) => {
    const form = path.normalize("NFC");
    // Upper then lower case covers more pairs than either alone (ß and SS, ſ and s).
    return foldsCase ? form.toUpperCase().toLowerCase() : form;
  };
}

/**
 * A last check, for a folder whose case rules differ from the probe's (a per-folder
 * setting on Windows and Linux): writing `foo.js` must not replace a local `Foo.js`
 * that stays. Asking the disk about the exact target, only when a name clashes,
 * catches that. A file this pull removes is no rival.
 */
async function protectCaseRenames(
  directory: string,
  plan: PullPlan,
  local: ReadonlyMap<string, string>,
): Promise<void> {
  const loose = (path: string) => path.normalize("NFC").toLowerCase();
  const removing = new Set(plan.remove);
  const staying = new Map<string, string>();
  for (const path of local.keys())
    if (!removing.has(path)) staying.set(loose(path), path);
  const kept: string[] = [];
  for (const path of plan.write) {
    const target = plan.localNames.get(path) ?? path;
    const rival = staying.get(loose(target));
    if (
      rival !== undefined &&
      rival !== target &&
      // A file of this very name is the target itself, as when the disk keeps Foo.js and foo.js apart.
      !local.has(target) &&
      (await lstat(join(directory, ...target.split("/"))).then(
        () => true,
        () => false,
      ))
    )
      plan.conflicts.push({
        path,
        reason: "case_conflict",
        clashesWith: rival,
      });
    else kept.push(path);
  }
  plan.write = kept;
  plan.conflicts.sort(byPath);
}

/** The target's folders exist and none is a link, so a write lands inside `root`. */
async function prepareTarget(root: string, path: string): Promise<string> {
  const parts = path.split("/");
  let current = root;
  await mkdir(root, { recursive: true });
  for (const [index, part] of parts.slice(0, -1).entries()) {
    current = join(current, part);
    const info = await lstat(current).catch(() => undefined);
    if (!info) await mkdir(current);
    else if (info.isSymbolicLink()) throw linkRefused(path);
    else if (!info.isDirectory())
      throw pathConflict(
        `${parts.slice(0, index + 1).join("/")} is a file here but a folder in Rosebud, which holds ${path}`,
      );
  }
  const target = join(root, ...parts);
  if ((await lstat(target).catch(() => undefined))?.isDirectory())
    throw pathConflict(`${path} is a folder here but a file in Rosebud`);
  return target;
}

/** Move a staged file into place; across devices it is copied beside the target first. */
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
  /** The last sync of this folder; ignored when the folder holds no files. */
  base?: Record<string, string>;
  force: boolean;
}): Promise<{
  plan: PullPlan;
  skipped: { path: string; reason: SkipReason }[];
  /**
   * The new last sync, path → MD5: Rosebud's manifest, except that a conflicted
   * file keeps its old entry, so pulling again still reports it rather than
   * mistaking the unmerged local file for an ordinary local edit.
   */
  files: Record<string, string>;
  media: string[];
  /** Conflicting path → Rosebud's copy on disk. */
  copies: Record<string, string>;
  /** Hidden entries in the folder, other than OS junk: update refuses them. */
  hidden: string[];
}> {
  const { api, game, directory, remoteCopies } = options;
  // Resolved on disk: through a linked parent, the folder could be the copies'
  // folder, which is emptied below.
  if (
    (await withinOnDisk(directory, remoteCopies)) ||
    (await withinOnDisk(remoteCopies, directory))
  )
    throw inputError(
      "state_in_build",
      "--directory can't be, hold or sit inside the folder where pull saves Rosebud's copies (the --state file's name without .json, plus .remote). Choose another folder.",
    );
  const skipped: { path: string; reason: SkipReason }[] = [];
  const texts = new Map<string, Uint8Array>();
  const media = new Map<string, GameFiles["media"][number]>();
  const remote = new Map<string, string>();
  for (const file of game.files) {
    if (!safePath(file.path) || remote.has(file.path)) {
      skipped.push({
        path: file.path,
        reason: safePath(file.path) ? "duplicate_path" : "unsafe_path",
      });
      continue;
    }
    const bytes = new TextEncoder().encode(file.content);
    texts.set(file.path, bytes);
    remote.set(file.path, md5Of(bytes));
  }
  for (const file of game.media) {
    const duplicate = remote.has(file.path) || media.has(file.path);
    if (!safePath(file.path) || duplicate) {
      skipped.push({
        path: file.path,
        reason: safePath(file.path) ? "duplicate_path" : "unsafe_path",
      });
      continue;
    }
    media.set(file.path, file);
    if (file.md5 !== null) remote.set(file.path, file.md5);
  }
  const { files: local, folders, hidden } = await localFiles(directory);
  await rm(remoteCopies, { recursive: true, force: true });
  const incoming = join(remoteCopies, ".incoming");
  /** Downloaded and checked, outside the folder; fetched once, whatever it is needed for. */
  const held = new Map<string, { to: string; md5: string }>();
  const download = async (path: string) => {
    const file = media.get(path);
    if (!file) throw corrupt(path);
    const to = join(incoming, randomUUID());
    const size = await api.downloadAsset({
      url: file.url,
      path: to,
      overwrite: true,
    });
    const md5 = await md5File(to);
    // Without an MD5, the size is all there is to check a download against.
    if (
      (file.size !== null && size !== file.size) ||
      (file.md5 !== null && md5 !== file.md5)
    )
      throw corrupt(path);
    const got = { to, md5 };
    held.set(path, got);
    return got;
  };
  try {
    const fold = await diskNames(directory, incoming);
    // A file without a recorded MD5 is downloaded now to learn it.
    for (const [path, file] of media)
      if (file.md5 === null) remote.set(path, (await download(path)).md5);
    // An empty or new folder has nothing of a last sync in it, whatever was saved.
    const base =
      options.base && local.size > 0
        ? new Map(Object.entries(options.base))
        : undefined;
    const plan = planPull(remote, local, base, options.force, {
      fold,
      folders,
    });
    await protectCaseRenames(directory, plan, local);
    /** Rosebud's copy of a file, checked, beside the downloads, so the folder never holds a half-written file. */
    const stage = async (path: string) => {
      const text = texts.get(path);
      if (!text) return (held.get(path) ?? (await download(path))).to;
      const to = join(incoming, randomUUID());
      await mkdir(incoming, { recursive: true });
      await writeFile(to, text, { flag: "wx" });
      return to;
    };
    const fetchTo = async (
      path: string,
      target: string,
      from?: string,
    ): Promise<void> => {
      from ??= await stage(path);
      try {
        await place(from, target);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          ["EISDIR", "ENOTDIR", "EEXIST"].includes(String(error.code))
        )
          throw pathConflict(`${path} is a file and a folder at once`);
        throw error;
      }
    };
    const copies = Object.create(null) as Record<string, string>;
    let apart = 0;
    for (const { path, reason } of plan.conflicts) {
      if (reason === "remote_deleted") continue;
      // Colliding names would collide in the copies' folder too, so each gets its
      // own; a leading dot keeps these folders clear of any name Rosebud can hold.
      const copy = await prepareTarget(
        remoteCopies,
        reason === "name_collision"
          ? `.name_collision/${(apart += 1)}/${path}`
          : path,
      );
      await fetchTo(path, copy);
      copies[path] = copy;
    }
    // Every write is staged before the folder changes: a failed download must not
    // follow a removal, such as a case rename's old name, which a rerun would take
    // for a file deleted here.
    const staged = new Map<string, string>();
    for (const path of plan.write) staged.set(path, await stage(path));
    // The folder was read before the downloads. A file edited or created here
    // meanwhile is the agent's own: stop before changing anything, and a rerun
    // compares it like any other edit.
    const byKey = new Map([...local.keys()].map((path) => [fold(path), path]));
    // A folder that was already here is path_conflict's to refuse, below.
    const walked = new Set(folders.map(fold));
    const checked = new Set<string>();
    for (const path of [
      ...plan.remove,
      ...plan.write.map((path) => plan.localNames.get(path) ?? path),
    ]) {
      const was = local.has(path) ? path : byKey.get(fold(path));
      if (was !== undefined && checked.has(was)) continue;
      const absolute = join(directory, ...(was ?? path).split("/"));
      const changed =
        was === undefined
          ? !walked.has(fold(path)) &&
            (await lstat(absolute).then(
              () => true,
              () => false,
            ))
          : (await md5File(absolute).catch(() => undefined)) !== local.get(was);
      if (changed)
        throw inputError(
          "folder_changed",
          `${was ?? path} changed while pull was downloading, so pull left the folder as it was. Run rosebud pull again.`,
        );
      if (was !== undefined) checked.add(was);
    }
    // Removals first: on a case-insensitive disk a file Rosebud renamed by case
    // is both removed and written, and the write must come last.
    for (const path of plan.remove)
      await unlink(await prepareTarget(directory, path));
    for (const path of plan.write)
      await fetchTo(
        path,
        await prepareTarget(directory, plan.localNames.get(path) ?? path),
        staged.get(path),
      );
    const conflicted = new Set(plan.conflicts.map(({ path }) => fold(path)));
    const files = new Map(
      [...remote].filter(([path]) => !conflicted.has(fold(path))),
    );
    for (const [path, md5] of base ?? [])
      if (conflicted.has(fold(path))) files.set(path, md5);
    return {
      plan,
      skipped,
      files: Object.fromEntries(files),
      media: [...media.keys()].sort(),
      copies,
      hidden,
    };
  } finally {
    await rm(incoming, { recursive: true, force: true });
    await rmdir(remoteCopies).catch(() => undefined); // only when empty
  }
}

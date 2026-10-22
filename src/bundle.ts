import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { zipSync } from "fflate";
import type { Zippable } from "fflate";
import { inputError, RosebudError } from "./errors.js";

const ZIP_BYTES = 10 * 1024 * 1024;
const EXPANDED_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 500;
/** Rosebud's limit for one file (MAX_FILE_SIZE_MB), the same as the editor's uploads. */
export const FILE_BYTES = 19 * 1024 * 1024;
/** The ceiling for one game on every plan (PROJECT_GAME_LIMITS). */
export const GAME_FILES = 2000;
export const GAME_BYTES = 1024 * 1024 * 1024;
// Directories count too, so a walk stops long before an accidental home folder is read.
const WALK_LIMIT = 2 * GAME_FILES;
/** Media Rosebud validates and stores as files; exact case, as on the server. */
const MEDIA_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".wav",
  ".mp3",
  ".webp",
  ".svg",
  ".ogg",
  ".oga",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".wasm",
  ".glb",
  ".gltf",
  ".bin",
]);
/** Rosebud keeps these as text unless they sit under assets/ (or it already holds them as media). */
const TEXT_OUTSIDE_ASSETS = new Set([".svg", ".gltf"]);
// The editor's file-name rules, plus no hidden names (they are usually .env or .git).
const UNSAFE_NAME = /[<>:"/\\|?*\u0000-\u001f\u007f]/u;
/** What operating systems scatter through folders; never game files, so never uploaded or refused. */
const OS_JUNK = new Set([".ds_store", "thumbs.db", "desktop.ini"]);
export const isOsJunk = (name: string): boolean =>
  OS_JUNK.has(name.toLowerCase());

export interface MediaFile {
  /** Relative path inside the game, such as assets/hero.png. */
  path: string;
  /** The file on disk, read again when it is uploaded. */
  absolute: string;
  size: number;
  /** 32 lowercase hex digits. */
  md5: string;
}
export interface PreparedRelease {
  /** Text files; without splitting, every file and folder, as in 0.1.0. */
  zip: Uint8Array;
  /** Media to declare in an upload session; empty without splitting. */
  media: MediaFile[];
  /** Every file in the release, path to MD5. Unknown for a ZIP the CLI didn't build. */
  files?: Record<string, string>;
  /** The paths Rosebud will store as media. */
  mediaPaths?: string[];
}

const md5Of = (bytes: Uint8Array) =>
  createHash("md5").update(bytes).digest("hex");

function checkName(name: string, path: string): void {
  // Usually a project root was published instead of its build folder.
  if (name.startsWith("."))
    throw inputError(
      "unsafe_path",
      `Hidden files and folders can't be uploaded: ${path}. Publish a folder that holds only the game's files, such as a copy in ./dist.`,
    );
  if (!name.trim())
    throw inputError(
      "unsafe_path",
      `Rename ${path}: a name can't be only spaces.`,
    );
  if (UNSAFE_NAME.test(name) || name.length > 255 || path.length > 500)
    throw inputError(
      "unsafe_path",
      `Rename ${path}: names can't contain < > : " | ? * or control characters, names are at most 255 characters and paths at most 500.`,
    );
}

/** Credentials and dependencies, matched as Rosebud does: trimmed, and in any case. */
function excluded(name: string): boolean {
  const key = name.trim().toLowerCase();
  return (
    EXCLUDED.has(key) ||
    key.includes("firebase-adminsdk") ||
    key.endsWith(".env")
  );
}

function checkText(content: Uint8Array, path: string): void {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    text = "\u0000";
  }
  if (text.includes("\u0000"))
    throw inputError(
      "unsupported_file",
      `${path} is not UTF-8 text. Put binary media under assets/ with a media extension: PNG, JPEG, WebP, SVG, WAV, MP3, OGG/OGA, WOFF/WOFF2, TTF/OTF, WASM, GLB/glTF or BIN.`,
    );
}

async function digest(
  absolute: string,
  path: string,
): Promise<{ size: number; md5: string }> {
  const hash = createHash("md5");
  let size = 0;
  // O_NOFOLLOW: a file swapped for a link after the walk is not read.
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await file.stat()).isFile())
      throw inputError("unsupported_input", `Use a regular file: ${path}`);
    for await (const chunk of file.createReadStream() as AsyncIterable<Buffer>) {
      size += chunk.byteLength;
      if (size > FILE_BYTES)
        throw inputError(
          "file_limit",
          `Reduce ${path} to at most ${FILE_BYTES} bytes, Rosebud's limit for one file.`,
        );
      hash.update(chunk);
    }
  } finally {
    await file.close();
  }
  return { size, md5: hash.digest("hex") };
}

function validateMediaPath(path: string, extension: string): void {
  if (!path.startsWith("assets/"))
    throw inputError(
      "media_path",
      `Put binary media under assets/ and update its references: ${path}`,
    );
  // Mirror normalize_project_asset_path: it lowercases and hyphenates but
  // leaves Unicode letters alone. Renaming silently would break references
  // inside code and model files.
  const segments = path
    .slice(0, -extension.length)
    .split("/")
    .map((segment) =>
      segment
        .toLowerCase()
        .replace(/\./g, " ")
        .replace(/[-\s]+/g, "-")
        .replace(/^[-_]+|[-_]+$/g, ""),
    );
  if (segments.some((segment) => !segment))
    throw inputError(
      "noncanonical_path",
      `Use media names containing a letter or number: ${path}`,
    );
  const canonical = `${segments.join("/")}${extension}`;
  if (canonical !== path)
    throw inputError(
      "noncanonical_path",
      `Rename ${path} and its references to ${canonical}.`,
    );
}

const EXCLUDED = new Set([
  "node_modules",
  "credentials",
  "secrets",
  "credentials.json",
  "service-account.json",
  "service_account.json",
]);

async function readBounded(path: string, limit: number): Promise<Uint8Array> {
  // O_NOFOLLOW prevents a last-moment file symlink from being packaged.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile())
      throw inputError("unsupported_input", `Use a regular file: ${path}`);
    if (stat.size > limit)
      throw inputError(
        "size_limit",
        `Reduce ${path}; the remaining size limit is ${limit} bytes.`,
      );
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(65536, limit - total + 1));
      const { bytesRead } = await file.read(chunk);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit)
        throw inputError(
          "size_limit",
          `Reduce ${path}; the remaining size limit is ${limit} bytes.`,
        );
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return new Uint8Array(Buffer.concat(chunks));
  } finally {
    await file.close();
  }
}

async function packDirectory(
  directory: string,
  split: boolean,
  knownMedia: ReadonlySet<string>,
  knownText: ReadonlySet<string>,
): Promise<PreparedRelease> {
  const root = resolve(directory);
  if (!(await lstat(root)).isDirectory())
    throw inputError(
      "unsupported_input",
      "Use a build directory, without a symbolic link at its root.",
    );
  const zipped: Zippable = Object.create(null) as Zippable;
  const media: MediaFile[] = [];
  const mediaPaths: string[] = [];
  const files: Record<string, string> = {};
  let walked = 0;
  let entries = 0;
  let count = 0;
  let zippedBytes = 0;
  let total = 0;
  let hasIndex = false;
  const entryAdded = () => {
    entries += 1;
    if (entries > MAX_ENTRIES)
      throw inputError(
        "entry_limit",
        split
          ? `Include at most ${MAX_ENTRIES} text files; media has a separate limit of ${GAME_FILES} files.`
          : `Include at most ${MAX_ENTRIES} entries, including directories.`,
      );
  };
  const counted = (size: number) => {
    total += size;
    if (total > GAME_BYTES)
      throw inputError(
        "expanded_limit",
        `Reduce the game to at most ${GAME_BYTES} bytes, Rosebud's limit for one game.`,
      );
  };
  async function walk(relative: string): Promise<void> {
    // Sorting and a fixed ZIP timestamp make the same directory reproducible.
    const names = (await readdir(join(root, relative))).sort();
    for (const name of names) {
      // Only a regular file is junk; a folder or link with such a name is checked as usual.
      if (isOsJunk(name) && (await lstat(join(root, relative, name))).isFile())
        continue;
      const path = relative ? `${relative}/${name}` : name;
      walked += 1;
      if (walked > WALK_LIMIT)
        throw inputError(
          "entry_limit",
          `Include at most ${GAME_FILES} files, Rosebud's limit for one game.`,
        );
      checkName(name, path);
      if (excluded(name)) {
        throw inputError(
          "excluded_file",
          `Remove credentials and dependencies from the build directory: ${path}`,
        );
      }
      const absolute = join(root, path);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        throw inputError(
          "unsupported_input",
          `Remove symbolic links and special files: ${path}`,
        );
      }
      if (stat.isDirectory()) {
        if (!split) {
          entryAdded();
          zipped[`${path}/`] = new Uint8Array();
        }
        await walk(path);
        continue;
      }
      count += 1;
      if (count > GAME_FILES)
        throw inputError(
          "entry_limit",
          `Include at most ${GAME_FILES} files, Rosebud's limit for one game.`,
        );
      const extension = extname(name);
      // What Rosebud already holds keeps its type, media first; the rest goes by extension.
      const heldAsMedia = knownMedia.has(path);
      const isMedia =
        heldAsMedia ||
        (!knownText.has(path) &&
          MEDIA_EXTENSIONS.has(extension) &&
          (path.startsWith("assets/") || !TEXT_OUTSIDE_ASSETS.has(extension)));
      if (isMedia) {
        if (!heldAsMedia) validateMediaPath(path, extension);
        mediaPaths.push(path);
      }
      // Text too, so an oversized file is refused before it is read.
      if (split && stat.size > FILE_BYTES)
        throw inputError(
          "file_limit",
          `Reduce ${path} to at most ${FILE_BYTES} bytes, Rosebud's limit for one file.`,
        );
      if (isMedia && split) {
        const { size, md5 } = await digest(absolute, path);
        if (size === 0)
          throw inputError(
            "file_limit",
            `Remove the empty file ${path}; Rosebud doesn't store empty media.`,
          );
        counted(size);
        media.push({ path, absolute, size, md5 });
        files[path] = md5;
        continue;
      }
      entryAdded();
      const content = await readBounded(absolute, EXPANDED_BYTES - zippedBytes);
      zippedBytes += content.byteLength;
      counted(content.byteLength);
      if (!isMedia) checkText(content, path);
      zipped[path] = content;
      files[path] = md5Of(content);
      hasIndex ||= path === "index.html";
    }
  }
  await walk("");
  if (!hasIndex)
    throw inputError(
      "missing_index",
      "Put index.html directly inside the build directory.",
    );
  const zip = zipSync(zipped, { level: 6, mtime: new Date(1980, 0, 1) });
  if (zip.byteLength > ZIP_BYTES)
    throw inputError(
      "compressed_limit",
      split
        ? `Reduce the game's text files to a ZIP of at most ${ZIP_BYTES} bytes.`
        : `Reduce the ZIP to at most ${ZIP_BYTES} bytes.`,
    );
  // Depth-first order can differ from path order, such as a-b.png and a/b.png.
  const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    zip,
    media: media.sort((a, b) => byPath(a.path, b.path)),
    files,
    mediaPaths: mediaPaths.sort(byPath),
  };
}

export async function prepareRelease(
  input: { directory?: string; zip?: string },
  options: {
    splitMedia?: boolean;
    /** Paths Rosebud holds as media: sent as media whatever their name or type. */
    knownMedia?: ReadonlySet<string>;
    /** Paths Rosebud holds as text: sent as text even with a media extension. */
    knownText?: ReadonlySet<string>;
  } = {},
): Promise<PreparedRelease> {
  try {
    if ((input.directory === undefined) === (input.zip === undefined))
      throw inputError(
        "input_required",
        "Choose exactly one directory or ZIP path.",
      );
    if (input.directory !== undefined) {
      if (typeof input.directory !== "string" || !input.directory.trim())
        throw inputError(
          "input_required",
          "Provide a nonempty build directory path.",
        );
      return await packDirectory(
        input.directory,
        options.splitMedia ?? false,
        options.knownMedia ?? new Set(),
        options.knownText ?? new Set(),
      );
    }
    if (
      typeof input.zip !== "string" ||
      !input.zip.trim() ||
      extname(input.zip).toLowerCase() !== ".zip"
    )
      throw inputError("input_required", "Provide an existing .zip file path.");
    if (!(await lstat(input.zip)).isFile())
      throw inputError(
        "unsupported_input",
        "Use a regular ZIP file, not a directory or symbolic link.",
      );
    // Existing archives go unchanged to the authoritative server validator.
    return { zip: await readBounded(input.zip, ZIP_BYTES), media: [] };
  } catch (error) {
    if (error instanceof RosebudError) throw error;
    throw inputError(
      "file_access",
      "Could not read the input. Check its path, permissions and that the build is no longer changing.",
    );
  }
}

export async function prepareBundle(input: {
  directory?: string;
  zip?: string;
}): Promise<Uint8Array> {
  return (await prepareRelease(input)).zip;
}

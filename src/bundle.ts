import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { zipSync } from "fflate";
import type { Zippable } from "fflate";
import { inputError, RosebudError } from "./errors.js";

const ZIP_BYTES = 10 * 1024 * 1024;
const EXPANDED_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 500;
const EXTENSIONS = new Set([
  ".html",
  ".js",
  ".css",
  ".json",
  ".txt",
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
const TEXT_EXTENSIONS = new Set([".html", ".js", ".css", ".json", ".txt"]);
const NOTICE_NAMES = new Set([
  "LICENSE",
  "LICENCE",
  "NOTICE",
  "COPYING",
  "COPYRIGHT",
  "AUTHORS",
]);

function isPlainTextNotice(name: string): boolean {
  return (
    extname(name).toLowerCase() === ".txt" ||
    NOTICE_NAMES.has(name.toUpperCase())
  );
}

function validateMediaPath(path: string, extension: string): void {
  if (!path.startsWith("assets/"))
    throw inputError(
      "media_path",
      `Put binary media under assets/ and update its references: ${path}`,
    );
  // Mirror normalize_project_asset_path for the ASCII paths this packer accepts.
  // Renaming silently would break references inside code and model files.
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

async function packDirectory(directory: string): Promise<Uint8Array> {
  const root = resolve(directory);
  if (!(await lstat(root)).isDirectory())
    throw inputError(
      "unsupported_input",
      "Use a build directory, without a symbolic link at its root.",
    );
  const files: Zippable = Object.create(null) as Zippable;
  let entries = 0;
  let expanded = 0;
  let hasIndex = false;
  async function walk(relative: string): Promise<void> {
    // Sorting and a fixed ZIP timestamp make the same directory reproducible.
    const names = (await readdir(join(root, relative))).sort();
    for (const name of names) {
      const path = relative ? `${relative}/${name}` : name;
      entries += 1;
      if (entries > MAX_ENTRIES)
        throw inputError(
          "entry_limit",
          `Include at most ${MAX_ENTRIES} entries, including directories.`,
        );
      if (
        !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(name) ||
        name.length > 255 ||
        path.length > 500
      ) {
        throw inputError(
          "unsafe_path",
          `Use letters, numbers, dots, hyphens or underscores in relative paths; remove hidden files: ${path}`,
        );
      }
      if (
        EXCLUDED.has(name.toLowerCase()) ||
        name.toLowerCase().includes("firebase-adminsdk")
      ) {
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
        files[`${path}/`] = new Uint8Array();
        await walk(path);
      } else {
        const extension = extname(name);
        const notice = isPlainTextNotice(name);
        if (!EXTENSIONS.has(extension) && !notice)
          throw inputError(
            "unsupported_file",
            `Unsupported file ${path}; use HTML, JS, CSS, JSON, plain-text notices, PNG/JPEG/WebP/SVG, WAV/MP3/OGG, web fonts, WASM, GLB/glTF or BIN.`,
          );
        if (!TEXT_EXTENSIONS.has(extension) && !notice)
          validateMediaPath(path, extension);
        const content = await readBounded(absolute, EXPANDED_BYTES - expanded);
        expanded += content.byteLength;
        files[path] = content;
        hasIndex ||= path === "index.html";
      }
    }
  }
  await walk("");
  if (!hasIndex)
    throw inputError(
      "missing_index",
      "Put index.html directly inside the build directory.",
    );
  const bytes = zipSync(files, { level: 6, mtime: new Date(1980, 0, 1) });
  if (bytes.byteLength > ZIP_BYTES)
    throw inputError(
      "compressed_limit",
      `Reduce the ZIP to at most ${ZIP_BYTES} bytes.`,
    );
  return bytes;
}

export async function prepareBundle(input: {
  directory?: string;
  zip?: string;
}): Promise<Uint8Array> {
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
      return await packDirectory(input.directory);
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
    return await readBounded(input.zip, ZIP_BYTES);
  } catch (error) {
    if (error instanceof RosebudError) throw error;
    throw inputError(
      "file_access",
      "Could not read the input. Check its path, permissions and that the build is no longer changing.",
    );
  }
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { prepareRelease, FILE_BYTES } from "../dist/bundle.js";

const md5 = (bytes) => createHash("md5").update(bytes).digest("hex");

async function folder(t, files) {
  const root = await mkdtemp(join(tmpdir(), "rosebud-bundle-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);

test("splitting sends text in the ZIP and hashes media for an upload session", async (t) => {
  const root = await folder(t, {
    "index.html": "<p>Game</p>",
    "AGENTS.md": "# Notes",
    "levels/My Level.json": "{}",
    "données.js": "export const vies = 3;",
    "assets/hero.png": png,
  });
  const release = await prepareRelease(
    { directory: root },
    { splitMedia: true },
  );
  const zipped = unzipSync(release.zip);
  assert.deepEqual(Object.keys(zipped).sort(), [
    "AGENTS.md",
    "données.js",
    "index.html",
    "levels/My Level.json",
  ]);
  assert.equal(strFromU8(zipped["AGENTS.md"]), "# Notes");
  assert.deepEqual(
    release.media.map(({ path, size, md5: hash }) => [path, size, hash]),
    [["assets/hero.png", png.length, md5(png)]],
  );
  assert.equal(release.files["assets/hero.png"], md5(png));
  assert.equal(release.files["index.html"], md5(Buffer.from("<p>Game</p>")));
  assert.deepEqual(release.mediaPaths, ["assets/hero.png"]);
});

test("a game bigger than one ZIP splits, and media over 19 MiB is refused", async (t) => {
  // Random bytes: a repeated byte would compress into one small ZIP.
  const big = randomBytes(12 * 1024 * 1024);
  const root = await folder(t, { "index.html": "x", "assets/big.bin": big });
  const release = await prepareRelease(
    { directory: root },
    { splitMedia: true },
  );
  assert.equal(release.media[0].size, big.length);
  await assert.rejects(
    prepareRelease({ directory: root }),
    (e) => e.code === "compressed_limit",
  );
  await writeFile(join(root, "assets/big.bin"), Buffer.alloc(FILE_BYTES + 1));
  await assert.rejects(
    prepareRelease({ directory: root }, { splitMedia: true }),
    (e) => e.code === "file_limit" && e.message.includes("assets/big.bin"),
  );
});

test("media Rosebud already holds keeps its editor name and type", async (t) => {
  const root = await folder(t, {
    "index.html": "x",
    "assets/clip.mp4": Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]),
    "assets/café.png": png,
  });
  await assert.rejects(
    prepareRelease({ directory: root }, { splitMedia: true }),
    (e) =>
      e.code === "unsupported_file" && e.message.includes("assets/clip.mp4"),
  );
  const release = await prepareRelease(
    { directory: root },
    {
      splitMedia: true,
      knownMedia: new Set(["assets/clip.mp4", "assets/café.png"]),
    },
  );
  assert.deepEqual(
    release.media.map((m) => m.path),
    ["assets/clip.mp4", "assets/café.png"].sort(),
  );
});

test("names the editor can't hold, hidden files and binary text are refused", async (t) => {
  for (const [name, content, code] of [
    [".env", "A=1", "unsafe_path"],
    // Windows can't create this name, so there is nothing for the CLI to refuse.
    ...(process.platform === "win32" ? [] : [["a<b.js", "x", "unsafe_path"]]),
    ["tool.exe", Buffer.from([0, 1, 2]), "unsupported_file"],
    ["assets/empty.png", Buffer.alloc(0), "file_limit"],
  ]) {
    const root = await folder(t, { "index.html": "x", [name]: content });
    await assert.rejects(
      prepareRelease({ directory: root }, { splitMedia: true }),
      (e) => e.code === code && e.outcome === "not_sent",
      name,
    );
  }
});

test("without splitting, folders and media stay in the ZIP as in 0.1.0", async (t) => {
  const root = await folder(t, { "index.html": "x", "assets/hero.png": png });
  const first = await prepareRelease({ directory: root });
  const second = await prepareRelease(
    { directory: root },
    { splitMedia: false },
  );
  assert.deepEqual(first.zip, second.zip);
  assert.deepEqual(Object.keys(unzipSync(first.zip)).sort(), [
    "assets/",
    "assets/hero.png",
    "index.html",
  ]);
  assert.deepEqual(first.media, []);
});

test("media is listed in path order, not folder-walk order", async (t) => {
  const root = await folder(t, {
    "index.html": "x",
    "assets/a/b.png": png,
    "assets/a-b.png": png,
  });
  const release = await prepareRelease(
    { directory: root },
    { splitMedia: true },
  );
  assert.deepEqual(release.mediaPaths, ["assets/a-b.png", "assets/a/b.png"]);
  assert.deepEqual(
    release.media.map((m) => m.path),
    release.mediaPaths,
  );
});

test("an existing ZIP passes through with no manifest", async (t) => {
  const root = await folder(t, { "game.zip": Buffer.from("server validates") });
  const release = await prepareRelease(
    { zip: join(root, "game.zip") },
    { splitMedia: true },
  );
  assert.equal(strFromU8(release.zip), "server validates");
  assert.deepEqual(release.media, []);
  assert.equal(release.files, undefined);
  assert.equal(release.mediaPaths, undefined);
});

test("without splitting, the ZIP is byte for byte what 0.1.0 packed", async (t) => {
  const root = await folder(t, {
    "index.html": "<p>Game</p>",
    LICENSE: "MIT License\n",
    "nested/game.js": "export const speed = 3;\n".repeat(40),
    "assets/hero.png": png,
    "assets/a-b.png": png,
    "assets/a/b.png": png,
  });
  await mkdir(join(root, "empty"));
  const { zip } = await prepareRelease({ directory: root });
  // The SHA-256 of the ZIP that 0.1.0 (e503d31's packer) builds from this folder.
  assert.equal(
    createHash("sha256").update(zip).digest("hex"),
    "45e82c4bf941d776d40c96f649f8ec363a0ae7a13666e2515ab40694665a9aac",
  );
});

test("a text file over 19 MiB is refused when splitting, before it is read", async (t) => {
  // Repeated letters compress to almost nothing, so only the size check can refuse it.
  const root = await folder(t, {
    "index.html": "x",
    "notes.txt": Buffer.alloc(FILE_BYTES + 1, "a"),
  });
  await assert.rejects(
    prepareRelease({ directory: root }, { splitMedia: true }),
    (e) =>
      e.code === "file_limit" &&
      e.outcome === "not_sent" &&
      e.message.includes("notes.txt"),
  );
});

const OS_JUNK = ["Thumbs.db", "desktop.ini", ".DS_Store"];

test("OS junk files are skipped, in any case and at any depth, without an error", async (t) => {
  const junk = Buffer.from([0, 0, 0, 1, 66, 117, 100, 49]);
  const root = await folder(t, {
    "index.html": "x",
    ".DS_Store": junk,
    "Thumbs.db": junk,
    "desktop.ini": "[.ShellClassInfo]",
    "assets/.DS_Store": junk,
    "assets/hero.png": png,
    "levels/.ds_store": junk,
    "levels/THUMBS.DB": junk,
    "levels/Desktop.INI": "[.ShellClassInfo]",
    "levels/one.json": "{}",
  });
  for (const splitMedia of [true, false]) {
    const release = await prepareRelease({ directory: root }, { splitMedia });
    const listed = Object.keys(release.files).sort();
    assert.deepEqual(listed, [
      "assets/hero.png",
      "index.html",
      "levels/one.json",
    ]);
    const zipped = Object.keys(unzipSync(release.zip)).filter(
      (name) => !name.endsWith("/"),
    );
    for (const name of zipped)
      assert.ok(
        !OS_JUNK.some((junkName) =>
          name.toLowerCase().endsWith(junkName.toLowerCase()),
        ),
        name,
      );
  }
  // Every other hidden name still refuses.
  await writeFile(join(root, "levels/.notes"), "x");
  await assert.rejects(
    prepareRelease({ directory: root }, { splitMedia: true }),
    (e) => e.code === "unsafe_path" && e.message.includes("levels/.notes"),
  );
});

// Windows can't create names that end in a space or hold only spaces.
const spaced = process.platform === "win32" ? [] : [" ", "\u00a0"];

test("a name of only whitespace is refused", async (t) => {
  for (const name of spaced) {
    const root = await folder(t, { "index.html": "x", [name]: "x" });
    await assert.rejects(
      prepareRelease({ directory: root }, { splitMedia: true }),
      (e) => e.code === "unsafe_path" && e.outcome === "not_sent",
      JSON.stringify(name),
    );
  }
});

test("names ending in .env are excluded in any case, and excluded names are compared trimmed", async (t) => {
  const names = [
    "prod.env",
    "Game.ENV",
    "config/staging.Env",
    "FIREBASE-ADMINSDK-abc.json",
    ...spaced.map(() => "prod.env "),
    ...spaced.map(() => "credentials "),
    ...spaced.map(() => "node_modules "),
    // Hidden means a raw leading dot, as for Rosebud; a space before it is trimmed
    // for the exclusion list, which a .env name is on.
    ...spaced.flatMap((blank) => [`${blank}.env`, `${blank}.ENV `]),
  ];
  for (const name of names) {
    const root = await folder(t, { "index.html": "x", [name]: "x" });
    await assert.rejects(
      prepareRelease({ directory: root }, { splitMedia: true }),
      (e) => e.code === "excluded_file" && e.outcome === "not_sent",
      name,
    );
  }
  // A folder named like that is excluded as a whole; names that merely contain env are fine.
  const folderRoot = await folder(t, { "index.html": "x", "a.env/x.js": "x" });
  await assert.rejects(
    prepareRelease({ directory: folderRoot }, { splitMedia: true }),
    (e) => e.code === "excluded_file",
  );
  const fine = await folder(t, {
    "index.html": "x",
    "env.js": "x",
    "environment.js": "x",
    "levels.environment": "x",
    "env/a.js": "x",
  });
  const release = await prepareRelease(
    { directory: fine },
    { splitMedia: true },
  );
  assert.deepEqual(Object.keys(release.files).sort(), [
    "env.js",
    "env/a.js",
    "environment.js",
    "index.html",
    "levels.environment",
  ]);
});

test(".svg and .gltf outside assets/ are text, checked as UTF-8; inside assets/ they are media", async (t) => {
  const root = await folder(t, {
    "index.html": "x",
    "art/Logo.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
    "models/scene.gltf": '{"asset":{"version":"2.0"}}',
    "assets/icon.svg": "<svg/>",
  });
  const release = await prepareRelease(
    { directory: root },
    { splitMedia: true },
  );
  assert.deepEqual(Object.keys(unzipSync(release.zip)).sort(), [
    "art/Logo.svg",
    "index.html",
    "models/scene.gltf",
  ]);
  assert.deepEqual(release.mediaPaths, ["assets/icon.svg"]);
  assert.deepEqual(
    release.media.map((m) => m.path),
    ["assets/icon.svg"],
  );
  // Text is text: bytes that aren't UTF-8 are refused as such.
  const binary = await folder(t, {
    "index.html": "x",
    "art/logo.svg": Buffer.from([0xff, 0xfe, 0, 1]),
  });
  await assert.rejects(
    prepareRelease({ directory: binary }, { splitMedia: true }),
    (e) => e.code === "unsupported_file" && e.message.includes("art/logo.svg"),
  );
});

test("paths Rosebud holds as text are sent as text, even with a media extension", async (t) => {
  const root = await folder(t, {
    "index.html": "x",
    // Rosie wrote these as text, with names the media rules would refuse.
    "assets/Icon Pack/Logo.svg": "<svg/>",
    "assets/notes.png": "just words",
    "assets/hero.png": png,
  });
  await assert.rejects(
    prepareRelease({ directory: root }, { splitMedia: true }),
    (e) => e.code === "noncanonical_path",
  );
  const knownText = new Set(["assets/Icon Pack/Logo.svg", "assets/notes.png"]);
  const release = await prepareRelease(
    { directory: root },
    { splitMedia: true, knownText },
  );
  assert.deepEqual(Object.keys(unzipSync(release.zip)).sort(), [
    "assets/Icon Pack/Logo.svg",
    "assets/notes.png",
    "index.html",
  ]);
  assert.deepEqual(release.mediaPaths, ["assets/hero.png"]);
  assert.equal(
    release.files["assets/notes.png"],
    md5(Buffer.from("just words")),
  );
  // Still UTF-8 checked, like any text.
  await writeFile(join(root, "assets/notes.png"), png);
  await assert.rejects(
    prepareRelease({ directory: root }, { splitMedia: true, knownText }),
    (e) =>
      e.code === "unsupported_file" && e.message.includes("assets/notes.png"),
  );
  // Media Rosebud lists as media keeps priority over a text listing of the same path.
  const both = await prepareRelease(
    { directory: root },
    {
      splitMedia: true,
      knownText: new Set(["assets/Icon Pack/Logo.svg", "assets/notes.png"]),
      knownMedia: new Set(["assets/notes.png"]),
    },
  );
  assert.deepEqual(both.mediaPaths, ["assets/hero.png", "assets/notes.png"]);
});

test("only a regular file is OS junk: a folder or link with such a name takes the normal path", async (t) => {
  // A folder named like junk is an ordinary folder, and its files ship.
  const folderRoot = await folder(t, {
    "index.html": "x",
    "Thumbs.db/level.json": "{}",
  });
  const release = await prepareRelease(
    { directory: folderRoot },
    { splitMedia: true },
  );
  assert.deepEqual(Object.keys(release.files).sort(), [
    "Thumbs.db/level.json",
    "index.html",
  ]);
  // A hidden folder is refused, junk name or not.
  const hidden = await folder(t, {
    "index.html": "x",
    ".DS_Store/a.json": "{}",
  });
  await assert.rejects(
    prepareRelease({ directory: hidden }, { splitMedia: true }),
    (e) => e.code === "unsafe_path" && e.message.includes(".DS_Store"),
  );
  // Creating links needs privileges on Windows.
  if (process.platform === "win32") return;
  for (const name of ["desktop.ini", ".DS_Store"]) {
    const linked = await folder(t, { "index.html": "x" });
    await symlink(join(linked, "index.html"), join(linked, name));
    await assert.rejects(
      prepareRelease({ directory: linked }, { splitMedia: true }),
      (e) =>
        ["unsupported_input", "unsafe_path"].includes(e.code) &&
        e.message.includes(name),
      name,
    );
  }
});

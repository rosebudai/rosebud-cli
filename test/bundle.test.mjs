import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

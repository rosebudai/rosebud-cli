import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rosebud, RosebudError } from "../dist/index.js";
import { fakeRosebud, md5 } from "./fake-rosebud.mjs";

async function folder(t, files) {
  const root = await mkdtemp(join(tmpdir(), "rosebud-sync-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}
const big = randomBytes(12 * 1024 * 1024); // incompressible: more than one 10 MiB ZIP
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test("a directory publish sends text in the ZIP and media file by file", async (t) => {
  const game = await fakeRosebud(t);
  const root = await folder(t, {
    "index.html": "<p>Game</p>",
    "assets/big.bin": big,
    "assets/hero.png": png,
  });
  const result = await new Rosebud({ apiBaseUrl: game.base }).publish({
    directory: root,
  });
  assert.equal(result.content_version, game.version);
  assert.deepEqual(game.puts.sort(), ["assets/big.bin", "assets/hero.png"]);
  assert.deepEqual([...game.text.keys()], ["index.html"]);
  assert.equal(md5(game.media.get("assets/big.bin")), md5(big));
  const storage = game.requests.filter((r) => r.path.startsWith("/storage/"));
  assert.ok(storage.every((r) => r.headers.authorization === undefined));
});

test("a failed PUT is retried, and a refused one stops before any release", async (t) => {
  const flaky = await fakeRosebud(t, { failPuts: 2 });
  const root = await folder(t, { "index.html": "x", "assets/hero.png": png });
  await new Rosebud({ apiBaseUrl: flaky.base }).publish({ directory: root });
  assert.deepEqual(flaky.puts, ["assets/hero.png"]);
  const refusing = await fakeRosebud(t, { refusePuts: true });
  await assert.rejects(
    new Rosebud({ apiBaseUrl: refusing.base }).publish({ directory: root }),
    (e) =>
      e instanceof RosebudError &&
      e.code === "upload_rejected" &&
      e.status === 403 &&
      e.message.includes("assets/hero.png"),
  );
  assert.equal(refusing.releases, 0);
});

test("without upload sessions, a small game goes as one ZIP and a big one says why it can't", async (t) => {
  const game = await fakeRosebud(t, { sync: false });
  const small = await folder(t, { "index.html": "x", "assets/hero.png": png });
  await new Rosebud({ apiBaseUrl: game.base }).publish({ directory: small });
  assert.equal(md5(game.media.get("assets/hero.png")), md5(png));
  assert.deepEqual(game.puts, []);
  const large = await folder(t, { "index.html": "x", "assets/big.bin": big });
  await assert.rejects(
    new Rosebud({ apiBaseUrl: game.base }).publish({ directory: large }),
    (e) =>
      ["compressed_limit", "size_limit"].includes(e.code) &&
      /file-by-file/.test(e.message),
  );
  assert.equal(game.releases, 1);
});

test("an upload session response that names undeclared paths is unexpected", async (t) => {
  const game = await fakeRosebud(t);
  const client = new Rosebud({ apiBaseUrl: game.base });
  const session = await client.createUploadSession({
    files: [{ path: "assets/a.png", size: 8, md5: md5(png) }],
  });
  assert.equal(session.uploads[0].path, "assets/a.png");
  // A hand-made server that links a path nobody declared.
  const rogue = createServer((_req, res) =>
    res.writeHead(201, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        upload_id: randomUUID(),
        upload_token: "U".repeat(43),
        expires_at: "x",
        linked: ["assets/other.png"],
        uploads: [],
      }),
    ),
  );
  rogue.listen(0, "127.0.0.1");
  t.after(() => rogue.close());
  await new Promise((r) => rogue.once("listening", r));
  await assert.rejects(
    new Rosebud({
      apiBaseUrl: `http://127.0.0.1:${rogue.address().port}`,
    }).createUploadSession({
      files: [{ path: "assets/a.png", size: 8, md5: md5(png) }],
    }),
    (e) => e.code === "unexpected_response",
  );
});

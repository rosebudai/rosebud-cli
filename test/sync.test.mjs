import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import { Rosebud, RosebudError, prepareRelease } from "../dist/index.js";
import { fakeRosebud, md5, AGENT, PROJECT } from "./fake-rosebud.mjs";

async function folder(t, files) {
  const root = await mkdtemp(join(tmpdir(), "rosebud-sync-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), content);
  }
  return root;
}
// A hand-made server for answers the fake never gives.
async function rogueServer(t, respond) {
  const requests = [];
  const app = createServer(async (req, res) => {
    for await (const _chunk of req);
    requests.push(`${req.method} ${req.url}`);
    respond(req, res);
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(async () => {
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
  });
  return { base: `http://127.0.0.1:${app.address().port}`, requests };
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

test("a missing cover fails before the session or any upload", async (t) => {
  const game = await fakeRosebud(t);
  const root = await folder(t, { "index.html": "x", "assets/hero.png": png });
  await assert.rejects(
    new Rosebud({ apiBaseUrl: game.base }).publish({
      directory: root,
      thumbnail: join(root, "no-such-cover.png"),
    }),
    (e) => e.code === "thumbnail" && e.outcome === "not_sent",
  );
  assert.equal(game.requests.length, 0);
});

test("a file that vanishes before its PUT fails at once as changed, without retries", async (t) => {
  const game = await fakeRosebud(t);
  const root = await folder(t, { "index.html": "x", "assets/hero.png": png });
  const prepared = await prepareRelease(
    { directory: root },
    { splitMedia: true },
  );
  await rm(join(root, "assets/hero.png"));
  const started = Date.now();
  await assert.rejects(
    new Rosebud({ apiBaseUrl: game.base }).publish({
      directory: root,
      prepared,
    }),
    (e) =>
      e.kind === "input" &&
      e.code === "file_changed" &&
      e.outcome === "not_sent" &&
      e.message.includes("assets/hero.png"),
  );
  // Retrying a transport error would wait 1 s and then 2 s.
  assert.ok(Date.now() - started < 2000);
  assert.equal(game.releases, 0);
});

test("a session that asks for another header or an insecure URL is refused before any PUT", async (t) => {
  const root = await folder(t, { "index.html": "x", "assets/hero.png": png });
  const storage = await rogueServer(t, (_req, res) => res.writeHead(200).end());
  for (const [url, headers] of [
    [`${storage.base}/put`, { Authorization: "Bearer stolen" }],
    [
      "http://storage.example.invalid/put",
      { "Content-Type": "application/octet-stream" },
    ],
  ]) {
    const api = await rogueServer(t, (_req, res) =>
      res.writeHead(201, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          upload_id: randomUUID(),
          upload_token: "U".repeat(43),
          expires_at: "2030-01-01T00:00:00Z",
          linked: [],
          uploads: [{ path: "assets/hero.png", url, method: "PUT", headers }],
        }),
      ),
    );
    await assert.rejects(
      new Rosebud({ apiBaseUrl: api.base }).publish({ directory: root }),
      (e) => e.code === "unexpected_response",
    );
    assert.deepEqual(api.requests, ["POST /api/developer/uploads/"]);
  }
  assert.deepEqual(storage.requests, []);
});

test("project_unavailable from the session is the answer, not a reason to send one ZIP", async (t) => {
  const root = await folder(t, { "index.html": "x", "assets/hero.png": png });
  const api = await rogueServer(t, (_req, res) =>
    res.writeHead(404, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        error: { code: "project_unavailable", message: "Gone." },
      }),
    ),
  );
  await assert.rejects(
    new Rosebud({ apiBaseUrl: api.base }).update({
      directory: root,
      projectId: PROJECT,
      agentToken: AGENT,
      expectedVersion: "0".repeat(64),
      operationId: randomUUID(),
    }),
    (e) => e.code === "project_unavailable" && e.status === 404,
  );
  assert.deepEqual(api.requests, ["POST /api/developer/uploads/"]);
});

test("an update links media Rosebud already holds and keeps the agent token off storage", async (t) => {
  const game = await fakeRosebud(t);
  game.edit({
    text: { "index.html": "old" },
    media: { "assets/hero.png": png },
  });
  const added = Buffer.concat([png, png]);
  const root = await folder(t, {
    "index.html": "new",
    "assets/hero.png": png,
    "assets/new.png": added,
  });
  await new Rosebud({ apiBaseUrl: game.base }).update({
    directory: root,
    projectId: PROJECT,
    agentToken: AGENT,
    expectedVersion: game.version,
    operationId: randomUUID(),
  });
  assert.deepEqual(game.puts, ["assets/new.png"]);
  assert.equal(game.releases, 1);
  assert.equal(md5(game.media.get("assets/hero.png")), md5(png));
  assert.equal(md5(game.media.get("assets/new.png")), md5(added));
  const session = game.requests.find(
    (r) => r.path === "/api/developer/uploads/",
  );
  assert.equal(session.headers.authorization, `Bearer ${AGENT}`);
  const storage = game.requests.filter((r) => r.path.startsWith("/storage/"));
  assert.equal(storage.length, 1);
  assert.ok(storage.every((r) => r.headers.authorization === undefined));
});

test("a slow PUT gets time in proportion to its size on top of the base timeout", async (t) => {
  const game = await fakeRosebud(t, { putDelayMs: 700 });
  const root = await folder(t, { "index.html": "x", "assets/hero.png": png });
  await new Rosebud({ apiBaseUrl: game.base, timeoutMs: 300 }).publish({
    directory: root,
  });
  assert.deepEqual(game.puts, ["assets/hero.png"]);
  // One attempt: a timeout at 300 ms would have been retried.
  const storage = game.requests.filter((r) => r.path.startsWith("/storage/"));
  assert.equal(storage.length, 1);
});

test("giving up on a PUT says how to allow more time", async (t) => {
  const game = await fakeRosebud(t, { failPuts: 3 });
  const root = await folder(t, { "index.html": "x", "assets/hero.png": png });
  await assert.rejects(
    new Rosebud({ apiBaseUrl: game.base }).publish({ directory: root }),
    (e) =>
      e.code === "upload_failed" &&
      e.outcome === "not_sent" &&
      e.message.includes("assets/hero.png") &&
      e.message.includes("--timeout-ms") &&
      !/twice/.test(e.message),
  );
  assert.equal(game.releases, 0);
});

test("a game with too many files for the one-ZIP fallback is told the old server's file limit", async (t) => {
  const game = await fakeRosebud(t, { sync: false });
  // 499 text files go in the split ZIP; one ZIP would also hold the media and assets/.
  const files = { "index.html": "x", "assets/hero.png": png };
  for (let n = 0; n < 498; n += 1) files[`t${n}.js`] = "x";
  const root = await folder(t, files);
  await assert.rejects(
    new Rosebud({ apiBaseUrl: game.base }).publish({ directory: root }),
    (e) =>
      e.code === "entry_limit" &&
      /file-by-file/.test(e.message) &&
      /500 files/.test(e.message) &&
      !/10 MiB/.test(e.message),
  );
  assert.equal(game.releases, 0);
});

async function run(root, args) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), ...args],
    {
      cwd: root,
      env: {
        ...process.env,
        ROSEBUD_API_BASE: "",
        ROSEBUD_CREDENTIALS_DIR: join(root, "credentials"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => (stdout += b));
  child.stderr.on("data", (b) => (stderr += b));
  const [code] = await once(child, "close");
  return {
    code,
    data: stdout ? JSON.parse(stdout) : undefined,
    error: stderr ? JSON.parse(stderr).error : undefined,
  };
}
/** Publish dist, connect and approve: the state a person reaches after claiming. */
async function connected(t, game, files) {
  const root = await folder(
    t,
    Object.fromEntries(Object.entries(files).map(([p, c]) => [`dist/${p}`, c])),
  );
  assert.equal(
    (
      await run(root, [
        "publish",
        "--directory",
        "dist",
        "--api-base",
        game.base,
      ])
    ).code,
    0,
  );
  assert.equal((await run(root, ["connect"])).code, 0);
  game.access = "active";
  assert.equal((await run(root, ["status"])).code, 0);
  return root;
}
const handle = async (root) =>
  JSON.parse(await readFile(join(root, ".rosebud/project.json"), "utf8"));

test("publish and update record every file they sent", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, {
    "index.html": "one",
    "assets/hero.png": png,
  });
  assert.deepEqual((await handle(root)).files, {
    "index.html": md5(Buffer.from("one")),
    "assets/hero.png": md5(png),
  });
  assert.deepEqual((await handle(root)).media, ["assets/hero.png"]);
  await writeFile(join(root, "dist/index.html"), "two");
  const update = await run(root, ["update", "--directory", "dist"]);
  assert.equal(update.code, 0, JSON.stringify(update.error));
  assert.equal(
    (await handle(root)).files["index.html"],
    md5(Buffer.from("two")),
  );
  assert.deepEqual(game.puts, ["assets/hero.png"]); // the update linked it
});

test("a rerun after a lost response replays the release without uploading again", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, {
    "index.html": "one",
    "assets/big.bin": big,
  });
  await writeFile(
    join(root, "dist/assets/big.bin"),
    Buffer.alloc(big.length, 9),
  );
  const before = game.puts.length;
  game.loseNextRelease = true;
  const lost = await run(root, ["update", "--directory", "dist"]);
  assert.equal(lost.code, 4);
  // The lost attempt staged the upload; the rerun must not stage it again.
  assert.equal(game.puts.length, before + 1);
  const puts = game.puts.length,
    releases = game.releases;
  const rerun = await run(root, ["update", "--directory", "dist"]);
  assert.equal(rerun.code, 0, JSON.stringify(rerun.error));
  assert.equal(game.puts.length, puts); // linked: the game already serves it
  assert.equal(game.releases, releases); // replayed, not released twice
  assert.equal(rerun.data.content_version, game.version);
});

test("a handle from 0.1.0, without files or media, still updates and gains them", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, {
    "index.html": "one",
    "assets/hero.png": png,
  });
  const old = await handle(root);
  delete old.files;
  delete old.media;
  await writeFile(join(root, ".rosebud/project.json"), JSON.stringify(old), {
    mode: 0o600,
  });
  await writeFile(join(root, "dist/index.html"), "two");
  const update = await run(root, ["update", "--directory", "dist"]);
  assert.equal(update.code, 0, JSON.stringify(update.error));
  assert.deepEqual((await handle(root)).media, ["assets/hero.png"]);
  assert.equal(
    (await handle(root)).files["index.html"],
    md5(Buffer.from("two")),
  );
});

test("an update from a ZIP clears what the handle knew of the files", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one" });
  assert.ok((await handle(root)).files);
  await writeFile(
    join(root, "game.zip"),
    zipSync({ "index.html": strToU8("two") }),
  );
  const update = await run(root, ["update", "--zip", "game.zip"]);
  assert.equal(update.code, 0, JSON.stringify(update.error));
  const after = await handle(root);
  assert.equal(after.files, undefined);
  assert.equal(after.media, undefined);
  assert.equal(after.content_version, game.version);
});

test("after a lost response, a changed media file is different input, not a rerun", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, {
    "index.html": "one",
    "assets/hero.png": png,
  });
  await writeFile(
    join(root, "dist/assets/hero.png"),
    Buffer.concat([png, png]),
  );
  game.loseNextRelease = true;
  assert.equal((await run(root, ["update", "--directory", "dist"])).code, 4);
  // The text ZIP is the same; only the media manifest differs.
  await writeFile(
    join(root, "dist/assets/hero.png"),
    Buffer.concat([png, png, png]),
  );
  const changed = await run(root, ["update", "--directory", "dist"]);
  assert.equal(changed.code, 2);
  assert.equal(changed.error.code, "pending_operation");
});

test("a handle whose files or media are malformed is refused", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, {
    "index.html": "one",
    "assets/hero.png": png,
  });
  const good = await handle(root);
  const state = join(root, ".rosebud/project.json");
  for (const bad of [
    { files: [] },
    { files: null },
    { files: "x" },
    { files: { "index.html": 1 } },
    { media: "x" },
    { media: null },
    { media: {} },
    { media: [1] },
  ]) {
    await writeFile(state, JSON.stringify({ ...good, ...bad }));
    const refused = await run(root, ["status"]);
    assert.equal(refused.error.code, "state_format", JSON.stringify(bad));
  }
  await writeFile(state, JSON.stringify(good));
  assert.equal((await run(root, ["status"])).code, 0);
});

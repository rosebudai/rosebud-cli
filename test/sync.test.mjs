import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { watch } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import { Rosebud, RosebudError, prepareRelease } from "../dist/index.js";
import { planPull, safePath } from "../dist/sync.js";
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

test("what Rosebud holds as text or media is kept when a game falls back to one ZIP", async (t) => {
  const game = await fakeRosebud(t, { sync: false });
  const root = await folder(t, {
    "index.html": "x",
    "assets/hero.png": png,
    // Neither name passes the media rules for a new file.
    "assets/Icon Pack/Logo.svg": "<svg/>",
    "assets/Clip.mp4": Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]),
  });
  await new Rosebud({ apiBaseUrl: game.base }).publish({
    directory: root,
    knownText: new Set(["assets/Icon Pack/Logo.svg"]),
    knownMedia: new Set(["assets/Clip.mp4"]),
  });
  assert.equal(game.releases, 1);
  assert.deepEqual(game.puts, []);
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
async function connected(t, game, files, { directory = "dist", state } = {}) {
  const root = await folder(
    t,
    Object.fromEntries(
      Object.entries(files).map(([p, c]) => [`${directory}/${p}`, c]),
    ),
  );
  const own = state ? ["--state", state] : [];
  assert.equal(
    (
      await run(root, [
        "publish",
        "--directory",
        directory,
        "--api-base",
        game.base,
        ...own,
      ])
    ).code,
    0,
  );
  assert.equal((await run(root, ["connect", ...own])).code, 0);
  game.access = "active";
  assert.equal((await run(root, ["status", ...own])).code, 0);
  return root;
}
const handle = async (root) =>
  JSON.parse(await readFile(join(root, ".rosebud/project.json"), "utf8"));

test("a lock left by a process that has gone is taken over, and a live one still refuses", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one" });
  const lock = join(root, ".rosebud/project.json.lock");
  // A process that has exited: its id names no running process now.
  const gone = spawn(process.execPath, ["-e", ""]);
  await once(gone, "exit");
  await writeFile(lock, `${gone.pid}\n`);
  const taken = await run(root, ["status"]);
  assert.equal(taken.code, 0, JSON.stringify(taken.error));
  await assert.rejects(readFile(lock));
  // This test's own process is alive, so its lock stands.
  await writeFile(lock, `${process.pid}\n`);
  const live = await run(root, ["status"]);
  assert.equal(live.code, 2);
  assert.equal(live.error.code, "state_locked");
  assert.match(live.error.message, new RegExp(`process ${process.pid}`));
  assert.equal(await readFile(lock, "utf8"), `${process.pid}\n`);
  // A lock that names no process can't be judged, so it stands too.
  await writeFile(lock, "");
  assert.equal((await run(root, ["status"])).error.code, "state_locked");
  await rm(lock);
  assert.equal((await run(root, ["status"])).code, 0);
});

test(
  "a command stopped by SIGTERM or SIGINT releases its lock and exits with the signal's code",
  { skip: process.platform === "win32" }, // Windows ends a process without a signal to handle
  async (t) => {
    // Rosebud never answers, as during a long upload.
    const api = await rogueServer(t, () => undefined);
    const root = await folder(t, { "dist/index.html": "one" });
    const lock = join(root, ".rosebud/project.json.lock");
    for (const [signal, exit] of [
      ["SIGTERM", 143],
      ["SIGINT", 130],
    ]) {
      const asked = api.requests.length;
      const child = spawn(
        process.execPath,
        [
          fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
          "publish",
          "--directory",
          "dist",
          "--api-base",
          api.base,
        ],
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
      let stderr = "";
      child.stderr.on("data", (b) => (stderr += b));
      const closed = once(child, "close");
      for (let wait = 0; api.requests.length === asked && wait < 200; wait += 1)
        await new Promise((resolve) => setTimeout(resolve, 25));
      assert.ok(api.requests.length > asked, "the publish reached Rosebud");
      assert.ok((await readFile(lock, "utf8")).length > 0, "it holds the lock");
      child.kill(signal);
      const [code] = await closed;
      assert.equal(code, exit, signal);
      await assert.rejects(readFile(lock), signal);
      const error = JSON.parse(stderr).error;
      assert.equal(error.code, "interrupted");
      assert.equal(error.outcome, "unknown");
      assert.match(error.message, new RegExp(signal));
    }
  },
);

test("an .svg outside assets/ is a text file, and a path Rosebud holds as text stays text on update", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, {
    "index.html": "one",
    "art/logo.svg": "<svg id='1'/>",
  });
  assert.equal(game.text.get("art/logo.svg"), "<svg id='1'/>");
  assert.deepEqual((await handle(root)).media, []);
  // Rosie wrote SVGs under assets/ as text, one with a name new media couldn't have.
  game.edit({
    text: {
      "assets/icon.svg": "<svg id='a'/>",
      "assets/Icon Pack/Logo.svg": "<svg id='b'/>",
    },
  });
  const pulled = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(pulled.code, 0, JSON.stringify(pulled.error));
  assert.deepEqual((await handle(root)).media, []);
  await writeFile(join(root, "dist/assets/icon.svg"), "<svg id='c'/>");
  await writeFile(
    join(root, "dist/assets/Icon Pack/Logo.svg"),
    "<svg id='d'/>",
  );
  await writeFile(join(root, "dist/art/logo.svg"), "<svg id='2'/>");
  const update = await run(root, ["update", "--directory", "dist"]);
  assert.equal(update.code, 0, JSON.stringify(update.error));
  assert.equal(game.text.get("assets/icon.svg"), "<svg id='c'/>");
  assert.equal(game.text.get("assets/Icon Pack/Logo.svg"), "<svg id='d'/>");
  assert.equal(game.text.get("art/logo.svg"), "<svg id='2'/>");
  assert.deepEqual([...game.media.keys()], []);
  assert.deepEqual(game.puts, []);
});

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

test("planPull keeps local edits, takes Rosebud's, and calls changes on both sides conflicts", () => {
  const m = (o) => new Map(Object.entries(o));
  const base = m({
    same: "1",
    local: "1",
    remote: "1",
    both: "1",
    gone: "1",
    goneEdited: "1",
    deletedHere: "1",
  });
  const remote = m({
    same: "1",
    local: "1",
    remote: "2",
    both: "2",
    deletedHere: "1",
    fresh: "9",
  });
  const local = m({
    same: "1",
    local: "2",
    remote: "1",
    both: "3",
    gone: "1",
    goneEdited: "5",
    mine: "7",
  });
  assert.deepEqual(planPull(remote, local, base), {
    write: ["fresh", "remote"],
    remove: ["gone"],
    conflicts: [
      { path: "both", reason: "both_changed" },
      { path: "goneEdited", reason: "remote_deleted" },
    ],
    localOnly: ["mine"],
    missing: ["deletedHere"],
    localNames: new Map(),
  });
  // Without a last sync, every difference is a conflict, so nothing local is lost.
  assert.deepEqual(
    planPull(m({ a: "1", b: "2" }), m({ a: "9", c: "3" }), undefined).conflicts,
    [{ path: "a", reason: "both_changed" }],
  );
  // --force settles conflicts for Rosebud, but leaves changes made only here alone.
  // It also restores a file deleted here that Rosebud still has.
  assert.deepEqual(planPull(remote, local, base, true), {
    write: ["both", "deletedHere", "fresh", "remote"],
    remove: ["gone", "goneEdited"],
    conflicts: [],
    localOnly: ["mine"],
    missing: [],
    localNames: new Map(),
  });
  assert.deepEqual(
    planPull(
      m({ x: "2", y: "1" }),
      m({ y: "1", z: "1" }),
      m({ x: "1", y: "1" }),
      true,
    ),
    {
      write: ["x"],
      remove: [],
      conflicts: [],
      localOnly: ["z"],
      missing: [],
      localNames: new Map(),
    },
  );
  // A file deleted here and changed in Rosebud is a conflict too.
  assert.deepEqual(planPull(m({ x: "2" }), m({}), m({ x: "1" })).conflicts, [
    { path: "x", reason: "local_deleted" },
  ]);
});

test("planPull matches names the way the disk does, and refuses Rosebud names that would land on one file", () => {
  const m = (o) => new Map(Object.entries(o));
  // A disk like macOS's: letter case and Unicode form don't tell names apart.
  const fold = (path) => path.normalize("NFC").toLowerCase();
  const nfd = "café.js",
    nfc = "café.js";
  const game = m({
    "index.html": "i",
    "Foo.js": "U",
    "foo.js": "l",
    "Scripts/a.js": "a",
    "scripts/b.js": "b",
    "Scripts/c.js": "c",
  });
  const collisions = [
    ["Foo.js", "name_collision", "foo.js"],
    ["Scripts/a.js", "name_collision", "scripts/b.js"],
    ["Scripts/c.js", "name_collision", "scripts/b.js"],
    ["foo.js", "name_collision", "Foo.js"],
    ["scripts/b.js", "name_collision", "Scripts/a.js"],
  ];
  const brief = (plan) =>
    plan.conflicts.map((c) => [c.path, c.reason, c.clashesWith]);
  // Neither of two colliding names is written, even with --force, and a local
  // file under one of them is left alone rather than listed or removed.
  for (const force of [false, true]) {
    const plan = planPull(
      game,
      m({ "foo.js": "mine" }),
      m({ "foo.js": "old" }),
      force,
      { fold },
    );
    assert.deepEqual(plan.write, ["index.html"]);
    assert.deepEqual(brief(plan), collisions);
    assert.deepEqual([plan.remove, plan.localOnly], [[], []]);
  }
  // A disk that tells them apart holds them all.
  assert.deepEqual(
    planPull(game, m({}), undefined).write,
    [...game.keys()].sort(),
  );

  const one = (remote, local, base, force = false, folders) =>
    planPull(m(remote), m(local), base && m(base), force, { fold, folders });
  // The agent's edit to a file Rosebud holds under another Unicode form is kept…
  assert.deepEqual(one({ [nfc]: "p" }, { [nfd]: "edit" }, { [nfd]: "p" }), {
    write: [],
    remove: [],
    conflicts: [],
    localOnly: [],
    missing: [],
    localNames: new Map(),
  });
  // …and when Rosebud changed it too, it is a conflict.
  assert.deepEqual(
    brief(one({ [nfc]: "r" }, { [nfd]: "edit" }, { [nfd]: "p" })),
    [[nfc, "both_changed", undefined]],
  );
  // Rosebud's change lands on the local file, under the local name.
  const taken = one({ [nfc]: "r" }, { [nfd]: "p" }, { [nfd]: "p" });
  assert.deepEqual(
    [taken.write, taken.localNames],
    [[nfc], new Map([[nfc, nfd]])],
  );
  // Rosebud renamed a file by case: the old name goes, the new one is written.
  const renamed = one({ "foo.js": "1" }, { "Foo.js": "1" }, { "Foo.js": "1" });
  assert.deepEqual([renamed.write, renamed.remove], [["foo.js"], ["Foo.js"]]);
  // The agent renamed it by case: that goes up with the next update.
  assert.deepEqual(
    one({ "Foo.js": "1" }, { "foo.js": "1" }, { "Foo.js": "1" }).write,
    [],
  );
  // Renamed in Rosebud and edited here: a case_conflict, which --force settles for Rosebud.
  assert.deepEqual(
    brief(one({ "foo.js": "2" }, { "Foo.js": "mine" }, { "Foo.js": "1" })),
    [["foo.js", "case_conflict", "Foo.js"]],
  );
  const forced = one(
    { "foo.js": "2" },
    { "Foo.js": "mine" },
    { "Foo.js": "1" },
    true,
  );
  assert.deepEqual([forced.write, forced.remove], [["foo.js"], ["Foo.js"]]);
  // A file of the agent's own under another case is never replaced, even with --force.
  for (const force of [false, true]) {
    const own = one({ "readme.md": "r" }, { "README.md": "mine" }, {}, force);
    assert.deepEqual(brief(own), [["readme.md", "case_conflict", "README.md"]]);
    assert.deepEqual([own.write, own.remove, own.localOnly], [[], [], []]);
  }
  // A folder here spelled differently would take Rosebud's file under its own name.
  for (const force of [false, true]) {
    const folder = one(
      { "scripts/b.js": "b" },
      { "Scripts/mine.js": "m" },
      {},
      force,
      ["Scripts"],
    );
    assert.deepEqual(brief(folder), [
      ["scripts/b.js", "case_conflict", "Scripts"],
    ]);
    assert.deepEqual(
      [folder.write, folder.localOnly],
      [[], ["Scripts/mine.js"]],
    );
  }
  // Rosebud renamed a folder by case: the folder here must be renamed first.
  const moved = one(
    { "scripts/a.js": "a" },
    { "Scripts/a.js": "a" },
    { "Scripts/a.js": "a" },
    true,
  );
  assert.deepEqual(brief(moved), [
    ["scripts/a.js", "case_conflict", "Scripts"],
  ]);
  assert.deepEqual([moved.write, moved.remove], [[], []]);
});

test("safePath keeps every write inside the folder", () => {
  for (const ok of [
    "index.html",
    "rosie/README.md",
    "assets/café.png",
    "levels/My Level.json",
  ])
    assert.ok(safePath(ok), ok);
  for (const bad of [
    "",
    "/etc/passwd",
    "../x",
    "a/../../x",
    "a\\b",
    "C:x",
    ".env",
    "a/.git/x",
    "a//b",
    "x\u0000",
    "a/",
    "./x",
    "a/./b",
    "\\\\server\\share\\x",
    `${"a".repeat(256)}.js`,
    `${"d/".repeat(250)}x.js`,
  ])
    assert.ok(!safePath(bad), bad);
});

test("files returns Rosebud's current files and refuses a malformed answer", async (t) => {
  const game = await fakeRosebud(t);
  game.edit({
    text: { "index.html": "one" },
    media: { "assets/hero.png": png },
  });
  const files = await new Rosebud({ apiBaseUrl: game.base }).files({
    projectId: PROJECT,
    agentToken: AGENT,
  });
  assert.equal(files.content_version, game.version);
  assert.deepEqual(files.files, [{ path: "index.html", content: "one" }]);
  assert.equal(files.media[0].md5, md5(png));
  // Far past the 1 MiB that other JSON answers may take.
  game.edit({ text: { "big.js": "x".repeat(3 * 1024 * 1024) } });
  const large = await new Rosebud({ apiBaseUrl: game.base }).files({
    projectId: PROJECT,
    agentToken: AGENT,
  });
  assert.equal(
    large.files.find((f) => f.path === "big.js")?.content.length,
    3 * 1024 * 1024,
  );
  const good = {
    project_id: PROJECT,
    content_version: "a".repeat(64),
    files: [],
    media: [],
  };
  const media = {
    path: "assets/a.png",
    url: "/media/a",
    size: 8,
    md5: null,
    media_file_id: randomUUID(),
  };
  for (const bad of [
    { ...good, project_id: randomUUID() },
    { ...good, content_version: "short" },
    { ...good, files: [{ path: "a.js" }] },
    { ...good, media: [{ ...media, md5: "NOT-HEX" }] },
    { ...good, media: [{ ...media, size: "8" }] },
    { ...good, media: "none" },
  ]) {
    const api = await rogueServer(t, (_req, res) =>
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(bad)),
    );
    await assert.rejects(
      new Rosebud({ apiBaseUrl: api.base }).files({
        projectId: PROJECT,
        agentToken: AGENT,
      }),
      (e) => e.code === "unexpected_response",
      JSON.stringify(bad),
    );
  }
  const api = await rogueServer(t, (_req, res) =>
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ ...good, media: [media] })),
  );
  const ok = await new Rosebud({ apiBaseUrl: api.base }).files({
    projectId: PROJECT,
    agentToken: AGENT,
  });
  assert.equal(ok.media[0].md5, null);
});

test("pull brings Rosie's edits into an unchanged folder, then update succeeds without re-uploading", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, {
    "index.html": "one",
    "game.js": "v1",
    "assets/hero.png": png,
  });
  game.edit({
    text: { "game.js": "v2", "AGENTS.md": "# Rosie notes" },
    media: { "assets/new.png": png },
    remove: ["index.html"],
  });
  game.edit({ text: { "index.html": "two" } });
  const pull = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(pull.code, 0, JSON.stringify(pull.error));
  assert.equal(pull.data.status, "synced");
  assert.equal(await readFile(join(root, "dist/game.js"), "utf8"), "v2");
  assert.equal(
    await readFile(join(root, "dist/AGENTS.md"), "utf8"),
    "# Rosie notes",
  );
  assert.deepEqual(await readFile(join(root, "dist/assets/new.png")), png);
  assert.equal((await handle(root)).content_version, game.version);
  const puts = game.puts.length;
  await writeFile(join(root, "dist/game.js"), "v3");
  const update = await run(root, ["update", "--directory", "dist"]);
  assert.equal(update.code, 0, JSON.stringify(update.error));
  assert.equal(game.text.get("AGENTS.md"), "# Rosie notes");
  assert.equal(game.puts.length, puts);
});

test("pull removes what Rosebud deleted, keeps files Rosebud never had and local edits", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, {
    "index.html": "one",
    "old.js": "1",
    "keep.js": "1",
  });
  await writeFile(join(root, "dist/mine.js"), "x");
  await writeFile(join(root, "dist/keep.js"), "edited");
  game.edit({ remove: ["old.js"] });
  const pull = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(pull.code, 0, JSON.stringify(pull.error));
  assert.equal(pull.data.status, "synced");
  assert.deepEqual(pull.data.removed, ["old.js"]);
  assert.deepEqual(pull.data.local_only, ["mine.js"]);
  assert.deepEqual((await readdir(join(root, "dist"))).sort(), [
    "index.html",
    "keep.js",
    "mine.js",
  ]);
  assert.equal(await readFile(join(root, "dist/keep.js"), "utf8"), "edited");
  // Rosebud's manifest is the new base: neither local file is part of it as an edit of Rosebud's.
  assert.equal((await handle(root)).files["old.js"], undefined);
  assert.equal((await handle(root)).files["keep.js"], md5(Buffer.from("1")));
});

test("pull into a folder that was deleted writes every file again", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, {
    "index.html": "one",
    "game.js": "1",
  });
  await rm(join(root, "dist"), { recursive: true });
  const pull = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(pull.code, 0, JSON.stringify(pull.error));
  assert.equal(pull.data.status, "synced");
  assert.deepEqual(pull.data.written, ["game.js", "index.html"]);
  assert.deepEqual(pull.data.missing_locally, []);
  assert.equal(await readFile(join(root, "dist/game.js"), "utf8"), "1");
  // An emptied folder is the same: nothing in it, so nothing of a last sync.
  await rm(join(root, "dist/game.js"));
  await rm(join(root, "dist/index.html"));
  await writeFile(join(root, "dist/.DS_Store"), "junk");
  const emptied = await run(root, ["pull", "--directory", "dist"]);
  assert.deepEqual(emptied.data.written, ["game.js", "index.html"]);
});

test("pull into another folder than the last sync's writes every file there", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, {
    "index.html": "one",
    "game.js": "1",
  });
  await mkdir(join(root, "game"));
  await writeFile(join(root, "game/notes.txt"), "mine");
  const pull = await run(root, ["pull", "--directory", "game"]);
  assert.equal(pull.code, 0, JSON.stringify(pull.error));
  assert.deepEqual(pull.data.written, ["game.js", "index.html"]);
  assert.deepEqual(pull.data.local_only, ["notes.txt"]);
  assert.deepEqual(pull.data.missing_locally, []);
  assert.match(pull.data.directory, /game$/);
  assert.equal((await handle(root)).directory, pull.data.directory);
  // Back in the first folder, its files are compared without that other sync.
  await rm(join(root, "dist/game.js"));
  const back = await run(root, ["pull", "--directory", "dist"]);
  assert.deepEqual(back.data.written, ["game.js"]);
  assert.equal(back.data.status, "synced");
});

test("files deleted here are reported, --force restores them, and the next update deletes them", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, {
    "index.html": "one",
    "game.js": "1",
    "art.js": "2",
  });
  await rm(join(root, "dist/game.js"));
  const pull = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(pull.code, 0, JSON.stringify(pull.error));
  assert.equal(pull.data.status, "synced");
  assert.deepEqual(pull.data.written, []);
  assert.deepEqual(pull.data.missing_locally, ["game.js"]);
  assert.match(
    pull.data.next_action,
    /1 file Rosebud has is missing here: `game\.js`/,
  );
  assert.match(
    pull.data.next_action,
    /your next update removes it from the game/,
  );
  assert.match(
    pull.data.next_action,
    /`rosebud pull --directory dist --force` restores it/,
  );
  assert.match(pull.data.next_action, /^1 file Rosebud has is missing here/);
  await assert.rejects(readFile(join(root, "dist/game.js")));
  const forced = await run(root, ["pull", "--directory", "dist", "--force"]);
  assert.deepEqual(forced.data.written, ["game.js"]);
  assert.deepEqual(forced.data.missing_locally, []);
  assert.equal(await readFile(join(root, "dist/game.js"), "utf8"), "1");
  // A deliberate deletion still goes up with the next update.
  await rm(join(root, "dist/game.js"));
  await rm(join(root, "dist/art.js"));
  const again = await run(root, ["pull", "--directory", "dist"]);
  assert.deepEqual(again.data.missing_locally, ["art.js", "game.js"]);
  assert.match(again.data.next_action, /2 files Rosebud has are missing here/);
  const update = await run(root, ["update", "--directory", "dist"]);
  assert.equal(update.code, 0, JSON.stringify(update.error));
  assert.deepEqual([...game.text.keys()], ["index.html"]);
});

test("pull keeps conflicting local edits, saves Rosebud's copy beside the state, and update still needs --expected-version", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one" });
  const published = (await handle(root)).content_version;
  await writeFile(join(root, "dist/index.html"), "mine");
  game.edit({ text: { "index.html": "rosie's" } });
  const blocked = await run(root, ["update", "--directory", "dist"]);
  assert.equal(blocked.error.code, "version_conflict");
  assert.deepEqual(blocked.error.changed_paths, ["index.html"]);
  const pull = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(pull.data.status, "conflicts");
  assert.equal(await readFile(join(root, "dist/index.html"), "utf8"), "mine");
  const copy = pull.data.conflicts[0].rosebud_copy;
  assert.equal(await readFile(copy, "utf8"), "rosie's");
  // Only a conflict between two names says which other name it clashes with.
  assert.ok(!("clashes_with" in pull.data.conflicts[0]));
  // Beside the state file, so never inside the folder that update uploads.
  assert.equal(
    await realpath(dirname(copy)),
    join(await realpath(root), ".rosebud", "project.remote"),
  );
  assert.equal(pull.data.content_version, game.version);
  assert.equal((await handle(root)).content_version, published);
  assert.equal(
    (await run(root, ["update", "--directory", "dist"])).error.code,
    "version_conflict",
  );
  // Asking again must not forget the conflict and let update overwrite Rosie's edit.
  const again = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(again.data.status, "conflicts");
  assert.equal((await handle(root)).content_version, published);
  assert.equal(
    await readFile(again.data.conflicts[0].rosebud_copy, "utf8"),
    "rosie's",
  );
  await writeFile(join(root, "dist/index.html"), "mine + rosie's");
  const merged = await run(root, [
    "update",
    "--directory",
    "dist",
    "--expected-version",
    pull.data.content_version,
  ]);
  assert.equal(merged.code, 0, JSON.stringify(merged.error));
  assert.equal(game.text.get("index.html"), "mine + rosie's");
  const forced = await run(root, ["pull", "--directory", "dist", "--force"]);
  assert.equal(forced.data.status, "synced");
});

test("pull --force takes Rosebud's copies and moves the version on", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one" });
  await writeFile(join(root, "dist/index.html"), "mine");
  game.edit({ text: { "index.html": "rosie's" } });
  const forced = await run(root, ["pull", "--directory", "dist", "--force"]);
  assert.equal(forced.code, 0, JSON.stringify(forced.error));
  assert.equal(forced.data.status, "synced");
  assert.deepEqual(forced.data.written, ["index.html"]);
  assert.equal(
    await readFile(join(root, "dist/index.html"), "utf8"),
    "rosie's",
  );
  assert.equal((await handle(root)).content_version, game.version);
  assert.equal((await run(root, ["update", "--directory", "dist"])).code, 0);
});

test("a file deleted on one side and changed on the other is a conflict, and Rosebud's deletion has no copy", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, {
    "index.html": "one",
    "a.js": "1",
    "b.js": "1",
  });
  await rm(join(root, "dist/a.js"));
  await writeFile(join(root, "dist/b.js"), "mine");
  game.edit({ text: { "a.js": "2" }, remove: ["b.js"] });
  const pull = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(pull.code, 0, JSON.stringify(pull.error));
  assert.equal(pull.data.status, "conflicts");
  assert.deepEqual(
    pull.data.conflicts.map((c) => [c.path, c.reason, c.rosebud_copy === null]),
    [
      ["a.js", "local_deleted", false],
      ["b.js", "remote_deleted", true],
    ],
  );
  assert.equal(
    await readFile(pull.data.conflicts[0].rosebud_copy, "utf8"),
    "2",
  );
  assert.equal(await readFile(join(root, "dist/b.js"), "utf8"), "mine");
  await assert.rejects(readFile(join(root, "dist/a.js")));
});

test("a handle without files treats every difference as a conflict and then records Rosebud's files", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one", "a.js": "1" });
  const old = await handle(root);
  delete old.files;
  delete old.media;
  await writeFile(join(root, ".rosebud/project.json"), JSON.stringify(old));
  await writeFile(join(root, "dist/a.js"), "mine");
  game.edit({ text: { "a.js": "2", "b.js": "3" } });
  const pull = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(pull.code, 0, JSON.stringify(pull.error));
  assert.deepEqual(
    pull.data.conflicts.map((c) => [c.path, c.reason]),
    [["a.js", "both_changed"]],
  );
  assert.deepEqual(pull.data.written, ["b.js"]);
  assert.equal(await readFile(join(root, "dist/a.js"), "utf8"), "mine");
  const after = await handle(root);
  assert.equal(after.files["b.js"], md5(Buffer.from("3")));
  assert.equal(after.content_version, old.content_version);
});

test("pull refuses unsafe remote paths and never writes outside the folder", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one" });
  game.edit({
    text: {
      "../escape.js": "x",
      "a/../../escape2.js": "x",
      ".hidden/x.js": "x",
    },
  });
  const pull = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(pull.code, 0, JSON.stringify(pull.error));
  assert.deepEqual(pull.data.skipped.map((s) => s.path).sort(), [
    "../escape.js",
    ".hidden/x.js",
    "a/../../escape2.js",
  ]);
  assert.deepEqual((await readdir(root)).sort(), [
    ".rosebud",
    "credentials",
    "dist",
  ]);
  assert.deepEqual(await readdir(join(root, "dist")), ["index.html"]);
});

test("pull skips absolute, backslash and drive-letter paths, and unsafe media paths", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one" });
  game.edit({
    text: { "/abs.js": "x", "a\\b.js": "x", "C:x.js": "x", "a//b.js": "x" },
    media: { "../hero.png": png, "assets/ok.png": png },
  });
  const pull = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(pull.code, 0, JSON.stringify(pull.error));
  assert.deepEqual(pull.data.skipped.map((s) => s.path).sort(), [
    "../hero.png",
    "/abs.js",
    "C:x.js",
    "a//b.js",
    "a\\b.js",
  ]);
  assert.ok(pull.data.skipped.every((s) => s.reason === "unsafe_path"));
  assert.deepEqual((await readdir(root)).sort(), [
    ".rosebud",
    "credentials",
    "dist",
  ]);
  assert.deepEqual((await readdir(join(root, "dist"))).sort(), [
    "assets",
    "index.html",
  ]);
  assert.match(pull.data.next_action, /skipped/);
  assert.deepEqual((await handle(root)).media, ["assets/ok.png"]);
});

test(
  "pull never follows a link in the folder",
  { skip: process.platform === "win32" }, // creating links needs privileges there
  async (t) => {
    const game = await fakeRosebud(t);
    const root = await connected(t, game, { "index.html": "one" });
    const outside = await folder(t, { "target.txt": "safe" });
    const before = await handle(root);
    game.edit({ text: { "linked/x.js": "x", "index.html": "two" } });
    // A folder replaced by a link is not followed.
    await symlink(outside, join(root, "dist/linked"));
    const linked = await run(root, ["pull", "--directory", "dist"]);
    assert.equal(linked.error.code, "unsupported_input");
    assert.deepEqual(await readdir(outside), ["target.txt"]);
    assert.equal(await readFile(join(root, "dist/index.html"), "utf8"), "one");
    // Neither is a file link, even one Rosebud also changed.
    await rm(join(root, "dist/linked"));
    await rm(join(root, "dist/index.html"));
    await symlink(join(outside, "target.txt"), join(root, "dist/index.html"));
    const file = await run(root, ["pull", "--directory", "dist"]);
    assert.equal(file.error.code, "unsupported_input");
    assert.equal(await readFile(join(outside, "target.txt"), "utf8"), "safe");
    // Nor a link at the folder itself.
    await rm(join(root, "dist"), { recursive: true });
    await symlink(outside, join(root, "dist"));
    const top = await run(root, ["pull", "--directory", "dist"]);
    assert.equal(top.error.code, "unsupported_input");
    assert.deepEqual(await readdir(outside), ["target.txt"]);
    assert.deepEqual(await handle(root), before);
  },
);

test("pull keeps Rosebud's copies out of the folder", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one" });
  game.edit({ text: { "index.html": "two" } });
  for (const directory of [
    ".rosebud/project.remote",
    ".rosebud/project.remote/game",
  ]) {
    const refused = await run(root, ["pull", "--directory", directory]);
    assert.equal(refused.error.code, "state_in_build", directory);
  }
  assert.deepEqual(await readdir(join(root, ".rosebud")), ["project.json"]);
});

test("pull needs --directory, refuses --zip and wants an approved connection", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one" });
  assert.equal((await run(root, ["pull"])).error.code, "input_required");
  const zipped = await run(root, [
    "pull",
    "--directory",
    "dist",
    "--zip",
    "a.zip",
  ]);
  assert.equal(zipped.error.code, "input_required");
  assert.equal(zipped.code, 2);
  const fresh = await folder(t, { "dist/index.html": "one" });
  assert.equal(
    (
      await run(fresh, [
        "publish",
        "--directory",
        "dist",
        "--api-base",
        game.base,
      ])
    ).code,
    0,
  );
  const unconnected = await run(fresh, ["pull", "--directory", "dist"]);
  assert.equal(unconnected.error.code, "connection_required");
});

test("a pull that fails part-way leaves the handle unchanged, and a rerun finishes it", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, {
    "index.html": "one",
    "assets/hero.png": png,
  });
  game.edit({
    text: { "AGENTS.md": "notes" },
    media: { "assets/new.png": Buffer.concat([png, png]) },
  });
  const before = await handle(root);
  game.failMedia = 1;
  const failed = await run(root, ["pull", "--directory", "dist"]);
  assert.notEqual(failed.code, 0);
  assert.deepEqual(await handle(root), before);
  assert.deepEqual(await readdir(join(root, "dist/assets")), ["hero.png"]);
  const rerun = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(rerun.code, 0, JSON.stringify(rerun.error));
  assert.equal(rerun.data.status, "synced");
  assert.equal(await readFile(join(root, "dist/AGENTS.md"), "utf8"), "notes");
  assert.equal((await readFile(join(root, "dist/assets/new.png"))).length, 16);
  assert.equal((await handle(root)).content_version, game.version);
  assert.deepEqual(await readdir(join(root, ".rosebud")), ["project.json"]);
});

test("a download that fails its MD5 is refused and never replaces the file or moves the handle", async (t) => {
  const game = await fakeRosebud(t, { damageMedia: true });
  const root = await connected(t, game, {
    "index.html": "one",
    "assets/hero.png": png,
  });
  game.edit({ media: { "assets/hero.png": Buffer.concat([png, png]) } });
  const before = await handle(root);
  const pull = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(pull.error.code, "download_corrupt");
  assert.deepEqual(await readFile(join(root, "dist/assets/hero.png")), png);
  assert.deepEqual(await readdir(join(root, "dist/assets")), ["hero.png"]);
  assert.deepEqual(await handle(root), before);
});

test("media without an MD5 is downloaded once, then moved into place", async (t) => {
  const game = await fakeRosebud(t, { hideMd5: true });
  const root = await connected(t, game, {
    "index.html": "one",
    "assets/hero.png": png,
  });
  const added = Buffer.concat([png, png]);
  game.edit({ media: { "assets/new.png": added } });
  const gets = (path) =>
    game.requests.filter((r) => r.path === `/media/${encodeURIComponent(path)}`)
      .length;
  const pull = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(pull.code, 0, JSON.stringify(pull.error));
  assert.equal(gets("assets/new.png"), 1);
  assert.deepEqual(await readFile(join(root, "dist/assets/new.png")), added);
  assert.deepEqual(pull.data.written, ["assets/new.png"]);
  assert.equal((await handle(root)).files["assets/new.png"], md5(added));
  // The unchanged file was fetched to learn its MD5, and left alone.
  assert.equal(gets("assets/hero.png"), 1);
  assert.deepEqual(await readFile(join(root, "dist/assets/hero.png")), png);
  assert.deepEqual(await readdir(join(root, ".rosebud")), ["project.json"]);
  assert.deepEqual((await readdir(join(root, "dist/assets"))).sort(), [
    "hero.png",
    "new.png",
  ]);
});

test("a conflicting media file's copy comes from the same single download", async (t) => {
  const game = await fakeRosebud(t, { hideMd5: true });
  const root = await connected(t, game, {
    "index.html": "one",
    "assets/hero.png": png,
  });
  const theirs = Buffer.concat([png, png]);
  await writeFile(
    join(root, "dist/assets/hero.png"),
    Buffer.concat([png, png, png]),
  );
  game.edit({ media: { "assets/hero.png": theirs } });
  const pull = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(pull.code, 0, JSON.stringify(pull.error));
  assert.equal(pull.data.status, "conflicts");
  assert.deepEqual(await readFile(pull.data.conflicts[0].rosebud_copy), theirs);
  assert.equal(
    game.requests.filter((r) => r.path.startsWith("/media/")).length,
    1,
  );
  assert.equal((await readFile(join(root, "dist/assets/hero.png"))).length, 24);
});

test("a handle whose files, media or folder are malformed is refused", async (t) => {
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
    { directory: 1 },
    { directory: null },
  ]) {
    await writeFile(state, JSON.stringify({ ...good, ...bad }));
    const refused = await run(root, ["status"]);
    assert.equal(refused.error.code, "state_format", JSON.stringify(bad));
  }
  await writeFile(state, JSON.stringify(good));
  assert.equal((await run(root, ["status"])).code, 0);
});

test("pull on a plan without code download is refused as plan_required", async (t) => {
  const game = await fakeRosebud(t, { pro: false });
  const root = await connected(t, game, { "index.html": "one" });
  const pull = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(pull.code, 3);
  assert.equal(pull.error.code, "plan_required");
});

test("pull on a plan without code download explains that publishing still works", async (t) => {
  const game = await fakeRosebud(t, { pro: false });
  const root = await connected(t, game, { "index.html": "one" });
  const pull = await run(root, ["pull", "--directory", "dist"]);
  assert.match(pull.error.next_action, /updating still work/);
  assert.doesNotMatch(pull.error.next_action, /\$|price|upgrade/i);
});

test("errors carry changed paths, numeric limits and what to do next", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one" });
  game.edit({ text: { "index.html": "rosie's", "AGENTS.md": "notes" } });
  await writeFile(join(root, "dist/index.html"), "mine");
  const conflict = await run(root, ["update", "--directory", "dist"]);
  assert.equal(conflict.code, 3);
  assert.deepEqual(conflict.error.changed_paths, ["AGENTS.md", "index.html"]);
  assert.match(conflict.error.next_action, /rosebud pull --directory/);
  assert.equal(
    conflict.error.next_action,
    "Rosebud changed 2 file(s) since your last sync: `AGENTS.md`, `index.html`. Run `rosebud pull --directory dist` to bring them in, merge, then update again.",
  );
});

test("a conflict says what to do whether Rosebud names files, none, or can't tell", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one" });
  // Only metadata changed in Rosebud: the version moves, no file does.
  game.version = "f".repeat(64);
  const metadata = await run(root, ["update", "--directory", "dist"]);
  assert.deepEqual(metadata.error.changed_paths, []);
  assert.equal(
    metadata.error.next_action,
    "Only the game's title, description or cover changed in Rosebud. Run `rosebud status` and pass its content_version as `--expected-version`.",
  );
  // A version Rosebud has no record of: it can't say what changed.
  const unknown = await run(root, [
    "update",
    "--directory",
    "dist",
    "--expected-version",
    "e".repeat(64),
  ]);
  assert.equal(unknown.error.changed_paths, null);
  assert.equal(
    unknown.error.next_action,
    "Rosebud can't tell which files changed. Run `rosebud pull --directory dist` and compare before updating.",
  );
  // Many files: name ten and say there are more.
  game.edit({
    text: Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `f${String(i + 1).padStart(2, "0")}.js`,
        "x",
      ]),
    ),
  });
  const many = await run(root, [
    "update",
    "--directory",
    "dist",
    "--expected-version",
    (await handle(root)).content_version,
  ]);
  assert.equal(many.error.changed_paths.length, 12);
  assert.match(many.error.next_action, /^Rosebud changed 12 file\(s\)/);
  assert.match(many.error.next_action, /`f10\.js`, …\./);
  assert.doesNotMatch(many.error.next_action, /f11/);
});

test("a conflict's pull command names the same folder and state file the update used", async (t) => {
  const game = await fakeRosebud(t);
  const state = ".rosebud/b.json";
  const root = await connected(
    t,
    game,
    { "index.html": "one" },
    { directory: "my game", state },
  );
  game.edit({ text: { "index.html": "rosie's" } });
  const conflict = await run(root, [
    "update",
    "--directory",
    "my game",
    "--state",
    state,
  ]);
  assert.match(
    conflict.error.next_action,
    /Run `rosebud pull --directory (['"])my game\1 --state \.rosebud\/b\.json` to bring them in/,
  );
  // With a ZIP there is no folder to name.
  await writeFile(
    join(root, "game.zip"),
    zipSync({ "index.html": strToU8("z") }),
  );
  const zipped = await run(root, [
    "update",
    "--zip",
    "game.zip",
    "--state",
    state,
  ]);
  assert.match(
    zipped.error.next_action,
    /`rosebud pull --directory <your game folder> --state \.rosebud\/b\.json`/,
  );
});

test("refusals say what to do next, never mention pricing, and give limits as numbers", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one" });
  await writeFile(join(root, "dist/index.html"), "two");
  const refused = async (status, error) => {
    game.inject.push({ path: "/releases/", status, error });
    return run(root, ["update", "--directory", "dist"]);
  };
  // Servers before ENG-4832 send the limit as a string.
  const tooMuch = await refused(400, {
    code: "release_upload_limit",
    limit: "20971520",
  });
  assert.equal(tooMuch.code, 3);
  assert.equal(tooMuch.error.limit, 20971520);
  assert.equal(
    tooMuch.error.next_action,
    "This update adds more new media than Rosebud takes at once (limit: 20971520 bytes). Update with part of the new media first, then again with the rest; files Rosebud already has are not uploaded again.",
  );
  const numeric = await refused(400, {
    code: "release_upload_limit",
    limit: 5242880,
  });
  assert.equal(numeric.error.limit, 5242880);
  assert.match(numeric.error.next_action, /\(limit: 5242880 bytes\)/);
  const unsaid = await refused(400, { code: "release_upload_limit" });
  assert.equal(unsaid.error.limit, undefined);
  assert.doesNotMatch(unsaid.error.next_action, /limit:/);
  for (const [status, code] of [
    [409, "upload_stale"],
    [410, "upload_expired"],
    [404, "invalid_upload"],
  ]) {
    const result = await refused(status, { code });
    assert.equal(
      result.error.next_action,
      "Run the same command again; it declares the media in a new upload session.",
      code,
    );
  }
  // An unrelated refusal gets no advice.
  const plain = await refused(400, { code: "invalid_media" });
  assert.equal(plain.error.next_action, undefined);
  // A Rosebud without the file API is an uncertain outcome, still with advice.
  game.sync = false;
  const old = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(old.error.code, "sync_unavailable");
  assert.equal(
    old.error.next_action,
    "This Rosebud server can't read files back or take file-by-file uploads yet.",
  );
  for (const result of [tooMuch, numeric, old])
    assert.doesNotMatch(result.error.next_action, /\$|price|pricing|upgrade/i);
});

/** The saved pending operation's id, from the credential files under root. */
async function pendingOperation(root) {
  const dir = join(root, "credentials");
  for (const name of await readdir(dir, { recursive: true })) {
    let saved;
    try {
      saved = JSON.parse(await readFile(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    if (saved.pending) return saved.pending.operation_id;
  }
  return undefined;
}

test("a busy Rosebud refused the update unapplied: it is a plain rejection, so the next update may change anything", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one" });
  const injectBusy = (retryAfter) =>
    game.inject.push({
      path: "/releases/",
      status: 503,
      ...(retryAfter === undefined
        ? {}
        : { headers: { "Retry-After": retryAfter } }),
      error: { code: "busy" },
    });
  await writeFile(join(root, "dist/index.html"), "two");
  injectBusy("7");
  const busy = await run(root, ["update", "--directory", "dist"]);
  assert.equal(busy.code, 3);
  assert.equal(busy.error.kind, "api");
  assert.equal(busy.error.code, "busy");
  assert.equal(busy.error.outcome, "rejected");
  assert.equal(busy.error.status, 503);
  assert.equal(busy.error.retry_after_seconds, 7);
  assert.equal(
    busy.error.next_action,
    "Rosebud is busy. Run the same command again in 7 seconds; nothing was changed.",
  );
  assert.equal(game.releases, 1); // only the publish
  assert.equal(await pendingOperation(root), undefined);
  // Changed input after busy is an ordinary new update, not an uncertain one.
  await writeFile(join(root, "dist/index.html"), "three");
  const changed = await run(root, ["update", "--directory", "dist"]);
  assert.equal(changed.code, 0, JSON.stringify(changed.error));
  assert.equal(game.text.get("index.html"), "three");
  // Busy, then a Rosebud edit: pull brings it in and update carries on.
  await writeFile(join(root, "dist/index.html"), "four");
  injectBusy("1");
  assert.equal(
    (await run(root, ["update", "--directory", "dist"])).error.next_action,
    "Rosebud is busy. Run the same command again in 1 second; nothing was changed.",
  );
  game.edit({ text: { "AGENTS.md": "rosie's notes" } });
  const pulled = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(pulled.code, 0, JSON.stringify(pulled.error));
  assert.equal(pulled.data.status, "synced");
  const merged = await run(root, ["update", "--directory", "dist"]);
  assert.equal(merged.code, 0, JSON.stringify(merged.error));
  assert.equal(game.text.get("index.html"), "four");
  assert.equal(game.text.get("AGENTS.md"), "rosie's notes");
  // Without a usable Retry-After there is nothing to count.
  for (const retryAfter of [undefined, "0"]) {
    injectBusy(retryAfter);
    const soon = await run(root, ["update", "--directory", "dist"]);
    assert.equal(
      soon.error.next_action,
      "Rosebud is busy. Run the same command again shortly; nothing was changed.",
      String(retryAfter),
    );
  }
  // Only Rosebud's own busy answer is known not to have been applied.
  await writeFile(join(root, "dist/index.html"), "five");
  game.inject.push({ path: "/releases/", status: 503, error: { code: "x" } });
  assert.equal((await run(root, ["update", "--directory", "dist"])).code, 4);
});

test("a busy refusal of a retry after an uncertain update keeps the operation, so the rerun replays it", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one" });
  await writeFile(join(root, "dist/index.html"), "two");
  game.loseNextRelease = true;
  assert.equal((await run(root, ["update", "--directory", "dist"])).code, 4);
  const operation = await pendingOperation(root);
  assert.ok(operation);
  game.inject.push({
    path: "/releases/",
    status: 503,
    error: { code: "busy" },
  });
  const busy = await run(root, ["update", "--directory", "dist"]);
  assert.equal(busy.code, 3);
  // The lost attempt may have been applied, so only its own retry may settle it.
  assert.equal(await pendingOperation(root), operation);
  const again = await run(root, ["update", "--directory", "dist"]);
  assert.equal(again.code, 0, JSON.stringify(again.error));
  assert.deepEqual([...game.operations.keys()], [operation]);
  assert.equal(game.releases, 2); // the publish and the one applied update
  assert.equal(await pendingOperation(root), undefined);
});

test("a changed update after an uncertain one is refused with the way out", async (t) => {
  const game = await fakeRosebud(t);
  const state = ".rosebud/b.json";
  const root = await connected(t, game, { "index.html": "one" }, { state });
  await writeFile(join(root, "dist/index.html"), "two");
  game.loseNextRelease = true;
  const args = ["update", "--directory", "dist", "--state", state];
  assert.equal((await run(root, args)).code, 4);
  await writeFile(join(root, "dist/index.html"), "three");
  const refused = await run(root, args);
  assert.equal(refused.code, 2);
  assert.equal(refused.error.code, "pending_operation");
  assert.equal(
    refused.error.next_action,
    "Run `rosebud status --state .rosebud/b.json`, reconcile what changed in Rosebud into your files, then run your update again with `--expected-version <content_version from status>`. To retry the earlier update unchanged, rerun its identical command.",
  );
});

test("a busy answer to a read is reported at once, not retried behind the scenes", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one" });
  game.inject.push({
    path: "/connection/",
    status: 503,
    headers: { "Retry-After": "30" },
    error: { code: "busy" },
  });
  const before = game.requests.length;
  const busy = await run(root, ["status"]);
  assert.equal(busy.code, 3);
  assert.equal(busy.error.retry_after_seconds, 30);
  assert.equal(game.requests.length - before, 1);
});

test("a first publish refused as busy created nothing and is safe to run again", async (t) => {
  const game = await fakeRosebud(t);
  const root = await folder(t, { "dist/index.html": "one" });
  game.inject.push({
    path: "/projects/import/",
    status: 503,
    error: { code: "busy" },
  });
  const args = ["publish", "--directory", "dist", "--api-base", game.base];
  const busy = await run(root, args);
  assert.equal(busy.code, 3);
  assert.equal(busy.error.outcome, "rejected");
  assert.equal(busy.error.retry_after_seconds, undefined);
  assert.equal(
    busy.error.next_action,
    "Rosebud is busy. Run the same command again shortly; no game was created, so publishing again is safe.",
  );
  assert.equal(game.releases, 0);
  await assert.rejects(readFile(join(root, ".rosebud/project.json")));
  assert.equal((await run(root, args)).code, 0);
  assert.equal(game.releases, 1);
});

test("an upload session is asked again while Rosebud checks the game's existing files", async (t) => {
  const game = await fakeRosebud(t, { uploadRetries: 3, uploadRetryAfter: 0 });
  const root = await connected(t, game, { "index.html": "one" });
  const sessions = () =>
    game.requests.filter((r) => r.path === "/api/developer/uploads/").length;
  // The publish had no media, so it made no session request.
  assert.equal(sessions(), 0);
  await mkdir(join(root, "dist/assets"));
  await writeFile(join(root, "dist/assets/hero.png"), png);
  const update = await run(root, ["update", "--directory", "dist"]);
  assert.equal(update.code, 0, JSON.stringify(update.error));
  assert.equal(sessions(), 4);
  assert.deepEqual(game.puts, ["assets/hero.png"]);
});

test("after 20 upload_retry answers the CLI stops and says to run it again", async (t) => {
  const game = await fakeRosebud(t, {
    uploadRetries: 100,
    uploadRetryAfter: 0,
  });
  const root = await folder(t, {
    "dist/index.html": "one",
    "dist/assets/hero.png": png,
  });
  const result = await run(root, [
    "publish",
    "--directory",
    "dist",
    "--api-base",
    game.base,
  ]);
  assert.equal(result.code, 3);
  assert.equal(result.error.code, "upload_retry");
  assert.equal(result.error.outcome, "rejected");
  assert.equal(result.error.retry_after_seconds, 0);
  assert.equal(
    result.error.next_action,
    "Run the same command again; Rosebud is still checking this game's existing files.",
  );
  assert.equal(game.uploadRetries, 80);
  assert.equal(game.releases, 0);
});

const sessionAsks = (game) =>
  game.requests.filter((r) => r.path === "/api/developer/uploads/").length;
const fallingFrom = (count) =>
  Array.from({ length: count }, (_, index) => count - index);
async function publishWithMedia(t, game) {
  const root = await folder(t, { "index.html": "x", "assets/hero.png": png });
  return new Rosebud({ apiBaseUrl: game.base }).publish({ directory: root });
}

test("while Rosebud's remaining count falls, the identical request is repeated past 20 attempts", async (t) => {
  const game = await fakeRosebud(t, {
    uploadRetryAfter: 0,
    uploadRemaining: fallingFrom(45),
  });
  await publishWithMedia(t, game);
  assert.equal(sessionAsks(game), 46);
  assert.equal(game.releases, 1);
  // A count that stands still once is not a stall, only twice in a row is.
  const slow = await fakeRosebud(t, {
    uploadRetryAfter: 0,
    uploadRemaining: [5, 5, 4, 4, 3, 3, 2, 2, 1],
  });
  await publishWithMedia(t, slow);
  assert.equal(sessionAsks(slow), 10);
});

test("a remaining count that fails to fall twice in a row ends the retries", async (t) => {
  for (const [remaining, asks] of [
    [[5, 4, 4, 4, 4, 4], 4],
    [[7, 7, 7, 7], 3],
    [[3, 4, 5, 6], 3],
  ]) {
    const game = await fakeRosebud(t, {
      uploadRetryAfter: 0,
      uploadRemaining: remaining,
    });
    await assert.rejects(
      publishWithMedia(t, game),
      (e) => e.code === "upload_retry" && e.outcome === "rejected",
      remaining.join(","),
    );
    assert.equal(sessionAsks(game), asks, remaining.join(","));
    assert.equal(game.releases, 0);
  }
  // The command says what to do, as after any other upload_retry stop.
  const game = await fakeRosebud(t, {
    uploadRetryAfter: 0,
    uploadRemaining: [9, 9, 9, 9],
  });
  const root = await folder(t, {
    "dist/index.html": "one",
    "dist/assets/hero.png": png,
  });
  const result = await run(root, [
    "publish",
    "--directory",
    "dist",
    "--api-base",
    game.base,
  ]);
  assert.equal(result.code, 3);
  assert.equal(result.error.code, "upload_retry");
  assert.equal(
    result.error.next_action,
    "Run the same command again; Rosebud is still checking this game's existing files.",
  );
});

test("without a numeric remaining count, an upload session is asked for at most 20 times", async (t) => {
  for (const uploadRemaining of [
    Array(100).fill("3"),
    Array(100).fill(null),
    Array(100).fill(-1),
    [5, 4, ...Array(100).fill(undefined)],
  ]) {
    const game = await fakeRosebud(t, {
      uploadRetryAfter: 0,
      uploadRemaining,
      uploadRetries: 100,
    });
    await assert.rejects(
      publishWithMedia(t, game),
      (e) => e.code === "upload_retry",
      JSON.stringify(uploadRemaining.slice(0, 3)),
    );
    assert.equal(
      sessionAsks(game),
      20,
      JSON.stringify(uploadRemaining.slice(0, 3)),
    );
  }
});

test("a falling remaining count still stops at 500 attempts", async (t) => {
  const game = await fakeRosebud(t, {
    uploadRetryAfter: 0,
    uploadRemaining: fallingFrom(800),
  });
  await assert.rejects(
    publishWithMedia(t, game),
    (e) => e.code === "upload_retry",
  );
  assert.equal(sessionAsks(game), 500);
});

test("only a 409 upload_retry is asked again", async (t) => {
  const game = await fakeRosebud(t);
  game.inject.push({
    path: "/api/developer/uploads/",
    status: 400,
    error: { code: "upload_retry" },
  });
  const root = await folder(t, { "index.html": "x", "assets/hero.png": png });
  await assert.rejects(
    new Rosebud({ apiBaseUrl: game.base }).publish({ directory: root }),
    (e) => e.code === "upload_retry" && e.status === 400,
  );
  assert.equal(
    game.requests.filter((r) => r.path === "/api/developer/uploads/").length,
    1,
  );
});

test("without a Retry-After, an upload_retry is asked again after one second", async (t) => {
  const game = await fakeRosebud(t, { uploadRetries: 1 });
  const root = await folder(t, { "index.html": "x", "assets/hero.png": png });
  const started = Date.now();
  await new Rosebud({ apiBaseUrl: game.base }).publish({ directory: root });
  assert.ok(Date.now() - started >= 900);
  assert.equal(game.uploadRetries, 0);
});

test("pull --force settles conflicts for Rosebud and restores missing files, but never touches edits made only here", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, {
    "index.html": "one",
    "game.js": "1",
    "old.js": "1",
  });
  await writeFile(join(root, "dist/index.html"), "mine");
  await writeFile(join(root, "dist/game.js"), "edited here");
  await rm(join(root, "dist/old.js"));
  game.edit({ text: { "index.html": "rosie's" } });
  const forced = await run(root, ["pull", "--directory", "dist", "--force"]);
  assert.equal(forced.code, 0, JSON.stringify(forced.error));
  assert.equal(forced.data.status, "synced");
  assert.deepEqual(forced.data.written, ["index.html", "old.js"]);
  assert.deepEqual(forced.data.removed, []);
  assert.deepEqual(forced.data.local_only, []);
  assert.equal(
    await readFile(join(root, "dist/index.html"), "utf8"),
    "rosie's",
  );
  assert.equal(
    await readFile(join(root, "dist/game.js"), "utf8"),
    "edited here",
  );
  assert.equal(await readFile(join(root, "dist/old.js"), "utf8"), "1");
  // The edit made only here still goes up with the next update.
  const update = await run(root, ["update", "--directory", "dist"]);
  assert.equal(update.code, 0, JSON.stringify(update.error));
  assert.equal(game.text.get("game.js"), "edited here");
  assert.equal(game.text.get("old.js"), "1");
});

test("pull --force removes a file Rosebud deleted that was edited here", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one", "b.js": "1" });
  await writeFile(join(root, "dist/b.js"), "mine");
  game.edit({ remove: ["b.js"] });
  const forced = await run(root, ["pull", "--directory", "dist", "--force"]);
  assert.equal(forced.code, 0, JSON.stringify(forced.error));
  assert.deepEqual(forced.data.removed, ["b.js"]);
  await assert.rejects(readFile(join(root, "dist/b.js")));
});

test("next steps are copy-pasteable: they name --state and quote what needs it", async (t) => {
  const game = await fakeRosebud(t);
  const state = ".rosebud/b.json";
  const root = await connected(
    t,
    game,
    { "index.html": "one" },
    { directory: "my game", state },
  );
  game.edit({ text: { "index.html": "two" } });
  const synced = await run(root, [
    "pull",
    "--directory",
    "my game",
    "--state",
    state,
  ]);
  assert.equal(synced.code, 0, JSON.stringify(synced.error));
  assert.match(
    synced.data.next_action,
    /run `rosebud update --directory (['"])my game\1 --state \.rosebud\/b\.json`\./,
  );
  await writeFile(join(root, "my game/index.html"), "mine");
  game.edit({ text: { "index.html": "rosie's" } });
  const conflicted = await run(root, [
    "pull",
    "--directory",
    "my game",
    "--state",
    state,
  ]);
  const action = conflicted.data.next_action;
  assert.match(
    action,
    new RegExp(
      `rosebud update --directory (['"])my game\\1 --state \\.rosebud/b\\.json --expected-version ${conflicted.data.content_version}`,
    ),
  );
  assert.match(
    action,
    /rosebud pull --directory (['"])my game\1 --state \.rosebud\/b\.json --force/,
  );
  // The default state needs no flag.
  const plain = await connected(t, game, { "index.html": "x" });
  const unflagged = await run(plain, ["pull", "--directory", "dist"]);
  assert.match(
    unflagged.data.next_action,
    /run `rosebud update --directory dist`\./,
  );
  assert.doesNotMatch(unflagged.data.next_action, /--state/);
});

test("the folder's own leftovers are not game files: hidden entries and old .part files", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one" });
  await writeFile(join(root, "dist/.DS_Store"), "junk");
  await mkdir(join(root, "dist/.git"));
  await writeFile(join(root, "dist/.git/config"), "junk");
  await writeFile(join(root, `dist/index.html.${randomUUID()}.part`), "half");
  await writeFile(join(root, "dist/mine.js"), "x");
  const pull = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(pull.code, 0, JSON.stringify(pull.error));
  assert.deepEqual(pull.data.local_only, ["mine.js"]);
});

test("OS junk files are not game files: pull ignores them and update does not upload or refuse them", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one" });
  await writeFile(
    join(root, "dist/Thumbs.db"),
    Buffer.from([0xd0, 0xcf, 0x11]),
  );
  await writeFile(join(root, "dist/desktop.ini"), "[.ShellClassInfo]");
  await mkdir(join(root, "dist/levels"));
  await writeFile(join(root, "dist/levels/.DS_Store"), "junk");
  await writeFile(join(root, "dist/levels/THUMBS.DB"), "junk");
  await writeFile(join(root, "dist/levels/one.json"), "{}");
  const pull = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(pull.code, 0, JSON.stringify(pull.error));
  assert.deepEqual(pull.data.local_only, ["levels/one.json"]);
  const update = await run(root, ["update", "--directory", "dist"]);
  assert.equal(update.code, 0, JSON.stringify(update.error));
  assert.deepEqual([...game.text.keys()].sort(), [
    "index.html",
    "levels/one.json",
  ]);
  assert.deepEqual(Object.keys((await handle(root)).files).sort(), [
    "index.html",
    "levels/one.json",
  ]);
});

test("pull treats only a regular file named like OS junk as junk: a folder is walked and a link is refused", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one" });
  await mkdir(join(root, "dist/Thumbs.db"));
  await writeFile(join(root, "dist/Thumbs.db/level.json"), "{}");
  const pull = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(pull.code, 0, JSON.stringify(pull.error));
  assert.deepEqual(pull.data.local_only, ["Thumbs.db/level.json"]);
  if (process.platform === "win32") return; // creating links needs privileges there
  await symlink(join(root, "dist/index.html"), join(root, "dist/desktop.ini"));
  const linked = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(linked.error.code, "unsupported_input");
  assert.match(linked.error.message, /desktop\.ini/);
});

test("a junk-named file that Rosebud holds is written by pull, then ignored, so the next update leaves it out", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one" });
  game.edit({ text: { "Thumbs.db": "rosie made this" } });
  const pull = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(pull.code, 0, JSON.stringify(pull.error));
  assert.deepEqual(pull.data.written, ["Thumbs.db"]);
  assert.equal(
    await readFile(join(root, "dist/Thumbs.db"), "utf8"),
    "rosie made this",
  );
  const again = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(again.data.status, "synced");
  assert.deepEqual(again.data.local_only, []);
  // The folder ignores it rather than missing it, so it is not reported as missing.
  assert.deepEqual(again.data.missing_locally, []);
  const update = await run(root, ["update", "--directory", "dist"]);
  assert.equal(update.code, 0, JSON.stringify(update.error));
  assert.deepEqual([...game.text.keys()], ["index.html"]);
});

test("pull leaves no temporary file in the folder, even while it works", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, {
    "index.html": "one",
    "assets/hero.png": png,
  });
  game.edit({
    text: { "index.html": "two", "more.js": "x" },
    media: { "assets/hero.png": Buffer.concat([png, png]) },
  });
  const seen = new Set();
  const watcher = watch(
    join(root, "dist"),
    { recursive: true },
    (_event, name) => name && seen.add(String(name)),
  );
  try {
    const pull = await run(root, ["pull", "--directory", "dist"]);
    assert.equal(pull.code, 0, JSON.stringify(pull.error));
    // File events arrive a little late; wait for the last file, up to two seconds.
    for (let wait = 0; wait < 40 && !seen.has("more.js"); wait += 1)
      await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    watcher.close();
  }
  assert.ok(seen.has("more.js"), "the watcher saw the writes");
  assert.deepEqual(
    [...seen].filter((name) => name.endsWith(".part")),
    [],
  );
});

test("a file where a folder is needed, or the reverse, is path_conflict and names the path", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, {
    "index.html": "one",
    "a/x.js": "1",
  });
  // Rosebud replaced the folder a/ with a file a, so a/x.js is deleted there.
  game.edit({ remove: ["a/x.js"], text: { a: "now a file" } });
  const before = await handle(root);
  const emptied = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(emptied.code, 2);
  assert.equal(emptied.error.code, "path_conflict");
  assert.match(emptied.error.message, /^a is a folder/);
  // Removals run first, so the old file is gone and a rerun after rmdir finishes.
  await assert.rejects(readFile(join(root, "dist/a/x.js")));
  assert.deepEqual(await handle(root), before);
  await rm(join(root, "dist/a"), { recursive: true });
  const rerun = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(rerun.code, 0, JSON.stringify(rerun.error));
  assert.equal(await readFile(join(root, "dist/a"), "utf8"), "now a file");
  // A folder that still holds a file of ours is a real clash.
  game.edit({ remove: ["a"], text: { "b/c.js": "1" } });
  assert.equal((await run(root, ["pull", "--directory", "dist"])).code, 0);
  game.edit({ remove: ["b/c.js"], text: { b: "file" } });
  await writeFile(join(root, "dist/b/mine.js"), "local only");
  const clash = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(clash.error.code, "path_conflict");
  assert.equal(
    await readFile(join(root, "dist/b/mine.js"), "utf8"),
    "local only",
  );
  // And the other way round: a folder is needed where a file stands.
  game.edit({ remove: ["b"], text: { "index.html/x.js": "x" } });
  const reverse = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(reverse.error.code, "path_conflict");
  assert.match(reverse.error.message, /index\.html/);
});

// macOS and Windows disks treat Foo.js and foo.js as one file; Linux ones don't.
async function caseInsensitiveDisk(t) {
  const probe = await folder(t, { A: "x" });
  return readFile(join(probe, "a")).then(
    () => true,
    () => false,
  );
}

test("removals run before writes, so a name that changes only in case survives", async (t) => {
  if (!(await caseInsensitiveDisk(t)))
    return t.skip("this file system is case-sensitive");
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one", "Foo.js": "1" });
  game.edit({ remove: ["Foo.js"], text: { "foo.js": "2" } });
  const pull = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(pull.code, 0, JSON.stringify(pull.error));
  assert.deepEqual((await readdir(join(root, "dist"))).sort(), [
    "foo.js",
    "index.html",
  ]);
  assert.equal(await readFile(join(root, "dist/foo.js"), "utf8"), "2");
});

test("a case-only rename never overwrites a local file that stays: it is a case_conflict with Rosebud's copy saved aside", async (t) => {
  if (!(await caseInsensitiveDisk(t)))
    return t.skip("this file system is case-sensitive");
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one", "Foo.js": "1" });
  await writeFile(join(root, "dist/Foo.js"), "mine");
  game.edit({ remove: ["Foo.js"], text: { "foo.js": "2" } });
  const before = await handle(root);
  const pull = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(pull.code, 0, JSON.stringify(pull.error));
  assert.equal(pull.data.status, "conflicts");
  assert.deepEqual(pull.data.written, []);
  const copy = join(await realpath(root), ".rosebud/project.remote/foo.js");
  assert.deepEqual(
    pull.data.conflicts.map(({ path, reason, rosebud_copy, clashes_with }) => [
      path,
      reason,
      rosebud_copy && join(rosebud_copy),
      clashes_with,
    ]),
    [["foo.js", "case_conflict", copy, "Foo.js"]],
  );
  // The local edit is untouched, under its own name; Rosebud's copy is beside it.
  assert.deepEqual((await readdir(join(root, "dist"))).sort(), [
    "Foo.js",
    "index.html",
  ]);
  assert.equal(await readFile(join(root, "dist/Foo.js"), "utf8"), "mine");
  assert.equal(await readFile(copy, "utf8"), "2");
  assert.match(pull.data.next_action, /letter case/);
  assert.match(pull.data.next_action, /`foo\.js`/);
  assert.match(pull.data.next_action, /`Foo\.js`/);
  assert.match(pull.data.next_action, /project\.remote/);
  // Nothing moved: the saved version and manifest still describe the last sync.
  const after = await handle(root);
  assert.equal(after.content_version, before.content_version);
  assert.deepEqual(after.files, before.files);
  // Pulling again says the same, and the folder is still untouched.
  const again = await run(root, ["pull", "--directory", "dist"]);
  assert.deepEqual(
    again.data.conflicts.map((c) => [c.path, c.reason]),
    [["foo.js", "case_conflict"]],
  );
  assert.equal(await readFile(join(root, "dist/Foo.js"), "utf8"), "mine");
  // --force takes Rosebud's version: the old name goes first, so the new one can be written.
  const forced = await run(root, ["pull", "--directory", "dist", "--force"]);
  assert.equal(forced.code, 0, JSON.stringify(forced.error));
  assert.equal(forced.data.status, "synced");
  assert.deepEqual((await readdir(join(root, "dist"))).sort(), [
    "foo.js",
    "index.html",
  ]);
  assert.equal(await readFile(join(root, "dist/foo.js"), "utf8"), "2");
});

test("a file Rosebud adds that differs only in case from a file that exists only here is a case_conflict, even with --force", async (t) => {
  if (!(await caseInsensitiveDisk(t)))
    return t.skip("this file system is case-sensitive");
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one" });
  await writeFile(join(root, "dist/README.md"), "mine");
  game.edit({
    text: {
      "readme.md": "rosie's",
      "Assets/Lib/B.js": "b",
      "Levels/two.json": "{}",
    },
    media: { "Hero.PNG": png },
  });
  await mkdir(join(root, "dist/assets/lib"), { recursive: true });
  await writeFile(join(root, "dist/assets/lib/b.js"), "mine too");
  await writeFile(join(root, "dist/hero.png"), "mine three");
  // A folder of the agent's own would take Rosebud's file under the folder's spelling.
  await mkdir(join(root, "dist/levels"));
  await writeFile(join(root, "dist/levels/one.json"), "[]");
  for (const args of [[], ["--force"]]) {
    const pull = await run(root, ["pull", "--directory", "dist", ...args]);
    assert.equal(pull.code, 0, JSON.stringify(pull.error));
    assert.deepEqual(
      pull.data.conflicts.map((c) => [c.path, c.reason, c.clashes_with]),
      [
        ["Assets/Lib/B.js", "case_conflict", "assets/lib/b.js"],
        ["Hero.PNG", "case_conflict", "hero.png"],
        ["Levels/two.json", "case_conflict", "levels"],
        ["readme.md", "case_conflict", "README.md"],
      ],
      args.join(" "),
    );
    // Rosebud's files are the same files on this disk, so none is listed as only here.
    assert.deepEqual(pull.data.local_only, ["levels/one.json"]);
    assert.deepEqual(await readdir(join(root, "dist/levels")), ["one.json"]);
    assert.equal(await readFile(join(root, "dist/README.md"), "utf8"), "mine");
    assert.equal(
      await readFile(join(root, "dist/assets/lib/b.js"), "utf8"),
      "mine too",
    );
    assert.equal(
      await readFile(join(root, "dist/hero.png"), "utf8"),
      "mine three",
    );
    // Rosebud's copies, media included, wait in the .remote folder.
    assert.equal(
      await readFile(join(root, ".rosebud/project.remote/readme.md"), "utf8"),
      "rosie's",
    );
    assert.deepEqual(
      await readFile(join(root, ".rosebud/project.remote/Hero.PNG")),
      png,
    );
  }
});

test("on a case-sensitive disk, names that differ only in case are different files and no conflict is made", async (t) => {
  if (await caseInsensitiveDisk(t))
    return t.skip("this file system is case-insensitive");
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one", "Foo.js": "1" });
  await writeFile(join(root, "dist/Foo.js"), "mine");
  game.edit({ remove: ["Foo.js"], text: { "foo.js": "2" } });
  const pull = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(pull.code, 0, JSON.stringify(pull.error));
  assert.deepEqual(
    pull.data.conflicts.map((c) => [c.path, c.reason]),
    [["Foo.js", "remote_deleted"]],
  );
  assert.deepEqual(pull.data.written, ["foo.js"]);
  assert.equal(await readFile(join(root, "dist/Foo.js"), "utf8"), "mine");
  assert.equal(await readFile(join(root, "dist/foo.js"), "utf8"), "2");
});

test("Rosebud names that this disk would store as one file are all refused, with each copy kept apart", async (t) => {
  if (!(await caseInsensitiveDisk(t)))
    return t.skip("this file system is case-sensitive");
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one" });
  const published = (await handle(root)).content_version;
  game.edit({
    text: {
      "index.html":
        "<script src='Scripts/a.js'></script><script src='scripts/b.js'></script>",
      "Foo.js": "UPPER",
      "foo.js": "lower",
      "Scripts/a.js": "a",
      "scripts/b.js": "b",
    },
  });
  for (const args of [[], ["--force"]]) {
    const pull = await run(root, ["pull", "--directory", "dist", ...args]);
    assert.equal(pull.code, 0, JSON.stringify(pull.error));
    assert.equal(pull.data.status, "conflicts", args.join(" "));
    assert.deepEqual(
      pull.data.conflicts.map((c) => [c.path, c.reason, c.clashes_with]),
      [
        ["Foo.js", "name_collision", "foo.js"],
        ["Scripts/a.js", "name_collision", "scripts/b.js"],
        ["foo.js", "name_collision", "Foo.js"],
        ["scripts/b.js", "name_collision", "Scripts/a.js"],
      ],
    );
    // None of them reached the folder, so no name swallowed another.
    assert.deepEqual(await readdir(join(root, "dist")), ["index.html"]);
    const copies = Object.fromEntries(
      pull.data.conflicts.map((c) => [c.path, c.rosebud_copy]),
    );
    assert.equal(await readFile(copies["Foo.js"], "utf8"), "UPPER");
    assert.equal(await readFile(copies["foo.js"], "utf8"), "lower");
    assert.equal(await readFile(copies["Scripts/a.js"], "utf8"), "a");
    assert.equal(await readFile(copies["scripts/b.js"], "utf8"), "b");
    assert.ok(
      Object.values(copies).every((copy) => copy.includes("project.remote")),
    );
    assert.match(pull.data.next_action, /can't tell apart/);
    assert.match(
      pull.data.next_action,
      /`Foo\.js`, `Scripts\/a\.js`, `foo\.js`, `scripts\/b\.js`/,
    );
    assert.match(pull.data.next_action, /saved version/);
    // The saved version stays, so the next update can't silently drop one of them.
    assert.equal((await handle(root)).content_version, published);
  }
  const update = await run(root, ["update", "--directory", "dist"]);
  assert.equal(update.error.code, "version_conflict");
});

// macOS stores names that differ only in Unicode form (é as one character or two) as one file.
async function formInsensitiveDisk(t) {
  const probe = await folder(t, { "e\u0301": "x" });
  return readFile(join(probe, "\u00e9")).then(
    () => true,
    () => false,
  );
}

test("a local edit to a file Rosebud names in another Unicode form is never overwritten", async (t) => {
  const nfd = "cafe\u0301.js",
    nfc = "caf\u00e9.js";
  const game = await fakeRosebud(t, { nfc: true });
  const root = await connected(t, game, {
    "index.html": "x",
    [nfd]: "published",
  });
  assert.ok(game.text.has(nfc));
  await writeFile(join(root, "dist", nfd), "MY LOCAL EDIT");
  const pull = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(pull.code, 0, JSON.stringify(pull.error));
  assert.equal(
    await readFile(join(root, "dist", nfd), "utf8"),
    "MY LOCAL EDIT",
  );
  // A disk that keeps both forms apart holds two files, and nothing was lost.
  if (!(await formInsensitiveDisk(t))) return;
  // One file here, unchanged in Rosebud since the last sync: the edit is the agent's own.
  assert.equal(pull.data.status, "synced");
  assert.deepEqual(
    [pull.data.written, pull.data.conflicts, pull.data.local_only],
    [[], [], []],
  );
  // Once Rosebud changes it too, it is a conflict, and the edit still stays.
  game.edit({ text: { [nfc]: "rosie's" } });
  const both = await run(root, ["pull", "--directory", "dist"]);
  assert.deepEqual(
    both.data.conflicts.map((c) => [c.path, c.reason]),
    [[nfc, "both_changed"]],
  );
  assert.equal(
    await readFile(join(root, "dist", nfd), "utf8"),
    "MY LOCAL EDIT",
  );
  assert.equal(
    await readFile(both.data.conflicts[0].rosebud_copy, "utf8"),
    "rosie's",
  );
  // --force takes Rosebud's text into the same file, under the name it has here.
  const forced = await run(root, ["pull", "--directory", "dist", "--force"]);
  assert.deepEqual(forced.data.written, [nfc]);
  assert.deepEqual((await readdir(join(root, "dist"))).sort(), [
    nfd,
    "index.html",
  ]);
  assert.equal(await readFile(join(root, "dist", nfd), "utf8"), "rosie's");
});

test("conflict advice fits the conflicts, and skipped files are mentioned there too", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, {
    "index.html": "one",
    "gone.js": "1",
    "edited.js": "1",
  });
  // Only a file Rosebud deleted: no copy exists, so none is named.
  await writeFile(join(root, "dist/gone.js"), "mine");
  game.edit({ remove: ["gone.js"], text: { "../skipped.js": "x" } });
  const deleted = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(deleted.data.status, "conflicts");
  assert.match(deleted.data.next_action, /has no copy/);
  assert.doesNotMatch(
    deleted.data.next_action,
    /project\.remote|copies are in/,
  );
  assert.doesNotMatch(deleted.data.next_action, /Merge each/);
  assert.match(deleted.data.next_action, /skipped/);
  // A file deleted here and changed in Rosebud has a copy and its own advice.
  await rm(join(root, "dist/edited.js"));
  game.edit({ text: { "edited.js": "2" } });
  const local = await run(root, ["pull", "--directory", "dist"]);
  assert.match(local.data.next_action, /project\.remote/);
  assert.match(
    local.data.next_action,
    /restore it from Rosebud's copy or leave it deleted/,
  );
});

test("a path Rosebud lists twice is reported as duplicate_path, without the removal warning", async (t) => {
  const game = await fakeRosebud(t);
  const root = await connected(t, game, { "index.html": "one" });
  game.edit({ text: { "twice.js": "text" }, media: { "twice.js": png } });
  const pull = await run(root, ["pull", "--directory", "dist"]);
  assert.equal(pull.code, 0, JSON.stringify(pull.error));
  assert.deepEqual(pull.data.skipped, [
    { path: "twice.js", reason: "duplicate_path" },
  ]);
  assert.equal(await readFile(join(root, "dist/twice.js"), "utf8"), "text");
  assert.doesNotMatch(pull.data.next_action, /removes them from the game/);
  assert.match(pull.data.next_action, /twice/);
});

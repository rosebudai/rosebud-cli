import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  stat,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const token = `rbk_${"T".repeat(43)}`;
const approval = `https://example.invalid/connect/assets#${"S".repeat(43)}`;
const sprite = Buffer.from("sprite zip bytes");
const projectId = randomUUID();
const agentToken = "A".repeat(43);
const model = {
  id: "flux-2-flash",
  name: "Flux 2 Flash",
  category: "image",
  inputs: [
    { name: "prompt", type: "string", required: true, description: "" },
    {
      name: "asset_type",
      type: "enum",
      required: false,
      description: "",
      values: ["any", "sprite"],
    },
    { name: "seed", type: "integer", required: false, description: "" },
  ],
};
function json(res, body, status = 200) {
  res
    .writeHead(status, { "Content-Type": "application/json" })
    .end(JSON.stringify(body));
}

/**
 * A fake Rosebud asset API; `api.loseJobResponse` drops one job admission reply and
 * each `api.throttle` entry refuses one quote with that Retry-After. Publishing
 * with an active login answers with the account's game.
 */
async function rosebud(t) {
  const api = {
    login: "none",
    logins: [],
    quotes: [],
    jobPosts: [],
    jobs: new Map(),
    downloads: [],
    loseJobResponse: false,
    throttle: [],
    publishes: [],
    statusChecks: [],
  };
  const job = (id) => {
    const row = api.jobs.get(id);
    const done = row.polls > 0;
    return {
      id,
      status: done ? "succeeded" : "queued",
      model: model.id,
      input: row.input,
      idempotency_key: row.key,
      credits: row.credits,
      asset: done
        ? {
            id: row.asset,
            name: "Moss tile",
            file_name: "moss.zip",
            format: "zip",
            url: `/api/v1/assets/${row.asset}/files/animation.zip/`,
          }
        : null,
      error: null,
    };
  };
  const app = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const path = new URL(req.url, "http://fake").pathname;
    if (path === "/api/developer/projects/import/") {
      api.publishes.push(req.headers.authorization);
      if (api.login === "pending") {
        const error = { code: "login_pending", message: "Approve first." };
        json(res, { error }, 403);
        return;
      }
      json(
        res,
        {
          project_id: projectId,
          play_url: "https://example.invalid/p/moss-garden",
          editor_url: `https://example.invalid/edit/${projectId}`,
          content_version: "v1",
          claimed: true,
          owner: "Mei",
          agent_token: agentToken,
          connection_expires_at: "2031-01-01T00:00:00Z",
        },
        201,
      );
      return;
    }
    if (path === `/api/developer/projects/${projectId}/connection/`) {
      api.statusChecks.push(req.headers.authorization);
      json(res, {
        project_id: projectId,
        connection_id: randomUUID(),
        status: "active",
        expires_at: "2031-01-01T00:00:00Z",
        content_version: "v1",
        play_url: "https://example.invalid/p/moss-garden",
      });
      return;
    }
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    if (path === "/api/v1/agent-logins/") {
      api.logins.push(body);
      api.login = "pending";
      json(
        res,
        {
          login_id: randomUUID(),
          token,
          approval_url: approval,
          status: "pending",
          expires_at: "2030-01-01T00:30:00Z",
        },
        201,
      );
      return;
    }
    if (path === "/api/v1/asset-models/flux-2-flash/") {
      json(res, model);
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      json(res, { detail: "Invalid token.", code: "invalid_token" }, 401);
      return;
    }
    if (path === "/api/v1/agent-logins/current/") {
      if (req.method === "DELETE") {
        api.login = "revoked";
        res.writeHead(204).end();
        return;
      }
      const active = api.login === "active";
      json(res, {
        login_id: randomUUID(),
        status: api.login,
        client: "codex",
        name: "Moon Garden agent",
        expires_at: active ? null : "2030-01-01T00:30:00Z",
        account: active ? { display_name: "Mei", balance: 5000 } : null,
      });
      return;
    }
    if (api.login !== "active") {
      json(res, { detail: "Invalid key.", code: "invalid_key" }, 401);
      return;
    }
    if (path === "/api/v1/asset-quotes/" && api.throttle.length) {
      const seconds = api.throttle.shift();
      res
        .writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": String(seconds),
        })
        .end(
          JSON.stringify({
            detail: `Request was throttled. Expected available in ${seconds} seconds.`,
            code: "throttled",
          }),
        );
      return;
    }
    if (path === "/api/v1/asset-quotes/") {
      api.quotes.push(body);
      json(
        res,
        {
          id: randomUUID(),
          model: body.model,
          input: body.input,
          credits: body.input.asset_type === "sprite" ? 300 : 250,
          balance: 5000,
          payment_required: false,
          expires_at: "2030-01-01T00:10:00Z",
        },
        201,
      );
      return;
    }
    if (path === "/api/v1/asset-jobs/") {
      api.jobPosts.push(body);
      const existing = [...api.jobs].find(
        ([, row]) => row.key === body.idempotency_key,
      );
      if (existing) {
        json(res, job(existing[0]));
        return;
      }
      const id = randomUUID();
      const quote = api.quotes.at(-1);
      api.jobs.set(id, {
        key: body.idempotency_key,
        input: quote.input,
        credits: quote.input.asset_type === "sprite" ? 300 : 250,
        polls: 0,
        asset: randomUUID(),
      });
      if (api.loseJobResponse) {
        api.loseJobResponse = false;
        req.socket.destroy();
        return;
      }
      json(res, job(id), 202);
      return;
    }
    const polled = path.match(/^\/api\/v1\/asset-jobs\/([^/]+)\/$/);
    if (polled) {
      api.jobs.get(polled[1]).polls++;
      json(res, job(polled[1]));
      return;
    }
    if (path.endsWith("/files/animation.zip/")) {
      api.downloads.push(path);
      res.writeHead(200, { "Content-Type": "application/zip" }).end(sprite);
      return;
    }
    json(res, { detail: "Not found.", code: "not_found" }, 404);
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  t.after(async () => {
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
  });
  api.origin = `http://127.0.0.1:${app.address().port}`;
  return api;
}

async function workspace(t) {
  // The real path, because the CLI resolves --out from its working directory.
  const root = await realpath(await mkdtemp(join(tmpdir(), "rosebud-assets-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function cli(root, api, args) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), ...args],
    {
      cwd: root,
      env: {
        ...process.env,
        ROSEBUD_API_BASE: api.origin,
        ROSEBUD_CREDENTIALS_DIR: join(root, "credentials"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => {
    stdout += b;
  });
  child.stderr.on("data", (b) => {
    stderr += b;
  });
  const [code] = await once(child, "close");
  return {
    code,
    stdout,
    stderr,
    data: stdout ? JSON.parse(stdout) : undefined,
    error: stderr ? JSON.parse(stderr).error : undefined,
  };
}
async function loggedIn(t) {
  const root = await workspace(t);
  const api = await rosebud(t);
  assert.equal((await cli(root, api, ["login"])).code, 0);
  api.login = "active";
  return { root, api };
}

test("login waits for the person's approval, whoami reports it and logout forgets it", async (t) => {
  const root = await workspace(t);
  const api = await rosebud(t);
  const login = await cli(root, api, [
    "login",
    "--agent-client",
    "codex",
    "--name",
    "Moon Garden agent",
  ]);
  assert.equal(login.code, 0, login.stderr);
  assert.equal(login.data.status, "pending");
  assert.equal(login.data.approval_url, approval);
  assert.ok(!login.stdout.includes(token));
  assert.deepEqual(api.logins, [
    { client: "codex", name: "Moon Garden agent" },
  ]);
  const [saved] = await readdir(join(root, "credentials"));
  assert.ok(
    (await readFile(join(root, "credentials", saved), "utf8")).includes(token),
  );
  if (process.platform !== "win32")
    assert.equal(
      (await stat(join(root, "credentials", saved))).mode & 0o777,
      0o600,
    );
  const pending = await cli(root, api, ["whoami"]);
  assert.equal(pending.data.status, "pending");
  assert.equal(pending.data.approval_url, approval);

  api.login = "active";
  const active = await cli(root, api, ["whoami"]);
  assert.equal(active.code, 0, active.stderr);
  assert.equal(active.data.status, "active");
  assert.equal(active.data.account.balance, 5000);
  assert.equal(active.data.approval_url, undefined);
  // Logging in again reports the active login instead of replacing it.
  const again = await cli(root, api, ["login"]);
  assert.equal(again.data.status, "active");
  assert.match(again.data.next_action, /logout/);
  assert.equal(api.logins.length, 1);

  const logout = await cli(root, api, ["logout"]);
  assert.equal(logout.code, 0, logout.stderr);
  assert.equal(api.login, "revoked");
  assert.deepEqual(await readdir(join(root, "credentials")), []);
  const after = await cli(root, api, ["whoami"]);
  assert.equal(after.code, 2);
  assert.equal(after.error.code, "login_required");
});

test("assets quote and create map inputs, respect --max-credits and save the finished file", async (t) => {
  const { root, api } = await loggedIn(t);
  const request = [
    "--model",
    "flux-2-flash",
    "--prompt",
    "Mossy stone tile",
    "--input",
    "asset_type=sprite",
    "--input",
    "seed=7",
  ];
  const quote = await cli(root, api, ["assets", "quote", ...request]);
  assert.equal(quote.code, 0, quote.stderr);
  assert.equal(quote.data.credits, 300);
  assert.deepEqual(api.quotes, [
    {
      model: "flux-2-flash",
      input: { asset_type: "sprite", seed: 7, prompt: "Mossy stone tile" },
    },
  ]);
  const unknown = await cli(root, api, [
    "assets",
    "quote",
    ...request,
    "--input",
    "colour=red",
  ]);
  assert.equal(unknown.code, 2);
  assert.equal(unknown.error.code, "unknown_input");
  assert.equal(api.quotes.length, 1);

  const over = await cli(root, api, [
    "assets",
    "create",
    ...request,
    "--max-credits",
    "250",
  ]);
  assert.equal(over.code, 2);
  assert.equal(over.error.code, "max_credits");
  assert.equal(api.jobPosts.length, 0);

  const created = await cli(root, api, [
    "assets",
    "create",
    ...request,
    "--max-credits",
    "300",
    "--out",
    "art/moss.zip",
  ]);
  assert.equal(created.code, 0, created.stderr);
  assert.equal(created.data.status, "succeeded");
  assert.equal(created.data.file, join(root, "art/moss.zip"));
  assert.deepEqual(await readFile(join(root, "art/moss.zip")), sprite);
  assert.equal(api.jobPosts.length, 1);
  assert.equal(api.downloads.length, 1);
  // The finished request is forgotten; only the login stays.
  assert.equal((await readdir(join(root, "credentials"))).length, 1);

  const exists = await cli(root, api, [
    "assets",
    "create",
    ...request,
    "--out",
    "art/moss.zip",
  ]);
  assert.equal(exists.code, 2);
  assert.equal(exists.error.code, "file_exists");
  assert.equal(api.quotes.length, 3);
});

test("rerunning a create after a lost response resumes the same job without paying twice", async (t) => {
  const { root, api } = await loggedIn(t);
  const request = [
    "assets",
    "create",
    "--model",
    "flux-2-flash",
    "--prompt",
    "Mossy stone tile",
  ];
  api.loseJobResponse = true;
  const lost = await cli(root, api, request);
  assert.equal(lost.code, 4, lost.stderr);
  assert.equal(lost.error.outcome, "unknown");
  assert.equal(api.jobs.size, 1);

  const recovered = await cli(root, api, request);
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(recovered.data.status, "succeeded");
  assert.equal(recovered.data.resumed, true);
  assert.equal(api.quotes.length, 1);
  assert.equal(api.jobs.size, 1);
  assert.equal(api.jobPosts.length, 2);
  assert.deepEqual(api.jobPosts[1], api.jobPosts[0]);

  // Once a create has finished, the same command makes a new asset.
  const next = await cli(root, api, [...request, "--no-wait"]);
  assert.equal(next.code, 0, next.stderr);
  assert.notEqual(next.data.id, recovered.data.id);
  assert.equal(api.jobs.size, 2);
  assert.notEqual(
    api.jobPosts[2].idempotency_key,
    api.jobPosts[0].idempotency_key,
  );
});

test("throttled requests wait out Retry-After, and a long wait is reported", async (t) => {
  const { root, api } = await loggedIn(t);
  const request = ["--model", "flux-2-flash", "--prompt", "Mossy stone tile"];
  api.throttle = [0];
  const quote = await cli(root, api, ["assets", "quote", ...request]);
  assert.equal(quote.code, 0, quote.stderr);
  assert.equal(quote.data.credits, 250);
  assert.equal(api.throttle.length, 0);

  api.throttle = [120];
  const refused = await cli(root, api, ["assets", "quote", ...request]);
  assert.equal(refused.code, 3);
  assert.equal(refused.error.code, "throttled");
  assert.equal(refused.error.retry_after_seconds, 120);
  assert.equal(api.quotes.length, 1);
});

async function game(root) {
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist", "index.html"), "<h1>Moss garden</h1>");
}

test("a logged-in publish lands in the person's account, ready for update", async (t) => {
  const { root, api } = await loggedIn(t);
  await game(root);
  const published = await cli(root, api, ["publish", "--directory", "dist"]);
  assert.equal(published.code, 0, published.stderr);
  assert.deepEqual(api.publishes, [`Bearer ${token}`]);
  assert.equal(published.data.claimed, true);
  assert.equal(published.data.owner, "Mei");
  assert.match(published.data.next_action, /nothing to claim/);
  assert.ok(!("claim_url" in published.data));
  assert.ok(!published.stdout.includes(agentToken));
  const handle = JSON.parse(
    await readFile(join(root, ".rosebud", "project.json"), "utf8"),
  );
  assert.equal(handle.project_id, projectId);
  assert.ok(!("claim_expires_at" in handle));
  // The saved connection works at once, with no rosebud connect.
  const status = await cli(root, api, ["status"]);
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.data.status, "active");
  assert.deepEqual(api.statusChecks, [`Bearer ${agentToken}`]);
});

test("a publish with a login still waiting for approval saves nothing", async (t) => {
  const root = await workspace(t);
  const api = await rosebud(t);
  assert.equal((await cli(root, api, ["login"])).code, 0);
  await game(root);
  const refused = await cli(root, api, ["publish", "--directory", "dist"]);
  assert.equal(refused.code, 3);
  assert.equal(refused.error.code, "login_pending");
  await assert.rejects(stat(join(root, ".rosebud", "project.json")));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
export function fixture(t, profile = "legacy") {
  const stage=profile==="stage", production=profile==="production";
  const workerFile=stage?"stage-autodeploy.sh":production?"release-production.sh":"autodeploy.sh";
  const script=fs.readFileSync(new URL("./deploy/"+workerFile,import.meta.url),"utf8");
  const branch=stage?"dev":production?"production":"feature/management-workspace";
  const suffix=stage?"-stage":"";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bpm-deploy-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, "remote.git"),
    publisher = path.join(root, "publisher"),
    repo = path.join(root, "checkout"),
    store = path.join(root, "store"),
    bin = path.join(root, "bin");
  for (const d of [store, bin]) fs.mkdirSync(d, { recursive: true });
  function run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.stdout.trim();
  }
  function git(args, cwd = publisher) {
    return run("git", args, { cwd });
  }
  run("git", ["init", "--bare", remote]);
  run("git", ["clone", remote, publisher]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.test"]);
  git(["checkout", "-b", branch]);
  fs.mkdirSync(path.join(publisher, "management/public"), { recursive: true });
  fs.mkdirSync(path.join(publisher, "management/deploy"), { recursive: true });
  fs.writeFileSync(
    path.join(publisher, "management/server.mjs"),
    "// version one\n",
  );
  fs.writeFileSync(
    path.join(publisher, "management/public/app.js"),
    "// frontend\n",
  );
  fs.writeFileSync(
    path.join(publisher, "management/smoke.test.mjs"),
    "import {test} from 'node:test';test('candidate smoke',()=>{});\n",
  );
  fs.writeFileSync(
    path.join(publisher, "management/deploy/"+workerFile),
    script,
  );
  git(["add", "."]);
  git(["commit", "-m", "baseline"]);
  git(["push", "-u", "origin", branch]);
  const old = git(["rev-parse", "HEAD"]);
  run("git", [
    "clone",
    "--branch",
    branch,
    remote,
    repo,
  ]);
  const db = new DatabaseSync(path.join(store, "management.db"));
  db.exec("CREATE TABLE marker(v TEXT);INSERT INTO marker VALUES('original');");
  db.close();
  fs.mkdirSync(path.join(store, "deploy-state"), { recursive: true });
  fs.writeFileSync(path.join(store, "deploy-state/deployed"), old + "\n");
  const write = (name, content) =>
    fs.writeFileSync(path.join(bin, name), content, { mode: 0o755 });
  write("runuser", '#!/usr/bin/env bash\nshift 2\nshift\nexec "$@"\n');
  write("id", "#!/usr/bin/env bash\necho 0\n");
  write("chown", "#!/usr/bin/env bash\nexit 0\n");
  write(
    "systemctl",
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${root}/service.log'\nif [[ "$1" == start && -f '${root}/migrate' && ! -f '${root}/migrated' ]]; then\n  touch '${root}/migrated'\n  python3 -c "import sqlite3;c=sqlite3.connect('${store}/management.db');c.execute(\\\"UPDATE marker SET v='migrated'\\\");c.commit()"\nfi\n`,
  );
  write(
    "curl",
    `#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> '${root}/curl.log'\nif [[ -f '${root}/fail-health' ]]; then exit 22; fi\nprintf '%s' '{"ok":true,"service":"business-pulse-management"}'\n`,
  );
  const worker = path.join(root, "worker.sh");
  let patched = script
    .replace(
      "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      `export PATH=${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    )
    .replace("REPO=/opt/business-pulse-management"+suffix, "REPO=" + repo)
    .replace("STORE=/var/lib/business-pulse-management"+suffix, "STORE=" + store)
    .replace(
      "REMOTE=https://github.com/Balakhmatov/business-pulse.git",
      "REMOTE=" + remote,
    )
    .replace(
      "NODE=/usr/local/bin/node-business-pulse",
      "NODE=" + process.execPath,
    )
    .replace(
      production?"WORKER=/usr/local/sbin/business-pulse-management-release":"WORKER=/usr/local/sbin/business-pulse-management"+suffix+"-deploy",
      "WORKER=" + path.join(root, "installed-worker"),
    )
    .replace(
      "LOCK=/run/lock/business-pulse-management"+suffix+"-deploy.lock",
      "LOCK=" + path.join(root, "lock"),
    )
    .replace(
      stage?"/opt/bp-management-stage-check.XXXXXXXX":"/opt/bp-management-check.XXXXXXXX",
      path.join(root, "candidate.XXXXXXXX"),
    );
  fs.writeFileSync(worker, patched, { mode: 0o755 });
  return {
    root,
    repo,
    store,
    bin,
    old,
    git,
    deploy: (opts = {}) => {
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      return spawnSync("bash", [worker], {
        encoding: "utf8",
        timeout: 20000,
        cwd: opts.cwd,
        env,
      });
    },
    update({ bad = false } = {}) {
      fs.writeFileSync(
        path.join(publisher, "management/server.mjs"),
        "// version " + Math.random() + "\n",
      );
      if (bad)
        fs.writeFileSync(
          path.join(publisher, "management/smoke.test.mjs"),
          "throw Error('test rejection');\n",
        );
      git(["add", "."]);
      git(["commit", "-m", "candidate"]);
      git(["push"]);
      return git(["rev-parse", "HEAD"]);
    },
  };
}
test("autodeploy promotes a checked commit and stores a consistent database backup", (t) => {
  const f = fixture(t),
    next = f.update();
  const r = f.deploy();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(f.git(["rev-parse", "HEAD"], f.repo), next);
  assert.equal(
    fs.readFileSync(path.join(f.store, "deploy-state/deployed"), "utf8").trim(),
    next,
  );
  const backups = fs.readdirSync(path.join(f.store, "deploy-state/backups"));
  assert.equal(backups.length, 1);
  const copy = new DatabaseSync(
    path.join(f.store, "deploy-state/backups", backups[0], "management.db"),
  );
  assert.equal(copy.prepare("SELECT v FROM marker").get().v, "original");
  copy.close();
  const again = f.deploy();
  assert.equal(again.status, 0);
  assert.equal(
    fs.readdirSync(path.join(f.store, "deploy-state/backups")).length,
    1,
  );
});
test("failed candidate tests keep the running checkout untouched and are not retried", (t) => {
  const f = fixture(t),
    next = f.update({ bad: true }),
    r = f.deploy();
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.equal(f.git(["rev-parse", "HEAD"], f.repo), f.old);
  assert.equal(fs.existsSync(path.join(f.root, "service.log")), false);
  assert.equal(
    fs.readFileSync(path.join(f.store, "deploy-state/failed"), "utf8").trim(),
    next,
  );
  assert.equal(f.deploy().status, 0);
});
test("failed health restores both the old code and pre-migration database", (t) => {
  const f = fixture(t);
  f.update();
  fs.writeFileSync(path.join(f.root, "fail-health"), "");
  fs.writeFileSync(path.join(f.root, "migrate"), "");
  const r = f.deploy();
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.equal(f.git(["rev-parse", "HEAD"], f.repo), f.old);
  assert.equal(
    fs.existsSync(path.join(f.root, "migrated")),
    true,
    "migration simulation must run",
  );
  const db = new DatabaseSync(path.join(f.store, "management.db"));
  assert.equal(db.prepare("SELECT v FROM marker").get().v, "original");
  db.close();
  assert.equal(
    fs.readFileSync(path.join(f.store, "deploy-state/deployed"), "utf8").trim(),
    f.old,
  );
});
test("local tracked edits prevent automatic overwrites", (t) => {
  const f = fixture(t);
  f.update();
  fs.appendFileSync(
    path.join(f.repo, "management/server.mjs"),
    "// local edit\n",
  );
  const r = f.deploy();
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /local changes/);
  assert.match(
    fs.readFileSync(path.join(f.repo, "management/server.mjs"), "utf8"),
    /local edit/,
  );
  assert.equal(fs.existsSync(path.join(f.root, "service.log")), false);
});

test('dev stage autodeploy promotes only the stage service and URLs',t=>{
  const f=fixture(t,'stage'),next=f.update(),r=f.deploy();
  assert.equal(r.status,0,r.stdout+r.stderr);
  assert.equal(f.git(['rev-parse','HEAD'],f.repo),next);
  const log=fs.readFileSync(path.join(f.root,'service.log'),'utf8');
  assert.match(log,/business-pulse-management-stage.service/);
  assert.equal(/business-pulse-management\.service/.test(log),false);
  const requests=fs.readFileSync(path.join(f.root,'curl.log'),'utf8');
  assert.match(requests,/127\.0\.0\.1:3129/);assert.match(requests,/stage.cityai.site/);
  assert.equal(requests.includes('127.0.0.1:3128'),false);
});
test('failed stage health rolls back stage code and database',t=>{
  const f=fixture(t,'stage');f.update();
  fs.writeFileSync(path.join(f.root,'fail-health'),'');fs.writeFileSync(path.join(f.root,'migrate'),'');
  const r=f.deploy();assert.notEqual(r.status,0);
  assert.equal(f.git(['rev-parse','HEAD'],f.repo),f.old);
  const db=new DatabaseSync(path.join(f.store,'management.db'));
  assert.equal(db.prepare('SELECT v FROM marker').get().v,'original');db.close();
  assert.equal(fs.readFileSync(path.join(f.root,'service.log'),'utf8').includes('business-pulse-management.service'),false);
});
test('stage worker refuses a production checkout before any service change',t=>{
  const f=fixture(t,'stage');f.update();f.git(['switch','-c','production'],f.repo);
  const r=f.deploy();assert.notEqual(r.status,0);assert.match(r.stdout,/Unexpected checkout branch/);
  assert.equal(fs.existsSync(path.join(f.root,'service.log')),false);
});
test('manual production runner requires production branch and releases only its reviewed tip',t=>{
  const f=fixture(t,'production'),next=f.update(),r=f.deploy();
  assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(f.git(['rev-parse','HEAD'],f.repo),next);
  assert.match(fs.readFileSync(path.join(f.root,'service.log'),'utf8'),/business-pulse-management.service/);
});

function freezeFixture(t) {
  const f=fixture(t);
  f.git(['push','origin','HEAD:production']);
  const worker=path.join(f.root,'freeze.sh');
  let source=fs.readFileSync(new URL('./deploy/freeze-production.sh',import.meta.url),'utf8')
    .replace('REPO=/opt/business-pulse-management','REPO='+f.repo)
    .replace('REMOTE=https://github.com/Balakhmatov/business-pulse.git','REMOTE='+path.join(f.root,'remote.git'))
    .replace('/var/lib/business-pulse-management/deploy-state/deployed',path.join(f.store,'deploy-state/deployed'))
    .replace('/run/lock/business-pulse-management-deploy.lock',path.join(f.root,'lock'));
  fs.writeFileSync(worker,source);fs.writeFileSync(path.join(f.root,'stable-revision'),f.old+'\n');
  return {...f,freeze:()=>spawnSync('bash',[worker],{encoding:'utf8',timeout:10000,env:{...process.env,PATH:f.bin+':'+process.env.PATH}})};
}
test('freezing switches only branch metadata and disables the old timer without restarting the app',t=>{
  const f=freezeFixture(t),before=fs.readFileSync(path.join(f.store,'management.db'));
  const r=f.freeze();assert.equal(r.status,0,r.stdout+r.stderr);
  assert.equal(f.git(['branch','--show-current'],f.repo),'production');
  assert.equal(f.git(['rev-parse','HEAD'],f.repo),f.old);
  assert.deepEqual(fs.readFileSync(path.join(f.store,'management.db')),before);
  const log=fs.readFileSync(path.join(f.root,'service.log'),'utf8');
  assert.match(log,/disable --now business-pulse-management-deploy.timer/);
  assert.equal(/(?:start|stop|restart) business-pulse-management.service/.test(log),false);
  const again=f.freeze();assert.equal(again.status,0,again.stdout+again.stderr);
});
test('freeze rejects an unreviewed running revision without changing app code or database',t=>{
  const f=freezeFixture(t);fs.writeFileSync(path.join(f.root,'stable-revision'),'0'.repeat(40)+'\n');
  const r=f.freeze();assert.notEqual(r.status,0);assert.match(r.stdout,/differs from reviewed revision/);
  assert.equal(f.git(['branch','--show-current'],f.repo),'feature/management-workspace');
  assert.equal(f.git(['rev-parse','HEAD'],f.repo),f.old);
  assert.equal(/(?:start|stop|restart) business-pulse-management.service/.test(fs.readFileSync(path.join(f.root,'service.log'),'utf8')),false);
});

test('stage and manual release validate from an accessible candidate directory, not the root caller cwd',t=>{
  for(const profile of ['stage','production']) {
    const f=fixture(t,profile),privateDir=path.join(f.root,'root-only');fs.mkdirSync(privateDir,{mode:0o700});
    // Model runuser's inherited private cwd without needing root/setgroups in CI.
    fs.writeFileSync(path.join(f.bin,'runuser'),`#!/usr/bin/env bash\nif [[ "$PWD" == '${privateDir}' ]]; then echo 'EACCES: private inherited cwd' >&2; exit 13; fi\nshift 3\nexec "$@"\n`,{mode:0o755});
    const next=f.update(),r=f.deploy({cwd:privateDir});
    assert.equal(r.status,0,r.stdout+r.stderr);assert.equal(f.git(['rev-parse','HEAD'],f.repo),next);
  }
});

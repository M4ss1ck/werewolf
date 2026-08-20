import { afterEach, describe, expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryRepositories: string[] = [];

function git(repository: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd: repository });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString().trim();
}

afterEach(async () => {
  await Promise.all(
    temporaryRepositories
      .splice(0)
      .map((repository) => rm(repository, { force: true, recursive: true })),
  );
});

describe("release script", () => {
  test("commits every file changed by the version bump", async () => {
    const repository = await mkdtemp(join(tmpdir(), "werewolf-release-test-"));
    temporaryRepositories.push(repository);

    await Promise.all([
      mkdir(join(repository, "scripts"), { recursive: true }),
      mkdir(join(repository, "apps/client/src-tauri"), { recursive: true }),
      mkdir(join(repository, "apps/server"), { recursive: true }),
      mkdir(join(repository, "packages/protocol"), { recursive: true }),
    ]);

    const projectRoot = join(import.meta.dir, "..");
    await Promise.all([
      cp(join(projectRoot, "scripts/release.sh"), join(repository, "scripts/release.sh")),
      cp(join(projectRoot, "scripts/bump-version.sh"), join(repository, "scripts/bump-version.sh")),
      writeFile(join(repository, "package.json"), '{"name":"fixture","version": "0.1.0"}\n'),
      writeFile(
        join(repository, "apps/client/package.json"),
        '{"name":"client","version": "0.1.0"}\n',
      ),
      writeFile(
        join(repository, "apps/server/package.json"),
        '{"name":"server","version": "0.1.0"}\n',
      ),
      writeFile(
        join(repository, "packages/protocol/package.json"),
        '{"name":"protocol","version": "0.1.0"}\n',
      ),
      writeFile(
        join(repository, "apps/client/src-tauri/tauri.conf.json"),
        '{"version": "0.1.0"}\n',
      ),
      writeFile(
        join(repository, "apps/client/src-tauri/Cargo.toml"),
        '[package]\nname = "app"\nversion = "0.1.0"\n',
      ),
      writeFile(
        join(repository, "apps/client/src-tauri/Cargo.lock"),
        '[[package]]\nname = "app"\nversion = "0.1.0"\n',
      ),
    ]);
    await Promise.all([
      chmod(join(repository, "scripts/release.sh"), 0o755),
      chmod(join(repository, "scripts/bump-version.sh"), 0o755),
    ]);

    git(repository, "init", "--initial-branch=main");
    git(repository, "config", "user.email", "release-test@example.com");
    git(repository, "config", "user.name", "Release Test");
    git(repository, "add", ".");
    git(repository, "commit", "-m", "initial");

    const release = Bun.spawnSync(["bash", "scripts/release.sh", "0.1.1"], {
      cwd: repository,
      env: { ...process.env, BOT_AI_API_KEY: "", CHANGELOG_AI_MODEL: "" },
    });
    expect(release.exitCode, release.stderr.toString()).toBe(0);
    expect(git(repository, "status", "--porcelain")).toBe("");

    for (const manifest of [
      "apps/client/package.json",
      "apps/server/package.json",
      "packages/protocol/package.json",
    ]) {
      expect(await readFile(join(repository, manifest), "utf8")).toContain('"version": "0.1.1"');
      expect(git(repository, "show", `HEAD:${manifest}`)).toContain('"version": "0.1.1"');
    }
  });
});

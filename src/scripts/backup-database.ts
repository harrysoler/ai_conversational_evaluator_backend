const databaseUrl = Deno.env.get("DATABASE_URL");
if (!databaseUrl) throw new Error("DATABASE_URL no está configurada");

const url = new URL(databaseUrl);
if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
  throw new Error("DATABASE_URL debe usar PostgreSQL");
}

Deno.umask(0o077);
const backupDirectory = new URL("../../../docs-privados/backups/", import.meta.url);
await Deno.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
await Deno.chmod(backupDirectory, 0o700);

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const output = new URL(`virtualchallenge-${timestamp}.dump`, backupDirectory);
const command = new Deno.Command("pg_dump", {
  args: [
    "--format=custom",
    "--no-owner",
    "--no-acl",
    `--host=${url.hostname}`,
    `--port=${url.port || "5432"}`,
    `--username=${decodeURIComponent(url.username)}`,
    `--dbname=${decodeURIComponent(url.pathname.slice(1))}`,
    `--file=${output.pathname}`,
  ],
  env: { PGPASSWORD: decodeURIComponent(url.password) },
  stdout: "inherit",
  stderr: "inherit",
});

try {
  const { code } = await command.output();
  if (code !== 0) throw new Error(`pg_dump terminó con código ${code}`);
  await Deno.chmod(output, 0o600);
  console.log(`Respaldo creado: ${output.pathname}`);
} catch (error) {
  await Deno.remove(output).catch(() => {});
  throw error;
}

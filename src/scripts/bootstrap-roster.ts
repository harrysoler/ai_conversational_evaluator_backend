const rosterFiles = [
  "DOCENTES SEGUIMIENTO A SYLLABUS.xlsx",
  "DECANOS SEGUIMIENTO A SYLLABUS.xlsx",
  "ESTUDIANTES SEGUIMIENTO SYLLABUS.xlsx",
];

const privateDirectory = new URL("../../../docs-privados/", import.meta.url);
const dryRun = Deno.args.length === 1 && Deno.args[0] === "--dry-run";

if (Deno.args.length > 0 && !dryRun) {
  throw new Error("Uso: deno task bootstrap:roster [--dry-run]");
}

const paths = await Promise.all(rosterFiles.map(async (file) => {
  const path = new URL(file, privateDirectory);
  await Deno.stat(path);
  return decodeURIComponent(path.pathname);
}));

async function runTask(task: string, args: string[] = []) {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["task", task, ...args],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const { code } = await command.output();
  if (code !== 0) throw new Error(`${task} terminó con código ${code}`);
}

if (!dryRun) await runTask("migrate");
await runTask("import:roster", [...(dryRun ? ["--dry-run"] : []), ...paths]);

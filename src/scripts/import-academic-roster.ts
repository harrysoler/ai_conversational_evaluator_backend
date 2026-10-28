import ExcelJS from "exceljs";

import { pool, query } from "@/infrastructure/database/postgres.ts";
import { upsertUserProfile } from "@/repositories/user-profile-repository.ts";
import type { AppRole } from "@/domain/users.ts";

type Person = {
  role: "docente" | "estudiante";
  name: string;
  email: string;
  documentNumber: string;
  homeProgram?: string;
};

type RosterTeacher = Person & {
  program: string;
  subject: string;
};

type RosterStudent = Person & {
  courseProgram: string;
  subject: string;
};

type ImportedAccount = {
  person: Person;
  authUserId: string;
};

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const aliasMap = new Map([
  ["ING SISTEMAS", "INGENIERIA DE SISTEMAS"],
  ["ING SISTEMAS HIBRIDA", "INGENIERIA DE SISTEMAS HIBRIDO"],
  ["ING CIVIL", "INGENIERIA CIVIL"],
  ["ING INDUSTRIAL", "INGENIERIA INDUSTRIAL"],
  ["ING MECANICA", "INGENIERIA MECANICA"],
  ["ING ELECTRONICA", "INGENIERIA ELECTRONICA"],
  ["ING AMBIENTAL", "INGENIERIA AMBIENTAL"],
  ["ING DATOS E IA", "INGENIERIA DE DATOS E INTELIGENCIA ARTIFICIAL"],
  ["CULTURA FISICA RECREACION Y DEPORTE", "CULTURA FISICA DEPORTE Y RECREACION"],
  ["CILCE", "IDIOMAS"],
]);

function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeProgram(value: string) {
  let key = normalize(value);
  key = key.replace(/^DEPARTAMENTO DE /, "").replace(/ TUNJA$/, "");
  return aliasMap.get(key) ?? key;
}

function normalizeSubject(value: string) {
  return normalize(value);
}

function cleanDocumentNumber(value: string) {
  return value.trim().replace(/\.0$/, "").replace(/\s+/g, "");
}

function cellText(row: ExcelJS.Row, headers: Map<string, number>, header: string) {
  const column = headers.get(normalize(header));
  return column ? row.getCell(column).text.trim() : "";
}

async function readSheet(path: string, expectedHeaders: string[]) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error(`No se encontró una hoja de cálculo en ${path}`);

  const headers = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, column) => {
    headers.set(normalize(cell.text), column);
  });

  const missingHeaders = expectedHeaders.filter((header) => !headers.has(normalize(header)));
  if (missingHeaders.length) {
    throw new Error(`El archivo ${path} no tiene las columnas requeridas (${missingHeaders.length})`);
  }

  return { sheet, headers };
}

async function readTeachers(path: string): Promise<RosterTeacher[]> {
  const { sheet, headers } = await readSheet(path, [
    "NOMBRES",
    "APELLIDOS",
    "IDENTIFICACION",
    "DIR_EMAIL",
    "PROGRAMA_ACADEMICO",
    "DES_ACTIVIDAD / NOM_MATERIA",
  ]);
  const records: RosterTeacher[] = [];

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const documentNumber = cleanDocumentNumber(cellText(row, headers, "IDENTIFICACION"));
    const email = cellText(row, headers, "DIR_EMAIL").toLowerCase();
    const name = `${cellText(row, headers, "NOMBRES")} ${cellText(row, headers, "APELLIDOS")}`.trim();
    const program = cellText(row, headers, "PROGRAMA_ACADEMICO");
    const subject = cellText(row, headers, "DES_ACTIVIDAD / NOM_MATERIA");

    if (documentNumber && emailPattern.test(email) && name && program && subject) {
      records.push({ role: "docente", documentNumber, email, name, program, subject });
    }
  }

  return records;
}

async function readStudents(path: string): Promise<RosterStudent[]> {
  const { sheet, headers } = await readSheet(path, [
    "APELLIDOS",
    "NOMBRES",
    "NUM_IDENTIFICACION",
    "DIR_EMAIL",
    "PROGRAMA DEL ESTUDIANTES",
    "PROGRAMA AL QUE PERTENECE LA MATERIA",
    "NOM_MATERIA",
  ]);
  const records: RosterStudent[] = [];

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const documentNumber = cleanDocumentNumber(cellText(row, headers, "NUM_IDENTIFICACION"));
    const email = cellText(row, headers, "DIR_EMAIL").toLowerCase();
    const name = `${cellText(row, headers, "NOMBRES")} ${cellText(row, headers, "APELLIDOS")}`.trim();
    const homeProgram = cellText(row, headers, "PROGRAMA DEL ESTUDIANTES");
    const courseProgram = cellText(row, headers, "PROGRAMA AL QUE PERTENECE LA MATERIA");
    const subject = cellText(row, headers, "NOM_MATERIA");

    if (documentNumber && emailPattern.test(email) && name && homeProgram && courseProgram && subject) {
      records.push({
        role: "estudiante",
        documentNumber,
        email,
        name,
        homeProgram,
        courseProgram,
        subject,
      });
    }
  }

  return records;
}

function rosterKey(role: Person["role"], documentNumber: string) {
  return `${role}:${documentNumber}`;
}

function courseKey(program: string, subject: string) {
  return `${normalizeProgram(program)}\u0000${normalizeSubject(subject)}`;
}

function preferredLabel(current: string | undefined, candidate: string) {
  return !current || candidate.length > current.length ? candidate : current;
}

async function stableCode(prefix: string, value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 20);
  return `${prefix}-${hash}`;
}

async function insertAssociations(
  sql: string,
  rows: Array<Array<string>>,
) {
  const batchSize = 400;
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const width = batch[0]?.length ?? 0;
    const values = batch.map((row, rowIndex) =>
      `(${row.map((_, columnIndex) => `$${rowIndex * width + columnIndex + 1}`).join(", ")})`
    );
    await query(`${sql} VALUES ${values.join(", ")} ON CONFLICT DO NOTHING`, batch.flat());
  }
}

async function ensureAccount(
  person: Person,
  counters: { created: number; existing: number; conflicts: number; failed: number },
): Promise<ImportedAccount | null> {
  const matches = await query<{
    id: string;
    email: string;
    document_number: string | null;
    role: AppRole | null;
  }>(
    `
      SELECT u.id, u.email, p.document_number, p.role
      FROM "user" u
      LEFT JOIN user_profiles p ON p.auth_user_id = u.id
      WHERE lower(u.email) = $1 OR p.document_number = $2
      LIMIT 3
    `,
    [person.email, person.documentNumber],
  );

  if (matches.length > 1) {
    counters.conflicts++;
    return null;
  }

  const existing = matches[0];
  if (existing) {
    if (
      existing.email.toLowerCase() !== person.email ||
      (existing.document_number && existing.document_number !== person.documentNumber) ||
      (existing.role && existing.role !== person.role)
    ) {
      counters.conflicts++;
      return null;
    }

    await upsertUserProfile({
      authUserId: existing.id,
      role: person.role,
      documentNumber: person.documentNumber,
      mustChangePassword: existing.document_number ? undefined : true,
    });
    counters.existing++;
    return { person, authUserId: existing.id };
  }

  try {
    const { auth } = await import("@/infrastructure/auth/auth.ts");
    const result = await auth.api.signUpEmail({
      body: {
        name: person.name,
        email: person.email,
        password: person.documentNumber,
      },
    });
    await upsertUserProfile({
      authUserId: result.user.id,
      role: person.role,
      documentNumber: person.documentNumber,
      mustChangePassword: true,
    });
    counters.created++;
    return { person, authUserId: result.user.id };
  } catch {
    counters.failed++;
    return null;
  }
}

async function main() {
  const args = Deno.args.filter((arg) => arg !== "--dry-run");
  const dryRun = Deno.args.includes("--dry-run");
  if (args.length !== 2 && args.length !== 3) {
    throw new Error(
      "Uso: deno task import:roster [--dry-run] <docentes.xlsx> [decanos.xlsx] <estudiantes.xlsx>",
    );
  }

  const paths = await Promise.all(args.map((path) => Deno.realPath(path)));
  const teacherPaths = paths.slice(0, -1);
  const studentPath = paths.at(-1)!;
  const [teacherSources, studentRows] = await Promise.all([
    Promise.all(teacherPaths.map(readTeachers)),
    readStudents(studentPath),
  ]);
  const teacherRows = teacherSources.flat();

  const peopleByKey = new Map<string, Person>();
  const invalidIdentities = new Set<string>();
  const identitiesByEmail = new Map<string, string>();
  const emailConflicts = new Set<string>();

  for (const person of [...teacherRows, ...studentRows]) {
    const key = rosterKey(person.role, person.documentNumber);
    const existing = peopleByKey.get(key);
    if (existing && existing.email !== person.email) invalidIdentities.add(key);
    if (!existing) peopleByKey.set(key, person);

    const emailOwner = identitiesByEmail.get(person.email);
    if (emailOwner && emailOwner !== key) {
      emailConflicts.add(emailOwner);
      emailConflicts.add(key);
    } else {
      identitiesByEmail.set(person.email, key);
    }
  }

  for (const key of emailConflicts) invalidIdentities.add(key);
  const people = [...peopleByKey.entries()]
    .filter(([key]) => !invalidIdentities.has(key))
    .map(([, person]) => person);

  const studentCourseKeys = new Set(
    studentRows.map((student) => courseKey(student.courseProgram, student.subject)),
  );
  const teacherCourses = new Map<string, Set<string>>();
  const programLabels = new Map<string, string>();
  const courseLabels = new Map<string, string>();

  function addProgram(label: string) {
    const key = normalizeProgram(label);
    if (key) programLabels.set(key, preferredLabel(programLabels.get(key), label.trim()));
    return key;
  }

  for (const teacher of teacherRows) {
    const programKey = addProgram(teacher.program);
    const fullSubjectKey = normalizeSubject(teacher.subject);
    let subjectKey = fullSubjectKey;
    const directKey = `${programKey}\u0000${fullSubjectKey}`;
    if (!studentCourseKeys.has(directKey)) {
      const separator = teacher.subject.lastIndexOf(" - ");
      if (separator > 0) subjectKey = normalizeSubject(teacher.subject.slice(0, separator));
    }

    const key = `${programKey}\u0000${subjectKey}`;
    const teachers = teacherCourses.get(key) ?? new Set<string>();
    teachers.add(teacher.documentNumber);
    teacherCourses.set(key, teachers);
    courseLabels.set(key, preferredLabel(courseLabels.get(key), teacher.subject.slice(0, teacher.subject.lastIndexOf(" - ") > 0 ? teacher.subject.lastIndexOf(" - ") : undefined).trim()));
  }

  for (const student of studentRows) {
    addProgram(student.homeProgram ?? "");
    addProgram(student.courseProgram);
    const key = courseKey(student.courseProgram, student.subject);
    courseLabels.set(key, preferredLabel(courseLabels.get(key), student.subject));
  }

  const uniqueStudents = new Map<string, RosterStudent>();
  for (const student of studentRows) {
    uniqueStudents.set(student.documentNumber, uniqueStudents.get(student.documentNumber) ?? student);
  }

  const matchedStudentCourseKeys = new Set(
    [...studentCourseKeys].filter((key) => teacherCourses.has(key)),
  );
  const ambiguousStudentCourseKeys = new Set(
    [...matchedStudentCourseKeys].filter((key) => (teacherCourses.get(key)?.size ?? 0) > 1),
  );

  if (dryRun) {
    console.log(JSON.stringify({
      mode: "dry-run",
      teacherSourceRows: teacherSources.map((rows) => rows.length),
      teacherRows: teacherRows.length,
      uniqueTeachers: new Set(teacherRows.map((teacher) => teacher.documentNumber)).size,
      studentRows: studentRows.length,
      uniqueStudents: uniqueStudents.size,
      programsOrAcademicUnits: programLabels.size,
      academicSpaces: courseLabels.size,
      matchedStudentCoursePairs: matchedStudentCourseKeys.size,
      skippedAmbiguousCoursePairs: ambiguousStudentCourseKeys.size,
      identityConflicts: invalidIdentities.size,
    }, null, 2));
    return;
  }

  const migration = await Deno.readTextFile(
    new URL("../../migrations/003_initial_password_rotation.sql", import.meta.url),
  );
  await query(migration);

  const counters = { created: 0, existing: 0, conflicts: 0, failed: 0 };
  const accountByDocument = new Map<string, ImportedAccount>();
  for (let start = 0; start < people.length; start += 6) {
    const batch = people.slice(start, start + 6);
    const accounts = await Promise.all(batch.map((person) => ensureAccount(person, counters)));
    for (const account of accounts) {
      if (account) accountByDocument.set(account.person.documentNumber, account);
    }
    if ((start + batch.length) % 300 === 0 || start + batch.length === people.length) {
      console.log(`Cuentas procesadas: ${start + batch.length}/${people.length}`);
    }
  }

  const existingPrograms = await query<{ id: string; name: string }>(
    "SELECT id::text, name FROM academic_programs",
  );
  const programIdByKey = new Map<string, string>();
  for (const program of existingPrograms) {
    const key = normalizeProgram(program.name);
    if (key && !programIdByKey.has(key)) programIdByKey.set(key, program.id);
  }

  const newPrograms = [];
  for (const [key, name] of programLabels) {
    if (!programIdByKey.has(key)) {
      newPrograms.push({ key, name, code: await stableCode("ROSTER", key) });
    }
  }

  for (const program of newPrograms) {
    const rows = await query<{ id: string }>(
      `
        INSERT INTO academic_programs (code, name)
        VALUES ($1, $2)
        ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
        RETURNING id::text
      `,
      [program.code, program.name],
    );
    programIdByKey.set(program.key, rows[0].id);
  }

  const existingSpaces = await query<{
    id: string;
    program_id: string;
    program_name: string;
    name: string;
  }>(
    `
      SELECT s.id::text, s.program_id::text, p.name AS program_name, s.name
      FROM academic_spaces s
      JOIN academic_programs p ON p.id = s.program_id
    `,
  );
  const spaceIdByKey = new Map<string, string>();
  for (const space of existingSpaces) {
    const key = `${normalizeProgram(space.program_name)}\u0000${normalizeSubject(space.name)}`;
    if (!spaceIdByKey.has(key)) spaceIdByKey.set(key, space.id);
  }

  const spaces = [];
  for (const [key, name] of courseLabels) {
    if (!spaceIdByKey.has(key)) {
      const [programKey, subjectKey] = key.split("\u0000");
      spaces.push({
        key,
        name,
        programId: programIdByKey.get(programKey)!,
        code: await stableCode("SUBJ", subjectKey),
      });
    }
  }

  for (const space of spaces) {
    const rows = await query<{ id: string }>(
      `
        INSERT INTO academic_spaces (program_id, code, name)
        VALUES ($1, $2, $3)
        ON CONFLICT (program_id, code) DO UPDATE
          SET name = EXCLUDED.name, updated_at = now()
        RETURNING id::text
      `,
      [space.programId, space.code, space.name],
    );
    spaceIdByKey.set(space.key, rows[0].id);
  }

  const programStudentRows: string[][] = [];
  for (const student of uniqueStudents.values()) {
    const account = accountByDocument.get(student.documentNumber);
    const programId = programIdByKey.get(normalizeProgram(student.homeProgram ?? ""));
    if (account && programId) programStudentRows.push([programId, account.authUserId]);
  }
  await insertAssociations(
    "INSERT INTO program_students (program_id, student_user_id)",
    programStudentRows,
  );

  const teacherSpaceRows = new Map<string, string[]>();
  for (const teacher of teacherRows) {
    const programKey = normalizeProgram(teacher.program);
    const fullKey = `${programKey}\u0000${normalizeSubject(teacher.subject)}`;
    const prefix = teacher.subject.lastIndexOf(" - ");
    const courseSubject = studentCourseKeys.has(fullKey) || prefix < 1
      ? normalizeSubject(teacher.subject)
      : normalizeSubject(teacher.subject.slice(0, prefix));
    const key = `${programKey}\u0000${courseSubject}`;
    const account = accountByDocument.get(teacher.documentNumber);
    const spaceId = spaceIdByKey.get(key);
    if (account && spaceId) {
      teacherSpaceRows.set(`${spaceId}:${account.authUserId}`, [spaceId, account.authUserId]);
    }
  }
  await insertAssociations(
    "INSERT INTO academic_space_teachers (academic_space_id, teacher_user_id)",
    [...teacherSpaceRows.values()],
  );

  const studentSpaceRows = new Map<string, string[]>();
  const skippedAmbiguousStudentLinks = new Set<string>();
  for (const student of studentRows) {
    const account = accountByDocument.get(student.documentNumber);
    const key = courseKey(student.courseProgram, student.subject);
    const spaceId = spaceIdByKey.get(key);
    if (!account || !spaceId) continue;
    const relationKey = `${spaceId}:${account.authUserId}`;
    if ((teacherCourses.get(key)?.size ?? 0) > 1) {
      skippedAmbiguousStudentLinks.add(relationKey);
      continue;
    }
    studentSpaceRows.set(relationKey, [spaceId, account.authUserId]);
  }
  await insertAssociations(
    "INSERT INTO academic_space_students (academic_space_id, student_user_id)",
    [...studentSpaceRows.values()],
  );

  console.log(JSON.stringify({
    mode: "imported",
    createdAccounts: counters.created,
    existingAccounts: counters.existing,
    identityConflicts: counters.conflicts + invalidIdentities.size,
    failedAccounts: counters.failed,
    programsOrAcademicUnits: programIdByKey.size,
    academicSpaces: spaceIdByKey.size,
    programStudentLinks: programStudentRows.length,
    teacherSpaceLinks: teacherSpaceRows.size,
    studentSpaceLinks: studentSpaceRows.size,
    skippedAmbiguousStudentLinks: skippedAmbiguousStudentLinks.size,
  }, null, 2));
}

if (import.meta.main) {
  try {
    await main();
  } finally {
    await pool.end();
  }
}

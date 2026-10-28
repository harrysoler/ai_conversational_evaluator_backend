# Virtual Challenge - Backend

API de Virtual Challenge para la autenticación y operación de la plataforma académica. Atiende las solicitudes del frontend, gestiona programas, espacios, asignaciones y conversaciones, y coordina la evaluación de los Live Talks con servicios de OpenAI.

Este repositorio contiene el servicio HTTP. La interfaz web se encuentra en el [repositorio frontend](https://github.com/harrysoler/ai_conversational_evaluator_frontend).

## Funcionalidades

- API organizada para los módulos de administración, docencia y estudiantes.
- Autenticación y acceso a datos persistidos en PostgreSQL.
- Gestión de conversaciones de Live Talk y evaluación asistida por IA.
- Consulta de perfil y registro de resultados e intentos.
- Exportación de resultados a hojas de cálculo.

## Tecnologías

- Deno 2 y TypeScript.
- Hono para la API HTTP.
- PostgreSQL como base de datos.
- Better Auth para autenticación.
- OpenAI para las funciones conversacionales y de evaluación.

## Requisitos

- [Deno](https://docs.deno.com/runtime/getting_started/installation/) instalado.
- PostgreSQL accesible desde el entorno de ejecución.
- Una clave de API de OpenAI para las funciones de IA.
- Docker Compose, opcional, para iniciar la base de datos local si trabajas con el workspace combinado.

## Puesta en marcha

### 1. Configurar variables de entorno

Copia el archivo de ejemplo:

```bash
cp .env.example .env
```

Completa los valores locales:

| Variable | Descripción | Ejemplo local |
| --- | --- | --- |
| `OPENAI_API_KEY` | Clave privada para acceder a OpenAI | La clave de tu cuenta |
| `DATABASE_URL` | Cadena de conexión a PostgreSQL | `postgresql://virtualchallenge:virtualchallenge_dev_password@localhost:5433/virtualchallenge` |
| `BETTER_AUTH_SECRET` | Secreto usado por Better Auth; debe ser privado | Genera uno con `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | URL base de esta API | `http://localhost:8000` |
| `FRONTEND_URL` | Origen principal permitido para el frontend | `http://localhost:5173` |
| `FRONTEND_URLS` | Orígenes permitidos, separados por comas | `http://localhost:5173,http://127.0.0.1:5173` |

No publiques `.env` ni incluyas secretos en el frontend. Si Vite utiliza otro puerto, agrega su origen a `FRONTEND_URL` y `FRONTEND_URLS`.

### 2. Iniciar PostgreSQL

En el workspace combinado, el Compose está en el directorio raíz, junto a las carpetas de backend y frontend. Desde esa raíz, ejecuta:

```bash
docker compose up -d postgres
```

El Compose local publica PostgreSQL en el puerto `5433` y carga las migraciones al inicializar una base nueva. Si tienes este repositorio clonado de forma independiente, configura `DATABASE_URL` para apuntar a una base PostgreSQL vacía o a una base con el esquema existente de Virtual Challenge.

### 3. Crear o actualizar el esquema

Desde la raíz del repositorio del backend, ejecuta:

```bash
deno task migrate
```

El comando aplica, en orden, los archivos de `migrations/` y registra cada versión en `schema_migrations`. Es seguro volverlo a ejecutar. Las migraciones crean también las tablas propias de la aplicación, incluida `user_profiles`; Better Auth no crea esa tabla. En el workspace combinado, Compose ya aplica las mismas migraciones al inicializar una base nueva, por lo que `deno task migrate` solo registrará las versiones pendientes.

### 4. Importar el padrón académico (workspace combinado)

Los tres Excel contienen datos personales y se mantienen fuera de Git, en `../docs-privados/` junto a las carpetas de backend y frontend. Copia allí los archivos de docentes, decanos y estudiantes con los nombres indicados abajo. Desde la raíz del backend, valida primero el resumen:

```bash
deno task bootstrap:roster --dry-run
```

Después carga el esquema y el padrón:

```bash
deno task bootstrap:roster
```

`bootstrap:roster` busca `DOCENTES SEGUIMIENTO A SYLLABUS.xlsx`, `DECANOS SEGUIMIENTO A SYLLABUS.xlsx` y `ESTUDIANTES SEGUIMIENTO SYLLABUS.xlsx` en `../docs-privados/`. Si los archivos tienen otra ubicación, usa `deno task migrate` y luego `deno task import:roster [--dry-run] <docentes.xlsx> <decanos.xlsx> <estudiantes.xlsx>`. Los decanos se importan con rol docente porque también dictan clase y el modelo de acceso no tiene un rol específico de decano.

El proceso es idempotente: no reemplaza contraseñas de cuentas existentes. Para cuentas nuevas usa el correo institucional y el número de documento como contraseña temporal, y exige cambiarla por una contraseña de al menos 12 caracteres al primer ingreso. El padrón contiene programas/unidades académicas y materias, pero no una columna explícita de facultad. Tampoco incluye el grupo de matrícula de cada estudiante; por eso se omiten las asociaciones estudiante-materia cuando la relación con docentes resulta ambigua.

### 5. Respaldar la base de datos para otro despliegue

Con `pg_dump` disponible en el entorno Nix del backend, ejecuta:

```bash
deno task backup:db
```

El respaldo PostgreSQL se guarda en `../docs-privados/backups/` con permisos privados. Incluye cuentas, contraseñas cifradas, perfiles, relaciones y resultados existentes. Transfiérelo solo por un canal privado. Para restaurarlo en una base PostgreSQL **vacía**, crea la base y ejecuta `pg_restore --no-owner --no-acl --dbname="$DATABASE_URL" <archivo.dump>` desde un entorno que tenga `pg_restore`; después configura los secretos de la API para ese despliegue. También es posible reconstruir solo el padrón con `bootstrap:roster` si el receptor tiene los tres Excel privados.

### 6. Iniciar la API

Desde la raíz del repositorio del backend:

```bash
deno task dev
```

El servidor de desarrollo escucha normalmente en `http://localhost:8000`. Deno resuelve las dependencias al ejecutar la tarea. Para iniciar sin recarga automática:

```bash
deno task start
```

La API usa la ruta base `/api`; entre sus grupos se encuentran `/api/auth`, `/api/admin`, `/api/teacher`, `/api/student`, `/api/me` y `/api/conversations`.

### 7. Cargar datos de demostración (opcional)

Con la base de datos disponible y las variables configuradas:

```bash
deno task seed
```

El script crea usuarios, programa, espacio académico y asignaciones de demostración. Las credenciales de prueba son:

| Perfil | Correo |
| --- | --- |
| Administrador | `admin.demo@virtualchallenge.edu` |
| Docente | `docente.demo@virtualchallenge.edu` |
| Estudiante | `estudiante.demo@virtualchallenge.edu` |

Contraseña local de demostración: `Demo2026!`. Úsala únicamente en entornos locales o de prueba; no habilites estas cuentas en producción.

## Comandos disponibles

```bash
deno task dev   # desarrollo con recarga automática
deno task start # ejecución sin recarga automática
deno task migrate # aplicar migraciones PostgreSQL
deno task seed  # carga de datos de demostración
deno task import:roster # importar padrón desde los Excel del workspace
deno task bootstrap:roster # migrar e importar los tres Excel privados
deno task backup:db # crear respaldo privado de PostgreSQL
```

## Modelo de IA

El modelo de evaluación se puede ajustar mediante `OPENAI_EVALUATOR_MODEL`; si no se define, el servicio usa `gpt-4o-mini`. La integración de Live Talk utiliza el modelo Realtime configurado por el servicio. La clave de OpenAI se mantiene exclusivamente en el backend.

## Ejecutar con el frontend

Inicia la API y la base de datos, luego sigue los pasos del [README del frontend](https://github.com/harrysoler/ai_conversational_evaluator_frontend#puesta-en-marcha). La URL de la API para el cliente local es `http://localhost:8000/api`.

## Notas para producción

- Define secretos propios y usa credenciales de base de datos seguras.
- Restringe CORS a los dominios reales del frontend.
- No uses las cuentas ni la contraseña de demostración.
- Configura una instancia PostgreSQL persistente y con copias de seguridad.
- Mantén la clave de OpenAI y `BETTER_AUTH_SECRET` en el gestor de secretos del entorno.

## Repositorios relacionados

- [Frontend de Virtual Challenge](https://github.com/harrysoler/ai_conversational_evaluator_frontend)


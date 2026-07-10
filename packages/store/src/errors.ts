export type Result<T, E = StoreError> = { ok: true; value: T } | { ok: false; error: E };

export type StoreError =
  | { kind: "Busy"; message: string }
  | { kind: "Sqlite"; message: string }
  | { kind: "NotFound"; entity: string; id: string | number }
  | { kind: "CorruptRow"; table: string; id: string | number | null; field: string; message: string }
  | { kind: "InvalidInput"; field: string; message: string }
  | { kind: "ChainBreak"; atSeq: number; expected: string; found: string }
  | { kind: "Io"; path: string; message: string };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err(error: StoreError): Result<never> {
  return { ok: false, error };
}

export function map<T, U>(result: Result<T>, f: (value: T) => U): Result<U> {
  return result.ok ? ok(f(result.value)) : result;
}

export function bind<T, U>(result: Result<T>, f: (value: T) => Result<U>): Result<U> {
  return result.ok ? f(result.value) : result;
}

export function errorMessage(error: StoreError): string {
  switch (error.kind) {
    case "Busy":
    case "Sqlite":
      return error.message;
    case "NotFound":
      return `${error.entity} not found: ${error.id}`;
    case "CorruptRow":
      return `${error.table}${error.id === null ? "" : `#${error.id}`}.${error.field}: ${error.message}`;
    case "InvalidInput":
      return `${error.field}: ${error.message}`;
    case "ChainBreak":
      return `patch chain broke at seq ${error.atSeq}: expected ${error.expected}, found ${error.found}`;
    case "Io":
      return `${error.path}: ${error.message}`;
  }
}

export function sqliteError(error: unknown): StoreError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.toLowerCase().includes("busy") || message.toLowerCase().includes("locked")) {
    return { kind: "Busy", message };
  }
  return { kind: "Sqlite", message };
}

export function ioError(path: string, error: unknown): StoreError {
  return { kind: "Io", path, message: error instanceof Error ? error.message : String(error) };
}

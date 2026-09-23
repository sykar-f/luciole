import type { Entry } from "./model";

// Pure formatting, used by the Client: dates read in the terminal user's time zone.

const UNITS = ["B", "KB", "MB", "GB", "TB"];
const KILO = 1024,
  // Under ten units, one decimal: `4.2 KB`, then `42 KB`.
  DECIMAL_BELOW = 10;
export function size(bytes: number) {
  let value = bytes,
    unit = 0;
  while (value >= KILO && unit < UNITS.length - 1) {
    value /= KILO;
    unit++;
  }
  return unit === 0
    ? `${bytes} B`
    : `${value.toFixed(value < DECIMAL_BELOW ? 1 : 0)} ${UNITS[unit]}`;
}

const pad = (n: number) => String(n).padStart(2, "0");
export function date(at: number) {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const MINUTE_MS = 60_000,
  HOUR_MINUTES = 60,
  DAY_HOURS = 24,
  MONTH_DAYS = 30,
  YEAR_DAYS = 365;
export function ago(at: number, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - at) / MINUTE_MS));
  if (minutes < 1) return "just now";
  if (minutes < HOUR_MINUTES) return `${minutes} min ago`;
  const hours = Math.round(minutes / HOUR_MINUTES);
  if (hours < DAY_HOURS) return `${hours} h ago`;
  const days = Math.round(hours / DAY_HOURS);
  if (days < MONTH_DAYS) return `${days} d ago`;
  if (days < YEAR_DAYS) return `${Math.round(days / MONTH_DAYS)} mo ago`;
  return `${Math.round(days / YEAR_DAYS)} y ago`;
}

// POSIX mode bits: file type in the high bits, then owner/group/other rwx triplets.
const TYPE_MASK = 0o170000,
  DIRECTORY = 0o040000,
  SYMLINK = 0o120000,
  PERMISSIONS = 0o7777,
  SETUID = 0o4000,
  SETGID = 0o2000,
  STICKY = 0o1000,
  OWNER_SHIFT = 6,
  GROUP_SHIFT = 3,
  OCTAL = 8,
  OCTAL_DIGITS = 3,
  RWX = 7,
  READ = 4,
  WRITE = 2,
  EXECUTE = 1;
export function permissions(mode: number) {
  const type = mode & TYPE_MASK;
  const letters = [OWNER_SHIFT, GROUP_SHIFT, 0]
    .map((shift, i) => {
      const bits = (mode >> shift) & RWX;
      const special = [SETUID, SETGID, STICKY][i] & mode;
      const x = bits & EXECUTE;
      const exec = special ? (i === 2 ? (x ? "t" : "T") : x ? "s" : "S") : x ? "x" : "-";
      return `${bits & READ ? "r" : "-"}${bits & WRITE ? "w" : "-"}${exec}`;
    })
    .join("");
  const prefix = type === DIRECTORY ? "d" : type === SYMLINK ? "l" : "-";
  return `${prefix}${letters} (${(mode & PERMISSIONS).toString(OCTAL).padStart(OCTAL_DIGITS, "0")})`;
}

const TYPES: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript JSX",
  js: "JavaScript",
  jsx: "JavaScript JSX",
  mjs: "JavaScript module",
  cjs: "CommonJS module",
  json: "JSON",
  md: "Markdown",
  zig: "Zig",
  py: "Python",
  rs: "Rust",
  go: "Go",
  rb: "Ruby",
  sh: "Shell script",
  css: "CSS",
  html: "HTML",
  toml: "TOML",
  yml: "YAML",
  yaml: "YAML",
  sql: "SQL",
  lock: "Lockfile",
  txt: "Plain text",
  png: "PNG image",
  jpg: "JPEG image",
  jpeg: "JPEG image",
  gif: "GIF image",
  webp: "WebP image",
  svg: "SVG image",
  pdf: "PDF document",
  zip: "Zip archive",
  gz: "Gzip archive",
  sqlite: "SQLite database",
};
export function typeOf(entry: Entry) {
  if (entry.kind === "symlink")
    return entry.targetKind ? `Symlink to ${entry.targetKind}` : "Broken symlink";
  if (entry.kind === "directory") return "Directory";
  if (entry.kind === "other") return "Special file";
  const dot = entry.name.lastIndexOf(".");
  const extension = dot > 0 ? entry.name.slice(dot + 1).toLowerCase() : "";
  return TYPES[extension] ?? (extension ? `${extension.toUpperCase()} file` : "File");
}

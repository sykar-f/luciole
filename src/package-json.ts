import { z } from "zod";

const Dependencies = z.record(z.string(), z.string());
/** The fields of a package.json the build and the starter copy; others are dropped. */
const PackageJson = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  packageManager: z.string().optional(),
  dependencies: Dependencies.optional(),
  devDependencies: Dependencies.optional(),
  overrides: z.record(z.string(), z.unknown()).optional(),
});

/** Reads a JSON file and checks it against `schema`, naming the file on failure. */
export async function readJsonFile<T>(file: string, schema: z.ZodType<T>): Promise<T> {
  let value: unknown;
  try {
    value = await Bun.file(file).json();
  } catch (error: unknown) {
    throw new Error(`${file}: invalid JSON`, { cause: error });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${file}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export const readPackageJson = (file: string) => readJsonFile(file, PackageJson);

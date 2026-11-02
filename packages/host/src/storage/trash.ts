// Deleted boards and shared cards go to .trash in the storage folder, named with the time they were deleted, so a
// mistake can be undone by hand and Turn into Board's redo can bring a board back.
import type { Fs } from "./fs";

const TRASH = ".trash";

/** .trash in the storage folder, made if missing */
export async function trashDir(fs: Fs, root: string): Promise<string> {
  const t = fs.join(root, TRASH);
  await fs.mkdir(t);
  return t;
}

/** The name in the trash for a board (or, with prefix "card-", a shared card) deleted now */
export const trashName = (id: string, prefix = "") => `${prefix}${id}.${Date.now()}.json`;

/** The file the board id was last put in the trash as; none = undefined */
export async function lastTrashed(fs: Fs, root: string, id: string): Promise<string | undefined> {
  const re = new RegExp(`^${id}\\.(\\d+)\\.json$`);
  const names = (await fs.readdir(fs.join(root, TRASH)).catch(() => []))
    .map((d) => re.exec(d.name))
    .filter((m): m is RegExpExecArray => !!m);
  if (!names.length) return undefined;
  return fs.join(root, TRASH, names.sort((a, b) => Number(b[1]) - Number(a[1]))[0][0]);
}

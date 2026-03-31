import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

export function defaultState() {
  return {
    version: 1,
    targets: {},
    feeds: {},
    meta: {
      created_at: new Date().toISOString(),
    },
  };
}

async function writeAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}

export async function loadState(statePath) {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...defaultState(),
      ...(parsed || {}),
      targets: { ...(parsed?.targets || {}) },
      feeds: { ...(parsed?.feeds || {}) },
      meta: { ...(parsed?.meta || {}) },
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    const state = defaultState();
    await saveState(statePath, state);
    return state;
  }
}

export async function saveState(statePath, state) {
  const json = JSON.stringify(state, null, 2);
  await writeAtomic(statePath, json);
}

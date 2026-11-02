import fs from 'node:fs/promises';
import path from 'node:path';

// Projects made from the @st starter keep framework code in src/@st and import it as
// @st/http, @st/database, @st/queue ... (npm workspaces). Older projects use src/config, src/middlewares.
export async function usesSt(root) {
  try {
    return (await fs.lstat(path.join(root, 'src/@st/core/index.js'))).isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// Where the Prisma client is created: global omit and similar edits go here.
export const dbFile = (st) => st ? 'src/@st/database/index.js' : 'src/config/db.js';

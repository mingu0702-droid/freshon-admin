import crypto from 'node:crypto';
import fs from 'node:fs/promises';

export async function atomicCoverageWrite(file, bytes) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  let created = false;
  try {
    const handle = await fs.open(temp, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, file);
  } finally {
    if (created) await fs.unlink(temp).catch(() => {});
  }
}

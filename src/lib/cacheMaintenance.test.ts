/// <reference types="node" />

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearOwnedCacheFiles } from '../../electron/cacheMaintenance.cjs';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
});

describe('cache maintenance', () => {
  it('removes only owned regular files and preserves active entries', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byux-cache-test-'));
    temporaryRoots.push(root);
    const removable = path.join(root, `${'a'.repeat(64)}.mp4`);
    const active = path.join(root, `${'b'.repeat(64)}.mp4`);
    const unrelated = path.join(root, 'notes.txt');
    await Promise.all([
      fs.writeFile(removable, Buffer.alloc(32)),
      fs.writeFile(active, Buffer.alloc(16)),
      fs.writeFile(unrelated, 'keep'),
    ]);

    const result = await clearOwnedCacheFiles(
      root,
      /^[0-9a-f]{64}\.mp4$/i,
      [active],
    );

    expect(result).toEqual({ files: 1, bytes: 32, protectedFiles: 1 });
    await expect(fs.stat(removable)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(active)).resolves.toBeDefined();
    await expect(fs.stat(unrelated)).resolves.toBeDefined();
  });

  it('treats a missing cache directory as already clear', async () => {
    const root = path.join(os.tmpdir(), `byux-missing-cache-${Date.now()}`);
    await expect(
      clearOwnedCacheFiles(root, /^[0-9a-f]{64}\.wfc$/i),
    ).resolves.toEqual({ files: 0, bytes: 0, protectedFiles: 0 });
  });
});

import type { Sink } from "@logtape/logtape";
import {
  type AsyncRotatingFileSinkDriver,
  type FileSinkOptions,
  getBaseFileSink,
  getBaseRotatingFileSink,
  type RotatingFileSinkDriver,
  type RotatingFileSinkOptions,
} from "./filesink.base.ts";

/**
 * A Deno-specific file sink driver.
 */
export const denoDriver: RotatingFileSinkDriver<Deno.FsFile> = {
  openSync(path: string) {
    return Deno.openSync(path, { create: true, append: true });
  },
  writeSync(fd, chunk) {
    fd.writeSync(chunk);
  },
  writeManySync(fd: Deno.FsFile, chunks: Uint8Array[]): void {
    // Deno doesn't have writev, but we can optimize by writing all chunks
    // then doing a single sync operation
    for (const chunk of chunks) {
      fd.writeSync(chunk);
    }
  },
  flushSync(fd) {
    fd.syncSync();
  },
  closeSync(fd) {
    fd.close();
  },
  statSync: globalThis?.Deno.statSync,
  renameSync: globalThis?.Deno.renameSync,
};

/**
 * A Deno-specific async file sink driver.
 * @since 1.0.0
 */
export const denoAsyncDriver: AsyncRotatingFileSinkDriver<Deno.FsFile> = {
  ...denoDriver,
  async writeMany(fd: Deno.FsFile, chunks: Uint8Array[]): Promise<void> {
    // Deno doesn't have async writev, but we can write all chunks
    // then do a single async sync
    for (const chunk of chunks) {
      await fd.write(chunk);
    }
  },
  async flush(fd) {
    await fd.sync();
  },
  close(fd) {
    return Promise.resolve(fd.close());
  },
};

/**
 * Get a file sink.
 *
 * Note that this function is unavailable in the browser.
 *
 * @param path A path to the file to write to.
 * @param options The options for the sink.
 * @returns A sink that writes to the file.  The sink is also a disposable
 *          object that closes the file when disposed. If `nonBlocking` is enabled,
 *          returns a sink that also implements {@link AsyncDisposable}.
 */
export function getFileSink(
  path: string,
  options?: FileSinkOptions,
): Sink & Disposable;
export function getFileSink(
  path: string,
  options: FileSinkOptions & { nonBlocking: true },
): Sink & AsyncDisposable;
export function getFileSink(
  path: string,
  options: FileSinkOptions = {},
): Sink & (Disposable | AsyncDisposable) {
  if (options.nonBlocking) {
    return getBaseFileSink(path, { ...options, ...denoAsyncDriver });
  }
  return getBaseFileSink(path, { ...options, ...denoDriver });
}

/**
 * Get a rotating file sink.
 *
 * This sink writes log records to a file, and rotates the file when it reaches
 * the `maxSize`.  The rotated files are named with the original file name
 * followed by a dot and a number, starting from 1.  The number is incremented
 * for each rotation, and the maximum number of files to keep is `maxFiles`.
 *
 * Note that this function is unavailable in the browser.
 *
 * @param path A path to the file to write to.
 * @param options The options for the sink and the file driver.
 * @returns A sink that writes to the file.  The sink is also a disposable
 *          object that closes the file when disposed. If `nonBlocking` is enabled,
 *          returns a sink that also implements {@link AsyncDisposable}.
 */
export function getRotatingFileSink(
  path: string,
  options?: RotatingFileSinkOptions,
): Sink & Disposable;
export function getRotatingFileSink(
  path: string,
  options: RotatingFileSinkOptions & { nonBlocking: true },
): Sink & AsyncDisposable;
export function getRotatingFileSink(
  path: string,
  options: RotatingFileSinkOptions = {},
): Sink & (Disposable | AsyncDisposable) {
  if (options.nonBlocking) {
    return getBaseRotatingFileSink(path, { ...options, ...denoAsyncDriver });
  }
  return getBaseRotatingFileSink(path, { ...options, ...denoDriver });
}

// cSpell: ignore filesink

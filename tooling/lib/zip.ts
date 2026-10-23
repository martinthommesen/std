/**
 * Reads files from a ZIP archive (PKWARE APPNOTE 6.3: the end of central
 * directory record, the central directory and local file headers; stored
 * and deflated entries). The CTK runner reads only the kit's `config.json`
 * from the downloaded zip, after checking the zip's SHA-256, so no extractor
 * runs anything from the archive.
 */
import { inflateRawSync } from "node:zlib";

const END_OF_DIRECTORY = 0x06_05_4b_50;
const DIRECTORY_ENTRY = 0x02_01_4b_50;
const LOCAL_HEADER = 0x04_03_4b_50;
const STORED = 0;
const DEFLATED = 8;
const END_RECORD_SIZE = 22;
const MAX_COMMENT = 0xff_ff;
const LOCAL_HEADER_SIZE = 30;
const DIRECTORY_HEADER_SIZE = 46;

/** One entry of the archive's central directory. */
interface Entry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly localOffset: number;
}

const endOfDirectory = (zip: Buffer): number => {
  const lowest = Math.max(0, zip.length - END_RECORD_SIZE - MAX_COMMENT);

  for (
    let offset = zip.length - END_RECORD_SIZE;
    offset >= lowest;
    offset -= 1
  ) {
    if (zip.readUInt32LE(offset) === END_OF_DIRECTORY) {
      return offset;
    }
  }

  throw new Error("not a ZIP archive: no end of central directory record");
};

const entriesOf = (zip: Buffer): readonly Entry[] => {
  const end = endOfDirectory(zip);
  const count = zip.readUInt16LE(end + 10);
  const entries: Entry[] = [];
  let offset = zip.readUInt32LE(end + 16);

  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(offset) !== DIRECTORY_ENTRY) {
      throw new Error("malformed ZIP central directory");
    }

    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);

    entries.push({
      compressedSize: zip.readUInt32LE(offset + 20),
      localOffset: zip.readUInt32LE(offset + 42),
      method: zip.readUInt16LE(offset + 10),
      name: zip
        .subarray(
          offset + DIRECTORY_HEADER_SIZE,
          offset + DIRECTORY_HEADER_SIZE + nameLength
        )
        .toString("utf-8"),
    });

    offset += DIRECTORY_HEADER_SIZE + nameLength + extraLength + commentLength;
  }

  return entries;
};

/**
 * The names of the files in an archive.
 *
 * @param zip - The archive's bytes.
 * @returns The entry names.
 */
export const zipEntryNames = (zip: Buffer): readonly string[] =>
  entriesOf(zip).map((entry) => entry.name);

/**
 * Reads one file from an archive.
 *
 * @param zip - The archive's bytes.
 * @param name - The entry's name, or a suffix of it after a `/`.
 * @returns The file's bytes.
 */
export const readZipEntry = (zip: Buffer, name: string): Buffer => {
  const entry = entriesOf(zip).find(
    (candidate) =>
      candidate.name === name || candidate.name.endsWith(`/${name}`)
  );

  if (entry === undefined) {
    throw new Error(`the archive has no ${name}`);
  }

  const local = entry.localOffset;

  if (zip.readUInt32LE(local) !== LOCAL_HEADER) {
    throw new Error(`malformed ZIP local header for ${entry.name}`);
  }

  const start =
    local +
    LOCAL_HEADER_SIZE +
    zip.readUInt16LE(local + 26) +
    zip.readUInt16LE(local + 28);

  const data = zip.subarray(start, start + entry.compressedSize);

  if (entry.method === STORED) {
    return Buffer.from(data);
  }

  if (entry.method === DEFLATED) {
    return inflateRawSync(data);
  }

  throw new Error(`unsupported ZIP compression method ${entry.method}`);
};

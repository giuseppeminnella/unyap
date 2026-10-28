import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crc32 } from "node:zlib";
import { zip } from "./zip.ts";

/** Reads a stored ZIP back through its central directory, checking each local header against it. */
function unzip(archive: Buffer): { name: string; data: Buffer }[] {
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50);
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(archive.readUInt32LE(at), 0x02014b50);
    const crc = archive.readUInt32LE(at + 16);
    const size = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const local = archive.readUInt32LE(at + 42);
    const name = archive.toString("utf8", at + 46, at + 46 + nameLength);
    assert.equal(archive.readUInt32LE(local), 0x04034b50);
    assert.equal(archive.readUInt16LE(local + 8), 0, "stored");
    assert.equal(archive.readUInt32LE(local + 14), crc);
    assert.equal(archive.toString("utf8", local + 30, local + 30 + nameLength), name);
    const data = archive.subarray(local + 30 + nameLength, local + 30 + nameLength + size);
    assert.equal(crc32(data), crc);
    entries.push({ name, data });
    at += 46 + nameLength;
  }
  return entries;
}

describe("zip", () => {
  it("stores every entry with its name, bytes and CRC", () => {
    const entries = [
      { name: "manifest.json", data: Buffer.from('{"name":"Unyap"}') },
      { name: "icons/icon-16.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]) },
      { name: "empty.txt", data: Buffer.alloc(0) },
    ];
    assert.deepEqual(unzip(zip(entries)), entries);
  });

  it("gives the same bytes for the same files", () => {
    const entries = [{ name: "a.js", data: Buffer.from("1") }];
    assert.deepEqual(zip(entries), zip(entries));
  });

  it("writes an empty archive as just the end record", () => {
    assert.equal(zip([]).length, 22);
  });
});

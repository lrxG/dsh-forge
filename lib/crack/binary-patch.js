/**
 * 原生二进制补丁引擎。
 *
 * 约束：
 * - 永远写新文件，output 与 input 相同直接拒绝；
 * - 每个补丁可带 expect，原字节不匹配则整体中止，不产生半成品；
 * - PE 文件默认重算 OptionalHeader.CheckSum；
 * - `assemble` 需要可选的 keystone，当前未内置，只接受 bytes / nop。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const NOP = 0x90;

function toInt(value, label) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const text = String(value ?? "").trim();
  if (!text) throw new Error(label + " is empty");
  const n = /^0x/i.test(text) ? Number.parseInt(text.slice(2), 16) : Number.parseInt(text, 10);
  if (!Number.isFinite(n)) throw new Error(label + " is not a number: " + text);
  return n;
}

export function parseHexBytes(value, label = "bytes") {
  if (Array.isArray(value)) {
    const bytes = value.map((item) => {
      const n = toInt(item, label);
      if (n < 0 || n > 255) throw new Error(label + " byte out of range: " + item);
      return n;
    });
    if (!bytes.length) throw new Error(label + " is empty");
    return Buffer.from(bytes);
  }
  const text = String(value ?? "").replace(/0x/gi, "").replace(/[^0-9a-fA-F]/g, "");
  if (!text || text.length % 2 !== 0) throw new Error(label + " must be an even-length hex string");
  return Buffer.from(text, "hex");
}

/** 解析 PE 布局；非 PE 返回 isPe=false。 */
export function parsePe(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const out = { isPe: false, pe32Plus: false, imageBase: 0, checksumOffset: 0, sections: [] };
  try {
    if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return out;
    const peOff = buf.readUInt32LE(0x3c);
    if (peOff + 24 > buf.length || buf.readUInt32LE(peOff) !== 0x00004550) return out;
    const coff = peOff + 4;
    const numSections = buf.readUInt16LE(coff + 2);
    const sizeOptional = buf.readUInt16LE(coff + 16);
    const opt = coff + 20;
    if (opt + 2 > buf.length) return out;
    const magic = buf.readUInt16LE(opt);
    const pe32Plus = magic === 0x20b;
    const imageBase = pe32Plus
      ? Number(buf.readBigUInt64LE(opt + 24))
      : buf.readUInt32LE(opt + 28);
    const sections = [];
    const secStart = opt + sizeOptional;
    for (let i = 0; i < numSections; i += 1) {
      const at = secStart + i * 40;
      if (at + 40 > buf.length) break;
      sections.push({
        virtualSize: buf.readUInt32LE(at + 8),
        virtualAddress: buf.readUInt32LE(at + 12),
        rawSize: buf.readUInt32LE(at + 16),
        rawPtr: buf.readUInt32LE(at + 20),
      });
    }
    return {
      isPe: true,
      pe32Plus,
      imageBase,
      checksumOffset: opt + 64,
      sections,
    };
  } catch {
    return out;
  }
}

/** 标准 PE checksum（跳过 checksum 字段本身）。 */
export function peChecksum(data, checksumOffset) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const skip = Number.isFinite(checksumOffset) ? checksumOffset : -1;
  let sum = 0;
  for (let i = 0; i < buf.length; i += 2) {
    if (skip >= 0 && i >= skip && i < skip + 4) continue;
    const word = (buf[i] | ((i + 1 < buf.length ? buf[i + 1] : 0) << 8)) >>> 0;
    sum = (sum + word) >>> 0;
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  sum = (sum & 0xffff) + (sum >>> 16);
  sum = (sum & 0xffff) + (sum >>> 16);
  return (sum + buf.length) >>> 0;
}

function rvaToOffset(layout, rva) {
  for (const section of layout.sections) {
    const size = Math.max(section.virtualSize, section.rawSize);
    if (rva >= section.virtualAddress && rva < section.virtualAddress + size) {
      return section.rawPtr + (rva - section.virtualAddress);
    }
  }
  return null;
}

function offsetOfPatch(layout, patch) {
  if (patch.offset !== undefined && patch.offset !== null && patch.offset !== "") {
    return toInt(patch.offset, "offset");
  }
  if (patch.rva !== undefined && patch.rva !== null && patch.rva !== "") {
    if (!layout.isPe) throw new Error("rva requires a PE file");
    const offset = rvaToOffset(layout, toInt(patch.rva, "rva"));
    if (offset === null) throw new Error("rva not inside any PE section: " + patch.rva);
    return offset;
  }
  if (patch.va !== undefined && patch.va !== null && patch.va !== "") {
    if (!layout.isPe) throw new Error("va requires a PE file");
    const rva = toInt(patch.va, "va") - layout.imageBase;
    if (rva < 0) throw new Error("va is below image base: " + patch.va);
    const offset = rvaToOffset(layout, rva);
    if (offset === null) throw new Error("va not inside any PE section: " + patch.va);
    return offset;
  }
  throw new Error("patch needs offset, rva, or va");
}

function bytesOfPatch(patch) {
  if (patch.nop !== undefined && patch.nop !== null) {
    const count = toInt(patch.nop, "nop");
    if (count <= 0) throw new Error("nop must be > 0");
    return Buffer.alloc(count, NOP);
  }
  if (patch.bytes !== undefined) return parseHexBytes(patch.bytes);
  if (patch.asm !== undefined) {
    throw new Error("assemble is not bundled; pass raw bytes or nop instead");
  }
  throw new Error("patch needs bytes or nop");
}

function sameFile(a, b) {
  const norm = (value) => {
    const full = resolve(value);
    return process.platform === "win32" ? full.toLowerCase() : full;
  };
  return norm(a) === norm(b);
}

/**
 * 应用补丁，写新文件。
 * @param {{input:string,output:string,patches:Array<object>,overwrite?:boolean,dryRun?:boolean,updateChecksum?:boolean}} options
 */
export function applyBinaryPatches(options) {
  const input = String(options?.input || "").trim();
  const output = String(options?.output || "").trim();
  const patches = Array.isArray(options?.patches) ? options.patches : [];
  if (!input) throw new Error("input is required");
  if (!output) throw new Error("output is required");
  if (!patches.length) throw new Error("patches is empty");
  if (sameFile(input, output)) throw new Error("refusing to patch in place; output must differ from input");
  if (!existsSync(input)) throw new Error("input not found: " + input);
  if (existsSync(output) && options.overwrite !== true) {
    throw new Error("output exists; pass overwrite:true to replace it");
  }

  const original = readFileSync(input);
  const layout = parsePe(original);
  const patched = Buffer.from(original);
  const applied = [];

  for (const patch of patches) {
    const offset = offsetOfPatch(layout, patch);
    const bytes = bytesOfPatch(patch);
    if (!Number.isFinite(offset) || offset < 0 || offset + bytes.length > patched.length) {
      throw new Error("patch out of bounds at offset " + offset + " length " + bytes.length);
    }
    if (patch.expect !== undefined && patch.expect !== null && patch.expect !== "") {
      const expect = parseHexBytes(patch.expect, "expect");
      if (expect.length !== bytes.length) {
        throw new Error("expect length " + expect.length + " != patch length " + bytes.length);
      }
      const actual = patched.subarray(offset, offset + expect.length);
      if (!actual.equals(expect)) {
        throw new Error(
          "expect mismatch at offset 0x" + offset.toString(16) +
          ": got " + actual.toString("hex") + ", want " + expect.toString("hex")
        );
      }
    }
    bytes.copy(patched, offset);
    applied.push({
      offset: "0x" + offset.toString(16),
      length: bytes.length,
      bytes: bytes.toString("hex"),
      expect: patch.expect === undefined ? null : String(patch.expect),
      note: patch.note ? String(patch.note) : "",
    });
  }

  let checksum = null;
  if (layout.isPe && layout.checksumOffset > 0 && layout.checksumOffset + 4 <= patched.length) {
    if (options.updateChecksum !== false) {
      checksum = peChecksum(patched, layout.checksumOffset);
      patched.writeUInt32LE(checksum >>> 0, layout.checksumOffset);
    } else {
      checksum = patched.readUInt32LE(layout.checksumOffset);
    }
  }

  const sha256 = createHash("sha256").update(patched).digest("hex");
  const dryRun = options.dryRun === true;
  if (!dryRun) {
    mkdirSync(dirname(resolve(output)), { recursive: true });
    const temp = output + "." + process.pid + "." + Date.now() + ".tmp";
    try {
      writeFileSync(temp, patched);
      if (existsSync(output) && options.overwrite === true) rmSync(output, { force: true });
      renameSync(temp, output);
    } catch (error) {
      try { rmSync(temp, { force: true }); } catch { /* ignore */ }
      throw error;
    }
  }

  return {
    ok: true,
    dry_run: dryRun,
    input,
    output: dryRun ? null : output,
    input_size: original.length,
    output_size: patched.length,
    pe: layout.isPe ? { pe32_plus: layout.pe32Plus, image_base: "0x" + layout.imageBase.toString(16) } : null,
    checksum: checksum === null ? null : "0x" + (checksum >>> 0).toString(16),
    sha256,
    patches: applied,
  };
}

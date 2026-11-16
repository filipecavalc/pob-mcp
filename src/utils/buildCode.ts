import zlib from "zlib";

/**
 * PoB's build code: zlib deflate of the build XML, base64 with '+' and '/'
 * swapped for '-' and '_' (ImportTab.lua "Generate":
 * common.base64.encode(Deflate(build:SaveDB("code"))):gsub("+","-"):gsub("/","_")).
 */
export function encodeBuildCode(xml: string): string {
  return zlib.deflateSync(Buffer.from(xml, 'utf8')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Reverse of encodeBuildCode (ImportTab.lua:
 * Inflate(common.base64.decode(buf:gsub("-","+"):gsub("_","/")))). Decoded
 * here rather than in Lua because the headless engine's Inflate is a stub.
 * Raw deflate is accepted too. Throws with zlib's reason when the text is
 * not a code.
 */
export function decodeBuildCode(code: string): string {
  const compressed = Buffer.from(code.trim().replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  let xml: string;
  try {
    xml = zlib.inflateSync(compressed).toString('utf8');
  } catch (zlibErr) {
    try {
      xml = zlib.inflateRawSync(compressed).toString('utf8');
    } catch {
      throw new Error(zlibErr instanceof Error ? zlibErr.message : String(zlibErr));
    }
  }
  if (!xml.trim()) throw new Error('the code decodes to nothing');
  return xml;
}

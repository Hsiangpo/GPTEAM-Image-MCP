import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ImageMCPError } from './errors.js';

export const DEFAULT_IMAGE_FORMAT = 'png';

export function writeImageOutput(input = {}, options = {}) {
  const bytes = decodeBase64Image(input.b64);
  const image = inspectImageBytes(bytes);
  const format = image.format || normalizeImageFormat(input.format || input.output_format || DEFAULT_IMAGE_FORMAT);
  const outputPath = writeImageFile(input.output_path, format, bytes, {
    ...options,
    overwrite: Boolean(input.overwrite)
  });
  return {
    file: outputPath,
    final_file: outputPath,
    path: outputPath,
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    mime_type: image.mime_type,
    mimeType: image.mime_type,
    width: image.width,
    height: image.height,
    format,
    output_format: format
  };
}

export function localImageToDataURL(rawPath, options = {}) {
  const filePath = path.resolve(expandHome(String(rawPath || ''), options.home || os.homedir()));
  const bytes = fs.readFileSync(filePath);
  const image = inspectImageBytes(bytes);
  return `data:${image.mime_type};base64,${bytes.toString('base64')}`;
}

function writeImageFile(rawOutputPath, format, bytes, options) {
  if (options.overwrite) {
    const outputPath = resolveOutputPath(rawOutputPath, format, options);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    atomicReplaceFile(outputPath, bytes);
    return outputPath;
  }
  return writeImageFileNonOverwriting(rawOutputPath, format, bytes, options);
}

function writeImageFileNonOverwriting(rawOutputPath, format, bytes, options) {
  let lastConflict;
  for (let attempt = 0; attempt < 10000; attempt += 1) {
    const outputPath = resolveAvailableOutputPath(rawOutputPath, format, options);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    try {
      atomicWriteFile(outputPath, bytes);
      return outputPath;
    } catch (error) {
      if (!isOutputPathConflict(error)) throw error;
      lastConflict = error;
    }
  }
  throw lastConflict || new ImageMCPError('无法生成不覆盖现有文件的输出路径。', {
    code: 'output_path_conflict',
    category: 'file_system',
    stage: 'local',
    retryable: false
  });
}

export function normalizeImageFormat(value) {
  const normalized = String(value || DEFAULT_IMAGE_FORMAT).trim().toLowerCase();
  if (normalized === 'jpg') return 'jpeg';
  if (['png', 'jpeg', 'webp'].includes(normalized)) return normalized;
  return DEFAULT_IMAGE_FORMAT;
}

function decodeBase64Image(value) {
  const text = String(value || '').trim();
  if (!text) {
    throw new ImageMCPError('GPTEAM 图片接口没有返回 b64_json 图片数据。', {
      code: 'image_data_missing',
      category: 'response_invalid',
      stage: 'local',
      retryable: false
    });
  }
  const bytes = Buffer.from(text, 'base64');
  if (bytes.length === 0) {
    throw new ImageMCPError('GPTEAM 图片接口返回的图片数据为空。', {
      code: 'image_data_empty',
      category: 'response_invalid',
      stage: 'local',
      retryable: false
    });
  }
  return bytes;
}

export function inspectImageBytes(bytes) {
  const png = inspectPNG(bytes);
  if (png) return png;
  const jpeg = inspectJPEG(bytes);
  if (jpeg) return jpeg;
  const webp = inspectWebP(bytes);
  if (webp) return webp;
  throw new ImageMCPError('写入前图片校验失败：无法识别 PNG/JPEG/WebP。', {
    code: 'image_mime_invalid',
    category: 'response_invalid',
    stage: 'local',
    retryable: false
  });
}

function inspectPNG(bytes) {
  if (bytes.length < 24) return null;
  const signature = '89504e470d0a1a0a';
  if (bytes.subarray(0, 8).toString('hex') !== signature) return null;
  return {
    format: 'png',
    mime_type: 'image/png',
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20)
  };
}

function inspectJPEG(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3].includes(marker)) {
      return {
        format: 'jpeg',
        mime_type: 'image/jpeg',
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7)
      };
    }
    offset += 2 + length;
  }
  return { format: 'jpeg', mime_type: 'image/jpeg', width: undefined, height: undefined };
}

function inspectWebP(bytes) {
  if (bytes.length < 16) return null;
  if (bytes.subarray(0, 4).toString('ascii') !== 'RIFF') return null;
  if (bytes.subarray(8, 12).toString('ascii') !== 'WEBP') return null;
  if (bytes.subarray(12, 16).toString('ascii') === 'VP8X' && bytes.length >= 30) {
    return {
      format: 'webp',
      mime_type: 'image/webp',
      width: 1 + readUInt24LE(bytes, 24),
      height: 1 + readUInt24LE(bytes, 27)
    };
  }
  return { format: 'webp', mime_type: 'image/webp', width: undefined, height: undefined };
}

function readUInt24LE(bytes, offset) {
  return bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16);
}

function resolveAvailableOutputPath(rawOutputPath, format, options) {
  const resolved = resolveOutputPath(rawOutputPath, format, options);
  if (!fs.existsSync(resolved)) return resolved;
  const parsed = path.parse(resolved);
  for (let version = 2; version < 10000; version += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}-v${version}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new ImageMCPError('无法生成不覆盖现有文件的输出路径。', {
    code: 'output_path_conflict',
    category: 'file_system',
    stage: 'local',
    retryable: false
  });
}

function resolveOutputPath(rawOutputPath, format, options) {
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const name = `gpteam-image-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')}.${format}`;
  if (rawOutputPath) {
    const expanded = expandHome(String(rawOutputPath), home);
    if (isDirectoryLike(expanded)) return path.resolve(expanded, name);
    return path.resolve(withImageExtension(expanded, format));
  }
  const outputDir = expandHome(firstNonEmpty(env.GPTEAM_IMAGE_OUTPUT_DIR, defaultImageOutputDir(home)), home);
  return path.resolve(outputDir, name);
}

function atomicWriteFile(outputPath, bytes) {
  const tempPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.linkSync(tempPath, outputPath);
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // 目标文件已通过独占链接落盘，临时文件清理失败不影响返回结果。
    }
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // 忽略关闭临时文件失败，下面会清理临时路径。
      }
    }
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // 忽略清理失败，返回主要写入错误。
    }
    const conflict = error && error.code === 'EEXIST';
    throw new ImageMCPError(conflict ? '输出文件已存在，正在重新选择不覆盖路径。' : `图片文件写入失败：${error.message}`, {
      code: conflict ? 'output_path_conflict' : 'file_write_failed',
      category: 'file_system',
      stage: 'local',
      retryable: false
    });
  }
}

function atomicReplaceFile(outputPath, bytes) {
  const tempPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, outputPath);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // 忽略关闭临时文件失败，下面会清理临时路径。
      }
    }
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // 忽略清理失败，返回主要写入错误。
    }
    throw new ImageMCPError(`图片文件写入失败：${error.message}`, {
      code: 'file_write_failed',
      category: 'file_system',
      stage: 'local',
      retryable: false
    });
  }
}

function isOutputPathConflict(error) {
  return error instanceof ImageMCPError && error.code === 'output_path_conflict';
}

function defaultImageOutputDir(home) {
  const desktop = path.join(home, 'Desktop');
  return fs.existsSync(desktop) ? desktop : process.cwd();
}

function isDirectoryLike(value) {
  return /[\\/]$/.test(value) || (fs.existsSync(value) && fs.statSync(value).isDirectory());
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function expandHome(value, home) {
  const text = String(value || '');
  if (text === '~') return home;
  if (text.startsWith(`~${path.sep}`)) return path.join(home, text.slice(2));
  if (text.startsWith('~/')) return path.join(home, text.slice(2));
  return text;
}

function withImageExtension(filePath, format) {
  const parsed = path.parse(filePath);
  const ext = parsed.ext.toLowerCase();
  const normalizedExt = ext === '.jpg' ? '.jpeg' : ext;
  if (normalizedExt === `.${format}`) return filePath;
  return path.join(parsed.dir, `${parsed.name}.${format}`);
}

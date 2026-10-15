'use strict';
/**
 * 极简 ZIP 打包工具（store 方式，无压缩，零依赖）。
 *
 * 用途：把 extension/ 目录打包成浏览器扩展下载包（.zip），
 * 并在打包时用 overrides 把 config.js 的内容替换成内置的全局服务器地址。
 *
 * 仅支持「存储（无压缩）」模式，浏览器扩展解压无需压缩即可正常加载。
 */
const fs = require('fs');
const path = require('path');

// ── CRC32（标准表驱动）──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// DOS 时间（固定为当前时间即可，扩展包不在意精确时间戳）
function dosDateTime() {
  const d = new Date();
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2))) & 0xFFFF;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  return { time, date };
}

function walk(rootDir, base, out) {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'backups') continue;
    const abs = path.join(rootDir, e.name);
    const rel = path.relative(base, abs).split(/[\\/]/).join('/');
    if (e.isDirectory()) walk(abs, base, out);
    else out.push(rel);
  }
  return out;
}

/**
 * 打包目录为 zip Buffer。
 * @param {string} rootDir  要打包的目录（绝对或相对）
 * @param {Object} [overrides] 形如 { '相对路径': '文件内容字符串' }，覆盖或新增文件（UTF-8）
 * @returns {Buffer} 完整的 .zip 文件内容
 */
function zipDir(rootDir, overrides) {
  overrides = overrides || {};
  const { time, date } = dosDateTime();

  // 1) 收集磁盘上的文件
  const files = walk(rootDir, rootDir, []);
  // 2) 把 overrides 中「不在磁盘上」的新增文件也加进来
  for (const rel of Object.keys(overrides)) {
    if (!files.includes(rel)) files.push(rel);
  }

  const localParts = [];
  const central = [];
  let offset = 0;

  for (const rel of files) {
    const data = Object.prototype.hasOwnProperty.call(overrides, rel)
      ? Buffer.from(String(overrides[rel]), 'utf-8')
      : fs.readFileSync(path.join(rootDir, rel));
    const nameBuf = Buffer.from(rel, 'utf-8');
    const crc = crc32(data);
    const size = data.length;

    // 本地文件头（30 字节 + 文件名）
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // 签名
    lh.writeUInt16LE(20, 4);         // 解压所需版本
    lh.writeUInt16LE(0, 6);          // 通用标志位
    lh.writeUInt16LE(0, 8);          // 压缩方式：0 = store
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(size, 18);      // 压缩后大小
    lh.writeUInt32LE(size, 22);      // 未压缩大小
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);         // 额外字段长度

    const localEntry = Buffer.concat([lh, nameBuf, data]);
    localParts.push(localEntry);

    // 中央目录头（46 字节 + 文件名）
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); // 签名
    ch.writeUInt16LE(20, 4);         // 版本（由）
    ch.writeUInt16LE(20, 6);         // 版本（解压所需）
    ch.writeUInt16LE(0, 8);          // 标志位
    ch.writeUInt16LE(0, 10);         // 压缩方式
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(size, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);         // 额外字段长度
    ch.writeUInt16LE(0, 32);         // 注释长度
    ch.writeUInt16LE(0, 34);         // 磁盘号
    ch.writeUInt16LE(0, 36);         // 内部属性
    ch.writeUInt32LE(0, 38);         // 外部属性
    ch.writeUInt32LE(offset, 42);    // 本地头偏移

    central.push(Buffer.concat([ch, nameBuf]));
    offset += localEntry.length;
  }

  const localAll = Buffer.concat(localParts);
  const centralAll = Buffer.concat(central);

  // 结束记录（22 字节）
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralAll.length, 12);
  end.writeUInt32LE(localAll.length, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([localAll, centralAll, end]);
}

module.exports = { zipDir };

// 她的相册：管理和挑选要发给你的照片。
//
// 设计取舍：为什么不做"AI 生成照片"？
//   1. 文生图模型在硅基流动上有，但每张要几秒到几十秒，且质量不稳定
//   2. 更重要：真人发的是**自己生活里的照片**（书店、猫、咖啡、下雨的窗），
//      AI 生成的图恰恰缺少这种"真实生活的粗糙感"，反而更假
//   3. 所以方案是：你往相册里放真实照片，她自己挑一张、配一句话发给你
//
// 照片目录：data/photos/
//   - 直接往里丢 jpg/png 就行
//   - 文件名可以暗示内容，比如 "团子在窗台.jpg"、"书店的下午.jpg"

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

export const PHOTO_DIR = path.join(DATA_DIR, 'photos');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

/** 确保相册目录存在。 */
export function ensurePhotoDir() {
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  return PHOTO_DIR;
}

/**
 * 列出相册里所有可用的照片。
 * @returns {Array<{name: string, path: string, size: number, hint: string}>}
 */
export function listPhotos() {
  ensurePhotoDir();
  let entries;
  try {
    entries = fs.readdirSync(PHOTO_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!IMAGE_EXT.has(ext)) continue;

    const full = path.join(PHOTO_DIR, e.name);
    let size = 0;
    try { size = fs.statSync(full).size; } catch { continue; }

    out.push({
      name: e.name,
      path: full,
      size,
      // 文件名（去掉扩展名）作为内容提示，用于让模型配一句贴合的话
      hint: path.basename(e.name, ext),
    });
  }
  return out;
}

/**
 * 挑一张照片。
 *
 * @param {object} opts
 * @param {string} opts.prefer 优先匹配的关键词（比如"猫""书店"），命中就优先选
 * @param {string[]} opts.exclude 最近发过的文件名，避免重复发同一张
 * @returns {object|null}
 */
export function pickPhoto({ prefer = '', exclude = [] } = {}) {
  const all = listPhotos();
  if (!all.length) return null;

  const fresh = all.filter((p) => !exclude.includes(p.name));
  const pool = fresh.length ? fresh : all; // 都发过了就允许重复

  // 有偏好关键词时，优先在文件名里找
  if (prefer) {
    const kw = String(prefer).split(/[\s,，、]+/).filter(Boolean);
    const matched = pool.filter((p) => kw.some((k) => p.name.includes(k) || p.hint.includes(k)));
    if (matched.length) {
      return matched[Math.floor(Math.random() * matched.length)];
    }
  }

  return pool[Math.floor(Math.random() * pool.length)];
}

/** 相册概览（给控制台显示）。 */
export function photoStats() {
  const photos = listPhotos();
  const totalBytes = photos.reduce((s, p) => s + p.size, 0);
  return {
    dir: PHOTO_DIR,
    count: photos.length,
    totalBytes,
    totalMB: Number((totalBytes / 1048576).toFixed(2)),
    photos: photos.map((p) => ({ name: p.name, hint: p.hint, size: p.size })),
  };
}

/** 读取照片字节。 */
export function readPhoto(filePath) {
  return fs.readFileSync(filePath);
}

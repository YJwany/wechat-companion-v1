// 挑选可用的识图模型：逐个试，看谁能真正"看见"这张测试图。
import { loadConfig } from '../src/config.js';
import { visionDescribe } from '../src/brain/client.js';
import { readPhoto, PHOTO_DIR } from '../src/soul/album.js';
import path from 'node:path';

const cfg = loadConfig();
const img = readPhoto(path.join(PHOTO_DIR, '验证图-彩色条纹.jpg'));

const CANDIDATES = [
  'Qwen/Qwen3-VL-8B-Instruct',
  'Qwen/Qwen3-VL-30B-A3B-Instruct',
  'Qwen/Qwen3-VL-32B-Instruct',
  'PaddlePaddle/PaddleOCR-VL-1.5',
];

console.log('测试图: 五条彩色横条（红/蓝/绿/黄/紫）+ 右下黑圆 + 白字');
console.log('═'.repeat(70));

const results = [];
for (const model of CANDIDATES) {
  const t0 = Date.now();
  try {
    const desc = await visionDescribe(
      { baseUrl: cfg.brain.baseUrl, apiKey: cfg.brain.apiKey, model },
      { imageData: img, mime: 'image/jpeg', prompt: '用一两句口语描述这张图片。像跟朋友说话那样。' },
    );
    const ms = Date.now() - t0;
    const sawColor = /(彩|红|蓝|绿|黄|紫|色|条纹)/.test(desc);
    const sawShape = /(圆|条|块|方)/.test(desc);
    console.log(`✓ ${model}  (${ms}ms)`);
    console.log(`  描述: ${desc}`);
    console.log(`  看到颜色: ${sawColor ? '✓' : '✗'}  看到形状: ${sawShape ? '✓' : '✗'}`);
    results.push({ model, ms, desc, ok: sawColor || sawShape });
  } catch (err) {
    console.log(`✗ ${model}: ${err.message.slice(0, 100)}`);
  }
  console.log('');
}

const good = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
console.log('═'.repeat(70));
if (good.length) {
  console.log('推荐的识图模型（按速度排序）:');
  for (const g of good) console.log(`  ${g.model}  (${g.ms}ms)`);
  console.log('');
  console.log('最快且可用:', good[0].model);
} else {
  console.log('没有可用的识图模型');
}

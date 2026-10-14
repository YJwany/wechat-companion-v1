// 验证识图：让她"看"一张内容明确的图，检查描述是否准确。
import { loadConfig } from '../src/config.js';
import { visionDescribe } from '../src/brain/client.js';
import { readPhoto, PHOTO_DIR } from '../src/soul/album.js';
import path from 'node:path';

const cfg = loadConfig();
const slot = {
  baseUrl: cfg.vision?.baseUrl || cfg.brain.baseUrl,
  apiKey: cfg.vision?.apiKey || cfg.brain.apiKey,
  model: cfg.vision?.model || cfg.brain.model,
  degraded: !cfg.vision?.model,
};

console.log('识图槽位:');
console.log('  baseUrl:', slot.baseUrl);
console.log('  model  :', slot.model);
console.log('  来源   :', slot.degraded ? '回落对话模型（未配独立识图模型）' : '独立识图模型');
console.log('');

const img = readPhoto(path.join(PHOTO_DIR, '验证图-彩色条纹.jpg'));
console.log('测试图:', img.length, '字节（五条彩色横条 + 右下圆形 + 文字）');
console.log('');

try {
  const desc = await visionDescribe(slot, {
    imageData: img,
    mime: 'image/jpeg',
    prompt: '用一两句口语描述这张图片。像跟朋友说话那样。说重点就行。',
  });
  console.log('她的描述:', desc);
  console.log('');
  // 判断是否真的"看见"了
  const sawColor = /(彩|红|蓝|绿|黄|紫|条纹|色)/.test(desc);
  const sawShape = /(圆|条|块|方)/.test(desc);
  console.log('看到颜色/条纹:', sawColor ? '✓' : '✗');
  console.log('看到形状:', sawShape ? '✓' : '✗');
} catch (err) {
  console.log('识图失败:', err.message);
  console.log('');
  console.log('这说明当前对话模型不支持多模态。解决办法：');
  console.log('  在控制台「大脑」页配置独立的识图模型，例如：');
  console.log('    baseUrl: https://api.siliconflow.cn/v1');
  console.log('    model  : Qwen/Qwen2.5-VL-7B-Instruct');
}

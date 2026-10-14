# 用 OpenCV 解码我们自己生成的二维码矩阵 —— 这是最硬的正确性验证。
# 结构对不代表编码对：Reed-Solomon、掩码、格式信息任何一处错都会导致扫不出来。
import sys
import numpy as np
import cv2
from PIL import Image


def load_matrix(path):
    """从 PBM(P1) 读取布尔矩阵。逐字符解析，避免整数溢出。"""
    with open(path) as f:
        tokens = f.read().split()
    assert tokens[0] == 'P1', f'不是 P1 PBM: {tokens[0]}'
    w, h = int(tokens[1]), int(tokens[2])
    body = ''.join(tokens[3:])
    assert len(body) >= w * h, f'数据不足: {len(body)} < {w * h}'
    arr = np.array([1 if ch == '1' else 0 for ch in body[:w * h]], dtype=np.uint8)
    return arr.reshape(h, w)


pbm = sys.argv[1]
expected = sys.argv[2]

arr = load_matrix(pbm)
print(f'矩阵尺寸: {arr.shape}')

# PBM: 1 = 黑。灰度图里黑=0，所以反转
img = (1 - arr) * 255
img = img.astype(np.uint8)

# 放大，模拟实际扫码距离
scale = 8
big = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_NEAREST)
big = cv2.copyMakeBorder(big, 40, 40, 40, 40, cv2.BORDER_CONSTANT, value=255)

detector = cv2.QRCodeDetector()
data, points, _ = detector.detectAndDecode(big)

if not data:
    print('✗ 解码失败 —— 二维码不可扫！')
    Image.fromarray(big).save('qr-decode-fail.png')
    print('  已保存失败样本: qr-decode-fail.png')
    sys.exit(1)

print('✓ 解码成功')
print(f'  解码内容: {data}')
print(f'  期望内容: {expected}')
if data == expected:
    print('✓ 内容完全一致 —— 二维码是正确的')
    sys.exit(0)
else:
    print('✗ 内容不一致')
    sys.exit(1)

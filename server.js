/**
 * EVA 标题图自动生成服务
 * 用 Puppeteer 操控 lab.magiconch.com/eva-title，填入参数后导出 canvas 图片。
 *
 * 部署：Render Web Service（免费层即可）
 *  - Build Command: npm install
 *  - Start Command: node server.js
 *  - 环境变量: TOKEN（可选，简单鉴权）
 */

const express = require('express');
const chromium = require('chrome-aws-lambda');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(express.json({ limit: '10mb' }));

const VALID_COLORS = ['黑白', '白黑', '黑红', '红白', '黑黄'];
const VALID_RATIOS = ['4:3', '16:9', '3:3', '5:4', '3:2'];
const TOKEN = process.env.TOKEN || '';

let browser = null;

async function getBrowser() {
  if (browser) {
    // 检测浏览器是否还活着
    try {
      await browser.version();
      return browser;
    } catch {
      try { await browser.close(); } catch {}
      browser = null;
    }
  }
  // chrome-aws-lambda 为 serverless 环境优化，内存占用小、启动快
  browser = await chromium.puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 640, height: 640 },
    executablePath: await chromium.executablePath,
    headless: chromium.headless,
  });
  return browser;
}

// 简单鉴权中间件
function auth(req, res, next) {
  if (TOKEN && req.headers['x-token'] !== TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.post('/generate', auth, async (req, res) => {
  const { layout, fields, color = '黑白', ratio = '3:3' } = req.body || {};

  if (!layout || !Array.isArray(fields) || fields.length === 0) {
    return res.status(400).json({ error: '缺少 layout 或 fields' });
  }
  if (!VALID_COLORS.includes(color)) {
    return res.status(400).json({ error: `无效的配色，可选：${VALID_COLORS.join('/')}` });
  }
  if (!VALID_RATIOS.includes(ratio)) {
    return res.status(400).json({ error: `无效的比例，可选：${VALID_RATIOS.join('/')}` });
  }

  const page = await (await getBrowser()).newPage();
  try {
    await page.goto(
      `https://lab.magiconch.com/eva-title/?layout=${encodeURIComponent(layout)}`,
      { waitUntil: 'networkidle2', timeout: 45000 },
    );

    // 等待输入框和字体就绪
    await page.waitForSelector('input', { timeout: 15000 });
    await page.evaluateHandle('document.fonts.ready').catch(() => {});

    // 填入每个字段（用原生 setter 确保 Vue 检测到变化）
    const inputs = await page.$$('input');
    const nativeSetter =
      'Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set';
    for (let i = 0; i < Math.min(fields.length, inputs.length); i++) {
      await inputs[i].evaluate(
        (el, value, setterStr) => {
          const setter = eval(setterStr);
          setter.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        },
        fields[i],
        nativeSetter,
      );
    }

    // 选配色
    await page.click(`a[data-text="${color}"]`).catch(() => {});
    // 选比例
    await page.click(`a[data-text="${ratio}"]`).catch(() => {});

    // 等渲染
    await new Promise((r) => setTimeout(r, 1200));

    // 取最大 canvas 的 base64
    const dataUrl = await page.evaluate(() => {
      const canvases = Array.from(document.querySelectorAll('canvas'));
      if (canvases.length === 0) return null;
      let best = canvases[0];
      for (const c of canvases) {
        if (c.width * c.height > best.width * best.height) best = c;
      }
      return best.toDataURL('image/png');
    });

    if (!dataUrl) {
      return res.status(500).json({ error: 'canvas 生成失败' });
    }

    res.json({ image: dataUrl });
  } catch (err) {
    console.error('生成失败：', err);
    res.status(500).json({ error: err.message || '生成失败' });
  } finally {
    await page.close();
  }
});

app.get('/', (req, res) => res.send('eva-title-generator running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`eva-title-generator listening on port ${PORT}`);
});

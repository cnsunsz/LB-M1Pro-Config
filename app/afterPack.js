const fs = require('fs');
const path = require('path');

function rm(p) {
  try {
    if (!fs.existsSync(p)) return false;
    const st = fs.statSync(p);
    if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
    return true;
  } catch (_) { return false; }
}

exports.default = async function (context) {
  const appOut = context.appOutDir;
  const locales = path.join(appOut, 'locales');
  let removed = 0;
  if (fs.existsSync(locales)) {
    const keep = new Set(['zh-CN.pak', 'en-US.pak']);
    for (const f of fs.readdirSync(locales)) {
      if (!keep.has(f) && rm(path.join(locales, f))) removed++;
    }
  }
  // Optional Chromium bits unused by this config UI (no media playback / GPU compute)
  const drop = [
    'LICENSE',
    'LICENSES.chromium.html',
    'version',
    'chrome_crashpad_handler.exe',
    'vk_swiftshader.dll',
    'vk_swiftshader_icd.json',
    'vulkan-1.dll',
    // keep ffmpeg.dll — Chromium may still link it; dropping can crash on some builds
  ];
  for (const n of drop) {
    if (rm(path.join(appOut, n))) removed++;
  }
  console.log(`[afterPack] pruned extras; locale survivors:`, fs.existsSync(locales) ? fs.readdirSync(locales) : []);
};

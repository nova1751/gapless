/* MIT. gapless-mac-menu: independent BetterNCM-mac title-bar menu, version 1.1.1.
 * Uses the host's existing button and authenticated installed-plugin API.
 * Exposes the host market when explicitly enabled; keeps its compatibility policy.
 */
(() => {
  'use strict';
  if (window.gaplessMacMenu || typeof BETTERNCM_API_PATH !== 'string') return;
  const id = 'gapless-mac-menu', slug = 'gapless-player-mac';
  const compatibility = '市场主要面向 Windows，很多插件在 macOS 不能直接使用，尤其是依赖 DLL／原生接口的插件。请查看兼容说明；下载和安装由你选择。';
  const hostFetch = window.fetch.bind(window);
  const api = (route, options = {}) => hostFetch(BETTERNCM_API_PATH + route, {
    ...options, headers: { BETTERNCM_API_KEY, 'Content-Type': 'application/json' },
  });
  let panel, anchor, data, managing = false, pendingReload = false, saving = false, timer, epoch = 0;
  const node = (tag, cls, text) => {
    const el = document.createElement(tag); el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  function installStyle() {
    if (document.getElementById(id + '-style')) return;
    const style = node('style', ''); style.id = id + '-style';
    style.textContent = `
      #${id} { --fg:30,30,34; --bg:255,255,255; --accent:236,65,65; position:fixed; z-index:100000; width:300px; max-width:calc(100vw - 16px); max-height:calc(100vh - 90px); overflow:auto; padding:8px; box-sizing:border-box; border:.5px solid rgba(var(--fg),.12); border-radius:12px; background:rgba(var(--bg),.96); color:rgb(var(--fg)); font:13px/1.45 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif; box-shadow:0 12px 36px #0004; backdrop-filter:blur(28px) saturate(150%); -webkit-app-region:no-drag; }
      #${id}.dark { --fg:236,236,240; --bg:36,36,40; }
      #${id} * { box-sizing:border-box; }
      #${id} .gm-heading { padding:8px 10px 10px; font-size:12px; opacity:.72; }
      #${id} .gm-row { display:flex; gap:12px; align-items:center; padding:10px; margin-bottom:4px; border-radius:8px; background:rgba(var(--fg),.04); }
      #${id} .gm-info { flex:1; min-width:0; }
      #${id} .gm-name { font-weight:500; }
      #${id} small { margin-left:6px; font-weight:400; opacity:.65; }
      #${id} .gm-status, #${id} .gm-note { margin-top:3px; font-size:11px; opacity:.75; overflow-wrap:anywhere; }
      #${id} .gm-note { padding:6px 10px; }
      #${id} button { font:inherit; color:inherit; border:0; cursor:pointer; }
      #${id} .gm-switch { flex:0 0 36px; width:36px; height:22px; padding:0; }
      #${id} button:disabled { opacity:.45; cursor:wait; }
      #${id} .gm-action { display:flex; justify-content:space-between; width:100%; margin-top:4px; padding:10px; border-radius:8px; background:transparent; text-align:left; }
      #${id} .gm-action:hover { background:rgba(var(--fg),.06); }
      #${id} .gm-action::after { content:'›'; opacity:.6; }
      #${id} button:focus-visible { outline:2px solid rgb(var(--accent)); outline-offset:3px; }
      #${id} .gm-danger { color:rgb(var(--accent)); }
      #${id} .gm-confirm { padding:8px 10px; font-size:12px; }
      #${id} .gm-confirm button { padding:6px 12px; margin:8px 8px 0 0; border-radius:12px; background:rgba(var(--fg),.08); }
      body.gapless-mac-menu-entry [title="BetterNCM"][role="button"] { display:none !important; }
      .better-ncm-manager .gm-market-note { margin:8px 0 0; max-width:620px; font-size:12px; line-height:1.6; opacity:.72; }
      .better-ncm-manager .plugin-btn[data-plugin-slug="${slug}"] { cursor:pointer; opacity:1; }
      .better-ncm-manager .plugin-btn[data-plugin-slug="${slug}"]:focus-visible { outline:2px solid #ec4141; outline-offset:2px; }
    `;
    document.head.append(style);
  }
  const runtime = () => {
    try { return window.gaplessMac?.status(); } catch { return null; }
  };
  function pluginRow(p) {
    const row = node('div', 'gm-row'), info = node('div', 'gm-info');
    const name = node('div', 'gm-name', p.name);
    if (p.version) name.append(node('small', '', p.version));
    const status = node('div', 'gm-status'); status.setAttribute('role', 'status');
    const sw = node('button', 'gm-switch bncm-plugins-switch'); sw.type = 'button';
    sw.setAttribute('role', 'switch'); sw.setAttribute('aria-label', p.name);
    sw.setAttribute('aria-checked', String(!!p.enabled)); sw.disabled = !!p.dev;
    let failure = '';
    const update = () => {
      const s = p.slug === slug ? runtime() : null;
      sw.disabled = !!(p.dev || saving || s?.savingConfig || s?.phase === 'restoring');
      if (s && !sw.disabled) sw.setAttribute('aria-checked', String(s.enabled));
      const installed = p.version || (p.builtin ? '内置' : '未知');
      const running = p.slug === slug ? window.gaplessMac?.version : null;
      name.title = `已安装：${installed}${running ? `；运行：${running}` : ''}`;
      status.textContent = failure || (sw.disabled && !p.dev ? '正在切换…' : p.note
        || (pendingReload ? '已保存，关闭面板后生效' : s
          ? s.enabled ? s.loading ? '已开启 · 正在准备' : s.ownsPlayback ? '已开启' : '已开启 · 当前原生播放'
            : '已关闭 · 网易云原生播放'
          : p.enabled ? '已开启' : '已关闭'));
      if (running && p.version !== running) status.textContent += ` · 运行 ${running}，重启后更新`;
    };
    sw.addEventListener('click', async () => {
      // The live adapter's document-capture handler owns this exact host switch.
      // It saves the setting and restores native audio without reloading the page.
      if (p.slug === slug && window.gaplessMac?.disable) return;
      const next = sw.getAttribute('aria-checked') !== 'true', generation = epoch;
      saving = true; failure = ''; update();
      try {
        const response = await api('/internal/plugins/enabled', { method: 'POST', body: JSON.stringify({ slug: p.slug, enabled: next }) });
        if (!response.ok) throw new Error('save-failed');
        p.enabled = next;
        const visible = data?.plugins.find(item => item.slug === p.slug);
        if (visible) visible.enabled = next;
        // The builtin lyrics switch reloads via its host config watcher.
        if (!p.builtin) {
          pendingReload = true;
          // Closing during the save must not strand a newly enabled plugin.
          if (!panel) { pendingReload = false; location.reload(); }
        }
        if (generation === epoch) sw.setAttribute('aria-checked', String(next));
      } catch { failure = '设置未保存，请重试'; }
      finally { saving = false; if (generation === epoch) update(); }
    });
    info.append(name, status); row.append(info, sw); update();
    return { row, update };
  }
  function action(text, handler, cls = '') {
    const button = node('button', 'gm-action ' + cls, text); button.type = 'button';
    button.addEventListener('click', handler); return button;
  }
  function uninstall() {
    const area = node('div', 'gm-confirm', '卸载后网易云将重新以原版打开。插件和设置会保留。');
    const cancel = node('button', '', '取消'), confirm = node('button', 'gm-danger', '卸载');
    cancel.type = confirm.type = 'button'; cancel.addEventListener('click', render);
    confirm.addEventListener('click', async () => {
      cancel.disabled = confirm.disabled = true;
      try {
        const response = await api('/internal/uninstall', { method: 'POST', body: '{}' });
        if (!response.ok) throw new Error('uninstall-failed');
        pendingReload = false; confirm.textContent = '正在卸载…';
      } catch { confirm.textContent = '卸载失败，请重试'; cancel.disabled = confirm.disabled = false; }
    });
    area.append(cancel, confirm); panel.replaceChildren(area); cancel.focus();
  }
  function market() {
    const manager = document.querySelector('section.better-ncm-manager');
    const shortcut = [...document.querySelectorAll('[title="BetterNCM"]')]
      .find(button => !manager?.contains(button));
    if (!data?.pluginManager || !shortcut || !manager) {
      panel?.append(node('div', 'gm-note', '市场尚未就绪，请重启网易云后重试。'));
      return;
    }
    // Use the host's own layout, back navigation and PluginMarket controls.
    // Opening this view does not invoke any plugin download or install action.
    const wasOpen = manager.classList.contains('ncmm-show');
    if (!wasOpen) {
      const header = manager.querySelector('.bncm-mgr-header h1')?.parentElement;
      if (header && !header.querySelector('.gm-market-note')) {
        header.append(node('p', 'gm-market-note', `Mac 宿主 ${data.version} · 标题数字为兼容接口版本。${compatibility}`));
      }
    }
    shortcut.click();
    decorateSettingsEntry();
    if (wasOpen || manager.classList.contains('ncmm-show')) {
      if (!wasOpen) manager.querySelector('[data-plugin-slug="PluginMarket"]')?.click();
      close(true);
    }
  }
  function render() {
    if (!panel || !data) return;
    clearInterval(timer); panel.replaceChildren();
    panel.append(node('div', 'gm-heading', managing ? '已安装的插件' : `BetterNCM ${data.version} · 插件`));
    const plugins = managing ? data.plugins : data.plugins.filter(p => p.slug === slug);
    const rows = plugins.map(pluginRow);
    for (const { row } of rows) panel.append(row);
    if (!plugins.length) panel.append(node('div', 'gm-note', managing ? '没有已安装的插件' : '尚未安装无缝播放插件'));
    if (managing) panel.append(node('div', 'gm-note', compatibility));
    panel.append(action(managing ? '返回无缝设置' : '管理已安装插件', () => { managing = !managing; render(); panel.querySelector('button')?.focus(); }));
    if (data.pluginManager) {
      const marketOpen = document.querySelector('section.better-ncm-manager')?.classList.contains('ncmm-show');
      panel.append(action(marketOpen ? '返回网易云' : '插件市场', market));
      if (!managing && !marketOpen) panel.append(node('div', 'gm-note', compatibility));
    }
    if (managing) panel.append(action('卸载 BetterNCM…', uninstall, 'gm-danger'));
    // Only while visible; no polling, FFT work or audio manipulation in the background.
    timer = setInterval(() => { for (const row of rows) row.update(); }, 200);
  }
  function close(focus = false) {
    if (!panel) return;
    clearInterval(timer); epoch++; panel.remove(); panel = null; data = null;
    anchor?.setAttribute('aria-expanded', 'false'); if (focus && anchor?.isConnected) anchor.focus();
    if (pendingReload) { pendingReload = false; location.reload(); }
  }
  async function open(button) {
    if (panel) { close(true); return; }
    installStyle(); anchor = button; managing = false; const generation = ++epoch;
    // Keep one title-bar entry; do not touch NetEase's settings button.
    document.body.classList.add('gapless-mac-menu-entry');
    panel = node('section', ''); panel.id = id; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '插件');
    const rgb = (getComputedStyle(button).color.match(/[\d.]+/g) || []).map(Number);
    if (rgb.length >= 3 ? rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114 > 150 : matchMedia('(prefers-color-scheme:dark)').matches) panel.classList.add('dark');
    panel.append(node('div', 'gm-note', '正在读取…')); document.body.append(panel);
    const r = button.getBoundingClientRect();
    panel.style.right = `${Math.max(8, innerWidth - r.right)}px`; panel.style.top = `${r.bottom + 8}px`;
    button.setAttribute('aria-expanded', 'true'); button.setAttribute('aria-haspopup', 'dialog');
    try {
      const response = await api('/internal/plugins'); if (!response.ok) throw new Error('list-failed');
      const value = await response.json(); if (!Array.isArray(value.plugins)) throw new Error('list-failed');
      if (generation !== epoch || !panel) return;
      data = value; render(); panel.querySelector('button')?.focus();
    } catch {
      if (generation !== epoch || !panel) return;
      panel.replaceChildren(node('div', 'gm-note', '读取失败，请重试'), action('重新读取', () => { close(); void open(button); }));
    }
  }
  function decorateSettingsEntry() {
    const entry = document.querySelector(`section.better-ncm-manager .plugin-btn[data-plugin-slug="${slug}"]`);
    if (!entry) return;
    entry.setAttribute('role', 'button'); entry.tabIndex = 0;
    entry.title = '打开无缝播放开关和状态';
  }
  function settingsFromManager(event) {
    const entry = event.target.closest?.(`section.better-ncm-manager .plugin-btn[data-plugin-slug="${slug}"]`);
    if (!entry || event.target.closest?.('.plugin-uninstall-btn')) return false;
    const button = document.querySelector('.bncm-plugins-btn');
    if (!button) return false;
    // No separate config page: route this installed entry to the existing live switch.
    // Leave the host's uninstall control and audio handlers in charge of their actions.
    event.preventDefault(); event.stopImmediatePropagation(); void open(button); return true;
  }
  document.addEventListener('click', event => {
    if (settingsFromManager(event)) return;
    if (event.target.closest?.('section.better-ncm-manager')) queueMicrotask(decorateSettingsEntry);
    const button = event.target.closest?.('.bncm-plugins-btn');
    if (!button) return;
    event.preventDefault(); event.stopImmediatePropagation(); void open(button);
  }, true);
  document.addEventListener('pointerdown', event => {
    if (panel && !panel.contains(event.target) && !event.target.closest?.('.bncm-plugins-btn')) close();
  }, true);
  document.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && settingsFromManager(event)) return;
    if (event.key === 'Escape' && panel) { event.preventDefault(); close(true); }
    else if (panel && event.key === 'Tab') {
      const buttons = [...panel.querySelectorAll('button:not(:disabled)')];
      const target = event.shiftKey && document.activeElement === buttons[0] ? buttons.at(-1)
        : !event.shiftKey && document.activeElement === buttons.at(-1) ? buttons[0] : null;
      if (target) { event.preventDefault(); target.focus(); }
    }
  }, true);
  window.addEventListener('pagehide', () => clearInterval(timer));
  function unifyEntry() {
    if (!document.body || !document.head || !document.querySelector('.bncm-plugins-btn')) return false;
    installStyle(); document.body.classList.add('gapless-mac-menu-entry'); return true;
  }
  if (!unifyEntry()) {
    const observer = new MutationObserver(() => { if (unifyEntry()) observer.disconnect(); });
    observer.observe(document.documentElement || document, { childList: true, subtree: true });
    window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
  }
  window.gaplessMacMenu = Object.freeze({ version: '1.1.1' });
})();

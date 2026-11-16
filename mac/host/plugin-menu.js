/* MIT. gapless-mac-menu: BetterNCM-mac manager integration, version 1.2.1.
 * Preserve the host sidebar/configuration page and authenticated plugin API.
 * Playback remains controlled by the existing live adapter.
 */
(() => {
  'use strict';
  if (window.gaplessMacMenu || typeof BETTERNCM_API_PATH !== 'string') return;
  const id = 'gapless-mac-controls', slug = 'gapless-player-mac', marketSlug = 'PluginMarket';
  const compatibility = '市场主要面向 Windows，很多插件在 macOS 不能直接使用，尤其是依赖 DLL／原生接口的插件。请查看兼容说明；下载和安装由你选择。';
  const reopenKey = 'gapless-mac-manager-reopen', selectionKey = 'gapless-mac-manager-selection';
  const hostFetch = window.fetch.bind(window);
  const api = (route, options = {}) => hostFetch(BETTERNCM_API_PATH + route, {
    ...options, headers: { BETTERNCM_API_KEY, 'Content-Type': 'application/json' },
  });
  const node = (tag, cls, text) => {
    const el = document.createElement(tag); el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  };
  const manager = () => document.querySelector('section.better-ncm-manager');
  const isOpen = () => !!manager()?.classList.contains('ncmm-show');
  const shortcut = () => [...document.querySelectorAll('[title="BetterNCM"]')]
    .find(button => !manager()?.contains(button));
  const runtime = () => { try { return window.gaplessMac?.status(); } catch { return null; } };
  const name = p => p.slug === marketSlug ? '插件市场' : p.name;
  let data, selected = slug, saving = false, generation = 0, timer, observer, frame;
  let detail, detailSlug, stateLabel, checkbox, saveError = '';
  const quickId = 'gapless-mac-quick-menu';
  let quick, quickControl, quickLabel, quickAnchor, quickTimer, quickGeneration = 0;
  let quickLoading = false, quickError = '';
  function stopWatching() {
    clearInterval(timer); timer = null; observer?.disconnect(); observer = null;
    cancelAnimationFrame(frame); frame = null;
  }
  function installStyle() {
    if (document.getElementById(id + '-style')) return;
    const style = node('style', ''); style.id = id + '-style';
    style.textContent = `
      body.gapless-mac-menu-entry [title="BetterNCM"][role="button"] { display:none !important; }
      #${id}-note { margin-top:10px; max-width:740px; font-size:12px; line-height:1.6; font-family:inherit; opacity:.72; }
      #${id} { margin:0 0 12px; padding-bottom:12px; border-bottom:1px solid #8884; font-size:13px; line-height:1.7; font-family:inherit; }
      #${id} h2 { margin:0 0 8px; font-size:18px; }
      #${id} p { margin:6px 0; }
      #${id} .gm-meta, #${id} .gm-state { opacity:.7; }
      #${id} label, .gm-gapless-setting { display:inline-flex; align-items:center; gap:6px; cursor:pointer; }
      #${id} .gm-checkbox, .gm-gapless-setting input { appearance:auto !important; -webkit-appearance:checkbox !important; width:16px !important; height:16px !important; margin:0; border:initial; border-radius:3px; background:initial !important; accent-color:#ec4141; cursor:pointer; }
      #${id} .gm-checkbox::before, #${id} .gm-checkbox::after, .gm-gapless-setting input::before, .gm-gapless-setting input::after { display:none !important; }
      #${id} input:disabled, .gm-gapless-setting input:disabled { cursor:wait; }
      .better-ncm-manager .gm-custom > :not(#${id}) { display:none; }
      .better-ncm-manager .plugin-btn[data-gm-selected="true"] { background-color:#8882; border-radius:8px; }
      .better-ncm-manager .plugin-btn.selected:not([data-gm-selected="true"]) { background-color:transparent; }
      .better-ncm-manager .gm-plugin-row:focus-visible { outline:2px solid currentColor; outline-offset:-2px; }
      #${quickId} { width:260px; padding-top:6px; }
      #${quickId} .bncm-plugins-foot { margin-top:4px; }
      #${quickId} .gm-manage { display:block; width:100%; padding:9px 8px; border:0; border-radius:8px; background:transparent; color:inherit; font:inherit; text-align:left; cursor:pointer; }
      #${quickId} .gm-manage:hover { background:rgba(var(--fg),.06); }
      #${quickId} button:focus-visible { outline:2px solid currentColor; outline-offset:2px; }
    `;
    document.head.append(style);
  }
  function sync() {
    syncQuick();
    if (!isOpen()) { stopWatching(); return; }
    const p = data?.plugins.find(p => p.slug === selected), s = runtime();
    if (!p) return;
    if (p.slug === slug && s && !s.savingConfig) p.enabled = s.enabled;
    const busy = !!(saving || p.slug === slug && s && (s.savingConfig || s.phase === 'restoring'));
    // The gapless plugin supplies its own onConfig checkbox. Disabled/unloaded
    // plugins use the same host control without executing their plugin code.
    const control = checkbox || manager()?.querySelector('.gm-gapless-setting input');
    if (control) {
      control.disabled = !!(p.dev || busy);
      control.checked = !!p.enabled; control.setAttribute('aria-checked', String(!!p.enabled));
    }
    const message = saveError || (busy ? '正在切换…' : p.note || (p.enabled ? '已开启' : '已关闭'));
    if (stateLabel && stateLabel.textContent !== message) stateLabel.textContent = message;
  }
  async function savePlugin(p, control) {
    if (saving) return;
    const next = control.getAttribute('aria-checked') !== 'true', revision = generation;
    saving = true; saveError = ''; sync();
    try {
      const response = await api('/internal/plugins/enabled', { method: 'POST', body: JSON.stringify({ slug: p.slug, enabled: next }) });
      if (!response.ok) throw new Error('save-failed');
      p.enabled = next;
      if (!p.builtin) {
        if (isOpen()) { try { sessionStorage.setItem(reopenKey, 'true'); sessionStorage.setItem(selectionKey, selected); } catch { /* Optional view recovery. */ } }
        location.reload();
      }
    } catch { if (revision === generation) saveError = '设置未保存，请重试'; }
    finally { saving = false; if (revision === generation) sync(); }
  }
  function controlFor(p) {
    const label = node('label', ''), control = node('input', 'gm-checkbox');
    control.type = 'checkbox'; control.setAttribute('aria-label', name(p));
    control.setAttribute('aria-checked', String(!!p.enabled));
    if (p.slug === slug) control.classList.add('bncm-plugins-switch');
    control.addEventListener('click', event => {
      if (p.slug === slug && window.gaplessMac?.disable) return;
      event.preventDefault(); void savePlugin(p, control);
    });
    label.append(control, node('span', '', p.slug === slug ? '无缝播放' : '启用插件'));
    checkbox = control; return label;
  }
  function renderDetails() {
    const host = manager(), sidebar = host?.querySelector('.loaded-plugins-list');
    const pane = sidebar?.nextElementSibling?.firstElementChild?.firstElementChild;
    const p = data?.plugins.find(p => p.slug === selected);
    if (!pane || !p) return;
    const native = window.loadedPlugins?.[p.slug];
    const hasConfig = !!native?.haveConfigElement?.();
    pane.classList.toggle('gm-custom', !hasConfig);
    if (!detail?.isConnected || detailSlug !== selected) {
      detail?.remove(); detail = node('div', ''); detail.id = id; detailSlug = selected; checkbox = null;
      detail.append(node('h2', '', name(p)));
      const running = native?.manifest.version;
      detail.append(node('p', 'gm-meta', `已安装：${p.version || (p.builtin ? '内置' : '未知')}${running ? ` · 运行：${running}` : ' · 未加载'}${p.author ? ` · ${p.author}` : ''}`));
      if (p.description) detail.append(node('p', '', p.description));
      if (!(p.slug === slug && hasConfig)) detail.append(controlFor(p));
      stateLabel = node('p', 'gm-state'); stateLabel.setAttribute('role', 'status'); detail.append(stateLabel);
      if (!hasConfig) detail.append(node('p', 'gm-meta', p.enabled ? '此插件没有额外配置。' : '开启后加载插件；可用的详细配置将显示在此处。'));
      if (p.slug === marketSlug) detail.append(node('p', 'gm-meta', p.enabled ? compatibility : '插件市场已关闭；左侧仍可管理已安装插件。'));
      pane.prepend(detail);
    }
    for (const row of host.querySelectorAll('.plugin-btn[data-plugin-slug]')) row.setAttribute('data-gm-selected', String(row.getAttribute('data-plugin-slug') === selected));
    sync();
  }
  function select(p) {
    selected = p.slug; saveError = ''; detailSlug = null;
    const original = [...manager().querySelectorAll('.plugin-btn[data-plugin-slug]')]
      .find(row => row.getAttribute('data-plugin-slug') === selected && !row.classList.contains('gm-plugin-row'));
    if (original && window.loadedPlugins?.[selected]?.haveConfigElement?.()) original.click();
    renderDetails();
  }
  function mountMissingRows() {
    const sidebar = manager()?.querySelector('.loaded-plugins-list');
    const list = sidebar?.firstElementChild?.firstElementChild; if (!list || !data) return;
    let extra = sidebar.querySelector('.gm-extra-plugins');
    if (!extra) { extra = node('div', 'gm-extra-plugins'); list.append(extra); }
    for (const p of data.plugins) {
      const nativeRow = [...sidebar.querySelectorAll('.plugin-btn[data-plugin-slug]')]
        .find(row => row.getAttribute('data-plugin-slug') === p.slug && !row.classList.contains('gm-plugin-row'));
      let row = [...extra.children].find(row => row.getAttribute('data-plugin-slug') === p.slug);
      if (nativeRow) { row?.remove(); continue; }
      if (row) continue;
      row = node('div', 'plugin-btn gm-plugin-row'); row.setAttribute('data-plugin-slug', p.slug);
      row.setAttribute('role', 'button'); row.tabIndex = 0;
      row.append(node('span', 'plugin-list-name', name(p)));
      row.addEventListener('click', () => select(p));
      row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(p); } });
      extra.append(row);
    }
  }
  async function refresh() {
    const revision = ++generation;
    try {
      const response = await api('/internal/plugins'); if (!response.ok) throw new Error('list-failed');
      const value = await response.json(); if (!Array.isArray(value.plugins)) throw new Error('list-failed');
      if (revision !== generation || !isOpen()) return;
      data = value;
      const header = manager()?.querySelector('.bncm-mgr-header h1')?.parentElement; if (!header) return;
      let note = document.getElementById(id + '-note');
      if (!note) { note = node('p', ''); note.id = id + '-note'; header.append(note); }
      note.textContent = `Mac 宿主 ${data.version} · 管理入口 ${window.gaplessMacMenu.version} · 标题数字为兼容接口版本。${compatibility}`;
      mountMissingRows(); select(data.plugins.find(p => p.slug === selected) || data.plugins[0]);
      stopWatching(); timer = setInterval(sync, 200);
      observer = new MutationObserver(() => {
        if (frame) return;
        frame = requestAnimationFrame(() => { frame = null; if (isOpen()) { mountMissingRows(); renderDetails(); } else stopWatching(); });
      });
      observer.observe(manager(), { childList: true, subtree: true });
    } catch {
      if (revision !== generation || !isOpen()) return;
      const header = manager()?.querySelector('.bncm-mgr-header h1')?.parentElement;
      let note = document.getElementById(id + '-note'); if (!note) { note = node('p', ''); note.id = id + '-note'; header?.append(note); }
      note.textContent = '插件列表读取失败，请关闭管理界面后重新打开。';
    }
  }
  function closeManager() { shortcut()?.click(); generation++; stopWatching(); }
  function openManager() {
    const button = shortcut(); if (!button || !manager()) return false;
    if (!isOpen()) button.click();
    void refresh(); return true;
  }
  function syncQuick() {
    if (!quick) return;
    const p = data?.plugins.find(p => p.slug === slug), s = runtime();
    const busy = !!(saving || s?.savingConfig || s?.phase === 'restoring');
    const enabled = s ? !!s.enabled : !!p?.enabled;
    quickControl.disabled = quickLoading || !!quickError || !p || !!p.dev || busy;
    quickControl.setAttribute('aria-checked', String(enabled));
    const message = quickError || saveError || (quickLoading ? '正在读取插件…' : busy ? '正在切换…' : p ? `版本 ${p.version || '未知'} · ${enabled ? '已开启' : '已关闭'}` : data ? '未安装无缝播放插件' : '正在读取插件…');
    if (quickLabel.textContent !== message) quickLabel.textContent = message;
  }
  function closeQuick(returnFocus = false) {
    quickGeneration++; clearInterval(quickTimer); quickTimer = null;
    quick?.remove(); quick = null;
    quickAnchor?.setAttribute('aria-expanded', 'false');
    if (returnFocus) quickAnchor?.focus();
    quickControl = null; quickLabel = null; quickAnchor = null;
    quickLoading = false; quickError = '';
  }
  async function openQuick(anchor) {
    closeQuick(); saveError = ''; quickLoading = true; quickAnchor = anchor;
    anchor.setAttribute('aria-haspopup', 'dialog'); anchor.setAttribute('aria-expanded', 'true');
    quick = node('div', 'bncm-plugins open'); quick.id = quickId;
    quick.setAttribute('role', 'dialog'); quick.setAttribute('aria-label', 'BetterNCM');
    const color = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(anchor).color || '');
    const dark = color ? .2126 * +color[1] + .7152 * +color[2] + .0722 * +color[3] > 150 : matchMedia('(prefers-color-scheme: dark)').matches;
    quick.classList.toggle('dark', dark);
    const list = node('div', 'bncm-plugins-list'), row = node('div', 'bncm-plugins-row');
    const text = node('div', 'bncm-plugins-text');
    quickLabel = node('div', 'bncm-plugins-sub');
    text.append(node('div', 'bncm-plugins-name', '无缝播放'), quickLabel);
    quickControl = node('button', 'bncm-plugins-switch'); quickControl.type = 'button';
    quickControl.setAttribute('role', 'switch'); quickControl.setAttribute('aria-label', '无缝播放');
    quickControl.addEventListener('click', event => {
      // A loaded player handles this exact host switch in its capture listener.
      if (window.gaplessMac?.disable) return;
      event.preventDefault();
      const p = data?.plugins.find(p => p.slug === slug);
      if (p) void savePlugin(p, quickControl);
    });
    row.append(text, quickControl); list.append(row);
    const foot = node('div', 'bncm-plugins-foot'), manage = node('button', 'gm-manage', '管理插件');
    manage.type = 'button'; manage.addEventListener('click', () => { closeQuick(); openManager(); });
    foot.append(manage); quick.append(list, foot); document.body.append(quick);
    const rect = anchor.getBoundingClientRect();
    quick.style.left = `${Math.max(8, Math.min(rect.right - 260, innerWidth - 268))}px`;
    quick.style.top = `${Math.max(8, Math.min(rect.bottom + 8, innerHeight - quick.offsetHeight - 8))}px`;
    const revision = quickGeneration;
    syncQuick(); quickTimer = setInterval(syncQuick, 200); manage.focus();
    try {
      const response = await api('/internal/plugins'); if (!response.ok) throw new Error('list-failed');
      const value = await response.json(); if (!Array.isArray(value.plugins)) throw new Error('list-failed');
      if (revision !== quickGeneration || !quick) return;
      data = value; quickLoading = false; syncQuick();
    } catch {
      if (revision !== quickGeneration || !quick) return;
      clearInterval(quickTimer); quickTimer = null; quickLoading = false;
      quickError = '插件读取失败，请重新打开'; syncQuick();
    }
  }
  document.addEventListener('click', event => {
    const anchor = event.target.closest?.('.bncm-plugins-btn');
    if (anchor && shortcut() && manager()) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (quick) closeQuick(true); else void openQuick(anchor); return;
    }
    if (!isOpen()) return;
    if (event.target.closest?.('[data-testid="tid_header_back_btn"]')) { event.preventDefault(); event.stopImmediatePropagation(); closeManager(); return; }
    const row = event.target.closest?.('.plugin-btn[data-plugin-slug]');
    if (!row || !manager().contains(row) || event.target.closest?.('.plugin-uninstall-btn') || row.classList.contains('gm-plugin-row')) return;
    const p = data?.plugins.find(p => p.slug === row.getAttribute('data-plugin-slug')); if (!p) return;
    selected = p.slug; saveError = ''; detailSlug = null;
    if (!window.loadedPlugins?.[selected]?.haveConfigElement?.()) { event.preventDefault(); event.stopImmediatePropagation(); renderDetails(); }
    else queueMicrotask(renderDetails);
  }, true);
  document.addEventListener('pointerdown', event => {
    if (quick && !quick.contains(event.target) && !quickAnchor?.contains(event.target)) closeQuick();
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && quick) { event.preventDefault(); event.stopImmediatePropagation(); closeQuick(true); return; }
    if (event.key === 'Escape' && isOpen()) { event.preventDefault(); closeManager(); }
  }, true);
  window.addEventListener('resize', () => closeQuick());
  window.addEventListener('pagehide', () => { closeQuick(); stopWatching(); });
  window.gaplessMacMenu = Object.freeze({ version: '1.2.1' });
  function setup() {
    if (!document.body || !document.head || !document.querySelector('.bncm-plugins-btn') || !manager()) return false;
    installStyle(); document.body.classList.add('gapless-mac-menu-entry');
    try {
      if (sessionStorage.getItem(reopenKey) === 'true') { selected = sessionStorage.getItem(selectionKey) || slug; sessionStorage.removeItem(reopenKey); sessionStorage.removeItem(selectionKey); openManager(); }
    } catch { /* Optional view recovery. */ }
    return true;
  }
  if (!setup()) {
    const setupObserver = new MutationObserver(() => { if (setup()) setupObserver.disconnect(); });
    setupObserver.observe(document.documentElement || document, { childList: true, subtree: true });
    window.addEventListener('pagehide', () => setupObserver.disconnect(), { once: true });
  }
})();

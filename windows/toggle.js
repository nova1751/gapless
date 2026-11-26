/* MIT. Host-backed menu and scoped styling for the BetterNCM manager. */
function installGaplessToggle(controller, pluginManager, onMounted) {
  const id = 'gapless-windows-menu';
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.textContent = `
    .gp-host-entry { appearance:none; display:inline-flex; align-items:center; justify-content:center; flex:0 0 20px; width:20px; height:22px; padding:0; margin:0; border:0; border-radius:4px; background:transparent; color:var(--colorSidebar3,inherit); cursor:pointer; -webkit-app-region:no-drag; }
    .gp-host-entry:hover { color:var(--colorSidebar1,inherit); background:rgba(128,128,128,.15); }
    .gp-host-entry:focus-visible, #${id} button:focus-visible { outline:2px solid currentColor; outline-offset:3px; }
    .gp-host-entry svg { width:20px; height:20px; pointer-events:none; }
    #${id} { position:fixed; z-index:10000; width:300px; max-width:calc(100vw - 16px); box-sizing:border-box; padding:8px; border:1px solid var(--gp-border); border-radius:12px; background:var(--gp-bg); color:var(--gp-fg); font-family:inherit; font-size:13px; box-shadow:0 12px 36px #0004; backdrop-filter:blur(28px) saturate(180%); -webkit-app-region:no-drag; overflow:auto; animation:gp-menu-in .16s ease-out; }
    #${id}[hidden], #${id} [hidden] { display:none; }
    #${id} .gp-heading { display:flex; align-items:center; gap:8px; padding:8px 10px 10px; font-size:12px; font-weight:600; opacity:.72; }
    #${id} .gp-row { display:flex; align-items:center; gap:12px; padding:10px; border-radius:8px; background:var(--gp-surface); }
    #${id} .gp-info { flex:1; min-width:0; }
    #${id} .gp-name { display:flex; gap:6px; align-items:center; font-weight:500; }
    #${id} .gp-description { font-size:11px; opacity:.78; margin-top:3px; line-height:1.5; overflow-wrap:anywhere; }
    #${id} .gp-switch { appearance:none; flex:0 0 36px; width:36px; height:22px; padding:0; border:0; position:relative; border-radius:11px; background:#8886; cursor:pointer; transition:background .18s; }
    #${id} .gp-switch[aria-checked="true"] { background:var(--colorPrimary,#ec4141); }
    #${id} .gp-switch::after { content:''; position:absolute; width:18px; height:18px; top:2px; left:2px; border-radius:50%; background:white; box-shadow:0 1px 3px #0003; transition:transform .18s; }
    #${id} .gp-switch[aria-checked="true"]::after { transform:translateX(14px); }
    #${id} button:disabled { opacity:.45; cursor:wait; }
    #${id} .gp-manage:not([hidden]) { display:flex; }
    #${id} .gp-manage { width:100%; align-items:center; justify-content:space-between; margin-top:4px; padding:10px; border:0; border-radius:8px; background:transparent; color:inherit; font:inherit; text-align:left; cursor:pointer; }
    #${id} .gp-manage:hover { background:var(--gp-surface); }
    #${id} .gp-manage::after { content:'›'; opacity:.65; }
    section.better-ncm-manager.gp-manager.ncmm-show .loaded-plugins-list .plugin-btn { border-radius:8px; }
    section.better-ncm-manager.gp-manager.ncmm-show .loaded-plugins-list .plugin-btn:hover { background-color:rgba(128,128,128,.14); }
    @keyframes gp-menu-in { from { opacity:0; transform:translateY(-5px); } to { opacity:1; transform:translateY(0); } }
    @media(prefers-reduced-motion:reduce) { #${id}, #${id} .gp-switch, #${id} .gp-switch::after { animation:none; transition:none; } }
  `;
  document.head.append(style);
  const panel = document.createElement('section');
  panel.id = id; panel.hidden = true; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', '插件');
  document.body.append(panel);
  const entries = new Map();
  let active, toggle, message, manage, busy = false, saveError = false;
  const element = (tag, cls, text) => {
    const node = document.createElement(tag); node.className = cls;
    if (text) node.textContent = text;
    return node;
  };
  function render() {
    panel.replaceChildren();
    panel.append(element('div', 'gp-heading', 'BetterNCM · 插件'));
    const row = element('div', 'gp-row'), info = element('div', 'gp-info');
    message = element('div', 'gp-description'); message.setAttribute('role', 'status');
    info.append(element('div', 'gp-name', '无缝播放'), message);
    toggle = element('button', 'gp-switch'); toggle.type = 'button';
    toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-label', '无缝播放');
    toggle.addEventListener('click', async () => {
      if (busy || controller.status().available === false) return;
      busy = true; saveError = false; toggle.disabled = true;
      try { await controller.enable(!controller.status().enabled); }
      catch { saveError = true; }
      finally { busy = false; update(); }
    });
    row.append(info, toggle); panel.append(row);
    manage = element('button', 'gp-manage'); manage.type = 'button';
    manage.addEventListener('click', () => {
      if (pluginManager(true)) close(true);
      else update();
    });
    panel.append(manage); update();
  }
  function update() {
    if (!toggle) return;
    const manager = pluginManager();
    manage.hidden = !manager;
    manage.textContent = manager?.isOpen ? '返回网易云' : '管理插件';
    const state = controller.status();
    toggle.setAttribute('aria-checked', String(state.enabled));
    toggle.disabled = state.available === false || busy || state.savingConfig || state.handingBack
      || (!state.enabled && (state.owns || state.loading));
    message.textContent = state.available === false ? '播放接口不兼容 · 网易云原生播放'
      : saveError ? '设置未保存，请重试' : toggle.disabled ? '正在切换播放方式…'
      : state.waitingForNextLoad ? '已开启，当前保持原生播放，下次选歌生效'
      : state.enabled ? '已开启' : '已关闭 · 网易云原生播放';
  }
  function close(focus = false) {
    panel.hidden = true;
    for (const button of entries.values()) button.setAttribute('aria-expanded', 'false');
    if (focus) active?.focus();
  }
  function position() {
    if (panel.hidden || !active) return;
    const r = active.getBoundingClientRect();
    // The lyrics page auto-hides and remounts its header when the pointer leaves.
    // Keep an open menu at its last anchor instead of dismissing its switch.
    if (!active.isConnected || !r.width || r.top < 0 || r.bottom > 110) return;
    panel.style.left = `${Math.max(8, Math.min(r.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 8))}px`;
    panel.style.top = `${r.bottom + 8}px`; panel.style.maxHeight = `${Math.max(0, innerHeight - r.bottom - 24)}px`;
  }
  function theme() {
    if (panel.hidden || !active) return;
    const hostStyle = getComputedStyle(active.parentElement || document.body);
    const color = hostStyle.getPropertyValue('--colorSidebar3').trim() || hostStyle.color;
    const rgb = color.match(/[\d.]+/g)?.map(Number) || [255,255,255];
    const dark = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 > 150;
    panel.style.setProperty('--gp-bg', dark ? 'rgba(28,29,33,.96)' : 'rgba(255,255,255,.96)');
    panel.style.setProperty('--gp-fg', dark ? '#f3f4f6' : '#202124');
    panel.style.setProperty('--gp-surface', dark ? '#ffffff0d' : '#00000008');
    panel.style.setProperty('--gp-border', dark ? '#ffffff1a' : '#00000014');
  }
  function mount() {
    const hosts = [...document.querySelectorAll('[class^="MiniModeIconBar_"]')];
    for (const [host, button] of entries) if (!host.isConnected) { button.remove(); entries.delete(host); }
    for (const host of hosts) {
      if (entries.has(host) && entries.get(host).isConnected) continue;
      const button = element('button', 'gp-host-entry'); button.type = 'button'; button.title = 'BetterNCM · 插件';
      button.setAttribute('aria-label', 'BetterNCM 插件'); button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-expanded', 'false'); button.setAttribute('aria-controls', id);
      button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 3H5a2 2 0 0 0-2 2v4h2a3 3 0 1 1 0 6H3v4a2 2 0 0 0 2 2h4v-2a3 3 0 1 1 6 0v2h4a2 2 0 0 0 2-2v-4h-2a3 3 0 1 1 0-6h2V5a2 2 0 0 0-2-2h-4v2a3 3 0 1 1-6 0Z"/></svg>';
      const reference = host.querySelector('[aria-label="setting"]')?.closest('.cmd-badge');
      if (reference?.parentElement === host) host.insertBefore(button, reference);
      else { button.style.marginRight = '16px'; host.prepend(button); }
      button.addEventListener('click', event => {
        // BetterNCM closes the manager on title-bar clicks that reach window.
        event.stopPropagation();
        if (!panel.hidden && active === button) { close(); return; }
        close(); active = button; render(); panel.hidden = false;
        button.setAttribute('aria-expanded', 'true'); theme(); position(); toggle?.focus();
      });
      entries.set(host, button);
      onMounted?.();
      onMounted = null;
    }
    theme();
  }
  window.addEventListener('pointerdown', e => { if (!panel.hidden && !panel.contains(e.target) && !active?.contains(e.target)) close(); }, true);
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) { close(true); e.preventDefault(); e.stopPropagation(); } }, true);
  window.addEventListener('resize', position);
  mount();
  const timer = setInterval(() => { mount(); update(); position(); }, 500);
  window.addEventListener('beforeunload', () => clearInterval(timer), { once: true });
  return update;
}

function installGaplessSettings(controller, plugin, report, onMounted) {
  installGaplessToggle(controller, pluginManager, onMounted);
  function settingsControl(makeCheckbox) {
    const label = document.createElement('label');
    const state = controller.status();
    if (state.available === false) {
      label.textContent = '当前客户端的播放接口不兼容，网易云原生播放';
      return label;
    }
    const enabled = () => controller.status().enabled;
    const checkbox = makeCheckbox({ checked: enabled() });
    checkbox.addEventListener('change', async () => {
      checkbox.disabled = true;
      try { await controller.enable(checkbox.checked); } catch (error) { report(error); }
      finally { checkbox.checked = enabled(); checkbox.disabled = false; }
    });
    checkbox.addEventListener('focus', () => { checkbox.checked = enabled(); });
    label.append(checkbox, ' 无缝播放');
    return label;
  }
  plugin.onConfig(tools => settingsControl(options => tools.makeCheckbox(options)));
  function openGaplessSettings(manager) {
    manager.classList.add('gp-manager');
    manager.querySelector('[data-plugin-slug="gapless-player-windows"]')?.click();
  }
  function pluginManager(toggle = false) {
    const manager = document.querySelector('section.better-ncm-manager');
    const main = document.querySelector('.right-container, section.g-mn:not(.better-ncm-manager)');
    if (!manager || !main || manager === main) return null;
    const isOpen = manager.classList.contains('ncmm-show');
    if (!toggle) return { isOpen };
    // Reuse BetterNCM's page and plugin controls. Some layouts remove its
    // original title-bar shortcut, so keep the existing page toggle as a fallback.
    const shortcut = [...document.querySelectorAll('[title="BetterNCM"]')]
      .find(node => !manager.contains(node));
    if (shortcut) {
      shortcut.click();
      if (manager.classList.contains('ncmm-show') !== isOpen) {
        if (!isOpen) openGaplessSettings(manager);
        return { isOpen: !isOpen };
      }
    }
    if (isOpen) {
      manager.classList.remove('ncmm-show');
      if (main.style.getPropertyValue('display') === 'none') main.style.removeProperty('display');
    } else {
      if (manager.parentElement !== main.parentElement) main.after(manager);
      manager.classList.add('ncmm-show');
      main.style.setProperty('display', 'none', 'important');
      openGaplessSettings(manager);
    }
    return { isOpen: !isOpen };
  }
  window.addEventListener('click', event => {
    // The manager overlays the current page without adding a history entry.
    if (!event.target?.closest?.('[data-testid="tid_header_back_btn"]') || !pluginManager()?.isOpen) return;
    if (!pluginManager(true)) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  window.addEventListener('keydown', event => {
    if (event.repeat || !event.ctrlKey || !event.altKey || event.shiftKey
      || String(event.key).toLowerCase() !== 'g') return;
    if (event.target?.closest?.('input,textarea,[contenteditable]')) return;
    if (pluginManager(true)) event.preventDefault();
  }, true);
}
